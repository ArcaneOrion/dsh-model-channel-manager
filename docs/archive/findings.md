# 审计发现与依据

## 初始状态
- 工作目录：`/home/arcaneorion/AI/AI-DSH/plugin/model-channel-manager`。
- 初始 `git status --short` 为空。
- 当前目录包含 README、package.json、cordis.patch.yml、两个 src JavaScript 文件、7 个测试文件以及开发经验文档。
- 从根目录至当前目录未发现实体 AGENTS.md；遵循会话提供的中文、第一性原理、证据与 NixOS/uv 约束。

## 待确认
- 用户所说的 DeepSeek harness Cordis 是否覆盖宿主整体；先读取当前模块和上层项目文档确定实际关系。

## 功能与架构初步核对
- 当前仓库是独立的 `@arcaneorion/dsh-model-channel-manager`（审计时线上发布版为 0.1.0；本地已抬到 0.2.0，尚未发布），host 928 行、client 1414 行、7 个测试文件 600 行。
- README 承诺：供应商/模型编辑，虚拟 roundrobin 路由，sticky/round-robin/primary 调度，重试/超时/冷却，测速排序，7 天健康统计，真实模型测试，旧配置迁移与 Cordis 热生命周期。
- 文档明确依赖 DSH settings、llm 和 web connection/slots；自建 settings 命名空间依赖宿主 apiproxy 白名单补丁。
- README 与 DEVELOPMENT-EXPERIENCE 对 compat 是否只支持两字段存在直接矛盾；需以实际加载的宿主包为准，不能据源码快照直接判断。
- 上层存在两份 harness 源码树：`AI-DSH/deepseek-harness` 和 `AI-DSH/源码/deepseek-harness`，版本差异需要核对。
- 已异步询问审计范围；等待期间审查当前插件及宿主接口。

## 待复现的实现疑点（尚非最终结论）
- 三条流消费路径（streamAttempt / measureCandidate / runModelTest）超时后 await inner.return()，未主动中止上游；异步生成器挂在 next() 时 return() 可能排队，拖住超时与切换。
- 三条流消费路径成功见到 finish 后退出，但没有 finally 关闭/排空手工迭代的 inner；需核对真实 LLM wrapper 的终结资源释放。
- 健康记录先修改 state.records、2 秒后 flush；healthScope.watch 对任意健康命名空间更新直接用落盘 records 覆盖 state.records，可能丢未 flush 记录。
- 测试请求用单槽 testRequest + 异步 lastTestHandledNonce 确认；需检验并发请求、ack 排队与重复触发。
- 模型测试的 60 秒 guard 每 chunk 重置，测速同理；文档称 60 秒超时，但是否实际仅空闲超时需验证。
- 虚模型能力全部按手填值暴露，没有与真实候选的上下文/模态/推理档位联动。
- 现有测试大量以字符串断言或复制实现为主，未直接执行完整插件生命周期与流处理。

## 环境与验证可用性
- Node.js v24.14.0；插件目录没有 node_modules、没有 npm scripts。
- 上层 harness 源码树有 node_modules；实际历史安装包位于 `AI/Agent-workerspace/pnpm-packages/node_modules/.pnpm`，后续核对该处 rc.2 接口。
- 安装包：Cordis 4.0.2、schemastery 3.18.2、dsh-llm/dsh-settings/dsh-llm-pi-ai 0.1.1-rc.2、cordis-plugin-timer 1.1.4。
- 基线：`node --test tests/*.test.cjs` 7/7 文件通过；`node --check src/index.js` 和 client.js 均通过。

## 完整源码第一遍发现
- client.js:602 的 onDragStart 调用 setDragIdx(idx)/String(idx)，但 map 解构参数只有 name/p/realIdx；idx 未定义。现有拖拽持久化/搜索测试未触发此实际事件。
- save() 同时发起两个命名空间写入（1329-1359），没有跨命名空间事务/补偿，也没传宿主已支持的 expectedRevision；部分成功会导致 provider 与引用组不一致。
- refresh() 只在 prev 为假时初始化 draft/channelsDraft（1196/1199），手动刷新不能重建已存在草稿；保存全量重写可覆盖其他页面的新修改。
- 初次 describe 未完成时保存按钮仍可点：draft=null 跳过 provider 更新，但 p2 将 channelsDraft=null 当 groups=[] 写回。
- 自动测速 UI 只设置 enabled（930）；host 仅 boot 且 onFirstUse=true 时触发（883），新建组没有 onFirstUse，常规 streamGroup 不测速。
- provider 改名只更新组主 candidates（1152-1156），未更新 presets 内的候选引用；宿主实际优先使用 activePreset（152-158）。
- 健康存储实际按 provider 只保留最近 300 条（265-274），非文档称的每组 2000；7d 页 cutoff=0，静默渠道记录过期后仍可统计。
- settings 服务实际提供 validate、expectedRevision 与异步有序 watcher；需要在复現里使用真实该服务，避免复制实现掩盖问题。

