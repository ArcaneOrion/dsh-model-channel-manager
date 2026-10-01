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






// ───────────────────────── R3：guard 与启动清扫接线 ─────────────────────────
test('R3：timed() 在 dispose 时主动 reject（不再只 clearTimeout）', () => {
  assert.ok(/fire\(\{ code: 'ABORTED', message: 'plugin reloaded while this attempt was in flight' \}\)/.test(srcIndex),
    'dispose 应 reject ABORTED');
  assert.ok(/const fire = \(err\) => \{ if \(settled\) return; settled = true; rejectFn\(err\); \}/.test(srcIndex),
    'guard 应防重复 settle');
});



// ───────────────────────── 退避 + 兜底轮询（审计 #6 / R2） ─────────────────────────






// ───────────────────────── #7 / #13 ─────────────────────────
test('#7：host 测试预算 60s → 45s（给终态写入留余量）', () => {
  assert.ok(srcIndex.includes('const MODEL_TEST_TOTAL_MS = 45000;'), '预算应为 45s');
  assert.ok(!srcIndex.includes('const MODEL_TEST_TOTAL_MS = 60000;'), '不应残留 60s');
});



// ───────────────────────── client（#11 / 放弃提示三态） ─────────────────────────




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
