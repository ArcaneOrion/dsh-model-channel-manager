/** @arcaneorion/dsh-model-channel-manager — client 半（静态 bundle v5）。
 * 照 shipped settings-models 同款模式：inject ["slots","connection"]，
 * apply(ctx) 里 ctx.get("connection").api 捕获 api，组件经闭包使用。
 * 数据通道 = api.settings / api.llm / api.credentials（公共 seam，无 RPC）。
 */
window.__ModuleLoader__.load({
  id: '@arcaneorion/dsh-model-channel-manager',
  factory: (require) => {
    const { createElement: el, useState, useEffect } = require('react')
    let apiRef = null

    const CSS = `
.mcm-root { display:flex; flex-direction:column; height:100%; overflow:hidden; font-size:14px; color:var(--dsw-alias-label-primary); }
.mcm-tabs { display:flex; gap:0; border-bottom:1px solid var(--dsw-alias-border-l2); flex-shrink:0; padding:0 16px; }
.mcm-tab { padding:8px 16px; font-size:13px; font-weight:500; color:var(--dsw-alias-label-tertiary); cursor:pointer; border-bottom:2px solid transparent; }
.mcm-tab:hover { color:var(--dsw-alias-label-secondary); }
.mcm-tab.active { color:var(--dsw-alias-brand-primary); border-bottom-color:var(--dsw-alias-brand-primary); }
.mcm-tab-right { margin-left:auto; display:flex; align-items:center; gap:6px; padding:4px 0; }
.mcm-btn { box-sizing:border-box; height:28px; border:1px solid var(--dsw-alias-border-l2); background:transparent; color:var(--dsw-alias-label-primary); border-radius:14px; padding:0 12px; font-size:12px; cursor:pointer; font:inherit; display:inline-flex; align-items:center; gap:4px; }
.mcm-btn:hover { background:var(--dsw-alias-interactive-bg-hover); }
.mcm-btn.primary { background:var(--dsw-alias-button-primary-fill); color:var(--dsw-alias-label-primary-foreground); border:none; }
.mcm-btn.primary:hover { background:var(--dsw-alias-button-primary-hover); }
.mcm-btn.danger { color:var(--dsw-alias-state-error-primary); }
.mcm-btn.danger:hover { background:var(--dsw-alias-interactive-bg-hover-danger); }
.mcm-body { flex:1; overflow-y:auto; padding:16px 20px 60px; }
.mcm-notice { font-size:12px; color:var(--dsw-alias-label-tertiary); }
.mcm-notice.ok { color:var(--dsw-alias-state-success-primary); }
.mcm-notice.err { color:var(--dsw-alias-state-error-primary); }
.mcm-card { border:1px solid var(--dsw-alias-border-l2); border-radius:12px; margin-bottom:8px; overflow:hidden; }
.mcm-card-h { display:flex; align-items:center; gap:10px; padding:10px 14px; cursor:pointer; }
.mcm-card-h:hover { background:var(--dsw-alias-interactive-bg-hover); }
.mcm-card-name { font-size:14px; font-weight:500; }
.mcm-card-route { font-size:12px; color:var(--dsw-alias-label-tertiary); }
.mcm-card-tag { border:1px solid var(--dsw-alias-border-l3); color:var(--dsw-alias-label-secondary); border-radius:4px; padding:1px 6px; font-size:11px; }
.mcm-dot { display:none; }
.mcm-chev { font-size:12px; color:var(--dsw-alias-label-dimmed); }
.mcm-card-act { margin-left:auto; display:flex; gap:4px; }
.mcm-editor { background:var(--dsw-alias-bg-module-platform); border-top:1px solid var(--dsw-alias-border-l2); padding:14px 16px; display:flex; flex-direction:column; gap:14px; }
.mcm-field { display:flex; flex-direction:column; gap:4px; }
.mcm-fl { display:flex; align-items:center; gap:4px; font-size:12px; font-weight:500; color:var(--dsw-alias-label-secondary); line-height:18px; }
.mcm-req { color:var(--dsw-alias-state-error-primary); }
.mcm-hint { color:var(--dsw-alias-label-dimmed); cursor:help; font-size:11px; border:1px solid var(--dsw-alias-border-l3); border-radius:50%; width:14px; height:14px; display:inline-flex; align-items:center; justify-content:center; }
.mcm-in { box-sizing:border-box; width:100%; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); border-radius:8px; height:32px; padding:0 10px; font:inherit; font-size:14px; }
.mcm-in:focus { border-color:var(--dsw-alias-brand-primary); outline:none; }
.mcm-in.mono { font-family:var(--ds-font-family-code); font-size:12px; }
.mcm-row { display:flex; flex-wrap:wrap; gap:10px; }
.mcm-row > .mcm-field { flex:1; min-width:160px; }
.mcm-adv { border-top:1px dashed var(--dsw-alias-border-l3); padding-top:10px; }
.mcm-adv-sum { cursor:pointer; font-size:13px; font-weight:500; color:var(--dsw-alias-label-secondary); display:flex; align-items:center; gap:6px; }
.mcm-adv-sum:hover { color:var(--dsw-alias-label-primary); }
.mcm-adv-b { padding-top:10px; display:flex; flex-direction:column; gap:12px; }
.mcm-mcard { border:1px solid var(--dsw-alias-border-l2); border-radius:8px; margin-bottom:6px; overflow:hidden; }
.mcm-mcard-h { display:flex; align-items:center; gap:8px; padding:8px 12px; cursor:pointer; }
.mcm-mcard-h:hover { background:var(--dsw-alias-interactive-bg-hover); }
.mcm-mcard-id { font-family:var(--ds-font-family-code); font-size:12px; font-weight:500; flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.mcm-mtag { font-size:11px; padding:1px 6px; border-radius:4px; border:1px solid var(--dsw-alias-border-l3); color:var(--dsw-alias-label-secondary); }
.mcm-mtag.reasoning { color:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); }
.mcm-mtag.image { color:var(--dsw-alias-state-success-primary); border-color:var(--dsw-alias-state-success-primary); }
.mcm-mcard-b { padding:10px 12px 12px; border-top:1px solid var(--dsw-alias-border-l2); display:flex; flex-direction:column; gap:10px; }
.mcm-levels { display:grid; grid-template-columns:repeat(auto-fill,minmax(80px,1fr)); gap:6px; }
.mcm-level { display:flex; flex-direction:column; gap:2px; }
.mcm-level label { font-size:11px; color:var(--dsw-alias-label-tertiary); }
.mcm-level input { border:1px solid var(--dsw-alias-border-l2); border-radius:6px; padding:4px 6px; font:inherit; font-size:12px; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-1); outline:none; }
.mcm-level input:focus { border-color:var(--dsw-alias-brand-primary); }
.mcm-compat { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:8px; padding:8px 0; }
.mcm-compat-f { display:flex; flex-direction:column; gap:2px; }
.mcm-compat-f label { font-size:11px; color:var(--dsw-alias-label-tertiary); }
.mcm-kv { border:1px solid var(--dsw-alias-border-l2); border-radius:8px; overflow:hidden; }
.mcm-kv-row { display:flex; align-items:center; border-bottom:1px solid var(--dsw-alias-border-l2); }
.mcm-kv-row:last-child { border-bottom:none; }
.mcm-kv-row input { border:none; border-radius:0; background:transparent; padding:6px 8px; outline:none; font:inherit; font-size:12px; color:var(--dsw-alias-label-primary); }
.mcm-kv-row .k { width:35%; font-weight:500; background:var(--dsw-alias-bg-module-platform); border-right:1px solid var(--dsw-alias-border-l2); }
.mcm-kv-row .v { flex:1; font-family:var(--ds-font-family-code); font-size:11px; }
.mcm-kv-row .x { padding:0 8px; color:var(--dsw-alias-label-dimmed); cursor:pointer; }
.mcm-kv-row .x:hover { color:var(--dsw-alias-state-error-primary); }
.mcm-check { display:inline-flex; align-items:center; gap:4px; font-size:13px; color:var(--dsw-alias-label-secondary); margin-right:10px; }
.mcm-check input { accent-color:var(--dsw-alias-brand-primary); }
.mcm-mask { position:fixed; inset:0; background:rgba(0,0,0,.3); backdrop-filter:blur(2px); display:flex; align-items:center; justify-content:center; z-index:200; }
.mcm-modal { background:var(--dsw-alias-bg-base); border-radius:12px; box-shadow:0 8px 32px rgba(0,0,0,.2); width:90%; max-width:520px; max-height:80vh; display:flex; flex-direction:column; border:1px solid var(--dsw-alias-border-l2); }
.mcm-modal-h { padding:14px 18px; border-bottom:1px solid var(--dsw-alias-border-l2); display:flex; align-items:center; gap:8px; }
.mcm-modal-h h2 { font-size:15px; font-weight:500; flex:1; margin:0; }
.mcm-modal-b { padding:16px 18px; overflow-y:auto; flex:1; }
.mcm-modal-f { padding:10px 18px; border-top:1px solid var(--dsw-alias-border-l2); display:flex; justify-content:flex-end; gap:8px; }
.mcm-fs { display:flex; align-items:center; gap:5px; flex-wrap:wrap; padding:8px 10px; background:var(--dsw-alias-bg-module-platform); border-radius:8px; margin-bottom:10px; font-size:12px; }
.mcm-fs-i { display:inline-flex; align-items:center; gap:3px; padding:2px 9px; border-radius:12px; font-weight:500; font-size:11px; }
.mcm-fs-i.total { border:1px solid var(--dsw-alias-border-l2); color:var(--dsw-alias-label-primary); }
.mcm-fs-i.ok { color:var(--dsw-alias-state-success-primary); }
.mcm-fs-i.add { color:var(--dsw-alias-brand-primary); }
.mcm-fs-i.clean { color:var(--dsw-alias-state-error-primary); }
.mcm-fl-list { max-height:280px; overflow-y:auto; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; }
.mcm-fl-item { display:flex; align-items:center; gap:8px; padding:7px 10px; border-bottom:1px solid var(--dsw-alias-border-l2); cursor:pointer; }
.mcm-fl-item:last-child { border-bottom:none; }
.mcm-fl-item:hover { background:var(--dsw-alias-interactive-bg-hover); }
.mcm-fl-item input { accent-color:var(--dsw-alias-brand-primary); flex-shrink:0; }
.mcm-fl-item label { flex:1; font-family:var(--ds-font-family-code); font-size:12px; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.mcm-fl-tag { font-size:10px; padding:1px 5px; border-radius:10px; font-weight:500; }
.mcm-fl-tag.add { color:var(--dsw-alias-brand-primary); }
.mcm-fl-tag.ok { color:var(--dsw-alias-state-success-primary); }
.mcm-fl-tag.stale { color:var(--dsw-alias-state-error-primary); }
.mcm-spin { width:20px; height:20px; border:2px solid var(--dsw-alias-border-l2); border-top-color:var(--dsw-alias-brand-primary); border-radius:50%; animation:mcm-spin .8s linear infinite; margin:16px auto; }
@keyframes mcm-spin { to { transform:rotate(360deg); } }
.mcm-live { display:inline-flex; align-items:center; gap:4px; font-size:12px; font-weight:500; padding:2px 8px; border-radius:12px; }
.mcm-live.ok { color:var(--dsw-alias-state-success-primary); }
.mcm-live.bad { color:var(--dsw-alias-state-error-primary); }
.mcm-live.testing { color:var(--dsw-alias-label-tertiary); }
.mcm-empty { color:var(--dsw-alias-label-tertiary); padding:16px; text-align:center; font-size:13px; }
`

    const clone = (v) => JSON.parse(JSON.stringify(v))
    const APIS = ['openai-completions', 'openai-responses', 'anthropic-messages']
    const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
    const TF = ['openai', 'deepseek', 'openrouter', 'together', 'zai', 'qwen', 'chat-template', 'qwen-chat-template', 'string-thinking', 'ant-ling']
    const MTF = ['max_completion_tokens', 'max_tokens']
    const TRANSPORTS = ['sse', 'websocket', 'websocket-cached', 'auto']
    const CACHE = ['none', 'short', 'long']
    const btn = (label, onClick, kind) => el('button', { className: 'mcm-btn' + (kind ? ' ' + kind : ''), onClick }, label)
    const field = (label, tip, req, children) => el('div', { className: 'mcm-field' }, el('div', { className: 'mcm-fl' }, label, req ? el('span', { className: 'mcm-req' }, '*') : null, tip ? el('span', { className: 'mcm-hint', title: tip }, '?') : null), children)
    const tf = (label, tip, value, onSet, mono) => field(label, tip, false, el('input', { className: 'mcm-in' + (mono ? ' mono' : ''), value: value == null ? '' : String(value), onChange: (e) => onSet(e.target.value) }))
    const nf = (label, tip, value, onSet) => tf(label, tip, value, (v) => onSet(Number(v) || 0))
    const sel = (label, tip, value, options, onSet) => field(label, tip, false, el('select', { className: 'mcm-in', value, onChange: (e) => onSet(e.target.value) }, ...options.map((o) => Array.isArray(o) ? el('option', { key: o[0], value: o[0] }, o[1]) : el('option', { key: o, value: o }, o))))

    function levelsEditor(efforts, onSet) {
      const cur = efforts && typeof efforts === 'object' ? efforts : {}
      return el('div', { className: 'mcm-levels' }, LEVELS.map((lv) => {
        const wire = cur[lv]
        return el('div', { key: lv, className: 'mcm-level' }, el('label', { title: lv === 'off' ? 'null=关闭推理' : '发到API的实际值' }, lv), el('input', { value: wire == null ? '' : String(wire), placeholder: lv === 'off' ? '(null)' : 'wire', onChange: (e) => { const v = e.target.value; const n = Object.assign({}, cur); if (v === '' && lv !== 'off') { delete n[lv] } else if (v === '') { n[lv] = null } else { n[lv] = v }; onSet(n) } }))
      }))
    }

    function kvEditor(kvs, onSet) {
      const entries = Object.entries(kvs || {})
      return el('div', null, el('div', { className: 'mcm-kv' }, entries.length > 0 ? entries.map(([k, v], i) => el('div', { key: i, className: 'mcm-kv-row' }, el('input', { className: 'k', value: k, onChange: (e) => { const n = Object.assign({}, kvs); delete n[k]; n[e.target.value] = v; onSet(n) } }), el('input', { className: 'v', value: v, onChange: (e) => { const n = Object.assign({}, kvs); n[k] = e.target.value; onSet(n) } }), el('span', { className: 'x', onClick: () => { const n = Object.assign({}, kvs); delete n[k]; onSet(n) } }, '\u2715'))) : el('div', { className: 'mcm-empty', style: { padding: 8 } }, '无header')), btn('＋添加', () => onSet(Object.assign({}, kvs, { '': '' })), 'danger'))
    }

    function compatEditor(compat, onSet) {
      const c = compat || {}
      const setB = (k, v) => onSet(Object.assign({}, c, { [k]: v }))
      const setS = (k, v) => onSet(Object.assign({}, c, { [k]: v }))
      const bF = (k, d) => el('div', { className: 'mcm-compat-f' }, el('label', { title: d }, k), el('label', { className: 'mcm-check' }, el('input', { type: 'checkbox', checked: !!c[k], onChange: (e) => setB(k, e.target.checked) }), c[k] ? '✓' : '✗'))
      const sF = (k, opts, d) => el('div', { className: 'mcm-compat-f' }, el('label', { title: d }, k), el('select', { className: 'mcm-in', style: { height: 28, fontSize: 12 }, value: c[k] || '', onChange: (e) => setS(k, e.target.value) }, el('option', { value: '' }, '—'), ...opts.map((o) => el('option', { key: o, value: o }, o))))
      return el('div', { className: 'mcm-compat' }, sF('thinkingFormat', TF, '推理调度线格式'), sF('maxTokensField', MTF, '输出上限字段名'), bF('supportsReasoningEffort', '支持reasoning_effort'), bF('supportsDeveloperRole', '支持developer role'), bF('supportsStore', '支持store'), bF('supportsUsageInStreaming', '流式含usage'), bF('supportsLongCacheRetention', '支持长缓存'), bF('supportsEagerToolInputStreaming', '工具输入流式'), bF('supportsTemperature', '支持temperature'), bF('forceAdaptiveThinking', '强制自适应思考'), bF('allowEmptySignature', '允许空签名'), bF('supportsStrictMode', 'strict模式'), bF('supportsStrictTools', 'strict tools'), bF('supportsCacheControlOnTools', '工具缓存控制'), bF('requiresToolResultName', '结果带name'), bF('requiresAssistantAfterToolResult', '结果后紧跟assistant'), bF('requiresThinkingAsText', '思考以文本发送'), bF('requiresReasoningContentOnAssistantMessages', 'assistant带reasoning_content'), sF('cacheControlFormat', ['anthropic'], '缓存控制格式'))
    }

    function modelCard(m, mi, updateModel, removeModel, em, setEm, launchTest, testState) {
      const setInput = (patch) => updateModel(mi, patch)
      const input = m.input || ['text']
      const tog = (mod) => { const s = new Set(input); if (s.has(mod)) { s.delete(mod) } else { s.add(mod) }; setInput({ input: [...s] }) }
      const tags = []
      const ts = testState
      const tsTag = ts ? (ts.status === 'running' ? el('span', { className: 'mcm-live testing' }, '⏳') : ts.status === 'ok' ? el('span', { className: 'mcm-live ok', title: 'TTFT ' + (ts.ttftMs != null ? (ts.ttftMs / 1000).toFixed(2) + 's' : '—') + ' · 总 ' + (ts.latencyMs != null ? (ts.latencyMs / 1000).toFixed(2) + 's' : '—') + (ts.text ? ' · ' + ts.text.slice(0, 40) : '') }, '✓') : el('span', { className: 'mcm-live bad', title: (ts.error || ts.code || '失败') }, '✗')) : null
      if (input.includes('image')) { tags.push(el('span', { key: 'i', className: 'mcm-mtag image' }, 'image')) } else { tags.push(el('span', { key: 't', className: 'mcm-mtag' }, 'text')) }
      const eff = m.reasoningEfforts || {}
      if (Object.keys(eff).some((k) => k !== 'off' && eff[k] != null)) { tags.push(el('span', { key: 'r', className: 'mcm-mtag reasoning' }, 'reasoning')) }
      const isOpen = !!em[mi]
      return el('div', { className: 'mcm-mcard', key: mi }, el('div', { className: 'mcm-mcard-h', onClick: () => setEm((e) => Object.assign({}, e, { [mi]: !e[mi] })) }, el('span', { className: 'mcm-chev' }, isOpen ? '▼' : '▶'), el('span', { className: 'mcm-mcard-id' }, m.id || '(unnamed)'), ...tags, tsTag, btn('⚡测试', (e) => { e.stopPropagation(); if (launchTest) launchTest(m.id) }, 'primary'), btn('✕', (e) => { e.stopPropagation(); removeModel(mi) }, 'danger')),
        isOpen ? el('div', { className: 'mcm-mcard-b' }, el('div', { className: 'mcm-row' }, field('id', '模型唯一标识', true, el('input', { className: 'mcm-in mono', value: m.id || '', onChange: (e) => setInput({ id: e.target.value }) })), field('name', '显示名称(不影响API)', false, el('input', { className: 'mcm-in', value: m.name || '', onChange: (e) => setInput({ name: e.target.value }) }))), el('div', { className: 'mcm-row' }, nf('contextWindow', '上下文窗口token数', m.contextWindow || 0, (v) => setInput({ contextWindow: v })), nf('maxTokens', '最大输出token', m.maxTokens || 0, (v) => setInput({ maxTokens: v }))), field('input', 'text=纯文本,image=图片', false, el('div', null, el('label', { className: 'mcm-check' }, el('input', { type: 'checkbox', checked: input.includes('text'), onChange: () => tog('text') }), 'text'), el('label', { className: 'mcm-check' }, el('input', { type: 'checkbox', checked: input.includes('image'), onChange: () => tog('image') }), 'image'))), field('reasoningEfforts', '各级wire值映射(off=null表示关闭)', false, levelsEditor(eff, (v) => setInput({ reasoningEfforts: v }))), el('div', { className: 'mcm-adv' }, el('div', { className: 'mcm-adv-sum', onClick: (e) => { e.stopPropagation(); setEm((s) => Object.assign({}, s, { ['cx_' + mi]: !s['cx_' + mi] })) } }, el('span', null, em['cx_' + mi] ? '▼' : '▶'), 'compat占位修改(模型级)'), em['cx_' + mi] ? el('div', { className: 'mcm-adv-b' }, compatEditor(m.compat, (v) => setInput({ compat: v }))) : null)) : null)
    }

    function fetchModal(name, p, disc, setDisc, onApply) {
      if (!disc || disc.provider !== name) return null
      let body
      if (disc.loading) { body = el('div', { style: { display: 'flex', justifyContent: 'center', padding: 24 } }, el('div', { className: 'mcm-spin' }))
      } else if (disc.error) { body = el('div', { style: { color: 'var(--dsw-alias-state-error-primary)', padding: 14, textAlign: 'center', fontSize: 12 } }, '拉取失败: ' + disc.error, el('br'), btn('重试', () => { setDisc({ provider: name, loading: true }); doFetch(name, p, setDisc) }))
      } else { const d = disc; const all = [...d.missing.map((id) => ({ id, tag: 'add', txt: '+ 可添加' })), ...d.configured.map((id) => ({ id, tag: 'ok', txt: '✓ 已配' })), ...d.stale.map((id) => ({ id, tag: 'stale', txt: '! 可清' }))]
        const toggle = (item) => { const s = new Set(d.selected); if (s.has(item.id)) { s.delete(item.id) } else { s.add(item.id) }; setDisc(Object.assign({}, d, { selected: s })) }
        body = el('div', null, el('div', { className: 'mcm-fs' }, el('span', { className: 'mcm-fs-i total' }, '端点 ' + d.available.length), el('span', { className: 'mcm-fs-i ok' }, '✓已配 ' + d.configured.length), el('span', { className: 'mcm-fs-i add' }, '+可加 ' + d.missing.length), el('span', { className: 'mcm-fs-i clean' }, '!可清 ' + d.stale.length)), el('div', { className: 'mcm-notice' }, '勾选=保留/添加，取消勾选=清理。已配置项默认勾选，取消勾选会被删除。'), el('div', { className: 'mcm-fl-list' }, all.length === 0 ? el('div', { className: 'mcm-empty' }, '端点无模型') : all.map((item) => { const checked = d.selected.has(item.id); return el('div', { key: item.id, className: 'mcm-fl-item', onClick: () => toggle(item) }, el('input', { type: 'checkbox', checked, onChange: (e) => { e.stopPropagation(); toggle(item) } }), el('label', null, item.id), el('span', { className: 'mcm-fl-tag ' + item.tag }, item.txt)) })))
      }
      const cc = disc && disc.selected ? disc.selected.size : 0
      const mh = el('div', { className: 'mcm-modal-h' }, el('h2', null, '拉取上游可用模型 · ' + name), btn('✕', () => setDisc(null)))
      const mb = el('div', { className: 'mcm-modal-b' }, body)
      const mf = el('div', { className: 'mcm-modal-f' }, btn('取消', () => setDisc(null)), btn('应用 (' + cc + ')', () => { if (disc.selected) { onApply([...disc.selected]); setDisc(null) } }, 'primary'))
      return el('div', { className: 'mcm-mask', onClick: () => setDisc(null) }, el('div', { className: 'mcm-modal', onClick: (e) => e.stopPropagation() }, mh, mb, mf))
    }

    function doFetch(name, p, setDisc) {
      if (!apiRef) { setDisc({ provider: name, error: 'api unavailable' }); return }
      apiRef.llm.discoverModels({ settingsNs: 'llm-pi-ai', provider: name, baseURL: p.baseURL || undefined }).then((resp) => {
        const r = resp && resp.result ? resp.result : resp
        if (r && r.ok === false) throw new Error((r.error && (r.error.message || r.error)) || 'discover failed')
        const result = r && r.value !== undefined ? r.value : r
        const models = (result && result.models) || []
        const av = models.map((m) => m.id).filter(Boolean)
        const cf = new Set((p.models || []).map((m) => m.id))
        // pi 同款语义：已配置默认勾选(保留)，可添加默认不勾，可清理默认不勾；应用=勾选的保留/添加，未勾选的删除
        setDisc({ provider: name, available: av, configured: [...cf].filter((id) => av.includes(id)), missing: av.filter((id) => !cf.has(id)), stale: [...cf].filter((id) => !av.includes(id)), selected: new Set([...cf].filter((id) => av.includes(id))) })
      }).catch((e) => setDisc({ provider: name, error: String((e && e.message) || e) }))
    }

    function ModelTestModal(props) {
      const win = props.win; const setWin = props.setWin
      const [running, setRunning] = useState(false)
      const poll = (nonce) => {
        if (!apiRef) return
        apiRef.settings.describe({}).then((resp) => {
          const r = resp && resp.result ? resp.result : resp
          const d = r && r.value !== undefined ? r.value : r
          const ns = ((d && d.namespaces) || []).find((n) => n && n.ns === 'model-channel-health')
          const tr = (ns && ns.value && ns.value.testResults) || {}
          const e = tr[nonce]
          if (e && e.status === 'ok') { setWin((w) => Object.assign({}, w, { result: e, polling: false })); setRunning(false); props.onResult(e) }
          else if (e && e.status === 'error') { setWin((w) => Object.assign({}, w, { result: e, polling: false })); setRunning(false); props.onResult(e) }
          else setTimeout(() => poll(nonce), 1200)
        }).catch(() => setTimeout(() => poll(nonce), 1500))
      }
      const run = () => {
        if (!apiRef || running) return
        const nonce = Date.now() % 1000000000
        setRunning(true); setWin((w) => Object.assign({}, w, { nonce, result: null }))
        apiRef.settings.update({ ns: 'model-channel-health', patch: { testRequest: { nonce, provider: win.provider, model: win.model, prompt: win.prompt || '你好', maxTokens: win.maxTokens || 256 } } }).then(() => { poll(nonce) }).catch((e) => { setWin((w) => Object.assign({}, w, { result: { status: 'error', error: String((e && e.message) || e) } })); setRunning(false) })
      }
      const w = win
      const res = w.result
      const statusLine = running || (res && res.status === 'running') ? el('span', { className: 'mcm-live testing' }, '请求中…模拟DSH真实链路') : res && res.status === 'ok' ? el('span', { className: 'mcm-live ok' }, '✓成功 · TTFT ' + (res.ttftMs != null ? (res.ttftMs / 1000).toFixed(2) + 's' : '—') + ' · 总延迟 ' + (res.latencyMs != null ? (res.latencyMs / 1000).toFixed(2) + 's' : '—')) : res && res.status === 'error' ? el('span', { className: 'mcm-live bad' }, '✗失败: ' + (res.error || res.code || 'unknown')) : null
      const body = el('div', { className: 'mcm-modal-b' }, el('div', { className: 'mcm-fs' }, el('span', { className: 'mcm-fs-i total' }, '模型测试'), el('span', { className: 'mcm-fs-i ok' }, w.provider), el('span', { className: 'mcm-fs-i add' }, w.model)), field('问题', '发送到上游的真实用户消息（存本地）', false, el('textarea', { className: 'mcm-in', style: { height: 70, padding: 8, resize: 'vertical' }, value: w.prompt || '', onChange: (e) => { localStorage.setItem('mcm_test_prompt', e.target.value); setWin((x) => Object.assign({}, x, { prompt: e.target.value })) } })), field('maxTokens', '最大输出token', false, el('input', { type: 'number', className: 'mcm-in', value: w.maxTokens || 256, onChange: (e) => setWin((x) => Object.assign({}, x, { maxTokens: Number(e.target.value) || 256 })) })), el('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } }, btn(running ? '请求中…' : '🚀 发送测试', run, 'primary'), statusLine), res && res.status === 'ok' && res.text ? el('div', { className: 'mcm-mcard-b', style: { marginTop: 8 } }, el('div', { className: 'mcm-fl' }, '回复'), el('pre', { style: { whiteSpace: 'pre-wrap', fontSize: 12, fontFamily: 'var(--ds-font-family-code)', maxHeight: 180, overflow: 'auto', color: 'var(--dsw-alias-label-primary)' } }, res.text)) : null)
      return el('div', { className: 'mcm-mask', onClick: () => setWin(null) }, el('div', { className: 'mcm-modal', onClick: (e) => e.stopPropagation() }, el('div', { className: 'mcm-modal-h' }, el('h2', null, '模型测试 · ' + w.model), btn('✕', () => setWin(null))), body, el('div', { className: 'mcm-modal-f' }, btn('关闭', () => setWin(null)))))
    }

    function ModelConfigPanel(props) {
      const draft = props._draft; const setDraft = props._setDraft
      const [exp, setExp] = useState({}); const [em, setEm] = useState({}); const [sa, setSa] = useState({}); const [disc, setDisc] = useState(null); const [live, setLive] = useState({}); const [keyInput, setKeyInput] = useState({})
      const providers = draft || {}; const credStatus = props._state && props._state.credentials ? props._state.credentials : {}
      const [testWin, setTestWin] = useState(null); const [testStates, setTestStates] = useState({})
      const launchTest = (provider, model) => { setTestStates((s) => Object.assign({}, s, { [provider + '::' + model]: { status: 'running' } })); setTestWin({ provider, model, prompt: localStorage.getItem('mcm_test_prompt') || '用一句话介绍你自己', maxTokens: 256, nonce: null, result: null, polling: false }) }
      const updateP = (name, patch) => setDraft((d) => Object.assign({}, d, { [name]: Object.assign({}, d[name], patch) }))
      const updateModel = (name, mi, patch) => setDraft((d) => { const ms = (d[name].models || []).map((mm, i) => i === mi ? Object.assign({}, mm, patch) : mm); return Object.assign({}, d, { [name]: Object.assign({}, d[name], { models: ms }) }) })
      const removeModel = (name, mi) => setDraft((d) => { const ms = (d[name].models || []).filter((_, i) => i !== mi); return Object.assign({}, d, { [name]: Object.assign({}, d[name], { models: ms }) }) })
      const saveKey = (name) => { const ref = (providers[name] || {}).apiKeyEnv || ''; const val = (keyInput[name] || '').trim(); if (!ref || !val || !apiRef) return; apiRef.credentials.set({ key: ref, value: val }).then((resp) => { const r = resp && resp.result ? resp.result : resp; if (r && r.ok === false) throw new Error((r.error && (r.error.message || r.error)) || 'set failed'); setKeyInput((k) => Object.assign({}, k, { [name]: '' })); setLive((l) => Object.assign({}, l, { [name + '_key']: 'saved' })) }).catch((e) => setLive((l) => Object.assign({}, l, { [name + '_key']: 'error:' + String((e && e.message) || e) }))) }
      const cards = Object.entries(providers).map(([name, p]) => {
        const isOpen = !!exp[name]; const credOk = credStatus[name] && credStatus[name].configured; const models = p.models || []
        const doDiscover = () => { setDisc({ provider: name, loading: true }); doFetch(name, p, setDisc) }
        const testConn = () => { setLive((l) => Object.assign({}, l, { [name]: { status: 'testing' } })); doFetch(name, p, (d) => { setLive((l) => Object.assign({}, l, { [name]: d.error ? { status: 'bad', error: d.error } : { status: 'ok', count: d.available.length } })) }) }
        // pi 同款：勾选的保留/添加，未勾选的删除；已配置保留原顺序
        const applyDiscovery = (ids) => { const cs = new Set(ids); const kept = models.filter((m) => cs.has(m.id)); const ex = new Set(kept.map((m) => m.id)); const news = [...cs].filter((id) => !ex.has(id)).map((id) => ({ id, name: id, contextWindow: 0, maxTokens: 0, input: ['text'], reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high' } })); updateP(name, { models: kept.concat(news) }) }
        const adv = sa[name]; const lv = live[name]
        const mc = models.map((m, mi) => modelCard(m, mi, (mi2, patch) => updateModel(name, mi2, patch), (mi2) => removeModel(name, mi2), em, setEm, (modelId) => launchTest(name, modelId), testStates[name + '::' + m.id]))
        return el('div', { className: 'mcm-card', key: name }, el('div', { className: 'mcm-card-h', onClick: () => setExp((e) => Object.assign({}, e, { [name]: !e[name] })) }, el('span', { className: 'mcm-chev' }, isOpen ? '▼' : '▶'), el('span', { className: 'mcm-dot' }), el('span', { className: 'mcm-card-name' }, name), p.api ? el('span', { className: 'mcm-card-tag' }, p.api) : null, el('span', { className: 'mcm-card-route' }, models.length + ' 模型'), el('div', { className: 'mcm-card-act' }, btn('删', (e) => { e.stopPropagation(); if (confirm('删除provider ' + name + '?')) setDraft((d) => { const n = clone(d); delete n[name]; return n }) }, 'danger'))),
          isOpen ? el('div', { className: 'mcm-editor' }, tf('displayName', '提供商显示名称', p.displayName || '', (v) => updateP(name, { displayName: v })), el('div', { className: 'mcm-row' }, sel('api', '当前仅支持3个协议', p.api || 'openai-completions', APIS, (v) => updateP(name, { api: v })), tf('baseURL', 'API端点地址含/v1', p.baseURL || '', (v) => updateP(name, { baseURL: v }), true)), tf('apiKeyEnv', '环境变量名(凭据引用)不明文存密钥', p.apiKeyEnv || '', (v) => updateP(name, { apiKeyEnv: v }), true),
            el('div', { className: 'mcm-field' }, el('div', { className: 'mcm-fl' }, '直接输入 API Key', el('span', { className: 'mcm-hint', title: '直接粘贴key值存入DSH凭据存储不进浏览器日志' }, '?')), el('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } }, el('input', { type: 'password', className: 'mcm-in mono', style: { flex: 1 }, placeholder: '粘贴 API Key (sk-xxx)', value: (keyInput[name] || ''), onChange: (e) => setKeyInput((k) => Object.assign({}, k, { [name]: e.target.value })) }), btn('保存密钥', () => saveKey(name)), live[name + '_key'] === 'saved' ? el('span', { className: 'mcm-live ok' }, '✓已保存') : null, live[name + '_key'] && live[name + '_key'].startsWith('error') ? el('span', { className: 'mcm-live bad' }, '✗' + live[name + '_key']) : null)),
            el('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } }, btn('🔌探测端点', testConn), lv && lv.status === 'testing' ? el('span', { className: 'mcm-live testing' }, '探测中…') : null, lv && lv.status === 'ok' ? el('span', { className: 'mcm-live ok' }, '✓端点可达·' + lv.count + '模型') : null, lv && lv.status === 'bad' ? el('span', { className: 'mcm-live bad' }, '✗' + lv.error) : null),
            el('div', { className: 'mcm-adv' }, el('div', { className: 'mcm-adv-sum', onClick: () => setSa((s) => Object.assign({}, s, { [name]: !s[name] })) }, el('span', null, adv ? '▼' : '▶'), '高级字段(transport/timeout/image/compat/retry)'), adv ? el('div', { className: 'mcm-adv-b' }, el('div', { className: 'mcm-row' }, nf('defaultContextWindow', '默认上下文窗口', p.defaultContextWindow || 0, (v) => updateP(name, { defaultContextWindow: v })), nf('defaultMaxTokens', '默认最大输出token', p.defaultMaxTokens || 0, (v) => updateP(name, { defaultMaxTokens: v }))), field('defaultInput', '默认输入模态', false, el('input', { className: 'mcm-in', value: (p.defaultInput || []).join(','), onChange: (e) => updateP(name, { defaultInput: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) }) })), field('headers', '自定义HTTP请求头', false, kvEditor(p.headers || {}, (v) => updateP(name, { headers: v }))), sel('reasoning', 'provider级默认思考等级', p.reasoning || '', LEVELS, (v) => updateP(name, { reasoning: v || undefined })), field('thinkingBudgets', '各级token预算', false, el('div', { className: 'mcm-row' }, nf('minimal', null, (p.thinkingBudgets || {}).minimal || 0, (v) => updateP(name, { thinkingBudgets: Object.assign({}, p.thinkingBudgets, { minimal: v }) })), nf('low', null, (p.thinkingBudgets || {}).low || 0, (v) => updateP(name, { thinkingBudgets: Object.assign({}, p.thinkingBudgets, { low: v }) })), nf('medium', null, (p.thinkingBudgets || {}).medium || 0, (v) => updateP(name, { thinkingBudgets: Object.assign({}, p.thinkingBudgets, { medium: v }) })), nf('high', null, (p.thinkingBudgets || {}).high || 0, (v) => updateP(name, { thinkingBudgets: Object.assign({}, p.thinkingBudgets, { high: v }) })))), el('div', { className: 'mcm-row' }, sel('transport', '传输方式', p.transport || 'auto', TRANSPORTS, (v) => updateP(name, { transport: v })), sel('cacheRetention', '缓存保留', p.cacheRetention || 'none', CACHE, (v) => updateP(name, { cacheRetention: v }))), el('div', { className: 'mcm-row' }, nf('timeoutMs', '请求超时ms', p.timeoutMs || 0, (v) => updateP(name, { timeoutMs: v })), nf('streamIdleTimeoutMs', '流空闲超时ms', p.streamIdleTimeoutMs || 0, (v) => updateP(name, { streamIdleTimeoutMs: v })), nf('websocketConnectTimeoutMs', 'ws连接超时ms', p.websocketConnectTimeoutMs || 0, (v) => updateP(name, { websocketConnectTimeoutMs: v }))), el('div', { className: 'mcm-row' }, nf('maxRequestImageBytes', '图片最大字节', p.maxRequestImageBytes || 0, (v) => updateP(name, { maxRequestImageBytes: v })), nf('requestImagePixelBudget', '像素预算', p.requestImagePixelBudget || 0, (v) => updateP(name, { requestImagePixelBudget: v })), nf('requestImageMaxBytes', '单张图片最大字节', p.requestImageMaxBytes || 0, (v) => updateP(name, { requestImageMaxBytes: v }))), field('retryPolicy', 'mode=normal按codes重试,mode=always总是重试', false, el('div', null, sel('mode', '重试模式', (p.retryPolicy || {}).mode || 'normal', ['normal', 'always'], (v) => updateP(name, { retryPolicy: Object.assign({}, p.retryPolicy, { mode: v }) })), nf('maxRetries', '最大重试次默认5', (p.retryPolicy || {}).maxRetries || 5, (v) => updateP(name, { retryPolicy: Object.assign({}, p.retryPolicy, { maxRetries: v }) })), nf('initialDelayMs', '初始延迟ms默认500', ((p.retryPolicy || {}).backoff || {}).initialDelayMs || 500, (v) => updateP(name, { retryPolicy: Object.assign({}, p.retryPolicy, { backoff: Object.assign({}, (p.retryPolicy || {}).backoff, { initialDelayMs: v }) }) })), nf('maxDelayMs', '最大延迟ms默认10000', ((p.retryPolicy || {}).backoff || {}).maxDelayMs || 10000, (v) => updateP(name, { retryPolicy: Object.assign({}, p.retryPolicy, { backoff: Object.assign({}, (p.retryPolicy || {}).backoff, { maxDelayMs: v }) }) })))), el('div', { style: { marginTop: 4 } }, el('div', { className: 'mcm-adv-sum', onClick: () => setSa((s) => Object.assign({}, s, { ['cx_' + name]: !s['cx_' + name] })) }, el('span', null, sa['cx_' + name] ? '▼' : '▶'), 'compat(provider级)'), sa['cx_' + name] ? el('div', { className: 'mcm-adv-b' }, compatEditor(p.compat, (v) => updateP(name, { compat: v }))) : null)) : null),
            el('div', null, el('div', { style: { display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0 8px' } }, el('span', { style: { fontSize: 13, fontWeight: 500 } }, '模型(' + models.length + ')'), el('span', { style: { marginLeft: 'auto', display: 'flex', gap: 6 } }, btn('＋添加', () => updateP(name, { models: models.concat([{ id: '', name: '', contextWindow: 0, maxTokens: 0, input: ['text'], reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high' } }]) })), btn('🔍拉取上游', doDiscover, 'primary'))), models.length === 0 ? el('div', { className: 'mcm-empty' }, '无模型') : mc),
            fetchModal(name, p, disc, setDisc, applyDiscovery)) : null)
      })

      const addBtn = btn('＋新增provider', () => { const nm = 'new-provider-' + (Object.keys(providers).length + 1); setDraft((d) => Object.assign({}, d || {}, { [nm]: { api: 'openai-completions', baseURL: '', apiKeyEnv: nm.toUpperCase().replace(/-/g, '_') + '_API_KEY', displayName: nm, models: [] } })); setExp((e) => Object.assign({}, e, { [nm]: true })) }, 'primary')
      return el('div', null, ...cards, addBtn, testWin ? el(ModelTestModal, { win: testWin, setWin: setTestWin, providers, onResult: (e) => { const key = testWin.provider + '::' + testWin.model; setTestStates((s) => Object.assign({}, s, { [key]: e })); } }) : null)
    }
    function candidatePicker(providers, cand, onSet) {
      const providerCfg = providers[cand.provider] || {}
      const modelOptions = (providerCfg.models || []).map((m) => m.id).filter(Boolean)
      const provNames = Object.keys(providers || {})
      return el('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } }, el('select', { className: 'mcm-in', style: { flex: 1, minWidth: 160 }, value: cand.provider || '', onChange: (e) => onSet(Object.assign({}, cand, { provider: e.target.value, model: '' })) }, el('option', { value: '' }, '— provider —'), ...provNames.map((p) => el('option', { key: p, value: p }, p))), el('select', { className: 'mcm-in', style: { flex: 1, minWidth: 160 }, value: cand.model || '', onChange: (e) => onSet(Object.assign({}, cand, { model: e.target.value })) }, el('option', { value: '' }, '— model —'), ...modelOptions.map((m) => el('option', { key: m, value: m }, m))))
    }

    function RoundrobinPanel(props) {
      const groups = props.channelsDraft || []
      const providers = props._providers || {}
      const [saveState, setSaveState] = useState(null); const [speedState, setSpeedState] = useState({}); const [expanded, setExpanded] = useState({})
      const addGroup = () => props.setChannelsDraft((d) => (d || []).concat([{ id: 'group-' + ((d || []).length + 1), virtualModel: { name: 'RoundRobin', reasoning: true, input: ['text'], contextWindow: 200000, maxTokens: 16384 }, candidates: [], strategy: 'sticky', timeoutMs: 30000, cooldownMs: 60000, maxRetriesPerCandidate: 2, speedTest: { enabled: false, sortKey: 'ttft', prompt: '欧拉函数的意义？', maxTokens: 2048, timeoutMs: 60000, concurrency: 3, minIntervalMs: 60000, retries: 2 } }]))
      const patchGroup = (i, patch) => props.setChannelsDraft((d) => d.map((g, gi) => gi === i ? Object.assign({}, g, patch) : g))
      const patchGroupPath = (i, path, value) => props.setChannelsDraft((d) => d.map((g, gi) => {
        if (gi !== i) return g
        const cur = Object.assign({}, g)
        let ref = cur
        for (let k = 0; k < path.length - 1; k++) { ref[path[k]] = Object.assign({}, ref[path[k]]) ; ref = ref[path[k]] }
        ref[path[path.length - 1]] = value
        return cur
      }))
      const save = () => { if (!apiRef) return; setSaveState('saving'); apiRef.settings.update({ ns: 'model-channels', patch: { groups } }).then((resp) => { const r = resp && resp.result ? resp.result : resp; if (r && r.ok === false) throw new Error((r.error && (r.error.message || r.error)) || 'update failed'); setSaveState('ok'); setTimeout(() => setSaveState(null), 2000); props.refreshChannels() }).catch((e) => { setSaveState('err:' + String((e && e.message) || e)) }) }
      const speedtest = (gid) => { if (!apiRef) return; const nonce = Date.now() % 1000000000; setSpeedState((s) => Object.assign({}, s, { [gid]: 'running' })); apiRef.settings.update({ ns: 'model-channel-health', patch: { speedRequest: { group: gid, nonce } } }).then(() => { setSpeedState((s) => Object.assign({}, s, { [gid]: 'sent' })); setTimeout(() => setSpeedState((s) => Object.assign({}, s, { [gid]: null })), 3000) }).catch((e) => setSpeedState((s) => Object.assign({}, s, { [gid]: 'err:' + String((e && e.message) || e) }))) }
      if (!props.channelsDraft) return el('div', { className: 'mcm-empty' }, '加载中…')
      if (groups.length === 0) return el('div', null, el('div', { className: 'mcm-empty' }, '尚无轮询组'), btn('＋新增轮询组', addGroup, 'primary'))
      return el('div', null, groups.map((g, i) => {
        const isOpen = !!expanded[i]
        const st = speedState[g.id]
        const vm = g.virtualModel || {}
        const stCfg = g.speedTest || {}
        return el('div', { className: 'mcm-card', key: g.id + '-' + i }, el('div', { className: 'mcm-card-h', onClick: () => setExpanded((e) => Object.assign({}, e, { [i]: !e[i] })) }, el('span', { className: 'mcm-chev' }, isOpen ? '▼' : '▶'), el('span', { className: 'mcm-card-name' }, vm.name || g.id), el('span', { className: 'mcm-card-tag' }, g.id), el('span', { className: 'mcm-card-route' }, (g.candidates || []).length + ' 候选 · ' + (g.strategy || 'sticky')), el('div', { className: 'mcm-card-act' }, btn('⚡测速', (e) => { e.stopPropagation(); speedtest(g.id) }, 'primary'), st === 'running' ? el('span', { className: 'mcm-live testing' }, '测速中…') : null, st === 'sent' ? el('span', { className: 'mcm-live ok' }, '已触发') : null, st && String(st).startsWith('err') ? el('span', { className: 'mcm-live bad' }, st) : null, btn('删', (e) => { e.stopPropagation(); if (confirm('删除轮询组 ' + g.id + '?')) props.setChannelsDraft((d) => d.filter((_, gi) => gi !== i)) }, 'danger'))),
          isOpen ? el('div', { className: 'mcm-editor' }, el('div', { className: 'mcm-row' }, tf('组ID', '小写字母数字连字符', g.id, (v) => patchGroup(i, { id: v }), true), tf('虚拟模型名', '选择该组后会显示的名字', vm.name || '', (v) => patchGroupPath(i, ['virtualModel', 'name'], v))), el('div', { className: 'mcm-row' }, nf('contextWindow', '虚拟模型上下文窗口', vm.contextWindow || 0, (v) => patchGroupPath(i, ['virtualModel', 'contextWindow'], v)), nf('maxTokens', '虚拟模型最大输出', vm.maxTokens || 0, (v) => patchGroupPath(i, ['virtualModel', 'maxTokens'], v))), field('候选池', '故障转移顺序：首候选失败切下一个', false, el('div', null, (g.candidates || []).map((c, ci) => el('div', { key: ci, style: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 } }, candidatePicker(providers, c, (nc) => patchGroupPath(i, ['candidates', ci], nc)), btn('✕', (e) => { e.stopPropagation(); patchGroup(i, { candidates: (g.candidates || []).filter((_, gi) => gi !== ci) }) }, 'danger'))), btn('＋候选', () => patchGroup(i, { candidates: (g.candidates || []).concat([{ provider: '', model: '' }]) })))),
            el('div', { className: 'mcm-row' }, sel('strategy', 'sticky=成功后黏住 / round-robin=轮流 / primary=回首选', g.strategy || 'sticky', [['sticky', 'sticky'], ['round-robin', 'round-robin'], ['primary', 'primary']], (v) => patchGroup(i, { strategy: v })), nf('timeoutMs', '单候选首响应超时(ms)', g.timeoutMs || 30000, (v) => patchGroup(i, { timeoutMs: v }))), el('div', { className: 'mcm-row' }, nf('cooldownMs', '失败后冷却(ms)', g.cooldownMs || 60000, (v) => patchGroup(i, { cooldownMs: v })), nf('maxRetriesPerCandidate', '单候选原地重试次数', g.maxRetriesPerCandidate || 0, (v) => patchGroup(i, { maxRetriesPerCandidate: v }))),
            el('div', { className: 'mcm-adv' }, el('div', { className: 'mcm-adv-sum', onClick: () => setExpanded((e) => Object.assign({}, e, { st_: i + '_' + !e['st_' + i] })) }, el('span', null, expanded['st_' + i] ? '▼' : '▶'), '测速排序'), expanded['st_' + i] ? el('div', { className: 'mcm-adv-b' }, el('div', { className: 'mcm-row' }, el('label', { className: 'mcm-check' }, el('input', { type: 'checkbox', checked: stCfg.enabled !== false, onChange: (e) => patchGroupPath(i, ['speedTest', 'enabled'], e.target.checked) }), stCfg.enabled !== false ? '✓' : '✗'), sel('sortKey', '排序键', stCfg.sortKey || 'ttft', [['ttft', 'ttft'], ['latency', 'latency'], ['hybrid', 'hybrid'], ['smart', 'smart']], (v) => patchGroupPath(i, ['speedTest', 'sortKey'], v))), field('prompt', '测速prompt', false, el('input', { className: 'mcm-in', value: stCfg.prompt || '', onChange: (e) => patchGroupPath(i, ['speedTest', 'prompt'], e.target.value) })), el('div', { className: 'mcm-row' }, nf('timeoutMs', '单次测速超时(ms)', stCfg.timeoutMs || 60000, (v) => patchGroupPath(i, ['speedTest', 'timeoutMs'], v)), nf('concurrency', '并行数', stCfg.concurrency || 3, (v) => patchGroupPath(i, ['speedTest', 'concurrency'], v)), nf('retries', '失败重试次数', stCfg.retries || 2, (v) => patchGroupPath(i, ['speedTest', 'retries'], v)))) : null),
            el('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 } }, btn('保存轮询配置', save, 'primary'), saveState === 'saving' ? el('span', { className: 'mcm-live testing' }, '保存中…') : saveState === 'ok' ? el('span', { className: 'mcm-live ok' }, '✓已保存(即时生效)') : saveState && String(saveState).startsWith('err') ? el('span', { className: 'mcm-live bad' }, '✗' + saveState) : null)) : null)
      })).concat(el('div', { style: { marginTop: 8 } }, btn('＋新增轮询组', addGroup, 'primary')))
    }

    function HealthPanel(props) {
      const health = props.health
      if (!health) return el('div', { className: 'mcm-empty' }, '健康命名空间尚未注册——请重启 DSH 使 host 端轮询引擎生效')
      const groups = Object.keys(health.records || {})
      const lastUpdate = health.lastUpdate
      const header = el('div', { className: 'mcm-notice', style: { marginBottom: 8 } }, '数据来自 host 引擎的 7 天滚动记录' + (lastUpdate ? ' · 更新于 ' + lastUpdate : ''))
      if (groups.length === 0) return el('div', null, header, el('div', { className: 'mcm-empty' }, '暂无健康数据——使用过轮询组后自动采集(7天滚动)'))
      return el('div', null, header, groups.map((gid) => {
        const recs = health.records[gid] || []
        const speeds = health.speedResults[gid] || []
        const by = new Map()
        for (const e of recs) {
          const key = e.provider + '::' + e.model
          let a = by.get(key)
          if (!a) { a = { provider: e.provider, model: e.model, total: 0, success: 0, ttftSum: 0, latSum: 0, lastTs: 0, lastOk: null }; by.set(key, a) }
          a.total++; if (e.ok) a.success++
          if (e.ttftMs != null) a.ttftSum += e.ttftMs
          if (e.latencyMs != null) a.latSum += e.latencyMs
          if ((e.ts || 0) > a.lastTs) { a.lastTs = e.ts || 0; a.lastOk = e.ok }
        }
        const rows = [...by.values()].map((a) => ({ ...a, rate: a.total > 0 ? (a.success / a.total * 100).toFixed(0) + '%' : '—', avgTtft: a.success > 0 ? (a.ttftSum / a.success / 1000).toFixed(2) + 's' : '—', avgLat: a.success > 0 ? (a.latSum / a.success / 1000).toFixed(2) + 's' : '—' }))
        const statCells = (r) => [el('span', { className: 'mcm-fl' }, '成功率 ' + r.rate + ' (' + r.success + '/' + r.total + ')'), el('span', { className: 'mcm-fl' }, 'TTFT均值 ' + r.avgTtft), el('span', { className: 'mcm-fl' }, '延迟均值 ' + r.avgLat)]
        const rowCards = rows.map((r) => el('div', { key: r.provider + '::' + r.model, className: 'mcm-mcard' }, el('div', { className: 'mcm-mcard-h' }, el('span', { className: 'mcm-mcard-id' }, r.provider + ' / ' + r.model), el('span', { className: 'mcm-mtag ' + (r.lastOk ? 'reasoning' : 'stale') }, r.lastOk ? '✓最近成功' : '✗最近失败')), el('div', { className: 'mcm-mcard-b' }, el('div', { className: 'mcm-row' }, ...statCells(r)))))
        const speedRow = speeds.map((s) => ({ key: s.provider + '::' + s.model, ok: s.ok, ttft: s.ttft != null ? (s.ttft / 1000).toFixed(2) + 's' : '—', lat: s.latency != null ? (s.latency / 1000).toFixed(2) + 's' : '—', failure: s.failure || null, at: s.at }))
        const speedItems = speedRow.map((s) => el('div', { key: s.key, className: 'mcm-fl-item' }, el('label', null, s.key), el('span', { className: 'mcm-fl-tag ' + (s.ok ? 'ok' : 'stale') }, s.ok ? '✓' : '✗'), el('span', { className: 'mcm-fl-tag' }, 'TTFT ' + s.ttft), el('span', { className: 'mcm-fl-tag' }, '总 ' + s.lat)))
        return el('div', { className: 'mcm-card', key: gid }, el('div', { className: 'mcm-card-h' }, el('span', { className: 'mcm-card-name' }, gid), el('span', { className: 'mcm-card-route' }, recs.length + ' 条记录')), el('div', { className: 'mcm-mcard-b' }, el('div', { className: 'mcm-fl' }, '候选健康(7天)'), el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(360px,1fr))', gap: 8 } }, rowCards), speedRow.length > 0 ? el('div', { className: 'mcm-fl', style: { marginTop: 10 } }, '最近测速') : null, speedRow.length > 0 ? el('div', { className: 'mcm-fl-list' }, speedItems) : null))
      }))
    }

    function ModelConfigView() {
      const [state, setState] = useState(null); const [draft, setDraft] = useState(null); const [notice, setNotice] = useState(null); const [saving, setSaving] = useState(false); const [tab, setTab] = useState('config')
      const [channels, setChannels] = useState(null); const [channelsDraft, setChannelsDraft] = useState(null); const [health, setHealth] = useState(null)
      const unwrap = (resp) => {
        const r = resp && resp.result ? resp.result : resp
        if (r && r.ok === false) throw new Error((r.error && (r.error.message || r.error)) || 'request failed')
        return r && r.value !== undefined ? r.value : r
      }
      const [refreshing, setRefreshing] = useState(false); const [lastRefresh, setLastRefresh] = useState(null)
      const refresh = () => {
        if (!apiRef) { setNotice('api unavailable'); return }
        setRefreshing(true)
        apiRef.settings.describe({}).then((resp) => {
          const d = unwrap(resp)
          const nss = (d && d.namespaces) || []
          const findNs = (name) => nss.find((n) => n && n.ns === name)
          const ns = findNs('llm-pi-ai')
          const providers = (ns && ns.value && ns.value.providers) || {}
          setState({ providers, revision: ns && ns.revision })
          setDraft((prev) => prev || clone(providers))
          const cn = findNs('model-channels')
          const ch = (cn && cn.value && cn.value.groups) || []
          setChannels(ch)
          setChannelsDraft((prev) => prev || clone(ch))
          const hn = findNs('model-channel-health')
          setHealth(hn ? { records: (hn.value && hn.value.records) || {}, speedResults: (hn.value && hn.value.speedResults) || {}, runtime: (hn.value && hn.value.runtime) || {}, lastUpdate: new Date().toLocaleTimeString() } : null)
          setLastRefresh(new Date())
          setNotice('已刷新 ' + new Date().toLocaleTimeString())
        }).catch((e) => setNotice('加载失败:' + String((e && e.message) || e))).finally(() => setRefreshing(false))
      }
      useEffect(() => { refresh() }, [])
      const save = () => { if (!apiRef || !draft) return; setSaving(true); setNotice(null); apiRef.settings.update({ ns: 'llm-pi-ai', patch: { providers: draft } }).then((resp) => { const r = resp && resp.result ? resp.result : resp; if (r && r.ok === false) throw new Error((r.error && (r.error.message || r.error)) || 'update failed'); setNotice('已保存（即时生效）') }).catch((e) => setNotice('保存失败:' + String((e && e.message) || e))).finally(() => setSaving(false)) }
      const panels = { config: el(ModelConfigPanel, { _state: state, _draft: draft, _setDraft: setDraft }), roundrobin: el(RoundrobinPanel, { channels, channelsDraft, setChannelsDraft, health, _providers: state ? state.providers : {}, refreshChannels: () => { apiRef.settings.describe({}).then((resp) => { const d = unwrap(resp); const cn = ((d && d.namespaces) || []).find((n) => n && n.ns === 'model-channels'); const ch = (cn && cn.value && cn.value.groups) || []; setChannels(ch); setChannelsDraft((prev) => prev || clone(ch)) }).catch(() => { }) } }), health: el(HealthPanel, { health, channels, channelsDraft }) }
      return el('div', { className: 'mcm-root' }, el('div', { className: 'mcm-tabs' }, el('div', { className: 'mcm-tab' + (tab === 'config' ? ' active' : ''), onClick: () => setTab('config') }, '模型配置'), el('div', { className: 'mcm-tab' + (tab === 'roundrobin' ? ' active' : ''), onClick: () => setTab('roundrobin') }, '轮询渠道'), el('div', { className: 'mcm-tab' + (tab === 'health' ? ' active' : ''), onClick: () => setTab('health') }, '健康统计'), el('div', { className: 'mcm-tab-right' }, el('span', { className: 'mcm-notice ' + (notice && notice.includes('已保存') ? 'ok' : notice ? 'err' : '') }, notice || ''), btn(refreshing ? '刷新中…' : '刷新', refresh), btn(saving ? '保存中…' : '保存', save, 'primary'))), el('div', { className: 'mcm-body' }, panels[tab]))
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
        (p) => el(ModelConfigView, p)))
    }

    return { name: 'model-channel-manager', inject: ['slots', 'connection'], apply }
  },
})