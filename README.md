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

从 npm 装（发布版）：

```bash
dsh plugin --profile web add @arcaneorion/dsh-model-channel-manager
# 然后重启 dsh --profile web 并刷新页面
```

本地开发用 `link:`（改源码即时生效）——`profiles/web/package.json`：
- `dependencies` 加 `"@arcaneorion/dsh-model-channel-manager": "link:/home/arcaneorion/AI/AI-DSH/plugin/model-channel-manager"`
- `dsh.profile.bundles` 加 `"@arcaneorion/dsh-model-channel-manager"`
- `pnpm install` 后重启 `dsh --profile web`

> **link: 方式的模块解析坑（0.3.8 实测）**：pnpm 对 link: 包不安装其依赖；且 Node ESM
> import 会把 symlink **realpath 化**——host 从 profile 路径加载插件时，`import 'zod'`
> 实际从**工作区真实路径**向上解析，工作区没有 node_modules 就报
> `Cannot find package 'zod'`。解法：工作区 `node_modules/` 里软链宿主侧已有实体
> （`zod` ← profile 顶层；`@deepseek-ai/dsh-storage-domain` ← pnpm `.pnpm` 实体；
> `.gitignore` 已含 `node_modules/`）。npm 安装方式（dependencies 正常解析）无此问题。

验证：
- host 日志出现 `[model-channel-manager] booted, groups: ...`
- `llm.providers` 出现 `roundrobin/<组id>`
- settings describe 含 `model-channels` / `model-channel-health` 命名空间

## 兼容性（DSH 版本）

> **当前工作树已移植到 DSH `0.2.0-rc.1`**（peer 按 `0.2.0-rc.1` 声明；settings 寻址从「自建命名空间」改为「本行实例配置」——
> 原先的 `model-channels` + `model-channel-health` 两个命名空间合并为本行 Config 的
> `groups` / `providerOrder` / `effortMemory` / `health`）。下面这段 `0.1.1-rc.2` 的记录仅作历史基线参考。

本包原在 **DSH `0.1.1-rc.2`**（`dsh --version`）上开发与实测，宿主侧依赖按该版本**精确钉住**：

| 宿主包 | 声明 | 用途 |
|---|---|---|
| `@deepseek-ai/dsh-llm` | `0.1.1-rc.2` | `llm.registerAdapter` / `llm.stream`（轮询引擎与健康采集） |
| `@deepseek-ai/dsh-settings` | `0.1.1-rc.2` | `model-channels` / `model-channel-health` 命名空间读写 |
| `@deepseek-ai/dsh-client-connection` | `0.1.1-rc.2` | client 半的 `connection.api` 调用 |
| `@deepseek-ai/dsh-client-ui-conversation` | `0.1.1-rc.2` | `conversation.view` 页签座位 |
| `@deepseek-ai/cordis` | `^4.0.2` | 插件生命周期 |
| `@deepseek-ai/schemastery` | `>=3.18.2` | 配置 schema |

**换 DSH 版本（例如 `0.1.2-rc.1`）必须先重新验证、再放宽 peer**：宿主服务与座位契约跨版本会变，
精确钉住的 peer 会在安装时报冲突——这正是它存在的意义，好过装上去静默失效。

## 数据通道（全走公共 seam，无私有 RPC）

- 读配置/运行态 = `api.settings.describe()` 过滤命名空间
- 保存 provider = `api.settings.update({ns:'llm-pi-ai', patch:{providers}})`
- 保存轮询组 = `api.settings.update({ns:'model-channels', patch:{groups}})`
- ⚡测速 = `api.settings.update({ns:'model-channel-health', patch:{speedRequest:{group,nonce}}})`（host watcher 消费）
- 单模型测试 = `settings.update({ns:'model-channel-health', patch:{testRequest:{nonce,provider,model,prompt,maxTokens}}})`；host 执行真实 `llm.stream` 后把结果写回 `testResults[nonce]`；client 轮询 describe 直到 ok/error
- `apiRef` 获取：**0.2 为 `ctx.remote`**（插件级 `inject` 声明 `remote` / `remote.settings` / `remote.credentials` / `remote.llm`，apply 时经 `ctx.inject(['remote'])` 捕获）；0.1 的 `ctx.get('connection').api` 已不存在。
- 上述调用形状仍保留 0.1 的样子：client 半内建门面 `makeLegacyApi` 把 0.2 的**位置参数 + RemoteResult** 适配回旧的**对象入参 + `{result:{ok,value}}`**，并把 `model-channels` / `model-channel-health` 合成回旧命名空间视图（真实承载是本插件行 id `model-channel-manager` 的实例配置）。

> **宿主边界（0.1 历史，0.2 已不适用）**：0.1 的 settings RPC 走 apiproxy 暴露白名单（`exposedNamespaces()` = LLM provider ns + `WEB_/PRODUCT_SETTINGS_NAMESPACES`），当时含该边界的宿主必须放行 `model-channels` / `model-channel-health`（本仓曾在 harness `dsh-host-apiproxy` 打 `PLUGIN_SETTINGS_NAMESPACES` 补丁）。
> **0.2 的 settings 命名空间就是 profile 行 id**，由 `@deepseek-ai/dsh-api-settings-controller` 的 `describe` 直接投影本行实例配置，没有该白名单环节；对应地，本插件的配置落在 `~/.dsh/profiles/web/cordis.patch.yml` 的 `model-channel-manager` 行 `config` 下。

