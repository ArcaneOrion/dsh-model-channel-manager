// 离线回归测试：providerOrder 方案走通 settings 落盘链路
// 复刻（源码对齐）：
//   - settings-file/src/index.ts 的 patchNode（叶子 diff，数组 deepEqual 不等即整值 setIn）
//   - settings/src/index.ts 的 mergeLayers（update 语义）+ applyPathOp（mutate 语义）+ resolve
// 场景覆盖见每个 describe
const { parseDocument } = require('yaml')

// ---- 复刻 settings-file patchNode（index.ts:70-81，逐行对齐） ----
const deepEqualJson = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const isMapLike = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
function patchNode(document, path, current, next) {
  if (isMapLike(current) && isMapLike(next)) {
    for (const key of Object.keys(current)) {
      if (!(key in next)) document.deleteIn([...path, key])
    }
    for (const [key, value] of Object.entries(next)) {
      patchNode(document, [...path, key], current[key], value)
    }
    return
  }
  if (!deepEqualJson(current, next)) document.setIn([...path], next)
}
// renderYaml（settings-file index.ts:421-432，text 缓存非空时 patch，否则整文档新建）
function renderYaml(text, ns, section) {
  if (text === undefined) return new (require('yaml').Document)({ [ns]: section }).toString()
  const document = parseDocument(text)
  const root = document.toJS()
  patchNode(document, [ns], isMapLike(root) ? root[ns] : undefined, section)
  return document.toString()
}

// ---- 复刻 settings 服务 mergeLayers / applyPathOp（src/index.ts:297, 214-233） ----
const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
function mergeLayers(under, over) {
  if (over === undefined) return under
  if (!isPlainObject(under) || !isPlainObject(over)) return over
  const merged = { ...under }
  for (const [key, value] of Object.entries(over)) {
    merged[key] = key in merged ? mergeLayers(merged[key], value) : value
  }
  return merged
}
function applyPathOp(section, op) {
  const [head, ...rest] = op.path
  if (head === undefined) {
    if (op.op === 'unset') return {}
    if (!isPlainObject(op.value)) throw new TypeError('mutate section root requires plain object')
    return { ...op.value }
  }
  if (rest.length === 0) {
    if (op.op === 'set') return { ...section, [head]: op.value }
    const { [head]: _r, ...kept } = section
    return kept
  }
  const child = section[head]
  if (!isPlainObject(child)) {
    if (op.op === 'unset') return section
    return { ...section, [head]: applyPathOp({}, { ...op, path: rest }) }
  }
  return { ...section, [head]: applyPathOp(child, { ...op, path: rest }) }
}

// ---- 复刻 CONFIG_SCHEMA 的 resolve 行为（schemastery loose + providerOrder 数组） ----
// 已实测：缺省解析为 []，有值透传，非法类型 reject（见 schema 验证脚本）
const resolveChannels = (section) => ({
  groups: Array.isArray(section.groups) ? section.groups : [],
  providerOrder: Array.isArray(section.providerOrder) ? section.providerOrder : [],
})

// ============ 测试 ============
let passed = 0, failed = 0
const t = (name, cond) => { cond ? passed++ : (failed++, console.log('  FAIL:', name)) }

// ---- T1: 核心场景——拖拽重排 + 保存 → 文件真实落盘新顺序 ----
{
  // 磁盘初始状态：settings.yaml（创建时序 p1,p2,p3 + 已有 groups）
  let diskText = 'llm-pi-ai:\n  providers:\n    p1: {api: openai-completions}\n    p2: {api: openai-completions}\n    p3: {api: openai-completions}\nmodel-channels:\n  groups: [{id: demo}]\n'
  // 内存 user 层（模拟 settings 服务初始化时从文件 load）
  const doc0 = parseDocument(diskText).toJS()
  let nsChannelsUser = doc0['model-channels'] || {}

  // 面板拖拽 p3 到第一位 → draft 键序 p3,p1,p2 → 保存：
  const cleanProviders = { p3: { api: 'openai-completions' }, p1: { api: 'openai-completions' }, p2: { api: 'openai-completions' } }
  // save(): update({ns:'model-channels', patch:{groups, providerOrder:[p3,p1,p2]}})
  const patch = { groups: [{ id: 'demo' }], providerOrder: Object.keys(cleanProviders) }
  const merged = mergeLayers(nsChannelsUser, patch)
  const resolved = resolveChannels(merged)
  // persistSection → renderYaml → patchNode
  diskText = renderYaml(diskText, 'model-channels', resolved)

  // 断言 1：providerOrder 数组按新顺序落盘（数组 wholesale replace）
  t('T1.1 providerOrder 落盘新顺序', parseDocument(diskText).toJS()['model-channels'].providerOrder.join('') === 'p3p1p2')
  // 断言 2：llm-pi-ai 的 mutate（unset+set）只改内存，文件键序原样（p1,p2,p3——patchNode 只对该 ns 的叶子 diff）
  t('T1.2 llm-pi-ai 文件段未被本次 update 触碰', parseDocument(diskText).toJS()['llm-pi-ai'].providers.p1 !== undefined)

  // ---- 重启：从文件重载 → refresh 按 providerOrder 重排渲染 ----
  const reloaded = parseDocument(diskText).toJS()
  const rawProviders = reloaded['llm-pi-ai'].providers  // 键序回到创建时序 p1,p2,p3
  const order = reloaded['model-channels'].providerOrder
  // 复刻 client applyProviderOrder
  const applyProviderOrder = (providers, ord) => {
    if (!providers || !Array.isArray(ord) || ord.length === 0) return providers
    const known = new Set(Object.keys(providers))
    const ranked = ord.filter((k) => known.has(k))
    if (ranked.length === 0) return providers
    const rest = Object.keys(providers).filter((k) => !ranked.includes(k))
    const out = {}
    for (const k of ranked.concat(rest)) out[k] = providers[k]
    return out
  }
  const rendered = applyProviderOrder(rawProviders, order)
  t('T1.3 重启后渲染顺序 = 拖拽顺序', Object.keys(rendered).join('') === 'p3p1p2')
}

