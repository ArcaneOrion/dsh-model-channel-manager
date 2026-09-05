// slot 座位替换回归测试（白屏根因防护）
// 根因：single slot 的 cell = slot 本身，同 priority 撞格直接抛错 →
//       apply 失败 → 整个插件（含 ModelConfigView 页签）加载失败 →「看不到模型配置视图」
// 修复：显式传 priority: -1（负值 < 原生 0，lowest renders 语义下插件遮蔽原生）
// 复刻 ui-slots/src/index.ts:796-830 的 occupancy + 选举语义
let passed = 0, failed = 0
const t = (name, cond) => { cond ? passed++ : (failed++, console.log('  FAIL:', name)) }

function makeCore() {
  const records = new Map()
  return {
    declare(name, spec) { records.set(name, { spec, entries: [] }) },
    register(options, component) {
      const rec = records.get(options.name)
      if (!rec) throw new Error(`slot "${options.name}" is not declared`)
      if (rec.spec.kind === 'single') {
        const priority = options.priority ?? 0
        const occupant = rec.entries.find(e => (e.options.priority ?? 0) === priority)
        if (occupant) throw new Error(`single slot "${options.name}" already has a registration at priority ${priority}`)
      }
      rec.entries.push({ options, component })
    },
    winner(name) {
      const rec = records.get(name)
      if (!rec) return null
      return rec.entries.slice().sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0))[0] || null
    },
  }
}

// T1: 复现白屏根因——同 priority 0 撞格抛错
{
  const core = makeCore()
  core.declare('conversation.input.model', { kind: 'single', scope: 'session' })
  core.register({ name: 'conversation.input.model' }, () => 'native')
  let threw = false
  try { core.register({ name: 'conversation.input.model', id: 'plugin' }, () => 'plugin') }
  catch (e) { threw = e.message.includes('already has a registration at priority 0') }
  t('T1 同 priority 撞格抛错（根因复现）', threw)
}

// T2: 负 priority 遮蔽成功（当前 client.js 的注册方式）
{
  const core = makeCore()
  core.declare('conversation.input.model', { kind: 'single', scope: 'session' })
  core.register({ name: 'conversation.input.model' }, () => 'native')
  let ok = true
  try { core.register({ name: 'conversation.input.model', id: 'mcm-search-select', priority: -1 }, () => 'plugin') }
  catch (e) { ok = false }
  t('T2 负 priority 注册不抛错', ok)
  t('T3 选举赢家是插件（-1 < 0，lowest renders）', core.winner('conversation.input.model').options.priority === -1)
}

// T4: 源码静态检查——注册必须带 priority: -1
{
  const fs = require('fs')
  const src = fs.readFileSync(__dirname + '/../src/client.js', 'utf8')
  const i = src.indexOf("slots.inject('conversation.input.model'")
  const seg = i >= 0 ? src.slice(i, i + 400) : ''
  t('T4 源码注册带 priority: -1', seg.includes('priority: -1'))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
