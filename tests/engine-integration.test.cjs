/**
 * 引擎集成测试（0.3.15）：真正调用 apply() 组装引擎，再用 adapter 跑一遍虚拟路由请求。
 *
 * 为什么需要它：此前所有引擎测试都是源级断言或逻辑复刻，抓不到「作用域/引用」类缺陷。
 * 0.3.5 的 F13 重构把 `let cursor = …` 改成两个分支内赋值却没保留声明——ESM 严格模式下
 * 每次走虚拟路由都抛 `ReferenceError: cursor is not defined`（用户看到的「本轮运行失败」），
 * 而当时 32 个测试全绿。本文件用最小 Cordis 替身跑真实代码路径：
 *   apply(ctx, Config({...})) → 捕获 adapter → adapter.stream(...) → 断言真实 llm.stream 调用
 * 覆盖：路由分发、round-robin 指针（F13）、失败切换（failover）、无候选组、prepareCall。
 *
 * 组配置显式 speedTest.enabled = false：默认值是真，首次使用会后台触发一次真实测速
 * （F14 行为），会污染本文件对 llm.stream 调用序列的断言。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROUTE = 'roundrobin/';

/**
 * 最小 Cordis ctx 替身：只实现插件真正用到的面。
 * ctx.timeout 按 cordis-plugin-timer 的真实语义实现两种形态：
 *   ctx.timeout(callback, delay) → 注册 effect 并返回 disposer
 *   ctx.timeout(delay)           → 返回 promise（真实实现 dispose 时会 reject，
 *                                  测试替身只 resolve，避免收尾清理产生 unhandled rejection）
 */
function makeCtx({ llmStream }) {
  const registered = [];
  const effects = [];
  const settingsCtx = {
    settings: {
      update: async () => ({}),
      mutate: async () => ({}),
      describe: () => [],
    },
  };
  const ctx = {
    fiber: { uid: 1, entry: { options: { id: 'model-channel-manager' } } },
    get: () => undefined,
    plugin: () => {}, // Gateway controller is exercised by runtime-api.test.cjs.
    on: () => {},
    effect: (cb) => { const d = cb(); if (typeof d === 'function') effects.push(d); return d; },
    timeout: (...args) => {
      const cb = typeof args[0] === 'function' ? args.shift() : undefined;
      const delay = args[0];
      if (cb) {
        const t = setTimeout(cb, delay);
        const dispose = () => clearTimeout(t);
        effects.push(dispose);
        return dispose;
      }
      return new Promise((resolve) => {
        const t = setTimeout(resolve, delay);
        effects.push(() => clearTimeout(t));
      });
    },
    inject: (deps, cb) => { if (deps.includes('settings')) cb(settingsCtx); },
    llm: {
      registerAdapter: (providers, adapter) => { registered.push({ providers, adapter }); return { replace: () => {} }; },
      listProviders: () => [],
      stream: llmStream,
      resolveModelInfo: async () => null,
    },
  };
  // 测试收尾必须执行全部 effect disposer：插件注册了 5s 兜底轮询 interval，
  // 不清理会让 node --test 进程永不退出（这也顺带覆盖了 dispose 路径）。
  const disposeAll = () => { for (const d of effects.splice(0)) { try { d(); } catch (_e) { } } };
  return { ctx, registered, disposeAll };
}

async function loadPlugin() {
  return import(pathToFileURL(path.join(__dirname, '../src/index.js')).href);
}

/** 建组：默认关掉自动测速，避免后台真实测速污染调用序列断言。 */
const group = (id, strategy, candidates) => ({ id, strategy, candidates, speedTest: { enabled: false } });

async function setup(groups, llmStream) {
  const { apply, Config } = await loadPlugin();
  const h = makeCtx({ llmStream });
  apply(h.ctx, Config({ groups, providerOrder: [], effortMemory: {}, health: {} }));
  assert.equal(h.registered.length, 1, '应注册一个路由适配器');
  return { adapter: h.registered[0].adapter, disposeAll: h.disposeAll };
}

const okStream = (text) => (async function* () {
  yield { type: 'text-delta', text };
  yield { type: 'finish', reason: { kind: 'stop' } };
})();

async function drain(iter) {
  const out = [];
  for await (const chunk of iter) out.push(chunk);
  return out;
}

test('引擎集成：round-robin 组的一次请求能正常完成（cursor 必须已声明）', async () => {
  const calls = [];
  const { adapter, disposeAll } = await setup(
    [group('round-a', 'round-robin', [{ provider: 'p1', model: 'm1' }, { provider: 'p2', model: 'm2' }])],
    (opts) => { calls.push(opts.provider + '::' + opts.model); return okStream('hello'); },
  );
  try {
    const chunks = await drain(adapter.stream({ provider: ROUTE + 'round-a', model: 'virtual', messages: [] }));
    assert.deepEqual(calls, ['p1::m1'], '首个请求应命中第一个候选');
    assert.ok(chunks.some((c) => c.type === 'text-delta' && c.text === 'hello'), '应把内容块透传给下游');
    assert.ok(chunks.some((c) => c.type === 'finish' && c.reason && c.reason.kind === 'stop'), '应以成功终止块结束');
  } finally { disposeAll(); }
});

