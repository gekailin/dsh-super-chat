# dsh-super-chat

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Super Chat 面板：一个通用聊天流，消息可以带多个主题标签；安装 `dsh-superagent-prototype` 时，主题作为任务分发的线索，未打标的消息交给 Superagent 自行判断。

[简体中文](README.md) | [English](README.en.md)

## 这个仓库是什么

- **面向 dsh-superagent-prototype 的 Super Chat 插件**：核心是注册 `super-chat` Source，把聊天消息变成工单；同时提供单流聊天、SQLite 存储和主题标签视图。
- **Superagent 工单**：插件通过 prototype 公开的 `orchestrator` 服务接入；确认和结果回到同一聊天流。prototype 的代码不被修改；没有 prototype 时用一个通用 DSH Session 兜底。
- **`wechat/`**：可选的微信「文件传输助手」桥，默认接入通用聊天，用 `@主题` 给消息打标。

## 仓库结构

| 路径 | 内容 | 检查 |
| --- | --- | --- |
| 根目录（`src/`、`tests/`、`docs/`） | 独立 Super Chat 插件（`dsh-super-chat` 包） | 根目录 `pnpm check` |
| `wechat/` | 微信桥（独立 Node.js 进程） | `cd wechat && npm test` |

根插件与另外安装的 `dsh-superagent-prototype` 互相独立。插件只通过对方公开的 `orchestrator` 服务接入；服务不存在或未配置时，退回一个通用 DSH Session。

## 功能

- **通用聊天**：所有消息进入同一条流；不再有“每个对话一个 Session”的概念。
- **主题视图**：主题是消息上的标签，不是独立对话；一条消息可以有多个标签，出现在所有对应主题视图里。
- **主题是分发线索**：有标签的消息把第一个标签作为 `super-chat` 的 dispatch thread；通用聊天走 `general`，由 Superagent 自己判断。标签不强制决定结果。
- **Superagent 工单**：确认、回答和结果会带标签回到聊天流；没有 GitHub 仓库或 CLI 的 chat-only prototype 也能接单。
- **SQLite**：消息、主题和消息-主题关系用表存储，并建立索引；旧的 `chat.json` 会一次性迁移。
- **微信远程接入**：打开面板入口时按需启动桥，默认通用聊天，自然语言里写 `@主题` 即可打标；不再使用命令系统。
- **中英双语**，跟随 DSH locale。

## 环境要求

- DSH **0.2.1-rc.5** 或兼容的 `0.2.x`，并且使用 Web profile（`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`）。
- Node.js 22.19+ 或 24+。
- profile 里已经配置好模型提供方（和普通 DSH Session 一样）。

## 安装

发布后的包：

```sh
dsh plugin --profile web add dsh-super-chat
```

从源码 checkout 安装（先构建；`link:` 安装不会替你构建）：

```sh
git clone <this repository> dsh-super-chat
cd dsh-super-chat
pnpm install
pnpm build
dsh plugin --profile web add "$PWD"
```

用 git URL 安装时会执行包的 `prepare` 构建；pnpm 可能先要求你允许这个构建脚本。

`dsh plugin add` 会安装包并把插件加入 profile 的 `dsh.profile.bundles`。重启 profile 后，在侧边栏 **Superagent** 行标题右侧点击 **Super Chat** 快捷入口。

## 配置

所有选项都有可用默认值。在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: super-chat
  config:
    # chat.sqlite 的目录；默认 $DSH_HOME/state/super-chat。
    stateDir: /home/you/.dsh/state/super-chat
    # superagent 不可用时，兜底 Session 的工作目录。
    cwd: /home/you/src/my-project
    # 可选：兜底 Session 的 agent preset。
    agentPreset: standard
    # 可选：兜底 Session 的权限 preset。
    permissionPreset: danger-full-access
```

| 选项 | 默认值 | 含义 |
| --- | --- | --- |
| `stateDir` | `$DSH_HOME/state/super-chat` | 存放 `chat.sqlite` 的目录，仅本人可读。 |
| `cwd` | `process.cwd()` | 兜底 Session 的 workspace 目录。 |
| `agentPreset` | profile 默认 | 兜底 Session 使用的 agent preset。 |
| `permissionPreset` | profile 默认 | 应用到兜底 Session 的权限 preset。 |

## 工作原理

```
浏览器（client slot "main" + "sidebar.panellist"）
  │  GET/POST /super-chat/api/chat?topic=…
  ▼
宿主插件（dsh-super-chat）
  ├─ chat.sqlite         message / topic / message_topic，带索引
  ├─ ChatTransportRouter
  │    ├─ superagent   注册 super-chat Source；首个标签 → dispatch thread
  │    └─ GeneralSession（兜底）一个 DSH Session super-chat-general
  └─ sessionController.list patch（隐藏 super-chat-* Session）
