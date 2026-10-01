// 任务通道去重与叶写回归测试（0.3.12）
//
// 事故：客户端「等待测试结果超时：host 可能未处理该请求」。
// 真实成因不是 host 没处理，而是两件事叠加：
//   A) 去重 guard 用数值大小推断：last = Math.max(lastTestHandledNonce, claimedNonce)。
//      两个 nonce 都是随机 53-bit，「上一轮 > 本轮」时（≈50%）判等失效 →
//      同一 testRequest 在每次 loader/volatile-update（包括宿主自己每 5s 的 digest 回写）
//      被重新消费：重复上游请求（真实计费），且多次执行的结果写进同一条目。
//      线上物证：同 nonce 一条记录同时带 `code TIMEOUT / 60000ms` 与 `ok:true / text`
//      （单次执行不可能）。
//   B) 整树读-改-写回灌：落后一拍的内存快照把终态改回 running，深合并保留
//      finishedAt/code/error → 客户端只认 status 就永远等不到终态 → 66s giveUp。
//
// 本文件用真实导出（src/index.js 的 shouldConsumeNonce / nonceKey / settledNonceKey）
// 断言 A 的判定表，并用源级断言锁住 B 的修法（叶写）与客户端的终态识别。
const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')
let passed = 0, failed = 0
const t = (name, cond) => { cond ? passed++ : (failed++, console.log('  FAIL:', name)) }

const srcIndex = fs.readFileSync(__dirname + '/../src/index.js', 'utf8')
const srcClient = fs.readFileSync(__dirname + '/../src/client.js', 'utf8')

async function main() {
  const mod = await import(pathToFileURL(path.join(__dirname, '../src/index.js')).href)
  const { shouldConsumeNonce, nonceKey, settledNonceKey } = mod
  t('E1 导出纯判定函数', typeof shouldConsumeNonce === 'function' && typeof nonceKey === 'function' && typeof settledNonceKey === 'function')

  // ── A. 判定表（真实导出，不是复制实现）────────────────────────────────────
  const base = { consumed: new Set(), key: null, claimed: null, settled: null, hasTerminal: false }

  // A1（事故核心）：上一轮 nonce 比本轮大，也必须去重 —— 旧 Math.max 实现正是在这里失效。
  {
    const prevBigger = 8000000000000000 // 上一轮已结算（安全整数范围内）
    const current = 424242424242 // 本轮
    const claimed = String(current)
    t('A1 本轮 < 上一轮时仍判定为「不消费」（旧实现在此失效）',
      shouldConsumeNonce({ ...base, key: String(current), claimed, settled: String(prevBigger) }) === false)
    t('A1b 新一轮 nonce 正常消费',
      shouldConsumeNonce({ ...base, key: String(prevBigger + 1), claimed, settled: String(prevBigger) }) === true)
  }
  // A2: 已认领（in-flight）→ 不消费
  t('A2 已认领的 nonce 不重复消费',
    shouldConsumeNonce({ ...base, key: '777', claimed: '777', settled: null }) === false)
  // A3: 已消费集合命中 → 不消费
  t('A3 已消费集合命中不重复消费',
    shouldConsumeNonce({ ...base, key: '777', consumed: new Set(['777']) }) === false)
  // A4: 已结算的持久值命中 → 不消费
  t('A4 已结算 nonce 不重复消费',
    shouldConsumeNonce({ ...base, key: '777', settled: '777' }) === false)
  // A5: 已有终态结果 → 不消费（即使认领/结算都没记录）
  t('A5 已存在终态结果不重复消费',
    shouldConsumeNonce({ ...base, key: '777', hasTerminal: true }) === false)
  // A6: 全新 nonce → 消费
  t('A6 全新 nonce 消费', shouldConsumeNonce({ ...base, key: '777' }) === true)
  // A7: 非法 nonce → 不消费
  t('A7 非法 nonce 不消费',
    shouldConsumeNonce({ ...base, key: null }) === false && shouldConsumeNonce({ ...base, key: undefined }) === false)
  // A8: 类型混用（UUID 字符串 vs 数字）按字符串键严格比较
  {
    const uuid = '4da347c2-6996-41fc-884a-f0fc719da1b4'
    t('A8 字符串 UUID 与数字 nonce 不互相污染',
      nonceKey(uuid) === uuid && nonceKey(42) === '42' && nonceKey({}) === null
      && shouldConsumeNonce({ ...base, key: uuid, claimed: '42', settled: '7' }) === true)
  }
  // A9: schema 默认值 0 代表「从未处理」，不能当真实 nonce
  t('A9 默认值 0 视为未结算',
    settledNonceKey(0) === null && settledNonceKey('0') === null && settledNonceKey(5) === '5' && settledNonceKey(undefined) === null)
  // A10: 键顺序无关（Set 语义）
  t('A10 消费集合判定与插入顺序无关',
    shouldConsumeNonce({ ...base, key: '1', consumed: new Set(['2', '1']) }) === false)

  // ── A'. 源级：旧 guard 不得复活 ────────────────────────────────────────────
  t('A11 不再使用 Math.max 做 nonce 判等', !/Math\.max\(\s*lastNum/.test(srcIndex))
  t('A12 测试与测速都走同一判定函数',
    (srcIndex.match(/shouldConsumeNonce\(\{ consumed: consumedTestNonces/g) || []).length === 1
    && (srcIndex.match(/shouldConsumeNonce\(\{ consumed: consumedSpeedNonces/g) || []).length === 1)
  t('A13 释放认领时同时释放已消费集合（notReady 重放才可能成功）',
    (srcIndex.match(/releaseConsumed\(consumedTestNonces, reqKey\)/g) || []).length >= 1
    && (srcIndex.match(/releaseConsumed\(consumedSpeedNonces, speedKey\)/g) || []).length >= 2)

  // ── B. 源级：叶写 + 客户端终态识别 ────────────────────────────────────────
  t('B1 host 单键叶写 API 存在并被结果写入使用',
    srcIndex.includes('const writeHealthLeaf = (path, value)') && srcIndex.includes("writeHealthLeaf(['testResults', key], value)"))
  t('B2 host 不再整树回写 health', !srcIndex.includes('const next = Object.assign({}, cur, patch)'))
  t('B3 client 不再 describe 快照 + 整树回写',
    !srcClient.includes('Object.assign({}, health, patch)') && !srcClient.includes('remote.settings.update(NS_MCM, { health }'))
  t('B4 client health 写走 path-ops',
    srcClient.includes("path: ['health', k]") && srcClient.includes('remote.settings.mutate(NS_MCM, ops, expected)'))
  t('B5 client 终态识别包含 finishedAt（僵尸条目也能出真实错误）',
    srcClient.includes("e.status === 'error' || e.finishedAt"))
  t('B6 client 放弃提示区分「仍在执行」与「未写入结果」',
    srcClient.includes('POLL_TIMEOUT_RUNNING') && srcClient.includes('host 未写入结果'))
  t('B7 client 降级 nonce 落在安全整数范围',
    !srcClient.includes('Date.now() * 1000 + nonceFallbackCounter') && srcClient.includes('Number.MAX_SAFE_INTEGER'))

  console.log('\n' + passed + ' passed, ' + failed + ' failed')
  process.exit(failed > 0 ? 1 : 0)
}
main()
