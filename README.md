# dsh-super-chat

A Super Chat panel for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): its core is a `super-chat` Source for the `dsh-superagent-prototype` bundle, turning chat messages into Superagent Tickets. The panel keeps one general chat stream where messages can carry several topic tags; topics act as task-dispatch cues and untagged messages are left for Superagent to decide. Without that prototype, the plugin falls back to a single general DSH Session.

English | [简体中文](README.zh.md)

![Super Chat: a general chat panel for DeepSeek Harness](docs/readme-hero.jpg)

## What this repository is

- **A Super Chat plugin for dsh-superagent-prototype**: its core is a `super-chat` Source that turns chat messages into Tickets; it also provides one tagged chat stream, SQLite storage and topic-filtered views.
- **Superagent Tickets**: the plugin connects through the prototype's public `orchestrator` service; acknowledgements and results return to the same stream. Prototype code is not modified; a single general DSH Session is the fallback when the prototype is absent.
- **`wechat/`**: an optional WeChat File Transfer Helper bridge. It defaults to the general chat and uses `@topic` to tag messages.

## Repository layout

| Path | What it is | Checks |
| --- | --- | --- |
| root (`src/`, `tests/`, `docs/`) | the standalone plugin (`dsh-super-chat` package) | `pnpm check` at the root |
| `wechat/` | the WeChat bridge (separate Node.js process) | `cd wechat && npm test` |

The root plugin and the separately installed `dsh-superagent-prototype` are independent. The plugin reaches the prototype only through its public `orchestrator` service; when that service is absent or unconfigured, one general DSH Session takes over.

## Features

- **All messages**: every message goes into one stream; this is the panel's main view and replaces the former "General chat" label. The panel opens at the newest page and loads older messages when you scroll up.
- **<No topic> view**: shows only messages that carry no tags, with a live count in the sidebar; it is a read-time filter and changes neither storage, dispatch nor the topic list.
- **Topic views**: topics are tags on messages, not separate conversations. One message may carry several tags and appears in every matching view.
- **Topics are dispatch cues**: for a tagged message the first tag becomes the `super-chat` dispatch thread; untagged messages go to `general` and Superagent decides. Tags never force the outcome.
- **Auto-tagging**: the general chat's header labels untagged messages with existing topics through the profile's default model; only empty tags are filled, agent replies inherit them, and no topics are created.
- **Manual tag editing**: each message's tag row can add or remove tags and save; only that message changes, a new name creates a topic, and no work is dispatched.
- **Markdown replies**: agent replies render common Markdown (headings, lists, quotes, links, fenced and inline code); each reply has a **Raw** button that switches it back to the original text. User messages stay as authored.
- **Model settings**: the composer's **Models** entry, immediately left of **Send**, chooses the orchestrator model and the default model for new workers from the profile catalog. A chat message such as `用 gemini-4-argon 模型启动一个新 worker 做…` or `use gemini-4-argon model to start a new worker for…` gives that one new worker the named model without changing the default.
- **Superagent Tickets**: acknowledgements, answers and results come back with their tags. A chat-only prototype with no GitHub repository or CLI can still take work.
- **Workspace grouping**: with the prototype installed, the orchestrator's Workspace and each ticket worker's Workspace appear as one **Superagent** group with the orchestrator pinned on top. The merge is presentation-only and does not move a Session's working directory.
- **SQLite**: messages, topics and message-topic links live in indexed tables; an old `chat.json` is migrated once.
- **WeChat remote access**: the bridge starts on demand when the panel entry opens; it defaults to the general chat and uses `@topic` in natural language. There is no command system.
- **Bilingual UI** following the DSH locale.

## Requirements

- DSH **0.2.1-rc.5** or a compatible `0.2.x` Web profile (`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`).
- Node.js 22.19+ or 24+.
- A model provider configured in the profile, as for any normal DSH Session.

## Install

Published package:

```sh
dsh plugin --profile web add dsh-super-chat
```

From a checkout (build first; a `link:` install does not build it):

```sh
git clone <this repository> dsh-super-chat
cd dsh-super-chat
pnpm install
pnpm build
dsh plugin --profile web add "$PWD"
```

A git-URL install runs the package's `prepare` build; pnpm may ask you to allow that script.

