# Architecture

This document describes the single chat stream, topic tags, SQLite storage, superagent dispatch, model settings, workspace grouping, the host/browser split, the HTTP contract, and the two narrow patches.

English | [简体中文](architecture.zh.md)

## Components

| File | Runtime | Responsibility |
| --- | --- | --- |
| `src/index.ts` | host | Reads configuration, opens SQLite, mounts the superagent Source, the fallback Session, the HTTP API and the list patch. |
| `src/store.ts` | host | `chat.sqlite`: messages, topics, message-topic links, indexes, one-time legacy `chat.json` migration, and manual replacement of one message's tags. |
| `src/session.ts` | host | The single fallback DSH Session (`super-chat-general`) used when superagent is unavailable. |
| `src/transport.ts` | host | `ChatTransportRouter`: chooses superagent or the fallback Session per operation. |
| `src/superagent.ts` | host | The core `super-chat` Source, topic dispatch, Channel/Thread context, role-model settings, the per-worker model directive, and the memory-only chat-only Setup patch. |
| `src/models.ts` | both | Role-model shapes, the catalog view, the worker-model directive parser and reference resolution shared by the host and the dialog. |
| `src/tagger.ts` | host | On-demand topic judgement for existing messages through the profile default model; only empty tags are filled, and agent replies inherit them. |
| `src/wechat-bridge.ts` | host | WeChat bridge lifecycle and keep-alive: starts on demand before sign-in, and automatically resumes and monitors the bridge while saved credentials exist; reuses an external bridge and stops only the child it started. |
| `src/api.ts` | host | `/super-chat/api/*`: validation, same-origin guard, topic resolution and message storage. |
| `src/monkey.ts` | host | Filters `super-chat-*` Sessions out of `sessionController.list`. |
| `src/workspace-group.ts` | both | Shared workspace-group shape and the browser-side merge projection. |
| `src/workspace-group-host.ts` | host | Ensures the prototype state-directory Workspace, attaches and pins the orchestrator Session. |
| `src/protocol.ts` | both | Shared ids, limits, message/topic shapes and text helpers. |
| `src/client/index.tsx` | browser | Registers the `main` panel, dictionaries and the `sidebar.panellist` entry; mounts the Super Chat shortcut at the right of the Superagent row, keeping a standalone entry as fallback. |
| `src/client/workspace-group.ts` | browser | Wraps the Workspace snapshot to fold ticket Workspaces into the Superagent group. |
| `src/client/chat.tsx` | browser | Newest-page paging with scroll-up for older pages, the `<No topic>` view, tag input, new topics, per-message tag editing, stop and polling. |
| `src/client/api.ts` | browser | Same-origin request helper (`x-super-chat-request`, JSON body, typed errors) used by every panel request. |
| `src/client/models.tsx` | browser | The Models entry and dialog: orchestrator and default-worker selectors backed by the catalog and role settings. |
| `src/client/markdown.tsx` | browser | Safe Markdown-to-React rendering for agent replies; the parser covers common chat syntax and never interprets authored HTML. |
| `src/client/topics.ts` | browser | Tag-name merging, input parsing and message-tag display helpers. |
| `src/client/text.ts` | browser | Relative and short-date timestamp formatting for message metadata. |
| `src/client/locales.ts` | browser | Simplified Chinese and English dictionaries for the panel and WeChat dialog. |
| `src/client/dsh.ts` | browser | Minimal local type contracts for the DSH client plugin context (`slots`, `locale`, `layout`, `workspaces`). |
| `src/client/wechat.tsx` | browser | WeChat access entry and scan/status/sign-out window backed by the local bridge on `127.0.0.1:8790`. |

The browser half has no runtime imports of DSH packages: it requires only `react` (provided by the DSH module loader) and receives `slots` and `locale` through the client plugin context.

## Data model

Data lives in `stateDir/chat.sqlite` and is accessed synchronously with `node:sqlite`:

```sql
CREATE TABLE topic (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE message (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  at TEXT NOT NULL,
  kind TEXT,
  via TEXT
);
CREATE TABLE message_topic (
  message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  topic_id TEXT NOT NULL REFERENCES topic(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (message_id, topic_id)
);
CREATE INDEX message_at ON message(at);
CREATE INDEX message_topic_topic ON message_topic(topic_id, message_id);
```

- There is one message stream; topics are tags on messages, not separate conversations. One message may carry several topics and appears in several topic views.
- Message ids are globally unique and deduplicate retries. At most `MESSAGE_LIMIT` (1000) messages are kept; the oldest are trimmed.
- Topic names are case-insensitive and unique; at most `TOPIC_LIMIT` (200) topics.
- A topic view filters by `message_topic.topic_id`; All messages reads the whole stream ordered by `message.seq`. Reads return one page (50 messages by default, at most `VIEW_LIMIT`), newest first internally and oldest first on the wire; `before=<oldest id>` walks to the previous page.
- An old `chat.json` is imported when the database is empty: v1 conversations are flattened into the general stream; after a successful import the old file is renamed `chat.json.imported-<timestamp>`. An unreadable file is renamed `.corrupt-<timestamp>` and does not block startup.
- SQLite uses WAL; one profile has exactly one writing process.

## Chat flow and dispatch

```
browser
  │ GET /super-chat/api/chat?topic=<id>&before=<id>&limit=<n>   read a page
  │ POST /super-chat/api/chat {text,tags}                       send a message
  ▼
ChatStore (SQLite)
  │ appendUser / resolveTags
  ▼
ChatTransportRouter
  ├─ superagent available: superagent.deliver(message, topics)
  └─ otherwise: GeneralSession.deliver(message, topics)
```

### superagent dispatch

- Tagged: the first topic id selects the dispatch thread `super-chat:topic:<topicId>`; the remaining tags travel in Trigger meta and the text cue.
- Untagged: dispatch thread `super-chat:general`; Superagent's assessment decides whether to accept, split or ignore.
- The Trigger text is prefixed with `[topics: names…]`; the chat store keeps the original text.
- The Channel address carries `topics=<ids>`; replies are written back with those tags, so one reply appears in the general chat and its topic view.
- Thread context reads the dispatch topic's messages; an untagged Trigger reads the general stream.
- Topics are cues, not hard partitions: Superagent can still decide otherwise or route the work to another Ticket.

### Models

The **Models** dialog reads the profile catalog through `sessionController.modelCatalog()` and the prototype's current roles through `store.settings()` (`eval.model` and `executor.model`). A save sends the complete block from the current settings plus the chosen `model` to `settings.save(block, value, blockRevision(block), 'panel')`; the prototype validates the route and keeps its own history, and the plugin retries once when a concurrent save changed the block revision. A null role saves `model: null`, which inherits the deployment default.

Saving the orchestrator role also appends a `model/selection` session event to the live orchestrator Session (`agent.id === orchestrator.masterId`), so the switch takes effect on that Session's next request and persists; later orchestrator Sessions read the saved `eval.model`. Saving the worker role changes only `executor.model`, which the prototype reads when it creates the next worker Session; a running worker keeps its model.

A chat message may carry a worker-model directive, in Chinese (`用 gemini-4-argon 模型启动一个新 worker 做…`) or English (`use gemini-4-argon model to start a new worker for…`). `src/models.ts` recognizes the phrase only when the message also asks to start or run a worker; the model reference may be a `provider/model`, an exact model id or an exact display name, with an optional `@effort` suffix. `POST /chat` resolves it before storing the message, so an unknown or ambiguous reference returns 400 without creating work. The resolved route is attached to the delivery and remembered under the message's Trigger id for at most 30 minutes (bounded to 50 entries).

