# 安全

[简体中文](SECURITY.md) | [English](SECURITY.en.md)

本插件在 DSH Web server 上运行一个 HTTP 路由，并让一个 agent Session 访问 workspace。请据此评估风险。

- 除非部署有自己的网络控制，否则让 DSH Web server 保持 loopback。自定义的 `x-super-chat-request` 请求头和 `Origin` 检查是 CSRF 防护，不是身份认证。
- 聊天数据保存在 `stateDir` 的 `chat.sqlite`（以及 WAL/SHM 文件）中，权限为仅本人可读。本插件不会上传它们，但消息会像普通 Session 一样发送给 profile 配置的模型提供方。
- 谨慎选择 `cwd` 和 `permissionPreset`。面板没有审批 UI，需要询问的审批 preset 可能让回合一直等待；见 README。
- 不要把 `stateDir`、`chat.sqlite`、模型凭据或聊天数据导出提交到仓库。默认 `stateDir` 位于插件 checkout 之外。

如需报告漏洞，请使用仓库的私有安全公告表单，不要开公开 issue。请附上插件版本、DSH 版本，以及不包含真实凭据或私密聊天内容的最小复现。
