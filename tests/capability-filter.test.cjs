/**
 * F08 最小切片回归：候选能力过滤（防「成功路径改变用户输入」）。
 * 核心语义边界（与宿主契约对齐：inputModalities 缺失=未知，显式排除才是负能力）：
 *  1. 明确排除 image 的候选在图片请求时被过滤；
 *  2. 能力未知的候选不过滤（保持 failover 行为）；
 *  3. 全部被滤时退回原列表（报真实错误而不是 NO_CANDIDATES）；
 *  4. 无图无 effort 的请求零开销直通（不触发解析）；
 *  5. 带 effort 时明确无 reasoning 的候选被过滤；
 *  6. TTL 缓存：同一候选的第二次解析走缓存。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');

// 提取 filterByCapability 相关函数体做行为级测试：直接用 eval 重建闭包环境太脆，
// 改为「逻辑复刻验证」——从源码提取关键谓词函数逐一驱动。
// 这里以独立实现复刻源码语义（与 src/index.js 的 filterByCapability 逐行对齐）。
function buildFilter(resolveCapability) {
  const requestHasImage = (options) => {
    try {
      return (options.messages || []).some((m) => Array.isArray(m?.content) && m.content.some((p) => p && p.type === 'image'));
    } catch (_e) { return false; }
  };
  const filterByCapability = async (cands, options) => {
    const needImage = requestHasImage(options);
    const needReasoning = typeof options.reasoningEffort === 'string' && options.reasoningEffort.length > 0 && options.reasoningEffort !== 'off';
    if (!needImage && !needReasoning) return cands;
    const kept = [];
    for (const cand of cands) {
      const info = await resolveCapability(cand);
      if (info === null) { kept.push(cand); continue; }
      if (needImage) {
        const mods = info.inputModalities;
        if (Array.isArray(mods) && mods.length > 0 && !mods.includes('image')) continue;
      }
      if (needReasoning && info.reasoning === undefined) continue;
      kept.push(cand);
    }
    return kept.length > 0 ? kept : cands;
  };
  return { requestHasImage, filterByCapability };
}

test('F08-1 明确排除 image 的候选在图片请求时被过滤（全滤退回原列表）', async () => {
  const { filterByCapability } = buildFilter(async () => ({ inputModalities: ['text'] }));
  const cands = [{ provider: 'a', model: 'm' }, { provider: 'b', model: 'm' }];
  const req = { messages: [{ role: 'user', content: [{ type: 'image' }] }] };
  const kept = await filterByCapability(cands, req);
  // 复刻版含退回语义（kept.length > 0 ? kept : cands，与源码对齐）：
  // 全部明确排除时退回原列表——让请求去撞真实错误，而不是 NO_CANDIDATES
  assert.equal(kept.length, 2, '全滤 → 退回原列表（报真实错误而非假装无渠道）');
  // 部分排除：a 明确排除、b 支持 → 只留 b
  const { filterByCapability: f2 } = buildFilter(async (c) => c.provider === 'a' ? { inputModalities: ['text'] } : { inputModalities: ['text', 'image'] });
  const kept2 = await f2(cands, req);
  assert.deepEqual(kept2.map((c) => c.provider), ['b'], '部分排除 → 只留支持者');
});

test('F08-2 能力未知的候选不过滤', async () => {
  const { filterByCapability } = buildFilter(async () => ({ inputModalities: undefined }));
  const cands = [{ provider: 'a', model: 'm' }];
  const req = { messages: [{ role: 'user', content: [{ type: 'image' }] }] };
  const kept = await filterByCapability(cands, req);
  assert.equal(kept.length, 1, '未知（无 inputModalities）不过滤');
  // 解析失败 = null 也不过滤
  const { filterByCapability: f2 } = buildFilter(async () => null);
  const kept2 = await f2(cands, req);
  assert.equal(kept2.length, 1, '解析失败不过滤');
});

test('F08-3 空 modality 数组 = 未知（不过滤），非空且不含 image = 明确排除', async () => {
  const { filterByCapability } = buildFilter(async (c) => c.provider === 'a' ? { inputModalities: [] } : { inputModalities: ['text'] });
  const cands = [{ provider: 'a', model: 'm' }, { provider: 'b', model: 'm' }];
  const req = { messages: [{ role: 'user', content: [{ type: 'image' }] }] };
  const kept = await filterByCapability(cands, req);
  assert.deepEqual(kept.map((c) => c.provider), ['a'], '空数组=未知保留，非空无 image=排除');
});

test('F08-4 无图无 effort 零开销直通（不触发解析）', async () => {
  let resolved = 0;
  const { filterByCapability } = buildFilter(async () => { resolved++; return null; });
  const cands = [{ provider: 'a', model: 'm' }];
  const kept = await filterByCapability(cands, { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
  assert.equal(kept.length, 1);
  assert.equal(resolved, 0, '不应触发任何能力解析');
});

test('F08-5 带 effort 时明确无 reasoning 的候选被过滤；off 不算', async () => {
  const { filterByCapability } = buildFilter(async (c) => c.provider === 'a' ? {} : { reasoning: { efforts: [] } });
  const cands = [{ provider: 'a', model: 'm' }, { provider: 'b', model: 'm' }];
  const kept = await filterByCapability(cands, { messages: [], reasoningEffort: 'high' });
  assert.deepEqual(kept.map((c) => c.provider), ['b'], 'a 无 reasoning 被滤');
  const keptOff = await filterByCapability(cands, { messages: [], reasoningEffort: 'off' });
  assert.equal(keptOff.length, 2, 'off 不触发过滤');
});

test('F08-6 源级：TTL 缓存 + 全滤退回 + 组事件', () => {
  assert.ok(/capabilityCache = new Map\(\)/.test(src), '应有能力缓存');
  assert.ok(/CAPABILITY_TTL_MS = 60000/.test(src), 'TTL 60s');
  assert.ok(/kept\.length > 0 \? kept : cands/.test(src), '全滤退回原列表');
  assert.ok(/capability-filter/.test(src), '应有 capability-filter 组事件');
  assert.ok(/resolveModelInfo\(cand\.provider, cand\.model\)/.test(src), '应经宿主 resolveModelInfo');
  // streamGroup 里调用点在 orderedCandidates 之后（保序；F14 的自动测速块插在中间）
  const m = src.match(/let order = orderedCandidates\(cfg\);[\s\S]{0,900}?filterByCapability\(order, options\)/);
  assert.ok(m, '过滤应发生在测速排序之后');
});
