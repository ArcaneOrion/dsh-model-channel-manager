/** Compile the changed framework modules and test against installed DSH in isolation. */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const source = process.argv[2] || '/home/arcaneorion/AI/AI-DSH/源码/deepseek-harness/vendor/loader/src/index.ts';
(async () => {
  const dir = fs.mkdtempSync('/tmp/mcm-loader-verify-');
  const output = path.join(dir, 'loader.mjs');
  const editor = path.join(dir, 'editor.mjs');
  const buildModule = (entry, outfile) => require('esbuild').build({
    entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node', target: 'node22', tsconfigRaw: {},
    plugins: [{ name: 'installed-peers', setup(build) {
      // The release build's tsc pass inlines this const enum before bundling.
      build.onLoad({ filter: /\.ts$/ }, args => ({ contents: fs.readFileSync(args.path, 'utf8').replace(/, FiberState,/, ',').replaceAll('FiberState.ACTIVE', '2').replaceAll('FiberState.UNLOADING', '5'), loader: 'ts' }));
      build.onResolve({ filter: /^[^./]/ }, args => ({ path: args.path.startsWith('node:') ? args.path : require.resolve(args.path), external: true }));
    } }],
  });
  await buildModule(source, output);
  await buildModule(path.resolve(path.dirname(source), '../../../packages/boot/config-editor/src/index.ts'), editor);
  const hook = path.join(dir, 'hook.mjs');
  const mapping = {
    '@deepseek-ai/cordis-plugin-loader': pathToFileURL(output).href,
    '@deepseek-ai/dsh-config-editor': pathToFileURL(editor).href,
    [require.resolve('@deepseek-ai/dsh-config-editor')]: pathToFileURL(editor).href,
  };
  fs.writeFileSync(hook, `import { registerHooks } from 'node:module';\nconst mapping=${JSON.stringify(mapping)};\nregisterHooks({resolve(specifier,context,next){if(mapping[specifier])return {url:mapping[specifier],shortCircuit:true};return next(specifier,context)}});\n`);
  const run = spawnSync(process.execPath, ['--import', hook, '--test', 'tests/framework/volatile-rollback.cjs'], { cwd: path.resolve(__dirname, '..'), stdio: 'inherit' });
  process.exitCode = run.status ?? 1;
  console.log('Compiled framework:', dir);
})().catch(error => { console.error(error); process.exitCode = 1; });