## 健康数据存储（0.3.1 重构：事实数据归位 storageDomain）

> 背景：0.3.0 及之前，健康流水整字段存在 settings health 子树里，每 2s 防抖整段重写
> profile patch（实测 6350 行中 health 约占 3000 行），且与 volatile 快照覆盖互相踩——
> 刚记的账在落盘前被旧快照抹掉（审计 F11/F23，「测试成功不入账」的根因）。

- **权威存储**：`storageDomain` 的 `model_channel_health` 单元（dsh-base 已组合 json 后端，
  root=`~/.dsh/storages/`），`per-record` 布局——一条渠道一个桶文档，`backup-and-skip`
  容错。host 侧 `src/health-store.js` 封装：追加走原子写链（并发 `recordHealth` 不丢更新）、
  7 天窗口过期、每桶 300 条截断。
- **settings 只存小投影**：`health.digest`（host 聚合好的摘要数组：total/success/ttft/latency/
  token 三分项/lastTs）+ `digestAt`，client 健康页渲染用；不再下发原始流水。
- **聚合上移 host**：`buildDigest` 在 host 折叠（口径同旧 client：计费 token = input +
  cacheRead + cacheWrite + output），client 不再拉全量 describe 做原始事件折叠。
- **存量迁移**：首次启动自动把 settings 里的 `records`/`speedResults` 搬入 domain（桶已存在
  即跳过，幂等），同一次合并写里清空 settings 旧存量并落 `healthMigrated` 标记。
- **降级**：storageDomain 缺席的 profile 退化为纯内存（不持久化流水），不拒绝启动。
- **client 兼容**：旧 host（无 digest 字段）自动回落原始 records 路径，升级窗口不断供。
- **已知近似**：30m/24h 视图按「最近活跃渠道」过滤，数值仍是 7 天累计（UI 已标注）；
  精确分窗口需 host 出多份 digest，后续增强。健康页默认 7d，避免近 30m 冷窗让用户
  误以为历史数据丢失。
- **混部 nonce 兼容**：测试/测速 nonce 使用随机安全整数（host schema 为 number），
  避免 UUID client 遇到未重启旧 host 时被旧版 `typeof nonce === 'number'` 静默忽略；
  新 host 同时兼容旧数字与字符串 nonce。使用 `crypto.getRandomValues`，fallback 为
  时间戳×1000 + 同毫秒计数。

## 响应信封（重要）

0.1 的 `connection.api.*` 返回 `{result: {ok, value}}` 包裹（`dsh-client-connection` 的 `callUnary` + zod 校验）。
**0.2 的原生远程调用直接返回 `RemoteResult`（`{ok, value} | {ok:false, error}`）**，不再有 `result` 外层；
本插件 client 的门面把它重新包回旧形状，因此下面这层解包逻辑在 0.2 上依然成立：
- 成功：`resp.result.value.{...}`
- 失败：`resp.result.ok === false`，错误在 `resp.result.error.message`
- `settings.describe` 的 value = `{writable, hasDocument, namespaces:[{ns, value, base, user, revision, ...}]}`
- `llm.discoverModels` 的 value = `{models:[{id, name?, contextWindow?, maxTokens?}]}`

**不要把 `result.value` 当 `result` 读**——曾因少解一层导致整个面板静默空数据（describe 返回 namespaces 但全面板 0 provider，无任何错误提示）。

## Token 用量统计（健康面板）

- 健康记录条目在既有字段（ts/provider/model/ok/ttftMs/latencyMs/code）上**增量附带**上游真实 token 用量：`inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens` / `reasoningTokens`——来自适配器在 `finish` 前发出的 `usage` StreamChunk（rc.2 运行时 `StreamChunk` 契约，pi-ai `done`/`error` 事件都带）；无 usage 则这些字段不写。
- **计费口径与 DSH `tokenMeter` 一致**：input + cacheRead + cacheWrite + output（互斥计数，`inputTokens` 不含缓存命中）。面板「总 Token 用量」卡按统计窗口求和，副行显示 输入/输出/缓存 拆分；每模型卡底部显示该模型窗口 Tokens。
- 采集点与健康记录**同址**（保证 token 与请求数同记录同窗口）：全局 `llm/stream` 拦截器 + 轮询引擎 `streamAttempt`（成功/失败/超时路径都尽量携带；pi-ai 的 error 事件同样上报部分 usage）。
- 测速（⚡测速）/ 单模型测试（⚡测试）消耗的 token **不计入**——与「测速结果不入健康流水」的既有口径一致。
- 记录 schema 无需改动（`records` 为 `z.array(z.any())`），无新 RPC / settings 字段；client 5s 轮询自动刷新。

## 测试通道（模型可用性）

- 模型行「⚡测试」→ 弹窗输入自定义问题 + maxTokens → 发送
- prompt 存 localStorage（`mcm_test_prompt`，pi 同款，全局共用）
- host 用 `llm.stream({provider, model, messages, maxTokens})` 真实调用（与正式对话同链路）；45s 总时限（0.3.13 由 60s 下调，给终态写入留余量）
- 结果：`status:'ok'`（ttftMs/latencyMs/text）或 `status:'error'`（code/error）
- 模型行内显示 ⏳→✓/✗ 状态标签（hover 见详情）

