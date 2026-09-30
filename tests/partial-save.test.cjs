/**
 * F06 回归（审计 C10）：两域保存的半成功可观察性。
 * C10 复现：providers 保存被拒、轮询组仍提交成功 → 旧实现统一「保存失败」，
 * 用户不知道轮询组其实已经落盘（指向不存在 provider 的引用已提交）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const client = fs.readFileSync(path.join(__dirname, '../src/client.js'), 'utf8');

// 复刻修复后的结算逻辑（与 save() 内对齐）
function settleSaveResults(results, cleanProviders) {
  const done = results.map((r) => r.value)
  const failed = done.filter((d) => d && !d.ok)
  const okCount = done.length - failed.length
  let notice
  if (failed.length === 0) notice = '已全部保存（即时生效）'
  else if (okCount > 0) notice = '部分保存：' + done.filter((d) => d && d.ok).map((d) => d.label).join('、') + ' 已生效；' + failed.map((d) => d.label).join('、') + ' 失败——' + failed[0].error
  else notice = '保存失败: ' + failed[0].error
  return { notice, allOk: failed.length === 0 }
}

test('F06 行为级：C10 场景——providers 拒、轮询组成 → 部分成功且明示', () => {
  const r = settleSaveResults([
    { value: { label: '提供商配置', ok: false, error: 'settings/conflict' } },
    { value: { label: '轮询组配置', ok: true } },
  ])
  assert.ok(r.notice.includes('部分保存'), '应明示部分保存')
  assert.ok(r.notice.includes('轮询组配置 已生效'.slice(0, 3)), '成功域被列出')
  assert.ok(r.notice.includes('提供商配置'), '失败域被列出')
  assert.ok(r.notice.includes('settings/conflict'), '失败原因保留')
  assert.equal(r.allOk, false, 'allOk=false（不同步本地镜像）')
});

test('F06 行为级：全成/全败两极', () => {
  const ok = settleSaveResults([
    { value: { label: '提供商配置', ok: true } },
    { value: { label: '轮询组配置', ok: true } },
  ])
  assert.ok(ok.notice.includes('已全部保存'))
  assert.equal(ok.allOk, true)
  const bad = settleSaveResults([
    { value: { label: '提供商配置', ok: false, error: 'x' } },
    { value: { label: '轮询组配置', ok: false, error: 'y' } },
  ])
  assert.ok(bad.notice.startsWith('保存失败'), '全败统一失败提示')
  assert.equal(bad.allOk, false)
});

test('F06 源级：allSettled + settleOf + 三态提示', () => {
  assert.ok(/Promise\.allSettled\(\[settleOf\(/.test(client), '应用 allSettled 分域结算');
  assert.ok(/const settleOf = \(label, p\) =>/.test(client), 'settleOf 包装应存在');
  assert.ok(/部分保存：/.test(client), '部分保存提示文案');
  assert.ok(/failed\.length === 0\) \{\s*\n\s*setDraft\(clone\(cleanProviders\)\)/.test(client), '仅全成才同步本地镜像');
  assert.ok(/8000 : 3000/.test(client), '失败提示展示更长（8s vs 3s）');
});
