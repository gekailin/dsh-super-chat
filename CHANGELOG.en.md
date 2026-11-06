# Changelog

[简体中文](CHANGELOG.md) | English

## Unreleased

- The panel gains an **Auto-tag** action: in the general chat, the profile's default model labels untagged messages with existing topics only. Existing tags are never overwritten, no topics are created, and agent replies inherit the tags.

## 0.1.0

First release: a Super Chat plugin built around `dsh-superagent-prototype`.

- Registers a `super-chat` Source through the prototype's public `orchestrator` service, turns chat messages into Tickets, and writes replies back to the same stream.
- One tagged chat stream: the general chat and topic views share it. Topics are tags; the first tag is a dispatch cue, and untagged messages use `general` for Superagent to decide.
- SQLite storage: indexed `message`, `topic` and `message_topic` tables, with a one-time `chat.json` migration.
- Chat-only: when both GitHub fields are empty, an in-memory `Setup` compatibility patch lets a chat-only deployment take work without modifying prototype files.
- Panel: general chat, topic views, multi-tag composer, new topics, and stopping the current view; the Super Chat entry is a chip at the right of the Superagent row title.
- WeChat: natural language with `@topic` tagging and single-stream polling; opening WeChat access starts the bridge on demand, with login and cursors under `stateDir/wechat`.
- Documentation defaults to Chinese, with English `.en.md` mirrors.
