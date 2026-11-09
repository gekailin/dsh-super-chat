# 架构

本文说明单流聊天、主题标签、SQLite 存储、superagent 分发、工作区分组、浏览器/宿主拆分、HTTP 契约，以及两个窄补丁。

[English](architecture.md) | 简体中文

## 组件

| 文件 | 运行时 | 职责 |
| --- | --- | --- |
| `src/index.ts` | host | 读取配置、打开 SQLite、挂载 superagent Source、兜底 Session、HTTP API 和列表补丁。 |
| `src/store.ts` | host | `chat.sqlite`：消息、主题、消息-主题关系、索引、旧 `chat.json` 迁移，以及手动替换单条消息的标签。 |
| `src/session.ts` | host | superagent 不可用时的单个兜底 DSH Session（`super-chat-general`）。 |
| `src/transport.ts` | host | `ChatTransportRouter`：按当前可用性在 superagent 和兜底 Session 之间选择。 |
| `src/superagent.ts` | host | 核心 `super-chat` Source、主题 dispatch、Channel/Thread context，以及仅内存中的 chat-only Setup 补丁。 |
| `src/tagger.ts` | host | 按需用 profile 默认模型给已有消息判断主题；只补空标签，agent 回复继承标签。 |
| `src/wechat-bridge.ts` | host | 微信桥生命周期与保活：未登录时按需启动，已有登录凭据时自动恢复并巡检保活；探测/复用外部桥，只停止自己启动的进程。 |
| `src/api.ts` | host | `/super-chat/api/*`：请求校验、同源守卫、主题解析和消息存储。 |
| `src/monkey.ts` | host | 从 `sessionController.list` 中过滤 `super-chat-*` Session。 |
| `src/workspace-group.ts` | both | 工作区分组的共享形状，以及浏览器侧的合并投影。 |
| `src/workspace-group-host.ts` | host | 确保 prototype state 目录的 Workspace、附加并置顶 orchestrator Session。 |
| `src/protocol.ts` | both | 共享 id、上限、消息/主题形状和文本辅助函数。 |
| `src/client/index.tsx` | browser | 注册 `main` 面板、词典和 `sidebar.panellist` 入口；在 Superagent 行标题右侧挂 Super Chat 快捷入口，找不到时保留独立入口。 |
| `src/client/workspace-group.ts` | browser | 包装 Workspace 快照，把工单 Workspace 折进 Superagent 分组。 |
| `src/client/chat.tsx` | browser | 最新一页优先、上滚加载更早分页、`<无主题>` 视图、标签输入、新建主题、逐条消息的标签编辑、停止和轮询。 |
| `src/client/topics.ts` | browser | 标签名合并、输入解析和消息标签展示辅助。 |
| `src/client/text.ts` | browser | 消息元数据的相对时间与简短日期格式化。 |
| `src/client/locales.ts` | browser | 面板与微信弹窗的简体中文、英文词典。 |
| `src/client/dsh.ts` | browser | DSH 浏览器插件上下文（`slots`、`locale`、`layout`、`workspaces`）的最小本地类型契约。 |
| `src/client/wechat.tsx` | browser | 微信接入入口和扫码/状态/退出窗口，背后是 `127.0.0.1:8790` 的本地桥。 |

浏览器半边运行时不 import DSH 包：只依赖 `react`（由 DSH module loader 提供），并通过 client plugin context 接收 `slots` 和 `locale`。

## 数据模型

数据在 `stateDir/chat.sqlite`，用 `node:sqlite` 同步访问：

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

- 只有一条消息流；主题是消息上的标签，不是独立对话。一个消息可以有多个主题，出现在多个主题视图里。
- 消息 id 全局唯一，用于去重；最多保留 `MESSAGE_LIMIT`（1000）条，最早的先淘汰。
- 主题名大小写不敏感且唯一；最多 `TOPIC_LIMIT`（200）个。
- 主题视图按 `message_topic.topic_id` 过滤；全部消息按 `message.seq` 读取整条流。读取返回一页（默认 50 条，最多 `VIEW_LIMIT`），存储侧从新到旧，返回时从旧到新；`before=<最旧 id>` 读取上一页。
- 旧 `chat.json` 在首次打开空库时导入：v1 的多个对话被扁平化到通用流；导入成功后旧文件改名为 `chat.json.imported-<timestamp>`。损坏的旧文件改名为 `.corrupt-<timestamp>`，不阻塞启动。
- SQLite 使用 WAL；一个 profile 只有一个进程写库。

