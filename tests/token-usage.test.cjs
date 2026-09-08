// Token 用量统计回归测试（离线复刻 + 源码锚点）
// 覆盖：
//   T1: usage StreamChunk 捕获逻辑（pi-ai done/error 两种序列，lastUsage 取最后一个）
//   T2: recordHealth 展平——有 usage 写 token 字段、无 usage 不写、非法字段忽略
//   T3: 客户端窗口聚合——计费口径 input+cacheRead+cacheWrite+output、旧记录按 0、与请求数同记录
//   T4: 源码锚点——host/client 的接线存在（防接线静默漂移）
const fs = require('node:fs')
const path = require('node:path')

let passed = 0, failed = 0
const t = (name, cond) => { cond ? passed++ : (failed++, console.log('  FAIL:', name)) }

// ---- 复刻：chunk 流中的 usage 捕获（与 src/index.js streamAttempt / 拦截器一致） ----
function captureUsage(chunks) {
  let lastUsage = null
  for (const chunk of chunks) {
    if (chunk && chunk.type === 'usage' && chunk.usage && typeof chunk.usage === 'object')
      lastUsage = chunk.usage
  }
  return lastUsage
}

// ---- 复刻：recordHealth 展平（与 src/index.js recordHealth 一致） ----
function flattenRecord(entry) {
  const rec = { ok: entry.ok, ttftMs: entry.ttftMs, latencyMs: entry.latencyMs, code: entry.code || null }
  const u = entry.usage
  if (u && typeof u === 'object') {
    if (Number.isFinite(u.inputTokens)) rec.inputTokens = u.inputTokens
    if (Number.isFinite(u.outputTokens)) rec.outputTokens = u.outputTokens
    if (Number.isFinite(u.cacheReadTokens)) rec.cacheReadTokens = u.cacheReadTokens
    if (Number.isFinite(u.cacheWriteTokens)) rec.cacheWriteTokens = u.cacheWriteTokens
    if (Number.isFinite(u.reasoningTokens)) rec.reasoningTokens = u.reasoningTokens
  }
  return rec
}

// ---- 复刻：客户端窗口聚合（与 src/client.js HealthPanel 一致） ----
function aggregate(records, now, windowMode) {
  const cutoff = windowMode === '30m' ? now - 30 * 60 * 1000 : windowMode === '24h' ? now - 24 * 3600 * 1000 : 0
  const all = records.filter((e) => (e.ts || 0) >= cutoff)
  let tokIn = 0, tokOut = 0, tokCache = 0
  for (const e of all) {
    tokIn += (e && e.inputTokens) || 0
    tokOut += (e && e.outputTokens) || 0
    tokCache += ((e && e.cacheReadTokens) || 0) + ((e && e.cacheWriteTokens) || 0)
  }
  return { requests: all.length, billed: tokIn + tokOut + tokCache, tokIn, tokOut, tokCache }
}

// ---- T1: usage 捕获 ----
{
  // pi-ai done 序列：text-delta → usage → finish
  const doneSeq = [
    { type: 'text-delta', index: 0, text: 'hi' },
    { type: 'usage', usage: { inputTokens: 120, outputTokens: 45, cacheReadTokens: 300 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  t('T1a done 序列捕获 usage', captureUsage(doneSeq)?.inputTokens === 120)
  // pi-ai error 序列：usage（部分计数）→ finish error
  const errSeq = [
    { type: 'usage', usage: { inputTokens: 80, outputTokens: 0 } },
    { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'SERVER' } } },
  ]
  t('T1b error 序列也捕获 usage（部分计数）', captureUsage(errSeq)?.inputTokens === 80)
  // 无 usage 块
  t('T1c 无 usage 块 → null', captureUsage([{ type: 'text-delta', index: 0, text: 'x' }, { type: 'finish', reason: { kind: 'stop' } }]) === null)
  // 多个 usage 块取最后一个（适配器契约：finish 前一条）
  t('T1d 多 usage 取最后一个', captureUsage([
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'usage', usage: { inputTokens: 2, outputTokens: 2 } },
  ])?.inputTokens === 2)
  // 非对象 usage 忽略
  t('T1e 非对象 usage 忽略', captureUsage([{ type: 'usage', usage: 'oops' }]) === null)
}

