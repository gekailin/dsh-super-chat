# dsh-super-chat

A Super Chat plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): its core is a `super-chat` Source for the `dsh-superagent-prototype` bundle, with one tagged chat stream, a loopback API and SQLite storage.

[简体中文](AGENTS.zh.md) | English

## Background

- DeepSeek Harness (dsh):
  - Keep a complete deepseek-harness checkout locally. Before changing DSH mechanics, lifecycle, or module boundaries, read the actual source, types, and call sites; do not guess.
  - Dependency versions follow `package.json` `engines` and `peerDependencies`; the supported set is the `0.2.1-rc.5` line.
- This repository has two surfaces:
  - The standalone Super Chat plugin at the root (`src/`, `tests/`, `docs/`): the single-stream panel, host API, `chat.sqlite` store, and one fallback DSH Session when superagent is unavailable.
  - `wechat/`: the plugin's built-in WeChat File Transfer Helper bridge, a separate Node.js process that owns its login and starts on demand when WeChat access opens; it defaults to the general chat with `@topic` natural-language tags.
- Superagent integration (core): the plugin registers a `super-chat` Source through `dsh-superagent-prototype`'s public `orchestrator` service and turns messages into Tickets. Without that service it falls back to one general DSH Session as a degraded path. The prototype is maintained in its own checkout; this repository must not modify it.
- Use public services only: the root plugin injects `webServer`, `sessionController`, `agents`, `permissionPresets`, and `workspaceRegistry`; the superagent integration uses only the structural interface of `orchestrator`. Never import another plugin's internals.

## Coding standard

### Priorities

- User experience, data accuracy, and data integrity come first. Never trade them away for refactors, performance, or convenience.
- Verify every change with real tests or a reproducible run. No assumptions.
- When something conflicts with DSH behavior, confirm the public DSH contract before adding a local patch.

### Data integrity

- Messages and topics must stay complete and recoverable. `chat.sqlite` writes run in transactions so messages and `message_topic` indexes stay consistent; directories are `0700`.
- Messages and topics are bounded (`MESSAGE_LIMIT`, `TOPIC_LIMIT`); eviction removes only the oldest messages and must never silently drop the current topic.
- A corrupt database or legacy `chat.json` is quarantined as `.corrupt-<timestamp>`; never fail DSH startup and never silently overwrite it.
- The panel opens on the newest page and reaches the complete selected view by loading older pages on scroll-up. Polling is a read; it must not reorder the loaded stream or change tags.
- In the superagent integration, Trigger, Thread, and Ticket identities stay stable: the `super-chat` Source; a tagged message uses `super-chat:topic:<topicId>`, an untagged one `super-chat:general`; authorization and ticket history must not change across restarts.

### Efficiency

- Make the smallest change that fully solves the problem, with the most direct implementation.
- Keep code and tests small and modular; reuse existing modules, assertions, styles, and DSH design tokens instead of duplicating them.
- Delete outdated or unneeded code and tests.

### Comments

- Comments explain why a rule exists, which invariant they protect, or a non-obvious boundary; do not restate the next line.
- User-facing errors name the concrete object and the next action.
- Keep machine-readable directives (`v8 ignore`, triple-slash references) minimal and drop explanatory prose.

### Tests

- Vitest + jsdom; mock every DSH service. Tests must not start a real DSH agent, call a model provider, reach the network, read the operator's home directory, or run a real `gh`/`lark-cli`.
- Run the narrowest test first (`pnpm vitest run tests/<name>.spec.ts -t "<case>"`), then the full suite.
- Reuse existing suites, cases, and assertions; new behavior needs coverage for failure and fallback paths.
- Integration tests use a fake `orchestrator` and never import prototype internals. Cover at least: the chat-only patch with empty GitHub settings, not taking over a configured GitHub, Policy seeding exactly once, topic dispatch/Channel/Thread context, and the fallback Session.
- SQLite tests use a temporary directory, call `close()` and remove it; cover legacy `chat.json` migration and corrupt-file quarantine.

