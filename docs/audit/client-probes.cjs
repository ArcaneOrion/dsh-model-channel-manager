/**
 * 执行原始 client.js 的组件函数与事件回调。
 * hook/DOM/API 为最小替身：验证真实回调和提交参数，不等同于浏览器端到端测试。
 * 不改写组件函数，不复制 save/drag/refresh 等业务实现，不连接实际服务。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../src/client.js'), 'utf8');
const evidence = [];
const tick = () => new Promise((resolve) => setImmediate(resolve));
const plain = (v) => JSON.parse(JSON.stringify(v));
const success = (value = {}) => ({ result: { ok: true, value } });
const failure = { result: { ok: false, error: { code: 'settings-rejected', message: 'audit: write rejected' } } };

function fixture({ providers = {}, groups = [], rejectWrites = false, rejectNamespace } = {}) {
  let slotsRender;
  let activeStore;
  let cursor = 0;
  let describeProviders = providers;
  let describeGroups = groups;
  const timers = [];
  const requests = [];
  const committed = [];
  const write = async (method, req) => {
    requests.push({ method, ...plain(req) });
    if (rejectWrites || req.ns === rejectNamespace) return failure;
    committed.push(req.ns);
    return success();
  };
  const api = {
    settings: {
      describe: async () => success({ namespaces: [
        { ns: 'llm-pi-ai', revision: 2, value: { providers: describeProviders }, user: { providers: describeProviders } },
        { ns: 'model-channels', revision: 3, value: { groups: describeGroups, providerOrder: Object.keys(describeProviders) } },
      ] }),
      mutate: (req) => write('mutate', req),
      update: (req) => write('update', req),
    },
    llm: { discoverModels: async () => success({ models: [] }) },
    credentials: { set: async () => success(), describe: async () => success({ credentials: {} }) },
  };
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState(initial) {
      const store = activeStore;
      const i = cursor++;
      if (!(i in store)) store[i] = typeof initial === 'function' ? initial() : initial;
      return [store[i], (v) => { store[i] = typeof v === 'function' ? v(store[i]) : v; }];
    },
    useEffect() {},
    useRef: (v) => ({ current: v }),
    useSyncExternalStore() {},
  };
  const sandbox = {
    window: { __ModuleLoader__: { load({ factory }) {
      const plugin = factory(() => react);
      plugin.apply({
        get: (name) => name === 'connection' ? { api } : name === 'slots' ? {
          inject: (_, callback) => callback(),
          register: (_, render) => { slotsRender = render; },
        } : undefined,
        effect: (callback) => callback(),
      });
    } } },
    document: { createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild() {} } },
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout: (callback, ms) => { timers.push({ callback, ms }); return timers.length; },
    setInterval: (callback, ms) => { timers.push({ callback, ms }); return timers.length; },
    clearInterval() {},
    confirm: () => true,
    console,
  };
  vm.runInNewContext(source, sandbox, { filename: 'src/client.js' });
  const View = slotsRender({}).type;
  const viewState = [
    { providers, userProviders: providers }, providers, null, false, 'config',
    groups, groups, null,
  ];
  const render = (Component, props, state) => {
    activeStore = state;
    cursor = 0;
    return Component(props || {});
  };
  return {
    View, viewState, render,
    renderView: () => render(View, {}, viewState),
    requests, timers, committed,
    setRemote(p, g = groups) { describeProviders = p; describeGroups = g; },
  };
}
function all(node, predicate) {
  if (!node || typeof node !== 'object') return [];
  return [...(predicate(node) ? [node] : []), ...(node.children || []).flatMap((child) => all(child, predicate))];
}
function button(tree, label) {
  const found = all(tree, (n) => n.type === 'button' && n.children.includes(label))[0];
  if (!found) throw new Error('未找到按钮 ' + label);
  return found;
}
function component(tree, name) {
  const node = all(tree, (n) => typeof n.type === 'function' && n.type.name === name)[0];
  if (!node) throw new Error('未找到组件 ' + name);
  return node;
}
async function probe(id, fn) {
  if (process.argv[2] && !process.argv[2].split(',').includes(id)) return;
  const result = await fn();
  evidence.push({ id, ...result });
  console.log('AUDIT', JSON.stringify(evidence.at(-1)));
}
const provider = { api: 'openai-completions', models: [{ id: 'm' }] };
const group = { id: 'g', candidates: [{ provider: 'p', model: 'm' }] };

async function main() {
  await probe('C01_drag_handler_reference_error', async () => {
    const f = fixture({ providers: { p: provider } });
    const node = component(f.renderView(), 'ModelConfigPanel');
    const tree = f.render(node.type, node.props, []);
    const handle = all(tree, (n) => n.props.draggable === true)[0];
    try {
      handle.props.onDragStart({ stopPropagation() {}, dataTransfer: { setData() {} } });
      return { issue: false };
    } catch (e) { return { error: e.name + ': ' + e.message, issue: /idx is not defined/.test(e.message) }; }
  });

  await probe('C02_save_removes_explicit_reasoning_false', async () => {
    const f = fixture({ providers: { p: { ...provider, models: [{ id: 'm', reasoningEfforts: false }] } } });
    button(f.renderView(), '保存全部变更').props.onClick();
    await tick();
    const value = f.requests.find((r) => r.method === 'mutate').ops.find((op) => op.op === 'set').value;
    return { before: false, savedModel: value.models[0], issue: !Object.hasOwn(value.models[0], 'reasoningEfforts') };
  });

  await probe('C03_refresh_keeps_stale_draft_and_save_overwrites', async () => {
    const f = fixture({ providers: { p: { ...provider, displayName: 'old' } }, groups: [group] });
    f.setRemote({ p: { ...provider, displayName: 'new elsewhere' } });
    button(f.renderView(), '刷新').props.onClick();
    await tick();
    const refreshedState = f.viewState[0].providers.p.displayName;
    const retainedDraft = f.viewState[1].p.displayName;
    button(f.renderView(), '保存全部变更').props.onClick();
    await tick();
    const write = f.requests.find((r) => r.method === 'mutate');
    const submittedName = write.ops.find((op) => op.op === 'set').value.displayName;
    return { refreshedState, retainedDraft, submittedName, expectedRevisionPresent: Object.hasOwn(write, 'expectedRevision'), issue: refreshedState !== retainedDraft && submittedName === 'old' && !Object.hasOwn(write, 'expectedRevision') };
  });

  await probe('C04_save_before_initial_load_clears_groups', async () => {
    const f = fixture({ groups: [group] });
    const stateBeforeLoad = [null, null, null, false, 'config', null, null, null];
    button(f.render(f.View, {}, stateBeforeLoad), '保存全部变更').props.onClick();
    await tick();
    const write = f.requests.find((r) => r.ns === 'model-channels');
    return { loadingSaveButtonDisabled: false, submittedGroups: write.patch.groups, issue: write.patch.groups.length === 0 };
  });

  await probe('C05_rename_does_not_update_active_preset', async () => {
    const configured = { ...group, activePreset: 'active', presets: [{ id: 'active', candidates: [{ provider: 'p', model: 'm' }] }] };
    const f = fixture({ providers: { p: provider }, groups: [configured] });
    const panel = component(f.renderView(), 'ModelConfigPanel');
    panel.props._renameProviderInChannels('p', 'renamed');
    const savedGroup = f.viewState[6][0];
    return { mainCandidateProvider: savedGroup.candidates[0].provider, activePresetProvider: savedGroup.presets[0].candidates[0].provider, issue: savedGroup.presets[0].candidates[0].provider === 'p' };
  });

  await probe('C06_test_write_error_envelope_ignored', async () => {
    const f = fixture({ providers: { p: provider }, rejectWrites: true });
    const panel = component(f.renderView(), 'ModelConfigPanel');
    const state = [{ p: true }];
    button(f.render(panel.type, panel.props, state), '⚡测试').props.onClick();
    await tick();
    const status = state[5]?.['p::m']?.status;
    return { serverRejected: true, displayedStatus: status, pollingTimers: f.timers.length, issue: status === 'running' && f.timers.length > 0 };
  });

  await probe('C07_speed_write_error_envelope_ignored', async () => {
    const f = fixture({ providers: { p: provider }, groups: [group], rejectWrites: true });
    f.viewState[4] = 'roundrobin';
    const panel = component(f.renderView(), 'RoundrobinPanel');
    const state = [];
    button(f.render(panel.type, panel.props, state), '⚡测速排序').props.onClick();
    await tick();
    return { serverRejected: true, displayedStatus: state[0].g, issue: state[0].g === 'sent' };
  });

  await probe('C08_catalog_provider_silently_changes_wire_protocol', async () => {
    const f = fixture({ providers: { anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' } } });
    button(f.renderView(), '保存全部变更').props.onClick();
    await tick();
    const value = f.requests.find((r) => r.method === 'mutate').ops.find((op) => op.op === 'set').value;
    return { before: { apiKeyEnv: 'ANTHROPIC_API_KEY' }, submitted: value, issue: value.api === 'openai-completions' && value.models.length === 0 };
  });

  await probe('C09_seven_day_window_includes_older_records', async () => {
    const f = fixture();
    f.viewState[4] = 'health';
    f.viewState[7] = { records: { p: [{ ts: Date.now() - 30 * 86400000, provider: 'p', model: 'm', ok: true }] } };
    const panel = component(f.renderView(), 'HealthPanel');
    const tree = f.render(panel.type, panel.props, ['7d']);
    const cards = all(tree, (n) => n.props.className === 'mcm-metric-card');
    const value = cards[0].children.find((n) => n.props?.className === 'mcm-metric-value').children[0];
    return { recordAgeDays: 30, displayedSevenDayRequests: value, issue: value === 1 };
  });

  await probe('C10_save_partially_commits_references_after_provider_rejection', async () => {
    const f = fixture({ providers: { renamed: provider }, groups: [{ id: 'g', candidates: [{ provider: 'renamed', model: 'm' }] }], rejectNamespace: 'llm-pi-ai' });
    button(f.renderView(), '保存全部变更').props.onClick();
    await tick();
    return { committedNamespaces: f.committed, requestsSent: f.requests.map((r) => r.ns), notice: f.viewState[2], issue: f.committed.includes('model-channels') && !f.committed.includes('llm-pi-ai') && f.requests.length === 2 };
  });

  console.log('AUDIT_SUMMARY', JSON.stringify({ probes: evidence.length, reproduced: evidence.filter((r) => r.issue).length, evidence }, null, 2));
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
