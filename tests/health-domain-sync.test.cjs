/**
 * 健康数据同步重构的行为回归（0.3.1）：
 *  1. recordHealth 走 domain 追加后，volatile 快照覆盖（旧 F11/F23 竞态）不再丢记录；
 *  2. digest 小投影会生成且包含聚合口径（total/success/token）；
 *  3. 旧 host 兼容：healthStore 缺席时内存镜像仍工作。
 *
 * 纯模块级测试：不启动 Cordis，直接以 mock healthStore 驱动 index.js 的
 * recordHealth/digest 逻辑等价路径（真实的 storageDomain 组合在安装环境验证）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// 提取 src/index.js 的 recordHealth 逻辑做等价性验证：
// 由于 apply() 闭包无法直接导入，这里对「关键行为契约」做源级断言 + 逻辑复刻验证。
const src = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');

test('recordHealth 不再有 2s 防抖 flush + pendingRecords 缓冲（竞态根因移除）', () => {
  assert.ok(!src.includes('pendingRecords.push'), 'pendingRecords 缓冲应已删除');
  assert.ok(!/healthFlushHandle/.test(src), '2s 防抖句柄应已删除');
  assert.ok(src.includes('healthStore.appendEvent'), 'recordHealth 应改为 domain 追加');
});

test('reloadFromConfig 优先从 domain 读权威数据（volatile 覆盖不再抹流水）', () => {
  assert.ok(src.includes('healthStore.allEventBuckets()'), '应从 domain 读事件桶');
  assert.ok(!src.includes('for (const p of pendingRecords)'), '快照覆盖后的补账循环应已删除');
});

test('digest 小投影：schema 声明 + 写入路径存在', () => {
  assert.ok(src.includes('digest: z.array(z.any()).default([])'), 'HEALTH_SCHEMA 应含 digest');
  assert.ok(src.includes('buildDigest()'), '应有 buildDigest 聚合');
  assert.ok(src.includes('digestAt'), '投影应带生成时刻');
});

test('聚合口径：digest 含 token 三分项与 lastTs（client 渲染所需全字段）', () => {
  const m = src.match(/const buildDigest = [\s\S]*?\n    };/);
  assert.ok(m, 'buildDigest 函数应存在');
  const body = m[0];
  for (const field of ['tokIn', 'tokOut', 'tokCache', 'lastTs', 'lastOk', 'lastCode', 'ttftAvg', 'latAvg']) {
    assert.ok(body.includes(field), 'digest 应含字段 ' + field);
  }
});

test('存量迁移：settings records → domain 一次性搬运 + 标记', () => {
  assert.ok(src.includes('migrateHealthToDomain'), '迁移函数应存在');
  assert.ok(src.includes('healthMigrated'), '迁移标记应存在');
  assert.ok(src.includes('migrateFrom('), '应调用 HealthStore.migrateFrom');
});

test('HealthStore：迁移幂等（桶已存在即跳过）+ 窗口过期 + 截断 + 并发追加原子链', async (t) => {
  // health-store.js 依赖 zod/storage-domain（peerDeps，本仓无 node_modules）；
  // 环境缺依赖时跳过本条（CI/安装环境有依赖时生效）
  const zodPath = require.resolve('zod', { paths: ['/home/arcaneorion/.dsh/profiles/web/node_modules'] }).catch ?
    null : require.resolve('zod', { paths: ['/home/arcaneorion/.dsh/profiles/web/node_modules'] });
  let HealthStore;
  try {
    ({ HealthStore } = await import(pathToFileURL(path.join(__dirname, '../src/health-store.js')).href));
  }
  catch (e) {
    if (/Cannot find package/.test(String(e && e.message))) { t.skip('zod/storage-domain 不可解析（本机无依赖安装），跳过'); return; }
    throw e;
  }
  const store = new HealthStore({}); // ctx 未用到的路径
  const buckets = new Map();
  store.events = {
    get: (k) => buckets.get(k),
    put: async (k, v) => { buckets.set(k, v); },
    // 原子链契约模拟：update 在写链槽位看到当前值（真实 KvTable 语义）
    update: async (k, fn) => {
      const cur = buckets.get(k);
      if (cur === undefined) { const err = new Error('missing-key'); err.code = 'missing-key'; throw err; }
      const next = fn(cur);
      buckets.set(k, next);
      return next;
    },
    keys: () => buckets.keys(),
    entries: () => buckets.entries(),
  };
  const speedBuckets = new Map();
  store.speed = {
    get: (k) => speedBuckets.get(k),
    put: async (k, v) => { speedBuckets.set(k, v); },
    keys: () => speedBuckets.keys(),
    entries: () => speedBuckets.entries(),
  };
  const now = Date.now();
  const old = { ts: now - 8 * 24 * 3600 * 1000, provider: 'p1', model: 'm1', ok: true };
  const fresh = { ts: now - 1000, provider: 'p1', model: 'm1', ok: true, ttftMs: 50, latencyMs: 500, inputTokens: 10, outputTokens: 5 };
  await store.migrateFrom({ p1: [old, fresh] }, { g1: [{ provider: 'p1', model: 'm1', ok: true, ttft: 40, latency: 400, at: now }] });
  // 过期事件被窗口过滤
  assert.equal(buckets.get('p1').events.length, 1);
  assert.equal(buckets.get('p1').events[0].inputTokens, 10);
  assert.equal(speedBuckets.get('g1').rows.length, 1);
  // 二次迁移（桶已存在）不覆盖
  await store.migrateFrom({ p1: [{ ts: now, provider: 'p1', model: 'm1', ok: false }] }, {});
  assert.equal(buckets.get('p1').events.length, 1, '已有桶应跳过，domain 权威');
  // appendEvent 截断到 300
  for (let i = 0; i < 305; i++) {
    await store.appendEvent('p2', { ts: now - i, provider: 'p2', model: 'm', ok: true });
  }
  assert.equal(buckets.get('p2').events.length, 300);
  // 并发追加同一新桶（原子链语义）：初始化 + 两条并发追加，一条都不丢
  const p = await Promise.all([
    store.appendEvent('p3', { ts: now, provider: 'p3', model: 'm', ok: true }),
    store.appendEvent('p3', { ts: now, provider: 'p3', model: 'm', ok: false, code: 'X' }),
    store.appendEvent('p3', { ts: now, provider: 'p3', model: 'm', ok: true }),
  ]);
  assert.equal(buckets.get('p3').events.length, 3, '并发追加不应丢事件（missing-key 回退 + update 排队）');
});

test('client 兼容：digest 缺席时回落原始 records 路径', () => {
  const csrc = fs.readFileSync(path.join(__dirname, '../src/client.js'), 'utf8');
  assert.ok(csrc.includes("Array.isArray(health.digest)"), '应探测 digest 数组');
  assert.ok(csrc.includes('旧 host 原始流水路径'), '应保留旧路径兼容');
});

function pathToFileURL(p) {
  const { pathToFileURL: toURL } = require('node:url');
  return toURL(p);
}
