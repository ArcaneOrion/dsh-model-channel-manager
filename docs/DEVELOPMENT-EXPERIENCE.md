# 开发与模型配置经验总结

> 本文沉淀 `@arcaneorion/dsh-model-channel-manager` 从 0 到 1 的完整开发经验与 DSH 模型渠道配置实践，包含大量从真实踩坑中提炼的可复用结论（含源码级证据）。供后续迭代、新插件开发与日常模型配置参考。

---

## 目录

1. [架构总览](#1-架构总览)
2. [Host 半开发经验](#2-host-半开发经验)
3. [Client 半开发经验](#3-client-半开发经验)
4. [踩坑速记表（按严重程度）](#4-踩坑速记表)
5. [模型配置字段全景](#5-模型配置字段全景)
6. [缓存命中率优化专题](#6-缓存命中率优化专题)
7. [默认值与最佳实践](#7-默认值与最佳实践)
8. [验证与部署](#8-验证与部署)

---

## 1. 架构总览

本插件是 **DSH 原生双半结构**：一份包，两个 runtime。

| 半 | 文件 | 运行环境 | 职责 |
| --- | --- | --- | --- |
| Host | `src/index.js` | DSH Node.js 主进程 | 轮询故障转移引擎、全局 `llm/stream` 健康拦截、settings 命名空间、单模型测试通道 |
| Client | `src/client.js` | 浏览器 Web GUI | `conversation.view`「模型配置」页签：提供商编辑 / 轮询组 / 健康统计 |

**核心设计原则**

- **无私有 RPC**：双向数据全部走公共 seam —— `api.settings` / `api.llm` / `api.credentials`。
- **配置即 settings 命名空间**：`model-channels`（轮询组配置）、`model-channel-health`（健康流水 + 测速 + 测试结果哨）。
- **保存即热重载**：settings watcher → 引擎热重建虚拟路由，无需重启。
- **动态插件只作调试，绝不作为交付物**：Cordis 动态插件随进程消亡，一切能力必须落仓库。
- **轮询组无请求头**：虚拟路由没有网络身份，请求转发下沉到候选供应商的 profile（headers / 凭据 / compat / 缓存全部由候选配置继承）。

---

## 2. Host 半开发经验

### 2.1 轮询故障转移引擎

- 通过 `llm.registerAdapter(['roundrobin/<组id>'])` 注册虚拟路由，引擎内嵌套 `ctx.llm.stream({provider: 候选})` 转发。
- 三策略：`sticky`（成功锁定）/ `round-robin`（成功指向下一候选）/ `primary`（永远回首选）。
- 单候选原地重试（指数退避）耗尽才进冷却换下一个；整轮全炸清冷却回溯一轮。
- 动态超时 = `max(timeoutMs, min(120s, 实测 ttft × 2))`，同时守护「首响应」与「流中空闲」两处。
- 测速排序四键：`ttft / latency / hybrid / smart`，smart 用贝叶斯平滑可靠性 `(success+2.5)/(total+5)` 参与归一化。
- 防自引用：候选 provider 不允许以 `roundrobin/` 开头。

### 2.2 settings 总线接入（响应式）

```js
// settings 服务异步初始化，apply 时 ctx.get('settings') 是 undefined！
// 必须 ctx.inject(['settings'], ...) 才能拿到
ctx.inject(['settings'], (sctx) => {
  const settings = sctx.settings;
  const cfgScope = settings.register(NS_CONFIG, CONFIG_SCHEMA, { base: {} });
  cfgScope.watch(() => { /* 热重建路由 */ });
  healthScope.watch((next) => { /* 消费 speedRequest / testRequest 哨 */ });
  boot();
});
```

### 2.3 全局 LLM 健康采集（本插件最关键的抽象）

```js
ctx.on('llm/stream', async function* (options, next) {
  // 1) 过滤虚拟路由，防双计
  if (options.provider.startsWith('roundrobin/')) return yield* next();
  // 2) 测量 TTFT / Latency / ok / code
  // 3) 写回 settings → 磁盘持久化（7 天滚动，单组 slice(-2000)）
}, { global: true, prepend: true });
```

**三处必须同时正确，否则静默失效**：

| 要素 | 作用 |
| --- | --- |
| `global: true` | 挂到 Cordis 根 Realm，否则主会话 Agent Loop 的流量穿透拦截器 |
| `prepend: true` | 排在瀑布流最顶层，保证每个请求都经过 |
| `.catch(() => {})` 包裹持久化 | 健康采集绝不能因写盘失败反噬主请求流 |

### 2.4 测试通道（哨兵模式）

Client 写 `testRequest: {nonce, provider, model, prompt, maxTokens}` → Host watcher 校验 nonce 去重并消费 → 真实 `llm.stream` 执行 → 结果回写 `testResults[nonce]` → Client 轮询 describe 直到 `ok / error`。

- **必须先保存配置再测试**：DSH 适配器对未配置模型直接抛 `UNKNOWN_MODEL`（源码 `dsh-llm-pi-ai/lib/index.js:1648`），与「拉取成功」与否无关——拉取只是前端草稿态。
- 测试结果同时收集 `reasoning-delta` 与 `text-delta`，思考模型测试才看得到完整输出。
- 无凭据引用的渠道定义为「原生认证」，跳过凭据检查直接测试。

### 2.5 持久化与重启

健康流水保存在 DSH settings 后端（`~/.dsh/settings.yaml` 的 `model-channel-health` 段），**重启 DSH 不丢**。`state.records` 按 provider 分组，7 天截止 `Date.now() - 7*24*3600*1000`，单组最多 2000 条。

---

## 3. Client 半开发经验

### 3.1 装载协议

```js
window.__ModuleLoader__.load({
  id: '@arcaneorion/dsh-model-channel-manager',
  factory: (require) => {
    const { createElement: el, useState, useEffect } = require('react');
    ...
    return { name: 'model-channel-manager', inject: ['slots', 'connection'], apply };
  },
});
```

- 静态 Client 必须 `inject: ['connection']`，在 `apply(ctx)` 里 `ctx.get('connection').api` 捕获到闭包；渲染组件内拿不到。
- `apply()` 不可直接返回 React Element —— 必须 `slots.inject('conversation.view', ...)` 注册页签。
- 样式用 `ctx.effect` 自管理 `<style>`，卸载时移除。
- **client bundle 按内容 hash 且 no-cache**：改 `src/client.js` 后 F5 刷新即生效；改 host 侧才需重启。

### 3.2 响应信封

所有 `connection.api.*` 返回 `{result: {ok, value}}`：

```js
const unwrap = (resp) => {
  const r = resp && resp.result ? resp.result : resp;
  if (r && r.ok === false) throw new Error(r.error?.message || 'request failed');
  return r && r.value !== undefined ? r.value : r;
};
```

**少解一层 = 面板全面板静默空数据，无任何报错**。所有 API 调用点统一用 `unwrap`，失败才抛错。

### 3.3 交互方法论（用户体验收敛于三个模式）

1. **长列表编辑器**：Provider 卡片（外层）→ 模型子卡片 → 兼容性折叠区，逐层展开，避免一屏塞满字段。
2. **静默异步 + 行内状态**：⚡测速 / ⚡测试不弹窗打断，行内徽标流转 `测试中… → ✓ 成功(详情) / ✗ 异常(详情)`，点击徽标才展开结果详情浮窗。
3. **全局参数一次配置**：测试 Prompt / MaxTokens 存 `localStorage`（`mcm_test_prompt` / `mcm_test_max_tokens`），全局共用。
4. **拖动排序**：见 [3.7](#37-供应商拖动排序) —— 独立 ⠿ 手柄 + 保序重建字典 + mutate 提交持久化。

### 3.4 拉取上游模型 Diff 语义（务必保持）

```
configured = 本地已配 且 端点在线的  → 默认勾选（提交保留，保持原顺序）
missing    = 端点有、本地无          → 默认不勾，勾选才添加
stale      = 本地已配但端点已下线    → 默认不勾，提交清理
提交 = 勾选的 configured 保留 + 勾选的 missing 添加
```

> **血泪史**：`selected` 曾初始化为 `missing`，导致 configured 项 checkbox 显示勾选却不在 selected 里，应用时已配置模型被整批删除。**selected 必须初始化为 `configured ∩ 端点`**。

### 3.5 健康面板设计

- **可用状态是主角，成功率是附属**（中转站同款心智）：

| 徽标 | 判定 |
| --- | --- |
| `✓ 在线可用`（绿） | lastOk 且窗口可用率 ≥ 80% |
| `! 服务降级`（橙） | 可用率 50% ~ 80% |
| `✗ 不可用/故障`（红） | 可用率 < 50% 或持续报错 |
| `空闲(未调用)`（灰） | 窗口内无调用 |

- **多时间窗口**：`近 30 分钟(实时探针) / 近 24 小时 / 近 7 天全量` —— 前端纯内存按 `ts` 切片，零开销即时切换。
- **前台 5s 自动轮询**：`useEffect` 里 `setInterval` 静默 describe 健康命名空间，卸载时 `clearInterval`。
- **优先读 draft**：面板数据源用 `draft || state.providers`，保证新添加的供应商/模型在轮询候选下拉中立即可选。
- **全量占位**：先把配置里的所有 provider/model 建零计数卡片，再叠加流水累积，未调用模型也可见（灰标「空闲」）。

### 3.6 提交前数据清洗 + 提交路径（Data Sanitizer & Write Path）

**清洗**（不洗则 schemastery/zod 整包拒绝，表现为「保存无反应」）：

- 剔除空 id 的占位模型行、空字符串字段、非法 0 值超时；
- `apiKeyEnv` 走 `normalizeCredentialRef` 归一化（见 [3.8](#38-凭据引用归一化)）；
- `headers` 无条件合并 `DEFAULT_HEADERS`（见 [3.9](#39-默认请求头)）；
- `compat` / `reasoningEfforts` 仅保留非空对象。

**提交**（llm-pi-ai 专用路径，源码 `dsh-settings/lib/index.js` 实证）：

| 写路径 | 语义 | 是否可用 |
| --- | --- | --- |
| `settings.update` | merge 深层合并 | ❌ 已存在键保序（对象 spread 旧键位置不动）：**排序与删除都无法表达** |
| `settings.replace` | 整体重建 user 层 | ⚠️ 官方警告：持脱敏视图整体重建会抹掉 wire 未回传字段 |
| `settings.mutate` | 有序 path-ops 依次作用 | ✅ 先 unset 全部旧键，再按目标顺序 set 重插 → 键序即持久化顺序；unset 掉的删除键真实卸载 |

```js
const ops = [];
for (const k of allKeys) ops.push({ op: 'unset', path: ['providers', k] }); // 含被删除的旧键
for (const k of order) ops.push({ op: 'set', path: ['providers', k], value: clean[k] });
await apiRef.settings.mutate({ ns: 'llm-pi-ai', ops });
```

- `refresh()` 同步捕获 `ns.user.providers`（user 层键集）作为 unset 依据；
- `model-channels` 的 groups 是数组，merge 下数组整体替换，删除天然生效，仍用 `update` 即可。

### 3.7 供应商拖动排序

- 实现：原生 HTML5 DnD（静态 bundle 只有 react 可用，不可引入 react-dnd）。
- **手势隔离**：`draggable` 只放在左侧 ⠿ 手柄上（`onClick stopPropagation`），卡片头点击展开不受影响；`onDragOver/onDrop` 挂在整卡接收。
- 视觉反馈：源卡片 `opacity: 0.45`，悬停目标品牌色描边 + 光晕。
- 排序 = 保序重建字典：`const [item] = entries.splice(from,1); entries.splice(to,0,item)`，对象键插入序即 YAML/JSON 持久化序。
- **持久化必须走 mutate 路径**（见 3.6），否则刷新即还原。

### 3.8 凭据引用归一化

DSH apiproxy 的 zod（`credentials.schema.js`）：

```js
export const credentialRefNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
```

- 该正则**不可放宽**：`apiKeyEnv` 引用同时是 POSIX 环境变量名，连字符 `-` 在 shell 标识符里非法——是官方一致性契约而非刻意严格。
- 踩坑：旧代码 `nm.toUpperCase() + '_API_KEY'` 对 `provider-22` 生成 `PROVIDER-22_API_KEY`（含 `-`）→ 整包保存 400。
- 修复：`normalizeCredentialRef` —— 合法值原样保留；非法值大写化 + 非法字符转 `_` + 数字开头补 `_` 前缀。**创建与保存两处双保险接入**。
- 官方同款参考（`dsh-client-ui-settings-models`）：`deriveKeyRef = name.toUpperCase().replace(/[^A-Z0-9]+/g,'_') + '_API_KEY'`。

### 3.9 默认请求头

取自 `pi-provider-manager/public/index.html` 的 `DEFAULT_HEADERS`（8 项浏览器伪装头），全供应商自动生效：

| Header | 值 |
| --- | --- |
| `User-Agent` | Chrome 131 / Windows 桌面 UA |
| `Accept` | `text/event-stream, text/html, application/json, */*` |
| `Accept-Language` | `en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7` |
| `Accept-Encoding` | `gzip, deflate, br` |
| `Cache-Control` | `no-cache` |
| `Connection` | `keep-alive` |
| `Origin` / `Referer` | `https://chat.openai.com` |

三个注入点：**新增供应商**初始化带上；**刷新加载**草稿合并（用户值优先，只补缺失）；**保存清洗**无条件合并。保存成功后同步 draft/state，界面立即可见。

- 轮询组无需任何请求头：引擎 `llm.stream({provider: 候选})` 走候选供应商 profile，全部 headers/凭据/compat/cache 由候选自身配置决定并继承。

---

## 4. 踩坑速记表

| # | 现象 | 根因 | 修复 |
| --- | --- | --- | --- |
| 1 | 整个引擎静默失效、命名空间未注册 | settings 服务异步初始化，`ctx.get` 在 apply 时为 undefined | `ctx.inject(['settings'], ...)` |
| 2 | 面板静默空数据、0 provider、无报错 | 响应信封 `{result:{ok,value}}` 少解一层 | 统一 `unwrap()` 并校验 `ok === false` |
| 3 | 全局健康统计始终无数据 | `ctx.on('llm/stream')` 缺 `{global:true, prepend:true}`，拦截器死在局部 Realm | 三要素齐配：global + prepend + 持久化 catch |
| 4 | 输入框打一个字母就失焦 | React 列表 key 绑定可编辑字段（`g.id + '-' + i`），每次输入 key 变化整树重建 | key 固定为稳定索引（`'rr_card_' + i`） |
| 5 | 选择候选渠道池直接白屏 | candidatePicker 空对象访问 `providers[cand.provider].models` 抛 TypeError 崩树 | 全路径解构防护 + 切换 Provider 自动联动第一个模型 |
| 6 | 拉取上游 401「check the API key」 | discoverModels 没带输入框 typedKey，且「写入存储」成功后又清空了输入框 | 传 `apiKey` 探针参数；`savedKeys[name]` 内存兜底，别清输入框 |
| 7 | 填 Key 报错 / credentials.set 失败 | 参数字段写成 `{key: ref}`，apiproxy zod schema 要求 `{ref, value}` | `apiRef.credentials.set({ ref, value })` |
| 8 | 保存新模型保存不了 | 草稿含空 id 占位行 / 空字段，schema 整包拒绝 | 提交前 Data Sanitizer |
| 9 | 刚拉取的模型立刻测试报「模型不存在」 | 拉取只写前端草稿；真实链路要求服务端已注册模型（`UNKNOWN_MODEL`） | 保存后再测 + 前端保存前友好拦截提示 |
| 10 | 动态插件重启后消失 | Cordis 动态插件是进程态临时能力 | 一切能力持久化到插件仓库源码 |
| 11 | 健康面板显示「什么都没了」 | 默认窗口「近 30 分钟」恰逢冷窗，过滤后为 0 | 引导切「近 7 天」或产生一次新调用 |
| 12 | 缓存命中率仅 ~1% | 见第 6 节专题 | 见第 6 节 |
| 13 | 拖动供应商排序后刷新顺序还原 | `settings.update` 是 merge 语义：已存在键保序（对象 spread 旧键位置不动），字典键序无法靠 patch 改写 | 改用 `settings.mutate` path-ops：先 unset 全部键，再按目标顺序 set 重插 |
| 14 | 保存失败 credential ref 必须匹配 `/^[A-Za-z_][A-Za-z0-9_]*$/` | 生成 `apiKeyEnv` 时 `toUpperCase()` 保留连字符（`PROVIDER-22_API_KEY`）；该正则 = POSIX 环境变量名契约，宿主端不可放宽 | `normalizeCredentialRef` 归一化，创建 + 保存双保险 |
| 15 | 删除供应商刷新后复活 | 同 #13 的 merge 保序：旧键留在 user 层 | mutate 的 unset 真实卸载被删键 |

---

## 5. 模型配置字段全景

> 所有字段均经 DSH 内核源码验证，出处：`@earendil-works/pi-ai/dist/types.d.ts`（`OpenAICompletionsCompat` / `AnthropicMessagesCompat`）与 `@deepseek-ai/dsh-llm-pi-ai`。

### 5.1 协议（api）：三种官方协议 + 切换结论

DSH `llm-pi-ai` 官方三协议（`PROTOCOLS` 定义）：

| api | 端点形态 | 鉴权 | 缓存特性 |
| --- | --- | --- | --- |
| `openai-completions` | `POST {baseURL}/chat/completions`（SDK 拼接） | `Authorization: Bearer` | 需 compat 打 cache 标记；官方 api.openai.com 自动 prompt_cache_key |
| `openai-responses` | Responses API | `Authorization: Bearer` | 官方端点自动缓存 |
| `anthropic-messages` | `POST {baseURL}/v1/messages` | `x-api-key` | **原生一等缓存**（cache_control 断点），Claude 系/兼容端点首选 |

**把端点改成 anthropic 格式可以吗？可以，且利于缓存**，三个前提：

1. 上游必须真实暴露 Anthropic Messages 兼容端点；
2. 模型 ID 可能需按站点文档调整；
3. `baseURL` 填根路径（协议层自动拼 `/v1/messages`）。

建议：新建副本供应商先行 A/B（「⚡测试」验证连通与延迟），确认后再切换或双格式并存，再放进轮询组做容灾。

### 5.2 Provider 级字段

| 字段 | 用途 | 面板位置 |
| --- | --- | --- |
| `displayName` | 显示名（不影响 API）；支持改名（引用自动同步 `apiKeyEnv` 不变、轮询候选联动、已存凭据继续有效） | 基础 |
| `baseURL` | 端点地址 | 基础 |
| `apiKeyEnv` | 凭据引用 = **POSIX 环境变量名**（`/^[A-Za-z_][A-Za-z0-9_]*$/`，连字符非法，面板自动归一化）；不明文存 key | 基础 |
| `models[]` | 模型列表（可按顺序自定义） | 模型列表区 |
| `defaultContextWindow` / `defaultMaxTokens` / `defaultInput` | 未配模型时的兜底 | 高级选项 |
| `headers` | 自定义 HTTP 头；**默认自动合并 8 项浏览器伪装头**（User-Agent/Accept/…/Origin/Referer） | 高级选项 |
| `reasoning` / `thinkingBudgets` | 供应商默认思考档/预算 | 高级选项 |
| `transport` | `sse / websocket / websocket-cached / auto` | 高级选项 |
| `cacheRetention` | `none / short / long` —— **省钱核心** | 高级选项 |
| `timeoutMs` / `streamIdleTimeoutMs` / `websocketConnectTimeoutMs` | 三类超时（默认流空闲 5 分钟） | 高级选项 |
| `requestImagePixelBudget` / `requestImageMaxBytes` / `maxRequestImageBytes` | 图片预算三件套 | 高级选项 |
| `retryPolicy` | 每个 provider profile 内自带重试策略 | settings.yaml 手工编辑 |

### 5.3 模型级字段

| 字段 | 说明 |
| --- | --- |
| `id` | 唯一标识，路由未配置即 `UNKNOWN_MODEL` |
| `name` | 显示别名 |
| `contextWindow` / `maxTokens` | 上下文窗 / 输出上限 |
| `input` | `['text']` / `['text','image']` 多模态 |
| `reasoningEfforts` | 各思考档（off/minimal/low/medium/high/xhigh/max）→ 上游 wire 值的映射，null=关闭 |
| `compat` | 模型级兼容覆写（优先级高于供应商级） |

### 5.4 Compat 字段（全部真实生效，均有内核证据）

**OpenAI Completions 系**：`supportsStore` / `supportsDeveloperRole` / `supportsReasoningEffort` / `supportsUsageInStreaming` / `maxTokensField` / `thinkingFormat`(10 种厂商线格式) / `requiresToolResultName` / `requiresAssistantAfterToolResult` / `requiresThinkingAsText` / `requiresReasoningContentOnAssistantMessages` / `supportsStrictMode` / `supportsLongCacheRetention` / `cacheControlFormat` / `sendSessionAffinityHeaders` / `supportsOpenAIGrammarTools` / `chatTemplateKwargs`

**Anthropic 系**：`supportsEagerToolInputStreaming` / `supportsCacheControlOnTools` / `supportsTemperature` / `forceAdaptiveThinking` / `allowEmptySignature` / `supportsStrictTools` / `supportsToolReferences` / `sendSessionAffinityHeaders` / `supportsLongCacheRetention`

典型禁用场景：Ollama/vLLM/中转站不吃 `developer` role 或 `reasoning_effort` → `supportsDeveloperRole: false` + `supportsReasoningEffort: false`。

---

## 6. 缓存命中率优化专题

### 6.1 原理：KV Cache 严格前缀匹配

上游缓存从**第 0 个 token 开始逐字匹配**。任何一处变化（哪怕几十字的时间戳出现在 System Prompt 前部），其后所有 token 的缓存全部失效。billed input = cache miss tokens 全价。

### 6.2 本例「1% 命中率」的三重根因（本会话实证）

1. **Compaction 重写历史**：会话日志实证发生过 2 次 —— `520,183 tokens / 657 消息`、`619,322 tokens / 976 消息`。每次压缩后第一条请求 = 几乎 100% 未命中，全额计费；长会话反复压缩 = 周期性费用尖峰。
2. **每回合运行时上下文注入**：`{kind:"inject", form:"snapshot", name:"@deepseek-ai/dsh-system-prompt"}` + `cordis-host-runner` 的 context 注入每回合变化（policy/approval/goal），以替换语义写进消息面 → 每回合从该位置起前缀失效。这是 agent-loop 核心行为，插件层不可移除。
3. **中转站节点漂移**：无会话亲和的第三方中转把连续请求轮询到不同副本，前缀再稳定也命中不了其他机器的缓存。~1% ≈ 连续两轮碰巧同副本。**中途换模型路由**（`DeepSeek-V4-Pro-0813-think → deepseek-v4-flash-vision-exp`）则直接切换缓存域。

### 6.3 提升命中率四件套（面板已齐全）

```yaml
# lucky-gemini 示例
lucky-gemini:
  api: openai-completions
  baseURL: https://new.lucky0625.qzz.io/v1
  cacheRetention: long                    # ① 面板：供应商高级选项 → Prompt 缓存保留
  compat:
    cacheControlFormat: anthropic         # ② Compat → 缓存控制协议规范
    supportsLongCacheRetention: true      # ③ Compat → 支持长周期 Prompt 缓存
    sendSessionAffinityHeaders: true      # ④ Compat → 会话亲和头
```

内核逻辑（`openai-completions.js:519`）：`prompt_cache_key` 仅对 `api.openai.com` 自动挂载，第三方中转必须显式 `cacheRetention !== "none"` 才走缓存路径；`cacheControlFormat: "anthropic"` 才会在 system/最后工具/最后消息打 `cache_control` 断点。

### 6.4 治本建议

- 长任务拆成多个新会话（短历史，未命中绝对成本也小）；
- 会话中途不切模型路由；
- Anthropic 格式兼容端点优先（原生缓存协议）；
- 优先 palne 上游确认「Prompt Cache 是否实现 + 是否回报 cached_tokens」—— 部分中转站不实现缓存，改配置也救不了；
- 默认 8 项浏览器伪装头与缓存正交，但对降低风控拦截概率有效（中转站常见用途）。

---

## 7. 默认值与最佳实践

| 项 | 默认值 | 说明 |
| --- | --- | --- |
| 新模型 `contextWindow` | `1048576`（1M） | 与重型 agent 长上下文匹配 |
| 新模型 `maxTokens` | `131072`（128K） | 覆盖推理预算 |
| 新模型 `input` | `['text','image']` | 多模态开箱即用 |
| 新模型 `reasoningEfforts` | `{off:null, low:'low', medium:'medium', high:'high', xhigh:'xhigh', max:'max'}` | 全档位思考映射 |
| 新轮询组虚拟模型 | 1M / 128K | 与模型默认一致 |
| 全部供应商 `headers` | 自动合并 8 项 `DEFAULT_HEADERS` 浏览器伪装头 | 用户自定义值优先 |
| 新增供应商 `apiKeyEnv` | `normalizeCredentialRef` 归一化（`provider-22` → `PROVIDER_22_API_KEY`） | POSIX 环境变量名契约 |
| 测速 | 默认关闭，prompt「欧拉函数的意义？」，ttft 键，3 并发 | 开启后 smart 键融入贝叶斯可靠性 |
| 单候选重试 | 2 次，指数退避 250ms×2ⁿ 封顶 4s | 与冷却 60s 配合 |
| 健康窗口 | 默认「近 30 分钟」，前台 5s 自动刷新 | 可切 24h / 7d |

---

## 8. 验证与部署

### 部署（profile web）

`profiles/web/package.json`：dependencies 加 `"link:/home/arcaneorion/AI/AI-DSH/plugin/model-channel-manager"`，`dsh.profile.bundles` 加包名；`pnpm install` 后重启。

### 三层验证

1. **改 Client** → 浏览器 F5，立即生效（bundle 内容 hash + no-cache）。
2. **改 Host** → 重启 DSH 一次（Node 模块内存常驻，运行时不会自更新）。
3. **验证项**：host 日志出现 `[model-channel-manager] booted, groups: ...`；settings describe 含 `model-channels` / `model-channel-health`；`llm.providers` 出现 `roundrobin/<组id>`；健康面板发出任一消息后 5s 内出现状态徽标。

### Git 纪律

- 功能 / 修复 / 文档分 commit，message 用 `feat/fix/docs(client|host|health):` 前缀。
- 提交前 `node --check src/client.js && node --check src/index.js` 强制语法验证。
- 动态插件（cordis_define/run）只做临时验证；**一切交付代码必须落入本仓库**。
- 经验迭代：每次大规模改动后同步更新本文件（踩坑表 + 字段全景 + 默认值表）。