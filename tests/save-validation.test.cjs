/**
 * F16/F17 回归（审计 H08/C05）：
 *  F16：非法/重复组 ID、空候选——保存前拒绝 + host 丢弃时大声告警。
 *     H08：3 组保存（1 非法 + 2 重复）被接受，settings 有 3 组、路由只有 1 条。
 *  F17：provider 改名同步 presets 内引用。
 *     C05：主 candidates 已改名、activePreset 仍指旧 ID → 删旧 provider 后组悬空。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:path').join
  ? require('node:fs')
  : null;
const fss = require('node:fs');
const path = require('node:path');

const client = fss.readFileSync(path.join(__dirname, '../src/client.js'), 'utf8');
const host = fss.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');

// ---- F17：改名同步 presets（复刻修复后逻辑） ----
function renameProviderInChannels(draft, oldId, newId) {
  const renameCands = (cands) => (cands || []).map((c) => (c && c.provider === oldId) ? { ...c, provider: newId } : c)
  return (draft || []).map((g) => {
    const next = { ...g, candidates: renameCands(g.candidates) }
    if (Array.isArray(g.presets)) {
      next.presets = g.presets.map((p) => (p && Array.isArray(p.candidates))
        ? { ...p, candidates: renameCands(p.candidates) }
        : p)
    }
    return next
  })
}

test('F17 行为级：改名同步主 candidates 与全部 presets', () => {
  const draft = [{
    id: 'g1',
    candidates: [{ provider: 'old', model: 'm' }],
    presets: [
      { id: 'p1', candidates: [{ provider: 'old', model: 'm' }, { provider: 'x', model: 'm' }] },
      { id: 'p2', candidates: [{ provider: 'old', model: 'm2' }] },
    ],
    activePreset: 'p1',
  }]
  const next = renameProviderInChannels(draft, 'old', 'new')
  assert.equal(next[0].candidates[0].provider, 'new', '主 candidates 改名')
  assert.equal(next[0].presets[0].candidates[0].provider, 'new', 'preset p1 改名')
  assert.equal(next[0].presets[0].candidates[1].provider, 'x', '其他 provider 不动')
  assert.equal(next[0].presets[1].candidates[0].provider, 'new', 'preset p2 改名')
  // 原 draft 不被原地修改（setChannelsDraft 的不可变更新语义）
  assert.equal(draft[0].candidates[0].provider, 'old')
  assert.equal(draft[0].presets[0].candidates[0].provider, 'old')
});

test('F17 源级：renameCands 覆盖 presets', () => {
  const m = client.match(/const renameProviderInChannels[\s\S]{0,800}?\n      \}/);
  assert.ok(m, '函数应存在');
  assert.ok(/presets\.map/.test(m[0]), '应遍历 presets');
  assert.ok(/renameCands\(p\.candidates\)/.test(m[0]), 'preset 候选应走同一改名函数');
});

// ---- F16：保存预检（复刻修复后逻辑） ----
function validateGroups(groupsToSave) {
  const problems = []
  const seenIds = new Set()
  for (const g of groupsToSave) {
    const gid = (g && g.id) || ''
    if (!/^[a-z0-9][a-z0-9-]*$/.test(gid)) {
      problems.push('id-invalid:' + (gid || '(未命名)'))
    } else if (seenIds.has(gid)) {
      problems.push('id-dup:' + gid)
    } else {
      seenIds.add(gid)
    }
    const candCount = (g && Array.isArray(g.candidates)) ? g.candidates.filter((c) => c && c.provider && c.model).length : 0
    if (candCount === 0 && gid) problems.push('no-cand:' + gid)
  }
  return problems
}

test('F16 行为级：H08 场景被预检拒绝', () => {
  // H08 原场景：1 个非法 ID + 2 个重复 ID
  const groups = [
    { id: 'BAD_ID!', candidates: [{ provider: 'a', model: 'm' }] },
    { id: 'dup', candidates: [{ provider: 'a', model: 'm' }] },
    { id: 'dup', candidates: [{ provider: 'a', model: 'm' }] },
  ]
  const problems = validateGroups(groups)
  assert.ok(problems.some((p) => p.startsWith('id-invalid')), '非法 ID 被抓')
  assert.ok(problems.some((p) => p.startsWith('id-dup')), '重复 ID 被抓')
  assert.equal(problems.length, 2, '恰好两个问题（非法 + 重复）')
});

test('F16 行为级：合法配置零问题；空候选被抓', () => {
  assert.equal(validateGroups([{ id: 'good-group', candidates: [{ provider: 'a', model: 'm' }] }]).length, 0, '合法零问题')
  assert.ok(validateGroups([{ id: 'g', candidates: [] }]).some((p) => p.startsWith('no-cand')), '空候选被抓')
  assert.ok(validateGroups([{ id: 'g', candidates: [{ provider: '', model: 'm' }] }]).some((p) => p.startsWith('no-cand')), '缺 provider 的候选不算数')
  assert.equal(validateGroups([]).length, 0, '空组列表合法（允许清空全部组）')
});

test('F16 源级：client 预检 + host 告警', () => {
  // client：保存前 problems 拦截
  assert.ok(/F16 预检/.test(client), 'save 应有 F16 预检块');
  assert.ok(/保存被拒绝/.test(client), '拒绝提示文案');
  // host：rewireRoutes 丢弃组时 console.warn（含「未通过校验」文案；marker 到
  // warn 调用约 635 字符，到文案结束还需更长，窗口从 warn 处再放宽）
  const m = host.match(/F16（审计 H08）[\s\S]{0,900}?console\.warn/);
  assert.ok(m, 'rewireRoutes 应有丢弃告警');
  assert.ok(/keptIds/.test(m[0]), '应按 keptIds 对比找被丢组');
  const warnIdx = host.indexOf('console.warn', host.indexOf('F16（审计 H08）'));
  assert.ok(warnIdx > 0, 'warn 调用应存在');
  assert.ok(host.slice(warnIdx, warnIdx + 300).includes('未通过校验'), '告警文案应说明未通过校验');
});