> 注意：此通道依赖 host 半新代码。**旧 host（未重启）无 testRequest 处理器**，测试会一直「请求中」——client 现在约 66s 后超时，并按现场区分提示：`POLL_TIMEOUT_RUNNING`（host 已收到、仍在执行：渠道慢或上游挂起）或 `POLL_TIMEOUT`（host 未写入结果：多为旧 host 未重启或写入失败）。
>
> 0.3.12 起终态判定同时接受 `finishedAt`：即使条目的 `status` 被并发写坏成 `running`，只要带 `finishedAt`/`code`/`error` 就按终态显示真实上游错误，不再误报「host 未处理」。

## 任务通道完整性（0.3.12 重构：去重与写入语义）

## 任务通道完整性（0.3.12 重构：去重与写入语义）

0.3.11 线上症状「等待测试结果超时：host 可能未处理该请求」的两个真实成因，均在 0.3.12 修掉：

- **去重不许做数值推断**：`handleTestRequest` / `reloadFromConfig`（测速）改用纯函数
  `shouldConsumeNonce()`（导出，可在测试里直接断言判定表）——严格等值 + 已消费集合 +
  已结算值 + 已有终态结果，四者任一命中即不消费。旧实现 `last = Math.max(lastTestHandledNonce,
  claimedNonce)` 对随机 53-bit nonce 有 ≈50% 失效率（「上一轮 > 本轮」即失效），
  于是同一请求在每次 `loader/volatile-update`（含宿主自己每 5s 的 digest 回写）都被重新消费：
  重复上游请求（真实计费）+ 多次执行结果写进同一条目（线上物证：同 nonce 同时带
  `code TIMEOUT / 60000ms` 与 `ok:true / text`，单次执行不可能）。
- **health 子树一律叶写**：`writeHealth` 由「读整树 → 合并 → 整树写回」改为对 patch 命中的
  顶层键逐个 `set`（path-ops），单键结果用 `writeHealthLeaf(['testResults', nonce], value)`；
  client 侧 shim 同样不再 `describe` 快照 + 整树回写，直接下推 path-ops。整树回写的 payload 是
  「调用时刻的快照」，晚于并发的终态落盘时会把 `status` 改回 `running`，而 `update` 的深合并
  保留后写入的 `finishedAt/code/error` → 僵尸条目 → 客户端永远等不到终态。
- client 终态判定加 `finishedAt`（写入后不可抹掉），并把 `ok` 归一成 `status` 显示真实错误。
- 降级 nonce 路径改用安全整数随机数（旧 `Date.now()*1000+counter ≈ 1.8e18` 超出
  `MAX_SAFE_INTEGER`，同毫秒可撞值；strict consume-once 下撞值 = 测试被静默丢弃）。

回归：`tests/task-dedup.test.cjs`（判定表用真实导出，不复制实现）、`tests/testresult-fallback.test.cjs`（叶写语义 + 事故复现：终态后并发叶写不得改回 running）。

## 拉取上游（模型选择）

`api.settings.update` 前置的 `llm.discoverModels({settingsNs:'llm-pi-ai', provider, baseURL})` 返回端点模型列表后按 pi 语义 diff：

- `configured` = 本地已配 **且端点在线的** → **默认勾选**（提交保留，保持原顺序）
- `missing` = 端点有、本地无 → 默认不勾，勾选才添加
- `stale` = 本地已配但端点不在线的 → 默认不勾，提交会被清理
- 提交 = `已保留(勾选的configured) + 新添加(勾选的missing)`，未勾选的从 draft 删除
- 勾选说明文案：「勾选=保留/添加，取消勾选=清理。已配置项默认勾选，取消勾选会被删除。」

## 供应商 ID 重命名

供应商卡片头部「改名」按钮可重命名 Provider ID（约束：小写字母开头，仅小写字母/数字/连字符）：

- 轮询组候选池中引用该 ID 的 candidate 会自动同步为新 ID——**主 candidates 与全部 presets 都同步**（0.3.6 修复审计 F17/C05：宿主优先使用 `activePreset.candidates`，漏改它 = 删旧 provider 后组悬空）
- `apiKeyEnv` 凭据引用**保持不变**——凭据是 write-only 无法搬移，保持引用名原地不动即可让已存储 Key 继续生效
- 历史健康流水保留在原 ID 名下（历史存档不受影响）
- 改名后仍需点击右上「保存全部变更」落盘

## 组配置保存校验（0.3.6，审计 F16/H08）

保存前 client 预检，以下问题**直接拒绝提交**并列出：

- 组 ID 非法（仅小写字母/数字/连字符，字母或数字开头）
- 组 ID 重复
- 组无可用候选（候选需同时选 Provider 和模型）

host 侧兜底：`rewireRoutes` 发现配置组数 > 实际路由数时 `console.warn` 列出被丢弃的组 ID（此前是静默丢弃——H08：3 组保存、路由只有 1 条，界面仍显示「已保存」）。允许清空全部组（空列表合法）。

## 保存时的 revision 冲突（0.3.14：自噪声识别 + 自动重试）

**症状**：保存后提示「部分保存：提供商配置 已生效；轮询组配置 失败——轮询组配置已被其他页面修改（版本冲突），请点「刷新」后重试」，且要点多次才成功。

**根因**（dsh-settings 源码事实）：`describe()` 里

