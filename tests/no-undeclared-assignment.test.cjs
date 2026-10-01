/**
 * 未声明赋值静态守卫（0.3.15）
 *
 * 这一类缺陷已经咬过两次，且都在测试全绿的情况下漏过：
 *   - F18（0.3.2）：client 的 onDragStart 用了 map 参数里不存在的 `idx` → 一拖就 ReferenceError；
 *   - 0.3.5 的 F13 重构：`let cursor = …` 被改成两个分支内赋值却丢了声明 →
 *     每次走虚拟路由都 `ReferenceError: cursor is not defined`（用户看到「本轮运行失败」），
 *     而当时 32 个测试全绿。
 *
 * 两次都是「赋值/读取一个从未声明的标识符」——严格模式下必然抛错，且只有跑到那行才暴露。
 * 本测试用 acorn 解析两个源文件，收集全部声明名（变量/函数/参数/catch/import/解构），
 * 再找出所有赋值目标（`x = …`、`x++`、`x += …`）里未声明的标识符。
 * 注意：这是文件级 no-undef，比真正的词法作用域宽松（宁可漏报不误报），
 * 恰好覆盖「整个文件里根本没这个名字」这一最危险的形态。
 *
 * acorn 不可解析时优雅跳过（与 yaml 测试同一策略）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

const requireFrom = createRequire(__filename);

function loadAcorn() {
  const candidates = [
    [],
    [path.join(os.homedir(), '.dsh/profiles/web/node_modules')],
    [process.env.DSH_WORKSPACE_NODE_MODULES || path.join(os.homedir(), 'AI/Agent-workerspace/pnpm-packages/node_modules')],
  ];
  for (const paths of candidates) {
    try {
      return paths.length === 0 ? requireFrom('acorn') : requireFrom(requireFrom.resolve('acorn', { paths }));
    } catch (_e) { /* 继续找 */ }
  }
  // 最后兜底：pnpm store 里的任意 acorn 版本
  const store = path.join(os.homedir(), 'AI/Agent-workerspace/pnpm-packages/node_modules/.pnpm');
  try {
    const dir = fs.readdirSync(store).find((d) => /^acorn@/.test(d));
    if (dir) return requireFrom(path.join(store, dir, 'node_modules/acorn'));
  } catch (_e) { /* 无 store */ }
  return null;
}

const GLOBALS = new Set([
  'globalThis', 'window', 'document', 'localStorage', 'sessionStorage', 'console', 'crypto', 'fetch',
  'navigator', 'location', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask',
  'structuredClone', 'process', 'require', 'module', 'exports', '__dirname', '__filename',
  'Math', 'JSON', 'Date', 'Number', 'Object', 'Array', 'String', 'Boolean', 'Promise', 'Set', 'Map',
  'WeakMap', 'WeakSet', 'Symbol', 'Error', 'TypeError', 'RangeError', 'RegExp', 'Uint8Array', 'Uint32Array',
  'Int32Array', 'Float64Array', 'ArrayBuffer', 'Intl', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURIComponent', 'decodeURIComponent', 'AbortController', 'AbortSignal', 'TextEncoder', 'TextDecoder',
  'performance', 'URL', 'URLSearchParams', 'Proxy', 'Reflect', 'BigInt', 'Infinity', 'NaN', 'undefined',
  'arguments',
]);

function collectDeclaredNames(ast) {
  const names = new Set();
  const addPattern = (node) => {
    if (!node) return;
    if (node.type === 'Identifier') names.add(node.name);
    else if (node.type === 'ObjectPattern') for (const p of node.properties) addPattern(p.type === 'RestElement' ? p.argument : p.value);
    else if (node.type === 'ArrayPattern') for (const el of node.elements) addPattern(el);
    else if (node.type === 'AssignmentPattern') addPattern(node.left);
    else if (node.type === 'RestElement') addPattern(node.argument);
  };
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node.type !== 'string') return;
    switch (node.type) {
      case 'VariableDeclarator': addPattern(node.id); break;
      case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression':
        if (node.id) names.add(node.id.name);
        for (const p of node.params) addPattern(p);
        break;
      case 'ClassDeclaration': case 'ClassExpression': if (node.id) names.add(node.id.name); break;
      case 'CatchClause': addPattern(node.param); break;
      case 'ImportDefaultSpecifier': case 'ImportNamespaceSpecifier': case 'ImportSpecifier':
        names.add(node.local.name); break;
      default: break;
    }
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
      const v = node[key];
      if (v && typeof v === 'object') walk(v);
    }
  };
  walk(ast);
  return names;
}

function findUndeclaredAssignments(ast, declared) {
  const bad = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node.type !== 'string') return;
    if (node.type === 'AssignmentExpression' && node.left && node.left.type === 'Identifier') {
      const n = node.left.name;
      if (!declared.has(n) && !GLOBALS.has(n)) bad.push({ line: node.loc.start.line, name: n });
    }
    if (node.type === 'UpdateExpression' && node.argument && node.argument.type === 'Identifier') {
      const n = node.argument.name;
      if (!declared.has(n) && !GLOBALS.has(n)) bad.push({ line: node.loc.start.line, name: n + '++' });
    }
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
      const v = node[key];
      if (v && typeof v === 'object') walk(v);
    }
  };
  walk(ast);
  return bad;
}

test('源文件里没有「赋值给未声明标识符」（F18 / cursor 类缺陷的静态守卫）', (t) => {
  const acorn = loadAcorn();
  if (!acorn) { t.skip('acorn 不可解析（未安装依赖），跳过'); return; }
  const files = [
    ['src/index.js', 'module'],
    ['src/client.js', 'script'],
  ];
  const problems = [];
  for (const [file, sourceType] of files) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType, locations: true });
    for (const b of findUndeclaredAssignments(ast, collectDeclaredNames(ast)))
      problems.push(file + ':' + b.line + ' → ' + b.name);
  }
  assert.deepEqual(problems, [], '以下赋值目标从未声明（严格模式下必然 ReferenceError）:\n' + problems.join('\n'));
});

test('引擎关键局部变量已声明（cursor 回归守卫，防止声明再次丢失）', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
  assert.ok(/let cursor = 0;/.test(src), 'streamGroup 的 cursor 必须有声明');
  assert.ok(/cursor = rt\.currentIndex % order\.length;/.test(src), 'round-robin 仍应在选定时刻推进指针');
});
