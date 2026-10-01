const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, waitFor } = require('./helpers/profile.cjs');
const mod = () => import('../src/channel-state.js');

test('真实 Gateway / HTTP：健康读取、测试与测速不修改配置或 revision', async t => {
  const f = await fixture(); t.after(() => f.close());
  assert.equal((await f.rpc('snapshot')).value.storage.mode, 'persistent');
  const before = f.readPatch();
  const revision = () => f.ctx.settings.describe().find(r => r.ns === 'model-channel-manager').revision;
  const rev = revision();
  const req = { nonce: 'same-request', provider: 'fixture', model: 'model' };
  const results = await Promise.all([f.rpc('test', req), f.rpc('test', req)]);
  assert.ok(results.every(r => r.ok));
  assert.equal((await f.settled(req.nonce)).status, 'ok');
  assert.equal(f.calls.length, 1);
  assert.equal((await f.rpc('test', { ...req, model: 'different' })).error.code, 'TASK_CONFLICT');
  const summary = (await f.rpc('snapshot')).value;
  assert.equal(summary.windows['30m'][0].total, 1);
  assert.equal(summary.windows['30m'][0].tokIn, 10);
  await f.rpc('speed', { nonce: 'speed-one', group: 'test' });
  assert.equal((await f.settled('speed-one')).status, 'ok');
  assert.ok((await f.rpc('snapshot')).value.speedResults.test.length);
  assert.equal(f.readPatch(), before);
  assert.equal(revision(), rev);
});

test('真实边界：坏参数、未知操作和不存在的任务不调用模型', async t => {
  const f = await fixture(); t.after(() => f.close());
  assert.equal((await f.rpc('test', { nonce: 'bad', provider: 'fixture', model: 'model', maxTokens: 0 })).error.code, 'BAD_REQUEST');
  assert.equal((await f.rpc('snapshot', { extra: true })).error.code, 'BAD_REQUEST');
  assert.equal((await f.rpc('unknown')).error.code, 'NOT_FOUND');
  assert.equal((await f.rpc('task', { id: 'missing' })).error.code, 'TASK_NOT_FOUND');
  assert.equal(f.calls.length, 0);
  const unauthenticated = await fetch(f.origin + '/api/modelChannels/invoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(unauthenticated.status, 401);
});

test('真实流取消：取消到达模型 signal，任务进入终态', async t => {
  let aborted = false;
  const f = await fixture({ stream: async function* ({ signal }) {
    yield { type: 'text-delta', text: '开始' };
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true }));
  } }); t.after(() => f.close());
  await f.rpc('test', { nonce: 'cancel-me', provider: 'fixture', model: 'model' });
  await waitFor(() => f.calls.length);
  await f.rpc('cancel', { id: 'cancel-me' });
  const row = await f.settled('cancel-me');
  assert.equal(row.code, 'ABORTED');
  assert.equal(aborted, true);
});

test('旧数据迁移：先持久化再移除 health，旧任务不重放，重启保留结果', async t => {
  const health = {
    records: { fixture: [{ ts: Date.now() - 1000, provider: 'fixture', model: 'old', ok: true, inputTokens: 13 }] },
    testRequest: { nonce: 'old-request', provider: 'fixture', model: 'old' },
    testResults: { interrupted: { status: 'running', startedAt: 1 } },
    runtime: { test: { currentIndex: 0 } },
  };
  let f = await fixture({ health });
  t.after(() => f?.close());
  await waitFor(async () => {
    if (f.readPatch().includes('health')) return false;
    try { const r = await f.rpc('snapshot'); return r.ok && r.value.storage.mode === 'persistent'; }
    catch (error) { if (error.message.startsWith('HTTP 404')) return false; throw error; }
  }, 10000);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.rpc('snapshot')).value.windows['7d'][0].tokIn, 13);
  assert.equal((await f.rpc('task', { id: 'interrupted' })).value.code, 'ABORTED');
  const home = f.home;
  await f.close(true); f = null;
  f = await fixture({ existingHome: home });
  assert.equal((await f.rpc('snapshot')).value.windows['7d'][0].tokIn, 13);
  assert.equal((await f.rpc('task', { id: 'interrupted' })).value.code, 'ABORTED');
  assert.equal(f.calls.length, 0);
});

test('无持久化服务：明确返回内存模式并保留旧配置', async t => {
  const f = await fixture({ storage: false, health: { digest: [], healthMigrated: true } }); t.after(() => f.close());
  const before = f.readPatch();
  assert.equal((await f.rpc('snapshot')).value.storage.mode, 'memory');
  await f.rpc('test', { nonce: 'memory', provider: 'fixture', model: 'model' });
  assert.equal((await f.settled('memory')).status, 'ok');
  assert.equal(f.readPatch(), before);
});