```js
raw = JSON.stringify([fiber.uid, schema.toJSON(), entry.options.config ?? {}])
revision = previous.revision + Number(previous.raw !== raw)
```

**revision 就是「该行 raw config 的 JSON 指纹」**。而本插件的 settings 行同时承载健康投影——宿主每 5s 的 digest 叶写、`runtime`、`testResults` 都会改动该行 raw config，revision 因此不断前进。client 加载时记下的 revision 在几秒内必然过期，保存被 `settings/conflict` 拒绝：**提示里的「其他页面」其实是插件自己写的健康数据**。providers 走的是另一个行（`llm-pi-ai`），没有这种自噪声，所以它总是先成功——这正是「部分保存」的原因。

**修法**：

- client：写入前**重新读取 revision**（消除过期）；仍冲突时比较远端值与我们加载时的基线
  （`groups`+`providerOrder` / `providers`，用键序无关的规范 JSON 比较）——
  **远端没变 = 自噪声 → 用新 revision 重试（最多 3 次）；远端真的变了 → 才报冲突**。
  既消除误报，也保留真正的多页面冲突保护（审计 F05 的语义）。
- host：`digest` 内容未变时不写（60s 心跳保底），从源头减少 revision 噪声。

回归：`tests/revision-conflict.test.cjs`。

> 真正的根治是把健康/任务通道搬出 settings 行（审计建议的 Remote + storageDomain 路线）——
> 那时本行 revision 只随用户配置变化，连重试都不需要。当前修法在不改通信架构的前提下
> 同时消除了症状与误报。

## 密钥写入（凭据引用虚拟化）

- 面板主视图只出现「API Key」输入框：**粘贴或输入后失焦即自动写入** DSH 凭据存储（`~/.dsh/.credentials.yaml`，0600，write-only 读不回），无手动按钮；清空输入框不会删除已存 key。上游 llm-pi-ai 的供应商 profile 只有 `apiKeyEnv` 一个密钥字段（凭据引用名），不存在内联 key 的选项——secrets 不进 settings.yaml、不随 `settings.describe` 下发，是有意的安全设计。
- 「API Key 环境变量名」已收进供应商高级选项、更名「凭据引用名 (apiKeyEnv)」：新增供应商时自动生成（`normalizeCredentialRef`），并对 **ID + 引用双重去重**——改名供应商会保留旧引用（write-only 无法搬移），只按 ID 去重会复活 `provider-1` 并继承已被占用的 `PROVIDER_1_API_KEY`（两个供应商同引用 = 共用同一把 key，写入互相覆盖）。此坑已由双重去重修复，存量撞引用靠 ⚠ 警示提示手动处理（改其中一个引用 → 重新写入）。
- 环境优先级：启动 shell 同名变量（只读、优先）> 存储的 key > 项目 `.env` > 用户 `.env`（credentials-local 分层）；想用环境注入直接在启动环境 export 即可。

**曾踩坑**：`selected` 曾初始化为 `missing`（只含"可加"），而 configured 项 checkbox 显示 `checked:true` 却不在 selected 里——应用时 `kept = models.filter(m => cs.has(m.id))` 把已配置模型全部丢弃 → **已有模型消失**。修复 = selected 初始化为 `configured ∩ 端点`。

## host 半内部接口

- settings 接入用 **`ctx.inject(['settings'], (sctx) => {...})`**（settings 服务异步初始化，apply 时 `ctx.get('settings')` 为 undefined——曾经整个引擎静默失效，命名空间从未注册）
- 配置 schema（schemastery）：`model-channels` 的虚模型/candidates/strategy/timeoutMs/cooldownMs/maxRetriesPerCandidate/speedTest；`model-channel-health` 的 runtime/speedRequest+lastHandledNonce/testRequest+testResults+lastTestHandledNonce/digest 小投影（records/speedResults 仅作 0.3.1 迁移的读取源，权威在 storageDomain）
- 引擎：sticky/round-robin/primary 三策略；**round-robin 选择时原子预留**（0.3.5：指针选定即推进，并发请求均分；旧实现成功后才推进，并发全打同一候选——审计 F13/H13）；首响应超时 + 流中空闲超时（动态 = max(timeoutMs, min(120s, ttft×2))）；单候选原地重试（指数退避）耗尽才换；全炸清冷却重试一轮；组级总预算 `totalBudgetMs`（默认 10 分钟，0.3.3）；测速 ttft/latency/hybrid/smart 四键（smart = 0.5×ttft_norm + 0.3×(1−reliability) + 0.2×latency_norm，reliability 贝叶斯平滑 `(success+2.5)/(total+5)`）；测速失败进冷却；请求隔离按组
- 自动测速（0.3.5，审计 F14/H07）：`speedTest.enabled` 且组无测速结果时，**首次真实使用触发一次后台测速**（不阻塞请求）；此前只有 boot 时的 `onFirstUse` 分支，常规路径无入口——开启开关后从未生效
- 虚拟模型元数据：`reasoning.efforts` 七档（off…max）、**defaultEffort=max**——原生 `/model` 弹窗对新模型的自动填档与展示跟随该声明；会话内显式档位的跨会话恢复由 selector 插件的档位记忆层负责（`modelDirectories` 拦截，存 `model-channels.effortMemory`）
- 迁移：startup 时从工作区 `.channel-manager/config.json` 一次性迁入 `model-channels`（无遗留则忽略）；完成后写 `legacyMigrated` 哨兵防止「清空组后重启复活」；fs 未就绪时 5s×6 重试
- 遗留 `.channel-manager/` 目录不再使用

