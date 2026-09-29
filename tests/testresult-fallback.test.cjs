// testResults 写入策略回归测试（dsh 0.2 版）
//
// 0.1 的策略是「先 mutate path-ops，回读校验，未生效再 update 合并兜底」。
// 0.2 的 settings 既没有 path-ops、也拿不到自建命名空间，改为同一 Config 的 health 子树整字段写：
//   * 每次写入先读当前值再合并（read-modify-write），未被本次 patch 覆盖的字段必须保留；
//   * 并发写入串行化，避免两次写入各自基于同一份旧快照互相覆盖；
//   * 写入必须切出 HMR 事务（loader/volatile-update 回调本身就在事务里，
//     直接写会抛 "HMR transactions cannot be nested"）。
// 本文件断言这三条仍在，且旧的 mutate/回退分支不再残留。
//
// 语义边界：串行化只保证「patch 未提及的字段」不被旧快照覆盖；
// 调用方若把整段 testResults 读出来再整段写回，同一子对象仍是后写者胜——
// 这正是 host 侧用 claimedTestNonce 去重、并把写入收敛到单点队列的原因。
const fs = require('fs')
let passed = 0, failed = 0
const t = (name, cond) => { cond ? passed++ : (failed++, console.log('  FAIL:', name)) }

const src = fs.readFileSync(__dirname + '/../src/index.js', 'utf8')

// ── 静态断言：0.2 的写入路径形状 ──────────────────────────────────────────────
t('S1 写入统一走 bus.writeHealth', src.includes('const writeHealth = (patch)'))
t('S2 写入串行化（healthWrites 队列）', src.includes('healthWrites'))
t('S3 事务外写入（outsideTransaction / als.exit）',
  src.includes('outsideTransaction') && src.includes('als.exit'))
t('S4 结果写入先读后合并', src.includes('const cur = healthOf().testResults || {}'))
t('S5 旧的 mutate 回退分支已移除', !src.includes('testResults mutate 未生效'))
t('S6 结果写入区段无静默吞错', (() => {
  const start = src.indexOf('const setResult')
  const end = src.indexOf('const done')
  if (start < 0 || end < 0) return false
  return !src.slice(start, end).includes('.catch(() => { })')
})())

// ── 行为断言：复刻 writeHealth 的队列 + 合并语义 ─────────────────────────────
// 与 host 实现同构：调用 settings.update(ns, { health: <整段> })，写入前重读当前 health。
function makeSerializedWriter(initialHealth, delayMs) {
  const store = { health: Object.assign({}, initialHealth) }
  let queue = Promise.resolve()
  const writes = []
  const settings = {
    update: async (_ns, patch) => {
      await new Promise((r) => setTimeout(r, delayMs))
      // 真实实现写的是 health 子树整体，故取 patch.health。
      store.health = patch.health
      writes.push(patch.health)
    },
  }
  const healthOf = () => store.health
  const writeHealth = (patch) => {
    const run = async () => {
      const cur = healthOf()
      const next = Object.assign({}, cur, patch)
      return settings.update('model-channel-manager', { health: next })
    }
    const queued = queue.then(run, run)
    queue = queued.catch(() => {})
    return queued
  }
  return { writeHealth, store, writes, healthOf }
}

async function main() {
  // F1: 并发写「不同字段」→ 两者都要在（串行合并，而不是整段覆盖）
  {
    const w = makeSerializedWriter({}, 20)
    await Promise.all([
      w.writeHealth({ lastTestHandledNonce: 11 }),
      w.writeHealth({ legacyMigrated: true }),
    ])
    t('F1 并发写不同字段都落盘',
      w.store.health.lastTestHandledNonce === 11 && w.store.health.legacyMigrated === true)
    t('F1 两次写入都被排队执行', w.writes.length === 2)
  }
  // F2: 合并写保留 patch 之外的既有字段
  {
    const w = makeSerializedWriter({ legacyMigrated: true, records: { p: [] } }, 1)
    await w.writeHealth({ lastTestHandledNonce: 7 })
    t('F2 保留既有 health 字段',
      w.store.health.legacyMigrated === true
      && w.store.health.lastTestHandledNonce === 7
      && Array.isArray(w.store.health.records.p))
  }
  // F3: 串行累积（真实用法：每个 nonce 写一次，读的是刚写过的值）→ 两个条目都在
  {
    const w = makeSerializedWriter({ testResults: {} }, 5)
    await w.writeHealth({ testResults: Object.assign({}, w.healthOf().testResults, { 42: { status: 'running' } }) })
    await w.writeHealth({ testResults: Object.assign({}, w.healthOf().testResults, { 43: { status: 'ok' } }) })
    const tr = w.store.health.testResults || {}
    t('F3 顺序写同一子对象不丢条目', !!tr['42'] && !!tr['43'])
  }
  // F4: 并发 5 次写不同字段 → 全部保留（串行化的价值）
  {
    const w = makeSerializedWriter({}, 3)
    await Promise.all([1, 2, 3, 4, 5].map((n) => w.writeHealth({ ['k' + n]: n })))
    const ok = [1, 2, 3, 4, 5].every((n) => w.store.health['k' + n] === n)
    t('F4 并发 5 次不同字段写入全部保留', ok)
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed')
  process.exit(failed > 0 ? 1 : 0)
}
main()