## 聊天流与分发

```
浏览器
  │ GET /super-chat/api/chat?topic=<id>&before=<id>&limit=<n>   读一页
  │ POST /super-chat/api/chat {text,tags}                       发消息
  ▼
ChatStore（SQLite）
  │ appendUser / resolveTags
  ▼
ChatTransportRouter
  ├─ superagent 可用：superagent.deliver(message, topics)
  └─ 否则：GeneralSession.deliver(message, topics)
```

### superagent dispatch

- 有标签：第一个主题 id 生成 dispatch thread `super-chat:topic:<topicId>`；其余标签写入 Trigger meta 和文本线索。
- 无标签：dispatch thread `super-chat:general`；由 Superagent 的评估自行决定接单、拆分或忽略。
- Trigger 文本在原文前加一行 `[topics: 名称…]`；聊天存储保留原文。
- Channel 地址带 `topics=<ids>`；回复写回时按这些 id 打标。因此同一回复会出现在通用聊天和对应主题视图。
- Thread context 读取该 dispatch topic 的消息；没有标签时读取通用流。
- 主题是线索而不是硬分区：Superagent 仍然可以重新判断，或把消息交给其它工单。

### 兜底 Session

- 只有一个 Session：`super-chat-general`。
- 提示文本同样带主题线索；assistant 消息和失败回合写回消息流，并继承最后一条用户消息的标签。
- 兜底不会为每个主题建 Session，也不会生成工单；它只是保证没有 prototype 时聊天仍可用。

### 全部消息与 `<无主题>`

面板的主视图叫「全部消息」，按最新一页优先读取：打开面板直接停在最新消息的底部，不重放整条流；滚到顶部时用 `before` 读取上一页。侧栏的「`<无主题>`」不是主题，也不是独立存储或分发分区：它只是在读取时把同一条流过滤为没有标签的消息，因此分页和计数都不复制消息。侧栏显示未打标签消息的总数；未打标签的消息仍然走 `super-chat:general`，由 Superagent 判断。轮询只把最新一页合并进已加载的流，不重排已加载消息；除非读者已在底部，否则不改变滚动位置。

### 自动打标签

全部消息视图右上角的「自动打标签」按需运行：只处理最近 `TAG_WINDOW`（即 `VIEW_LIMIT`，200）条消息里还没有标签的用户消息，让 profile 的默认模型从**已有主题**中选择标签；不创建新主题，也不覆盖已有标签。模型通过公开的 `llm` 服务直接调用（模型路由取自 `agentDefaultModel`），不创建额外 Session，也不给模型任何工具。每次最多发送 `TAG_WINDOW` 条消息、每条正文截断到 1000 字符，90 秒超时；输出不是合法 JSON 时重试一次，仍失败则保持原样并在面板显示错误。标签写入后，未打标签的 agent 回复继承最近的用户消息标签；这批写入和继承在同一个事务里完成，因此主题计数和视图始终一致。

### 手动编辑标签

每条消息的标签行右侧有「编辑标签」：打开后可以逐个移除现有标签，输入名称并回车添加（会解析并创建缺失主题），保存后只替换这一条消息的标签。手动编辑不像自动打标签那样让 agent 回复继承，也不会触发分发或创建新消息；清空标签后该消息回到未打标签状态，之后自动打标签可以再次处理。标签替换在同一个事务里完成。

## HTTP 契约

所有请求要求 `x-super-chat-request: 1`，`Host` 必须匹配监听地址（或 loopback 写法），外来 `Origin` 被拒绝。POST body 为 JSON，限制 64 KiB。

