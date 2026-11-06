# 更新日志

[简体中文](CHANGELOG.md) | [English](CHANGELOG.en.md)

## Unreleased

- 面板新增「自动打标签」：在通用聊天里用 profile 默认模型判断未打标签的消息，只套用已有主题；不覆盖已有标签，不创建主题，agent 回复继承标签。
- 每条消息支持手动编辑标签：逐条增删标签并保存，可新建主题；只替换该消息的标签。
- 面板的“通用聊天”改名为“全部消息”，并新增“<无主题>”视图，只显示未打标签的消息。
- 工作区新增 Superagent 分组：装了 prototype 时，orchestrator 与各工单 worker 的 Workspace 合并为一组，orchestrator 置顶；只在浏览器侧合并展示，不改变 Session 工作目录。

## 0.1.0

首个版本：面向 `dsh-superagent-prototype` 的 Super Chat 插件。

- 通过 prototype 公开的 `orchestrator` 服务注册 `super-chat` Source，把聊天消息变成 Ticket，回复写回同一聊天流。
- 单流聊天 + 多主题标签：通用聊天与主题视图共享一条流；主题是标签，首个标签作为 dispatch cue，无标签消息走 `general`，由 Superagent 自行判断。
- SQLite 存储：`message` / `topic` / `message_topic` 表和索引；旧 `chat.json` 一次性迁移。
- chat-only：GitHub 两项为空时，在内存中兼容 prototype 的 `Setup`，让纯 chat 部署也能接单；不修改 prototype 文件。
- 面板：通用聊天、主题视图、多重标签输入、新建主题、停止当前视图；Super Chat 入口作为 Superagent 行标题右侧的 chip。
- 微信：自然语言 + `@主题` 打标，单流轮询；打开接入时按需启动桥，登录态和游标存在 `stateDir/wechat`。
- 文档默认中文，英文版本为同目录 `.en.md`。