`dsh plugin add` installs the package and appends it to the profile's `dsh.profile.bundles`. Restart the profile, then open **Super Chat** from the shortcut at the right of the **Superagent** sidebar row.

## Configuration

Every option has a working default. Override it in the profile's `cordis.patch.yml`:

```yaml
- id: super-chat
  config:
    # Directory for chat.sqlite; defaults to $DSH_HOME/state/super-chat.
    stateDir: /home/you/.dsh/state/super-chat
    # Workspace for the fallback Session when superagent is unavailable.
    cwd: /home/you/src/my-project
    # Optional agent preset for the fallback Session.
    agentPreset: standard
    # Optional permission preset for the fallback Session.
    permissionPreset: danger-full-access
```

| Option | Default | Meaning |
| --- | --- | --- |
| `stateDir` | `$DSH_HOME/state/super-chat` | Directory holding `chat.sqlite`, owner-only. |
| `cwd` | `process.cwd()` | Workspace directory of the fallback Session. |
| `agentPreset` | profile default | Agent preset for the fallback Session. |
| `permissionPreset` | profile default | Permission preset applied to the fallback Session. |

## How it works

```
browser (client slots "main" + "sidebar.panellist")
  │  GET/POST /super-chat/api/chat?topic=…&before=…
  ▼
host plugin (dsh-super-chat)
  ├─ chat.sqlite          message / topic / message_topic, indexed
  ├─ ChatTransportRouter
  │    ├─ superagent     registers the super-chat Source; first tag → dispatch thread
  │    └─ GeneralSession (fallback) one DSH Session super-chat-general
  └─ sessionController.list patch (hides super-chat-* Sessions)
```

- A message id deduplicates retries; the same submission never opens a second Ticket.
- A topic view filters the one stream by tag. It does not copy messages or create separate storage.
- For tagged messages the Superagent Trigger text starts with a `[topics: …]` cue; the chat itself keeps the original text.
- Untagged messages use `super-chat:general`, leaving it to Superagent's assessment to accept, split or ignore them.
- Agent replies return through the Source Channel. The Channel address carries topic ids, so a reply appears in its topic view and in the general chat.

## Superagent integration

When `dsh-superagent-prototype` is installed in the same profile, its runtime exposes the public `orchestrator` SourceHost service. The plugin registers a Source named `super-chat` and seeds its Policy with the fixed local sender, `local`.

- **Tagged**: the first tag selects the `super-chat:topic:<topicId>` dispatch thread; every tag is carried in Trigger meta and the text cue. Tags are hints, not hard constraints.
- **Untagged**: uses `super-chat:general`; the general chat is left entirely to Superagent.
- **Chat-only**: the prototype's setup normally requires a GitHub repository and signed-in `gh` CLI. When both GitHub fields are empty the plugin wraps the prototype's `Setup` class in memory, accepts an empty deployment and asks the prototype to restart. No prototype file is modified. Workers in that mode have no GitHub tooling. This compatibility path covers the chat Source only; if Feishu is also needed, configure GitHub as the prototype expects so its original setup can handle Feishu.
- **Workspace grouping**: the prototype creates a Workspace for every ticket directory. The plugin keeps one **Superagent** Workspace over the prototype's state directory and folds ticket Workspaces into that group in the browser; the orchestrator Session is pinned first. `docs/architecture.md` records the mechanics and limits.
- **Models**: the **Models** dialog reads `eval.model` and `executor.model` through the prototype's public settings API and writes them back with the current block revision, so it shares the prototype's validation and history. Saving the orchestrator model also appends a model selection to the live orchestrator Session, so it takes effect on its next request; the worker model applies to worker Sessions created afterwards.
- **One worker's model**: when a message asks to start a new worker with a named model, the plugin resolves the name against the catalog before storing the message. For the accepted Ticket it remembers the selection, then appends it to the `worker-<ticket id>` Session as DSH creates it, before the prototype seeds the configured default. The chat shows a short note once the model is applied. An unknown or ambiguous name is reported and the message is not sent.
- **Fallback**: when the service is absent, unconfigured, or the patch no longer applies, `GeneralSession` handles every message in one DSH Session; topic tags are only hints.

## Permissions and approvals

