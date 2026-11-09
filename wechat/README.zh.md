# 微信远程接入模块

插件内置的微信接入模块，按需启动，把微信 **文件传输助手** 网页（`filehelper.weixin.qq.com`）接到 Super Chat 插件的单流聊天。默认进入**通用聊天**；文本里的 `@主题` 会作为消息标签提交，多个 `@主题` 会产生多个标签。

[English](README.md) | 简体中文

这个模块刻意做成独立的 Node.js 进程：它持有微信登录凭据，而 DSH profile 会在插件或设置变化时重启。**打开面板的「微信远程接入」时，插件宿主会按需启动它**；已保存登录凭据时，宿主在重启或后台巡检时也会自动恢复并保活桥进程；已有外部桥时直接复用。重启 DSH 不需要重新扫码。进程只通过 loopback 与插件的 chat API 通信。

插件管理的桥把登录态、游标和待发队列放在 `stateDir/wechat/`；旧的手动 `wechat/creds.json` 会一次性复制过去。只有排查问题或希望桥独立于 DSH 常驻时，才需要手动运行 `run-superchat.sh`。

> **请使用微信小号，不要用主号。** 自动化个人微信账号违反微信的个人账号规则；网页协议对异常位置和流量很敏感。本模块仅供个人研究和自托管使用，不保证可用性。它只发送文本，不面向批量或营销消息。

## 工作方式

```
手机微信 ──▶ filehelper.weixin.qq.com ──▶ wechat/ 桥 ──▶ GET/POST /super-chat/api/chat
                                                 │              （单流 + 主题标签）
                                                 ◀── 单流轮询回复 ──┘
```

- 默认通用聊天：没有“当前对话”或“切换对话”的概念，所有消息进入同一条流。
- 自然语言打标：`帮我看下 @设计 这个页面` 会发送 `帮我看下 这个页面`，并带上 `设计` 标签；`@设计 @紧急 两个标签` 会带两个标签。
- 没有命令系统：`/list`、`/new` 等只会作为普通文本发送。
- 回复按单流轮询；带标签的 agent 回复在微信里显示为 `「设计」回复内容`，方便看出主题。
- 桥只监听 loopback。默认在 `127.0.0.1:8790` 提供 `/health`、`/wechat/status`、`/wechat/login`、`/wechat/logout` 和 `POST /send`；面板直接调用 `/wechat/*`。
- 回复在微信里显示为你自己发送的消息（桥使用同一个账号），因此带有 `🤖 ` 前缀。

## 运行

在 DSH Web UI 打开 **Super Chat → 微信远程接入**；如果没有可用的桥，面板会请求宿主按需启动，然后用手机扫描二维码。也可以先手动启动（排查问题或常驻）：

```sh
cd wechat
./run-superchat.sh                          # 默认 http://127.0.0.1:3080/super-chat/api
SUPERCHAT_URL=http://127.0.0.1:3099 ./run-superchat.sh
PORT=9000 ./run-superchat.sh                # 另一个桥端口；同时修改 src/client/wechat.tsx 里的 BRIDGE
```

`run-superchat.sh` 默认指向本仓库的独立 Super Chat 插件（`3080`、`/super-chat/api`、`x-super-chat-request`）。如果 DSH Web 端口不同，设置 `SUPERCHAT_URL`。插件管理的桥固定使用 `8790`；手动运行时修改 `PORT` 还需要同时改 `src/client/wechat.tsx` 并重新构建客户端。

环境变量：

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `AGENT_MODE` | `llm` | `superchat` 把消息转发给本面板；`llm` 直接通过 OpenAI 兼容模型回答 |
| `SUPERCHAT_URL` | `http://127.0.0.1:3080` | 运行 Super Chat 面板的 DSH Web server |
| `SUPERCHAT_PATH` | `/super-chat/api` | 面板 API 路径 |
| `SUPERCHAT_HEADER` | `x-super-chat-request` | API 期望的请求头 |
| `PORT` | `8790` | 本地桥端口 |
| `CREDS` | `creds.json` | 手动运行时的登录凭据；插件管理时使用 `stateDir/wechat/creds.json` |
| `STATE_FILE` | `state.json` | 手动运行时的状态文件；插件管理时使用 `stateDir/wechat/state.json` |
| `AGENT_API_KEY`、`AGENT_API_BASE`、`AGENT_MODEL` | — | `llm` 模式下的模型访问 |

`creds.json`、`state.json`、`.cache/` 和日志包含登录态与聊天数据。它们已被 git 忽略；永远不要提交或发布它们。

## 验证

模块的测试使用 mock 微信后端和 mock Super Chat API，不需要账号：

```sh
cd wechat
node test/e2e.mjs                  # 协议收发和回声抑制
node test/login-e2e.mjs            # 扫码登录状态机
node test/superchat-e2e.mjs        # 自然语言、@主题、单流轮询和暂存
node test/service-superchat-e2e.mjs
node test/wechat-access-e2e.mjs    # 面板状态/登录/退出路由
```

`node test/cdp-e2e.mjs` 需要真实 Chrome 并打开文件传输助手页面，不在默认测试集里。

## 限制

- 仅文本。图片和文件只会上报标题，不会下载。
- 文件传输助手是“和自己”的对话：智能体的回复右对齐，看起来像你自己发的消息。
- 单流意味着所有主题的回复都会进入同一个微信对话；主题只通过标签和 `「主题」` 前缀区分。
- 一个桥进程只支持一个账号。同一账号的两个网页会话会互相踢下线。
- 凭据会过期；过期后面板的接入入口会重新发起扫码。
- 桥只需要面板的 `POST /chat` 和 `GET /chat` 端点；主题由服务端根据 `tags` 自动复用或创建，不需要桥直接调用主题接口。
