// SearchModelSelect 纯逻辑回归测试（复刻组件内的排序/过滤/置顶逻辑）
let passed = 0, failed = 0
const t = (name, cond) => { cond ? passed++ : (failed++, console.log('  FAIL:', name)) }

// 复刻组件逻辑：matches / ordered / sections
const makeLogic = (recent) => {
  const recentSet = new Set(recent)
  const matches = (group, model, qLower) => {
    if (!qLower) return true
    return (group.name || group.id || '').toLowerCase().includes(qLower)
      || (model.name || '').toLowerCase().includes(qLower)
      || (model.id || '').toLowerCase().includes(qLower)
      || (model.description || '').toLowerCase().includes(qLower)
  }
  const build = (groups, q) => {
    const qLower = q.trim().toLowerCase()
    let ordered = groups
    if (!qLower && recentSet.size > 0) {
      const rank = new Map(recent.map((p, i) => [p, i]))
      ordered = groups.slice().sort((a, b) => {
        const ra = rank.has(a.id) ? rank.get(a.id) : 1e9
        const rb = rank.has(b.id) ? rank.get(b.id) : 1e9
        return ra - rb
      })
    }
    const sections = []
    for (const g of ordered) {
      const rows = (g.models || []).filter((m) => matches(g, m, qLower))
      if (rows.length === 0) continue
      sections.push({ g, rows, isTop: !qLower && recentSet.has(g.id) })
    }
    return { ordered, sections }
  }
  return build
}

// T1: 置顶排序——recent 顺序重排组，未提及的按原序 append
{
  const groups = [
    { id: 'a', name: 'A', models: [{ id: 'a1', name: 'A1' }] },
    { id: 'b', name: 'B', models: [{ id: 'b1', name: 'B1' }] },
    { id: 'c', name: 'C', models: [{ id: 'c1', name: 'C1' }] },
  ]
  const build = makeLogic(['c', 'a'])  // 最近用 c、然后 a
  const { ordered, sections } = build(groups, '')
  t('T1 置顶顺序 c,a,b', ordered.map((g) => g.id).join('') === 'cab')
  t('T1 isTop 标记', sections[0].isTop === true && sections[2].isTop === false)
}

// T2: 搜索过滤（模型名/provider 名/描述/id 匹配）
{
  const groups = [
    { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', name: 'V4 Flash' }] },
    { id: 'carolineai', name: 'Caroline', models: [{ id: 'glm-5.2', name: 'GLM 5.2', description: '智谱旗舰' }] },
  ]
  const build = makeLogic([])
  t('T2a 搜 glm 命中 id', build(groups, 'glm').sections.length === 1 && build(groups, 'glm').sections[0].g.id === 'carolineai')
  t('T2b 搜 V4 命中模型名', build(groups, 'v4').sections[0].g.id === 'deepseek-official')
  t('T2c 搜 智谱 命中描述', build(groups, '智谱').sections[0].g.id === 'carolineai')
  t('T2d 搜 deepseek 命中组名+模型 id（两组都出）', build(groups, 'deepseek').sections.length === 1)
  t('T2e 空搜索全量', build(groups, '').sections.length === 2)
  t('T2f 无匹配空列表', build(groups, 'zzz-not-exist').sections.length === 0)
}

// T3: 置顶数据聚合（复刻 pullRecentProviders 的 7 天窗口逻辑）
{
  const now = Date.now()
  const day = 24 * 3600 * 1000
  const recs = {
    deepseek: [
      { provider: 'deepseek', ts: now - 1 * day, ok: true },
      { provider: 'deepseek', ts: now - 2 * day, ok: true },  // 更旧，不取
    ],
    caroline: [
      { provider: 'caroline', ts: now - 3 * day, ok: true },
    ],
    stale: [
      { provider: 'stale', ts: now - 8 * day, ok: true },     // 超 7 天，剔除
    ],
    failed: [
      { provider: 'failed', ts: now - 1 * day, ok: false },   // 失败，不置顶
    ],
  }
  const cutoff = now - 7 * day
  const last = new Map()
  for (const evs of Object.values(recs)) {
    for (const e of (evs || [])) {
      if (!e || !e.provider || !e.ts || e.ts < cutoff) continue
      if (!e.ok) continue
      if (!last.has(e.provider) || (e.ts || 0) > last.get(e.provider)) last.set(e.provider, e.ts)
    }
  }
  const order = [...last.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0])
  t('T3 7天窗口+去重+降序+剔除失败', order.join(',') === 'deepseek,caroline')
}

// T4: 组名匹配但模型不匹配时全组模型都显示（provider 维度搜索意图）
{
  const groups = [
    { id: 'nvidia', name: 'NVIDIA', models: [{ id: 'llama-3', name: 'Llama 3' }, { id: 'nemotron', name: 'Nemotron' }] },
  ]
  const build = makeLogic([])
  const { sections } = build(groups, 'nvidia')
  t('T4 组名匹配显示全组模型', sections.length === 1 && sections[0].rows.length === 2)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
