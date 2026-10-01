const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('../helpers/profile.cjs');

test('提交阶段解析失败：settings拒绝并回滚文件、raw与运行值', async t => {
  const f = await fixture(); t.after(() => f.close());
  await f.rpc('snapshot');
  const entry = f.ctx.configEditor.entries().find(r => r.options.id === 'model-channel-manager');
  const before = f.readPatch();
  const options = JSON.stringify(entry.options.config);
  const reference = entry.fiber.config.providerOrder;
  const value = reference.get();
  let evaluations = 0;
  entry.fiber.ctx.on('internal/config', (raw, next) => {
    if (raw.providerOrder?.[0] === 'trigger' && ++evaluations === 2) throw new Error('second evaluation failed');
    return next();
  });
  await assert.rejects(f.ctx.settings.update('model-channel-manager', { providerOrder: ['trigger'] }));
  assert.equal(f.readPatch(), before);
  assert.equal(JSON.stringify(entry.options.config), options);
  assert.equal(entry.fiber.config.providerOrder, reference);
  assert.deepEqual(reference.get(), value);
  await f.ctx.settings.update('model-channel-manager', { providerOrder: ['recovered'] });
  assert.deepEqual(reference.get(), ['recovered']);
});

test('直接entry更新失败可观察，随后合法volatile更新保持实例与引用', async t => {
  const f = await fixture(); t.after(() => f.close());
  await f.rpc('snapshot');
  const entry = f.ctx.configEditor.entries().find(r => r.options.id === 'model-channel-manager');
  const uid = entry.fiber.uid;
  const before = entry.fiber._config;
  const reference = entry.fiber.config.providerOrder;
  entry.fiber.ctx.on('internal/config', (raw, next) => {
    if (raw.providerOrder?.[0] === 'invalid') throw new Error('bad candidate');
    return next();
  });
  await assert.rejects(entry.update({ config: { ...entry.options.config, providerOrder: ['invalid'] } }), { code: 'CORDIS_VOLATILE_CONFIG_INVALID' });
  assert.equal(entry.fiber._config, before);
  await entry.update({ config: { ...entry.options.config, providerOrder: ['valid'] } });
  assert.equal(entry.fiber.uid, uid);
  assert.equal(entry.fiber.config.providerOrder, reference);
  assert.deepEqual(reference.get(), ['valid']);
});