The prototype creates a worker Session as `worker-<ticket id>` (documented in its `003-execution.md`) and seeds `executor.model` in `Sessions.ensure` after `sessionController.create` resolves. The plugin listens to DSH's public `agent/created` event: while the Ticket that owns the new Session has a pending directive, it appends the directive's `model/selection` before the prototype's seed runs. DSH's live selection cache does not observe an event appended by another plugin, so the plugin also injects the selection into prompt assembly and the request for that one request (the same public waterfall the prototype uses for its own role model), clearing it at the request header. The worker's first request therefore uses the chosen model, and later requests follow the recorded header. The orchestrator switch uses the same one-request injection, so it takes effect on the next request. A listener failure is logged and never fails Session creation. A Session that already made a request is left alone; when the selection is applied, the chat gains a short `note` message in the user message's topics. The directive affects only a newly created worker Session: a message that joins an existing Ticket keeps that worker's model.

### Fallback Session

- Exactly one Session: `super-chat-general`.
- Its prompt also carries topic cues; assistant messages and failed turns are written back to the stream and inherit the last user message's tags.
- The fallback creates no Session per topic and no Tickets; it only keeps chat usable without the prototype.

### All messages and `<No topic>`

The panel's main view is **All messages**, which reads the chat stream newest-page first: opening the panel shows the latest messages at the bottom without replaying the stream, and scrolling to the top fetches the previous page with `before`. The sidebar's **`<No topic>`** entry is neither a topic nor a separate storage or dispatch partition: it is the same stream filtered at read time to messages without tags, so it pages and counts without copying messages. Its sidebar count is the total untagged count, and untagged messages still use `super-chat:general` for Superagent to decide. Polling merges only the newest page into the loaded stream; it never reorders the loaded messages, and it keeps the reader's position unless they are at the bottom.

### Markdown replies

Assistant messages are rendered as Markdown in the browser. The parser covers headings, paragraphs, fenced and inline code, ordered and unordered lists (including one nested level), block quotes, horizontal rules, emphasis, links and bare URLs. It builds React elements rather than an HTML string, so authored HTML is shown as literal text and only `http:`, `https:` and `mailto:` link destinations become anchors. User messages and every raw view keep the authored text unchanged. Each assistant message has a **Raw** button; toggling it shows the original Markdown and a **Rendered** button switches back. The parser is local to the browser half and adds no runtime dependency.

### Auto-tagging

The **Auto-tag** action at the top of the All messages view runs on demand. It handles only untagged user messages among the most recent `TAG_WINDOW` (`VIEW_LIMIT`, 200) messages and lets the profile's default model choose among **existing topics**; it creates no topics and overwrites no tags. The model is called directly through the public `llm` service, with the route from `agentDefaultModel`, so no extra Session is created and the model receives no tools. A run sends at most `TAG_WINDOW` (`VIEW_LIMIT`) messages with each text truncated to 1000 characters and gives up after 90 seconds; a reply that is not valid JSON is retried once, and a second failure leaves the stream untouched and reports an error in the panel. After tags are written, untagged agent replies inherit the tags of the nearest preceding user message. Those writes and the inheritance share one transaction, so topic counts and views stay consistent.

### Manual tag editing

Every message's tag row has an **Edit tags** action. It removes existing tags one by one and adds names typed into the input; saving replaces that message's tags only, and a new name creates a topic. Unlike auto-tagging, a manual edit does not make agent replies inherit tags and does not dispatch work or create messages. Clearing every tag returns the message to the untagged state, so a later auto-tag run can handle it again. The replacement happens in one transaction.

## HTTP contract

