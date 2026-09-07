# @arcaneorion/dsh-model-channel-manager

DSH 原生模型渠道管理。两半结构：

- **host 半** `src/index.js`：轮询故障转移引擎（`llm.registerAdapter` 虚拟路由 `roundrobin/<组id>`）+ 7 天健康流水 + 测速排序 + 单模型真实请求测试通道。
- **client 半** `src/client.js`：`conversation.view` 顶级页签「模型配置」，内含三个子页：**模型配置**（llm-pi-ai providers 全字段编辑、拉取上游、单模型 ⚡ 测试、供应商搜索过滤）、**轮询渠道**（groups 编辑 + ⚡测速 + 输入模态编辑；**命名单一身份：显示名 = 组唯一 ID**，保存时归一化 `virtualModel.name = id`，改 ID 即改名，永不漂移）、**健康统计**（7 天聚合）。
- **会话模型选择器已拆出**为独立 cordis client 插件 [`@arcaneorion/dsh-model-selector-search`](../model-selector-search/)（一个占座者一个插件单元，可独立启停/替换；座位遮蔽 + 搜索 + 近 7 天置顶 + 菜单向上展开都在该仓）。

语义参考 pi 的 `pi-provider-manager`，但完全走 DSH 原生 seam（无独立 HTTP 服务/端口/token）：

| pi-provider-manager | 本项目（DSH 原生） |
| --- | --- |
| 自建 127.0.0.1 HTTP 面板 + token | `conversation.view` 页签（client 半，静态 bundle） |
| `models.json` / `roundrobin/config.json` + 自写原子写/bak | `settings` 服务命名空间 `model-channels`（配置）/ `model-channel-health`（健康+运行态+测试结果） |
| 轮询 provider（自实现 HTTP 转发） | `ctx.llm.registerAdapter(['roundrobin/<组>'])`，引擎内嵌套 `ctx.llm.stream({provider:候选})` 转发 |
| 健康 JSONL | `model-channel-health.records`（settings 总线，跨会话共享） |
| 保存即热重载（自建事件） | settings watcher → 热重建虚拟路由（原生） |
| 面板模型测试（本地 HTTP 转发） | `model-channel-health.testRequest` 哨 → host 走**真实** `llm.stream` → `testResults[nonce]` 回写 |

## 挂载

`profiles/web/package.json`：
- `dependencies` 加 `"@arcaneorion/dsh-model-channel-manager": "link:/home/arcaneorion/AI/AI-DSH/plugin/model-channel-manager"`
- `dsh.profile.bundles` 加 `"@arcaneorion/dsh-model-channel-manager"`
- `pnpm install` 后重启 `dsh --profile web`

验证：
- host 日志出现 `[model-channel-manager] booted, groups: ...`
- `llm.providers` 出现 `roundrobin/<组id>`
- settings describe 含 `model-channels` / `model-channel-health` 命名空间

## 数据通道（全走公共 seam，无私有 RPC）

- 读配置/健康/运行态 = `api.settings.describe()` 过滤命名空间
- 保存 provider = `api.settings.update({ns:'llm-pi-ai', patch:{providers}})`
- 保存轮询组 = `api.settings.update({ns:'model-channels', patch:{groups}})`
- ⚡测速 = `api.settings.update({ns:'model-channel-health', patch:{speedRequest:{group,nonce}}})`（host watcher 消费）
- 单模型测试 = `settings.update({ns:'model-channel-health', patch:{testRequest:{nonce,provider,model,prompt,maxTokens}}})`；host 执行真实 `llm.stream` 后把结果写回 `testResults[nonce]`；client 轮询 describe 直到 ok/error
- `apiRef` 获取：`ctx.get('connection').api`（static client 必须在 `inject` 里声明 `connection`，apply 时捕获进闭包）

> **宿主边界（重要）**：DSH apiproxy 对 settings RPC 有暴露白名单（`exposedNamespaces()` = LLM provider ns + `WEB_/PRODUCT_SETTINGS_NAMESPACES`，2026-07 起生效）。含该边界的宿主必须放行 `model-channels` / `model-channel-health`（本仓已在 harness `dsh-host-apiproxy` 打 `PLUGIN_SETTINGS_NAMESPACES` 补丁），否则 describe 会过滤掉这两个命名空间、写入报 `settings-not-exposed`——轮询组保存/健康面板/测速/测试全链路静默失效。

