# @arcaneorion/dsh-model-channel-manager

DSH 的模型渠道管理插件：提供商与模型编辑、轮询故障转移、真实模型测试和健康统计。当前版本 **0.4.0**，针对 DSH **0.2.0-rc.1**。

模型选择器是独立插件 `@arcaneorion/dsh-model-selector-search`；本包占用 `conversation.view` 的「模型配置」页签。

## 0.4.0 的变化

健康统计、运行态、模型测试和测速任务全部迁出 settings。常规请求、健康刷新和测试不会再重写 `cordis.patch.yml`，也不会推动配置 revision。健康页保留原有四张指标卡、供应商分组、模型状态卡和可用率条，30 分钟 / 24 小时 / 7 天改为按事件时间精确筛选。

测试和测速现在有独立任务编号、完成状态和取消按钮。重复提交同一编号只执行一次；宿主重启不会重放未完成任务。保存前核对编辑基线，拒绝覆盖另一页面已经修改的字段。

## 安装与加载

```sh
npm install
npm test
```

宿主以本地 `link:` 安装时，Node 从插件真实路径解析依赖，因此此目录必须能解析 package.json 中列出的 peer dependencies。不要只依赖 profile 目录的符号链接。宿主提供 React、Settings、Gateway、Connection 和模型运行时，不启动额外 HTTP 端口。

DSH profile 挂载本包的 `cordis.patch.yml`。默认实例 id 为 `model-channel-manager`，每个 profile 使用一个实例。升级 host 后刷新浏览器，避免旧页面继续使用已经移除的任务通道。

## 配置与数据归属

| 数据 | 所属位置 | 写入时机 |
|---|---|---|
| groups、providerOrder、effortMemory | 本插件的 Config / profile patch | 用户保存配置 |
| 提供商及模型配置 | `llm-pi-ai` 的 Settings | 用户保存配置 |
| API Key | DSH credentials | 用户输入并写入凭据 |
| 健康事件与测速结果 | `model_channel_health` storageDomain | 请求完成 / 测速完成 |
| 路由运行态与任务结果 | `model_channel_state` storageDomain | 运行态合并写、任务开始和结束 |
| 历史 health 原文 | `model_channel_state.legacy` | 首次成功迁移时归档 |
| UI 健康摘要 | 内存派生，通过 Gateway 读取 | 健康页在前台时每 5 秒读取 |

原始健康记录沿用既有 domain 和版本：每桶最多保留 300 条，最多 7 天。时间窗口统计精确作用于**保留的记录**，不代表无限历史全量统计。延迟均值只统计有有效延迟的成功记录。没有调用时成功率显示「—」，不推断模型在线。

模型测试计入健康统计；测速不计入正常请求统计。输入、输出和缓存 token 按上游 usage 分别累加，不重复计算 reasoning token。

任务数据按 profile 路径和实例 id 隔离。完成任务最多保留 100 条，进行中的任务不被裁剪；幂等保证适用于仍被保留的任务编号。不同参数复用同一编号会返回 `TASK_CONFLICT`。单个实例同时最多执行 4 项任务，同一个组最多一项显式测速。

没有 storageDomain 时仍能使用路由、测试和面板，页面会显示内存模式；新增数据不能跨重启保留。存储出错会显示错误，不会删除尚未成功迁移的旧配置。任务预留写入失败时不会调用模型；终态写入失败时保留当前进程内的实际结果并返回 `persistenceError`。

## 升级迁移

0.3.x 的 `config.health` 仅作为迁移输入，已从可编辑 Settings 表单隐藏：

1. 打开原健康存储和新的状态存储。
2. 归档旧 health 原文，合并历史事件和测速结果，保存运行态与测试结果。
3. 已完成结果保持终态；历史未完成任务标记 `ABORTED`，不重新调用上游。
4. 全部成功后，使用 ConfigEditor 一次性删除旧 health。若迁移期间有人改动旧 health，保留配置并显示提示。