## 客户端装载协议

`window.__ModuleLoader__.load({ id: '@arcaneorion/dsh-model-channel-manager', factory: (require) => ({ name, inject:['slots','connection'], apply }) })`；
react 经 `require('react')`；样式用 `ctx.effect` 自管理；`dsh.client: {inject:['slots','connection'], platform:'web'}`（与 client.js 返回的 inject 一致）+ `exports['./client']` 使 client-modules 自动扫描挂载。

**client bundle 按内容 hash 服务且 `no-cache`**：改 client.js 后**刷新浏览器即可生效**，无需重启 DSH。host 改动才需重启。

## 已知限制

- **虚拟模型能力声明与候选实际能力无联动（审计 F08，0.3.4 已做最小切片）**：请求含图
  或带 effort 时，宿主 `resolveModelInfo` 明确声明不支持的候选会被过滤（60s TTL 缓存；
  `inputModalities` 缺失=未知不过滤，保持 failover；全滤退回原列表报真实错误）——
  防住 H14（图片静默替换后假成功）与 H06（effort 强塞被拒）。**仍未做**：虚拟模型声明
  元数据（vision/efforts/窗口）与候选能力的联动聚合，属后续专项
- 动态超时实现了首响应 + 流中空闲；全炸后「清冷却重试一轮」回溯，未实现「等待最早冷却」的睡眠分支
- 测速结果不入健康流水（pi 记）；smart 键只统计真实请求
- **Token 字段只在新记录上出现**：host 升级重启前的存量健康记录无 token 字段，7 天视图对重启前的调用会低估 token（请求数/可用率不受影响）；数据自重启后开始累积
- 配置里 provider 必须非虚拟路由（防自引用）
- 轮询渠道/健康统计面板需要 host 新代码（重启后生效）；健康流水的数据在**实际请求过轮询组**后才出现
- `reasoningEfforts` 缺失（undefined）的 model 正确渲染（`|| {}` 兜底）
- 会话模型选择器搜索版已拆出为独立插件 `@arcaneorion/dsh-model-selector-search`（原生座位遮蔽、搜索、向上展开菜单、effort 档位未实现等边界见该仓 README）；本插件不再注册任何座位
- `makeLegacyApi` 0.1 兼容门面仍保留（94 行、11 调用点）：拆除要动 6 个功能路径的双层
  信封，待 0.3.2 真实环境验证后再决定
- 30m/24h 健康视图是近似口径（按最近活跃过滤，数值为 7 天累计，UI 已标注）；精确分窗口
  需 host 出多份 digest

### 0.3.13：2026-10-01 审计剩余项（已修）

同一份只读审计（13 项）里，0.3.12 修了最要命的两条（去重 guard、整树回写），0.3.13 清掉其余：

- **R3 remount/dispose 打断在飞测试**：`timed()` 守卫不再只在 dispose 时 `clearTimeout`——
  那样 promise 永不 settle，`await Promise.race([inner.next(), guard.promise])` 直接挂死，
  在飞测试既不结束也不写终态。现在 dispose 会主动 reject `ABORTED`，调用方走正常失败路径。
  另外**启动时清扫**：新进程里任何 `status: running` 且无 `finishedAt` 的条目都是上次遗留的，
  补写 `ABORTED` 终态；`running + finishedAt` 的僵尸条目按 `ok` 归一状态位
  （纯函数 `selectStaleTestEntries` 导出，回归见 `tests/runtime-hardening.test.cjs`）。
- **R2 volatile 提交静默失败（放大器）**：请求存在但既未认领也未结算时，
  ① `handleTestRequest` 显式打日志（每个 nonce 一次，不再静默忽略）；
  ② 新增 5s 兜底轮询 `sweepPendingTestRequest`，复用同一个消费判定，主动重试一次并留日志；
  ③ `reloadFromConfig` 检测「health 子树运行时从有到无」并大声告警——这是 0.3.11
  schema 兜底事故的形态，以前完全无声。
- **#7 预算错配**：host 测试总时限 60s → 45s（client 轮询上限 ≈66s，旧值只留 6s 余量）；
  client 放弃时还会比对 `lastTestHandledNonce`，区分第三种情况
  `POLL_TIMEOUT_SETTLED`（host 已结算但结果条目未写入）。
- **#6 notReady 退避**：释放认领后设 5s 退避窗口（测试/测速各自），期间任何
  volatile-update 都不再消费——旧实现释放后会被立刻再消费，并发起多个 45s 上游请求。
- **#13 迁移直写**：`migrateLegacyConfig` 改走 `bus.writeConfig`（`outsideTransaction` 包裹），
  不再在 HMR 事务内直写（旧写法会抛 "cannot be nested" 并被空 catch 吞掉，只剩哨兵）。
- **#11 digest 遮蔽**：`digest: []` 且 settings 仍有 `records` 时（domain 打开成功但迁移失败、
  或 host 刚重启尚未投影）回落到 records 路径，页面显示旧流水而不是全 0。
- **#10 health-store**：事件去重键由 `ts|provider|model` 扩成含 ok/code/延迟/token 的指纹
  （同毫秒同渠道的两笔真实请求不再被当重复合并）；`putSpeedRows` 与 `migrateFrom` 的测速写入
  并入同一条写链（不与事件追加交错）；`close()` 先排干写链再关 domain（不丢排队中的最后一笔）。

