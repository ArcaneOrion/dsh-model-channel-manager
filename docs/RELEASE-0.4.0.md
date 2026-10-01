# 0.4.0 交付记录

- 发布包：`dist/arcaneorion-dsh-model-channel-manager-0.4.0.tgz`。
- 校验和与机器可读验收结果：`dist/release-validation.json`。
- 当前 web profile 已通过本地 link 指向本工作树。
- 已安装的 Loader / ConfigEditor 已应用补丁，原文件保存在 `backups/framework-1790854153373/`。运行中的 DSH 进程需要重启才能加载这两个依赖文件的变化。
- 未向 npm 或远程 Git 仓库发布。

## 实现

健康数据、路由运行态和模型/测速任务已迁出 Settings；Config 仅承载用户配置。旧 health 先归档并导入存储，全部成功后再删除。任务预留持久化失败不会调用模型，未完成历史任务不会自动重放。

按用户反馈恢复原健康页面视觉：四张指标卡、供应商分组、模型卡片、状态点和可用率条。保留精确窗口统计、失败时保留上次数据，以及窄屏工具条换行。

框架修复包括 Loader 拒绝非法 volatile 候选并还原 raw/options，以及 ConfigEditor 检查提交是否真正被接受。原报告已原地修正、原版另存。

## 验证

| 检查 | 结果 |
|---|---|
| `npm test` | 80 项通过，0 失败，0 跳过 |
| 修改后的 Loader / ConfigEditor 源码隔离编译及回归 | 2 项通过 |
| 实际安装包的配置应用失败/回滚回归 | 2 项通过 |
| `npm run test:browser` | 8 组检查通过，无页面运行错误 |
| 发布包解包并启动真实 profile | 启动、RPC、模型任务、持久化和配置不变性通过 |
| 两个仓库 `git diff --check` | 通过 |
| ConfigEditor 中英文文档一致性检查 | 通过 |

浏览器验证使用真实 React 和本包客户端模块，后端是临时 profile 内的真实 Gateway、Connection、LLM 与 JSON storage；配置编辑页面的 Remote 使用可控测试数据。没有调用收费上游，也没有通过用户生产 profile 制造测试事件。未运行上游仓库的全量测试。

## 后续边界

- Settings 的整行 config 覆盖与 YAML 内部注释保留问题未改动；它们涉及现有组合契约，应作为独立变更处理。
- 健康统计的时间筛选是精确的，但数据保留仍限制为每桶 300 条、最多 7 天。
- 本地框架补丁可能被宿主依赖重装覆盖；可通过 `node scripts/apply-framework-fix.cjs` 检查，或由上游正式纳入发布。