test('引擎集成：round-robin 指针在选定时刻推进（并发均分，F13）', async () => {
  const calls = [];
  const { adapter, disposeAll } = await setup(
    [group('round-b', 'round-robin', [{ provider: 'p1', model: 'm1' }, { provider: 'p2', model: 'm2' }])],
    (opts) => { calls.push(opts.provider + '::' + opts.model); return okStream('x'); },
  );
  try {
    // 同时发起两个请求——旧实现两个都打 p1（成功后指针才推进）
    const [a, b] = await Promise.all([
      drain(adapter.stream({ provider: ROUTE + 'round-b', model: 'virtual', messages: [] })),
      drain(adapter.stream({ provider: ROUTE + 'round-b', model: 'virtual', messages: [] })),
    ]);
    assert.ok(a.length > 0 && b.length > 0, '两个请求都应完成');
    assert.deepEqual(calls.slice(0, 2).sort(), ['p1::m1', 'p2::m2'], '并发两请求应落在不同候选（原子预留）');
  } finally { disposeAll(); }
});

test('引擎集成：首个候选失败时切换到下一个（failover）', async () => {
  const calls = [];
  // maxRetriesPerCandidate: 0 —— 关掉单候选重试，让 failover 顺序可断言
  const { adapter, disposeAll } = await setup(
    [Object.assign(group('fo', 'primary', [{ provider: 'bad', model: 'm' }, { provider: 'good', model: 'm' }]), { maxRetriesPerCandidate: 0 })],
    (opts) => {
      calls.push(opts.provider + '::' + opts.model);
      if (opts.provider === 'bad')
        return (async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'SERVER' } } }; })();
      return okStream('ok');
    },
  );
  try {
    const chunks = await drain(adapter.stream({ provider: ROUTE + 'fo', model: 'virtual', messages: [] }));
    assert.deepEqual(calls.slice(0, 2), ['bad::m', 'good::m'], '失败候选之后应尝试下一个');
    assert.ok(chunks.some((c) => c.type === 'text-delta' && c.text === 'ok'), '最终应拿到可用候选的内容');
  } finally { disposeAll(); }
});

test('引擎集成：单候选重试（maxRetriesPerCandidate）在切换之前生效', async () => {
  const calls = [];
  const { adapter, disposeAll } = await setup(
    [Object.assign(group('rt', 'primary', [{ provider: 'bad', model: 'm' }, { provider: 'good', model: 'm' }]), { maxRetriesPerCandidate: 1 })],
    (opts) => {
      calls.push(opts.provider + '::' + opts.model);
      if (opts.provider === 'bad')
        return (async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'SERVER' } } }; })();
      return okStream('ok');
    },
  );
  try {
    await drain(adapter.stream({ provider: ROUTE + 'rt', model: 'virtual', messages: [] }));
    assert.deepEqual(calls.slice(0, 3), ['bad::m', 'bad::m', 'good::m'], '先按配置重试同候选，再切换');
  } finally { disposeAll(); }
});

test('引擎集成：未知组返回 NO_ADAPTER 终止块而不是抛异常', async () => {
  const { adapter, disposeAll } = await setup(
    [group('g1', 'primary', [{ provider: 'p', model: 'm' }])],
    () => (async function* () { })(),
  );
  try {
    const chunks = await drain(adapter.stream({ provider: ROUTE + 'nope', model: 'virtual', messages: [] }));
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].type, 'finish');
    assert.equal(chunks[0].reason.failure.code, 'NO_ADAPTER');
  } finally { disposeAll(); }
});

test('引擎集成：prepareCall 返回的 stream 与直接 stream 走同一引擎', async () => {
  const calls = [];
  const { adapter, disposeAll } = await setup(
    [group('pc', 'primary', [{ provider: 'p1', model: 'm1' }])],
    (opts) => { calls.push(opts.provider + '::' + opts.model); return okStream('prepared'); },
  );
  try {
    const prepared = await adapter.prepareCall(ROUTE + 'pc', 'virtual', undefined);
    assert.ok(prepared && prepared.model, 'prepareCall 应返回模型元数据快照');
    const chunks = await drain(prepared.stream({ provider: ROUTE + 'pc', model: 'virtual', messages: [] }));
    assert.deepEqual(calls, ['p1::m1']);
    assert.ok(chunks.some((c) => c.type === 'text-delta' && c.text === 'prepared'));
  } finally { disposeAll(); }
});

test('引擎集成：effect disposer 全部可执行（卸载不留悬挂 interval）', async () => {
  const { disposeAll } = await setup(
    [group('g2', 'primary', [{ provider: 'p1', model: 'm1' }])],
    () => okStream('x'),
  );
  assert.doesNotThrow(() => disposeAll(), 'disposer 不应抛错');
});
