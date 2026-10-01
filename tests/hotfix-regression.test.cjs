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

test('F03 nonce：安全整数随机 nonce（兼容旧 host number schema）', () => {
  assert.ok(!/Date\.now\(\) % 1000000000/.test(client), 'client 不应再用时间戳取模');
  assert.ok(/const createNonce = \(\) =>/.test(client), '统一 nonce 工厂应存在');
  assert.ok(/crypto\.getRandomValues/.test(client), '优先用 crypto 随机数，跨标签低碰撞');
  // 0.3.12：降级路径也必须是安全整数（旧 Date.now()*1000+counter 超出 MAX_SAFE_INTEGER，
  // 同毫秒可能撞值；strict consume-once 去重下撞值 = 测试被静默丢弃）
  assert.ok(/Number\.MAX_SAFE_INTEGER/.test(client), '无 crypto 时降级到安全整数随机数');
  assert.ok(!/Date\.now\(\) \* 1000 \+ nonceFallbackCounter/.test(client), '降级路径不得再用超出安全范围的表达式');
  assert.ok(/const nonce = createNonce\(\)/.test(client), '测试/测速都应使用同一工厂');
  // host 仍兼容 number/string（旧/新 client 混部窗口），0.3.12 起收敛到统一的 nonceKey
  const testSide = /nonceOf = \(v\) => \(typeof v === 'number' \|\| typeof v === 'string'\)/.test(host);
  const speedSide = /nonceKey\(req && req\.nonce\)/.test(host);
  assert.ok(testSide, 'handleTestRequest 应兼容双类型');
  assert.ok(speedSide, 'speedRequest 消费应兼容双类型');
});

test('健康页默认 7d：已有历史数据不因 30m 冷窗显示空', () => {
  assert.ok(/useState\('7d'\)/.test(client), 'HealthPanel 默认窗口应为 7d');
});

test('F19 信封：测试/测速路径检查 ok:false', () => {
  // fireTest 块：从声明起到 pollTest 调用之间的信封检查
  const fireStart = client.indexOf('const fireTest = ');
  const fireEnd = client.indexOf('pollTest(nonce', fireStart);
  const fire = client.slice(fireStart, fireEnd);
  assert.ok(fireStart >= 0 && fireEnd > fireStart, 'fireTest 应存在');
  assert.ok(/r\.ok === false/.test(fire), 'fireTest 应检查信封');
  // speedtest 块：从声明起到 groups.map 前
  const spStart = client.indexOf('const speedtest = ');
  const spEnd = client.indexOf('groups.map', spStart);
  const speed = client.slice(spStart, spEnd);
  assert.ok(spStart >= 0 && spEnd > spStart, 'speedtest 应存在');
  assert.ok(/r\.ok === false/.test(speed), 'speedtest 应检查信封');
});

test('F05 revision：门面透传 + save 携带最新 revision + 冲突分类重试', () => {
  assert.ok(/args\.expectedRevision !== undefined/.test(client), '门面应透传 expectedRevision');
  assert.ok(/nsRevisions/.test(client), 'state 应记录两行 revision');
  // 0.3.14：不再用加载时那份必然过期的 revision（本行同时承载健康投影，宿主每 5s 的
  // digest 叶写都会推高它的 revision），改为每次写入前取最新 revision + 自噪声冲突重试
  assert.ok(/const saveWithRevisionRetry = async/.test(client), '应有带 revision 的保存重试封装');
  assert.ok(/const desc = await readNsDesc\(ns\)/.test(client), '每次写入前应重新读取 revision');
  assert.ok(/settings\/conflict/.test(client) && /const isConflict =/.test(client), '应识别宿主冲突码');
  assert.ok(/if \(!sameJson\(remoteOf\(now\), baseline\)\) throw new Error\(conflictMessage\)/.test(client),
    '只有远端值真的变了才报冲突（否则视为插件自身健康写入的 revision 噪声并重试）');
  assert.ok(/版本冲突/.test(client), '冲突提示文案应存在');
  assert.ok(/saveWithRevisionRetry\(\{\s*ns: 'llm-pi-ai'/.test(client), 'providers 保存应走重试封装');
  assert.ok(/saveWithRevisionRetry\(\{\s*ns: 'model-channels'/.test(client), '轮询组保存应走重试封装');
  assert.ok(!/expectedRevision: \(state && state\.nsRevisions/.test(client), '不应再用加载时的旧 revision 直接写入');
});

test('工程：test script + yaml devDependency + 优雅跳过', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'node --test "tests/*.test.cjs"', 'test script 应为 glob 形式');
  assert.ok(pkg.devDependencies && pkg.devDependencies.yaml, 'yaml 应声明为 devDependency');
});