**仍然未修（有意保留）**：health 子树写入不带 `expectedRevision`。叶写后危害已大幅降低
（不同叶子互不覆盖），同一叶子的并发写本身是「后写者胜」的语义，加 revision 需要调用方
持有并维护 revision，收益不抵复杂度；配置域（groups/providerOrder）仍然带 revision。

## 引擎超时与生命周期（0.3.3 重构：审计 F01/F02/F15 已修）

- **per-attempt AbortController**：每次候选尝试独立 signal，用户取消转发（`relayAbort`，
  finally 移除防泄漏）+ 超时 abort（`attemptController.abort(raceErr)`）。pi-ai 适配器把
  `options.signal` 经 `AbortSignal.any` 融进 watchdog 并传给上游 HTTP——abort 即真正
  取消网络请求，不再有「return() 排在挂起的 next() 之后拖住 failover」（H02 复现的根因）
- **统一 finally 有界关闭**：streamAttempt / measureCandidate / runModelTest 三处流消费
  路径，成功 return / 失败 / 消费者提前退出都走 `closeInner`（closed 防重入 + 3s 关闭
  预算 race，预算超时补一发 abort）
- **组级总预算 `totalBudgetMs`**（默认 10 分钟，组配置可调）：超预算不开新尝试，以
  `CHANNEL_BUDGET_EXCEEDED` 终结——旧实现最坏 `2×N×(R+1)` 次尝试（默认 R=2 → 6N）
- **测速/测试改总时限**（F15）：旧实现每 chunk 重置 guard（H12：timeoutMs=40 流每
  20ms 输出，84ms 后仍成功），现在 `deadline` 固定总时限，超时 abort
- 回归：`tests/timeout-abort.test.cjs`（契约断言 + 挂起流行为级验证——3s 关闭预算内
  完成，不等满 5s 挂起）

## 引擎集成测试（0.3.15：真正跑一遍 apply → adapter → 引擎）

此前所有引擎测试都是**源级断言或逻辑复刻**，抓不到「作用域/引用」类缺陷：0.3.5 的 F13
重构把 `let cursor = …` 改成两个分支内赋值却丢了声明，ESM 严格模式下每次走虚拟路由都抛
`ReferenceError: cursor is not defined`（用户看到的「本轮运行失败」），而当时 32 个测试全绿。

`tests/engine-integration.test.cjs` 用最小 Cordis ctx 替身（只实现插件用到的 8 个面，
`ctx.timeout` 按 `cordis-plugin-timer` 的真实双形态实现）真正执行：

```
apply(ctx, Config({...}))  →  捕获 llm.registerAdapter 的 adapter
   →  adapter.stream({provider: 'roundrobin/<组>'})  →  断言真实 llm.stream 调用序列
```

覆盖：路由分发、round-robin 指针原子预留（F13 并发均分）、单候选重试与 failover 顺序、
`NO_ADAPTER` 终止块、`prepareCall` 快照路径、effect disposer 可执行（卸载不留悬挂 interval）。
**验证过它抓得住原 bug**：临时删掉 `let cursor = 0;` → 7 项里 5 项立即失败。

另加静态守卫 `tests/no-undeclared-assignment.test.cjs`：用 acorn 解析两个源文件，
找出所有「赋值给从未声明标识符」的目标（F18 的 `idx`、这次的 `cursor` 都是这一类）。
这是文件级 no-undef（比词法作用域宽松，宁可漏报不误报），恰好覆盖最危险的形态。

