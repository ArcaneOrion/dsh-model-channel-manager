/**
 * storageDomain 接入方式的回归（0.3.10）：
 *
 * 线上事故：host 日志出现
 *   storageDomain open failed ... cannot get property "storageDomain" without inject
 * 原因是 `ctx.get('storageDomain')` 是宽松读取（直接读 store，不校验 inject），
 * 拿到裸服务后交给 HealthStore；HealthStore 用该 ctx 做属性访问时被 Cordis 代理
 * 拒绝——domain 永远打不开，健康流水静默降级为内存。
 *
 * 正确方式：响应式 `ctx.inject(['storageDomain'], (dctx) => ...)`，回调里的
 * dctx 才带 inject 声明，可以安全访问 dctx.storageDomain。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const src = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');

test('storageDomain 必须经响应式 inject 取得（不能再 ctx.get 裸读）', () => {
  assert.ok(/ctx\.inject\(\['storageDomain'\]/.test(src), '应有响应式 inject storageDomain');
  assert.ok(/new HealthStore\(dctx\)/.test(src), 'HealthStore 必须拿到注入后的上下文');
  assert.ok(!/new HealthStore\(ctx\)/.test(src), '不得把未注入的外层 ctx 交给 HealthStore');
  assert.ok(!/const domainFacility = ctx\.get\('storageDomain'\)/.test(src), '不应再用 ctx.get 探测');
  assert.ok(!/if \(domainFacility !== undefined\)/.test(src), '不应再按探测结果分支');
});

test('启动不等待 domain：boot 在 inject 之前，服务缺席也能工作', () => {
  const bootIdx = src.indexOf('\n        boot();');
  const injectIdx = src.indexOf("ctx.inject(['storageDomain']");
  assert.ok(bootIdx > 0 && injectIdx > 0, '两段都应存在');
  assert.ok(bootIdx < injectIdx, 'boot 必须先于 domain 接入，避免服务缺席时插件不启动');
  assert.ok(/scheduleDigest\(\); \/\/ 首屏投影/.test(src), '启动时应刷新 digest 投影');
});

test('迁移清理走 path-ops 真删除（update 深合并清不掉旧键）', () => {
  assert.ok(/const writeHealthOps = \(ops\)/.test(src), '应有 path-ops 写入通道');
  assert.ok(/settings\.mutate\(SELF_NS, ops, undefined\)/.test(src), 'path-ops 应走 settings.mutate');
  assert.ok(/\{ op: 'unset', path: \['health', 'records'\] \}/.test(src), 'records 应被 unset');
  assert.ok(/\{ op: 'unset', path: \['health', 'speedResults'\] \}/.test(src), 'speedResults 应被 unset');
  // 已迁移但残留旧键的 profile 也要清理（0.3.8/0.3.9 曾用合并写「清空」而没删掉）
  assert.ok(/alreadyMigrated && !hasRecords && !hasSpeed/.test(src), '应对残留旧键补清理');
});

test('行为级：HealthStore 用注入上下文打开 domain 并绑定两张表', async (t) => {
  let HealthStore;
  try {
    ({ HealthStore } = await import(pathToFileURL(path.join(__dirname, '../src/health-store.js')).href));
  }
  catch (e) {
    if (/Cannot find package/.test(String(e && e.message))) { t.skip('zod/storage-domain 不可解析，跳过'); return; }
    throw e;
  }
  const opened = [];
  const emptyTable = () => ({
    get: () => undefined,
    put: async () => { },
    update: async () => { },
    keys: () => [][Symbol.iterator](),
    entries: () => [][Symbol.iterator](),
    delete: async () => false,
  });
  const fakeDomain = { table: (name) => (opened.push(name), emptyTable()), close: async () => { } };
  // 模拟「已注入 storageDomain 的上下文」：属性访问可用
  const store = new HealthStore({ storageDomain: { open: async (spec) => { opened.push(spec); return fakeDomain; } } });
  const domain = await store.open();
  const spec = opened.find((x) => x && typeof x === 'object');
  assert.ok(spec, 'open 应收到 domain spec');
  assert.equal(spec.name, 'model_channel_health');
  assert.equal(spec.layout, 'per-record');
  assert.ok(spec.tables.events && spec.tables.speed, 'spec 应声明 events/speed 两张表');
  assert.ok(store.events && store.speed, '打开后应绑定两张表');
  assert.equal(domain, fakeDomain);
  // 幂等：再次 open 不重复调用
  await store.open();
  assert.equal(opened.filter((x) => x && typeof x === 'object').length, 1, 'open 应幂等');
  await store.close();
  assert.equal(store.events, null, 'close 后应解绑');
});