| 方法 | 路径 | Body | 响应 |
| --- | --- | --- | --- |
| GET | `/super-chat/api/health` | — | `{ ok, messages, topics }` |
| GET | `/super-chat/api/workspace-group` | — | `{ group: { root, workRoot, workspaceId, title, orchestratorSessionId? } \| null }` |
| GET | `/super-chat/api/chat?topic=<id>&before=<id>&limit=<n>` | — | `{ topic?, topics, messages, olderCursor?, hasOlder?, untaggedCount, mode, busy? }` |
| GET | `/super-chat/api/chat?untagged=1&before=<id>&limit=<n>` | — | `{ topics, messages, olderCursor?, hasOlder?, untaggedCount, mode, busy? }` |
| POST | `/super-chat/api/chat` | `{ text, tags?, topic?, clientId?, via? }` | `{ result, topic?, topics, messages, olderCursor?, hasOlder?, untaggedCount, mode, busy? }` |
| POST | `/super-chat/api/chat/tag` | — | `{ tagged, topics, messages, olderCursor?, hasOlder?, untaggedCount, mode, busy? }` |
| POST | `/super-chat/api/chat/tags` | `{ id, tags, topic? }` | `{ result, topic?, topics, messages, olderCursor?, hasOlder?, untaggedCount, mode, busy? }` |
| POST | `/super-chat/api/topics` | `{ name }` | `{ topic, topics }` |
| POST | `/super-chat/api/topics/rename` | `{ id, name }` | `{ topic, topics }` |
| POST | `/super-chat/api/chat/cancel` | `{ topic? }` | `{ cancelled, topic?, topics, messages, olderCursor?, hasOlder?, untaggedCount, mode, busy? }` |
| POST | `/super-chat/api/wechat/start` | — | `{ ok, result: 'running' | 'started' }` |

- `tags` 是主题名称数组；服务端解析并创建缺失主题，消息里存主题 id。
- `topic` 是当前视图 id，用于返回同视图的消息；不是标签。
- `untagged=1` 只选没有主题标签的消息，不能和 `topic` 同时使用。
- `messages` 是一页消息，从旧到新。`limit` 为 1 到 `VIEW_LIMIT`（200）的整数，默认 `MESSAGE_PAGE`（50）。`olderCursor` 是本页最旧消息的 id；把它作为 `before` 可读取上一页，`hasOlder` 表示上一页是否可能非空。
- `untaggedCount` 是保留窗口内未打标签消息的总数，用于侧栏计数。
- 重复 `clientId` 返回 `duplicate`，不会再次投递。
- `chat/tag` 只给未打标签的消息补上已有主题；`tagged` 是本次新增标签的消息数（含继承标签的回复）。
- `chat/tags` 用提交的标签集合替换一条已有消息的标签；名称会解析并创建缺失主题，空数组表示清空。
- `mode` 为 `superagent` 或 `session`；`busy` 表示当前视图有未结束的工单或 Session 回合。

## 微信桥

`wechat/` 是独立的 Node.js 进程，默认使用通用聊天。`src/wechat-bridge.ts` 负责生命周期与保活：未保存登录凭据时只在用户打开微信接入弹窗时按需启动；一旦 `stateDir/wechat/creds.json` 存在，宿主加载和后台巡检会自动确保桥进程在线，异常退出或宿主重启后自动拉起，无需再次点击面板。每次启动前先探测 `8790/health`，已有桥则复用；否则 spawn，并只停止自己启动的进程。登录态、游标和待发队列在 `stateDir/wechat/`，旧的手动 `wechat/creds.json` 只复制一次。

- 文本里的 `@主题` 被解析成主题名称，从正文移除后作为 `tags` 提交；多个 `@主题` 产生多个标签。
- 单流轮询：桥读取 `GET /chat?limit=200`，把游标之后的 agent 消息转发到微信；带标签的回复加 `「主题」` 前缀。完整窗口让桥的已投递游标留在拉取页内，面板本身每次只分页 50 条。
- 没有命令系统；`/list` 等文本按普通消息发送。
- 桥只通过 loopback 调用 `/super-chat/api/chat`；插件宿主永远看不到微信凭据。

