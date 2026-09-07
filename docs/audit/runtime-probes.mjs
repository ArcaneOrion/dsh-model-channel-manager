/**
 * 离线审计探针：执行原始插件源码与已安装的 Cordis / DSH 服务。
 * 仅把 settings 存储替换为内存、模型适配器替换为可控制的假流。
 * 不读取用户配置，不连接网络，不修改安装包。输出是问题复现证据，不是修复后的回归验收。
 * 用法：node docs/audit/runtime-probes.mjs /path/to/node_modules/.pnpm
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runtimeRoot = process.argv[2];
if (!runtimeRoot) throw new Error('请传入已安装 DSH 的 node_modules/.pnpm 路径');
const dirs = fs.readdirSync(runtimeRoot);
function packageDir(name) {
  const hit = dirs.find((x) => x.startsWith('@deepseek-ai+' + name + '@'));
  if (!hit) throw new Error('未找到运行时包 ' + name);
  return path.join(runtimeRoot, hit, 'node_modules/@deepseek-ai', name);
}
const load = (name) => import(pathToFileURL(path.join(packageDir(name), 'lib/index.js')).href);
const { Context, Service } = await load('cordis');
const { default: TimerService } = await load('cordis-plugin-timer');
const { default: LlmRuntime, LlmAdapter } = await load('dsh-llm');
const { SettingsProvider } = await load('dsh-settings');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mcm-audit-'));
// 只替换依赖解析路径；插件函数、状态机、计时器及 watcher 均执行原始实现。
const original = fs.readFileSync(path.join(project, 'src/index.js'), 'utf8');
const source = original.replace('"@deepseek-ai/schemastery"', JSON.stringify(pathToFileURL(path.join(packageDir('schemastery'), 'lib/index.mjs')).href));
fs.writeFileSync(path.join(scratch, 'plugin.mjs'), source);
const plugin = await import(pathToFileURL(path.join(scratch, 'plugin.mjs')).href);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const copy = (v) => structuredClone(v);
const NS = 'model-channel-health';
const CN = 'model-channels';
const finish = { type: 'finish', reason: { kind: 'stop' } };
const text = { type: 'text-delta', text: 'ok' };
const input = [{ role: 'user', content: [{ type: 'text', text: 'audit fixture' }] }];
const evidence = [];

class MemorySettings extends SettingsProvider {
  constructor(ctx, options) {
    super(ctx);
    this.doc = copy(options.doc);
    this.persistDelay = options.persistDelay || 0;
    this.writes = [];
  }
  get writable() { return true; }
  async load() { return copy(this.doc); }
  async persist(ns, section) {
    if (this.persistDelay) await pause(this.persistDelay);
    this.doc[ns] = copy(section);
    this.writes.push({ ns, section: copy(section) });
  }
}

function group(overrides = {}) {
  return {
    id: 'audit',
    virtualModel: { name: 'audit', reasoning: false, input: ['text'], contextWindow: 8192, maxTokens: 16 },
    candidates: [{ provider: 'first', model: 'm' }, { provider: 'second', model: 'm' }],
    timeoutMs: 50, cooldownMs: 60000, maxRetriesPerCandidate: 0,
    speedTest: { enabled: false, retries: 0, timeoutMs: 50, concurrency: 1 },
    ...overrides,
  };
}

async function fixture({ groups = [group()], behavior, persistDelay = 0, health = {}, capabilities, migration } = {}) {
  const ctx = new Context();
  await ctx.plugin(TimerService);
  await ctx.plugin(LlmRuntime);
  const settingsFiber = await ctx.plugin(MemorySettings, {
    doc: { [CN]: { groups }, [NS]: { legacyMigrated: true, ...health } }, persistDelay,
  });
  if (migration) {
    class FakeFs extends Service {
      constructor(c) { super(c, 'fs'); }
      async resolve(target) { await migration.ready; return target; }
      async readText() { return JSON.stringify(migration.document); }
    }
    class FakePolicy extends Service {
      constructor(c) { super(c, 'sandboxPolicy'); this.workspaceRoot = '/audit-fixture'; }
    }
    await ctx.plugin(FakeFs);
    await ctx.plugin(FakePolicy);
  }
  const calls = [];
  const streams = [];
  const closed = [];
  class FakeAdapter extends LlmAdapter {
    async resolveModel(provider, model, signal) {
      if (capabilities) return { provider, id: model, name: model, ...capabilities(provider, model) };
      return super.resolveModel(provider, model, signal);
    }
    stream(options) {
      calls.push(options);
      const iterator = (async function* () {
        try {
          if (behavior) yield* behavior(options);
          else { yield text; yield finish; }
        } finally { closed.push(options.provider + '/' + options.model); }
      })();
      streams.push(iterator);
      return iterator;
    }
  }
  ctx.llm.registerAdapter(['first', 'second'], new FakeAdapter());
  const fiber = await ctx.plugin(plugin);
  await tick();
  assert(ctx.settings.get(CN), '插件命名空间应已注册');
  return {
    ctx, fiber, settingsFiber, calls, closed, streams,
    readHealth: () => copy(ctx.settings.get(NS)),
    async close() {
      // 探针观察结束后，显式排空假适配器，避免复现本身保留资源。
      for (const iterator of streams) await iterator.return();
      await ctx.fiber.dispose();
    },
  };
}
async function collect(iterator) {
  const chunks = [];
  for await (const chunk of iterator) chunks.push(chunk);
  return chunks;
}
const request = (provider = 'roundrobin/audit', extra = {}) => ({ provider, model: provider.startsWith('roundrobin/') ? 'audit' : 'm', messages: input, ...extra });
const selected = new Set((process.argv[3] || '').split(',').filter(Boolean));
async function probe(id, fn) {
  if (selected.size && !selected.has(id)) return;
  const result = await fn();
  evidence.push({ id, ...result });
  console.log('AUDIT', JSON.stringify(evidence.at(-1)));
}

await probe('H01_success_stream_cleanup', async () => {
  const f = await fixture();
  try {
    await collect(f.ctx.llm.stream(request('first')));
    const closedAfterDirect = f.closed.length;
    const chunks = await collect(f.ctx.llm.stream(request()));
    const closedAfterVirtual = f.closed.length;
    return { closedAfterDirect, closedAfterVirtual, virtualFinishCount: chunks.filter((c) => c.type === 'finish').length, issue: closedAfterVirtual === closedAfterDirect };
  } finally { await f.close(); }
});

await probe('H02_timeout_waits_for_unfinished_next', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = await fixture({ groups: [group({ timeoutMs: 15 })], behavior: async function* (options) {
    if (options.provider === 'first') await gate;
    yield text; yield finish;
  } });
  try {
    let settled = false;
    const pending = collect(f.ctx.llm.stream(request())).then((v) => { settled = true; return v; });
    await pause(80);
    const beforeRelease = { settled, providersCalled: f.calls.map((c) => c.provider), signalProvided: Boolean(f.calls[0]?.signal) };
    release();
    const chunks = await pending;
    return { configuredTimeoutMs: 15, observationAfterMs: 80, beforeRelease, finalProviders: f.calls.map((c) => c.provider), finalReason: chunks.at(-1)?.reason?.kind, issue: !beforeRelease.settled && beforeRelease.providersCalled.length === 1 };
  } finally { release(); await f.close(); }
});

await probe('H03_pending_health_overwritten_by_settings', async () => {
  const f = await fixture();
  try {
    await collect(f.ctx.llm.stream(request('first')));
    // 与调用记录无关的真实 settings 更新，发生在 2 秒批量落盘前。
    await f.ctx.settings.update(NS, { testResults: { audit: { status: 'ok' } } });
    await pause(2100);
    const recorded = Object.values(f.readHealth().records || {}).flat().length;
    return { successfulModelCalls: f.calls.length, persistedRecords: recorded, issue: recorded === 0 };
  } finally { await f.close(); }
});

await probe('H04_aborted_virtual_call_counts_as_failure', async () => {
  const controller = new AbortController();
  const f = await fixture({ behavior: async function* (options) {
    await new Promise((resolve) => {
      if (options.signal?.aborted) resolve();
      else options.signal.addEventListener('abort', resolve, { once: true });
    });
    yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'user cancelled' } } };
  } });
  try {
    const pending = collect(f.ctx.llm.stream(request('roundrobin/audit', { signal: controller.signal })));
    await tick();
    controller.abort();
    const chunks = await pending;
    await pause(2100);
    const records = Object.values(f.readHealth().records || {}).flat();
    return { finalReason: chunks.at(-1)?.reason?.kind, records, issue: records.some((r) => r.code === 'ABORTED' && !r.ok) };
  } finally { controller.abort(); await f.close(); }
});

await probe('H05_concurrent_test_request_duplicate_dispatch', async () => {
  const f = await fixture({ persistDelay: 2 });
  try {
    await Promise.all([
      f.ctx.settings.update(NS, { testRequest: { nonce: 101, provider: 'first', model: 'one' } }),
      f.ctx.settings.update(NS, { testRequest: { nonce: 102, provider: 'first', model: 'two' } }),
    ]);
    await pause(200);
    const callCounts = {};
    for (const call of f.calls) callCounts[call.model] = (callCounts[call.model] || 0) + 1;
    return { submittedRequests: 2, dispatches: f.calls.length, callCounts, resultKeys: Object.keys(f.readHealth().testResults || {}), issue: f.calls.length > 2 };
  } finally { await f.close(); }
});

await probe('H06_default_reasoning_rejects_nonreasoning_candidate', async () => {
  const f = await fixture({ groups: [group({ virtualModel: { reasoning: true }, candidates: [{ provider: 'first', model: 'm' }] })] });
  try {
    const direct = await collect(f.ctx.llm.stream(request('first')));
    const virtual = await collect(f.ctx.llm.stream(request()));
    return { directReason: direct.at(-1)?.reason?.kind, virtualReason: virtual.at(-1)?.reason, underlyingDispatches: f.calls.length, issue: direct.at(-1)?.reason?.kind === 'stop' && virtual.at(-1)?.reason?.kind === 'error' };
  } finally { await f.close(); }
});

await probe('H07_auto_speed_toggle_does_not_trigger_probe', async () => {
  const g = group({ speedTest: { enabled: true, retries: 0, timeoutMs: 50, concurrency: 1 } });
  const f = await fixture({ groups: [g] });
  try {
    await pause(20);
    const callsAfterBoot = f.calls.length;
    await collect(f.ctx.llm.stream(request()));
    return { callsAfterBoot, callsAfterFirstRequest: f.calls.length, speedRows: f.readHealth().speedResults || {}, issue: callsAfterBoot === 0 && f.calls.length === 1 && Object.keys(f.readHealth().speedResults || {}).length === 0 };
  } finally { await f.close(); }
});

await probe('H08_invalid_config_is_accepted_but_routes_disappear', async () => {
  const f = await fixture();
  try {
    await f.ctx.settings.update(CN, { groups: [group({ id: 'INVALID NAME' }), group({ id: 'duplicate' }), group({ id: 'duplicate' })] });
    await tick();
    const storedIds = f.ctx.settings.get(CN).groups.map((g) => g.id);
    const routes = f.ctx.llm.listProviders().filter((p) => p.id.startsWith('roundrobin/')).map((p) => p.id);
    return { writeAccepted: true, storedIds, routes, issue: routes.length !== storedIds.length };
  } finally { await f.close(); }
});

await probe('H09_virtual_route_loses_adapter_replay_state', async () => {
  const f = await fixture();
  try {
    const history = (provider) => [{ role: 'assistant', content: [{ type: 'text', text: 'previous' }], source: { kind: 'model', provider, model: 'm', replayState: { fixture: 'opaque-adapter-state' } } }, ...input];
    await collect(f.ctx.llm.stream(request('first', { messages: history('first') })));
    await collect(f.ctx.llm.stream(request('roundrobin/audit', { messages: history('roundrobin/audit') })));
    const directRetains = Boolean(f.calls[0].messages[0].source.replayState);
    const virtualRetains = Boolean(f.calls[1].messages[0].source.replayState);
    return { directRetains, virtualRetains, issue: directRetains && !virtualRetains };
  } finally { await f.close(); }
});

await probe('H10_speed_runtime_persisted_before_completion', async () => {
  const f = await fixture({ behavior: async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'FIXTURE_FAILURE', message: 'fixture failure' } } };
  } });
  try {
    await f.ctx.settings.update(NS, { speedRequest: { nonce: 103, group: 'audit' } });
    await pause(80);
    const value = f.readHealth();
    const rows = value.speedResults.audit || [];
    return { failedSpeedRows: rows.filter((r) => !r.ok).length, persistedRuntime: value.runtime.audit, issue: rows.length === 2 && value.runtime.audit?.lastSpeedTestAt === 0 && value.runtime.audit?.cooldowns?.length === 0 };
  } finally { await f.close(); }
});

await probe('H11_plugin_disposal_does_not_cancel_running_test', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = await fixture({ behavior: async function* () { await gate; yield text; yield finish; } });
  try {
    await f.ctx.settings.update(NS, { testRequest: { nonce: 104, provider: 'first', model: 'm' } });
    await pause(20);
    await f.fiber.dispose();
    const result = { calls: f.calls.length, closedAtDisposal: f.closed.length, routesAfterDisposal: f.ctx.llm.listProviders().map((p) => p.id), namespacesAfterDisposal: f.ctx.settings.describe().map((d) => d.ns), issue: f.calls.length === 1 && f.closed.length === 0 };
    release();
    await pause(20);
    return result;
  } finally { release(); await f.close(); }
});

await probe('H12_speed_timeout_is_idle_not_total', async () => {
  const f = await fixture({ groups: [group({ candidates: [{ provider: 'first', model: 'm' }], speedTest: { enabled: true, timeoutMs: 40, retries: 0, concurrency: 1 } })], behavior: async function* () {
    for (let i = 0; i < 4; i++) { await pause(20); yield text; }
    yield finish;
  } });
  try {
    await f.ctx.settings.update(NS, { speedRequest: { nonce: 105, group: 'audit' } });
    await pause(160);
    const row = f.readHealth().speedResults.audit?.[0];
    return { configuredTimeoutMs: 40, measuredLatencyMs: row?.latency, success: row?.ok, issue: row?.ok && row.latency > 40 };
  } finally { await f.close(); }
});

await probe('H13_round_robin_concurrent_requests_choose_same_candidate', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = await fixture({ groups: [group({ strategy: 'round-robin', timeoutMs: 500 })], behavior: async function* () { await gate; yield text; yield finish; } });
  try {
    const pending = Promise.all([collect(f.ctx.llm.stream(request())), collect(f.ctx.llm.stream(request()))]);
    await tick();
    const selectedProviders = f.calls.map((c) => c.provider);
    release();
    await pending;
    return { selectedProviders, issue: selectedProviders.length === 2 && new Set(selectedProviders).size === 1 };
  } finally { release(); await f.close(); }
});

await probe('H14_image_request_succeeds_after_image_was_removed', async () => {
  const f = await fixture({ groups: [group({ virtualModel: { reasoning: false, input: ['text', 'image'] } })], capabilities: (provider) => ({ inputModalities: provider === 'first' ? ['text'] : ['text', 'image'] }) });
  try {
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'Describe this image' }, { type: 'image', attachment: { attachmentId: 'sha256:auditimage', bytes: 1, mimeType: 'image/png' } }] }];
    const chunks = await collect(f.ctx.llm.stream(request('roundrobin/audit', { messages })));
    const content = f.calls[0]?.messages[0].content;
    return { candidatesCalled: f.calls.map((c) => c.provider), actualModelContent: content, finalReason: chunks.at(-1)?.reason, issue: chunks.at(-1)?.reason?.kind === 'stop' && f.calls.length === 1 && !content.some((c) => c.type === 'image') };
  } finally { await f.close(); }
});

await probe('H15_legacy_migration_overwrites_new_user_configuration', async () => {
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  const f = await fixture({ groups: [], health: { legacyMigrated: false }, migration: { ready, document: { groups: [group({ id: 'legacy' })] } } });
  try {
    await f.ctx.settings.update(CN, { groups: [group({ id: 'new-user-group' })], providerOrder: ['second', 'first'] });
    const before = copy(f.ctx.settings.get(CN));
    release();
    await pause(30);
    const after = copy(f.ctx.settings.get(CN));
    return { beforeIds: before.groups.map((g) => g.id), afterIds: after.groups.map((g) => g.id), beforeOrder: before.providerOrder, afterOrder: after.providerOrder, issue: after.groups[0]?.id === 'legacy' && !after.groups.some((g) => g.id === 'new-user-group') };
  } finally { release(); await f.close(); }
});

await probe('V01_sequential_routing_strategies', async () => {
  const results = {};
  for (const strategy of ['sticky', 'primary', 'round-robin']) {
    const f = await fixture({ groups: [group({ strategy })] });
    try {
      for (let i = 0; i < 3; i++) await collect(f.ctx.llm.stream(request()));
      results[strategy] = f.calls.map((c) => c.provider);
    } finally { await f.close(); }
  }
  const passed = results.sticky.join(',') === 'first,first,first' && results.primary.join(',') === 'first,first,first' && results['round-robin'].join(',') === 'first,second,first';
  assert(passed);
  return { results, passed };
});

await probe('V02_precontent_failure_fails_over_cleanly', async () => {
  const f = await fixture({ behavior: async function* (options) {
    if (options.provider === 'first') yield { type: 'finish', reason: { kind: 'error', failure: { code: 'FIXTURE_ERROR', message: 'fixture' } } };
    else { yield { type: 'text-delta', text: 'fallback' }; yield finish; }
  } });
  try {
    const chunks = await collect(f.ctx.llm.stream(request()));
    const providers = f.calls.map((c) => c.provider);
    const passed = providers.join(',') === 'first,second' && chunks.filter((c) => c.type === 'finish').length === 1 && chunks.at(-1).reason.kind === 'stop';
    assert(passed);
    return { providers, chunks, passed };
  } finally { await f.close(); }
});

await probe('V03_midstream_failure_does_not_mix_candidates', async () => {
  const f = await fixture({ behavior: async function* () {
    yield { type: 'text-delta', text: 'partial' };
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'FIXTURE_ERROR', message: 'fixture' } } };
  } });
  try {
    const chunks = await collect(f.ctx.llm.stream(request()));
    const providers = f.calls.map((c) => c.provider);
    const passed = providers.join(',') === 'first' && chunks.filter((c) => c.type === 'finish').length === 1 && chunks.at(-1).reason.kind === 'error';
    assert(passed);
    return { providers, chunks, passed };
  } finally { await f.close(); }
});

await probe('V04_prepared_call_preserves_group_snapshot', async () => {
  const f = await fixture();
  try {
    const prepared = await f.ctx.llm.prepareCall({ provider: 'roundrobin/audit', model: 'audit' });
    await f.ctx.settings.update(CN, { groups: [group({ candidates: [{ provider: 'second', model: 'm' }], virtualModel: { reasoning: false, contextWindow: 4096 } })] });
    await tick();
    await collect(prepared.stream({ ...prepared.config, messages: input }));
    const passed = f.calls[0].provider === 'first' && prepared.context.contextWindow === 8192;
    assert(passed);
    return { providerDispatched: f.calls[0].provider, preparedContext: prepared.context, passed };
  } finally { await f.close(); }
});

await probe('V05_route_rewire_and_registration_disposal', async () => {
  const f = await fixture();
  try {
    await f.ctx.settings.update(CN, { groups: [] });
    await tick();
    const afterEmpty = f.ctx.llm.listProviders().map((p) => p.id);
    await f.ctx.settings.update(CN, { groups: [group({ id: 'new-group' })] });
    await tick();
    const afterAdd = f.ctx.llm.listProviders().map((p) => p.id);
    await f.fiber.dispose();
    const afterDispose = f.ctx.llm.listProviders().map((p) => p.id);
    const namespacesAfterDispose = f.ctx.settings.describe().map((d) => d.ns);
    const passed = !afterEmpty.some((p) => p.startsWith('roundrobin/')) && afterAdd.includes('roundrobin/new-group') && !afterDispose.some((p) => p.startsWith('roundrobin/')) && namespacesAfterDispose.length === 0;
    assert(passed);
    return { afterEmpty, afterAdd, afterDispose, namespacesAfterDispose, passed };
  } finally { await f.close(); }
});

await probe('V06_health_flush_without_interleaved_write', async () => {
  const f = await fixture();
  try {
    await collect(f.ctx.llm.stream(request('first')));
    await pause(2100);
    const records = Object.values(f.readHealth().records || {}).flat();
    const passed = records.length === 1 && records[0].ok;
    assert(passed);
    return { successfulCalls: f.calls.length, records: records.length, passed };
  } finally { await f.close(); }
});

console.log('AUDIT_SUMMARY', JSON.stringify({ runtimeRoot, probes: evidence.length, reproduced: evidence.filter((r) => r.issue).length, controlsPassed: evidence.filter((r) => r.passed).length, evidence }, null, 2));
