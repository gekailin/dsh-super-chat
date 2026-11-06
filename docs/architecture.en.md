# Architecture

This document describes the single chat stream, topic tags, SQLite storage, superagent dispatch, the host/browser split, the HTTP contract, and the two narrow patches.

[简体中文](architecture.md) | English

## Components

| File | Runtime | Responsibility |
| --- | --- | --- |
| `src/index.ts` | host | Reads configuration, opens SQLite, mounts the superagent Source, the fallback Session, the HTTP API and the list patch. |
| `src/store.ts` | host | `chat.sqlite`: messages, topics, message-topic links, indexes, one-time legacy `chat.json` migration, and manual replacement of one message's tags. |
| `src/session.ts` | host | The single fallback DSH Session (`super-chat-general`) used when superagent is unavailable. |
| `src/transport.ts` | host | `ChatTransportRouter`: chooses superagent or the fallback Session per operation. |
| `src/superagent.ts` | host | The core `super-chat` Source, topic dispatch, Channel/Thread context, and the memory-only chat-only Setup patch. |
| `src/tagger.ts` | host | On-demand topic judgement for existing messages through the profile default model; only empty tags are filled, and agent replies inherit them. |
| `src/wechat-bridge.ts` | host | On-demand WeChat bridge lifecycle: reuse a running bridge or spawn `wechat/src/service.mjs`; stop only the child it started. |
| `src/api.ts` | host | `/super-chat/api/*`: validation, same-origin guard, topic resolution and message storage. |
| `src/monkey.ts` | host | Filters `super-chat-*` Sessions out of `sessionController.list`. |
| `src/protocol.ts` | both | Shared ids, limits, message/topic shapes and text helpers. |
| `src/client/index.tsx` | browser | Registers the `main` panel, dictionaries and the `sidebar.panellist` entry; mounts the Super Chat shortcut at the right of the Superagent row, keeping a standalone entry as fallback. |
| `src/client/chat.tsx` | browser | General chat, topic views, tag input, new topics, per-message tag editing, stop and polling. |
| `src/client/topics.ts` | browser | Tag-name merging, input parsing and message-tag display helpers. |
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
- A topic view filters by `message_topic.topic_id`; the general chat reads the whole stream ordered by `message.seq`.
- An old `chat.json` is imported when the database is empty: v1 conversations are flattened into the general stream; after a successful import the old file is renamed `chat.json.imported-<timestamp>`. An unreadable file is renamed `.corrupt-<timestamp>` and does not block startup.
- SQLite uses WAL; one profile has exactly one writing process.

## Chat flow and dispatch

