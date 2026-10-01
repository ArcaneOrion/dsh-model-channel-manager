# Cordis 配置与运行时状态：独立复核及修正

- 修正日期：2026-10-01。
- 历史审计基线：DSH 0.2.0-rc.1、Cordis 4.0.4、model-channel-manager 0.3.15。
- 修正依据：实际安装包源码、原报告的五份快照，以及临时 profile / HTTP / 存储实验。
- 原报告存档：`AUDIT-cordis-config-state-pollution.original-20261001.md`，与原报告同目录；原始快照保持不变。

## 结论

0.3.15 插件确实把健康摘要、任务和运行态写进 profile 配置，造成全文重写与配置 revision 噪声。但这不是框架没有状态传输通道所必然导致的：DSH 已有 Gateway Remote、流式接口与 Connection 传输能力。应优先迁移插件的数据通道，不能根据本案例推导出需要拆分 volatile 或重建 Cordis 核心。

框架另有两个具体问题：配置应用失败没有可靠传回编辑器；设置编辑会复制完整继承配置，且替换节点会丢失内部注释。前者已实施针对性修复；后者涉及明确的“整行 config 替换”组合契约，本次保留契约，列为后续独立改进。

## 证据口径

- **源码确认**：直接检查实际运行包的实现，不把插件注释当作框架行为证明。
- **实验确认**：使用临时 profile 和无密钥模型适配器调用真实框架；不修改用户 profile 来制造实验结果。
- **历史快照确认**：核对文件哈希、大小与解析后的字段差异；不能据此证明采样之间的全部事件数量或原审计人的操作历史。
- **未测量**：没有实测 SSD 写入放大、每日写入量、每轮工具调用与模型请求的严格对应关系。

## 对原报告逐项纠正

| 原编号 | 复核结论 | 依据与边界 |
|---|---|---|
| AP-01 / 03 / 05 / 06 | 成立 | Settings 的 live 表单投影 Config 中的 volatile 字段，写入 ConfigEditor，目标为 profile patch。 |
| AP-02 / DP-02 | “全系统唯一读通道”不成立 | Settings 本身不是状态总线，但 Gateway 支持独立服务方法。实验在不挂载 Settings 时成功读取运行时对象；新的插件 API 又通过真实 HTTP 验证。 |
| AP-04 | 只有 `applies: live` 是局部事实 | 表示 Settings 的生效方式，不能推出所有 UI 都不能展示只读状态，更不能推出全框架没有其他通道。 |
| AP-07 | 整个文件原子重写成立 | ConfigEditor 先读取并合并配置，再替换 YAML config 节点。不能从最后的整节点替换推断它没有锁或合并机制。 |
| AP-08 / 09 / 10 / DP-01 | volatile 的描述不准确 | 稳定引用与免重挂载是相关语义；普通 diff 跳过 volatile 后，Loader 仍解析、比较 ref.get()、提交并发事件。实验保持相同实例和引用并收到更新通知。没有证据证明必须拆成多个标记。 |
| AP-11 | `_config` 赋值不是写盘 | 写盘在 ConfigEditor；Loader 中相邻同步语句本身不能证明存在可被任意异步写入插入的窗口。 |
| AP-12 / DP-03 | 有条件成立 | 旧版直接 Loader 更新解析失败，会保留旧引用、接受新 raw 并只记录警告。正常 Settings 非法输入会被预校验挡住；故障注入证明“预校验成功、提交阶段再次解析失败”能导致文件 77、运行值 6、调用却成功返回。 |
| AP-13 / DP-04 | 嵌套写入限制成立 | 实测 `HMR transactions cannot be nested`。这是防重入约束；响应配置变化不总需要再次写配置。迁移状态和任务后，正常业务已不再需要这类回写。 |
| AP-14 | 插件的写入动机成立 | 插件为了 client 渲染而写摘要，但动机不证明这条路径不可替代。 |
| DP-05 | “无框架级队列”不成立 | ConfigEditor 使用文件锁、先 reconcile 外部变动，再在锁内读取 current；HMR 还有共享队列。两个并发叶写都保留；同 revision 的并发编辑拒绝一个。调用方自己提交陈旧整树快照仍可能覆盖数据，这不是加一条队列即可修复的问题。 |
| DP-06 | 复制继承值成立，“不可逆”不成立 | 单字段编辑会将其他继承字段一起物化到 profile；实验通过 reset 删除覆盖并恢复继承。 |
| “注释完整保留” | 不成立 | YAML 替换节点之外的注释可保留；实验中 config 内部及行尾注释丢失。 |

