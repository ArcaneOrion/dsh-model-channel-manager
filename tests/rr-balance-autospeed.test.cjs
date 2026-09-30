/**
 * F13/F14 回归（审计 H07/H13）：
 *  F13 round-robin 并发均分：指针在选择时原子预留（不再成功后推进）。
 *     H13 复现：两个并发请求都选 first——旧实现完成才推 currentIndex。
 *  F14 自动测速触发：enabled 且无结果的组，首次真实使用后台触发。
 *     H07 复现：enabled=true，boot 与首次请求都不触发——常规路径无入口。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');

test('F13 源级：round-robin 选定时原子预留', () => {
  const m = src.match(/if \(strategy === 'round-robin'\) \{\s*\n\s*cursor = rt\.currentIndex % order\.length;\s*\n\s*rt\.currentIndex = \(cursor \+ 1\) % order\.length;/);
  assert.ok(m, '应在选定时同步推进指针（原子预留）');
  // 成功路径不再推进 round-robin（只维护 sticky/primary）
  const succ = src.match(/rt\.cooldowns\.delete\(key\);[\s\S]{0,750}?break;/);
  assert.ok(succ, '成功路径块应存在');
  assert.ok(!/strategy === 'round-robin'\)\s*\n\s*rt\.currentIndex = \(pos \+ 1\)/.test(succ[0]), '成功路径不应再推进 round-robin 指针');
  assert.ok(/strategy === 'sticky'/.test(succ[0]), 'sticky 语义保留');
});

test('F13 行为级：并发两次请求拿到不同起始候选（选择时预留）', () => {
  // 复刻修复后的指针逻辑（与源码对齐）：选择时读改写，同步原子
  const rt = { currentIndex: 0 };
  const order = ['first', 'second'];
  const pick = () => {
    const cursor = rt.currentIndex % order.length;
    rt.currentIndex = (cursor + 1) % order.length;
    return order[cursor];
  };
  // 并发：两次 pick 都在任何一个「完成」之前发生（模拟 H13 场景）
  const a = pick();
  const b = pick();
  assert.equal(a, 'first');
  assert.equal(b, 'second', '第二次并发请求应拿到 second（旧实现两个都拿 first）');
  // 串行对照（V01）：第三个继续轮转
  assert.equal(pick(), 'first');
});

test('F14 源级：streamGroup 首次使用触发自动测速（enabled 且无结果）', () => {
  const m = src.match(/F14（审计 H07）[\s\S]{0,500}?runSpeedTest\(cfg\)\.catch/);
  assert.ok(m, 'streamGroup 应有 F14 自动测速分支');
  assert.ok(/cfg\.speedTest\.enabled/.test(m[0]), '以 enabled 为条件');
  assert.ok(/\(state\.speedResults\[cfg\.id\] \|\| \[\]\)\.length === 0/.test(m[0]), '以无结果为条件');
  assert.ok(/!rt\.speedTestRunning/.test(m[0]), '防重入守卫');
  assert.ok(/runSpeedTest\(cfg\)\.catch\(\(\) => \{ \}\)/.test(src), '后台触发不 await（fire-and-forget）');
});

test('F14 行为级：触发条件矩阵', () => {
  // 复刻 F14 条件（与源码对齐；cfg.id 必须与 speedResults 键匹配才构成「已有结果」）
  const shouldTrigger = (cfg, speedResults, running) =>
    cfg.speedTest.enabled && (speedResults[cfg.id] || []).length === 0 && !running;
  assert.ok(shouldTrigger({ id: 'g1', speedTest: { enabled: true } }, {}, false), 'enabled+无结果+空闲 → 触发');
  assert.ok(!shouldTrigger({ id: 'g1', speedTest: { enabled: false } }, {}, false), 'disabled → 不触发');
  assert.ok(!shouldTrigger({ id: 'g1', speedTest: { enabled: true } }, { g1: [{ provider: 'a', model: 'm', ok: true }] }, false), '已有结果 → 不触发（H07 的对照组）');
  assert.ok(shouldTrigger({ id: 'g1', speedTest: { enabled: true } }, { g2: [{ provider: 'a', model: 'm', ok: true }] }, false), '他组的结果不影响本组 → 仍触发');
  assert.ok(!shouldTrigger({ id: 'g1', speedTest: { enabled: true } }, {}, true), '测速进行中 → 不重入');
});
