/**
 * settings revision 冲突回归（0.3.14）
 *
 * 现象：保存时提示「部分保存：提供商配置 已生效；轮询组配置 失败——轮询组配置已被
 * 其他页面修改（版本冲突），请点「刷新」后重试」，且要点多次才成功。
 *
 * 机制（dsh-settings 源码事实）：
 *   describe() 里 `raw = JSON.stringify([fiber.uid, schema.toJSON(), entry.options.config ?? {}])`，
 *   `revision = previous.revision + Number(previous.raw !== raw)` —— **revision 是「该行 raw config
 *   的 JSON 指纹」**。而本插件的 settings 行同时承载健康投影：宿主每 5s 的 digest 叶写、runtime、
 *   testResults 都会改动该行 raw config → revision 不断前进。
 *   于是 client 加载时记下的 revision 在几秒内必然过期，保存被 settings/conflict 拒绝——
 *   提示里的「其他页面」其实是插件自己写的健康数据（providers 走的是另一个行 llm-pi-ai，
 *   没有这种自噪声，所以它总是先成功）。
 *
 * 修法：
 *   - client：写入前重新读取 revision；冲突时比较远端值与我们加载时的基线，只有远端真的变了
 *     才报冲突，否则视为自噪声并用新 revision 重试（最多 3 次）；
 *   - host：digest 内容未变时不写（减少 revision 噪声，60s 心跳保底）。
 *
 * client 是单文件浏览器 bundle（不可被 node 直接 import），故这里用源级断言锁住修复模式；
 * 判定语义（strict 等值/指纹）的行为测试见 tests/task-dedup.test.cjs 与 runtime-hardening。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const client = fs.readFileSync(path.join(__dirname, '../src/client.js'), 'utf8');
const host = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');



test('client：冲突只在「远端真的改过」时报出，自噪声自动重试', () => {
  assert.ok(/const isConflict = \(err\) =>/.test(client), '应有冲突判定');
  assert.ok(/settings\/conflict/.test(client), '应识别宿主冲突码');
  assert.ok(/for \(let attempt = 0; attempt < attempts; attempt\+\+\)/.test(client), '应有有界重试循环');
  assert.ok(/if \(!sameJson\(remoteOf\(now\), baseline\)\) throw new Error\(conflictMessage\)/.test(client),
    '远端未变 → 重试；远端已变 → 报冲突');
  assert.ok(/已自动重试 ' \+ attempts \+ ' 次仍未成功/.test(client), '重试耗尽要有明确提示');
});

test('client：两处保存都走同一封装，且基线取自「加载时的值」', () => {
  assert.ok(/saveWithRevisionRetry\(\{\s*ns: 'llm-pi-ai',\s*baseline: \(state && state\.providers\) \|\| \{\}/.test(client),
    'providers 保存：基线 = 加载时的 resolved providers');
  assert.ok(/saveWithRevisionRetry\(\{\s*ns: 'model-channels',\s*baseline: \{ groups: channels \|\| \[\], providerOrder: \(state && state\.providerOrder\) \|\| \[\] \}/.test(client),
    '轮询组保存：基线 = 加载时的 groups + providerOrder');
});

test('client：canonicalJson 对对象键排序（键序差异不算「远端改过」）', () => {
  assert.ok(/const canonicalJson = \(v\) =>/.test(client), '应有规范 JSON 助手');
  assert.ok(/Object\.keys\(v\)\.sort\(\)/.test(client), '对象键应排序后比较');
  assert.ok(/const sameJson = \(a, b\) => canonicalJson\(a\) === canonicalJson\(b\)/.test(client), '应有 sameJson');
});