## 历史快照复核

五份文件均为 144160 字节，MD5 前 16 位依次为：

```
7a753d66d1c17eb2
02c1203d4d1545ca
b03cb7cfdcdf5884
52c8bdbd8b690a1a
b35e5d1349c784b6
```

解析后比较确认，所有变化都在 `model-channel-manager.config.health`；非 health 内容一致。这支持“健康状态进入配置文件”的现象判断。

原报告的外推需要撤回：

1. 五个采样点在 100 秒内只能直接证明**至少四次**内容变化，不能精确断言五次写入，也不能据此计算“平均每 20 秒写一次”。
2. 文件字节数不变不能单独证明变化的一定是等宽数字；字段性质由 diff 确认。
3. `Date.now() - lastDigestWriteAt < 60000` 是执行 flush 时的去重判断，不是独立周期定时器；完全空闲时不因这一判断自动每分钟写盘。
4. 未运行的 tui 文件不变是辅助证据，不能排除所有外部进程、只针对 web 的工具或其他写入者。
5. 工具调用、模型调用、健康事件与写盘次数并非严格一一对应；5 秒内多个事件可以合并。原报告的“审计每一个字都导致写盘”不作为证据。
6. 每日 207 MB、SSD 寿命影响以及“每轮对话重写一次”均未得到足够测量支持。

## 0.4.0 已实施的插件改进

- Config 仅保留用户配置。旧 health 是非 live 的迁移输入，导入并归档成功后删除。
- 健康事件和测速结果继续使用既有 `model_channel_health` domain；运行态和任务结果进入 `model_channel_state`。
- UI 使用独立 `modelChannels/invoke` Gateway 接口，健康刷新和任务不调用 Settings 写入。
- 模型任务先保存幂等编号再执行；预留失败不调用模型。重复请求复用结果，取消传给上游，重启时未完成任务标记 ABORTED 而不重放。
- 健康统计按实际事件时间划分窗口，延迟分母只包括有效样本；保留原有供应商分组、指标卡和模型卡视觉布局。
- 提供商写入不再误映射为 health；提交前比较真实编辑基线，避免“读取最新 revision 后覆盖别人的修改”。

保留窗口仍有每桶 300 条 / 7 天限制，因此 UI 的精确窗口指对保留样本精确筛选，不能宣称无限历史全量统计。

## 已实施的框架修复

只改 `_commitVolatile()` 的返回值不足以修复调用链。进一步实验发现 Group 会捕获子项错误并记日志，因此修复分两层：

1. Loader 在 volatile 候选解析失败时恢复旧 entry options 与 Fiber raw config，并抛出 `CORDIS_VOLATILE_CONFIG_INVALID`；运行中的有效引用保持不变。
2. ConfigEditor 在 reconcile 后检查目标 entry 的 raw config 是否等于提交值。若 Group 包含了 Loader 错误但未传播，编辑器仍能识别未应用并触发已有的文件回滚逻辑。

已验证：第二次解析故障使 Settings 拒绝；文件、raw 和运行引用全部保持原值；随后正常编辑仍能提交。原有并发队列、防嵌套事务和普通配置重载语义保留。

源码修改位于 DeepSeek Harness 的 `vendor/loader/src/config/entry.ts` 与 `packages/boot/config-editor/src/index.ts`，连同回归测试及 vendor 修改记录。插件仓库保留源码补丁和可回滚的本地应用脚本。此本地依赖补丁会被包管理器重装覆盖，需要上游纳入发布版本或重新检查应用。

## 复现与交付验证

插件仓库：`/home/arcaneorion/AI/AI-DSH/plugin/model-channel-manager`。

```sh
npm test
node scripts/verify-framework.cjs /path/to/deepseek-harness/vendor/loader/src/index.ts
node --test tests/framework/volatile-rollback.cjs
```

- `tests/runtime-api.test.cjs`：真实 profile + Gateway / HTTP / LLM / JSON storage 组合，覆盖配置不变性、认证、迁移、恢复、去重、取消与参数边界。
- `tests/framework/volatile-rollback.cjs`：真实编辑链的第二次解析故障、回滚、引用稳定性与后续恢复。
- `tests/browser/e2e.py`：实际客户端模块的卡片布局、精确窗口、刷新隔离、失败提示、移动宽度、模型测试和保存冲突。
- `docs/screenshots/`：界面截图与浏览器验证结果。

源码级断言只能确认实现形态；交付判断以真实行为测试为主。原报告未经验证的断言已从结论移除，不再用插件注释或推断冒充运行时证据。
