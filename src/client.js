/** @arcaneorion/dsh-model-channel-manager — client 半（现代化设计版）。
 * 遵循 DSH 规范：inject ["slots","connection"]，
 * apply(ctx) 捕获 ctx.get("connection").api，组件经闭包使用。
 * 数据通道 = api.settings / api.llm / api.credentials（公共 seam，无私有 RPC）。
 */
window.__ModuleLoader__.load({
  id: '@arcaneorion/dsh-model-channel-manager',
  factory: (require) => {
    const { createElement: el, useState, useEffect } = require('react')
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
    const APIS = ['openai-completions', 'openai-responses', 'anthropic-messages']
    const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
    const TF = ['openai', 'deepseek', 'openrouter', 'together', 'zai', 'qwen', 'chat-template', 'qwen-chat-template', 'string-thinking', 'ant-ling']
    const MTF = ['max_completion_tokens', 'max_tokens']
    const TRANSPORTS = ['sse', 'websocket', 'websocket-cached', 'auto']
    const CACHE = ['none', 'short', 'long']
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

    function compatEditor(compat, onSet) {
      const c = compat || {}
      const setB = (k, v) => onSet(Object.assign({}, c, { [k]: v }))
      const setS = (k, v) => onSet(Object.assign({}, c, { [k]: v }))
      const bF = (k, d) => el('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
        el('label', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }, title: d }, k),
        el('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer', height: 28, fontSize: 12 } },
          el('input', { type: 'checkbox', checked: !!c[k], onChange: (e) => setB(k, e.target.checked) }),
          c[k] ? '✓ 开' : '关'
        )
      )
      const sF = (k, opts, d) => el('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
        el('label', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }, title: d }, k),
        el('select', { className: 'mcm-in', style: { height: 28, fontSize: 12 }, value: c[k] || '', onChange: (e) => setS(k, e.target.value) },
          el('option', { value: '' }, '— 默认 —'),
          ...opts.map((o) => el('option', { key: o, value: o }, o))
        )
      )
      return el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10, padding: '8px 0' } },
        sF('thinkingFormat', TF, '推理调度格式'),
        sF('maxTokensField', MTF, '最大输出 token 字段名'),
        bF('supportsReasoningEffort', '支持 reasoning_effort 字段'),
        bF('supportsDeveloperRole', '支持 developer role (OpenAI 新格式)'),
        bF('supportsStore', '支持 store 参数'),
        bF('supportsUsageInStreaming', '流式分片中包含 usage'),
        bF('supportsLongCacheRetention', '支持长周期 Prompt 缓存'),
        bF('supportsEagerToolInputStreaming', '工具调用流式输入'),
        bF('supportsTemperature', '支持自定义 temperature'),
        bF('forceAdaptiveThinking', '强制自适应思考'),
        bF('allowEmptySignature', '允许空签名'),
        bF('supportsStrictMode', '支持 strict 模式'),
        bF('supportsStrictTools', '支持 strict tools'),
        bF('supportsCacheControlOnTools', '支持对工具参数增加缓存控制'),
        bF('requiresToolResultName', '工具返回需携带 name'),
        bF('requiresAssistantAfterToolResult', '工具返回后紧跟 assistant 角色'),
        bF('requiresThinkingAsText', '思考过程作为纯文本消息传递'),
        bF('requiresReasoningContentOnAssistantMessages', 'assistant 消息需携带 reasoning_content'),
        sF('cacheControlFormat', ['anthropic'], '缓存控制协议规范')
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

    function fetchModal(name, p, disc, setDisc, onApply) {
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
          btn('重新尝试', () => { setDisc({ provider: name, loading: true }); doFetch(name, p, setDisc, keyInput[name]) }, 'primary')
        )
      } else {
        const d = disc
        const all = [
          ...d.missing.map((id) => ({ id, tag: 'add', txt: '+ 可添加' })),
          ...d.configured.map((id) => ({ id, tag: 'ok', txt: '✓ 已配置' })),
          ...d.stale.map((id) => ({ id, tag: 'stale', txt: '! 端点已下线' }))
        ]
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
          el('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, '说明：勾选 = 保留或添加；取消勾选 = 删除。已配置项默认勾选。'),
          el('div', { style: { maxHeight: 300, overflowY: 'auto', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1)' } },
            all.length === 0 ? el('div', { className: 'mcm-empty' }, '端点未返回任何可用模型') :
            all.map((item) => {
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
      const [exp, setExp] = useState({}); const [em, setEm] = useState({}); const [live, setLive] = useState({})
      const [sa, setSa] = useState({})
      const [keyInput, setKeyInput] = useState({})
      const [testStates, setTestStates] = useState({})
      const [detailWin, setDetailWin] = useState(null)
      const [configWin, setConfigWin] = useState(false)
      const [disc, setDisc] = useState(null)
      const providers = draft || {}

      const pollTest = (nonce, provider, model) => {
        if (!apiRef) return
        apiRef.settings.describe({}).then((resp) => {
          const r = resp && resp.result ? resp.result : resp
          const d = r && r.value !== undefined ? r.value : r
          const ns = ((d && d.namespaces) || []).find((n) => n && n.ns === 'model-channel-health')
          const tr = (ns && ns.value && ns.value.testResults) || {}
          const e = tr[nonce]
          const key = provider + '::' + model
          if (e && (e.status === 'ok' || e.status === 'error')) {
            setTestStates((s) => Object.assign({}, s, { [key]: e }))
          } else {
            setTimeout(() => pollTest(nonce, provider, model), 1200)
          }
        }).catch(() => setTimeout(() => pollTest(nonce, provider, model), 1500))
      }

      const launchTest = (provider, model) => {
        // 如果当前 draft 还没有点击保存，则向用户友好提示
        const currentSavedModels = (props._state?.providers?.[provider]?.models || []).map((m) => m.id)
        if (!currentSavedModels.includes(model)) {
          setNotice('请先点击右上角「保存全部变更」，保存后方可进行真实链路测试')
          setTimeout(() => setNotice(null), 4000)
        }
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

      const cards = Object.entries(providers).map(([name, p]) => {
        const isOpen = !!exp[name]
        const models = p.models || []
        const currentName = p.displayName !== undefined ? p.displayName : name
        return el('div', { className: 'mcm-card', key: name },
          el('div', { className: 'mcm-card-h', onClick: () => setExp((e) => Object.assign({}, e, { [name]: !e[name] })) },
            el('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, isOpen ? '▼' : '▶'),
            el('div', { className: 'mcm-card-title' }, el('span', null, p.displayName || name), el('span', { className: 'mcm-badge brand' }, name)),
            p.api ? el('span', { className: 'mcm-badge' }, p.api) : null,
            el('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', marginLeft: 'auto' } }, models.length + ' 个模型'),
            el('div', { style: { display: 'flex', gap: 6, marginLeft: 12 }, onClick: (e) => e.stopPropagation() },
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
                field('供应商级 Compat 兼容选项', '端点级 API 行为修正', false, compatEditor(p.compat, (v) => updateP(name, { compat: v })))
              ) : null
            ),
            el('div', { style: { marginTop: 8 } },
              el('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 } },
                el('span', { style: { fontWeight: 600, fontSize: 13 } }, '模型列表 (' + models.length + ')'),
                el('div', { style: { display: 'flex', gap: 6 } },
                  btn('🔍 拉取上游模型', () => { setDisc({ provider: name, loading: true }); doFetch(name, p, setDisc, keyInput[name]) }, 'primary'),
                  btn('＋添加模型', () => updateP(name, { models: models.concat([{ id: '', name: '', contextWindow: 1048576, maxTokens: 131072, input: ['text', 'image'], reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } }]) }))
                )
              ),
              fetchModal(name, p, disc, setDisc, (ids) => {
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
              }),
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
                      em['cx_' + name + '_' + mi] ? el('div', { style: { marginTop: 8 } }, compatEditor(m.compat, (v) => updateModel(name, mi, { compat: v }))) : null
                    )
                  ) : null
                )
              })
            )
          ) : null
        )
      })

      return el('div', null,
        el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 } },
          el('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, '已配置 ' + Object.keys(providers).length + ' 个提供商'),
          btn('⚙️ 配置全局测试参数', () => setConfigWin(true))
        ),
        ...cards,
        btn('＋新增提供商 (Provider)', () => {
          const nm = 'provider-' + (Object.keys(providers).length + 1)
          setDraft((d) => Object.assign({}, d || {}, { [nm]: { api: 'openai-completions', baseURL: '', apiKeyEnv: nm.toUpperCase() + '_API_KEY', displayName: nm, models: [] } }))
          setExp((e) => Object.assign({}, e, { [nm]: true }))
        }, 'primary'),
        el(GlobalTestConfigModal, { win: configWin, setWin: setConfigWin }),
        el(TestResultDetailModal, { win: detailWin, setWin: setDetailWin })
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

      const addGroup = () => props.setChannelsDraft((d) => (d || []).concat([{
        id: 'group-' + ((d || []).length + 1),
        virtualModel: { name: 'RoundRobin', reasoning: true, input: ['text'], contextWindow: 1048576, maxTokens: 131072 },
        candidates: [],
        strategy: 'sticky',
        timeoutMs: 30000,
        cooldownMs: 60000,
        maxRetriesPerCandidate: 2,
        speedTest: { enabled: false, sortKey: 'ttft', prompt: '欧拉函数的意义？', maxTokens: 2048, timeoutMs: 60000, concurrency: 3, minIntervalMs: 60000, retries: 2 }
      }]))

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
              el('div', { className: 'mcm-card-title' }, el('span', null, vm.name || g.id), el('span', { className: 'mcm-badge brand' }, 'roundrobin/' + g.id)),
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
                tf('组唯一 ID', '对应虚拟路由 roundrobin/<id>', g.id || '', (v) => patchGroup(i, { id: v }), true),
                tf('虚拟模型呈现名', '对话侧栏显示的名字', vm.name || '', (v) => patchGroupPath(i, ['virtualModel', 'name'], v))
              ),
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
      const [channels, setChannels] = useState(null)
      const [channelsDraft, setChannelsDraft] = useState(null)
      const [health, setHealth] = useState(null)

      const unwrap = (resp) => {
        const r = resp && resp.result ? resp.result : resp
        if (r && r.ok === false) throw new Error((r.error && (r.error.message || r.error)) || 'request failed')
        return r && r.value !== undefined ? r.value : r
      }

      const refresh = () => {
        if (!apiRef) return
        apiRef.settings.describe({}).then((resp) => {
          const d = unwrap(resp)
          const nss = (d && d.namespaces) || []
          const findNs = (name) => nss.find((n) => n && n.ns === name)
          const ns = findNs('llm-pi-ai')
          const providers = (ns && ns.value && ns.value.providers) || {}
          setState({ providers })
          setDraft((prev) => prev || clone(providers))
          const cn = findNs('model-channels')
          const ch = (cn && cn.value && cn.value.groups) || []
          setChannels(ch)
          setChannelsDraft((prev) => prev || clone(ch))
          const hn = findNs('model-channel-health')
          setHealth(hn ? { records: (hn.value && hn.value.records) || {}, speedResults: (hn.value && hn.value.speedResults) || {}, runtime: (hn.value && hn.value.runtime) || {} } : null)
        }).catch((e) => setNotice('加载失败: ' + String(e)))
      }

      useEffect(() => {
        refresh()
        // 前台 5 秒静默自动轮询，保持数据完全实时流动
        const timer = setInterval(() => {
          if (apiRef) {
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
        }, 5000)
        return () => clearInterval(timer)
      }, [])

      const save = () => {
        if (!apiRef) return
        setSaving(true)
        setNotice(null)
        // 自动清洗 draft 中的非法或空字段，保证完全满足 dsh-llm-pi-ai schema
        const cleanProviders = {}
        if (draft) {
          for (const [pKey, pVal] of Object.entries(draft)) {
            if (!pKey || !pVal) continue
            const cleanModels = (pVal.models || []).filter((m) => m && m.id && String(m.id).trim().length > 0).map((m) => {
              const cleaned = { id: String(m.id).trim() }
              if (m.name && String(m.name).trim()) cleaned.name = String(m.name).trim()
              if (Number.isFinite(m.contextWindow) && m.contextWindow > 0) cleaned.contextWindow = m.contextWindow
              if (Number.isFinite(m.maxTokens) && m.maxTokens > 0) cleaned.maxTokens = m.maxTokens
              if (Array.isArray(m.input) && m.input.length > 0) cleaned.input = m.input.slice()
              if (m.reasoningEfforts && typeof m.reasoningEfforts === 'object') cleaned.reasoningEfforts = Object.assign({}, m.reasoningEfforts)
              if (m.compat && typeof m.compat === 'object' && Object.keys(m.compat).length > 0) cleaned.compat = Object.assign({}, m.compat)
              return cleaned
            })
            const pObj = {
              api: pVal.api || 'openai-completions',
              models: cleanModels
            }
            if (pVal.baseURL && String(pVal.baseURL).trim()) pObj.baseURL = String(pVal.baseURL).trim()
            if (pVal.displayName && String(pVal.displayName).trim()) pObj.displayName = String(pVal.displayName).trim()
            if (pVal.apiKeyEnv && String(pVal.apiKeyEnv).trim()) pObj.apiKeyEnv = String(pVal.apiKeyEnv).trim()
            if (pVal.headers && typeof pVal.headers === 'object' && Object.keys(pVal.headers).length > 0) pObj.headers = Object.assign({}, pVal.headers)
            if (pVal.compat && typeof pVal.compat === 'object' && Object.keys(pVal.compat).length > 0) pObj.compat = Object.assign({}, pVal.compat)
            if (pVal.transport) pObj.transport = pVal.transport
            if (pVal.cacheRetention) pObj.cacheRetention = pVal.cacheRetention
            if (Number.isFinite(pVal.timeoutMs) && pVal.timeoutMs > 0) pObj.timeoutMs = pVal.timeoutMs
            if (Number.isFinite(pVal.streamIdleTimeoutMs) && pVal.streamIdleTimeoutMs > 0) pObj.streamIdleTimeoutMs = pVal.streamIdleTimeoutMs
            if (Number.isFinite(pVal.websocketConnectTimeoutMs) && pVal.websocketConnectTimeoutMs > 0) pObj.websocketConnectTimeoutMs = pVal.websocketConnectTimeoutMs
            cleanProviders[pKey] = pObj
          }
        }
        const p1 = draft ? apiRef.settings.update({ ns: 'llm-pi-ai', patch: { providers: cleanProviders } }).then((resp) => {
          const r = resp && resp.result ? resp.result : resp
          if (r && r.ok === false) throw new Error((r.error && (r.error.message || r.error)) || 'llm-pi-ai save failed')
          return r
        }) : Promise.resolve()
        const p2 = channelsDraft ? apiRef.settings.update({ ns: 'model-channels', patch: { groups: channelsDraft } }).then((resp) => {
          const r = resp && resp.result ? resp.result : resp
          if (r && r.ok === false) throw new Error((r.error && (r.error.message || r.error)) || 'model-channels save failed')
          return r
        }) : Promise.resolve()
        Promise.all([p1, p2]).then(() => {
          setNotice('已全部保存（即时生效）')
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
          tab === 'config' ? el(ModelConfigPanel, { _state: state, _draft: draft, _setDraft: setDraft }) :
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
      slots.inject('conversation.view', () => slots.register(
        { name: 'conversation.view', id: 'models', order: 25, label: '模型配置' },
        (p) => el(ModelConfigView, p)
      ))
    }

    return { name: 'model-channel-manager', inject: ['slots', 'connection'], apply }
  },
})