这次删除可能触发一次插件重载；之后不再有健康数据的配置写入。迁移幂等，不因旧 `healthMigrated` 标记存在而跳过尚未导入的数据。旧原型 `.channel-manager/config.json` 不再被自动导入，避免用户清空组后旧配置复活。

## 运行时接口

宿主提供 `modelChannels` Source Remote，客户端通过现有 Connection / Gateway 调用：

```js
const result = await ctx.connection.rpc.call(
  '/api', 'modelChannels/invoke',
  { args: { method: 'snapshot', payload: {} } }, signal,
)
```

所有请求经过 DSH 的认证与响应信封。返回 `{ ok: true, value }` 或 `{ ok: false, error }`；客户端必须检查 `ok`。

| method | payload | value |
|---|---|---|
| snapshot | `{}` | 三个时间窗口的摘要、测速结果、路由运行态、存储状态 |
| test | `{ nonce, provider, model, prompt?, maxTokens? }` | 已预留的任务 |
| speed | `{ nonce, group }` | 已预留的测速任务 |
| task | `{ id }` | 当前任务状态和结果 |
| cancel | `{ id }` | 当前任务，取消状态随后通过 task 确认 |

nonce 接受安全正整数或最多 128 字符的字母数字、下划线、点、连字符字符串。prompt 最多 16000 字符，maxTokens 为 1–8192。模型测试总时限 45 秒；单候选测速使用组里的 timeoutMs。用户取消会中止上游并结束任务，页面卸载会停止该页面的轮询。

## 轮询路由

每个组注册 `roundrobin/<组id>`，支持 sticky、round-robin 和 primary 策略。组 id 同时是虚拟模型的显示名；组内候选只能引用真实渠道。

轮询选择时原子推进指针；单候选重试耗尽后切换候选。首响应和流中空闲均有超时，组级 `totalBudgetMs` 默认 10 分钟。测速支持 ttft、latency、hybrid 和 smart 排序；启用自动测速且无历史结果时，首次真实使用触发一次后台测速。

提供商重命名同步轮询组及其 presets 中的引用，保留凭据引用名。历史健康数据继续归属原供应商 id。

## 配置保存

读取与写入使用实际实例 id；提供商写入直接发送给 `llm-pi-ai`。保存前比较远端值与当前编辑基线，只有未被别人改过才使用最新 revision 提交；并发发生在提交窗口时由 Settings 冲突检查兜底。

两个配置实例没有跨实例事务。部分保存会明确显示哪部分成功，哪部分失败。点击「重新加载配置」会用宿主当前值重新建立草稿，请先确认不再需要未保存的编辑。

## 验证与框架修复

```sh
npm test
node scripts/verify-framework.cjs /path/to/deepseek-harness/vendor/loader/src/index.ts
node scripts/apply-framework-fix.cjs          # 仅检查适用性
node scripts/apply-framework-fix.cjs --apply  # 显式本地修复并执行回归，失败自动还原
```

框架修复针对已审计版本：Loader 拒绝非法 volatile 候选并恢复旧 raw/options；ConfigEditor 验证目标行确实接受了配置，避免 Group 吞掉错误后仍报告成功。备份在 `backups/framework-*/`，源码补丁在 `patches/`。重装宿主依赖可能覆盖这项本地修复，需重新检查；插件的新状态通道本身不依赖此补丁。

`tests/runtime-api.test.cjs` 经临时 profile 启动真实 Loader、Settings、ConfigEditor、Gateway、Connection、LLM 和 JSON storage，只替换外部模型适配器。覆盖认证、迁移、重启恢复、重复任务、取消、输入边界以及配置不变性。

浏览器验证使用 `tests/browser/preview.cjs` 与 `tests/browser/e2e.py`；图片与结果记录在 `docs/screenshots/`。纠正后的审计见 [docs/AUDIT-cordis-config-state-pollution.md](docs/AUDIT-cordis-config-state-pollution.md)。
