// ModelConfigPanel 搜索过滤纯逻辑回归测试（复刻组件内的过滤逻辑）
let passed = 0, failed = 0
const t = (name, cond) => { cond ? passed++ : (failed++, console.log('  FAIL:', name)) }

// 复刻组件逻辑：visibleEntries 过滤（provider id/显示名/模型 id/模型名，不区分大小写）
const makeFilter = () => (entries, q) => {
  const pqLower = q.trim().toLowerCase()
  return entries
    .map(([name, p], realIdx) => ({ name, p, realIdx }))
    .filter(({ name, p }) => {
      if (!pqLower) return true
      if (name.toLowerCase().includes(pqLower)) return true
      if (p.displayName && String(p.displayName).toLowerCase().includes(pqLower)) return true
      return (p.models || []).some((m) => m && ((m.id || '').toLowerCase().includes(pqLower) || (m.name || '').toLowerCase().includes(pqLower)))
    })
}

const entries = [
  ['shangtang', { displayName: '商汤', models: [{ id: 'gpt-4', name: 'GPT-4' }] }],
  ['carolineai', { displayName: 'Caroline', models: [{ id: 'glm-5.2', name: 'GLM 5.2 旗舰' }] }],
  ['myapi', { displayName: undefined, models: [{ id: 'deepseek-v4', name: 'V4' }] }],
]

// T1: 空搜索 = 全量 + realIdx 与全量下标一致（拖拽映射正确的前提）
{
  const out = makeFilter()(entries, '')
  t('T1 空搜索全量保留', out.length === 3)
  t('T1 realIdx 连续映射', out[0].realIdx === 0 && out[1].realIdx === 1 && out[2].realIdx === 2)
}

// T2: provider id 命中
{
  const out = makeFilter()(entries, 'caroline')
  t('T2 id 命中', out.length === 1 && out[0].name === 'carolineai')
}

// T3: displayName 命中（中文）
{
  const out = makeFilter()(entries, '商汤')
  t('T3 显示名命中', out.length === 1 && out[0].name === 'shangtang')
}

// T4: 模型 id / 模型名命中
{
  t('T4a 模型 id 命中', makeFilter()(entries, 'glm-5.2').length === 1 && makeFilter()(entries, 'v4').length === 1)
  t('T4b 模型名命中（唯一词）', makeFilter()(entries, '旗舰').length === 1 && makeFilter()(entries, '旗舰')[0].name === 'carolineai')
}

// T5: 大小写不敏感
{
  t('T5 大小写不敏感', makeFilter()(entries, 'GLM').length === 1 && makeFilter()(entries, 'DEEPSEEK').length === 1)
}

// T6: 无命中 = 空列表（面板渲染空态文案）
{
  const out = makeFilter()(entries, '不存在的关键词')
  t('T6 无命中为空', out.length === 0)
}

// T7: 过滤后 realIdx 保留全量下标（过滤视图内拖拽映射到全量列表正确位置）
{
  const full = [['a', { models: [] }], ['b', { models: [] }], ['c', { models: [] }], ['dhit', { models: [] }], ['ehit', { models: [] }]]
  const out = makeFilter()(full, 'hit')
  t('T7 realIdx 保留原下标', out.length === 2 && out[0].realIdx === 3 && out[1].realIdx === 4)
}

console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed > 0 ? 1 : 0)