## 真实运行时离线复现（第一批）
- H01：同一假适配器直接请求执行 finally，经过虚拟路由后 finally 未执行；下游只有一个 finish，说明缺陷是内层流终结而非双 finish。
- H02：timeoutMs=15ms，80ms 后请求未结束且只调用 first；释放 first 的等待后才调用 second，证明超时 catch 等待 return 阻塞 failover。
- H03：一次成功直连请求后、2s flush 前更新 testResults，最终 records=0。
- H04：主动取消虚拟请求，下游正确收到 aborted，但健康记录仍留下 ok=false/code=ABORTED。
- H05：实际 DSH settings 写队列并发提交 nonce 101/102，模型执行次数为 one=1、two=4，总 5 次。
- H06：非推理候选直连成功；虚拟模型默认 reasoning=true 强行添加 medium，导致 CHANNEL_FULL_FAIL，真实候选未执行。
- H07：speedTest.enabled=true，boot 与首次请求都未触发测速（无 onFirstUse）；只发生 1 次正常模型请求，speedResults 为空。
- H08：非法 ID + 两个重复 ID 保存被接受，settings 有 3 组而路由只有 1 组。
- H09：直接同适配器调用保留 assistant.source.replayState，虚拟路由调用丢失；宿主 forAdapter 按 adapter identity 去除跨适配器重放数据。
- H10：测速两候选全部失败，speedResults 已保存，但 runtime.cooldowns=[]、lastSpeedTestAt=0（保存发生在完成更新前）。
- H11：卸载插件后虚拟路由和命名空间正常移除，但运行中的模型测试未取消，完成后仍尝试向已卸载 settings 写结果。
- 以上使用原始 host 代码（仅替换 schemastery import 路径）、实际 Cordis/LLM/settings/timer，模型/存储为假流/内存；没有运行真实端点请求。

## 前端实际事件函数复现（第一批）
- C01：拖拽回调抛 ReferenceError: idx is not defined。
- C02：原模型 reasoningEfforts:false 保存后变成 {id:'m'}，合法显式关闭语义被删。
- C03：刷新读到 displayName='new elsewhere'，draft 仍为 old，保存发送 old 且无 expectedRevision。
- C04：数据加载前点击保存直接提交 groups=[]。
- C05：改名同步主候选但 activePreset 内 provider 仍为旧 ID。
- C06/C07：settings RPC 返回 result.ok=false，模型测试仍显示 running、测速仍显示 sent。
- C08：仅有 apiKeyEnv 的 catalog provider 保存被改写为 api=openai-completions、models=[]。已核对宿主：models=[] 与缺省都继承 catalog，不能称为清空模型；确认的问题是强改协议，request.api 在 materialize 时优先于 catalog API。
- C09：30 天前的记录在「近 7 天」页面仍被计入。
- 执行原始 client.js，经 ModuleLoader/slots 取真实组件，hook/DOM/API 是最小替身；不是浏览器端到端验证。

## 文档与版本纠偏
- 安装 rc.2 的 PiAiCompatProfile 确实公开 20 项，reasoningEfforts 接受 false；sendSessionAffinityHeaders 仍为 withhold，不属于 20 项。
- 这份安装 rc.2 apiproxy 的 settingsDescribe 返回全部已注册 namespace、settingsWrite 没有 exposedNamespaces 白名单；README 的必须打该补丁说法不适用于此安装包。未据此提出缺补丁故障。

## 补充验证
- H12：测速 timeoutMs=40，流每 20ms 输出，84ms 后成功；该超时实际仅每次 next 的等待上限，不是总时限。
- H13：两个并发 round-robin 请求同时选择 first；指针在完成后才前进，不能实现并发均分。
- H15：旧配置读取暂缓期间用户保存 new-user-group 和 providerOrder；迁移继续后用 replace 覆盖为 legacy、providerOrder 变空，确认写前未重检。
- H14：补齐假适配器 name 后复现成功：虚模型声明 image，first 声明纯文本、second 支持 image；实际只调用 first，图片变为 `[image omitted because this model accepts text only...]`，最终 stop 成功，second 未调用。
- C10：供应商保存 RPC 被拒绝，轮询组 RPC 仍提交成功；返回统一「保存失败」，已提交的引用没有回滚。
- 测试依赖 yaml 从用户另一项目 .pnpm/yaml@2.9.0 解析，当前 package.json 未声明该测试依赖。

## 正常行为对照
- V01：串行 sticky/primary 均保持 first；串行 round-robin 得到 first/second/first。
- V02：首内容前失败能干净切换，只向下游交付 fallback 文本和一个成功 finish。
- V03：已交付内容后失败不会调用第二候选，只交付一个失败 finish。
- V04：prepareCall 后修改组配置，已准备的请求仍使用旧候选与原 contextWindow，组级快照一致性通过。
- V05：组清空、新增与插件卸载能正确维护路由；卸载后 settings 命名空间同时移除。
- V06：没有交错 settings 写时，一次直连成功能在节流后保存一条健康记录，是 H03 的对照。

## 当前证据汇总
- 31 个执行探针：25 个问题现象、6 个正常行为对照；问题现象将在报告按根因合并，不能当作 25 个独立缺陷。
- 可机读证据：docs/audit/results.json，包含运行时版本、Git commit、源文件 SHA-256、验证方法与全部观测。
- 源码快照 commit：7b83c31（完整值见 results.json）。
- 最终报告对齐外部新提交 19ed51d；H06 已重跑，当前错误档位为 max。其他结论经差分核对仍成立。
- 报告按根因归并为 19 项（9 P1、10 P2），详见 docs/AUDIT-2026-09-06.md；results.json 记录了起始/最终提交和外部变更的复核方法。
