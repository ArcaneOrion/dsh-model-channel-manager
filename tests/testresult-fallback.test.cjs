// testResults 写入策略回归测试：mutate 失败/未生效 → 回退 update 合并写
// 根因：部分运行时（rc.2 file provider）静默拒绝 mutate（promise 正常 resolve 但
// 条目不落盘），旧代码 .catch(() => {}) 吞掉 → client 轮询 66s 报 POLL_TIMEOUT。
const fs = require('fs')
let passed = 0, failed = 0
const t = (name, cond) => { cond ? passed++ : (failed++, console.log('  FAIL:', name)) }

// 静态断言：吞错不再存在、回读校验与兜底存在
{
  const src = fs.readFileSync(__dirname + '/../src/index.js', 'utf8')
  t('S1 mutate 未生效日志', src.includes('testResults mutate 未生效'))
  t('S2 update 合并兜底存在', src.includes('testResults update 兜底写入失败'))
  t('S3 回读校验存在', src.includes("|| {})[key]"))
  // testResults 写入区段不再有静默吞错（其他流程的吞错不在本断言范围）
  const seg = src.slice(src.indexOf('const setResult'), src.indexOf('const done'))
  t('S4 结果写入区段无静默吞错', !seg.includes('.catch(() => { })'))
}

// 复刻 writeResult 语义（store 可注入 mutate 行为）
function makeWriter(mutateImpl) {
  let mutateWorks = null
  const store = { testResults: {} }
  const updates = []
  const settings = {
    mutate: async (ns, ops) => mutateImpl(store, ops),
    update: async (ns, patch) => { updates.push(patch); if (patch.testResults) store.testResults = patch.testResults },
  }
  const scope = { get: () => ({ testResults: store.testResults }) }
  const bus = { healthScope: scope }
  const writeResult = async (key, value) => {
    const cur = (bus && bus.healthScope ? bus.healthScope.get().testResults : null) || {}
    if (mutateWorks !== false) {
      try {
        await settings.mutate('ns', [{ op: 'set', path: ['testResults', key], value }])
        const landed = ((bus && bus.healthScope ? bus.healthScope.get().testResults : null) || {})[key]
        if (landed) { mutateWorks = true; return }
        mutateWorks = false
      } catch (e) {
        mutateWorks = false
      }
    }
    await settings.update('ns', { testResults: Object.assign({}, cur, { [key]: value }) }).catch(() => {})
  }
  return { writeResult, store, updates }
}

const entry = { status: 'running', startedAt: 1, nonce: 42, provider: 'p', model: 'm' }

async function main() {
  // F1: mutate 正常落盘 → 不走兜底
  {
    const w = makeWriter((store, ops) => { for (const op of ops) store.testResults[op.path[1]] = op.value })
    await w.writeResult('42', entry)
    t('F1 mutate 生效直接落盘且不走 update', w.store.testResults['42'] && w.store.testResults['42'].status === 'running' && w.updates.length === 0)
  }
  // F2: mutate 静默拒绝（resolve 但不落盘）→ update 兜底落盘
  {
    const w = makeWriter(() => Promise.resolve())
    await w.writeResult('42', entry)
    t('F2 兜底后条目落盘', w.store.testResults['42'] && w.store.testResults['42'].status === 'running')
    t('F2 兜底走了一次 update', w.updates.length === 1)
    // F3: 兜底合并保留其他条目
    w.store.testResults['old'] = { status: 'error' }
    await w.writeResult('43', entry)
    t('F3 合并保留既有条目', w.store.testResults['old'] && w.store.testResults['43'])
  }
  // F4: mutate 抛错 → 同样回退
  {
    const w = makeWriter(() => Promise.reject(new Error('mutate rejected')))
    await w.writeResult('44', entry)
    t('F4 mutate 抛错也兜底落盘', w.store.testResults['44'] && w.updates.length === 1)
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed')
  process.exit(failed > 0 ? 1 : 0)
}
main()