```

- 消息 id 用于去重；重复提交不会重复创建工单。
- 主题视图只是按标签过滤同一条流；不是独立存储，也不会复制消息。
- 有标签时，发给 Superagent 的 Trigger 文本前会有一行 `[topics: …]` 作为线索；聊天里保留原文。
- 通用聊天没有标签，Trigger 走 `super-chat:general`，由 Superagent 的评估自行决定是否接单、如何拆分。
- agent 回复通过 Source 的 Channel 写回；Channel 的地址携带主题 id，因此回复会出现在对应主题视图和通用聊天里。

## Superagent 集成

同一 profile 安装了 `dsh-superagent-prototype` 时，它的运行时会公开 `orchestrator` SourceHost 服务。插件在其中注册名为 `super-chat` 的 Source，并把该 Source 的 Policy 初始化为本机固定发送者 `local`。

- **有标签**：第一个标签决定 `super-chat:topic:<topicId>` dispatch thread，其余标签放进 Trigger meta 和文本线索。标签是提示，不是硬约束。
- **无标签**：走 `super-chat:general`；通用聊天完全交给 Superagent 判断。
- **chat-only**：prototype 的 setup 通常要求 GitHub 仓库和已登录的 `gh` CLI。GitHub 两项都为空时，插件在内存中包装 prototype 的 `Setup` 类，让它接受空部署，然后请 prototype 重启；不修改任何 prototype 文件。这种模式下 worker 没有 GitHub 工具。该兼容路径只覆盖聊天 Source；如果还要使用 Feishu，仍按 prototype 的要求配置 GitHub，让原始 setup 处理 Feishu。
- **回退**：服务不存在、未配置或补丁失效时，改用 `GeneralSession`，所有消息进入一个通用 DSH Session，主题标签只作为提示。

## 权限与审批

- 兜底 Session 继承 profile 的权限 preset，除非设置了 `permissionPreset`。面板没有审批 UI，需要询问的 preset 可能让回合一直等待。
- 运行 Superagent 工单时，执行器使用 prototype 自己的权限、并发和目录设置；本插件只负责聊天入口和主题分发。

## 微信远程接入（按需启动）

`wechat/` 目录包含一个独立的 Node.js 桥，连接微信「文件传输助手」。**打开面板的「微信远程接入」时，宿主会按需启动桥**，不需要先手动运行；已有外部桥时直接复用。桥默认处于通用聊天状态：手机发来的普通文本进入通用聊天；文本里的 `@主题` 会从正文中取出、作为标签提交，例如：

```
帮我看下 @设计 这个页面
```

会发送 `帮我看下 这个页面`，并打上 `设计` 标签。多个 `@主题` 会变成多个标签。没有 `/list`、`/use`、`/new` 之类的命令，全部按自然语言处理。agent 带标签的回复在微信里显示为 `「设计」回复内容`。

只有排查问题或想让桥独立于 DSH 进程常驻时，才需要手动运行；此时指定面板端口：

```sh
cd wechat
SUPERCHAT_URL=http://127.0.0.1:3082 ./run-superchat.sh
```

桥监听 `127.0.0.1:8790`；按需启动时登录态和游标存在 `stateDir/wechat/`（旧的手动 `wechat/creds.json` 会一次性复制过去）。凭据和聊天数据都不进 git。请用小号：个人号自动化有封号风险。配置、测试和限制见 [wechat/README.md](wechat/README.md)。

## 隐私与安全

- 聊天保存在 `stateDir` 的 `chat.sqlite`，本插件不会上传它。消息会像普通 DSH Session 一样发送给 profile 配置的模型提供方；不要把密钥贴进聊天。
- HTTP API 与 DSH Web UI 同源，要求 `x-super-chat-request: 1` 请求头、匹配的 `Host`，并拒绝外来 `Origin`。这是 CSRF 防护，不是身份认证；真正的认证由 DSH Web server 负责。除非清楚网络暴露面，否则让服务保持 loopback。
- Superagent 工单使用 prototype 的执行环境和权限；本插件只写 SQLite、注册一个 HTTP 路由并读取 Session 事件。
- 没有埋点、遥测、远程字体或外部资源。

## 已知限制

- 仅文本；面板暂不接受图片和文件附件。
- 回复通过轮询（2.5 秒）到达，不做 token 级流式输出。
- 主题是标签和分发线索，不是严格分区；第一条标签决定 dispatch thread，Superagent 仍可自行重新判断。
- 兜底 Session 只有一条；此时所有消息共用一个模型上下文，回复只在通用聊天里可见（带标签的回复会继承最后一条用户消息的标签）。
- 插件不自带工单流水线或 worker 池；这些来自 `dsh-superagent-prototype`。
- 多用户能力仅限于 DSH Web server 本身已有的能力。
- 面板使用绝对的 `/super-chat/api` 路径并校验监听 host；不支持路径前缀或不同公开 authority 的反向代理。

## 开发

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm check
cd wechat && npm test
```

本地验证：把 checkout 安装进一个一次性 profile，用空闲端口启动，并把 `stateDir` 指到一次性目录。

目录：`src/index.ts`（宿主入口）、`src/store.ts`（SQLite）、`src/session.ts`（兜底 Session）、`src/transport.ts`（transport 选择）、`src/superagent.ts`（super-chat Source 与 chat-only 补丁）、`src/api.ts`（HTTP API）、`src/monkey.ts`（列表 patch）、`src/protocol.ts`（共享类型）、`src/client/`（浏览器半边）。

## 许可

MIT。主题列表布局与 CSS 改编自 `dsh-superagent` 原型（同为 MIT）。
