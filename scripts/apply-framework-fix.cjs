/** Explicit local hotfix for the audited DSH release. Never runs as an install hook. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const replaceOnce = (text, before, after) => {
  const pattern = before.split('\n').map(line => line.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\n[\\t ]*');
  const re = new RegExp('^[\\t ]*' + pattern, 'gm');
  const matches = [...text.matchAll(re)];
  if (matches.length !== 1) throw new Error('Installed package differs from audited release; refusing automatic patch');
  return text.replace(re, () => after);
};
const specs = [
  ['@deepseek-ai/cordis-plugin-loader', text => {
    if (text.includes('CORDIS_VOLATILE_CONFIG_INVALID')) return text;
    text = replaceOnce(text,
      '\t\t\t\tif (volatileOnly) this.fiber._config = this.options.config;\n\t\t\t\tconst pending = volatileOnly && this._commitVolatile() ? [] : changes;',
      '\t\t\t\tlet pending = changes;\n\t\t\t\tif (volatileOnly) {\n\t\t\t\t\tconst previousRaw = this.fiber._config;\n\t\t\t\t\tthis.fiber._config = this.options.config;\n\t\t\t\t\ttry { if (this._commitVolatile()) pending = []; }\n\t\t\t\t\tcatch (cause) {\n\t\t\t\t\t\tthis.options = legacy;\n\t\t\t\t\t\tthis.fiber._config = previousRaw;\n\t\t\t\t\t\tthrow Object.assign(new Error(`Volatile config update failed for "${this.options.id}"`, { cause }), { code: "CORDIS_VOLATILE_CONFIG_INVALID" });\n\t\t\t\t\t}\n\t\t\t\t}');
    return replaceOnce(text,
      '\t\t\tlet candidate;\n\t\t\ttry {\n\t\t\t\tcandidate = resolveConfig(fiber.runtime, fiber.ctx.waterfall(fiber, "internal/config", raw, () => raw));\n\t\t\t} catch (error) {\n\t\t\t\tthis.ctx.logger.warn("volatile config update failed for %C", this.options.id);\n\t\t\t\tthis.ctx.logger.warn(error);\n\t\t\t\treturn true;\n\t\t\t}',
      '\t\t\tconst candidate = resolveConfig(fiber.runtime, fiber.ctx.waterfall(fiber, "internal/config", raw, () => raw));');
  }],
  ['@deepseek-ai/dsh-config-editor', text => {
    if (text.includes('was rejected by Loader')) return text;
    const anchor = '\t\t\t\t\t\tawait reconcileProfilePatches(this.ownerContext.root, patches, "dsh", [entry.options.id]);';
    return replaceOnce(text, anchor, anchor + '\n\t\t\t\t\t\tif (!isDeepStrictEqual(entry.options.config ?? {}, next)) throw new Error(`Configuration for "${entry.options.id}" was rejected by Loader`);');
  }],
];
const edits = specs.map(([name, transform]) => { const file = require.resolve(name); const before = fs.readFileSync(file, 'utf8'); return { name, file, before, after: transform(before) }; });
if (!process.argv.includes('--apply')) {
  for (const e of edits) console.log(e.name, e.before === e.after ? 'already patched' : 'patch applicable');
} else {
  const changed = edits.filter(e => e.before !== e.after);
  const backup = path.join(root, 'backups', 'framework-' + Date.now());
  fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
  for (const e of edits) if (fs.readFileSync(e.file, 'utf8') !== e.before) throw new Error('Package changed during preflight');
  const write = (file, text) => { const temp = file + '.mcm-tmp'; fs.writeFileSync(temp, text); fs.renameSync(temp, file); };
  try {
    for (const e of changed) { fs.writeFileSync(path.join(backup, e.name.split('/').at(-1) + '.js'), e.before); write(e.file, e.after); }
    const result = spawnSync(process.execPath, ['--test', 'tests/framework/volatile-rollback.cjs'], { cwd: root, stdio: 'inherit' });
    if (result.status !== 0) throw new Error('Runtime verification failed; restoring packages');
    fs.writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify(edits.map(e => ({ name: e.name, file: e.file, before: crypto.createHash('sha256').update(e.before).digest('hex'), after: crypto.createHash('sha256').update(e.after).digest('hex') })), null, 2));
    console.log('Framework verified. Backup:', backup);
  } catch (error) { for (const e of changed) write(e.file, e.before); throw error; }
}