- The fallback Session inherits the profile's permission preset unless `permissionPreset` is set. The panel has no approval UI, so an asking preset can leave a turn waiting.
- Superagent Tickets use the prototype's own executor permissions, concurrency and directory settings; this plugin only provides the chat entry point and topic dispatch.

## WeChat remote access (started on demand)

`wechat/` is a separate Node.js bridge for WeChat's File Transfer Helper. **Opening the panel's WeChat access starts the bridge on demand**, so it does not need to be launched first; while saved credentials (`stateDir/wechat/creds.json`) exist, the host also automatically resumes and keeps the bridge alive across restarts and background checks; an already-running external bridge is reused. It defaults to the general chat: ordinary text goes there, and `@topic` tokens are extracted from the body as tags, for example:

```
帮我看下 @设计 这个页面
```

sends `帮我看下 这个页面` tagged `设计`. Several `@topic` tokens become several tags. There are no `/list`, `/use` or `/new` commands; everything is natural language. Tagged agent replies appear in WeChat as `「设计」reply`.

Run it manually only for troubleshooting or when the bridge should stay resident independently of DSH; point it at the panel port:

```sh
cd wechat
SUPERCHAT_URL=http://127.0.0.1:3082 ./run-superchat.sh
```

The bridge listens on `127.0.0.1:8790`; the on-demand manager stores login and cursors under `stateDir/wechat/` (an old manual `wechat/creds.json` is copied once). Credentials and chat data are ignored by git. Use a secondary WeChat account: personal-account automation carries a ban risk. See [wechat/README.md](wechat/README.md) for configuration, tests and limits.

## Privacy and security

- Chats are stored in `chat.sqlite` under `stateDir` and never uploaded by this plugin. Messages reach the configured model provider like any DSH Session; do not paste secrets into a chat.
- The HTTP API is same-origin with the DSH Web UI and requires `x-super-chat-request: 1`, a matching `Host` and no foreign `Origin`. This is CSRF protection, not authentication; the DSH Web Server still authenticates the human. Keep it on loopback unless you understand the exposure.
- Superagent Tickets use the prototype's execution environment and permissions; this plugin writes SQLite, registers the `/super-chat` HTTP route, reads Session events and, on an explicit panel save or a worker-model chat directive, saves a role model or appends a model selection.
- No analytics, telemetry, remote fonts or external assets.

## Limitations

- Text only; the panel does not accept images or file attachments yet.
- Replies arrive by polling (2.5 s), not token streaming.
- The panel reads the newest 50 messages first and fetches older pages as you scroll up, up to the retained stream limit.
- Topics are labels and dispatch cues, not strict partitions; the first tag chooses the dispatch thread and Superagent may still decide otherwise.
- The fallback has a single Session, so every message shares one model context; tagged replies inherit their turn's tags and appear in both All messages and their matching topic views.
- The plugin does not ship a ticket pipeline or worker pool; those come from `dsh-superagent-prototype`.
- Model settings need the prototype; without it the dialog explains that Superagent is unavailable. A chat directive only affects a newly created worker Session — a message that joins an existing Ticket keeps that worker's model — and names must match a catalog model id or display name (use `provider/model` when a bare id is ambiguous). A pending directive is forgotten after 30 minutes.
- Multi-user behavior is limited to what the DSH Web Server already provides.
- The panel uses absolute `/super-chat/api` paths and checks the configured bind host; path-prefix or different-authority reverse proxies are not supported.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm check
cd wechat && npm test
```

For a local run, install the checkout into a disposable profile on an unused port and point `stateDir` at a temporary directory.

Layout: `src/index.ts` (host entry), `src/store.ts` (SQLite), `src/session.ts` (fallback Session), `src/transport.ts` (transport selection), `src/superagent.ts` (super-chat Source, model settings and the chat-only patch), `src/models.ts` (role models, catalog resolution and the worker-model directive), `src/tagger.ts` (auto-tagging), `src/wechat-bridge.ts` (WeChat bridge lifecycle), `src/workspace-group.ts` and `src/workspace-group-host.ts` (Superagent workspace grouping), `src/api.ts` (HTTP API), `src/monkey.ts` (list patch), `src/protocol.ts` (shared types), `src/client/` (browser half).

## License

MIT. The topic-list layout and CSS are adapted from the `dsh-superagent` prototype, also MIT.