## 响应信封（重要）

所有 `connection.api.*` 调用返回 `{result: {ok, value}}` 包裹（`dsh-client-connection` 的 `callUnary` + zod 校验）。
- 成功：`resp.result.value.{...}`
- 失败：`resp.result.ok === false`，错误在 `resp.result.error.message`
- `settings.describe` 的 value = `{writable, hasDocument, namespaces:[{ns, value, base, user, revision, ...}]}`
- `llm.discoverModels` 的 value = `{models:[{id, name?, contextWindow?, maxTokens?}]}`

**不要把 `result.value` 当 `result` 读**——曾因少解一层导致整个面板静默空数据（describe 返回 namespaces 但全面板 0 provider，无任何错误提示）。

## 测试通道（模型可用性）

- 模型行「⚡测试」→ 弹窗输入自定义问题 + maxTokens → 发送
- prompt 存 localStorage（`mcm_test_prompt`，pi 同款，全局共用）
- host 用 `llm.stream({provider, model, messages, maxTokens})` 真实调用（与正式对话同链路）；60s 超时
- 结果：`status:'ok'`（ttftMs/latencyMs/text）或 `status:'error'`（code/error）
- 模型行内显示 ⏳→✓/✗ 状态标签（hover 见详情）

> 注意：此通道依赖 host 半新代码。**旧 host（未重启）无 testRequest 处理器**，测试会一直「请求中」——client 现在约 66s 后超时报 `POLL_TIMEOUT` 并提示 host 未处理（不再无限轮询）。

## 拉取上游（模型选择）

`api.settings.update` 前置的 `llm.discoverModels({settingsNs:'llm-pi-ai', provider, baseURL})` 返回端点模型列表后按 pi 语义 diff：

- `configured` = 本地已配 **且端点在线的** → **默认勾选**（提交保留，保持原顺序）
- `missing` = 端点有、本地无 → 默认不勾，勾选才添加
- `stale` = 本地已配但端点不在线的 → 默认不勾，提交会被清理
- 提交 = `已保留(勾选的configured) + 新添加(勾选的missing)`，未勾选的从 draft 删除
- 勾选说明文案：「勾选=保留/添加，取消勾选=清理。已配置项默认勾选，取消勾选会被删除。」

## 供应商 ID 重命名

供应商卡片头部「改名」按钮可重命名 Provider ID（约束：小写字母开头，仅小写字母/数字/连字符）：

- 轮询组候选池中引用该 ID 的 candidate 会自动同步为新 ID
- `apiKeyEnv` 凭据引用**保持不变**——凭据是 write-only 无法搬移，保持引用名原地不动即可让已存储 Key 继续生效
- 历史健康流水保留在原 ID 名下（历史存档不受影响）
- 改名后仍需点击右上「保存全部变更」落盘

## 密钥写入（凭据引用虚拟化）

- 面板主视图只出现「API Key」输入框：**粘贴或输入后失焦即自动写入** DSH 凭据存储（`~/.dsh/.credentials.yaml`，0600，write-only 读不回），无手动按钮；清空输入框不会删除已存 key。上游 llm-pi-ai 的供应商 profile 只有 `apiKeyEnv` 一个密钥字段（凭据引用名），不存在内联 key 的选项——secrets 不进 settings.yaml、不随 `settings.describe` 下发，是有意的安全设计。
- 「API Key 环境变量名」已收进供应商高级选项、更名「凭据引用名 (apiKeyEnv)」：新增供应商时自动生成（`normalizeCredentialRef`），并对 **ID + 引用双重去重**——改名供应商会保留旧引用（write-only 无法搬移），只按 ID 去重会复活 `provider-1` 并继承已被占用的 `PROVIDER_1_API_KEY`（两个供应商同引用 = 共用同一把 key，写入互相覆盖）。此坑已由双重去重修复，存量撞引用靠 ⚠ 警示提示手动处理（改其中一个引用 → 重新写入）。
- 环境优先级：启动 shell 同名变量（只读、优先）> 存储的 key > 项目 `.env` > 用户 `.env`（credentials-local 分层）；想用环境注入直接在启动环境 export 即可。

