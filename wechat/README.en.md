# WeChat remote access module

The plugin's built-in WeChat bridge, started on demand, connecting WeChat's **File Transfer Helper** web page (`filehelper.weixin.qq.com`) to the Super Chat plugin's single stream. It defaults to the **general chat**; `@topic` tokens in a message become topic tags, and several tokens produce several tags.

[简体中文](README.md) | English

The module is a separate Node.js process on purpose: it holds the WeChat login credentials while the DSH profile restarts when its plugins or settings change. **Opening the panel's WeChat access starts it on demand**; while saved credentials exist, the host also automatically resumes and keeps the bridge alive across restarts and background checks; an already-running external bridge is reused. Restarting DSH therefore does not require a new scan. The process talks to the plugin's chat API over loopback only.

The plugin-managed bridge keeps credentials, cursors and its outbox under `stateDir/wechat/`; an old manual `wechat/creds.json` is copied once. Run `run-superchat.sh` manually only for troubleshooting or when the bridge should stay resident independently of DSH.

> **Use a secondary WeChat account, not your main one.** Automating a personal WeChat account violates WeChat's personal-account rules; the web protocol is sensitive to unusual locations and traffic. This module is for personal research and self-hosting, with no availability guarantee. It sends text only and is not built for bulk or marketing messages.

## How it fits

```
phone WeChat ──▶ filehelper.weixin.qq.com ──▶ wechat/ bridge ──▶ GET/POST /super-chat/api/chat
                                                    │                  (single stream + topic tags)
                                                    ◀── single-stream polling ──┘
```

- Default general chat: there is no “current conversation” or “switch conversation”; every message enters the same stream.
- Natural-language tagging: `帮我看下 @设计 这个页面` sends `帮我看下 这个页面` tagged `设计`; `@设计 @紧急 两个标签` carries two tags.
- No command system: `/list`, `/new` and similar text are sent as ordinary messages.
- Replies are polled from the single stream; a tagged agent reply appears in WeChat as `「设计」reply`.
- The bridge is loopback-only. By default it serves `/health`, `/wechat/status`, `/wechat/login`, `/wechat/logout` and `POST /send` on `127.0.0.1:8790`; the panel calls `/wechat/*` directly.
- Replies appear in WeChat as messages you sent yourself (the bridge uses the same account), so they carry a `🤖 ` prefix.

## Run

Open **Super Chat → WeChat access** in the DSH Web UI; if no bridge is running the panel asks the host to start one, then shows the QR code. You can also start it manually for troubleshooting or a resident process:

```sh
cd wechat
./run-superchat.sh                          # default http://127.0.0.1:3080/super-chat/api
SUPERCHAT_URL=http://127.0.0.1:3099 ./run-superchat.sh
PORT=9000 ./run-superchat.sh                # another bridge port; also change BRIDGE in src/client/wechat.tsx
```

`run-superchat.sh` targets the standalone Super Chat plugin from this repository (`3080`, `/super-chat/api`, `x-super-chat-request`). If the DSH Web port differs, set `SUPERCHAT_URL`. The plugin-managed bridge always uses `8790`; a manual `PORT` change also requires changing `src/client/wechat.tsx` and rebuilding the client.

Environment:

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGENT_MODE` | `llm` | `superchat` forwards messages to this panel; `llm` answers through an OpenAI-compatible model directly |
| `SUPERCHAT_URL` | `http://127.0.0.1:3080` | DSH Web server running the Super Chat panel |
| `SUPERCHAT_PATH` | `/super-chat/api` | Panel API path |
| `SUPERCHAT_HEADER` | `x-super-chat-request` | Request header the API expects |
| `PORT` | `8790` | Local bridge port |
| `CREDS` | `creds.json` | Login credentials for a manual run; the manager uses `stateDir/wechat/creds.json` |
| `STATE_FILE` | `state.json` | State file for a manual run; the manager uses `stateDir/wechat/state.json` |
| `AGENT_API_KEY`, `AGENT_API_BASE`, `AGENT_MODEL` | — | Model access in `llm` mode |

`creds.json`, `state.json`, `.cache/` and logs contain login state and chat data. They are ignored by git; never commit or publish them.

## Verify

The module's tests use a mock WeChat backend and a mock Super Chat API; no account is needed:

```sh
cd wechat
node test/e2e.mjs                  # protocol send/receive and echo suppression
node test/login-e2e.mjs            # QR login state machine
node test/superchat-e2e.mjs        # natural language, @topic, single-stream polling and queueing
node test/service-superchat-e2e.mjs
node test/wechat-access-e2e.mjs    # panel status/login/logout routes
```

`node test/cdp-e2e.mjs` needs a real Chrome with the file helper page open and is not part of the default suite.

## Limits

- Text only. Images and files are reported as a title, never downloaded.
- The file transfer helper is a conversation with yourself: the agent's replies are right-aligned and look like your own messages.
- With one stream, replies from every topic land in the same WeChat conversation; only tags and the `「topic」` prefix distinguish them.
- One account per bridge process. Two web sessions of the same account sign each other out.
- Credentials expire; the panel's access entry starts a new scan when they do.
- The bridge needs the panel's `POST /chat` and `GET /chat` endpoints; the server reuses or creates topics from `tags`, so the bridge never calls the topic endpoints directly.