> 顺带观察（非缺陷）：`speedTest.enabled` 默认开启，所以**组内第一次请求会后台触发一次
> 全候选测速**（每个候选一次真实请求）。UI 文案是「开启自动测速」，语义一致；不想付这份
> 额度就在组设置里取消勾选。

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
22. **0.2 配置写入是 HMR 独占事务**：`settings.update` → `configEditor.edit()` → `hmr.runExclusive()`；在 `loader/volatile-update` 回调里回写会抛 `HMR transactions cannot be nested`（实测一段会话内 15 次，面板“测试”结果永远落不了盘）。事务内创建的**任何**异步资源（`AsyncResource` / `setTimeout` / `setInterval`）都继承事务上下文，**只有 `AsyncLocalStorage.exit()` 能切出**：`ctx.get('hmr').executing.exit(fn)`（仅当 `getStore()` 为真时切）。写入会被 `runExclusive` 排进队列、在本次事务结束后执行；**监听器保持同步、不要在外层事务里 await 它**（队列串行，互等即死锁）。
23. **整字段落盘 + 内存态被配置快照覆盖**（0.3.1 已根治）：`settings.update` 是整字段替换；旧实现 `reloadFromConfig()` 每次 volatile-update 都用配置快照整体覆盖 `state.records`，而健康 flush 有 2s 防抖 → **刚记下的一笔在落盘前就被内存覆盖**（症状：面板“测试”成功不入账，失败反被全局拦截器的 catch 记上）。当时的修法是 `pendingRecords` 缓冲补账；0.3.1 起权威数据搬入 storageDomain（见「健康数据存储」），settings 只存 digest 小投影，此竞态从数据模型层消除。
24. **nonce 落盘时机与启动竞态**：`lastTestHandledNonce` / `lastHandledNonce` 必须在**得出结果之后**写（提前写会让“未就绪”的重试被自己的持久值挡掉）；启动瞬间凭据服务尚未就绪时测试/测速会以 `MISSING_CREDENTIAL` 失败（凭据其实已在 `.credentials.yaml` 里），应识别为「还没就绪」→ 释放认领 + 5s 延时重试（上限 24 次），**不要**写成渠道故障；测速还必须在整组候选都因未就绪失败时**不落盘、不冷却**，否则一次启动重放就把所有渠道误判成故障。
25. **domain 写入的并发丢失（0.3.1 review 挽救）**：`KvTable.put` 是整 record 覆盖，`get→filter→put` 的读-改-写在 put 的 IO 延迟窗口内并发调用会互相覆盖（后写盖先写，先记的账丢失）——恰好复刻了要消灭的丢账问题。**并发追加必须走原子链**：`update(key, fn)` 的 fn 在写链队列槽位看到当前值；桶不存在时 update 报 `missing-key`，先 put 初始化。另外在 promise 链里 `ctx.effect` 注册 disposer 前必须先验 fiber 活性——对 inactive fiber 注册会抛 `INACTIVE_EFFECT`，若被外层 catch 吞掉则 domain 永不 close，facility 名字被占 → HMR 重载后 `already-open` 静默降级。回归：`tests/health-domain-sync.test.cjs`。
26. **`ctx.get(name)` 是宽松读，不代表可以访问服务（0.3.10 线上事故）**：Cordis 的服务属性访问经 Proxy 校验 inject——`ctx.get('storageDomain')` 直接查 store 返回裸服务（不校验 state/inject），但拿着这个未声明的 ctx 做 `ctx.storageDomain.open(...)` 会抛 `cannot get property "storageDomain" without inject`；若被 promise 链的 catch 吞掉，表现为「插件启动正常、domain 永远不打开、健康流水静默降级为内存」。**可选服务必须用响应式 inject**：`ctx.inject(['storageDomain'], (dctx) => { ... dctx.storageDomain ... })`——回调只在服务可用（state=2）时触发，缺席时插件照常工作；同时把插件主启动（`reloadFromConfig` + `boot`）放在 inject **之外**先跑，避免服务缺席时路由不注册。回归：`tests/domain-wiring.test.cjs`。
27. **`settings.update` 的深合并清不掉旧键（0.3.10 修）**：`update` 走 `mergeLayers`，`{records: {}}` 覆盖已有对象是**深合并**——旧键原样保留。0.3.8 的迁移「清空 settings 旧流水」实际没删，`records` 一直留在 profile 里，每次 `describe`（client 5s 轮询全量命名空间）都要带着它。要真删除必须走 path-ops：`settings.mutate(ns, [{op:'unset', path:['health','records']}, ...])`（`isVolatilePath` 对 volatile 子树的后代返回 true，允许操作）。回归：`tests/domain-wiring.test.cjs`。
28. **schema 类型漂移会静默清空整个 volatile 子树（0.3.11 线上事故，自己埋的）**：0.3.2 把 client nonce 改成 UUID 字符串、host 消费代码也兼容了字符串，**但没同步改 schema**——`lastTestHandledNonce: z.number()`。字符串一落盘，`HEALTH_SCHEMA` 解析时子字段抛错；而它是 `.loose(true)`，宽松兜底把**整个 health 子树换成默认空对象**（实测 `healthOf()` 返回 `{}`，不报错、不告警）。后果：`records`/`digest` 在运行时全部消失 → 存量迁移遍历空对象（什么都不导入）→ 清理逻辑以为「无残留」（旧键删不掉）→ 表现为「健康页没有历史数据」且旧 `records` 永久占据 profile。三条教训：① **写侧放宽类型时，schema 必须同步放宽**（用 `z.union([z.number(), z.string()])` 兼容历史值）；② **`.loose(true)` 的兜底是静默的**，volatile 子树里一个字段失配 = 整树数据不可见；③ **迁移标记不可信**——`migrateFrom` 改为「桶已存在时合并去重」而非整桶跳过，且「有存量必须先导入再清理」，这样即使 marker 被误写也能把旧账救回来。回归：`tests/health-schema-tolerance.test.cjs`。

29. **去重不能依赖 nonce 的数值单调性（0.3.12）**：`last = Math.max(lastTestHandledNonce, claimedNonce)` 看似「取最新」，实则假设了 nonce 单调递增——而 0.3.2 起 nonce 是随机 53-bit，**「上一轮 > 本轮」时（≈50%）判等失效**，同一 testRequest 在每次 `loader/volatile-update`（包括宿主自己每 5s 的 digest 回写触发的那次）都被重新消费。症状是两级：① 上游被真实重复调用（计费）；② 多次执行的结果写进同一条目（线上物证：同 nonce 一条记录同时带 `code TIMEOUT / 60000ms` 与 `ok:true / text/ttftMs`，单次执行不可能）。**规则：去重只做严格等值 + 已消费集合 + 已结算值 + 已有终态，任何「大小推断」都是错的**。释放认领（notReady 重放）时必须同时释放已消费集合，否则重放被自己的去重挡住。回归：`tests/task-dedup.test.cjs`（判定表直接调用生产导出 `shouldConsumeNonce`）。
30. **整树读-改-写会把并发终态「回灌」成旧值（0.3.12 线上事故）**：health 子树的每次写入都曾是 `cur = healthOf(); update({health:{...cur, patch}})`——payload 是调用时刻的**整树快照**。只要它晚于并发的终态写落盘，`status` 就被改回 `running`；而 `settings.update` 是深合并（只覆盖出现的键、不删键），后写入的 `finishedAt/code/error` 反而被保留 → 条目变成「running + 终态字段」的僵尸，客户端只认 `status==='ok'|'error'` 就永远等不到终态，66s 后误报「host 可能未处理该请求」。**规则：settings 里的共享子树一律叶写**（patch 命中的键逐个 `set`；单键结果用 `writeHealthLeaf(['testResults', nonce], value)`；修剪用 `unset` 而非整字典覆盖），client 侧同样不得「describe 快照 + 整树回写」。另：客户端终态判定要接受 `finishedAt`——状态位可能被写坏，但已经发生的终态字段不会消失。回归：`tests/testresult-fallback.test.cjs`（F4 直接复刻事故时序）。

