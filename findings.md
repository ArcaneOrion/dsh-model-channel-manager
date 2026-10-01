# 复核与实现依据

- 基线：插件 0.3.15；实际安装 DSH 0.2.0-rc.1、Cordis 4.0.4。
- 原报告路径：/home/arcaneorion/AI/AI-DSH/dsh_workspace/audit-cordis/AUDIT-cordis-config-state-pollution.md。
- 复核脚本 /tmp/cordis-audit-recheck.mjs 通过（node --expose-internals）。Gateway 无 settings 可读状态；并发叶写保留；同 revision 冲突被拒；内部注释丢失；重置恢复继承。
- Loader 二次解析失败存在已复现的成功返回/磁盘与运行值分叉；正常非法 settings 输入有写盘前校验。
- 插件 digest、runtime、test/speed 请求结果仍写入 config，制造 revision 噪声和全文重写。
- 现有 README 混有 0.1 历史通道说明，交付时应重写为当前版本契约。
- 基线 npm test：94 项通过。大量旧测试按源码字符串断言，重构后将替换涉及已删除通道的断言为真实行为测试。
- 实测直接 Connection.rpc.handle 在当前安装包里遇到 webServer 注入问题；最终采用已验证的 Gateway Source Remote 标记，浏览器通过 connection.rpc.call('/api','modelChannels/invoke',{args:{method,payload}}) 调用。全部请求仍经过宿主认证，无新端口。
- RuntimeStore 使用新 model_channel_state domain，既有 model_channel_health 格式不升级。任务预留先持久化后执行，完成结果独立落盘。
- 真实 HTTP 组合已验证：状态/测试/测速不改配置与 revision；重复 id 只调用一次；取消传到模型 signal；不合法参数被拒；无 cookie 请求 401。
- 迁移测试发现 configEditor 就绪早于 storageDomain 时清理会错过；改为双方就绪后触发，迁移和重启测试通过。
- 本地 node_modules 曾在测试期间整体消失（原因未定）；从实际安装包重建链接，不修改宿主包内容。
