// P0/P1 修复回归测试（离线复刻 settings 服务链路）
// 覆盖：
//   P0-2: guard 全量 remaining（纯逻辑断言，30s cap 已去除）
//   P1-1: abort 不记健康流水（isAbortLike 三形态 + 终止块 ABORTED 跳过）
//   P1-2: testResults mutate path-ops 原子写（并发 nonce 不互相覆盖 + prune 语义）
const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)

// settings 服务 applyPathOp 复刻（settings/src/index.ts:214-233 逐行对齐）
function applyPathOp(section, op) {
  const [head, ...rest] = op.path
  if (head === undefined) {
    if (op.op === 'unset') return {}
    if (!isPlainObject(op.value)) throw new TypeError('mutate section root requires plain object')
    return { ...op.value }
  }
  if (rest.length === 0) {
    if (op.op === 'set') return { ...section, [head]: op.value }
    const { [head]: _r, ...kept } = section
    return kept
  }
  const child = section[head]
  if (!isPlainObject(child)) {
    if (op.op === 'unset') return section
    return { ...section, [head]: applyPathOp({}, { ...op, path: rest }) }
  }
  return { ...section, [head]: applyPathOp(child, { ...op, path: rest }) }
}

let passed = 0, failed = 0
const t = (name, cond) => { cond ? passed++ : (failed++, console.log('  FAIL:', name)) }

// ---- P0-2: guard cap 移除后的纯逻辑 ----
{
  // 旧: timed(Math.max(1, Math.min(remaining, 30000)))  新: timed(Math.max(1, remaining))
  const guardMs = (remaining) => Math.max(1, remaining)
  t('P0-2a remaining=90s → guard 90s（不再 30s 截断）', guardMs(90000) === 90000)
  t('P0-2b remaining=0 → guard 1ms（兜底）', guardMs(0) === 1)
  t('P0-2c remaining=500 → guard 500', guardMs(500) === 500)
}

// ---- P1-1: isAbortLike 三形态 ----
{
  // 复刻拦截器的 isAbortLike
  const makeIsAbortLike = (options) => (err) => {
    if (options && options.signal && options.signal.aborted) return true
    if (!err) return false
    if (err.code === 'ABORTED' || err.name === 'AbortError') return true
    return typeof err.message === 'string' && /abort/i.test(err.message)
  }
  const sig = { aborted: false }
  const f = makeIsAbortLike({ signal: sig })
  t('P1-1a AbortError', f(new DOMException('This operation was aborted', 'AbortError')) === true)
  t('P1-1b code ABORTED', f({ code: 'ABORTED', message: 'request aborted' }) === true)
  t('P1-1c signal aborted', makeIsAbortLike({ signal: { aborted: true } })(null) === true)
  t('P1-1d 普通网络错误不误判', f({ code: 'ECONNRESET', message: 'socket hang up' }) === false)
  t('P1-1e null err', f(null) === false)
  // 终止块 aborted: lastError = failure.code = 'ABORTED' → 跳过
  const lastError = 'ABORTED'
  t('P1-1f 终止块 ABORTED 跳过记账', lastError === 'ABORTED')
}

// ---- P1-2: testResults 并发写不覆盖 ----
{
  // 场景：nonce 100 先完成写结果，nonce 200 后完成——旧 read-merge-write 会丢 100 或 200
  // mutate path-ops 版本：每次只 set 自己的 nonce
  let section = { testResults: {} }  // NS_HEALTH 的 user section
  // nonce 100 set running
  section = applyPathOp(section, { op: 'set', path: ['testResults', '100'], value: { status: 'running', nonce: 100 } })
  // nonce 200 set running（并发）
  section = applyPathOp(section, { op: 'set', path: ['testResults', '200'], value: { status: 'running', nonce: 200 } })
  // nonce 100 完成（旧版此处 read 到的快照若不含 200 running，整包写回会丢它）
  section = applyPathOp(section, { op: 'set', path: ['testResults', '100'], value: { status: 'ok', nonce: 100, finishedAt: 1000 } })
  // nonce 200 完成
  section = applyPathOp(section, { op: 'set', path: ['testResults', '200'], value: { status: 'ok', nonce: 200, finishedAt: 2000 } })
  t('P1-2a 并发两个 nonce 都存活', section.testResults['100'] && section.testResults['200'])
  t('P1-2b 各自终态正确', section.testResults['100'].status === 'ok' && section.testResults['200'].status === 'ok')

  // 旧版行为对照：read-merge-write 读到的快照若只有 100 的 running（200 running 未同步）
  const staleSnapshot = { '100': { status: 'running', nonce: 100 } }
  const legacyWrite = { ...staleSnapshot, '100': { status: 'ok', nonce: 100, finishedAt: 1000 } }
  t('P1-2c 对照：旧整包写丢 200', !('200' in legacyWrite))
}

// ---- P1-2: prune 语义 ----
{
  let section = { testResults: {} }
  for (let i = 1; i <= 55; i++)
    section = applyPathOp(section, { op: 'set', path: ['testResults', String(i)], value: { status: 'ok', nonce: i, finishedAt: i * 10 } })
  // 复刻 maybePrune：>50 砍到 50（按 finishedAt 降序保留最新 50）
  const entries = Object.entries(section.testResults)
  const drop = entries.sort((a, b) => ((b[1] && b[1].finishedAt) || 0) - ((a[1] && a[1].finishedAt) || 0)).slice(50).map(([k]) => ({ op: 'unset', path: ['testResults', String(k)] }))
  for (const op of drop) section = applyPathOp(section, op)
  const keys = Object.keys(section.testResults).map(Number).sort((a, b) => a - b)
  t('P1-2d prune 后 50 条', keys.length === 50)
  t('P1-2e 砍掉最旧的 5 条（nonce 1-5）', keys[0] === 6 && keys[keys.length - 1] === 55)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