```
browser
  │ GET /super-chat/api/chat?topic=<id>   read the general or a topic view
  │ POST /super-chat/api/chat {text,tags} send a message
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

### Fallback Session

- Exactly one Session: `super-chat-general`.
- Its prompt also carries topic cues; assistant messages and failed turns are written back to the stream and inherit the last user message's tags.
- The fallback creates no Session per topic and no Tickets; it only keeps chat usable without the prototype.

### Auto-tagging

The **Auto-tag** action at the top of the general chat runs on demand. It handles only untagged user messages among the most recent `TAG_WINDOW` (`VIEW_LIMIT`, 200) messages and lets the profile's default model choose among **existing topics**; it creates no topics and overwrites no tags. The model is called directly through the public `llm` service, with the route from `agentDefaultModel`, so no extra Session is created and the model receives no tools. A run sends at most `TAG_WINDOW` (`VIEW_LIMIT`) messages with each text truncated to 1000 characters and gives up after 90 seconds; a reply that is not valid JSON is retried once, and a second failure leaves the stream untouched and reports an error in the panel. After tags are written, untagged agent replies inherit the tags of the nearest preceding user message. Those writes and the inheritance share one transaction, so topic counts and views stay consistent.

### Manual tag editing

Every message's tag row has an **Edit tags** action. It removes existing tags one by one and adds names typed into the input; saving replaces that message's tags only, and a new name creates a topic. Unlike auto-tagging, a manual edit does not make agent replies inherit tags and does not dispatch work or create messages. Clearing every tag returns the message to the untagged state, so a later auto-tag run can handle it again. The replacement happens in one transaction.

## HTTP contract

All requests require `x-super-chat-request: 1`; `Host` must match the listening address (or a loopback spelling), and a foreign `Origin` is rejected. POST bodies are JSON and limited to 64 KiB.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/super-chat/api/health` | — | `{ ok, messages, topics }` |
| GET | `/super-chat/api/chat?topic=<id>` | — | `{ topic?, topics, messages, mode, busy? }` |
| POST | `/super-chat/api/chat` | `{ text, tags?, topic?, clientId?, via? }` | `{ result, topic?, topics, messages, mode, busy? }` |
| POST | `/super-chat/api/chat/tag` | — | `{ tagged, topics, messages, mode, busy? }` |
| POST | `/super-chat/api/chat/tags` | `{ id, tags, topic? }` | `{ result, topic?, topics, messages, mode, busy? }` |
| POST | `/super-chat/api/topics` | `{ name }` | `{ topic, topics }` |
| POST | `/super-chat/api/topics/rename` | `{ id, name }` | `{ topic, topics }` |
| POST | `/super-chat/api/chat/cancel` | `{ topic? }` | `{ cancelled, topic?, topics, messages, mode, busy? }` |
| POST | `/super-chat/api/wechat/start` | — | `{ ok, result: 'running' | 'started' }` |

- `tags` is an array of topic names; the server resolves and creates missing topics and stores topic ids on the message.
- `topic` is the selected view id used to return the same view; it is not a tag.
- A duplicate `clientId` returns `duplicate` and is not delivered again.
- `chat/tag` fills existing topics only on untagged messages; `tagged` counts the messages that gained tags, including replies that inherited them.
- `chat/tags` replaces one existing message's tags with the submitted set; names resolve and create missing topics, and an empty array clears the tags.
- `mode` is `superagent` or `session`; `busy` means the selected view has an open Ticket or a running fallback turn.

## WeChat bridge

`wechat/` is a separate Node.js process defaulting to the general chat. `src/wechat-bridge.ts` starts it on demand only when the user opens the WeChat access dialog: it probes `8790/health` and reuses an existing bridge, otherwise spawns one, and stops only the child it started. Credentials, cursors and the outbox live under `stateDir/wechat/`; an old manual `wechat/creds.json` is copied once.

- `@topic` tokens are parsed as topic names, removed from the body, and submitted as `tags`; several tokens produce several tags.
- Single-stream polling: the bridge reads `GET /chat` and forwards agent messages after its cursor to WeChat; tagged replies get a `「topic」` prefix.
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

## Same-origin and CSRF

The panel and API are same-origin. A custom request header cannot be set by a cross-site form, and cross-site `fetch` requires a CORS preflight this server never grants; the `Origin` check is additional defence. This is not authentication: DSH's Web server authenticates the human, and a local process can still call the route. Keep it on loopback unless the deployment has its own network controls.

## Concurrency and durability

SQLite writes run synchronously on the Node event loop; one profile has one plugin process. Messages and message-topic links are written in one transaction so indexes stay consistent. WAL lets reads and writes proceed together; the database is closed when the plugin stops. HTTP handlers share no mutable request state.

## Compatibility

- `dsh-superagent-prototype` setup normally requires GitHub. When both GitHub fields are empty, the plugin wraps its `Setup` class in memory so `run` returns an empty deployment, then asks the prototype to restart. No prototype file is modified. This compatibility path covers the chat Source only; Feishu still needs GitHub configured as the prototype expects. If `Setup.run` changes shape, the patch stops applying and chat falls back to the general Session.
- Source registration, Policy seeding and the Channel use only the prototype's public shape; no prototype internals are imported.
- An old `chat.json` is imported once; the topic/tag structure is described by the SQLite schema and this document.