## Session 列表 monkey patch

### 原因

DSH 把每个 Session 渲染到 workspace 浏览器。Super Chat 的兜底 Session 是真实 Session，但不应该作为普通用户 Session 出现；DSH 0.2.1 没有公开的“隐藏 Session”标记，所以只能过滤列表响应。

### 做法

```ts
const original = ctx.sessionController.list
ctx.sessionController.list = async function (request, signal) {
  const value = await original.call(this, request, signal)
  return { ...value, items: value.items.filter(item => !item.sessionId.startsWith('super-chat-')) }
}
// 随插件销毁：
if (ctx.sessionController.list === wrapper) ctx.sessionController.list = original
```

- 只读 `items`；未知字段通过 `...value` 保留。
- 如果另一个插件之后包装了 `list`，本插件的 disposer 会保留较新的包装，避免覆盖。
- 补丁不碰 `create`、`resolveAgent`、`prompt`、`cancel`、`rename` 等其它方法。

## Superagent 工作区分组

prototype 的 orchestrator Session 在 `stateDir`，每张工单的 worker 在自己的工单目录；DSH 工作区浏览器按 Workspace 分组，所以默认每个工单是一个独立组。插件在 prototype 配置完成后用公开的 `workspaceRegistry` 做两件事：

- 对 `stateDir` 执行 `create(stateDir, 'Superagent')`，确保分组 Workspace 存在；如果它仍是 state 目录的 basename，改成 `Superagent`，用户改过的标题保留。
- 把 orchestrator Session 附加到该 Workspace，并把它加入 registry 的置顶集合。`attachSession` 要求 Session 头的 cwd 与 Workspace 路径一致；失败时跳过附加，但浏览器仍会按 id 展示。

浏览器半边每 5 秒读取 `GET /super-chat/api/workspace-group`，拿到分组后包装 `ctx.workspaces.list` 的 `getSnapshot`：把 `workRoot`（默认 `<stateDir>/work`，否则取 settings 的 `executor.directory`）下的 Workspace 从快照中移除，把它们的 Session id 合并进分组 Workspace 的 `sessionIds`。合并只发生在客户端投影里：Host registry 不变，Session 的 header cwd、工作目录和执行环境都不变；同一份快照在输入未变时保持同一对象，避免 React 无谓重渲染。

删除分组的 Workspace 注册后，快照里找不到 group，浏览器自动恢复每个工单一组；停止插件会还原原始快照。局限：只覆盖该 state 目录和 executor 目录下的 Workspace；分组内新建会话落在 state 目录；Host 更新最多延迟一个轮询周期。

## 同源与 CSRF

面板和 API 同源。自定义请求头不能由跨站表单设置，跨站 `fetch` 会触发本服务器不放行的 CORS 预检；`Origin` 检查是额外防护。这不是身份认证：DSH Web server 自己的门禁认证真人，本地进程仍可调用该路由。保持 loopback，除非部署有自己的网络控制。

## 并发与持久性

SQLite 的写入在 Node 事件循环里同步执行；一个 profile 只有一个插件进程。消息和消息-主题关系在同一事务里写入，保持索引一致。WAL 允许读与写并行；插件停止时关闭数据库。HTTP handler 不共享可变请求状态。

## 兼容性

- `dsh-superagent-prototype` 的 setup 通常要求 GitHub。GitHub 两项为空时，插件在内存中包装其 `Setup` 类，让 `run` 返回空部署，然后请求 prototype 重启；不修改 prototype 文件。该兼容路径只覆盖聊天 Source；需要 Feishu 时仍按原型要求配置 GitHub。若 `Setup.run` 形状变化，补丁失效，聊天退回兜底 Session。
- prototype 的 Source 注册、Policy 播种和 Channel 只用公开形状；不 import prototype 内部。
- 旧 `chat.json` 只导入一次；主题与标签结构由 SQLite schema 和本文档共同描述。
