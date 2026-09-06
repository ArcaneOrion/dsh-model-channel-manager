/** @arcaneorion/dsh-model-channel-manager — client 半（现代化设计版）。
 * 遵循 DSH 规范：inject ["slots","connection"]，
 * apply(ctx) 捕获 ctx.get("connection").api，组件经闭包使用。
 * 数据通道 = api.settings / api.llm / api.credentials（公共 seam，无私有 RPC）。
 * 会话模型选择器（座位遮蔽）已拆出为独立插件 @arcaneorion/dsh-model-selector-search，
 * 本包只保留 conversation.view 模型配置页签。
 */
window.__ModuleLoader__.load({
  id: '@arcaneorion/dsh-model-channel-manager',
  factory: (require) => {
    const { createElement: el, useState, useEffect, useRef, useSyncExternalStore } = require('react')
    let apiRef = null
    const savedKeys = {}

    const CSS = `
.mcm-root { display:flex; flex-direction:column; height:100%; overflow:hidden; font-size:13px; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-base); }
.mcm-header { display:flex; align-items:center; justify-content:space-between; padding:12px 24px; border-bottom:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); flex-shrink:0; }
.mcm-nav { display:flex; background:var(--dsw-alias-bg-layer-2); padding:3px; border-radius:10px; border:1px solid var(--dsw-alias-border-l2); gap:2px; }
.mcm-nav-item { padding:6px 16px; font-size:12px; font-weight:500; color:var(--dsw-alias-label-tertiary); cursor:pointer; border-radius:8px; transition:all 0.15s ease; user-select:none; }
.mcm-nav-item:hover { color:var(--dsw-alias-label-primary); }
.mcm-nav-item.active { color:var(--dsw-alias-brand-primary); background:var(--dsw-alias-bg-layer-1); box-shadow:0 1px 3px rgba(0,0,0,0.06); font-weight:600; }
.mcm-actions { display:flex; align-items:center; gap:8px; }
.mcm-btn { box-sizing:border-box; height:30px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); border-radius:8px; padding:0 14px; font-size:12px; font-weight:500; cursor:pointer; font:inherit; display:inline-flex; align-items:center; gap:6px; transition:all 0.15s ease; }
.mcm-btn:hover { background:var(--dsw-alias-interactive-bg-hover); border-color:var(--dsw-alias-border-l3); }
.mcm-btn.primary { background:var(--dsw-alias-button-primary-fill); color:var(--dsw-alias-label-primary-foreground); border:none; box-shadow:0 1px 2px rgba(0,0,0,0.1); }
.mcm-btn.primary:hover { background:var(--dsw-alias-button-primary-hover); }
.mcm-btn.danger { color:var(--dsw-alias-state-error-primary); border-color:transparent; background:transparent; }
.mcm-btn.danger:hover { background:var(--dsw-alias-interactive-bg-hover-danger); }
.mcm-body { flex:1; overflow-y:auto; padding:20px 24px 60px; }
.mcm-banner { display:flex; align-items:center; justify-content:space-between; padding:12px 16px; border-radius:10px; background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1); margin-bottom:16px; font-size:12px; }
.mcm-card { border:1px solid var(--dsw-alias-border-l1); border-radius:12px; margin-bottom:12px; background:var(--dsw-alias-bg-layer-1); box-shadow:0 1px 3px rgba(0,0,0,0.02); transition:border-color 0.15s ease; overflow:hidden; }
.mcm-card:hover { border-color:var(--dsw-alias-border-l2); }
.mcm-card-h { display:flex; align-items:center; gap:12px; padding:12px 16px; cursor:pointer; user-select:none; }
.mcm-card-h:hover { background:var(--dsw-alias-interactive-bg-hover); }
.mcm-card-title { font-size:14px; font-weight:600; display:flex; align-items:center; gap:8px; }
.mcm-badge { font-size:11px; font-weight:500; padding:2px 8px; border-radius:6px; border:1px solid var(--dsw-alias-border-l2); color:var(--dsw-alias-label-secondary); background:var(--dsw-alias-bg-layer-2); font-family:var(--ds-font-family-code); }
.mcm-badge.brand { color:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); background:rgba(var(--dsw-rgb-brand-primary, 59, 130, 246), 0.08); }
.mcm-badge.success { color:var(--dsw-alias-state-success-primary); border-color:var(--dsw-alias-state-success-primary); background:rgba(16, 185, 129, 0.08); }
.mcm-badge.error { color:var(--dsw-alias-state-error-primary); border-color:var(--dsw-alias-state-error-primary); background:rgba(239, 68, 68, 0.08); }
.mcm-editor { background:var(--dsw-alias-bg-layer-2); border-top:1px solid var(--dsw-alias-border-l1); padding:16px 20px; display:flex; flex-direction:column; gap:16px; }
.mcm-field { display:flex; flex-direction:column; gap:6px; }
.mcm-fl { display:flex; align-items:center; gap:6px; font-size:12px; font-weight:600; color:var(--dsw-alias-label-secondary); }
.mcm-hint { color:var(--dsw-alias-label-dimmed); cursor:help; font-size:11px; border:1px solid var(--dsw-alias-border-l2); border-radius:50%; width:15px; height:15px; display:inline-flex; align-items:center; justify-content:center; }
.mcm-in { box-sizing:border-box; width:100%; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); border-radius:8px; height:34px; padding:0 12px; font:inherit; font-size:13px; transition:border-color 0.15s ease; }
.mcm-in:focus { border-color:var(--dsw-alias-brand-primary); outline:none; }
.mcm-in.mono { font-family:var(--ds-font-family-code); font-size:12px; }
.mcm-row { display:flex; flex-wrap:wrap; gap:12px; }
.mcm-row > .mcm-field { flex:1; min-width:180px; }
.mcm-subcard { border:1px solid var(--dsw-alias-border-l2); border-radius:10px; margin-bottom:8px; background:var(--dsw-alias-bg-layer-1); overflow:hidden; }
.mcm-subcard-h { display:flex; align-items:center; gap:10px; padding:10px 14px; cursor:pointer; }
.mcm-subcard-h:hover { background:var(--dsw-alias-interactive-bg-hover); }
.mcm-subcard-b { padding:14px 16px; border-top:1px solid var(--dsw-alias-border-l1); display:flex; flex-direction:column; gap:12px; background:var(--dsw-alias-bg-layer-2); }
.mcm-metrics-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:12px; margin-bottom:20px; }
.mcm-metric-card { background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1); border-radius:12px; padding:14px 16px; display:flex; flex-direction:column; gap:4px; box-shadow:0 1px 3px rgba(0,0,0,0.02); }
.mcm-metric-label { font-size:12px; color:var(--dsw-alias-label-tertiary); font-weight:500; }
.mcm-metric-value { font-size:24px; font-weight:700; color:var(--dsw-alias-label-primary); font-family:var(--ds-font-family-code); }
.mcm-meter { height:6px; border-radius:3px; background:var(--dsw-alias-bg-layer-2); overflow:hidden; margin-top:6px; display:flex; }
.mcm-meter-fill { height:100%; border-radius:3px; background:var(--dsw-alias-state-success-primary); }
.mcm-meter-fill.warn { background:var(--dsw-alias-state-warn-primary); }
.mcm-meter-fill.danger { background:var(--dsw-alias-state-error-primary); }
.mcm-health-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(320px, 1fr)); gap:12px; }
.mcm-health-card { background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1); border-radius:12px; padding:14px 16px; display:flex; flex-direction:column; gap:10px; }
.mcm-health-card-h { display:flex; align-items:center; justify-content:space-between; }
.mcm-status-dot { width:8px; height:8px; border-radius:50%; display:inline-block; }
.mcm-status-dot.ok { background:var(--dsw-alias-state-success-primary); box-shadow:0 0 0 3px rgba(16, 185, 129, 0.15); }
.mcm-status-dot.err { background:var(--dsw-alias-state-error-primary); box-shadow:0 0 0 3px rgba(239, 68, 68, 0.15); }
.mcm-mask { position:fixed; inset:0; background:rgba(0,0,0,.4); backdrop-filter:blur(3px); display:flex; align-items:center; justify-content:center; z-index:999; }
.mcm-modal { background:var(--dsw-alias-bg-base); border-radius:14px; box-shadow:0 12px 40px rgba(0,0,0,.25); width:92%; max-width:540px; max-height:85vh; display:flex; flex-direction:column; border:1px solid var(--dsw-alias-border-l2); overflow:hidden; }
.mcm-modal-h { padding:14px 20px; border-bottom:1px solid var(--dsw-alias-border-l1); display:flex; align-items:center; justify-content:space-between; background:var(--dsw-alias-bg-layer-1); }
.mcm-modal-b { padding:18px 20px; overflow-y:auto; flex:1; display:flex; flex-direction:column; gap:12px; }
.mcm-modal-f { padding:12px 20px; border-top:1px solid var(--dsw-alias-border-l1); display:flex; justify-content:flex-end; gap:8px; background:var(--dsw-alias-bg-layer-1); }
.mcm-empty { color:var(--dsw-alias-label-tertiary); padding:32px 16px; text-align:center; font-size:13px; }
.mcm-spin { width:18px; height:18px; border:2px solid var(--dsw-alias-border-l2); border-top-color:var(--dsw-alias-brand-primary); border-radius:50%; animation:mcm-spin .8s linear infinite; display:inline-block; }
@keyframes mcm-spin { to { transform:rotate(360deg); } }
`

    const clone = (v) => JSON.parse(JSON.stringify(v))
    // 生成第一个未占用的 prefix-N 名字，避免「删除中间项后 length+1 撞已有键」导致覆盖/静默去重
    const uniqueSuffixName = (prefix, taken) => { let i = 1; while (taken(prefix + i)) i++; return prefix + i }
    const APIS = ['openai-completions', 'openai-responses', 'anthropic-messages']
    const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
    // thinkingFormat 合法集合 = harness THINKING_FORMAT_GATE（8 项）。
    // thinkingFormat 全集 = 安装运行时 rc.2 的 SUPPORTED_THINKING_FORMATS（10 项）。
    // 此前注解「chat-template/qwen-chat-template 被 harness withheld」是源码仓快照的
    // 认知——rc.2 实际 offer 这两项（实测 schema 接受）；适配器契约必须以安装运行时为准。
    const TF = ['openai', 'deepseek', 'openrouter', 'together', 'zai', 'qwen', 'chat-template', 'qwen-chat-template', 'string-thinking', 'ant-ling']
    const MAX_TOKENS_FIELDS = ['max_completion_tokens', 'max_tokens']
    const CACHE_CONTROL_FORMATS = ['anthropic']
    const TRANSPORTS = ['sse', 'websocket', 'websocket-cached', 'auto']
    const CACHE = ['none', 'short', 'long']
    // apiKeyEnv 凭据引用必须是 POSIX 环境变量名（DSH apiproxy zod: /^[A-Za-z_][A-Za-z0-9_]*$/）
    const isLegalCredentialRef = (v) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(v)
    const normalizeCredentialRef = (raw) => {
      const v = String(raw == null ? '' : raw).trim()
      if (!v) return ''
      if (isLegalCredentialRef(v)) return v
      // 非法的引用（如含连字符 '-22'）：大写化、非法字符转下划线、数字开头补下划线前缀
      let s = v.toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^[0-9]+/, (m) => '_' + m).replace(/^_+/, '')
      if (!s) s = 'API_KEY'
      if (!isLegalCredentialRef(s)) s = '_' + s
      return s
    }
    // 参考 pi-provider-manager 的默认请求头（浏览器伪装，降低被上游风控的概率）。
    // 只在「新增供应商」时注入一次；加载与保存不再强制合并——编辑器里删除即真实生效。
    // 不含 User-Agent：pi-ai 的 requestHeaders 会强制用 deepseek-harness 归属 UA 覆盖，自定义是死数据。
    const DEFAULT_HEADERS = {
      'Accept': 'text/event-stream, text/html, application/json, */*',
      'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Origin': 'https://chat.openai.com',
      'Referer': 'https://chat.openai.com/',
    }
    const btn = (label, onClick, kind) => el('button', { className: 'mcm-btn' + (kind ? ' ' + kind : ''), onClick }, label)
    const field = (label, tip, req, children) => el('div', { className: 'mcm-field' }, el('div', { className: 'mcm-fl' }, label, req ? el('span', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, '*') : null, tip ? el('span', { className: 'mcm-hint', title: tip }, '?') : null), children)
    const tf = (label, tip, value, onSet, mono) => field(label, tip, false, el('input', { className: 'mcm-in' + (mono ? ' mono' : ''), value: value == null ? '' : String(value), onChange: (e) => onSet(e.target.value) }))
    const nf = (label, tip, value, onSet) => tf(label, tip, value, (v) => onSet(Number(v) || 0))
    const sel = (label, tip, value, options, onSet) => field(label, tip, false, el('select', { className: 'mcm-in', value, onChange: (e) => onSet(e.target.value) }, ...options.map((o) => Array.isArray(o) ? el('option', { key: o[0], value: o[0] }, o[1]) : el('option', { key: o, value: o }, o))))

    function kvEditor(kvs, onSet) {
      const entries = Object.entries(kvs || {})
      return el('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        entries.length > 0 ? entries.map(([k, v], i) => el('div', { key: i, style: { display: 'flex', gap: 6, alignItems: 'center' } },
          el('input', { className: 'mcm-in mono', style: { width: '35%' }, placeholder: 'Header Key', value: k, onChange: (e) => { const n = Object.assign({}, kvs); delete n[k]; n[e.target.value] = v; onSet(n) } }),
          el('input', { className: 'mcm-in mono', style: { flex: 1 }, placeholder: 'Value', value: v, onChange: (e) => { const n = Object.assign({}, kvs); n[k] = e.target.value; onSet(n) } }),
          btn('✕', () => { const n = Object.assign({}, kvs); delete n[k]; onSet(n) }, 'danger')
        )) : el('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', padding: '4px 0' } }, '暂无自定义请求头'),
        btn('＋添加 Header', () => onSet(Object.assign({}, kvs, { '': '' })))
      )
    }

    // rc.2 llm-pi-ai PiAiCompatProfile：全部字段真实生效（以安装运行时 d.ts/lib 为准，
    // 非源码仓快照）。按协议分组——模型级开关填错协议会使 resolve 直接失败，
    // route 级会跳过不适配的模型，所以编辑器只渲染当前协议接受的字段。
    const COMPAT_BOOL = {
      'openai-completions': ['supportsStore', 'supportsDeveloperRole', 'supportsReasoningEffort', 'supportsUsageInStreaming', 'requiresToolResultName', 'requiresAssistantAfterToolResult', 'requiresThinkingAsText', 'requiresReasoningContentOnAssistantMessages', 'supportsStrictMode', 'supportsLongCacheRetention'],
      'openai-responses': ['supportsDeveloperRole', 'supportsStrictMode', 'supportsLongCacheRetention'],
      'anthropic-messages': ['supportsEagerToolInputStreaming', 'supportsCacheControlOnTools', 'supportsTemperature', 'forceAdaptiveThinking', 'allowEmptySignature', 'supportsStrictTools', 'supportsLongCacheRetention'],
    }
    const COMPAT_SELECTS = {
      'openai-completions': [
        ['thinkingFormat', TF, '推理参数格式；chat-template / qwen-chat-template 会把 thinking 状态注入 chat_template_kwargs'],
        ['maxTokensField', MAX_TOKENS_FIELDS, '输出上限字段拼写（缺省 max_tokens）'],
        ['cacheControlFormat', CACHE_CONTROL_FORMATS, 'prompt-cache 标记约定'],
      ],
    }
    const COMPAT_KV = { 'openai-completions': [['chatTemplateKwargs', 'chat_template_kwargs 键值对；值支持 $var 占位（如 {"$var":"thinking.enabled","omitWhenOff":true}，此处仅支持字符串值，占位对象请手改配置文件）']] }

    function compatEditor(compat, onSet, apiType) {
      const c = compat || {}
      const setK = (k, v) => { const n = Object.assign({}, c); if (v === '' || v === undefined) delete n[k]; else n[k] = v; onSet(n) }
      const label = (k, d) => el('label', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }, title: d }, k)
      // 布尔三态：未设置 = 交给 pi-ai 按 baseURL 自动探测；checkbox 表达不了三态
      const boolF = (k, d) => el('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
        label(k, d),
        el('select', { className: 'mcm-in', style: { height: 28, fontSize: 12 }, value: c[k] == null ? '' : String(c[k]), onChange: (e) => setK(k, e.target.value === '' ? undefined : e.target.value === 'true') },
          el('option', { value: '' }, '— 默认 —'),
          el('option', { value: 'true' }, '开'),
          el('option', { value: 'false' }, '关')
        )
      )
      const selectF = (k, opts, d) => el('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
        label(k, d),
        el('select', { className: 'mcm-in', style: { height: 28, fontSize: 12 }, value: c[k] || '', onChange: (e) => setK(k, e.target.value || undefined) },
          el('option', { value: '' }, '— 默认 —'),
          ...opts.map((o) => el('option', { key: o, value: o }, o))
        )
      )
      const kvF = (k, d) => field(k, d, false, kvEditor(c[k] && typeof c[k] === 'object' ? c[k] : {}, (v) => setK(k, v && Object.keys(v).length ? v : undefined)))
      const api = apiType || 'openai-completions'
      const items = [
        ...(COMPAT_BOOL[api] || []).map((k) => boolF(k)),
        ...(COMPAT_SELECTS[api] || []).map(([k, opts, d]) => selectF(k, opts, d)),
        ...(COMPAT_KV[api] || []).map(([k, d]) => kvF(k, d)),
      ]
      return el('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, padding: '8px 0' } },
        items.length > 0
          ? el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 } }, items)
          : el('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, '当前协议（' + api + '）没有可配置的 compat 字段'),
        el('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', lineHeight: 1.6 } },
          'Compat 字段以安装运行时（rc.2 PiAiCompatProfile，20 项）为准、全部真实生效；保存时全量透传不再剥离。本编辑器只显示当前协议（' + api + '）接受的字段——模型级开关填错协议会使 resolve 直接失败。「— 默认 —」= 删除该键，交给 pi-ai 按 baseURL 自动探测。'
        )
      )
    }

    function levelsEditor(efforts, onSet) {
      const cur = efforts && typeof efforts === 'object' ? efforts : {}
      return el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(85px, 1fr))', gap: 6 } }, LEVELS.map((lv) => {
        const wire = cur[lv]
        return el('div', { key: lv, style: { display: 'flex', flexDirection: 'column', gap: 2 } }, el('label', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, lv), el('input', { className: 'mcm-in mono', style: { height: 28, fontSize: 12, padding: '0 6px' }, value: wire == null ? '' : String(wire), placeholder: lv === 'off' ? '(null)' : 'wire', onChange: (e) => { const v = e.target.value; const n = Object.assign({}, cur); if (v === '' && lv !== 'off') { delete n[lv] } else if (v === '') { n[lv] = null } else { n[lv] = v }; onSet(n) } }))
      }))
    }

    function GlobalTestConfigModal(props) {
      const win = props.win; const setWin = props.setWin
      const [prompt, setPrompt] = useState(localStorage.getItem('mcm_test_prompt') || '用一句话介绍你自己')
      const [maxTokens, setMaxTokens] = useState(Number(localStorage.getItem('mcm_test_max_tokens')) || 256)

      const save = () => {
        localStorage.setItem('mcm_test_prompt', prompt)
        localStorage.setItem('mcm_test_max_tokens', String(maxTokens))
        setWin(false)
      }

      if (!win) return null
      return el('div', { className: 'mcm-mask', onClick: () => setWin(false) },
        el('div', { className: 'mcm-modal', onClick: (e) => e.stopPropagation() },
          el('div', { className: 'mcm-modal-h' },
            el('h3', { style: { margin: 0, fontSize: 15, fontWeight: 600 } }, '⚙️ 全局模型测试参数配置'),
            btn('✕', () => setWin(false))
          ),
          el('div', { className: 'mcm-modal-b' },
            field('测试 Prompt', '点击单模型测试时直接发送的用户消息', false,
              el('textarea', { className: 'mcm-in', style: { height: 80, padding: 8, resize: 'vertical' }, value: prompt, onChange: (e) => setPrompt(e.target.value) })
            ),
            field('Max Tokens', '单次快速测试的最大 Token 限制', false,
              el('input', { type: 'number', className: 'mcm-in', value: maxTokens, onChange: (e) => setMaxTokens(Number(e.target.value) || 256) })
            ),
            el('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, '说明：配置后点击模型行「⚡测试」将静默发起测试，无需每次确认。')
          ),
          el('div', { className: 'mcm-modal-f' },
            btn('取消', () => setWin(false)),
            btn('保存配置', save, 'primary')
          )
        )
      )
    }

    function TestResultDetailModal(props) {
      const win = props.win; const setWin = props.setWin
      if (!win) return null
      const res = win.result || {}
      return el('div', { className: 'mcm-mask', onClick: () => setWin(null) },
        el('div', { className: 'mcm-modal', onClick: (e) => e.stopPropagation() },
          el('div', { className: 'mcm-modal-h' },
            el('h3', { style: { margin: 0, fontSize: 15, fontWeight: 600 } }, (res.status === 'ok' ? '✓ 测试成功 · ' : '✗ 测试异常 · ') + win.model),
            btn('✕', () => setWin(null))
          ),
          el('div', { className: 'mcm-modal-b' },
            el('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
              el('span', { className: 'mcm-badge brand' }, win.provider),
              el('span', { className: 'mcm-badge' }, win.model),
              res.status === 'ok' ? el('span', { className: 'mcm-badge success' }, 'HTTP 200 OK') : el('span', { className: 'mcm-badge error' }, res.code || 'ERROR')
            ),
            res.status === 'ok' ? el('div', { style: { background: 'var(--dsw-alias-bg-layer-2)', padding: 12, borderRadius: 8, border: '1px solid var(--dsw-alias-border-l1)', display: 'flex', flexDirection: 'column', gap: 6 } },
              el('div', { style: { display: 'flex', gap: 16, fontSize: 12, color: 'var(--dsw-alias-state-success-primary)', fontWeight: 600 } },
                el('span', null, 'TTFT 首字响应: ' + (res.ttftMs != null ? (res.ttftMs / 1000).toFixed(2) + 's' : '—')),
                el('span', null, '总延迟耗时: ' + (res.latencyMs != null ? (res.latencyMs / 1000).toFixed(2) + 's' : '—'))
              ),
              res.reasoning ? el('div', { style: { marginTop: 6 } },
                el('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, '思考过程 (Reasoning)'),
                el('pre', { style: { whiteSpace: 'pre-wrap', fontSize: 12, fontFamily: 'var(--ds-font-family-code)', maxHeight: 140, overflow: 'auto', color: 'var(--dsw-alias-label-secondary)', margin: '4px 0' } }, res.reasoning)
              ) : null,
              res.text ? el('div', { style: { marginTop: 6 } },
                el('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, '正文回复 (Text)'),
                el('pre', { style: { whiteSpace: 'pre-wrap', fontSize: 12, fontFamily: 'var(--ds-font-family-code)', maxHeight: 180, overflow: 'auto', color: 'var(--dsw-alias-label-primary)', margin: '4px 0' } }, res.text)
              ) : null
            ) : el('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 13, padding: 12, background: 'rgba(239, 68, 68, 0.08)', borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 4 } },
              el('strong', null, '错误代码: ' + (res.code || 'UNKNOWN')),
              el('div', { style: { fontFamily: 'var(--ds-font-family-code)', fontSize: 12 } }, res.error || '未知网络或认证异常')
            )
          ),
          el('div', { className: 'mcm-modal-f' },
            btn('关闭', () => setWin(null))
          )
        )
      )
    }

    function RenameProviderModal(props) {
      const win = props.win; const setWin = props.setWin
      const [value, setValue] = useState('')
      const [err, setErr] = useState(null)
      useEffect(() => { if (win) { setValue(win.value || ''); setErr(null) } }, [win])
      if (!win) return null
      const submit = () => {
        const next = value.trim()
        if (next === win.from) { setWin(null); return }
        if (!/^[a-z][a-z0-9-]*$/.test(next)) {
          setErr('ID 必须以小写字母开头，只能包含小写字母、数字与连字符 (-)')
          return
        }
        const outcome = props.onRename(win.from, next)
        if (outcome && outcome.error) { setErr(outcome.error); return }
        setWin(null)
      }
      return el('div', { className: 'mcm-mask', onClick: () => setWin(null) },
        el('div', { className: 'mcm-modal', style: { maxWidth: 460 }, onClick: (e) => e.stopPropagation() },
          el('div', { className: 'mcm-modal-h' },
            el('h3', { style: { margin: 0, fontSize: 15, fontWeight: 600 } }, '重命名供应商 ID · ' + win.from),
            btn('✕', () => setWin(null))
          ),
          el('div', { className: 'mcm-modal-b' },
            field('新 Provider ID', '作为 settings 键、会话日志引用与轮询组候选的标识', true,
              el('input', { className: 'mcm-in mono', autoFocus: true, value, onChange: (e) => setValue(e.target.value) })
            ),
            err ? el('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 } }, err) : null,
            el('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', lineHeight: 1.6 } },
              el('div', null, '· 轮询组候选池中的引用会自动同步更新。'),
              el('div', null, '· apiKeyEnv 凭据引用保持不变，已存储的 Key 继续有效；如需更换引用名请手动编辑该字段。'),
              el('div', null, '· 历史健康统计保留在原 ID 名下（历史存档不受影响）。')
            )
          ),
          el('div', { className: 'mcm-modal-f' },
            btn('取消', () => setWin(null)),
            btn('确认重命名', submit, 'primary')
          )
        )
      )
    }

    function fetchModal(name, p, disc, setDisc, getTypedKey, onApply, fq, setFq) {
      if (!disc || disc.provider !== name) return null
      let body
      if (disc.loading) {
        body = el('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: 32 } },
          el('div', { className: 'mcm-spin', style: { width: 24, height: 24 } }),
          el('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, '正在连接上游端点拉取模型列表…')
        )
      } else if (disc.error) {
        body = el('div', { style: { color: 'var(--dsw-alias-state-error-primary)', padding: 16, textAlign: 'center', fontSize: 13 } },
          el('div', { style: { marginBottom: 12 } }, '拉取失败: ' + disc.error),
          btn('重新尝试', () => { setDisc({ provider: name, loading: true }); doFetch(name, p, setDisc, getTypedKey()) }, 'primary')
        )
      } else {
        const d = disc
        const all = [
          ...d.missing.map((id) => ({ id, tag: 'add', txt: '+ 可添加' })),
          ...d.configured.map((id) => ({ id, tag: 'ok', txt: '✓ 已配置' })),
          ...d.stale.map((id) => ({ id, tag: 'stale', txt: '! 端点已下线' }))
        ]
        // 搜索过滤：模型 id 子串匹配（不区分大小写）；badge 统计仍按全量
        const fql = (fq || '').trim().toLowerCase()
        const visible = fql ? all.filter((item) => item.id.toLowerCase().includes(fql)) : all
        const toggle = (item) => {
          const s = new Set(d.selected)
          if (s.has(item.id)) { s.delete(item.id) } else { s.add(item.id) }
          setDisc(Object.assign({}, d, { selected: s }))
        }
        body = el('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
          el('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', background: 'var(--dsw-alias-bg-layer-2)', padding: '8px 12px', borderRadius: 8 } },
            el('span', { className: 'mcm-badge' }, '端点模型总数: ' + d.available.length),
            el('span', { className: 'mcm-badge success' }, '✓ 已匹配: ' + d.configured.length),
            el('span', { className: 'mcm-badge brand' }, '+ 可新增: ' + d.missing.length),
            d.stale.length > 0 ? el('span', { className: 'mcm-badge error' }, '! 端点无此模型: ' + d.stale.length) : null
          ),
          el('div', { style: { display: 'flex', gap: 10, alignItems: 'center' } },
            el('input', {
              className: 'mcm-in', style: { flex: 1 }, placeholder: '搜索模型 id…（不区分大小写）', value: fq || '',
              onChange: (e) => setFq(e.target.value)
            }),
            el('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', flexShrink: 0 } }, '显示 ' + visible.length + ' / ' + all.length)
          ),
          el('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, '说明：勾选 = 保留或添加；取消勾选 = 删除。已配置项默认勾选。'),
          el('div', { style: { maxHeight: 300, overflowY: 'auto', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1)' } },
            visible.length === 0 ? el('div', { className: 'mcm-empty' }, fql ? '无匹配「' + fq.trim() + '」的模型' : '端点未返回任何可用模型') :
            visible.map((item) => {
              const checked = d.selected.has(item.id)
              return el('div', {
                key: item.id,
                style: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: '1px solid var(--dsw-alias-border-l1)', cursor: 'pointer', background: checked ? 'rgba(var(--dsw-rgb-brand-primary, 59, 130, 246), 0.04)' : 'transparent' },
                onClick: () => toggle(item)
              },
                el('input', { type: 'checkbox', checked, onChange: (e) => { e.stopPropagation(); toggle(item) } }),
                el('label', { style: { flex: 1, fontFamily: 'var(--ds-font-family-code)', fontSize: 12, cursor: 'pointer' } }, item.id),
                el('span', { className: 'mcm-badge ' + (item.tag === 'ok' ? 'success' : item.tag === 'add' ? 'brand' : 'error') }, item.txt)
              )
            })
          )
        )
      }
      const cc = disc && disc.selected ? disc.selected.size : 0
      return el('div', { className: 'mcm-mask', onClick: () => setDisc(null) },
        el('div', { className: 'mcm-modal', onClick: (e) => e.stopPropagation() },
          el('div', { className: 'mcm-modal-h' },
            el('h3', { style: { margin: 0, fontSize: 15, fontWeight: 600 } }, '拉取上游端点模型 · ' + (p.displayName || name)),
            btn('✕', () => setDisc(null))
          ),
          el('div', { className: 'mcm-modal-b' }, body),
          el('div', { className: 'mcm-modal-f' },
            btn('取消', () => setDisc(null)),
            btn('应用选中模型 (' + cc + ')', () => { if (disc.selected) { onApply([...disc.selected]); setDisc(null) } }, 'primary')
          )
        )
      )
    }

    function doFetch(name, p, setDisc, typedKey) {
      if (!apiRef) { setDisc({ provider: name, error: 'api unavailable' }); return }
      const key = (typedKey && typedKey.trim()) ? typedKey.trim() : (savedKeys[name] || undefined)
      apiRef.llm.discoverModels({
        settingsNs: 'llm-pi-ai',
        provider: name,
        baseURL: p.baseURL || undefined,
        api: p.api || undefined,
        apiKey: key
      }).then((resp) => {
        const r = resp && resp.result ? resp.result : resp
        if (r && r.ok === false) throw new Error((r.error && (r.error.message || r.error)) || 'discover failed')
        const result = r && r.value !== undefined ? r.value : r
        const models = (result && result.models) || []
        const av = models.map((m) => m.id).filter(Boolean)
        const cf = new Set((p.models || []).map((m) => m.id))
        setDisc({
          provider: name,
          available: av,
          configured: [...cf].filter((id) => av.includes(id)),
          missing: av.filter((id) => !cf.has(id)),
          stale: [...cf].filter((id) => !av.includes(id)),
          selected: new Set([...cf].filter((id) => av.includes(id)))
        })
      }).catch((e) => setDisc({ provider: name, error: String((e && e.message) || e) }))
    }

    function ModelConfigPanel(props) {
      const draft = props._draft; const setDraft = props._setDraft
      const setNotice = props._setNotice || (() => {})
      const [exp, setExp] = useState({}); const [em, setEm] = useState({}); const [live, setLive] = useState({})
      const [sa, setSa] = useState({})
      const [keyInput, setKeyInput] = useState({})
      const [testStates, setTestStates] = useState({})
      const [detailWin, setDetailWin] = useState(null)
      const [configWin, setConfigWin] = useState(false)
      const [disc, setDisc] = useState(null)
      const [renameWin, setRenameWin] = useState(null)
      const [dragIdx, setDragIdx] = useState(null)
      const [overIdx, setOverIdx] = useState(null)
      const [pq, setPq] = useState('')
      // 拉取上游模型弹窗的搜索词（打开新弹窗时复位）
      const [fq, setFq] = useState('')
      const providers = draft || {}

      // 拖动排序：provider 字典保序重建（对象键插入顺序即 YAML/JSON 持久化顺序）
      const moveProvider = (from, to) => {
        setDraft((d) => {
          const entries = Object.entries(d || {})
          if (from === to || from < 0 || to < 0 || from >= entries.length || to >= entries.length) return d
          const [item] = entries.splice(from, 1)
          entries.splice(to, 0, item)
          const out = {}
          for (const [k, v] of entries) out[k] = v
          return out
        })
      }

      const renameProvider = (from, to) => {
        if (!providers[from]) return { error: '找不到原 ID（可能未保存，刷新后再试）' }
        if (providers[to]) return { error: '新 ID 已存在，请换一个' }
        const order = Object.keys(providers)
        const next = {}
        for (const k of order) {
          next[(k === from) ? to : k] = providers[k]
        }
        setDraft(next)
        setExp((s) => { const n = Object.assign({}, s); if (Object.prototype.hasOwnProperty.call(n, from)) { n[to] = n[from]; delete n[from] } return n })
        setEm((s) => { const n = Object.assign({}, s); for (const k of Object.keys(n)) { if (k === from || k.indexOf(from + '::') === 0) { n[(k === from ? to : to + '::' + k.slice(from.length + 2))] = n[k]; delete n[k] } } return n })
        setKeyInput((s) => { const n = Object.assign({}, s); if (Object.prototype.hasOwnProperty.call(n, from)) { n[to] = n[from]; delete n[from] } return n })
        setLive((s) => { const n = Object.assign({}, s); for (const k of Object.keys(n)) { if (k === from || k.indexOf(from + '_') === 0) { n[(k === from ? to : to + k.slice(from.length))] = n[k] } } return n })
        delete savedKeys[to]; if (savedKeys[from] !== undefined) { savedKeys[to] = savedKeys[from]; delete savedKeys[from] }
        if (props._renameProviderInChannels) props._renameProviderInChannels(from, to)
        setNotice('已重命名 ' + from + ' → ' + to + '（点击「保存全部变更」生效）')
        setTimeout(() => setNotice(null), 4000)
        return {}
      }

      const pollTest = (nonce, provider, model, attempt = 0) => {
        if (!apiRef) return
        const key = provider + '::' + model
        // host 侧测试超时 60s，约 55 次 × 1.2s ≈ 66s 后放弃，避免结果被覆盖时无限轮询
        const giveUp = () => setTestStates((s) => Object.assign({}, s, { [key]: { status: 'error', code: 'POLL_TIMEOUT', error: '等待测试结果超时：host 可能未处理该请求（host 半更新后需重启 DSH）' } }))
        apiRef.settings.describe({}).then((resp) => {
          const r = resp && resp.result ? resp.result : resp
          const d = r && r.value !== undefined ? r.value : r
          const ns = ((d && d.namespaces) || []).find((n) => n && n.ns === 'model-channel-health')
          const tr = (ns && ns.value && ns.value.testResults) || {}
          const e = tr[nonce]
          if (e && (e.status === 'ok' || e.status === 'error')) {
            setTestStates((s) => Object.assign({}, s, { [key]: e }))
          } else if (attempt >= 55) {
            giveUp()
          } else {
            setTimeout(() => pollTest(nonce, provider, model, attempt + 1), 1200)
          }
        }).catch(() => {
          if (attempt >= 55) giveUp()
          else setTimeout(() => pollTest(nonce, provider, model, attempt + 1), 1500)
        })
      }

      const fireTest = (provider, model) => {
        if (!apiRef) return
        const key = provider + '::' + model
        setTestStates((s) => Object.assign({}, s, { [key]: { status: 'running' } }))
        const nonce = Date.now() % 1000000000
        const prompt = localStorage.getItem('mcm_test_prompt') || '用一句话介绍你自己'
        const maxTokens = Number(localStorage.getItem('mcm_test_max_tokens')) || 256
        apiRef.settings.update({
          ns: 'model-channel-health',
          patch: { testRequest: { nonce, provider, model, prompt, maxTokens } }
        }).then(() => {
          pollTest(nonce, provider, model)
        }).catch((e) => {
          setTestStates((s) => Object.assign({}, s, { [key]: { status: 'error', error: String((e && e.message) || e) } }))
        })
      }

      const launchTest = (provider, model) => {
        // 模型尚未保存到配置中 → 友好提示
        const currentSavedModels = (props._state?.providers?.[provider]?.models || []).map((m) => m.id)
        if (!currentSavedModels.includes(model)) {
          setNotice('请先点击右上角「保存全部变更」，保存后方可进行真实链路测试')
          setTimeout(() => setNotice(null), 4000)
          return
        }
        const pCfg = providers[provider] || {}
        const ref = typeof pCfg.apiKeyEnv === 'string' && pCfg.apiKeyEnv.trim() ? pCfg.apiKeyEnv.trim() : ''
        const typed = (keyInput[provider] || '').trim()
        // 无凭据引用 → 直接测试（例如原生认证渠道）
        if (!ref) { fireTest(provider, model); return }
        // 输入框有 Key → 自动写入存储后再测试（与 DSH Models 页同一语义：键入即写入）
        if (typed) {
          savedKeys[provider] = typed
          apiRef.credentials.set({ ref, value: typed }).then((resp) => {
            const r = resp && resp.result ? resp.result : resp
            if (r && r.ok === false) throw new Error((r.error && (r.error.message || r.error)) || 'set failed')
            setLive((l) => Object.assign({}, l, { [provider + '_key']: 'saved' }))
            fireTest(provider, model)
          }).catch((e) => {
            setNotice('凭据写入失败: ' + String((e && e.message) || e))
            setTimeout(() => setNotice(null), 5000)
          })
          return
        }
        // 输入框为空 → 询问凭据存储是否已配置
        apiRef.credentials.describe({ refs: [ref] }).then((resp) => {
          const r = resp && resp.result ? resp.result : resp
          const d = r && r.value !== undefined ? r.value : r
          const c = d && d.credentials && d.credentials[ref]
          if (c && c.configured) { fireTest(provider, model); return }
          setTestStates((s) => Object.assign({}, s, { [provider + '::' + model]: { status: 'error', code: 'MISSING_CREDENTIAL', error: '缺少 API Key: 请在「快速写入密钥」输入框中粘贴 Key 并点击「写入存储」，或设置环境变量 ' + ref } }))
          setNotice('缺少 API Key（' + ref + '）: 请粘贴 Key 到「快速写入密钥」并点击「写入存储」后再测试')
          setTimeout(() => setNotice(null), 5000)
        }).catch(() => fireTest(provider, model))
      }
      const updateP = (name, patch) => setDraft((d) => Object.assign({}, d, { [name]: Object.assign({}, d[name], patch) }))
      const updateModel = (name, mi, patch) => setDraft((d) => { const ms = (d[name].models || []).map((mm, i) => i === mi ? Object.assign({}, mm, patch) : mm); return Object.assign({}, d, { [name]: Object.assign({}, d[name], { models: ms }) }) })
      const removeModel = (name, mi) => setDraft((d) => { const ms = (d[name].models || []).filter((_, i) => i !== mi); return Object.assign({}, d, { [name]: Object.assign({}, d[name], { models: ms }) }) })
      const saveKey = (name) => {
        const ref = (providers[name] || {}).apiKeyEnv || ''
        const val = (keyInput[name] || '').trim()
        if (!ref || !val || !apiRef) return
        savedKeys[name] = val
        apiRef.credentials.set({ ref, value: val }).then((resp) => {
          const r = resp && resp.result ? resp.result : resp
          if (r && r.ok === false) throw new Error((r.error && (r.error.message || r.error)) || 'set failed')
          setLive((l) => Object.assign({}, l, { [name + '_key']: 'saved' }))
        }).catch((e) => setLive((l) => Object.assign({}, l, { [name + '_key']: 'err: ' + String((e && e.message) || e) })))
      }

      // 搜索过滤：provider id/显示名/模型 id/模型名子串匹配（不区分大小写）；
      // 搜索时命中卡片自动展开。拖拽坐标用 realIdx（全量列表真实下标），
      // 过滤视图内拖放仍映射到全量列表的正确位置。
      const pqLower = pq.trim().toLowerCase()
      const visibleEntries = Object.entries(providers)
        .map(([name, p], realIdx) => ({ name, p, realIdx }))
        .filter(({ name, p }) => {
          if (!pqLower) return true
          if (name.toLowerCase().includes(pqLower)) return true
          if (p.displayName && String(p.displayName).toLowerCase().includes(pqLower)) return true
          return (p.models || []).some((m) => m && ((m.id || '').toLowerCase().includes(pqLower) || (m.name || '').toLowerCase().includes(pqLower)))
        })
      const cards = visibleEntries.map(({ name, p, realIdx }) => {
        const isOpen = pqLower ? true : !!exp[name]
        const models = p.models || []
        const currentName = p.displayName !== undefined ? p.displayName : name
        const isDragging = dragIdx === realIdx
        const isDropTarget = overIdx === realIdx && dragIdx !== null && dragIdx !== realIdx
        return el('div', {
          className: 'mcm-card',
          key: name,
          style: Object.assign(
            { transition: 'border-color 0.15s ease, opacity 0.15s ease' },
            isDragging ? { opacity: 0.45 } : {},
            isDropTarget ? { borderColor: 'var(--dsw-alias-brand-primary)', boxShadow: '0 0 0 2px rgba(59, 130, 246, 0.18)' } : {}
          ),
          onDragOver: (e) => {
            e.preventDefault()
            if (dragIdx !== null && dragIdx !== realIdx) setOverIdx(realIdx)
          },
          onDrop: (e) => {
            e.preventDefault()
            if (dragIdx !== null && dragIdx !== realIdx) moveProvider(dragIdx, realIdx)
            setDragIdx(null)
            setOverIdx(null)
          }
        },
          el('div', { className: 'mcm-card-h', onClick: () => setExp((e) => Object.assign({}, e, { [name]: !e[name] })) },
            el('span', {
              title: '拖动此手柄调整供应商顺序（保存后生效）',
              draggable: true,
              onDragStart: (e) => { e.stopPropagation(); setDragIdx(idx); try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(idx)) } catch (_e) {} },
              onDragEnd: () => { setDragIdx(null); setOverIdx(null) },
              onClick: (e) => e.stopPropagation(),
              style: { cursor: 'grab', color: 'var(--dsw-alias-label-tertiary)', fontSize: 14, padding: '0 6px', userSelect: 'none' }
            }, '⠿'),
            el('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, isOpen ? '▼' : '▶'),
            el('div', { className: 'mcm-card-title' }, el('span', null, p.displayName || name), el('span', { className: 'mcm-badge brand' }, name)),
            p.api ? el('span', { className: 'mcm-badge' }, p.api) : null,
            el('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', marginLeft: 'auto' } }, models.length + ' 个模型'),
            el('div', { style: { display: 'flex', gap: 6, marginLeft: 12 }, onClick: (e) => e.stopPropagation() },
              btn('改名', () => setRenameWin({ from: name, value: name })),
              btn('删', () => { if (confirm('删除 Provider ' + name + '?')) setDraft((d) => { const n = clone(d); delete n[name]; return n }) }, 'danger')
            )
          ),
          isOpen ? el('div', { className: 'mcm-editor' },
            el('div', { className: 'mcm-row' },
              tf('显示名称', '管理面板中的可读名称', currentName, (v) => updateP(name, { displayName: v })),
              sel('协议架构 (API)', '当前支持的请求格式', p.api || 'openai-completions', APIS, (v) => updateP(name, { api: v }))
            ),
            el('div', { className: 'mcm-row' },
              tf('Base URL', 'API 端点基础地址', p.baseURL || '', (v) => updateP(name, { baseURL: v }), true),
              tf('API Key 环境变量名', '凭据存储引用名', p.apiKeyEnv || '', (v) => updateP(name, { apiKeyEnv: v }), true)
            ),
            field('快速写入密钥', '将 API Key 安全存入 DSH 凭据存储', false,
              el('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                el('input', { type: 'password', className: 'mcm-in mono', style: { flex: 1 }, placeholder: '输入并覆盖 API Key (sk-...)', value: keyInput[name] || '', onChange: (e) => setKeyInput((k) => Object.assign({}, k, { [name]: e.target.value })) }),
                btn('写入存储', () => saveKey(name)),
                live[name + '_key'] === 'saved' ? el('span', { style: { color: 'var(--dsw-alias-state-success-primary)', fontSize: 12 } }, '✓ 已保存') : null
              )
            ),
            el('div', { style: { borderTop: '1px dashed var(--dsw-alias-border-l2)', paddingTop: 10 } },
              el('div', { style: { cursor: 'pointer', fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', display: 'flex', alignItems: 'center', gap: 6 }, onClick: () => setSa((s) => Object.assign({}, s, { [name]: !s[name] })) },
                el('span', null, sa[name] ? '▼' : '▶'), '供应商高级选项 (Headers, 传输, 超时, 图片预算, 重试策略, Compat)'
              ),
              sa[name] ? el('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, marginTop: 10 } },
                el('div', { className: 'mcm-row' },
                  nf('默认 Context Window', '未单独配置模型时的默认窗口', p.defaultContextWindow || 0, (v) => updateP(name, { defaultContextWindow: v })),
                  nf('默认 Max Tokens', '未单独配置模型时的最大输出', p.defaultMaxTokens || 0, (v) => updateP(name, { defaultMaxTokens: v }))
                ),
                field('自定义 HTTP Headers', '向上游端点发送的请求头', false, kvEditor(p.headers || {}, (v) => updateP(name, { headers: v }))),
                el('div', { className: 'mcm-row' },
                  sel('默认思考强度 (Reasoning)', '供应商默认', p.reasoning || '', LEVELS, (v) => updateP(name, { reasoning: v || undefined })),
                  sel('传输通道 (Transport)', '协议传输形式', p.transport || 'auto', TRANSPORTS, (v) => updateP(name, { transport: v })),
                  sel('Prompt 缓存保留', 'KV Cache 策略', p.cacheRetention || 'none', CACHE, (v) => updateP(name, { cacheRetention: v }))
                ),
                el('div', { className: 'mcm-row' },
                  nf('请求超时 (ms)', '首响应超时时间', p.timeoutMs || 0, (v) => updateP(name, { timeoutMs: v })),
                  nf('流空闲超时 (ms)', 'chunk 之间最大停顿', p.streamIdleTimeoutMs || 0, (v) => updateP(name, { streamIdleTimeoutMs: v })),
                  nf('WebSocket 超时 (ms)', '连接建立等待', p.websocketConnectTimeoutMs || 0, (v) => updateP(name, { websocketConnectTimeoutMs: v }))
                ),
                el('div', { className: 'mcm-row' },
                  nf('图片总像素上限', 'requestImagePixelBudget', p.requestImagePixelBudget || 0, (v) => updateP(name, { requestImagePixelBudget: v })),
                  nf('单张图片字节上限', 'requestImageMaxBytes', p.requestImageMaxBytes || 0, (v) => updateP(name, { requestImageMaxBytes: v }))
                ),
                field('供应商级 Compat 兼容选项', '端点级 API 行为修正', false, compatEditor(p.compat, (v) => updateP(name, { compat: v }), p.api || 'openai-completions'))
              ) : null
            ),
            el('div', { style: { marginTop: 8 } },
              el('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 } },
                el('span', { style: { fontWeight: 600, fontSize: 13 } }, '模型列表 (' + models.length + ')'),
                el('div', { style: { display: 'flex', gap: 6 } },
                  btn('🔍 拉取上游模型', () => { setFq(''); setDisc({ provider: name, loading: true }); doFetch(name, p, setDisc, keyInput[name]) }, 'primary'),
                  btn('＋添加模型', () => updateP(name, { models: models.concat([{ id: '', name: '', contextWindow: 1048576, maxTokens: 131072, input: ['text', 'image'], reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } }]) }))
                )
              ),
              fetchModal(name, p, disc, setDisc, () => keyInput[name], (ids) => {
                const cs = new Set(ids)
                const kept = models.filter((m) => cs.has(m.id))
                const ex = new Set(kept.map((m) => m.id))
                const news = [...cs].filter((id) => !ex.has(id)).map((id) => ({
                  id,
                  name: id,
                  contextWindow: 1048576,
                  maxTokens: 131072,
                  input: ['text', 'image'],
                  reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }
                }))
                updateP(name, { models: kept.concat(news) })
              }, fq, setFq),
              models.map((m, mi) => {
                const isMOpen = !!em[name + '::' + mi]
                const ts = testStates[name + '::' + m.id]
                return el('div', { className: 'mcm-subcard', key: mi },
                  el('div', { className: 'mcm-subcard-h', onClick: () => setEm((e) => Object.assign({}, e, { [name + '::' + mi]: !e[name + '::' + mi] })) },
                    el('span', { style: { fontSize: 10, color: 'var(--dsw-alias-label-tertiary)' } }, isMOpen ? '▼' : '▶'),
                    el('span', { style: { fontFamily: 'var(--ds-font-family-code)', fontWeight: 600, fontSize: 12 } }, m.id || '(未命名)'),
                    (m.input || []).includes('image') ? el('span', { className: 'mcm-badge success' }, 'vision') : null,
                    m.reasoningEfforts ? el('span', { className: 'mcm-badge brand' }, 'reasoning') : null,
                    ts ? (
                      ts.status === 'running' ? el('span', { className: 'mcm-badge brand' }, '测试中…') :
                      ts.status === 'ok' ? el('span', {
                        className: 'mcm-badge success',
                        style: { cursor: 'pointer' },
                        title: '点击查看成功详情与回复',
                        onClick: (e) => { e.stopPropagation(); setDetailWin({ provider: name, model: m.id, result: ts }) }
                      }, '✓ 成功 (详情)') :
                      el('span', {
                        className: 'mcm-badge error',
                        style: { cursor: 'pointer' },
                        title: '点击查看具体异常错误原因',
                        onClick: (e) => { e.stopPropagation(); setDetailWin({ provider: name, model: m.id, result: ts }) }
                      }, '✗ 异常 (详情)')
                    ) : null,
                    el('div', { style: { marginLeft: 'auto', display: 'flex', gap: 6 }, onClick: (e) => e.stopPropagation() },
                      btn('⚡测试', () => launchTest(name, m.id), 'primary'),
                      btn('✕', () => removeModel(name, mi), 'danger')
                    )
                  ),
                  isMOpen ? el('div', { className: 'mcm-subcard-b' },
                    el('div', { className: 'mcm-row' },
                      tf('模型 ID', '唯一模型标识', m.id || '', (v) => updateModel(name, mi, { id: v }), true),
                      tf('显示别名', 'UI 呈现名称', m.name || '', (v) => updateModel(name, mi, { name: v }))
                    ),
                    el('div', { className: 'mcm-row' },
                      nf('Context Window', '上下文窗口长度', m.contextWindow || 0, (v) => updateModel(name, mi, { contextWindow: v })),
                      nf('Max Tokens', '最大生成长度', m.maxTokens || 0, (v) => updateModel(name, mi, { maxTokens: v }))
                    ),
                    field('支持的模态 (Input)', 'text=纯文本, image=图片', false,
                      el('div', { style: { display: 'flex', gap: 16, alignItems: 'center', height: 32 } },
                        el('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' } },
                          el('input', { type: 'checkbox', checked: (m.input || ['text']).includes('text'), onChange: (e) => {
                            const cur = new Set(m.input || ['text'])
                            if (e.target.checked) cur.add('text'); else cur.delete('text')
                            updateModel(name, mi, { input: [...cur] })
                          } }),
                          el('span', null, 'text (文本)')
                        ),
                        el('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' } },
                          el('input', { type: 'checkbox', checked: (m.input || []).includes('image'), onChange: (e) => {
                            const cur = new Set(m.input || ['text'])
                            if (e.target.checked) cur.add('image'); else cur.delete('image')
                            updateModel(name, mi, { input: [...cur] })
                          } }),
                          el('span', null, 'image (图片/视觉)')
                        )
                      )
                    ),
                    field('思考强度映射 (Reasoning Efforts)', '各档发往上游的值映射 (high, xhigh, max 等)', false, levelsEditor(m.reasoningEfforts, (v) => updateModel(name, mi, { reasoningEfforts: v }))),
                    el('div', { style: { borderTop: '1px dashed var(--dsw-alias-border-l2)', paddingTop: 8 } },
                      el('div', { style: { cursor: 'pointer', fontSize: 12, fontWeight: 500, color: 'var(--dsw-alias-label-secondary)', display: 'flex', alignItems: 'center', gap: 6 }, onClick: (e) => { e.stopPropagation(); setEm((s) => Object.assign({}, s, { ['cx_' + name + '_' + mi]: !s['cx_' + name + '_' + mi] })) } },
                        el('span', null, em['cx_' + name + '_' + mi] ? '▼' : '▶'), '模型级 Compat 兼容性覆写'
                      ),
                      em['cx_' + name + '_' + mi] ? el('div', { style: { marginTop: 8 } }, compatEditor(m.compat, (v) => updateModel(name, mi, { compat: v }), p.api || 'openai-completions')) : null
                    )
                  ) : null
                )
              })
            )
          ) : null
        )
      })

      return el('div', null,
        el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 12 } },
          el('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, pqLower
            ? ('匹配 ' + visibleEntries.length + ' / ' + Object.keys(providers).length + ' 个提供商')
            : '已配置 ' + Object.keys(providers).length + ' 个提供商 · 拖动左侧 ⠿ 手柄可调整顺序（保存后生效）'),
          el('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            el('input', {
              className: 'mcm-in', style: { width: 220, height: 30 },
              placeholder: '搜索供应商 / 模型…', value: pq,
              onChange: (e) => setPq(e.target.value)
            }),
            btn('⚙️ 配置全局测试参数', () => setConfigWin(true))
          )
        ),
        ...cards,
        visibleEntries.length === 0 && pqLower ? el('div', { className: 'mcm-empty' }, '无匹配「' + pq.trim() + '」的供应商或模型') : null,
        btn('＋新增提供商 (Provider)', () => {
          const nm = uniqueSuffixName('provider-', (n) => Object.prototype.hasOwnProperty.call(providers, n))
          const keyRef = normalizeCredentialRef(nm + '_api_key')
          setDraft((d) => Object.assign({}, d || {}, { [nm]: { api: 'openai-completions', baseURL: '', apiKeyEnv: keyRef, displayName: nm, models: [], headers: Object.assign({}, DEFAULT_HEADERS) } }))
          setExp((e) => Object.assign({}, e, { [nm]: true }))
        }, 'primary'),
        el(GlobalTestConfigModal, { win: configWin, setWin: setConfigWin }),
        el(TestResultDetailModal, { win: detailWin, setWin: setDetailWin }),
        el(RenameProviderModal, { win: renameWin, setWin: setRenameWin, onRename: renameProvider })
      )
    }

    function candidatePicker(providers, cand, onSet) {
      const pName = cand && cand.provider ? cand.provider : ''
      const mName = cand && cand.model ? cand.model : ''
      const providerCfg = (providers && providers[pName]) || {}
      const modelOptions = ((providerCfg && providerCfg.models) || []).map((m) => m.id).filter(Boolean)
      const provNames = Object.keys(providers || {})
      return el('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flex: 1 } },
        el('select', {
          className: 'mcm-in',
          style: { flex: 1 },
          value: pName,
          onChange: (e) => {
            const nextProv = e.target.value
            const nextCfg = (providers && providers[nextProv]) || {}
            const nextModels = ((nextCfg && nextCfg.models) || []).map((m) => m.id).filter(Boolean)
            onSet({ provider: nextProv, model: nextModels[0] || '' })
          }
        },
          el('option', { value: '' }, '— 选择 Provider —'),
          ...provNames.map((p) => el('option', { key: p, value: p }, p))
        ),
        el('select', {
          className: 'mcm-in',
          style: { flex: 1 },
          value: mName,
          onChange: (e) => onSet({ provider: pName, model: e.target.value })
        },
          el('option', { value: '' }, '— 选择模型 —'),
          ...modelOptions.map((m) => el('option', { key: m, value: m }, m))
        )
      )
    }

    function RoundrobinPanel(props) {
      const groups = props.channelsDraft || []
      const providers = props._providers || {}
      const [speedState, setSpeedState] = useState({})
      const [expanded, setExpanded] = useState({})

      const addGroup = () => props.setChannelsDraft((d) => {
        const base = d || []
        const id = uniqueSuffixName('group-', (n) => base.some((g) => g && g.id === n))
        return base.concat([{
          id,
          // 单一身份：显示名 = 组唯一 ID（save 时统一归一化 virtualModel.name = id，
          // 不会漂移）。默认模态含 image：host 对当前会话模型做 resolveModelInfo，
          // 缺 image 时附加图片直接被拒（MODEL_DOES_NOT_SUPPORT_IMAGES），按直觉默认放开
          virtualModel: { name: id, reasoning: true, input: ['text', 'image'], contextWindow: 1048576, maxTokens: 131072 },
          candidates: [],
          strategy: 'sticky',
          timeoutMs: 30000,
          cooldownMs: 60000,
          maxRetriesPerCandidate: 2,
          speedTest: { enabled: false, sortKey: 'ttft', prompt: '欧拉函数的意义？', maxTokens: 2048, timeoutMs: 60000, concurrency: 3, retries: 2 }
        }])
      })

      const patchGroup = (i, patch) => props.setChannelsDraft((d) => d.map((g, gi) => gi === i ? Object.assign({}, g, patch) : g))
      const patchGroupPath = (i, path, value) => props.setChannelsDraft((d) => d.map((g, gi) => {
        if (gi !== i) return g
        const cur = clone(g)
        let ref = cur
        for (let k = 0; k < path.length - 1; k++) {
          if (!ref[path[k]]) ref[path[k]] = {}
          ref = ref[path[k]]
        }
        ref[path[path.length - 1]] = value
        return cur
      }))

      const speedtest = (gid) => {
        if (!apiRef) return
        const nonce = Date.now() % 1000000000
        setSpeedState((s) => Object.assign({}, s, { [gid]: 'running' }))
        apiRef.settings.update({ ns: 'model-channel-health', patch: { speedRequest: { group: gid, nonce } } }).then(() => {
          setSpeedState((s) => Object.assign({}, s, { [gid]: 'sent' }))
          setTimeout(() => setSpeedState((s) => Object.assign({}, s, { [gid]: null })), 3000)
        }).catch(() => setSpeedState((s) => Object.assign({}, s, { [gid]: 'err' })))
      }

      if (groups.length === 0) return el('div', { className: 'mcm-empty' }, '暂无轮询组，点击下方按钮创建', el('div', { style: { marginTop: 12 } }, btn('＋新增轮询组', addGroup, 'primary')))

      return el('div', null,
        groups.map((g, i) => {
          const isOpen = !!expanded[i]
          const vm = g.virtualModel || {}
          const stCfg = g.speedTest || {}
          const st = speedState[g.id]
          return el('div', { className: 'mcm-card', key: 'rr_card_' + i },
            el('div', { className: 'mcm-card-h', onClick: () => setExpanded((e) => Object.assign({}, e, { [i]: !e[i] })) },
              el('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, isOpen ? '▼' : '▶'),
              el('div', { className: 'mcm-card-title' }, el('span', null, g.id), el('span', { className: 'mcm-badge brand' }, 'roundrobin/' + g.id)),
              el('span', { className: 'mcm-badge' }, (g.candidates || []).length + ' 候选'),
              el('span', { className: 'mcm-badge' }, g.strategy || 'sticky'),
              el('div', { style: { marginLeft: 'auto', display: 'flex', gap: 6 }, onClick: (e) => e.stopPropagation() },
                btn('⚡测速排序', () => speedtest(g.id), 'primary'),
                st === 'running' ? el('span', { className: 'mcm-badge brand' }, '测速中…') : st === 'sent' ? el('span', { className: 'mcm-badge success' }, '已触发') : null,
                btn('删', () => { if (confirm('删除轮询组 ' + g.id + '?')) props.setChannelsDraft((d) => d.filter((_, gi) => gi !== i)) }, 'danger')
              )
            ),
            isOpen ? el('div', { className: 'mcm-editor' },
              el('div', { className: 'mcm-row' },
                tf('组唯一 ID', '对应虚拟路由 roundrobin/<id>，也是模型选择器里显示的名字（改这里即改名）', g.id || '', (v) => patchGroup(i, { id: v }), true)
              ),
              field('输入模态', '声明虚拟模型接受的输入；不含图片时附加图片会被 host 直接拒绝（MODEL_DOES_NOT_SUPPORT_IMAGES）', false,
                el('div', { style: { display: 'flex', gap: 16, alignItems: 'center', height: 32 } },
                  el('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, opacity: 0.7 } },
                    el('input', { type: 'checkbox', checked: true, disabled: true }),
                    el('span', { style: { fontSize: 12 } }, 'text（固定）')
                  ),
                  el('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' } },
                    el('input', { type: 'checkbox', checked: (vm.input || ['text']).includes('image'), onChange: (e) => patchGroupPath(i, ['virtualModel', 'input'], e.target.checked ? ['text', 'image'] : ['text']) }),
                    el('span', { style: { fontSize: 12 } }, 'image（图片/视觉）')
                  )
                )
              ),
              (g.id && !/^[a-z0-9][a-z0-9-]*$/.test(g.id)) ? el('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 11 } }, '⚠ 组 ID 仅允许小写字母/数字/连字符，且以字母或数字开头；不合法的组保存后会被 host 静默丢弃') : null,
              field('候选渠道池 (按序故障转移)', '首选失败后自动原地重试或切入下一候选', false,
                el('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                  (g.candidates || []).map((c, ci) => el('div', { key: 'cand_' + ci, style: { display: 'flex', gap: 8, alignItems: 'center' } },
                    el('span', { className: 'mcm-badge' }, '#' + (ci + 1)),
                    candidatePicker(providers, c, (nc) => {
                      const curCands = (g.candidates || []).slice()
                      curCands[ci] = nc
                      patchGroup(i, { candidates: curCands })
                    }),
                    btn('✕', () => {
                      const curCands = (g.candidates || []).filter((_, gi) => gi !== ci)
                      patchGroup(i, { candidates: curCands })
                    }, 'danger')
                  )),
                  el('div', { style: { marginTop: 4 } }, btn('＋添加候选', () => {
                    const curCands = (g.candidates || []).concat([{ provider: '', model: '' }])
                    patchGroup(i, { candidates: curCands })
                  }))
                )
              ),
              el('div', { className: 'mcm-row' },
                sel('路由策略', '切换规则', g.strategy || 'sticky', [['sticky', 'Sticky (成功即锁定)'], ['round-robin', 'Round-Robin (轮询均分)'], ['primary', 'Primary (优先首选)']], (v) => patchGroup(i, { strategy: v })),
                nf('超时时间 (ms)', '单候选首响应超时', g.timeoutMs || 30000, (v) => patchGroup(i, { timeoutMs: v })),
                nf('冷却时间 (ms)', '故障后冷却时间', g.cooldownMs || 60000, (v) => patchGroup(i, { cooldownMs: v })),
                nf('单候选重试次数', '冷却前原地退避重试', g.maxRetriesPerCandidate || 0, (v) => patchGroup(i, { maxRetriesPerCandidate: v }))
              ),
              el('div', { style: { borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 12 } },
                el('span', { style: { fontWeight: 600, fontSize: 12, display: 'block', marginBottom: 8 } }, '⚡ 动态测速排序设置'),
                el('div', { className: 'mcm-row' },
                  field('开启自动测速', '请求前测速并按指标自动重排候选', false,
                    el('label', { style: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', height: 34 } },
                      el('input', { type: 'checkbox', checked: stCfg.enabled !== false, onChange: (e) => patchGroupPath(i, ['speedTest', 'enabled'], e.target.checked) }),
                      el('span', null, stCfg.enabled !== false ? '已启用' : '已禁用')
                    )
                  ),
                  sel('排序基准', '排序算法', stCfg.sortKey || 'ttft', [['ttft', 'TTFT 首字延迟优先'], ['latency', 'Total Latency 总延迟优先'], ['hybrid', 'Hybrid 加权混合'], ['smart', 'Smart 智能可靠性平滑']], (v) => patchGroupPath(i, ['speedTest', 'sortKey'], v)),
                  nf('并发测速数', '同时测速线程', stCfg.concurrency || 3, (v) => patchGroupPath(i, ['speedTest', 'concurrency'], v))
                )
              )
            ) : null
          )
        }),
        btn('＋新增轮询组', addGroup, 'primary')
      )
    }

    function HealthPanel(props) {
      const health = props.health
      const providers = props._providers || {}
      const [windowMode, setWindowMode] = useState('30m') // '30m' | '24h' | '7d'

      if (!health) return el('div', { className: 'mcm-empty' }, '健康统计数据准备中…')

      const now = Date.now()
      const windowCutoff = windowMode === '30m' ? now - 30 * 60 * 1000 : windowMode === '24h' ? now - 24 * 3600 * 1000 : 0
      const recsMap = health.records || {}
      const rawEvents = Object.values(recsMap).flat()
      // 时间窗口过滤
      const allEvents = rawEvents.filter((e) => (e.ts || 0) >= windowCutoff)

      // 按 provider 分组
      const byProvider = new Map()

      // 先把用户配置好的所有 providers 和 models 填入字典（确保所有模型都有展示位）
      for (const [pName, pCfg] of Object.entries(providers)) {
        let pMap = byProvider.get(pName)
        if (!pMap) { pMap = new Map(); byProvider.set(pName, pMap) }
        for (const m of (pCfg.models || [])) {
          if (m && m.id) {
            pMap.set(m.id, {
              provider: pName,
              model: m.id,
              name: m.name || m.id,
              total: 0,
              success: 0,
              fail: 0,
              ttftSum: 0,
              latSum: 0,
              lastTs: 0,
              lastOk: null,
              lastCode: null,
              recentErrors: 0
            })
          }
        }
      }

      // 累加时间窗口内的真实流水记录
      for (const e of allEvents) {
        if (!e || !e.provider || !e.model) continue
        let pMap = byProvider.get(e.provider)
        if (!pMap) { pMap = new Map(); byProvider.set(e.provider, pMap) }
        let a = pMap.get(e.model)
        if (!a) {
          a = {
            provider: e.provider,
            model: e.model,
            name: e.model,
            total: 0,
            success: 0,
            fail: 0,
            ttftSum: 0,
            latSum: 0,
            lastTs: 0,
            lastOk: null,
            lastCode: null,
            recentErrors: 0
          }
          pMap.set(e.model, a)
        }
        a.total++
        if (e.ok) {
          a.success++
          if (e.ttftMs != null && e.ttftMs >= 0) a.ttftSum += e.ttftMs
          if (e.latencyMs != null && e.latencyMs >= 0) a.latSum += e.latencyMs
        } else {
          a.fail++
          if (e.code) a.lastCode = e.code
        }
        if ((e.ts || 0) > a.lastTs) {
          a.lastTs = e.ts || 0
          a.lastOk = e.ok
        }
      }

      const totalRequests = allEvents.length
      const totalSuccess = allEvents.filter((x) => x.ok).length
      const globalRate = totalRequests > 0 ? ((totalSuccess / totalRequests) * 100).toFixed(1) + '%' : '100%'
      const validTtfts = allEvents.filter((x) => x.ok && x.ttftMs != null).map((x) => x.ttftMs)
      const avgGlobalTtft = validTtfts.length > 0 ? (validTtfts.reduce((a, b) => a + b, 0) / validTtfts.length / 1000).toFixed(2) + 's' : '—'

      const providerGroups = [...byProvider.entries()].map(([provName, modelMap]) => {
        const models = [...modelMap.values()].map((m) => {
          const rate = m.total > 0 ? m.success / m.total : 1
          // 可用状态判定：基于当前时间窗口与最近调用
          let statusText = '空闲 (未调用)'
          let statusKind = 'idle'
          if (m.total > 0) {
            if (m.lastOk && rate >= 0.8) {
              statusText = '在线可用'
              statusKind = 'ok'
            } else if (rate >= 0.5) {
              statusText = '服务降级 (伴随异常)'
              statusKind = 'warn'
            } else {
              statusText = '不可用 / 服务故障'
              statusKind = 'err'
            }
          }
          return {
            ...m,
            statusText,
            statusKind,
            ratePercent: m.total > 0 ? (rate * 100).toFixed(0) + '%' : '未调用',
            rateValue: rate,
            avgTtft: m.success > 0 && m.ttftSum > 0 ? (m.ttftSum / m.success / 1000).toFixed(2) + 's' : '—',
            avgLat: m.success > 0 && m.latSum > 0 ? (m.latSum / m.success / 1000).toFixed(2) + 's' : '—',
            lastTimeStr: m.lastTs > 0 ? new Date(m.lastTs).toLocaleTimeString() : '无调用记录'
          }
        })
        models.sort((a, b) => (b.total - a.total) || (b.rateValue - a.rateValue))
        const pTotal = models.reduce((acc, m) => acc + m.total, 0)
        const pSuccess = models.reduce((acc, m) => acc + m.success, 0)
        const pRate = pTotal > 0 ? ((pSuccess / pTotal) * 100).toFixed(0) + '%' : '—'
        return { provider: provName, models, total: pTotal, success: pSuccess, rate: pRate }
      })

      providerGroups.sort((a, b) => b.total - a.total)

      return el('div', null,
        el('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 } },
          el('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            el('span', { style: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' } }, '统计时间窗口:'),
            el('div', { className: 'mcm-nav', style: { padding: 2 } },
              el('div', { className: 'mcm-nav-item' + (windowMode === '30m' ? ' active' : ''), style: { padding: '4px 12px', fontSize: 11 }, onClick: () => setWindowMode('30m') }, '🟢 近 30 分钟 (实时探针)'),
              el('div', { className: 'mcm-nav-item' + (windowMode === '24h' ? ' active' : ''), style: { padding: '4px 12px', fontSize: 11 }, onClick: () => setWindowMode('24h') }, '🟡 近 24 小时'),
              el('div', { className: 'mcm-nav-item' + (windowMode === '7d' ? ' active' : ''), style: { padding: '4px 12px', fontSize: 11 }, onClick: () => setWindowMode('7d') }, '🔵 近 7 天全量')
            )
          ),
          el('div', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--dsw-alias-state-success-primary)' } },
            el('span', { className: 'mcm-status-dot ok' }),
            el('span', null, '前台 5s 自动刷新流')
          )
        ),
        el('div', { className: 'mcm-metrics-grid' },
          el('div', { className: 'mcm-metric-card' },
            el('span', { className: 'mcm-metric-label' }, windowMode === '30m' ? '近 30 分钟请求' : windowMode === '24h' ? '近 24 小时请求' : '7 天全周期请求'),
            el('span', { className: 'mcm-metric-value' }, totalRequests),
            el('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, '真实上游交互捕获')
          ),
          el('div', { className: 'mcm-metric-card' },
            el('span', { className: 'mcm-metric-label' }, '窗口可用率'),
            el('span', { className: 'mcm-metric-value', style: { color: totalSuccess === totalRequests ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-primary)' } }, globalRate),
            el('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, totalSuccess + ' 成功 / ' + (totalRequests - totalSuccess) + ' 异常')
          ),
          el('div', { className: 'mcm-metric-card' },
            el('span', { className: 'mcm-metric-label' }, '平均首 Token 延迟 (TTFT)'),
            el('span', { className: 'mcm-metric-value' }, avgGlobalTtft),
            el('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, '首字响应速度均值')
          )
        ),
        providerGroups.length === 0 ? el('div', { className: 'mcm-empty' }, '暂无已配置供应商或调用记录') :
        providerGroups.map((pg) => el('div', { className: 'mcm-card', key: pg.provider, style: { marginBottom: 16 } },
          el('div', { style: { padding: '12px 16px', background: 'var(--dsw-alias-bg-layer-2)', borderBottom: '1px solid var(--dsw-alias-border-l1)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
            el('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
              el('span', { className: 'mcm-badge brand', style: { fontSize: 12, padding: '3px 10px' } }, pg.provider),
              el('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, pg.models.length + ' 个模型')
            ),
            el('div', { style: { display: 'flex', gap: 12, fontSize: 12 } },
              el('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, '窗口调用: ', el('strong', { style: { color: 'var(--dsw-alias-label-primary)' } }, pg.total)),
              el('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, '可用率: ', el('strong', { style: { color: 'var(--dsw-alias-state-success-primary)' } }, pg.rate))
            )
          ),
          el('div', { style: { padding: 12 }, className: 'mcm-health-grid' },
            pg.models.map((m) => el('div', { className: 'mcm-health-card', key: pg.provider + '::' + m.model, style: { background: 'var(--dsw-alias-bg-layer-1)' } },
              el('div', { className: 'mcm-health-card-h' },
                el('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                  el('span', {
                    className: 'mcm-status-dot ' + (m.statusKind === 'idle' ? 'idle' : m.statusKind === 'ok' ? 'ok' : 'err'),
                    style: m.statusKind === 'idle' ? { background: 'var(--dsw-alias-label-tertiary)' } : m.statusKind === 'warn' ? { background: 'var(--dsw-alias-state-warn-primary)' } : {}
                  }),
                  el('span', { style: { fontWeight: 600, fontSize: 13, fontFamily: 'var(--ds-font-family-code)' } }, m.model)
                ),
                el('span', {
                  className: 'mcm-badge ' + (m.statusKind === 'ok' ? 'success' : m.statusKind === 'warn' ? 'brand' : m.statusKind === 'err' ? 'error' : '')
                }, m.statusText)
              ),
              el('div', null,
                el('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginBottom: 3 } },
                  el('span', null, '可用率: ', el('strong', { style: { color: m.total === 0 ? 'var(--dsw-alias-label-tertiary)' : m.rateValue >= 0.8 ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)' } }, m.ratePercent)),
                  el('span', null, m.total === 0 ? '0 请求' : el('span', null, el('span', { style: { color: 'var(--dsw-alias-state-success-primary)' } }, '✓' + m.success), ' / ', el('span', { style: { color: m.fail > 0 ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-tertiary)' } }, '✗' + m.fail)))
                ),
                el('div', { className: 'mcm-meter' },
                  el('div', { className: 'mcm-meter-fill ' + (m.total === 0 ? 'idle' : m.rateValue >= 0.9 ? '' : m.rateValue >= 0.7 ? 'warn' : 'danger'), style: { width: m.total === 0 ? '0%' : (m.rateValue * 100) + '%', background: m.total === 0 ? 'var(--dsw-alias-border-l2)' : undefined } })
                )
              ),
              el('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 8 } },
                el('span', null, 'TTFT: ', el('strong', { style: { color: 'var(--dsw-alias-label-primary)' } }, m.avgTtft)),
                el('span', null, '最近: ', el('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, m.lastTimeStr))
              )
            ))
          )
        ))
      )
    }

    function ModelConfigView() {
      const [state, setState] = useState(null)
      const [draft, setDraft] = useState(null)
      const [notice, setNotice] = useState(null)
      const [saving, setSaving] = useState(false)
      const [tab, setTab] = useState('config')

      const renameProviderInChannels = (oldId, newId) => {
        setChannelsDraft((d) => (d || []).map((g) => {
          const cands = (g.candidates || []).map((c) => (c && c.provider === oldId) ? Object.assign({}, c, { provider: newId }) : c)
          return Object.assign({}, g, { candidates: cands })
        }))
      }
      const [channels, setChannels] = useState(null)
      const [channelsDraft, setChannelsDraft] = useState(null)
      const [health, setHealth] = useState(null)

      const unwrap = (resp) => {
        const r = resp && resp.result ? resp.result : resp
        if (r && r.ok === false) throw new Error((r.error && (r.error.message || r.error)) || 'request failed')
        return r && r.value !== undefined ? r.value : r
      }

      // 按持久化的 providerOrder 重排 providers 的键序：settings-file 的 patchNode
      // 对 map 键序盲（拖拽纯重排在文件层是零 diff），顺序由 model-channels ns 里的
      // providerOrder 数组携带（数组 wholesale replace 真实落盘）。未列出的 provider
      // append 在后（保持文件键序），防止 providerOrder 过期时丢供应商。
      const applyProviderOrder = (providers, order) => {
        if (!providers || !Array.isArray(order) || order.length === 0) return providers
        const known = new Set(Object.keys(providers))
        const ranked = order.filter((k) => known.has(k))
        if (ranked.length === 0) return providers
        const rest = Object.keys(providers).filter((k) => !ranked.includes(k))
        const out = {}
        for (const k of ranked.concat(rest)) out[k] = providers[k]
        return out
      }

      const refresh = () => {
        if (!apiRef) return
        apiRef.settings.describe({}).then((resp) => {
          const d = unwrap(resp)
          const nss = (d && d.namespaces) || []
          const findNs = (name) => nss.find((n) => n && n.ns === name)
          const ns = findNs('llm-pi-ai')
          const cn = findNs('model-channels')
          const savedOrder = (cn && cn.value && Array.isArray(cn.value.providerOrder)) ? cn.value.providerOrder : null
          const providers = applyProviderOrder((ns && ns.value && ns.value.providers) || {}, savedOrder)
          // user 层 = 仅用户手工声明的路由（用于真正删除与重排序的 mutate 依据）
          const userProviders = (ns && ns.user && ns.user.providers) || {}
          setState({ providers, userProviders, providerOrder: savedOrder || [] })
          setDraft((prev) => prev || clone(providers))
          const ch = (cn && cn.value && cn.value.groups) || []
          setChannels(ch)
          setChannelsDraft((prev) => prev || clone(ch))
          const hn = findNs('model-channel-health')
          setHealth(hn ? { records: (hn.value && hn.value.records) || {}, speedResults: (hn.value && hn.value.speedResults) || {}, runtime: (hn.value && hn.value.runtime) || {} } : null)
        }).catch((e) => setNotice('加载失败: ' + String(e)))
      }

      useEffect(() => {
        refresh()
      }, [])
      // 健康页签激活时才 5s 静默轮询（仅拉健康命名空间），切走即停，避免后台常驻全量 describe
      useEffect(() => {
        if (tab !== 'health') return
        const pull = () => {
          if (!apiRef) return
          apiRef.settings.describe({}).then((resp) => {
            const d = unwrap(resp)
            const hn = ((d && d.namespaces) || []).find((n) => n && n.ns === 'model-channel-health')
            if (hn && hn.value) {
              setHealth({
                records: hn.value.records || {},
                speedResults: hn.value.speedResults || {},
                runtime: hn.value.runtime || {}
              })
            }
          }).catch(() => {})
        }
        pull()
        const timer = setInterval(pull, 5000)
        return () => clearInterval(timer)
      }, [tab])

      const save = () => {
        if (!apiRef) return
        setSaving(true)
        setNotice(null)
        // Compat 全量透传：rc.2 PiAiCompatProfile 的 20 个字段全部真实生效——此前
        // 白名单净化（仅 thinkingFormat/supportsReasoningEffort）把用户配置的角色
        // 模板类字段（thinkingFormat:chat-template / chatTemplateKwargs /
        // requiresThinkingAsText 等）在每次保存时剥掉，上游报 400 角色信息不正确
        // （Ark 1214）。现仅剔除：空串/null（「— 默认 —」语义）与枚举非法值；
        // 其余键全量保留（真遇到 schema 不认的键会大声失败而不是静默丢弃）。
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
        const cleanProviders = {}
        if (draft) {
          for (const [pKey, pVal] of Object.entries(draft)) {
            if (!pKey || !pVal) continue
            const cleanModels = (pVal.models || []).filter((m) => m && m.id && String(m.id).trim().length > 0).map((m) => {
              // 同样保留模型级未知字段（面板外 schema 合法键），仅清洗/覆盖面板管理的
              const cleaned = Object.assign({}, m)
              cleaned.id = String(m.id).trim()
              if (cleaned.name != null && String(cleaned.name).trim() === '') delete cleaned.name
              if (!(Number.isFinite(cleaned.contextWindow) && cleaned.contextWindow > 0)) delete cleaned.contextWindow
              if (!(Number.isFinite(cleaned.maxTokens) && cleaned.maxTokens > 0)) delete cleaned.maxTokens
              if (Array.isArray(cleaned.input) && cleaned.input.length > 0) cleaned.input = cleaned.input.slice()
              else delete cleaned.input
              if (cleaned.reasoningEfforts != null && typeof cleaned.reasoningEfforts === 'object' && Object.keys(cleaned.reasoningEfforts).length > 0) cleaned.reasoningEfforts = Object.assign({}, cleaned.reasoningEfforts)
              else delete cleaned.reasoningEfforts
              const mc = cleanCompat(cleaned.compat)
              if (mc) cleaned.compat = mc
              else delete cleaned.compat
              return cleaned
            })
            const pObj = Object.assign({}, pVal)
            pObj.api = pVal.api || 'openai-completions'
            pObj.models = cleanModels
            if (!(pVal.baseURL && String(pVal.baseURL).trim())) delete pObj.baseURL
            else pObj.baseURL = String(pVal.baseURL).trim()
            if (!(pVal.displayName && String(pVal.displayName).trim())) delete pObj.displayName
            else pObj.displayName = String(pVal.displayName).trim()
            const apiKeyEnvVal = normalizeCredentialRef(pVal.apiKeyEnv || '')
            if (apiKeyEnvVal) pObj.apiKeyEnv = apiKeyEnvVal
            else delete pObj.apiKeyEnv
            // 请求头原样保存（默认头仅在新建供应商时注入一次），编辑器里删除即真实生效；
            // 仅剔除空键与 User-Agent（pi-ai 会用 deepseek-harness 归属 UA 强制覆盖，自定义是死数据）
            const hdrs = {}
            for (const [hk, hv] of Object.entries((pVal.headers && typeof pVal.headers === 'object') ? pVal.headers : {})) {
              const hk2 = String(hk).trim()
              if (!hk2 || hk2.toLowerCase() === 'user-agent') continue
              hdrs[hk2] = String(hv)
            }
            if (Object.keys(hdrs).length > 0) pObj.headers = hdrs
            else delete pObj.headers
            const pc = cleanCompat(pVal.compat)
            if (pc) pObj.compat = pc
            else delete pObj.compat
            if (pVal.transport) pObj.transport = pVal.transport
            else delete pObj.transport
            if (pVal.cacheRetention) pObj.cacheRetention = pVal.cacheRetention
            else delete pObj.cacheRetention
            if (Number.isFinite(pVal.timeoutMs) && pVal.timeoutMs > 0) pObj.timeoutMs = pVal.timeoutMs
            else delete pObj.timeoutMs
            if (Number.isFinite(pVal.streamIdleTimeoutMs) && pVal.streamIdleTimeoutMs > 0) pObj.streamIdleTimeoutMs = pVal.streamIdleTimeoutMs
            else delete pObj.streamIdleTimeoutMs
            if (Number.isFinite(pVal.websocketConnectTimeoutMs) && pVal.websocketConnectTimeoutMs > 0) pObj.websocketConnectTimeoutMs = pVal.websocketConnectTimeoutMs
            else delete pObj.websocketConnectTimeoutMs
            if (Number.isSafeInteger(pVal.defaultContextWindow) && pVal.defaultContextWindow > 0) pObj.defaultContextWindow = pVal.defaultContextWindow
            else delete pObj.defaultContextWindow
            if (Number.isSafeInteger(pVal.defaultMaxTokens) && pVal.defaultMaxTokens > 0) pObj.defaultMaxTokens = pVal.defaultMaxTokens
            else delete pObj.defaultMaxTokens
            if (pVal.reasoning) pObj.reasoning = pVal.reasoning
            else delete pObj.reasoning
            if (Number.isSafeInteger(pVal.requestImagePixelBudget) && pVal.requestImagePixelBudget > 0) pObj.requestImagePixelBudget = pVal.requestImagePixelBudget
            else delete pObj.requestImagePixelBudget
            if (Number.isSafeInteger(pVal.requestImageMaxBytes) && pVal.requestImageMaxBytes > 0) pObj.requestImageMaxBytes = pVal.requestImageMaxBytes
            else delete pObj.requestImageMaxBytes
            cleanProviders[pKey] = pObj
          }
        }
        // llm-pi-ai 用 mutate path-ops 提交：
        //  - settings.update 是 merge 语义：已存在键保序（无法表达拖拽重排）
        //  - settings.replace 会整体重建（官方不建议持有脱敏视图时使用）
        //  - mutate：先 unset 全部旧键（含删除项），再按最终顺序 set → 键序即持久化顺序
        const p1 = draft ? (() => {
          const keys = Object.keys(cleanProviders)
          // 用 resolved 键集（state.providers）而非 user 层（state.userProviders）作为 unset 依据：
          // 面板展示/编辑的正是 resolved 视图，user 层可能为空或与展示不一致，漏 unset 会导致
          // 删除/改名失效（旧键残留）与排序无效。
          const storedKeys = Object.keys((state && (state.providers || state.userProviders)) || {})
          const ops = []
          const allKeys = Array.from(new Set([...storedKeys, ...keys]))
          for (const k of allKeys) ops.push({ op: 'unset', path: ['providers', k] })
          for (const k of keys) ops.push({ op: 'set', path: ['providers', k], value: cleanProviders[k] })
          if (ops.length === 0) return Promise.resolve()
          return apiRef.settings.mutate({ ns: 'llm-pi-ai', ops }).then((resp) => {
            const r = resp && resp.result ? resp.result : resp
            if (r && r.ok === false) throw new Error((r.error && (r.error.message || r.error)) || 'llm-pi-ai save failed')
            return r
          })
        })() : Promise.resolve()
        // 顺序持久化：patchNode 对 map 键序盲，拖拽顺序写进 providerOrder 数组（同一次 update 落盘）；
        // 即使 channelsDraft 为空（无轮询组），只要 draft 非空也要写——这是排序的唯二持久化时机
        const orderPatch = draft ? { providerOrder: Object.keys(cleanProviders) } : {}
        const p2 = apiRef.settings.update({
          ns: 'model-channels',
          // 命名单一身份：写入时统一 virtualModel.name = 组 id——旧的独立呈现名
          // （如遗留的 group-1）在下一次保存时自动归一，无需迁移
          patch: Object.assign({ groups: (channelsDraft || []).map((g) => Object.assign({}, g, { virtualModel: Object.assign({}, g.virtualModel, { name: g.id }) })) }, orderPatch)
        }).then((resp) => {
          const r = resp && resp.result ? resp.result : resp
          if (r && r.ok === false) throw new Error((r.error && (r.error.message || r.error)) || 'model-channels save failed')
          return r
        })
        Promise.all([p1, p2]).then(() => {
          setNotice('已全部保存（即时生效）')
          // 同步草稿与状态为刚保存的清洗版本（含默认请求头合并结果）
          setDraft(clone(cleanProviders))
          setState((s) => Object.assign({}, s, { providers: cleanProviders, userProviders: cleanProviders, providerOrder: Object.keys(cleanProviders) }))
          setTimeout(() => setNotice(null), 3000)
          refresh()
        }).catch((e) => setNotice('保存失败: ' + String((e && e.message) || e))).finally(() => setSaving(false))
      }

      return el('div', { className: 'mcm-root' },
        el('div', { className: 'mcm-header' },
          el('div', { className: 'mcm-nav' },
            el('div', { className: 'mcm-nav-item' + (tab === 'config' ? ' active' : ''), onClick: () => setTab('config') }, '提供商与模型'),
            el('div', { className: 'mcm-nav-item' + (tab === 'roundrobin' ? ' active' : ''), onClick: () => setTab('roundrobin') }, '故障转移轮询组'),
            el('div', { className: 'mcm-nav-item' + (tab === 'health' ? ' active' : ''), onClick: () => setTab('health') }, '全局健康统计')
          ),
          el('div', { className: 'mcm-actions' },
            notice ? el('span', { style: { fontSize: 12, color: notice.includes('失败') ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)' } }, notice) : null,
            btn('刷新', refresh),
            btn(saving ? '保存中…' : '保存全部变更', save, 'primary')
          )
        ),
        el('div', { className: 'mcm-body' },
          tab === 'config' ? el(ModelConfigPanel, { _state: state, _draft: draft, _setDraft: setDraft, _setNotice: setNotice, _renameProviderInChannels: renameProviderInChannels }) :
          tab === 'roundrobin' ? el(RoundrobinPanel, { channels, channelsDraft, setChannelsDraft, _providers: (draft || (state ? state.providers : {})) }) :
          el(HealthPanel, { health, _providers: (draft || (state ? state.providers : {})) })
        )
      )
    }


    function apply(ctx) {
      const connection = ctx.get('connection')
      apiRef = connection && connection.api ? connection.api : null
      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.mcmStyle = ''
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => tag.remove()
      }, 'model-config: styles')
      const slots = ctx.get('slots')
      if (!slots) return
      // 会话模型选择器（conversation.input.model 座位遮蔽）已拆出为独立插件
      // @arcaneorion/dsh-model-selector-search——一个占座者一个插件单元，可独立启停/替换；
      // 本插件禁用/卸载不再影响选择器，反之亦然。座位契约（priority -1 + inject face）见该仓。
      slots.inject('conversation.view', () => slots.register(
        { name: 'conversation.view', id: 'models', order: 25, label: '模型配置' },
        (p) => el(ModelConfigView, p)
      ))
    }

    return { name: 'model-channel-manager', inject: ['slots', 'connection'], apply }
  },
})