31. **超时守卫 dispose 时必须 settle promise（0.3.13，审计 R3）**：`timed()` 的 guard 若在 fiber dispose 时只 `clearTimeout`，promise 永不 reject——`await Promise.race([inner.next(), guard.promise])` 就永久挂住，在飞测试既不结束也不写终态，客户端只能等到 66s 假超时（表现与「host 未处理」一模一样）。**规则：任何挂在 `ctx.effect` 上的定时器，dispose 时不仅要清定时器，还要让等待它的 promise settle**（这里 reject `ABORTED`），否则卸载路径会留下永久悬挂的 await。配套：新进程启动时清扫上次遗留的 `running` 条目（补 `ABORTED` 终态）——进程内在飞任务都有 fiber 生命周期，重启后见到的 running 一定是遗留的。回归：`tests/runtime-hardening.test.cjs`。
32. **静默失败要有出口（0.3.13，审计 R2）**：loader 的 `_commitVolatile` 在 `resolveConfig` 抛错时只 `logger.warn` 后返回 true——document 已落盘、fiber 引用不更新、**不发 `loader/volatile-update`**。而本插件的任务通道只在 volatile-update 里消费请求，于是请求被彻底忽略、客户端 66s 超时，宿主侧却「什么都没发生」。同理 `.loose(true)` 的 schema 兜底会把整棵 volatile 子树换成空对象而不报错（踩坑 28）。**规则：凡是「静默丢弃用户动作」的路径都要有可见出口**——① 未消费的请求打日志（每 nonce 一次）；② 周期性兜底重试（5s，复用同一消费判定，每 nonce 一次）；③ 关键子树从有到无时告警。回归：`tests/runtime-hardening.test.cjs`。

33. **settings 的 revision 是「raw config 的 JSON 指纹」，会被插件自己的健康写入推高（0.3.14）**：`describe()` 里 `revision += raw !== previous.raw`，`raw = JSON.stringify([fiber.uid, schema.toJSON(), entry.options.config])`。本插件的行同时承载健康投影（digest 每 5s、runtime、testResults），所以 client 手里的 revision 几秒内必然过期，保存被 `settings/conflict` 拒绝，提示却是「已被其他页面修改」——**其实「其他页面」就是插件自己**；providers 在另一个行（llm-pi-ai）没有自噪声，于是表现为「部分保存：提供商成功、轮询组失败，点多次才成功」。两条教训：① **带 revision 的写入必须「写入前重读」**，加载时记下的 revision 只在「该行没有其他写入者」时才有效；② 冲突要**分类**——比较远端值与加载基线（键序无关的规范 JSON），远端没变就是自噪声（重试），真的变了才是冲突（报错）。根治方向是把高频数据搬出该行（Remote/storageDomain）。回归：`tests/revision-conflict.test.cjs`。

34. **重构时把「声明 + 赋值」拆成分支内赋值，却丢了声明（0.3.15，用户看到的「本轮运行失败 cursor is not defined」）**：F13 把 `let cursor = strategy === 'primary' ? 0 : …` 改成 `if (round-robin) { cursor = …; } else { cursor = …; }` —— 两处赋值都在，**声明没了**。ESM 恒为严格模式，赋值未声明标识符直接抛 `ReferenceError`，于是**每一次走虚拟路由的请求都失败**；更糟的是这个错误只有真正跑到那一行才暴露：注册、目录、模型菜单、源级测试全部正常（32 项全绿）。教训：① **局部变量改写分支结构时，声明必须留在分支之外**（`let x;` + 分支内只赋值）；② **引擎需要「真跑一遍」的集成测试**——源级断言/逻辑复刻挡不住这类缺陷，见 `tests/engine-integration.test.cjs`；③ 加一道静态守卫：acorn 扫「赋值给未声明标识符」（`tests/no-undeclared-assignment.test.cjs`），同一类缺陷的 F18（`idx`）也会被它抓住。

## 0.3.11 修复后的自愈路径（无需手工清库）

重启后：schema 接受历史字符串 nonce → `records` 重新可见 → `migrateFrom` 把旧流水**合并去重**进 domain（`my-opencode-go` 桶已有新事件，按 `ts|provider|model` 去重后并入）→ path-ops 真删除 settings 里的 `records` → digest 重算包含历史。日志会打印 `legacy health imported into domain and cleared from settings`。