**曾踩坑**：`selected` 曾初始化为 `missing`（只含"可加"），而 configured 项 checkbox 显示 `checked:true` 却不在 selected 里——应用时 `kept = models.filter(m => cs.has(m.id))` 把已配置模型全部丢弃 → **已有模型消失**。修复 = selected 初始化为 `configured ∩ 端点`。

## host 半内部接口

- settings 接入用 **`ctx.inject(['settings'], (sctx) => {...})`**（settings 服务异步初始化，apply 时 `ctx.get('settings')` 为 undefined——曾经整个引擎静默失效，命名空间从未注册）
- 配置 schema（schemastery）：`model-channels` 的虚模型/candidates/strategy/timeoutMs/cooldownMs/maxRetriesPerCandidate/speedTest；`model-channel-health` 的 records 7 天切片（单组 ≤2000 条）/speedResults/runtime/speedRequest+lastHandledNonce/testRequest+testResults+lastTestHandledNonce
- 引擎：sticky/round-robin/primary 三策略；首响应超时 + 流中空闲超时（动态 = max(timeoutMs, min(120s, ttft×2))）；单候选原地重试（指数退避）耗尽才换；全炸清冷却重试一轮；测速 ttft/latency/hybrid/smart 四键（smart = 0.5×ttft_norm + 0.3×(1−reliability) + 0.2×latency_norm，reliability 贝叶斯平滑 `(success+2.5)/(total+5)`）；测速失败进冷却；请求隔离按组
- 虚拟模型元数据：`reasoning.efforts` 七档（off…max）、**defaultEffort=max**——原生 `/model` 弹窗对新模型的自动填档与展示跟随该声明；会话内显式档位的跨会话恢复由 selector 插件的档位记忆层负责（`modelDirectories` 拦截，存 `model-channels.effortMemory`）
- 迁移：startup 时从工作区 `.channel-manager/config.json` 一次性迁入 `model-channels`（无遗留则忽略）；完成后写 `legacyMigrated` 哨兵防止「清空组后重启复活」；fs 未就绪时 5s×6 重试
- 遗留 `.channel-manager/` 目录不再使用

## 客户端装载协议

`window.__ModuleLoader__.load({ id: '@arcaneorion/dsh-model-channel-manager', factory: (require) => ({ name, inject:['slots','connection'], apply }) })`；
react 经 `require('react')`；样式用 `ctx.effect` 自管理；`dsh.client: {inject:['slots','connection'], platform:'web'}`（与 client.js 返回的 inject 一致）+ `exports['./client']` 使 client-modules 自动扫描挂载。

**client bundle 按内容 hash 服务且 `no-cache`**：改 client.js 后**刷新浏览器即可生效**，无需重启 DSH。host 改动才需重启。

## 已知限制

- 动态超时实现了首响应 + 流中空闲；全炸后「清冷却重试一轮」回溯，未实现「等待最早冷却」的睡眠分支
- 测速结果不入健康流水（pi 记）；smart 键只统计真实请求
- 配置里 provider 必须非虚拟路由（防自引用）
- 轮询渠道/健康统计面板需要 host 新代码（重启后生效）；健康流水的数据在**实际请求过轮询组**后才出现
- `reasoningEfforts` 缺失（undefined）的 model 正确渲染（`|| {}` 兜底）
- 会话模型选择器搜索版已拆出为独立插件 `@arcaneorion/dsh-model-selector-search`（原生座位遮蔽、搜索、向上展开菜单、effort 档位未实现等边界见该仓 README）；本插件不再注册任何座位

## 踩坑速记（本项目，按严重程度）

