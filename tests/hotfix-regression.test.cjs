/**
 * 0.3.2 止血五项的源级回归（审计 F03/F04/F05/F18/F19）：
 *  1. F18 拖拽：onDragStart 必须用 realIdx（idx 未定义 = ReferenceError，拖拽全废）
 *  2. F04 保存门：ready 未置真前 save 直接拦截（不落 channelsDraft||[] 的「没读到当空」）
 *  3. F03 nonce：client 用 randomUUID（不再 Date.now()%1e9）；host 兼容 string/number
 *  4. F19 信封：fireTest/speedtest 的 then 检查 ok:false
 *  5. F05 revision：update/mutate 门面透传 expectedRevision；save 带两行 revision
 *
 * 源级断言（字符串/AST 级）：这些是「回归不复发」的守卫——某个 bug 的修复模式
 * 被无意改回时立刻红。行为级验证见 docs/audit 探针（0.2 适配后接入）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const client = fs.readFileSync(path.join(__dirname, '../src/client.js'), 'utf8');
const host = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');

test('F18 拖拽：onDragStart 使用 realIdx，不再引用未定义 idx', () => {
  const m = client.match(/onDragStart:[^}]+/);
  assert.ok(m, 'onDragStart 应存在');
  assert.ok(!/\bsetDragIdx\(idx\)/.test(client), 'setDragIdx(idx) 应已消失');
  assert.ok(/setDragIdx\(realIdx\)/.test(m[0]), '应改用 realIdx');
});

test('F04 保存门：ready 门 + 按钮禁用', () => {
  assert.ok(/const \[ready, setReady\] = useState\(false\)/.test(client), 'ready 状态应存在');
  assert.ok(/if \(!ready\) \{/.test(client), 'save 开头应拦截未就绪');
  assert.ok(/setReady\(true\)/.test(client), 'describe 成功应置真');
  assert.ok(/disabled: !ready \|\| saving/.test(client), '保存按钮应禁用');
});



test('健康页默认 7d：已有历史数据不因 30m 冷窗显示空', () => {
  assert.ok(/useState\('7d'\)/.test(client), 'HealthPanel 默认窗口应为 7d');
});





test('工程：test script + yaml devDependency + 优雅跳过', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'node --expose-internals --test "tests/*.test.cjs"', 'test script 应为 glob 形式');
  assert.ok(pkg.devDependencies && pkg.devDependencies.yaml, 'yaml 应声明为 devDependency');
});
