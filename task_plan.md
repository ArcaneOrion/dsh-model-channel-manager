# 配置与状态分离交付计划

## 目标
修正 Cordis 审计报告；将本插件健康数据、运行态与任务从 settings 配置中迁出；优化 UI；完成迁移和真实框架/浏览器验证，交付可运行版本。

## 阶段
1. [complete] 确认 API、现有测试、运行环境与迁移边界。
2. [complete] 实现独立状态/任务接口、持久化和幂等迁移。
3. [complete] 客户端接入与健康/测试 UI 优化。用户要求保留旧视觉：已恢复指标卡、供应商分组与模型卡布局。
4. [complete] 原报告已修正并备份；Loader 与 ConfigEditor 源码修复、隔离编译与已安装包验证均通过。
5. [complete] 单元、真实框架集成、浏览器与打包验证；完成安装交付和文档。

## 决策
- 现有 Gateway/Connection 可传输状态，不新增 settings.publish，不拆 volatile，不重复增加全局写队列。
- 用户已授权文档修正、实现、适度重构及 UI 优化；跨 writable roots 的落地按环境权限执行。
- 现存健康记录须先确认持久化成功再清理旧 config；旧任务不在升级后重放。
- 测试使用临时 profile 与无密钥模型适配器，不调用收费上游。

## 错误记录
- 首次 rg AGENTS.md 无匹配返回 1，后续独立读取不再串联在其后。
- uv 缓存受旧沙箱限制；恢复检查经批准后通过。目前用户已解除沙箱限制。
- 全库 pnpm 执行触发依赖重新安装，已中止；改用 esbuild 隔离编译改动模块并在实际安装的 DSH 组合中测试。
- 源码 const enum 需模拟 tsc 内联；编译验证脚本已显式内联 ACTIVE=2、UNLOADING=5。
- 初版只让 Loader 抛错仍被 Group 包含；加入 ConfigEditor raw 接受检查后完整回滚通过。
- 浏览器测试宿主需根路径 token 换 cookie；验证页面已按真实认证流程修正。
