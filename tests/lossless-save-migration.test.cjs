/**
 * F07 残余 + F10 回归（审计 C02/C08/H15）：
 *  F07-1：reasoningEfforts: false（显式关闭推理）保存后被删 → 静默恢复继承。
 *  F07-2：api 缺省（继承 catalog 协议）被强塞 openai-completions → 协议被切换
 *         （materialize 时显式 api 优先于 catalog）。
 *  F10：迁移读文件的 await 窗口里用户保存了新组 → 旧配置复活覆盖新配置。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const client = fs.readFileSync(path.join(__dirname, '../src/client.js'), 'utf8');
const host = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');

// ---- 复刻修复后的模型清洗逻辑（与 save() 内对齐） ----
function cleanModel(m) {
  const cleaned = Object.assign({}, m)
  cleaned.id = String(m.id).trim()
  if (cleaned.reasoningEfforts != null && typeof cleaned.reasoningEfforts === 'object' && Object.keys(cleaned.reasoningEfforts).length > 0) cleaned.reasoningEfforts = Object.assign({}, cleaned.reasoningEfforts)
  else if (cleaned.reasoningEfforts === false) {
    // false = 显式关闭：保留
  }
  else delete cleaned.reasoningEfforts
  return cleaned
}

test('F07-1 行为级：reasoningEfforts 三态无损往返', () => {
  // false（显式关闭）→ 保留
  const m1 = cleanModel({ id: 'm', reasoningEfforts: false })
  assert.strictEqual(m1.reasoningEfforts, false, 'false 必须原样保留（删除=静默恢复继承）')
  // 对象（档位映射）→ 保留（浅拷贝）
  const m2 = cleanModel({ id: 'm', reasoningEfforts: { low: 'low' } })
  assert.deepEqual(m2.reasoningEfforts, { low: 'low' })
  // undefined / null / 空对象 → 删除（未设置语义）
  assert.strictEqual(cleanModel({ id: 'm', reasoningEfforts: undefined }).reasoningEfforts, undefined)
  assert.strictEqual(cleanModel({ id: 'm', reasoningEfforts: null }).reasoningEfforts, undefined)
  assert.strictEqual(cleanModel({ id: 'm', reasoningEfforts: {} }).reasoningEfforts, undefined)
});

test('F07-1 源级：false 分支存在', () => {
  const m = client.match(/reasoningEfforts === false[\s\S]{0,200}?\n\s{14}else delete cleaned\.reasoningEfforts/);
  assert.ok(m, '应有 false 保留分支');
});

// ---- 复刻修复后的 api 处理（与 save() 内对齐） ----
function cleanProviderApi(pVal) {
  const pObj = Object.assign({}, pVal)
  if (typeof pVal.api === 'string' && pVal.api) pObj.api = pVal.api
  else delete pObj.api
  return pObj
}

test('F07-2 行为级：api 显式/继承两态无损', () => {
  // 显式 → 保留
  assert.equal(cleanProviderApi({ api: 'anthropic-messages' }).api, 'anthropic-messages')
  // 缺省（继承 catalog）→ 不强塞默认
  assert.strictEqual(cleanProviderApi({ baseURL: 'x' }).api, undefined, '缺省 api 不应被强塞 openai-completions')
  assert.strictEqual(cleanProviderApi({ api: '' }).api, undefined, '空串视为未设置')
});

test('F07-2 源级：不再无条件写默认 api；新增供应商仍显式给', () => {
  assert.ok(!/pObj\.api = pVal\.api \|\| 'openai-completions'/.test(client), '不应再强塞默认 api');
  assert.ok(/typeof pVal\.api === 'string' && pVal\.api\) pObj\.api = pVal\.api/.test(client), '显式 api 才写');
  // 新增供应商路径仍显式（新建的没有 catalog 可继承）
  assert.ok(/api: 'openai-completions'/.test(client), '新增供应商默认 api 保留');
});

// ---- F10：迁移写前重检（复刻修复后逻辑） ----
async function migrateLegacy(readText, currentGroupsAtWrite, update) {
  // 入口检查（迁移前提：无组）
  if (currentGroupsAtWrite().length !== 0) return 'skipped-entry'
  const text = await readText() // ← H15 的竞态窗口：这中间用户可能保存
  const migrated = { groups: [{ id: 'legacy-group' }] }
  // F10 修复点：写前重检
  if (currentGroupsAtWrite().length !== 0) return 'skipped-write'
  if (migrated.groups.length > 0) {
    await update(migrated.groups)
    return 'migrated'
  }
  return 'no-legacy'
}
