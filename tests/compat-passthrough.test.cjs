// Compat 净化策略回归测试：全量透传（对齐安装运行时 rc.2 PiAiCompatProfile 20 字段）
// 根因：旧 cleanCompat 白名单（仅 thinkingFormat/supportsReasoningEffort）在每次保存时
// 剥掉其余真实生效字段——rc.2 的 20 个字段（supportsDeveloperRole /
// requiresThinkingAsText / chatTemplateKwargs / thinkingFormat:chat-template 等）
// 全部被 harness 消费；用户配置的角色模板类字段被删后上游报
// 400 角色信息不正确（Ark code 1214）。
const fs = require('fs')
let passed = 0, failed = 0
const t = (name, cond) => { cond ? passed++ : (failed++, console.log('  FAIL:', name)) }

// 静态断言：净化逻辑不再有白名单
{
  const src = fs.readFileSync(__dirname + '/../src/client.js', 'utf8')
  t('S1 不再存在 COMPAT_ALIVE 白名单', !src.includes('COMPAT_ALIVE'))
  t('S2 cleanCompat 为全量透传', src.includes('out[k] = v') && src.includes("k === 'chatTemplateKwargs'"))
}

// 复刻 cleanCompat（与 save() 内实现逐行一致）
const TF = ['openai', 'deepseek', 'openrouter', 'together', 'zai', 'qwen', 'chat-template', 'qwen-chat-template', 'string-thinking', 'ant-ling']
const MAX_TOKENS_FIELDS = ['max_completion_tokens', 'max_tokens']
const CACHE_CONTROL_FORMATS = ['anthropic']
const TF_SET = new Set(TF)
const MAXTOK_SET = new Set(MAX_TOKENS_FIELDS)
const CCF_SET = new Set(CACHE_CONTROL_FORMATS)
const cleanCompat = (raw) => {
  if (!raw || typeof raw !== 'object') return undefined
  const out = {}
  for (const [k, v] of Object.entries(raw)) {
    if (v === '' || v == null) continue
    if (k === 'thinkingFormat' && !TF_SET.has(v)) continue
    if (k === 'maxTokensField' && !MAXTOK_SET.has(v)) continue
    if (k === 'cacheControlFormat' && !CCF_SET.has(v)) continue
    if (k === 'chatTemplateKwargs') {
      if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0) out[k] = v
      continue
    }
    out[k] = v
  }
  return Object.keys(out).length > 0 ? out : undefined
}

// C1: 旧白名单会删的字段现在全保留（含 rc.2 才有的角色/模板类）
{
  const raw = {
    thinkingFormat: 'chat-template',
    supportsDeveloperRole: false,
    requiresThinkingAsText: true,
    requiresReasoningContentOnAssistantMessages: true,
    maxTokensField: 'max_completion_tokens',
    supportsStrictMode: true,
  }
  const out = cleanCompat(raw)
  t('C1 六个白名单外字段全部保留', out && out.thinkingFormat === 'chat-template' && out.supportsDeveloperRole === false && out.requiresThinkingAsText === true && out.maxTokensField === 'max_completion_tokens')
}
// C2: false 是有效值必须保留（旧实现 checkbox 语义会丢）
t('C2 显式 false 保留', cleanCompat({ supportsReasoningEffort: false }).supportsReasoningEffort === false)
// C3: chatTemplateKwargs 对象保留、空对象剔除
{
  const kw = { thinking_enabled: 'true' }
  t('C3a kwargs 对象保留', cleanCompat({ chatTemplateKwargs: kw }).chatTemplateKwargs === kw)
  t('C3b 空 kwargs 剔除', cleanCompat({ chatTemplateKwargs: {} }) === undefined)
}
// C4: 空串/null（「— 默认 —」）剔除
t('C4 空串剔除', cleanCompat({ thinkingFormat: '', supportsStore: null, supportsStore2: undefined, supportsStrictMode: true }).thinkingFormat === undefined)
// C5: 枚举非法值剔除
{
  const out = cleanCompat({ thinkingFormat: 'bogus', maxTokensField: 'bogus', cacheControlFormat: 'bogus' }) || {}
  t('C5 非法枚举剔除', out.thinkingFormat === undefined && out.maxTokensField === undefined && out.cacheControlFormat === undefined)
}
// C6: 全空 → undefined；非对象 → undefined
t('C6a 空结果 undefined', cleanCompat({ thinkingFormat: '' }) === undefined)
t('C6b 非对象 undefined', cleanCompat('x') === undefined && cleanCompat(null) === undefined)

console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed > 0 ? 1 : 0)