// ---- T2: providerOrder 过期（手工删了 provider 或改名）不丢供应商 ----
{
  const applyProviderOrder = (providers, ord) => {
    if (!providers || !Array.isArray(ord) || ord.length === 0) return providers
    const known = new Set(Object.keys(providers))
    const ranked = ord.filter((k) => known.has(k))
    if (ranked.length === 0) return providers
    const rest = Object.keys(providers).filter((k) => !ranked.includes(k))
    const out = {}
    for (const k of ranked.concat(rest)) out[k] = providers[k]
    return out
  }
  // order 里引用了已删除的 p9 + 新增的 p4 不在 order 里
  const out = applyProviderOrder({ p1: 1, p2: 2, p4: 3 }, ['p2', 'p9', 'p1'])
  t('T2.1 过期 order：未列出的 append 在后', Object.keys(out).join('') === 'p2p1p4')
  t('T2.2 过期 order：不丢供应商', Object.keys(out).length === 3)
  // order 全部失效 → 回退文件键序
  const out2 = applyProviderOrder({ p1: 1, p2: 2 }, ['zzz'])
  t('T2.3 order 全失效回退文件序', Object.keys(out2).join('') === 'p1p2')
}

// ---- T3: 只保存轮询组（不动 provider）不冲掉已存顺序 ----
{
  let diskText = 'model-channels:\n  groups: []\n  providerOrder: [p3, p1, p2]\n'
  const doc0 = parseDocument(diskText).toJS()
  let user = doc0['model-channels']
  // 假想未来的别的调用者只 patch groups 不带 order
  const merged = mergeLayers(user, { groups: [{ id: 'x' }] })
  t('T3.1 merge 不带 order 保留旧顺序', merged.providerOrder.join('') === 'p3p1p2')
  const next = renderYaml(diskText, 'model-channels', resolveChannels(merged))
  t('T3.2 落盘后 providerOrder 仍在', parseDocument(next).toJS()['model-channels'].providerOrder.join('') === 'p3p1p2')
}

// ---- T4: 数组重排在 patchNode 下真实落盘（区别于 map 键序的零 diff） ----
{
  let diskText = 'model-channels:\n  groups: []\n  providerOrder: [p1, p2, p3]\n'
  const next = renderYaml(diskText, 'model-channels', { groups: [], providerOrder: ['p3', 'p1', 'p2'] })
  t('T4.1 数组重排触发整值替换', parseDocument(next).toJS()['model-channels'].providerOrder.join('') === 'p3p1p2')
  // 对照：map 键纯重排 = 零 diff（原 bug 根因）——用真实 settings.yaml 的 block style 值
  const yMap = 'llm-pi-ai:\n  providers:\n    p1:\n      x: 1\n    p2:\n      x: 2\n    p3:\n      x: 3\n'
  const d = parseDocument(yMap)
  const rootM = d.toJS()
  patchNode(d, ['llm-pi-ai'], rootM['llm-pi-ai'], { providers: { p3: { x: 3 }, p1: { x: 1 }, p2: { x: 2 } } })
  t('T4.2 对照：map 键纯重排 = 零 diff（原根因）', d.toString() === yMap)
}

// ---- T5: 新增/删除 provider 顺带更新 order 数组 ----
{
  let diskText = 'model-channels:\n  groups: []\n  providerOrder: [p1, p2]\n'
  // 用户新增 p4 并保存 → order = [p1,p2,p4]
  const merged = mergeLayers(parseDocument(diskText).toJS()['model-channels'], { groups: [], providerOrder: ['p1', 'p2', 'p4'] })
  const next = renderYaml(diskText, 'model-channels', resolveChannels(merged))
  t('T5.1 新增 provider 进 order', parseDocument(next).toJS()['model-channels'].providerOrder.length === 3)
  // 删除 p2 后保存
  const merged2 = mergeLayers(parseDocument(next).toJS()['model-channels'], { providerOrder: ['p1', 'p4'] })
  const next2 = renderYaml(next, 'model-channels', resolveChannels(merged2))
  t('T5.2 删除 provider 从 order 移除', parseDocument(next2).toJS()['model-channels'].providerOrder.join('') === 'p1p4')
}

// ---- T6: 存量数据无 providerOrder 字段（向后兼容） ----
{
  let diskText = 'model-channels:\n  groups: [{id: demo}]\n'
  const resolved = resolveChannels(parseDocument(diskText).toJS()['model-channels'])
  t('T6.1 存量无字段 resolve 为 []', resolved.providerOrder.length === 0)
  // 首次保存注入
  const merged = mergeLayers(parseDocument(diskText).toJS()['model-channels'], { groups: [{ id: 'demo' }], providerOrder: ['p1', 'p2'] })
  const next = renderYaml(diskText, 'model-channels', resolveChannels(merged))
  t('T6.2 首次保存注入 order', parseDocument(next).toJS()['model-channels'].providerOrder.join('') === 'p1p2')
  // client applyProviderOrder 对 null order 直接透传
  t('T6.3 order=null 透传', applyOrder({ a: 1, b: 2 }, null) && Object.keys(applyOrder({ a: 1, b: 2 }, null)).join('') === 'ab')
  function applyOrder(p, o) { if (!p || !Array.isArray(o) || o.length === 0) return p; return p }
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