All requests require `x-super-chat-request: 1`; `Host` must match the listening address (or a loopback spelling), and a foreign `Origin` is rejected. POST bodies are JSON and limited to 64 KiB.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/super-chat/api/health` | — | `{ ok, messages, topics }` |
| GET | `/super-chat/api/workspace-group` | — | `{ group: { root, workRoot, workspaceId, title, orchestratorSessionId? } \| null }` |
| GET | `/super-chat/api/models` | — | `{ available, error?, default?, orchestrator, worker, groups, failures }` |
| POST | `/super-chat/api/models` | `{ role: 'orchestrator' \| 'worker', model: { provider, model, reasoningEffort? } \| null }` | the same model view after the save |
| GET | `/super-chat/api/chat?topic=<id>&before=<id>&limit=<n>` | — | `{ topic?, topics, messages, olderCursor?, hasOlder?, untaggedCount, mode, busy? }` |
| GET | `/super-chat/api/chat?untagged=1&before=<id>&limit=<n>` | — | `{ topics, messages, olderCursor?, hasOlder?, untaggedCount, mode, busy? }` |
| POST | `/super-chat/api/chat` | `{ text, tags?, topic?, clientId?, via? }` | `{ result, topic?, topics, messages, olderCursor?, hasOlder?, untaggedCount, mode, busy? }` |
| POST | `/super-chat/api/chat/tag` | — | `{ tagged, topics, messages, olderCursor?, hasOlder?, untaggedCount, mode, busy? }` |
| POST | `/super-chat/api/chat/tags` | `{ id, tags, topic? }` | `{ result, topic?, topics, messages, olderCursor?, hasOlder?, untaggedCount, mode, busy? }` |
| POST | `/super-chat/api/topics` | `{ name }` | `{ topic, topics }` |
| POST | `/super-chat/api/topics/rename` | `{ id, name }` | `{ topic, topics }` |
| POST | `/super-chat/api/chat/cancel` | `{ topic? }` | `{ cancelled, topic?, topics, messages, olderCursor?, hasOlder?, untaggedCount, mode, busy? }` |
| POST | `/super-chat/api/wechat/start` | — | `{ ok, result: 'running' | 'started' }` |

- `tags` is an array of topic names; the server resolves and creates missing topics and stores topic ids on the message.
- `topic` is the selected view id used to return the same view; it is not a tag.
- `untagged=1` selects messages with no topic tag; it cannot be combined with `topic`.
- `messages` is one page, oldest first. `limit` is an integer from 1 to `VIEW_LIMIT` (200), defaulting to `MESSAGE_PAGE` (50). `olderCursor` is the oldest message in the page; pass it as `before` to read the previous page, and `hasOlder` says whether that page can be non-empty.
- `untaggedCount` is the total number of untagged messages in the retained stream, used for the sidebar count.
- A duplicate `clientId` returns `duplicate` and is not delivered again.
- `chat/tag` fills existing topics only on untagged messages; `tagged` counts the messages that gained tags, including replies that inherited them.
- `chat/tags` replaces one existing message's tags with the submitted set; names resolve and create missing topics, and an empty array clears the tags.
- `mode` is `superagent` or `session`; `busy` means the selected view has an open Ticket or a running fallback turn.
- `models` reads the profile catalog and the prototype's role settings; with Superagent unavailable it returns `available: false` instead of failing. A save validates `role`, requires an explicit `model` object or `null`, and answers 409 when the transport is not in superagent mode; a prototype validation failure keeps its own message.
- `POST /chat` resolves a worker-model directive before storing the message. An unknown or ambiguous model returns 400 and stores nothing; `tags` and deduplication behave as usual otherwise.

## WeChat bridge

`wechat/` is a separate Node.js process defaulting to the general chat. `src/wechat-bridge.ts` owns its lifecycle and keep-alive: before sign-in it starts on demand only when the user opens the WeChat access dialog; once `stateDir/wechat/creds.json` exists, host startup and background checks keep the bridge running and automatically recover it across host restarts or unexpected exits without waiting for a panel click. It probes `8790/health` and reuses an existing bridge, otherwise spawns one, and stops only the child it started. Credentials, cursors and the outbox live under `stateDir/wechat/`; an old manual `wechat/creds.json` is copied once.

- `@topic` tokens are parsed as topic names, removed from the body, and submitted as `tags`; several tokens produce several tags.
- Single-stream polling: the bridge reads `GET /chat?limit=200` and forwards agent messages after its cursor to WeChat; tagged replies get a `「topic」` prefix. The full window keeps its last-delivered cursor inside the fetched page while the panel pages 50 at a time.
- There is no command system; `/list` and similar text are ordinary messages.
- The bridge reaches `/super-chat/api/chat` over loopback only; the plugin host never sees WeChat credentials.

## Session-list monkey patch

### Why

DSH renders every Session in the workspace browser. Super Chat's fallback Session is a real Session but should not appear as an ordinary user Session. DSH 0.2.1 has no public “hidden Session” flag, so the only local seam is the list response.

### What

```ts
const original = ctx.sessionController.list
ctx.sessionController.list = async function (request, signal) {
  const value = await original.call(this, request, signal)
  return { ...value, items: value.items.filter(item => !item.sessionId.startsWith('super-chat-')) }
}
// disposed with the plugin:
if (ctx.sessionController.list === wrapper) ctx.sessionController.list = original
```

- Only reads `items`; unknown extra fields are preserved by spreading `...value`.
- If another plugin wraps `list` later, this plugin's disposer leaves the newer wrapper alone; restoration order is handled as before.
- The patch does not touch `create`, `resolveAgent`, `prompt`, `cancel`, `rename` or other methods.

## Superagent workspace grouping

The prototype's orchestrator Session lives in `stateDir`, while each ticket worker lives in its own ticket directory. The DSH workspace browser groups by Workspace, so a fresh deployment shows one group per ticket. Once the prototype is configured the plugin uses the public `workspaceRegistry` to:

- call `create(stateDir, 'Superagent')`, ensuring the group Workspace exists; a title still equal to the state directory basename is renamed to `Superagent`, while a user-chosen title is kept;
- attach the orchestrator Session to that Workspace and add it to the registry pin set. `attachSession` requires the Session header cwd to equal the Workspace path; when it fails the browser still renders the Session id.

The browser half reads `GET /super-chat/api/workspace-group` every five seconds. With a group it wraps `ctx.workspaces.list`'s `getSnapshot`: every Workspace under `workRoot` (default `<stateDir>/work`, otherwise the settings' `executor.directory`) leaves the snapshot and its Session ids join the group Workspace's `sessionIds`. The merge is a client projection only: the Host registry, each Session's header cwd, working directory and execution environment stay unchanged. The merged snapshot keeps the same object while its inputs do not change, so React does not re-render for a no-op.

Deleting the group Workspace registration removes it from the snapshot, so the browser restores the per-ticket groups automatically; stopping the plugin restores the original source. Limits: only Workspaces under that state directory and executor directory are covered; creating a Session inside the group targets the state directory; Host changes surface at most one polling interval later.

## Same-origin and CSRF

The panel and API are same-origin. A custom request header cannot be set by a cross-site form, and cross-site `fetch` requires a CORS preflight this server never grants; the `Origin` check is additional defence. This is not authentication: DSH's Web server authenticates the human, and a local process can still call the route. Keep it on loopback unless the deployment has its own network controls.

## Concurrency and durability

SQLite writes run synchronously on the Node event loop; one profile has one plugin process. Messages and message-topic links are written in one transaction so indexes stay consistent. WAL lets reads and writes proceed together; the database is closed when the plugin stops. HTTP handlers share no mutable request state.

## Compatibility

- `dsh-superagent-prototype` setup normally requires GitHub. When both GitHub fields are empty, the plugin wraps its `Setup` class in memory so `run` returns an empty deployment, then asks the prototype to restart. No prototype file is modified. This compatibility path covers the chat Source only; Feishu still needs GitHub configured as the prototype expects. If `Setup.run` changes shape, the patch stops applying and chat falls back to the general Session.
- Source registration, Policy seeding, the Channel and the role-model settings use only the prototype's public shape; no prototype internals are imported.
- The worker-model directive depends on public DSH and prototype facts: DSH emits `agent/created` before the Session's first request, the `system-prompt/assemble` and `agent/request` waterfalls carry an injected selection, and the prototype names a worker Session `worker-<ticket id>` and seeds `executor.model` in `Sessions.ensure` after creation. If these change, the directive stops applying (workers keep the configured default) while everything else keeps working.
- An old `chat.json` is imported once; the topic/tag structure is described by the SQLite schema and this document.