// ---- T2: recordHealth 展平 ----
{
  const r1 = flattenRecord({ ok: true, ttftMs: 100, latencyMs: 200, code: null, usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 1, reasoningTokens: 3 } })
  t('T2a 全部字段展平', r1.inputTokens === 10 && r1.outputTokens === 20 && r1.cacheReadTokens === 5 && r1.cacheWriteTokens === 1 && r1.reasoningTokens === 3)
  t('T2b 既有字段不受影响', r1.ok === true && r1.ttftMs === 100 && r1.latencyMs === 200 && r1.code === null)
  const r2 = flattenRecord({ ok: false, ttftMs: null, latencyMs: null, code: 'TIMEOUT' })
  t('T2c 无 usage → 不写 token 字段', !('inputTokens' in r2) && !('outputTokens' in r2) && r2.code === 'TIMEOUT')
  const r3 = flattenRecord({ ok: true, usage: { inputTokens: NaN, outputTokens: 'x', cacheReadTokens: 7 } })
  t('T2d 非法字段忽略，合法字段保留', !('inputTokens' in r3) && !('outputTokens' in r3) && r3.cacheReadTokens === 7)
}

// ---- T3: 客户端窗口聚合 ----
{
  const now = 1000 * 60 * 60 * 24 * 40 // 任意锚点
  const recs = [
    { ts: now - 10 * 60 * 1000, provider: 'a', model: 'm', ok: true, inputTokens: 100, outputTokens: 50, cacheReadTokens: 200 },
    { ts: now - 10 * 60 * 1000, provider: 'a', model: 'm', ok: false, code: 'SERVER' }, // 旧格式记录（无 token 字段）
    { ts: now - 2 * 3600 * 1000, provider: 'a', model: 'm', ok: true, inputTokens: 1000, outputTokens: 500 }, // 窗口外
    { ts: now - 40 * 60 * 1000, provider: 'b', model: 'n', ok: true, inputTokens: 10, outputTokens: 5, cacheWriteTokens: 2 },
  ]
  const r30 = aggregate(recs, now, '30m')
  t('T3a 30m 窗口请求数 = 2（-40min 记录被排除，旧记录也计请求）', r30.requests === 2)
  t('T3b 30m 计费 = 100+50+200 = 350', r30.billed === 350)
  t('T3c 30m 拆分 = in 100 / out 50 / cache 200（旧记录按 0）', r30.tokIn === 100 && r30.tokOut === 50 && r30.tokCache === 200)
  const r24 = aggregate(recs, now, '24h')
  t('T3d 24h 窗口含 -2h/-40min 记录，计费 = 350+1500+17 = 1867', r24.requests === 4 && r24.billed === 1867)
  const r7d = aggregate(recs, now, '7d')
  t('T3e 7d 全量同 24h（此数据集无 >24h 记录）', r7d.requests === 4 && r7d.billed === 1867)
}

// ---- T4: 源码锚点 ----
{
  const srcDir = path.join(__dirname, '..', 'src')
  const host = fs.readFileSync(path.join(srcDir, 'index.js'), 'utf8')
  const client = fs.readFileSync(path.join(srcDir, 'client.js'), 'utf8')
  // host：usage 捕获（streamAttempt + 拦截器两处）
  const usageCaptures = host.split("chunk.type === 'usage'").length - 1
  t('T4a host 存在 2 处 usage 捕获', usageCaptures >= 2)
  t('T4b host recordHealth 展平 inputTokens', host.includes('rec.inputTokens = u.inputTokens'))
  t('T4c host recordHealth 展平 cacheReadTokens', host.includes('rec.cacheReadTokens = u.cacheReadTokens'))
  // client：指标卡 + 聚合
  t('T4d client 存在总 Token 用量卡', client.includes("'总 Token 用量'"))
  t('T4e client 聚合 cacheRead+cacheWrite', client.includes('cacheReadTokens') && client.includes('cacheWriteTokens'))
  t('T4f client 模型卡 Tokens 行', client.includes("' · Tokens: '"))
}

console.log(`\ntoken-usage.test.cjs: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
