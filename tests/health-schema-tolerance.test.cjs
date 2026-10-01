/**
 * health schema 容错回归（0.3.11 线上事故）：
 *
 * 事故链：0.3.2 起 client 写 UUID 字符串 nonce，而 HEALTH_SCHEMA 声明
 * `lastTestHandledNonce: z.number()`。字符串落盘后，**整个 health 子树**
 * 校验失败；HEALTH_SCHEMA 是 `.loose(true)`，宽松兜底返回 schema 默认值
 * （undefined），于是运行时 healthOf() 变成 {}——records/digest 全部消失、
 * 存量迁移空转、旧键清理无从下手，表现为「健康页没有历史数据」。
 *
 * 修复：nonce 声明为 union(number, string)。本回归用**真实 Config** 验证
 * 任意历史 nonce 形态都不会再清空整个 health 子树。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const src = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
const UUID = '4da347c2-6996-41fc-884a-f0fc719da1b4';
const records = { p1: [{ ts: 1, provider: 'p1', model: 'm1', ok: true }] };

let Config;
test('前置：真实 Config 可导入', async () => {
  ({ Config } = await import(pathToFileURL(path.join(__dirname, '../src/index.js')).href));
  assert.ok(Config, 'Config schema 应导出');
});

const healthOf = (sample) => {
  const out = Config(sample);
  const ref = out && out.health;
  return typeof ref?.get === 'function' ? ref.get() : ref;
};



test('行为级：数字 nonce 下 records 保留（基线）', () => {
  const h = healthOf({ health: { records, lastTestHandledNonce: 1790680002 } });
  assert.ok(h && h.records && h.records.p1, 'records 应保留');
  assert.equal(h.records.p1.length, 1);
  assert.equal(h.lastTestHandledNonce, 1790680002);
});

test('行为级：字符串 UUID nonce 下 records 不再被清空（事故复现）', () => {
  const h = healthOf({ health: { records, lastTestHandledNonce: UUID } });
  assert.ok(h && h.records && h.records.p1, '字符串 nonce 不得导致 records 丢失');
  assert.equal(h.records.p1.length, 1);
  assert.equal(h.lastTestHandledNonce, UUID, '历史字符串值应原样保留（不强行转数字）');
});

test('行为级：两个 nonce 同时是历史形态 + 其他字段齐全时不丢数据', () => {
  const h = healthOf({
    health: {
      records,
      speedResults: { g1: [{ provider: 'p1', model: 'm1', ok: true, ttft: 1, latency: 2, at: 1 }] },
      runtime: { g1: { currentIndex: 1 } },
      lastHandledNonce: UUID,
      lastTestHandledNonce: 1790680002,
      healthMigrated: true,
      digest: [{ provider: 'p1', model: 'm1', total: 1 }],
      digestAt: 1,
    },
  });
  assert.ok(h.records && h.records.p1, 'records 保留');
  assert.ok(h.speedResults && h.speedResults.g1, 'speedResults 保留');
  assert.ok(h.runtime && h.runtime.g1, 'runtime 保留');
  assert.ok(Array.isArray(h.digest) && h.digest.length === 1, 'digest 保留');
  assert.equal(h.healthMigrated, true, '标记保留');
});
