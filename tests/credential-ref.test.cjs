// 供应商密钥 UX 虚拟化回归测试（静态断言，同仓测试风格）
// 背景：apiKeyEnv 是上游 llm-pi-ai 的唯一密钥字段——凭据引用名，key 实际存
// ~/.dsh/.credentials.yaml（0600，write-only 读不回；启动环境同名变量只读优先）。
// 面板将其藏进高级选项，主视图「API Key」改即输即存；新增供应商对 ID + 引用双重
// 去重——改名供应商会保留旧引用（write-only 无法搬移），只按 ID 去重会复活
// provider-1 并继承已被占用的 PROVIDER_1_API_KEY（两个供应商同引用 = 共用同一把 key）。
const fs = require('fs')
let passed = 0, failed = 0
const t = (name, cond) => { cond ? passed++ : (failed++, console.log('  FAIL:', name)) }

const src = fs.readFileSync(__dirname + '/../src/client.js', 'utf8')

// T1: 主视图不再暴露 apiKeyEnv 字段（旧 label 全源码移除，字段迁入高级选项）
t('T1 旧 label「API Key 环境变量名」已移除', !src.includes("'API Key 环境变量名'"))
t('T2 高级选项含「凭据引用名 (apiKeyEnv)」字段', src.includes('凭据引用名 (apiKeyEnv)'))
// T3: 即输即存——失焦且值有变化时自动 saveKey，不再有手动「写入存储」按钮
t('T3a API Key 失焦自动写入', /onBlur: \(\) => \{ const v = \(keyInput\[name\] \|\| ''\)\.trim\(\); if \(v && v !== savedKeys\[name\]\) saveKey\(name\)/.test(src))
t('T3b 手动「写入存储」按钮已移除', !src.includes("btn('写入存储'"))
// T4: 新增供应商双重去重（ID + 凭据引用）
t('T4a id 与 ref 占用集都有收集', src.includes('const idsTaken = new Set(Object.keys(providers || {}))') && src.includes('const refsTaken = new Set(Object.values(providers || {})'))
t('T4b 命名循环同时检查两者', /while \(idsTaken\.has\('provider-' \+ i\) \|\| refsTaken\.has\(normalizeCredentialRef\('provider-' \+ i \+ '_api_key'\)\)\) i\+\+/.test(src))
// T5: 共用引用警示（真撞才渲染，不阻断保存）
t('T5 共用引用 ⚠ 渲染存在', src.includes('共用同一把 Key'))
// T6: 缺引用时写入有可见反馈（不再静默丢弃）
t('T6 缺凭据引用名提示', src.includes('缺少凭据引用名'))
// T7: refUsage 计数器（警示数据源）
t('T7 refUsage 占用计数存在', src.includes('const refUsage = new Map()'))

console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed > 0 ? 1 : 0)