test('精确时间窗口与延迟分母：旧记录不算入30分钟，缺失延迟不当作0', async () => {
  const { aggregateHealth } = await mod();
  const now = 2e12;
  const windows = aggregateHealth({ p: [
    { ts: now - 1000, provider: 'p', model: 'm', ok: true, ttftMs: 100, inputTokens: 10 },
    { ts: now - 2000, provider: 'p', model: 'm', ok: true },
    { ts: now - 3600000, provider: 'p', model: 'm', ok: false, inputTokens: 20 },
    { ts: now - 2 * 86400000, provider: 'p', model: 'm', ok: true },
    { ts: now - 8 * 86400000, provider: 'p', model: 'm', ok: true },
  ] }, now);
  assert.equal(windows['30m'][0].total, 2);
  assert.equal(windows['24h'][0].total, 3);
  assert.equal(windows['7d'][0].total, 4);
  assert.equal(windows['30m'][0].ttftAvg, 100);
  assert.equal(windows['30m'][0].ttftCount, 1);
});

test('任务预留持久化失败时不执行，不消耗模型调用', async () => {
  const { TaskRegistry } = await mod();
  let calls = 0;
  const tasks = new TaskRegistry({ persist: async () => { throw new Error('disk unavailable'); } });
  await assert.rejects(tasks.submit('test', { nonce: 'no-write' }, () => calls++), { code: 'STORAGE_ERROR' });
  assert.equal(calls, 0);
  assert.equal(tasks.list().length, 0);
  await tasks.close();
});

test('任务并发上限、完成结果保留与恢复不重放', async () => {
  const { TaskRegistry } = await mod();
  let finish;
  const tasks = new TaskRegistry({ limit: 1 });
  await tasks.submit('test', { nonce: 'busy' }, () => new Promise(r => { finish = r; }));
  await assert.rejects(tasks.submit('test', { nonce: 'second' }, () => {}), { code: 'BUSY' });
  finish({ text: 'done' });
  await waitFor(() => tasks.get('busy').status === 'ok');
  const restored = new TaskRegistry(); restored.restore(tasks.list());
  let called = false;
  assert.equal((await restored.submit('test', { nonce: 'busy' }, () => { called = true; })).status, 'ok');
  assert.equal(called, false);
  await tasks.close(); await restored.close();
});

test('真实HMR：健康任务不进入配置事务，配置保存仍更新现有引用', async t => {
  const f = await fixture({ hmr: true }); t.after(() => f.close());
  await f.rpc('snapshot');
  const entry = f.ctx.configEditor.entries().find(r => r.options.id === 'model-channel-manager');
  const reference = entry.fiber.config.providerOrder;
  const uid = entry.fiber.uid;
  const before = f.readPatch();
  await f.rpc('test', { nonce: 'hmr-task', provider: 'fixture', model: 'model' });
  await f.settled('hmr-task');
  assert.equal(f.readPatch(), before);
  await f.ctx.settings.update('model-channel-manager', { providerOrder: ['fixture'] });
  assert.equal(entry.fiber.uid, uid);
  assert.equal(entry.fiber.config.providerOrder, reference);
  assert.deepEqual(reference.get(), ['fixture']);
});

test('失败的模型测试恰好记录一次，测速不进入健康统计', async t => {
  const f = await fixture({ stream: async function* () {
    yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 0 } };
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'unavailable' } } };
  } }); t.after(() => f.close());
  await f.rpc('test', { nonce: 'failed', provider: 'fixture', model: 'model' });
  assert.equal((await f.settled('failed')).code, 'SERVER');
  await f.rpc('speed', { nonce: 'measure', group: 'test' });
  await f.settled('measure');
  const row = (await f.rpc('snapshot')).value.windows['7d'][0];
  assert.equal(row.total, 1);
  assert.equal(row.success, 0);
  assert.equal(row.tokIn, 7);
});

test('迁移校验失败时保留旧配置并报告内存模式', async t => {
  const health = { records: { invalid: [{ ts: Date.now(), provider: 'fixture', model: 'model', ok: 'invalid' }] } };
  const f = await fixture({ health }); t.after(() => f.close());
  const before = f.readPatch();
  const result = await f.rpc('snapshot');
  assert.equal(result.value.storage.mode, 'memory');
  assert.match(result.value.storage.error, /旧配置保留/);
  assert.equal(f.readPatch(), before);
  assert.equal(f.calls.length, 0);
});