1. **settings 服务异步初始化**：host 插件 `ctx.get('settings')` 在 apply 时为 undefined → 整个引擎静默不生效（无报错、无命名空间）。必须 `ctx.inject(['settings'], ...)`。
2. **响应信封少解一层**：`{result:{ok,value}}` 只解到 `result` 找不到 `namespaces`/`models` → 面板静默空。解包函数校验 `ok === false` 抛错（否则失败也显示成功）。
3. **client bundle 缓存感知**：静态 client 修改后刷新页面即可；不要因为"面板没更新"而重启 DSH——先 F5。
4. **React.createElement 括号地狱**：大元素树用辅助函数 + 中间变量 + 数组 children；`node --check`/acorn 只能保证语法，**无法确保 return 在函数体内**——曾把 return 行整行删进函数体外（`cards is not defined`，页面白屏 "Failed to load plugins"）。改完后用真实浏览器验证。
5. **`connection` 注入**：static client 必须 `inject:['connection']` 并在 apply 捕获 `ctx.get('connection').api`；在渲染组件里 `ctx.get('connection')` 拿不到（renderer 只收 standardProps）。动态插件 client 没有 `connection` 服务（动态 catalog 里没有）。
6. **动态 vs 静态重复注册**：动态 `chm-3` 与静态包都注册 `conversation.view` id `models` 会出两个同名页签；静态化后停掉动态插件。
7. **profile bundles 变更需 pnpm install**：改 `profiles/web/package.json` 的 dependencies/bundles 后必须 `pnpm install` + 重启（symlink 需重建）。
8. **主实例 vs 临时实例**：诊断 host 问题时用 `dsh --profile web --no-open --port 3081` 起临时实例读日志/settings；主实例 3080 是用户进程，改动 host 后**必须用户重启**。
9. **中流失败不可故障转移**：候选已向下游输出内容后失败（终止块报错/流中超时），继续切候选会「finish 后又有内容 + 双 finish」并拼接两个模型输出。正确做法：失败终止块不下发，标 `emitted` 上抛，组层以 `CHANNEL_MIDSTREAM_FAIL` 直接终结。
10. **testResults 读写走已提交值**：watcher 同步的 state 快照滞后于 settings 写队列，连续测试会互相覆盖结果 → client 无限轮询。读写统一 `healthScope.get()`，client 轮询加 55 次上限。
11. **apiproxy settings 暴露白名单**：新宿主只放行 LLM provider ns + 静态白名单，插件自建 ns 被 describe 过滤/写入 `settings-not-exposed`——升级宿主前先打 `PLUGIN_SETTINGS_NAMESPACES` 补丁（见「数据通道」）。
12. **新增项命名 N+1 撞键**：`Object.keys().length + 1` 在删除中间项后撞已有键（provider 覆盖草稿、group 被 host seen-set 静默去重消失）。用 `uniqueSuffixName` 取第一个未占用后缀。
13. **超时 guard 必须 finally dispose**：`ctx.effect` 注册条目只有显式 disposer 才移除；`Promise.race` 超时路径跳过后面的 `guard.dispose()` 会按超时次数泄漏。race 包 try/finally。
14. **引擎提前终止的内层流拦截器记不到账**：全局拦截器只有流被完整排水才写记录；引擎超时关闭/收到终止块即停的请求要在 `streamAttempt` 侧自行 `recordHealth`，否则轮询组流量几乎不进健康统计。
15. **拖拽顺序不能依赖 map 键序落盘**：`@deepseek-ai/dsh-settings-file` 落盘是注释保留型叶子 diff（`patchNode`），对 map 键序是盲的——纯重排（值不变）在文件层是零 diff，`setIn` 对已存在键原地替换不挪位，新键只 append。settings 服务的内存 user 层顺序确实变了（运行中一切正常），但文件永远是创建时序，重启即还原。修复：**顺序存成数组数据**——`model-channels` ns 里 `providerOrder: [...]` 字段（数组走 wholesale replace 真实落盘），client 加载时按它重排渲染，未列出的 provider append 在后。llm-pi-ai 的 mutate 照旧（当次会话内存序即刻生效）。注：原生 Models 页本无拖拽交互，其顺序由 directory 决定（catalog 内置序 + settings 键序拼接）恒定；要原生排序持久需上游修 patchNode。回归测试见 `tests/provider-order-persistence.test.cjs`。
16. **save() 白名单重建会真删面板外字段**：mutate 是 unset+set 真删不是 merge；从零构建只带面板认识的字段，手工配置的 thinkingBudgets/retryPolicy/modelOverrides/defaultInput 任何一次保存（含只改轮询组）都被整批静默删除。修复：pObj 基底 `{...pVal}` 浅拷贝再覆盖面板字段，空值靠覆盖后删键而非忽略。模型对象同理。
17. **Compat 字段面必须以安装运行时为准（rc.2 共 20 项全部生效）——「仅两项生效」的错误结论导致保存剥字段**：源码仓快照的 PiAiCompatProfile 只暴露 thinkingFormat + supportsReasoningEffort，照此写白名单净化后，用户配置的角色模板类字段（thinkingFormat:chat-template / qwen-chat-template、chatTemplateKwargs、requiresThinkingAsText、supportsDeveloperRole 等）每次保存被静默剥掉，上游报 400「角色信息不正确」（Ark code 1214）。rc.2 实际 offer 20 个字段（含 chat-template 两种格式、chatTemplateKwargs、maxTokensField/cacheControlFormat 枚举等），schema 全部接受。修复：cleanCompat 改全量透传（仅剔空串/null 与非法枚举），compatEditor 按协议渲染全部字段（布尔用三态 select 表达「未设置」）。教训与 #21 同源：对照安装运行时 d.ts，不要照抄源码仓快照。回归：tests/compat-passthrough.test.cjs。
18. **guard 不能 cap 到 30s**：streamAttempt 的超时 guard 曾用 `Math.min(remaining, 30000)`，timeoutMs>30s 与动态超时 min(120s, ttft×2) 在 >30s 区间全部退化为 30s 切候选。guard 必须覆盖全量 remaining。另：用户主动 abort 不进健康流水（isAbortLike 三形态 + 终止块 ABORTED 跳过），否则污染成功率与 smart 键 reliability。
19. **single slot 换占必须传负 priority**：`conversation.input.model` 是单占位 seat，cell = slot 本身；原生无 priority（= 0），插件同名注册同不传 → **exact-priority 撞格直接抛错**（「already has a registration at priority 0」→ apply 失败 → 整个插件含模型配置页签加载失败，面板全白）。规则：同 cell 多 entry 按 priority **升序、数值最小者渲染**，遮蔽原生传 `priority: -1`。注意 slot-catalog 的「Do NOT pass priority」只适用于**动态包**（guard 自动分配）；静态 bundle 必须自己传。另：mock 验证 slots.register 不会暴露 occupancy 检查（mock 不抛）——验证座位替换必须复刻真实 SlotCore 撞格语义。选择器拆出后，回归测试随代码迁至 `../model-selector-search/tests/slot-priority.test.cjs`。
20. **诊断临时实例必须独立 home（`DSH_HOME=/tmp/dsh-diag dsh ...`）**：临时实例与主实例共用 `~/.dsh` 会并发写同一会话日志与 `session_projcache.json`——两进程各自的 seq 计数器交错追加，日志出现重复 seq → `corrupt session log: seq gap in committed region` → 会话 resume 直接拒绝，表现为该会话内模型目录加载失败（选择器「暂无可用模型」）。修复：解压 jsonl 删掉多余事件即可（后续 seq 连续则天然对齐），用 `session-persistence-jsonl` 的 `scanLog` 校验后压缩回写；杀进程前务必备份。
21. **适配器契约以安装运行时的 d.ts 为准，不能照抄源码仓快照**：源码仓较新、rc.2 运行时的 `LlmAdapter` 多一个必需的 `prepareCall(provider, model, signal) → Promise<{model, stream}>`（主分发路径 llm.stream/llm.prepareCall 都先走它再 `adapterCall.stream(options)`；`adapter.stream` 在 rc.2 服务层从不直调）。缺它的症状极具迷惑性：注册/目录/菜单全正常，**真实发对话**才报 `registration.adapter.prepareCall is not a function`。实现对齐 llm-pi-ai 的快照模式：prepare 时捕获一份配置快照，元数据与 dispatch 都出自同一代。回归：`tests/adapter-contract.test.cjs`（T3 直接解析安装版 d.ts 的 LlmAdapter 方法集做契约同步）。
