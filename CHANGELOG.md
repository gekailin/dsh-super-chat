# Changelog

English | [简体中文](CHANGELOG.zh.md)

## Unreleased

- The **Models** entry has moved from the sidebar foot into the composer, immediately left of **Send**; a narrow panel keeps it as an icon with its tooltip.
- Removed the outdated `docs/screenshot.png`, which included real workspace names.
- Agent replies render common Markdown (headings, lists, quotes, links, fenced and inline code); each reply has a **Raw** button in its bubble's corner to switch back to the original text, and user messages stay as authored.
- The panel gains a **Models** dialog: it chooses the orchestrator model and the default model for new workers from the profile catalog, sharing the prototype's `eval.model`/`executor.model` settings and save history. Saving the orchestrator model also switches the live orchestrator Session.
- Chat messages can ask for one new worker's model: `用 gemini-4-argon 模型启动一个新 worker 做…` or `use gemini-4-argon model to start a new worker for…`. The model is resolved before the message is stored and applied to that worker Session before its first request; the panel shows a short note once it is in place.
- Worker-model directives use DSH's public `agent/created` event and the prototype's documented `worker-<ticket id>` Session naming; no prototype file is modified. Unknown or ambiguous model names are reported without sending the message, and a directive affects only a newly created worker.

## 0.2.0

- The panel opens on the newest messages and fetches older pages when you scroll up, instead of replaying the whole stream from the top. Polling keeps the loaded pages and the reader's position.
- The `<No topic>` view is filtered at read time and shows a live untagged count in the sidebar; its messages page the same way as the other views.
- Documentation now defaults to English; Chinese versions use the `.zh.md` suffix.
- The panel gains an **Auto-tag** action: in the general chat, the profile's default model labels untagged messages with existing topics only. Existing tags are never overwritten, no topics are created, and agent replies inherit the tags.
- Each message now has manual tag editing: add or remove tags and save; a new name creates a topic, and only that message's tags change.
- The panel's "General chat" is now "All messages", with a new "<No topic>" view that lists only untagged messages.
- The workspace sidebar gains a Superagent group: with the prototype installed, the orchestrator and every ticket worker share one group with the orchestrator pinned first. The merge is presentation-only and does not move a Session's working directory.
- Fixed data consistency and concurrency edge cases: evict the oldest unused topic at `TOPIC_LIMIT` while protecting newly resolved tags in the same batch, quarantine corrupt SQLite databases or stale schemas alongside `-wal`/`-shm` sidecars, unregister the Source if `SuperagentChat.stop()` races with connection startup, sequence `send`/`stop` requests and sync `topicId` after tagged sends, ignore Enter during IME composition, and harden WeChat bridge origin/header checks, login/logout races, inbound `seen` persistence and 4xx outbox handling.

## 0.1.0

First release: a Super Chat plugin built around `dsh-superagent-prototype`.

- Registers a `super-chat` Source through the prototype's public `orchestrator` service, turns chat messages into Tickets, and writes replies back to the same stream.
- One tagged chat stream: the general chat and topic views share it. Topics are tags; the first tag is a dispatch cue, and untagged messages use `general` for Superagent to decide.
- SQLite storage: indexed `message`, `topic` and `message_topic` tables, with a one-time `chat.json` migration.
- Chat-only: when both GitHub fields are empty, an in-memory `Setup` compatibility patch lets a chat-only deployment take work without modifying prototype files.
- Panel: general chat, topic views, multi-tag composer, new topics, and stopping the current view; the Super Chat entry is a chip at the right of the Superagent row title.
- WeChat: natural language with `@topic` tagging and single-stream polling; opening WeChat access starts the bridge on demand, with login and cursors under `stateDir/wechat`.
- Documentation defaults to English, with Chinese `.zh.md` mirrors.