### Optimization

- Prevent over-engineering and abstractions for hypothetical needs.
- Avoid dangling references, uncleared timers, unbounded caches, and long-session memory growth, on both the host and browser sides.
- Timers, listeners, unregister functions, and effects must be cleaned up on stop/dispose.

### Language

- Code, comments, tests, and commit messages are English.
- Documentation defaults to English; Chinese versions live beside them with the same name plus `.zh.md`. Keep both in sync.
- Every UI string updates both Chinese and English in `src/client/locales.ts`; remove unused keys.

### Temporary files

- Put temporary files under `./.artifacts/` (already ignored) and delete them immediately after use.
- Never commit `node_modules/`, `lib/`, `.artifacts/`, `chat.sqlite` (including WAL/SHM), legacy `chat.json`, WeChat `creds.json`/`state.json`/`.cache/`, or logs.

### File size

- Keep every source or test file under 1000 lines; split by responsibility near the limit.

## Key invariants

- **HTTP guard**: every `/super-chat` request must be same-origin (a matching `Host`), carry `x-super-chat-request: 1`, and have no foreign `Origin`. Never weaken it or add endpoints without the same checks; bind loopback only.
- **Session identity**: the fallback Session is always `super-chat-general`; the prefix is reserved and is what the list patch filters. Do not change it casually.
- **Store rules**: one `chat.sqlite` per `stateDir`; messages and tags in one transaction, indexed, owner-only, bounded messages/topics; quarantine a corrupt file instead of overwriting it.
- **Topic identity**: topic ids are stable `tp-<uuid>` values; messages store ids and display names. The first tag selects the dispatch thread, but topics are not hard partitions; do not turn them into separate stores.
- **Two narrow patches**:
  - `monkey.ts` wraps `sessionController.list`, filters only `super-chat-*`, restores only while its wrapper is on top, and fails non-fatally on an unexpected response shape.
  - `superagent.ts` wraps the prototype's `Setup.run` in memory only when both GitHub fields are empty and the public `orchestrator` is reachable. Every other shape goes to the prototype; if the patch stops applying, fall back to the single general Session.
- **The superagent integration degrades gracefully**: normally route messages to the prototype; route only when its `super-chat` Policy exists and the prototype reports `configured()`, otherwise use the single GeneralSession. Degradation must not be silent, and the plugin must never fail to load because the prototype is absent or changed.
- **Browser half**: React 18, no runtime imports of DSH packages; register only through `slots`, `locale`, `layout`, and other client context services. Render message text as text, never as HTML.
- **Sidebar placement**: Super Chat does not keep a separate row; `src/client/index.tsx` hides its own `sidebar.panellist` row and mounts a `Super Chat` chip after the previous row's (Superagent's) title. Keep the standalone row as fallback when no Superagent row exists; the DOM observer must clean up and must not swallow clicks on the Superagent row.

## Pre-commit checks

- Close out the task list; every item is complete or explicitly closed.
- Review the full diff independently: every change necessary, correct, and not over-engineered.
- Clean up temporary files, temporary comments, and debug output.
- Run `pnpm check` (typecheck -> vitest -> tsdown build) and read the complete output; everything passes.
- Check both the English default and the `.zh.md` Chinese version of every doc you touched; commands, paths, environment variables, and links must be real and executable.
- For UI changes, provide before/after captures of the same scenario, viewport, and state; keep evidence outside the repository and use synthetic or redacted data.
- Never put personal paths, accounts, tokens, cookies, or chat content in the repository, tests, screenshots, or docs.

## Layout and responsive design

- The panel is DSH's center column, not the browser viewport; its width follows sidebar collapse and dragging. Prefer container queries over viewport media queries.
- Fold or wrap under width pressure; never crush content. No horizontal scrollbars, no overlap, and every field stays reachable at the narrowest pane.
- Use DSH design tokens (`var(--dsw-alias-*)`); do not hard-code colors or spacing.
- Portal fullscreen/overlay layers to `document.body` so container-query containing blocks do not affect them.
- Verify layout changes from desktop down to phone width (~390px), in both languages, on a long chat, and in the WeChat access dialog.

