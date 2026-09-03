# @arcaneorion/dsh-model-channel-manager

DSH 原生模型渠道管理。两半结构：

- **host 半** `src/index.js`：轮询故障转移引擎（`llm.registerAdapter` 虚拟路由 `roundrobin/<组id>`）+ 7 天健康流水 + 测速排序 + 单模型真实请求测试通道。
- **client 半** `src/client.js`：`conversation.view` 顶级页签「模型配置」，内含三个子页：**模型配置**（llm-pi-ai providers 全字段编辑、拉取上游、单模型 ⚡ 测试）、**轮询渠道**（groups 编辑 + ⚡测速）、**健康统计**（7 天聚合）。

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

> 注意：此通道依赖 host 半新代码。**旧 host（未重启）无 testRequest 处理器**，测试会永久「请求中」——症状与「链路没设计」一致，实际是 host 未热更。

## 拉取上游（模型选择）

`api.settings.update` 前置的 `llm.discoverModels({settingsNs:'llm-pi-ai', provider, baseURL})` 返回端点模型列表后按 pi 语义 diff：

- `configured` = 本地已配 **且端点在线的** → **默认勾选**（提交保留，保持原顺序）
- `missing` = 端点有、本地无 → 默认不勾，勾选才添加
- `stale` = 本地已配但端点不在线的 → 默认不勾，提交会被清理
- 提交 = `已保留(勾选的configured) + 新添加(勾选的missing)`，未勾选的从 draft 删除
- 勾选说明文案：「勾选=保留/添加，取消勾选=清理。已配置项默认勾选，取消勾选会被删除。」

**曾踩坑**：`selected` 曾初始化为 `missing`（只含"可加"），而 configured 项 checkbox 显示 `checked:true` 却不在 selected 里——应用时 `kept = models.filter(m => cs.has(m.id))` 把已配置模型全部丢弃 → **已有模型消失**。修复 = selected 初始化为 `configured ∩ 端点`。

## host 半内部接口

- settings 接入用 **`ctx.inject(['settings'], (sctx) => {...})`**（settings 服务异步初始化，apply 时 `ctx.get('settings')` 为 undefined——曾经整个引擎静默失效，命名空间从未注册）
- 配置 schema（schemastery）：`model-channels` 的虚模型/candidates/strategy/timeoutMs/cooldownMs/maxRetriesPerCandidate/speedTest；`model-channel-health` 的 records 7 天切片（单组 ≤2000 条）/speedResults/runtime/speedRequest+lastHandledNonce/testRequest+testResults+lastTestHandledNonce
- 引擎：sticky/round-robin/primary 三策略；首响应超时 + 流中空闲超时（动态 = max(timeoutMs, min(120s, ttft×2))）；单候选原地重试（指数退避）耗尽才换；全炸清冷却重试一轮；测速 ttft/latency/hybrid/smart 四键（smart = 0.5×ttft_norm + 0.3×(1−reliability) + 0.2×latency_norm，reliability 贝叶斯平滑 `(success+2.5)/(total+5)`）；测速失败进冷却；请求隔离按组
- 迁移：startup 时从工作区 `.channel-manager/config.json` 一次性迁入 `model-channels`（无遗留则忽略）
- 遗留 `.channel-manager/` 目录不再使用

## 客户端装载协议

`window.__ModuleLoader__.load({ id: '@arcaneorion/dsh-model-channel-manager', factory: (require) => ({ name, inject:['slots','connection'], apply }) })`；
react 经 `require('react')`；样式用 `ctx.effect` 自管理；`dsh.client: {inject:[], platform:'web'}` + `exports['./client']` 使 client-modules 自动扫描挂载。

**client bundle 按内容 hash 服务且 `no-cache`**：改 client.js 后**刷新浏览器即可生效**，无需重启 DSH。host 改动才需重启。

## 已知限制

- 动态超时实现了首响应 + 流中空闲；全炸后「清冷却重试一轮」回溯，未实现「等待最早冷却」的睡眠分支
- 测速结果不入健康流水（pi 记）；smart 键只统计真实请求
- 配置里 provider 必须非虚拟路由（防自引用）
- 轮询渠道/健康统计面板需要 host 新代码（重启后生效）；健康流水的数据在**实际请求过轮询组**后才出现
- `reasoningEfforts` 缺失（undefined）的 model 正常渲染（`|| {}` 兜底）

## 踩坑速记（本项目，按严重程度）

1. **settings 服务异步初始化**：host 插件 `ctx.get('settings')` 在 apply 时为 undefined → 整个引擎静默不生效（无报错、无命名空间）。必须 `ctx.inject(['settings'], ...)`。
2. **响应信封少解一层**：`{result:{ok,value}}` 只解到 `result` 找不到 `namespaces`/`models` → 面板静默空。解包函数校验 `ok === false` 抛错（否则失败也显示成功）。
3. **client bundle 缓存感知**：静态 client 修改后刷新页面即可；不要因为"面板没更新"而重启 DSH——先 F5。
4. **React.createElement 括号地狱**：大元素树用辅助函数 + 中间变量 + 数组 children；`node --check`/acorn 只能保证语法，**无法确保 return 在函数体内**——曾把 return 行整行删进函数体外（`cards is not defined`，页面白屏 "Failed to load plugins"）。改完后用真实浏览器验证。
5. **`connection` 注入**：static client 必须 `inject:['connection']` 并在 apply 捕获 `ctx.get('connection').api`；在渲染组件里 `ctx.get('connection')` 拿不到（renderer 只收 standardProps）。动态插件 client 没有 `connection` 服务（动态 catalog 里没有）。
6. **动态 vs 静态重复注册**：动态 `chm-3` 与静态包都注册 `conversation.view` id `models` 会出两个同名页签；静态化后停掉动态插件。
7. **profile bundles 变更需 pnpm install**：改 `profiles/web/package.json` 的 dependencies/bundles 后必须 `pnpm install` + 重启（symlink 需重建）。
8. **主实例 vs 临时实例**：诊断 host 问题时用 `dsh --profile web --no-open --port 3081` 起临时实例读日志/settings；主实例 3080 是用户进程，改动 host 后**必须用户重启**。
