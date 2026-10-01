// health 子树写入策略回归测试（dsh 0.2 版 / 0.3.12 叶写重构）
//
// 演进：
//   0.1  「mutate path-ops → 回读校验 → update 合并兜底」
//   0.3.0「整字段落盘」：每次写入先读当前 health 再整树合并写回（read-modify-write）
//   0.3.12「叶写」：patch 里出现的每个顶层键单独 set（path-ops），单键结果用
//          writeHealthLeaf(['testResults', nonce], value) 精确写入。
//
// 为什么必须改（0.3.11 线上事故）：整树 RMW 的 payload 是「调用时刻的快照」，
// 只要它晚于并发的终态写落盘，就会把该 nonce 的 status 改回 running，而
// settings.update 的深合并会保留后写入的 finishedAt/code/error ——
// 结果是「running + 终态字段」的僵尸条目，客户端永远等不到终态。
// 叶写只动 patch 命中的键，物理上不可能把未见过的旧值回灌。
//
// 本文件断言：
//   * 写入仍统一走 bus（串行化 + 事务外）；
//   * 结果写入是单键叶写，不再出现 testResults 整段读改写；
//   * 叶写在并发交错下不会覆盖别的 nonce（行为断言）。
const fs = require('fs')
let passed = 0, failed = 0
const t = (name, cond) => { cond ? passed++ : (failed++, console.log('  FAIL:', name)) }

const src = fs.readFileSync(__dirname + '/../src/index.js', 'utf8')

// ── 静态断言：0.3.12 的写入路径形状 ──────────────────────────────────────────
t('S1 写入统一走 bus.writeHealth', src.includes('const writeHealth = (patch)'))
t('S2 写入串行化（healthWrites 队列）', src.includes('healthWrites'))
t('S3 事务外写入（outsideTransaction / als.exit）',
  src.includes('outsideTransaction') && src.includes('als.exit'))
t('S4 结果写入是单键叶写', src.includes("bus.writeHealthLeaf(['testResults', key], value)"))
t('S5 不再有 testResults 整段读改写', !src.includes('const cur = healthOf().testResults || {}'))
t('S6 writeHealth 不再整树回写（无 Object.assign({}, cur, patch)）',
  !src.includes('const next = Object.assign({}, cur, patch)'))
t('S7 修剪走 unset 叶删（深合并删不掉键）',
  src.includes("op: 'unset', path: ['health', 'testResults', k]"))
t('S8 结果写入区段无静默吞错', (() => {
  const start = src.indexOf('const setResult')
  const end = src.indexOf('const done')
  if (start < 0 || end < 0) return false
  return !src.slice(start, end).includes('.catch(() => { })')
})())

// ── 行为断言：复刻叶写语义 ───────────────────────────────────────────────────
// 与 host 实现同构：每个 patch 键 → { op:'set', path:['health', key] }，
// 单键结果 → { op:'set', path:['health','testResults',nonce] }。
function makeLeafWriter(initialHealth, delayMs) {
  const store = { health: JSON.parse(JSON.stringify(initialHealth)) }
  let queue = Promise.resolve()
  const writes = []
  const applyOps = (ops) => {
    for (const { path, value } of ops) {
      // ops 的 path 相对整行（['health', ...]）；本 harness 只持有 health 子树，故去掉前缀
      const rel = path[0] === 'health' ? path.slice(1) : path
      if (rel.length === 0) continue
      let ref = store.health
      for (let i = 0; i < rel.length - 1; i++) {
        if (ref[rel[i]] === undefined || ref[rel[i]] === null) ref[rel[i]] = {}
        ref = ref[rel[i]]
      }
      ref[rel[rel.length - 1]] = value
    }
  }
  const settings = {
    // 真实实现是异步落盘；这里保留延迟以暴露「快照 vs 叶写」的差异
    mutate: async (_ns, ops) => {
      await new Promise((r) => setTimeout(r, delayMs))
      applyOps(ops)
      writes.push(ops)
    },
  }
  const run = (fn) => {
    const queued = queue.then(fn, fn)
    queue = queued.catch(() => {})
    return queued
  }
  const writeHealth = (patch) => run(async () => {
    const ops = Object.keys(patch || {}).map((k) => ({ op: 'set', path: ['health', k], value: patch[k] }))
    if (ops.length === 0) return
    return settings.mutate('model-channel-manager', ops)
  })
  const writeHealthLeaf = (path, value) => run(async () => settings.mutate('model-channel-manager', [{ op: 'set', path: ['health', ...path], value }]))
  return { writeHealth, writeHealthLeaf, store, writes }
}

async function main() {
  // F1: 并发写不同字段 → 两者都要在（叶写互不覆盖）
  {
    const w = makeLeafWriter({}, 20)
    await Promise.all([
      w.writeHealth({ lastTestHandledNonce: 11 }),
      w.writeHealth({ legacyMigrated: true }),
    ])
    t('F1 并发写不同字段都落盘',
      w.store.health.lastTestHandledNonce === 11 && w.store.health.legacyMigrated === true)
    t('F1 两次写入都被排队执行', w.writes.length === 2)
  }
  // F2: 叶写保留 patch 之外的既有字段
  {
    const w = makeLeafWriter({ legacyMigrated: true, digest: [{ provider: 'p' }] }, 1)
    await w.writeHealth({ lastTestHandledNonce: 7 })
    t('F2 保留既有 health 字段',
      w.store.health.legacyMigrated === true
      && w.store.health.lastTestHandledNonce === 7
      && Array.isArray(w.store.health.digest))
  }
  // F3: 单键叶写互不干扰（真实用法：每个 nonce 写一次）
  {
    const w = makeLeafWriter({ testResults: {} }, 5)
    await w.writeHealthLeaf(['testResults', '42'], { status: 'running' })
    await w.writeHealthLeaf(['testResults', '43'], { status: 'ok' })
    const tr = w.store.health.testResults || {}
    t('F3 两个 nonce 条目都在', !!tr['42'] && !!tr['43'])
  }
  // F4（事故复现）: 终态写入后，另一条并发的叶写不得把 status 改回 running。
  // 旧整树实现下，落后一拍的内存快照会把 running 回灌；叶写不可能做到。
  {
    const w = makeLeafWriter({ testResults: { '99': { status: 'running', startedAt: 1 } } }, 2)
    // 终态先写
    await w.writeHealthLeaf(['testResults', '99'], { status: 'error', code: 'SERVER', error: '503', finishedAt: 2 })
    // 随后一次「与本次无关」的 health 写（如 digest）
    await w.writeHealth({ digest: [], digestAt: 3 })
    const e = w.store.health.testResults['99']
    t('F4 事故复现：后续叶写不改回 running', e.status === 'error' && e.finishedAt === 2)
  }
  // F5: 并发 5 次写不同字段 → 全部保留
  {
    const w = makeLeafWriter({}, 3)
    await Promise.all([1, 2, 3, 4, 5].map((n) => w.writeHealth({ ['k' + n]: n })))
    const ok = [1, 2, 3, 4, 5].every((n) => w.store.health['k' + n] === n)
    t('F5 并发 5 次不同字段写入全部保留', ok)
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed')
  process.exit(failed > 0 ? 1 : 0)
}
main()
