// 轮询组输入模态回归测试（静态断言，同 adapter-contract 风格）
// 根因：轮询组虚拟模型 input 默认 ['text'] 且面板无编辑入口——host 在附加/发送
// 图片时对当前会话模型做 resolveModelInfo，inputModalities 缺 image 即拒
// （apiproxy api-proxy.ts MODEL_DOES_NOT_SUPPORT_IMAGES），即使候选模型全支持图片。
const fs = require('fs')
let passed = 0, failed = 0
const t = (name, cond) => { cond ? passed++ : (failed++, console.log('  FAIL:', name)) }

const src = fs.readFileSync(__dirname + '/../src/client.js', 'utf8')

// T1: 新建组默认模态含 image
t('T1 新建组默认 input 含 image', /input:\s*\['text',\s*'image'\]/.test(src))
// T2: 组编辑器存在输入模态控件（image 勾选写 virtualModel.input）
t('T2 编辑器存在 image 勾选', src.includes("'image（图片/视觉）'"))
t('T3 勾选写入 virtualModel.input', /patchGroupPath\(i,\s*\['virtualModel',\s*'input'\]/.test(src))
// T4: 不勾图片时回落纯文本（保底语义与 normalizeConfig 校验一致）
t('T4 关闭图片回落 [text]', /'text'\]\s*:\s*\['text'\]/.test(src.replace(/\s+/g, ' ')) || src.includes("? ['text', 'image'] : ['text']"))


// T5: 命名单一身份——呈现名字段已删除，save 归一化 virtualModel.name = 组 id
t('T5a 编辑器不再有呈现名字段', !src.includes('虚拟模型呈现名'))
t('T5b save 归一化 name = 组 id', src.includes('virtualModel: Object.assign({}, g.virtualModel, { name: g.id })'))
t('T5c 卡片标题显示组 id', src.includes("el('span', null, g.id)"))

console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed > 0 ? 1 : 0)
