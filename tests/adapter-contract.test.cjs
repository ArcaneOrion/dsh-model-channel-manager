// 适配器契约回归测试（对齐运行时 rc.2 的 LlmAdapter 接口）
// 根因：源码仓的 LlmAdapter 已把 prepareCall 重构进服务层，而运行时（0.1.1-rc.2）
// 的主分发路径 llm.stream/llm.prepareCall 都先调 adapter.prepareCall(provider, model, signal)
// 拿 {model, stream}——适配器缺它时注册/目录/菜单全部正常，真实发对话才报
// `registration.adapter.prepareCall is not a function`。
const fs = require('fs')
let passed = 0, failed = 0
const t = (name, cond) => { cond ? passed++ : (failed++, console.log('  FAIL:', name)) }

const src = fs.readFileSync(__dirname + '/../src/index.js', 'utf8')

// T1: 适配器必须实现 rc.2 LlmAdapter 全部方法（含 prepareCall）
{
  const methods = ['providerInfo', 'providerRetryPolicy', 'listModels', 'resolveModel', 'prepareCall', 'stream']
  for (const m of methods) t('T1 适配器实现 ' + m, new RegExp('\\b' + m + '\\s*\\(').test(src))
}

// T2: prepareCall 绑定快照（准备时刻的 pullConfig() 一份），dispatch 走同一代配置
{
  const seg = src.slice(src.indexOf('prepareCall(provider'), src.indexOf('stream(options) {'))
  t('T2a prepareCall 捕获快照', seg.includes('const snapshot = pullConfig()'))
  t('T2b 元数据出自同一快照', seg.includes('resolveModelWith(snapshot'))
  t('T2c stream 绑定快照组配置', seg.includes('streamGroup(cfg, options)'))
}

// T3: 与实际运行时 d.ts 的契约同步（找到安装的 dsh-llm 才检查，找不到则跳过）
{
  let dts = null
  const candidates = [
    '/home/arcaneorion/AI/Agent-workerspace/pnpm-packages/node_modules/.pnpm',
  ]
  for (const base of candidates) {
    if (!fs.existsSync(base)) continue
    const hit = fs.readdirSync(base).find((d) => d.startsWith('@deepseek-ai+dsh-llm@'))
    if (hit) { dts = fs.readFileSync(base + '/' + hit + '/node_modules/@deepseek-ai/dsh-llm/lib/types/index.d.ts', 'utf8'); break }
  }
  if (dts === null) {
    console.log('  SKIP: T3 未找到安装的 dsh-llm 类型定义')
  } else {
    const iface = dts.slice(dts.indexOf('interface LlmAdapter'), dts.indexOf('abstract class LlmAdapter'))
    const required = [...iface.matchAll(/^\s{4}(?:async )?(\w+)\(/gm)].map((m) => m[1])
    const abstractOnly = new Set(['stream'])
    for (const m of required) {
      if (m === 'constructor') continue
      t('T3 运行时契约方法 ' + m + ' 已实现', abstractOnly.has(m) || new RegExp('\\b' + m + '\\s*\\(').test(src))
    }
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed > 0 ? 1 : 0)
