const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { createServer } = require('node:http');
const { pathToFileURL } = require('node:url');
const pkg = name => import(require.resolve('@deepseek-ai/' + name));
const waitFor = async (fn, timeout = 5000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 15)); }
  throw new Error('condition timed out');
};
exports.waitFor = waitFor;
exports.fixture = async ({ health, storage = true, stream, existingHome, hmr = false, pluginPath } = {}) => {
  const { Context, Service } = await pkg('cordis');
  const { boot, initProfile, readProfilePatches } = await pkg('dsh-app-boot');
  const { default: Hmr } = await pkg('dsh-hmr');
  const { default: Timer } = await pkg('cordis-plugin-timer');
  const { default: Editor } = await pkg('dsh-config-editor');
  const { default: Settings } = await pkg('dsh-settings');
  const { default: Storage } = await pkg('dsh-storage');
  const Json = await pkg('dsh-storage-json');
  const Domain = await pkg('dsh-storage-domain');
  const Connection = await pkg('dsh-client-connection');
  const { default: Registry } = await pkg('dsh-typert-registry');
  const { default: Gateway } = await pkg('dsh-api-gateway');
  const { default: Llm, LlmAdapter } = await pkg('dsh-llm');
  const Plugin = await import(pathToFileURL(pluginPath || resolve(__dirname, '../../src/index.js')).href);
  const home = existingHome || mkdtempSync(join(tmpdir(), 'mcm-profile-'));
  const dir = join(home, 'profiles', 'test');
  const calls = [];
  const routes = [];
  const credentials = new Map();
  const server = createServer((req, res) => {
    const pathname = req.url.split('?')[0];
    const route = routes.find(r => pathname === r.path || pathname.startsWith(r.path + '/'));
    if (!route) { res.writeHead(404); res.end(); return; }
    Promise.resolve(route.handler(req, res)).catch(e => { res.writeHead(500); res.end(e.message); });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + server.address().port;
  class Credentials extends Service {
    constructor(ctx) { super(ctx, 'credentials'); }
    async modifyRecord(key, fn) { const value = await fn(credentials.get(key)); credentials.set(key, value); return value; }
  }
  class Adapter extends LlmAdapter {
    async *stream(options) {
      calls.push(options);
      if (stream) { yield* stream(options); return; }
      yield { type: 'text-delta', text: '测试成功' };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  const External = { inject: ['llm'], apply(ctx) { ctx.llm.registerAdapter(['fixture'], new Adapter()); } };
  const WebServer = { apply(ctx) { ctx.provide('webServer', { port: server.address().port, registerUpgrade(route) { const listener = (req, socket, head) => { if(req.url === route.path) route.handler(req, socket, head); else socket.destroy(); }; server.on('upgrade', listener); return () => server.off('upgrade', listener); }, register(route) { routes.push(route); return () => { const at = routes.indexOf(route); if (at >= 0) routes.splice(at, 1); }; } }); } };
  if (!existingHome) {
    initProfile(dir, ['fixture-bundle']);
    const bundle = join(dir, 'node_modules', 'fixture-bundle');
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(home, 'package.json'), '{"name":"mcm-fixture"}\n');
    writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'fixture-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }));
    const rows = [
      { id: 'timer', name: 'cordis:timer' }, { id: 'web', name: 'cordis:web' },
      { id: 'credentials', name: 'cordis:credentials' }, { id: 'connection', name: 'cordis:connection' },
      { id: 'registry', name: 'cordis:registry' }, { id: 'gateway', name: 'cordis:gateway' },
      { id: 'llm', name: 'cordis:llm' }, { id: 'external', name: 'cordis:external' },
      { id: 'editor', name: 'cordis:editor' }, { id: 'settings', name: 'cordis:settings' },
      ...(storage ? [{ id: 'storage', name: 'cordis:storage' }, { id: 'json', name: 'cordis:json', config: { root: join(home, 'storages') } }, { id: 'domain', name: 'cordis:domain', config: { backend: 'json' } }] : []),
      { id: 'model-channel-manager', name: 'cordis:mcm', config: { groups: [{ id: 'test', strategy: 'round-robin', candidates: [{ provider: 'fixture', model: 'model' }], speedTest: { enabled: false, retries: 0, timeoutMs: 100 } }] } },
    ];
    writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: rows }]));
    writeFileSync(join(dir, 'cordis.yml'), '[]\n');
    if (health) writeFileSync(join(dir, 'cordis.patch.yml'), JSON.stringify([{ id: 'model-channel-manager', config: { groups: rows.at(-1).config.groups, health } }]));
  }
  const profile = { name: 'test', startedBundles: ['fixture-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined };
  let ctx;
  try {
    ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), ctx => {
      ctx.provide('profileContext', profile);
      ctx.provide('appReady', { onReady(fn) { fn(); return () => {}; } });
      ctx.logger.exporter({ levels: { default: 3 }, export: message => { if (message.type === 'error' || message.type === 'warn') console.error(...message.args); } });
      Object.assign(ctx.loader.builtins, { registry: Registry, gateway: Gateway, timer: Timer, web: WebServer, credentials: Credentials, connection: Connection, llm: Llm, external: External, editor: Editor, settings: Settings, storage: Storage, json: Json, domain: Domain, mcm: Plugin });
    });
    if (hmr) { await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 }); await ctx.hmr.runExclusive(async () => {}); }
    await waitFor(() => routes.find(r => r.path === '/api') && ctx.get('modelChannelController'));
  } catch (error) { if(ctx) console.error('routes', routes.map(r=>r.path), 'services', Object.keys(ctx.reflect.props)); if(ctx) for (const row of ctx.loader.entries()) console.error(row.options.id, row.fiber?.state, row.fiber?._error); await ctx?.fiber.dispose(); await new Promise(r => server.close(r)); throw error; }
  const target = new URL(ctx.connection.authenticatedUrl(origin));
  let cookie;
  ctx.connection.authorizeIndex({ method: 'GET', url: target.pathname + target.search, headers: { host: target.host } }, { writeHead(status, headers) { cookie = headers['set-cookie'].split(';')[0]; }, end() {} });
  const rpc = async (method, payload = {}) => {
    const response = await fetch(origin + '/api/modelChannels/invoke', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ type: 'client-request', rpcId: 'test-' + Math.random(), method: 'modelChannels/invoke', payload: { args: { method, payload } } }) });
    if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + await response.text());
    return (await response.json()).result;
  };
  const settled = id => waitFor(async () => { const r = await rpc('task', { id }); return r.ok && r.value.status !== 'running' ? r.value : null; });
  return { ctx, home, profile, origin, calls, rpc, settled, readPatch: () => readFileSync(profile.patchPath, 'utf8'),
    async close(keep = false) { await ctx.fiber.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); if (!keep) rmSync(home, { recursive: true, force: true }); },
  };
};
