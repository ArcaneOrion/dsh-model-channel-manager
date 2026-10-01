/**
 * 运行时加固回归（0.3.12 第二轮：审计 R2/R3 + #7/#10/#11/#13）
 *
 * 覆盖：
 *  - selectStaleTestEntries（真实导出）：重启后遗留 running 条目分类（补写 ABORTED / 修僵尸）
 *  - timed() 守卫在 fiber dispose 时主动 reject（旧实现只 clearTimeout → 在飞测试永久挂死）
 *  - notReady 释放认领后的退避窗口；未消费请求的兜底轮询与显式日志
 *  - migrateLegacyConfig 走 writeConfig（切出 HMR 事务）
 *  - client：digest 空数组不遮蔽 records；放弃提示三态
 *  - HealthStore：事件去重指纹（同毫秒不同结果不合并）、putSpeedRows 入写链、close 排干写链
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const srcIndex = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
const srcClient = fs.readFileSync(path.join(__dirname, '../src/client.js'), 'utf8');
const srcStore = fs.readFileSync(path.join(__dirname, '../src/health-store.js'), 'utf8');

// ───────────────────────── selectStaleTestEntries（真实导出） ─────────────────────────
test('清扫分类：running 无 finishedAt = 遗留在飞任务（ABORTED）', async () => {
  const { selectStaleTestEntries } = await import(pathToFileURL(path.join(__dirname, '../src/index.js')).href);
  const r = selectStaleTestEntries({
    '1': { status: 'running', startedAt: 100 },
    '2': { status: 'ok', finishedAt: 200 },
    '3': { status: 'error', finishedAt: 200 },
  });
  assert.deepEqual(r.aborted, ['1']);
  assert.deepEqual(r.repaired, []);
});

test('清扫分类：running + 终态字段 = 僵尸条目（按 ok 修状态位）', async () => {
  const { selectStaleTestEntries } = await import(pathToFileURL(path.join(__dirname, '../src/index.js')).href);
  // 线上物证形态：status 被并发整树回写改回 running，但 code/error/finishedAt 都在
  const r = selectStaleTestEntries({
    '3107804232431564': { status: 'running', code: 'SERVER', error: '503', finishedAt: 1790824333158 },
    '4da347c2': { status: 'running', ok: true, ttftMs: 36597, finishedAt: 1790782362906 },
  });
  assert.deepEqual(r.aborted, []);
  assert.equal(r.repaired.length, 2);
});

test('清扫分类：running + finishedAt 但没有终态信息 → 不动（无法判断成败）', async () => {
  const { selectStaleTestEntries } = await import(pathToFileURL(path.join(__dirname, '../src/index.js')).href);
  const r = selectStaleTestEntries({ '9': { status: 'running', finishedAt: 1 } });
  assert.deepEqual(r.aborted, []);
  assert.deepEqual(r.repaired, []);
});

// ───────────────────────── R3：guard 与启动清扫接线 ─────────────────────────
test('R3：timed() 在 dispose 时主动 reject（不再只 clearTimeout）', () => {
  assert.ok(/fire\(\{ code: 'ABORTED', message: 'plugin reloaded while this attempt was in flight' \}\)/.test(srcIndex),
    'dispose 应 reject ABORTED');
  assert.ok(/const fire = \(err\) => \{ if \(settled\) return; settled = true; rejectFn\(err\); \}/.test(srcIndex),
    'guard 应防重复 settle');
});

test('R3：启动清扫先于首次消费 testRequest', () => {
  const sweep = srcIndex.indexOf('sweepStaleTestResults();');
  const reload = srcIndex.indexOf('reloadFromConfig(true);', sweep);
  assert.ok(sweep > 0 && reload > sweep, 'sweepStaleTestResults 必须在 reloadFromConfig(true) 之前调用');
  assert.ok(srcIndex.includes("bus.writeHealthLeaf(['testResults', key]"), '清扫应通过叶写回补终态');
});

// ───────────────────────── 退避 + 兜底轮询（审计 #6 / R2） ─────────────────────────
test('退避窗口：notReady 释放认领后 5s 内不再消费（测试与测速）', () => {
  assert.ok(srcIndex.includes('testBackoffUntil = Date.now() + 5000'), '测试路径应设置退避');
  assert.ok((srcIndex.match(/speedBackoffUntil = Date\.now\(\) \+ 5000/g) || []).length >= 2, '测速两条释放路径都应设置退避');
  assert.ok(srcIndex.includes('if (Date.now() < testBackoffUntil) return;'), '消费前应检查退避');
  assert.ok(srcIndex.includes('Date.now() < speedBackoffUntil'), '测速消费前应检查退避');
});

test('R2：未消费请求有显式日志 + 5s 兜底重试（复用同一判定函数）', () => {
  assert.ok(srcIndex.includes('testRequest 未被消费: nonce'), '应有未消费显式日志');
  assert.ok(srcIndex.includes('sweepPendingTestRequest'), '应有兜底重试函数');
  assert.ok(srcIndex.includes('model-channel pending-request sweep'), '应注册周期性兜底');
  assert.ok(/sweepPendingTestRequest[\s\S]{0,900}shouldConsumeNonce\(/.test(srcIndex), '兜底判定应复用 shouldConsumeNonce');
  assert.ok(srcIndex.includes('每个 nonce 只提醒一次') || srcIndex.includes('warnedTestNonces'), '日志应按 nonce 去重');
});

test('R2：health 子树运行时被兜底清空要告警（0.3.11 事故形态）', () => {
  assert.ok(srcIndex.includes('health 子树在运行时变空'), '应有整树清空告警');
  assert.ok(srcIndex.includes('lastHealthKeyCount'), '应记录键数用于对比');
});

// ───────────────────────── #7 / #13 ─────────────────────────
test('#7：host 测试预算 60s → 45s（给终态写入留余量）', () => {
  assert.ok(srcIndex.includes('const MODEL_TEST_TOTAL_MS = 45000;'), '预算应为 45s');
  assert.ok(!srcIndex.includes('const MODEL_TEST_TOTAL_MS = 60000;'), '不应残留 60s');
});

test('#13：migrateLegacyConfig 走 writeConfig（切出 HMR 事务）', () => {
  assert.ok(srcIndex.includes('const writeConfig = (patch) =>'), 'bus 应提供 writeConfig');
  assert.ok(srcIndex.includes('await bus.writeConfig({ groups: migrated.groups })'), '迁移应走 writeConfig');
  assert.ok(!srcIndex.includes('await bus.settings.update(SELF_NS, { groups: migrated.groups })'), '不应再直写 settings');
});

// ───────────────────────── client（#11 / 放弃提示三态） ─────────────────────────
test('#11：digest 空数组不再遮蔽 settings 里的 records', () => {
  assert.ok(srcClient.includes('hasRawRecords'), '应检测 records 是否有内容');
  assert.ok(/Array\.isArray\(health\.digest\) && \(health\.digest\.length > 0 \|\| !hasRawRecords\)/.test(srcClient),
    'digest 为空且有 records 时应回落 records 路径');
});

test('client：放弃提示区分「未写入」「仍在执行」「已结算但结果缺失」', () => {
  assert.ok(srcClient.includes('POLL_TIMEOUT_SETTLED'), '应有已结算但结果缺失的提示');
  assert.ok(srcClient.includes('POLL_TIMEOUT_RUNNING'), '应有仍在执行的提示');
  assert.ok(srcClient.includes('lastTestHandledNonce'), '放弃前应比对 lastTestHandledNonce');
});

// ───────────────────────── #10：HealthStore ─────────────────────────
async function loadStore(t) {
  try {
    const mod = await import(pathToFileURL(path.join(__dirname, '../src/health-store.js')).href);
    return mod.HealthStore;
  } catch (e) {
    if (/Cannot find package/.test(String(e && e.message))) { t.skip('zod/storage-domain 不可解析，跳过'); return null; }
    throw e;
  }
}

function fakeStore(HealthStore) {
  const buckets = new Map();
  const speedBuckets = new Map();
  const store = new HealthStore({});
  store.events = {
    get: (k) => buckets.get(k),
    put: async (k, v) => { buckets.set(k, JSON.parse(JSON.stringify(v))); },
    update: async (k, fn) => {
      const cur = buckets.get(k);
      if (cur === undefined) { const err = new Error('missing-key'); err.code = 'missing-key'; throw err; }
      buckets.set(k, JSON.parse(JSON.stringify(fn(cur))));
    },
  };
  store.speed = {
    get: (k) => speedBuckets.get(k),
    put: async (k, v) => { speedBuckets.set(k, JSON.parse(JSON.stringify(v))); },
  };
  return { store, buckets, speedBuckets };
}

test('#10：同毫秒同渠道但结果不同的两笔事件不再被合并', async (t) => {
  const HealthStore = await loadStore(t);
  if (!HealthStore) return;
  const { store, buckets } = fakeStore(HealthStore);
  const ts = 1790824333158;
  await store.appendEvent('p1', { ts, provider: 'p1', model: 'm', ok: true, ttftMs: 100, latencyMs: 200 });
  await store.appendEvent('p1', { ts, provider: 'p1', model: 'm', ok: false, ttftMs: null, latencyMs: 5000, code: 'TIMEOUT' });
  assert.equal(buckets.get('p1').events.length, 2, '同毫秒的两笔真实请求都应保留');
  // 迁移去重仍幂等：同一批重复导入不翻倍
  await store.migrateFrom({ p1: buckets.get('p1').events }, {});
  assert.equal(buckets.get('p1').events.length, 2, '重复导入应被指纹去重');
});

test('#10：putSpeedRows 与事件写入共用同一条写链（不交错）', async (t) => {
  const HealthStore = await loadStore(t);
  if (!HealthStore) return;
  const { store, speedBuckets } = fakeStore(HealthStore);
  const order = [];
  const slowEvents = store.events;
  store.events = {
    get: slowEvents.get,
    put: async (k, v) => { await new Promise((r) => setTimeout(r, 40)); order.push('event'); return slowEvents.put(k, v); },
    update: slowEvents.update,
  };
  const slowSpeed = store.speed;
  store.speed = { get: slowSpeed.get, put: async (k, v) => { order.push('speed'); return slowSpeed.put(k, v); } };
  const p1 = store.appendEvent('p1', { ts: Date.now(), provider: 'p1', model: 'm', ok: true });
  const p2 = store.putSpeedRows('g1', [{ provider: 'p1', model: 'm', ok: true, ttft: 1, latency: 2, at: Date.now() }]);
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ['event', 'speed'], '测速写入应排在事件写入之后（同链）');
  assert.ok(speedBuckets.get('g1').rows.length === 1);
});

test('#10：close() 先排干写链再关 domain（不丢排队中的最后一笔）', async (t) => {
  const HealthStore = await loadStore(t);
  if (!HealthStore) return;
  const { store, buckets } = fakeStore(HealthStore);
  let closed = false;
  let eventsAtClose = -1;
  store.ready = Promise.resolve({ close: async () => { closed = true; eventsAtClose = (buckets.get('p1') || {}).events?.length ?? 0; } });
  const slowPut = store.events.put;
  store.events.put = async (k, v) => { await new Promise((r) => setTimeout(r, 30)); return slowPut(k, v); };
  const append = store.appendEvent('p1', { ts: Date.now(), provider: 'p1', model: 'm', ok: true });
  const closing = store.close();
  await Promise.all([append, closing]);
  assert.ok(closed, 'domain 应被关闭');
  assert.equal(eventsAtClose, 1, '关闭时排队的写入应已落盘');
});