## Build and run

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm check          # full pre-commit gate
cd wechat && npm test
```

- `lib/` is build output; rebuild it, never hand-edit it.
- End-to-end verification: install the checkout into a disposable profile, start it on an unused port, and point `stateDir` at a temporary directory. Do not restart the profile in use unless the user asks.
- Startup prints the full tokenized Web URL; every restart changes the token and invalidates the old URL. Never commit the token.
- Host-plugin changes usually need a profile restart. Client HMR works only while the development watcher runs; do not assume a page refresh loads host changes.
- Superagent integration: verify both chat-only (empty GitHub fields) and configured-GitHub paths, and confirm the single fallback Session works when the prototype is absent; then send a tagged message and confirm it uses `super-chat:topic:<id>` and its reply carries the tag.

## Compatibility

- Stay compatible with the DSH `0.2.1-rc.5` line declared by `engines`; do not regress runtime dependencies, message parsing, or user-visible behavior.
- `docs/architecture.md` is the English source of truth for architecture and protocols; `docs/architecture.zh.md` is its Chinese mirror. Read it before compatibility-relevant changes and update it in the same commit.
- The superagent integration depends on the public `orchestrator` shape. The chat-only patch covers the chat Source only; Feishu still needs GitHub configured as the prototype expects. If the prototype changes `Setup.run`, the Source interface, or its lifecycle, prefer removing the compatibility patch and falling back to native capabilities; never make the plugin fail to load.
- Keep dependencies current; after upgrading DSH dependencies run `pnpm check` and review the module table in `docs/architecture.md`.

## I18n

- The UI supports Simplified Chinese and English and follows the DSH locale.
- Update both languages when adding or changing UI text; remove unused keys.
- Documentation defaults to English; Chinese lives in `.zh.md` beside it. Never update only one side.

## WeChat bridge (wechat/)

- It is part of the plugin's feature set but remains a separate process by design: **before sign-in, start it on demand only when the user opens the WeChat access dialog** (never eagerly when no credentials exist); once saved `creds.json` exists, the host automatically resumes and keeps the bridge alive across restarts and background checks.
- `src/wechat-bridge.ts` owns the lifecycle: probe `8790/health` and reuse an existing bridge; otherwise spawn `wechat/src/service.mjs` with `SUPERCHAT_URL` pointing at the current panel port; stop only the child this manager started, never an external bridge.
- Credentials, cursors and the outbox live under `stateDir/wechat/`; an old manual `wechat/creds.json` is copied once. Never commit these files.
- The bridge listens only on loopback `127.0.0.1:8790` and its tests use a mock WeChat backend. Do not merge it into the DSH process.

## Docs

- `docs/` contains end-user documentation only.
- `README.md` is the English default; Chinese is `README.zh.md`. The same applies to `CHANGELOG.md`, `SECURITY.md`, `wechat/README.md`, and `docs/architecture.md`.
- Commands, paths, configuration keys, and environment variables in docs must match the code. Do not include machine-specific absolute paths, personal accounts, tokens, or chat content.
- Screenshots use synthetic or redacted data; never expose a real chat.
- When renaming or adding docs, update `package.json` `files` and cross-links in the same change.

## Git

- Commit in small steps by task or purpose, with a short `area: summary` subject (`host:`, `client:`, `superagent:`, `wechat:`, `docs:`).
- Never commit generated `lib/`, `node_modules/`, `.artifacts/`, chat data, WeChat credentials, or logs.
- Do not `git push` without an explicit request; check the worktree for unrelated changes before committing.

## Releasing

- Follow `X.Y.Z` (major.minor.patch); review commits since the last tag before releasing.
- `pnpm check` must be green; rebuild `lib/` and confirm `package.json` `files` includes the current docs and `wechat/`.
- Tagging and creating a release are maintainer actions; release notes state user-visible changes, compatibility, and breaking changes.
