# dsh-super-chat

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Super Chat 插件：核心是为 `dsh-superagent-prototype` 提供 `super-chat` Source，并实现单流聊天、主题标签、loopback API 和 SQLite 存储。

[简体中文](AGENTS.zh.md) | [English](AGENTS.md)

## 背景

- DeepSeek Harness（dsh）：
  - 本机应有一份完整的 deepseek-harness checkout。涉及 DSH 机制、生命周期或模块边界时，先读实际源码、类型和调用点，不靠猜测。
  - 依赖版本以 `package.json` 的 `engines` 与 `peerDependencies` 为准；默认兼容 `0.2.1-rc.5` 系列。
- 本仓库有两个面：
  - 根目录的独立 Super Chat 插件（`src/`、`tests/`、`docs/`）：单流聊天面板、宿主 API、`chat.sqlite` 存储；superagent 不可用时只有一个兜底 DSH Session。
  - `wechat/`：插件内置的微信「文件传输助手」桥，独立 Node.js 进程，拥有自己的登录态；打开微信接入时按需启动，默认通用聊天，用 `@主题` 自然语言打标。
- Superagent 集成（核心）：插件通过 `dsh-superagent-prototype` 的公开 `orchestrator` 服务注册 `super-chat` Source，把消息变成工单；没有该服务时回退到单个通用 DSH Session 作为降级路径。原型代码由它自己的 checkout 维护，本仓库不修改它。
- 只使用公开服务：根插件注入 `webServer`、`sessionController`、`agents`、`permissionPresets`；Superagent 集成只使用 `orchestrator` 的结构化接口。不要 import 其他插件的内部模块。

## 代码规范

### 优先级

- 用户体验、数据准确性、数据完整性优先。不要为了重构、性能或便利牺牲它们。
- 每个改动都要用真实测试或可复现的运行验证，不靠假设。
- 与 DSH 现有能力冲突时，先确认 DSH 的公开契约，再决定是否加本地补丁。

### 数据完整性

- 消息和主题必须完整、可恢复。`chat.sqlite` 的写入在事务中完成，消息与 `message_topic` 索引保持一致；目录 `0700`。
- 消息和主题都有上限（`MESSAGE_LIMIT`、`TOPIC_LIMIT`）；淘汰只移除最旧消息，不能静默丢失当前主题。
- 数据库或旧 `chat.json` 损坏时隔离为 `.corrupt-<timestamp>`，不要让 DSH 启动失败，也不要静默覆盖。
- 面板显示所选视图的完整消息；轮询是读，不得因为读而改变排序或标签。
- Superagent 集成里，Trigger、Thread、Ticket 的身份必须稳定：`super-chat` Source；有标签时 dispatch thread 是 `super-chat:topic:<topicId>`，无标签时是 `super-chat:general`；不能因重启改变授权或工单历史。

### 效率

- 做能完整解决问题的最小改动，选择最直接的实现。
- 代码与测试保持小而模块化；复用现有模块、断言、样式和 DSH 设计 token，不重复造轮子。
- 删除过时或不再需要的代码与测试。

### 注释

- 注释只解释为什么这样、保护什么不变量，或说明非显然的边界；不要复述下一行代码。
- 用户可见错误要指出具体对象和下一步动作。
- 机械指令（`v8 ignore`、三斜线引用等）保留最小必要说明，不写解释性长文。

### 测试

- Vitest + jsdom；mock 所有 DSH 服务。测试不得启动真实 DSH agent、调用模型提供方、访问网络、读取操作者 home 目录或真实 `gh`/`lark-cli`。
- 先跑最窄的测试（`pnpm vitest run tests/<name>.spec.ts -t "<case>"`），再跑全量。
- 复用现有 suite/case/assertion；新增行为要有覆盖失败路径和回退路径的测试。
- Superagent 集成的测试使用 fake `orchestrator`，不 import prototype 内部；至少覆盖：空 GitHub 的 chat-only 补丁、已配置 GitHub 时不接管、Policy 只播种一次、主题 dispatch/Channel/Thread context、兜底 Session 回退。
- SQLite 测试使用临时目录，结束时 `close()` 并删除目录；旧 `chat.json` 迁移和损坏隔离要有测试。

### 优化

- 防止过度设计，避免为假想需求增加抽象。
- 避免悬挂引用、未清理定时器、无界缓存和长会话内存增长；服务端与浏览器半边都要考虑。
- 定时器、监听器和 unregister/effect 必须在 stop/dispose 时清理。

### 语言

- 代码、注释、测试和提交信息用英文。
- 文档默认英文；中文版本放在同目录同名 `.zh.md`。两者内容保持同步。
- UI 文案必须同时更新 `src/client/locales.ts` 的中文和英文；删除废弃 key。

### 临时文件

- 临时文件只放 `./.artifacts/`（已在 `.gitignore`）；用完后立即删除。
- 不提交 `node_modules/`、`lib/`、`.artifacts/`、`chat.sqlite`（含 WAL/SHM）、旧 `chat.json`、微信 `creds.json`/`state.json`/`.cache/` 或日志。

### 文件大小

- 每个源码或测试文件保持在 1000 行以内；接近上限时按职责拆分。

## 关键不变量

- **HTTP guard**：每个 `/super-chat` 请求必须同源（`Host` 匹配）、带 `x-super-chat-request: 1`，且没有外来 `Origin`。不要削弱或新增无同样检查的端点；只绑定 loopback。
- **Session 身份**：兜底 Session 固定为 `super-chat-general`；前缀是保留的，也是列表补丁过滤的依据。不要随意改前缀。
- **Store 规则**：一个 `stateDir` 一份 `chat.sqlite`；消息与标签在同一事务写入，带索引、仅本人可读、消息/主题有上限；损坏文件隔离而不是覆盖。
- **主题身份**：主题 id 是稳定的 `tp-<uuid>`；消息存主题 id，展示用名称。首个标签决定 dispatch thread，但主题不是硬分区；不要把它改成不同的存储分区。
- **两个窄补丁**：
  - `monkey.ts` 包装 `sessionController.list`，只过滤 `super-chat-*`，只在包装仍位于顶层时恢复，响应形状异常时非致命。
  - `superagent.ts` 只在 GitHub 两项都为空、且能访问公开 `orchestrator` 时，内存中包装 prototype 的 `Setup.run`；其他配置交给原型；补丁失效时回退单个通用 Session。
- **Superagent 集成可降级**：正常情况下优先把消息交给原型；只有在 `super-chat` Policy 存在且原型 `configured()` 时才路由，其余情况走单个兜底 GeneralSession。降级不能变成静默失败，插件也不能因为原型缺失或变化而无法加载。
- **浏览器半边**：React 18，运行时不 import DSH 包；只通过 `slots`、`locale`、`layout` 等 client context 注册；消息文本按文本渲染，绝不作为 HTML。
- **侧边栏位置**：Super Chat 不单独占一行；`src/client/index.tsx` 把自己的 `sidebar.panellist` 行隐藏，把 `Super Chat` chip 挂到前一行（Superagent）的标题右侧。找不到 Superagent 行时保留独立入口；DOM 监听必须可清理，且不能吞掉 Superagent 行本身的点击。

## 提交前检查

- 收尾待办清单，确认每一项已完成或明确关闭。
- 独立复查完整 diff：每个改动必要、正确、不过度设计。
- 清理临时文件、临时注释和无用输出。
- 运行 `pnpm check`（typecheck → vitest → tsdown build），完整查看输出；全部通过。
- 文档改动同时检查英文默认版与 `.zh.md` 中文版；命令、路径、环境变量和链接必须真实可执行。
- UI 改动提供同场景、同视口、同状态的前后截图；截图放仓库外，使用合成或脱敏数据。
- 不把个人路径、账号、token、cookie、聊天内容写进仓库、测试、截图或文档。

## 布局与响应式

- 面板是 DSH 的中心列，不是浏览器 viewport；宽度会随侧边栏折叠和拖拽变化。优先用 container queries，不要用 viewport media queries 当唯一依据。
- 宽度不足时折叠或换行，不要把内容压碎；不出现横向滚动条、不重叠，最窄面板下每个字段仍可达。
- 使用 DSH 设计 token（`var(--dsw-alias-*)`），不要硬编码颜色和间距。
- 全屏/遮罩层要 portal 到 `document.body`，避免 container query 的 containing block 影响。
- 布局改动要在桌面到手机宽度（约 390px）、中英两种语言、长聊天和微信接入弹窗下实际验证。

## 构建与运行

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm check          # 提交前完整门禁
cd wechat && npm test
```

- `lib/` 是构建产物，重新构建，不要手改。
- 端到端验证：把 checkout 装进一次性 profile，用空闲端口启动，并把 `stateDir` 指到临时目录；不要重启正在使用的 profile，除非用户明确要求。
- 启动输出给出带 token 的完整 Web URL；每次重启 token 会变，旧 URL 立即失效。不要把 token 写进仓库或提交。
- 宿主插件改动通常需要重启 profile 才生效；客户端 HMR 只在开发 watcher 运行时可用，不要假设刷新页面就能加载宿主改动。
- Superagent 集成：验证一次 chat-only（GitHub 两项为空）和一次已配置 GitHub 的路径；确认未安装原型时单个兜底 Session 仍正常；再发一条带主题的消息，确认它走 `super-chat:topic:<id>` 并在回复里带标签。

## 兼容性

- 必须兼容 `engines` 声明的 DSH `0.2.1-rc.5` 系列，不回归运行时依赖、消息解析或用户可见行为。
- `docs/architecture.md` 是架构与协议的英文事实来源，`docs/architecture.zh.md` 是中文镜像；兼容性相关的改动先读它，并在同一提交里更新。
- Superagent 集成依赖 prototype 的公开 `orchestrator` 形状。chat-only 补丁只覆盖聊天 Source；需要 Feishu 时仍按原型要求配置 GitHub。若其 `Setup.run`、Source 接口或生命周期变化，优先去掉兼容补丁并回退到原生能力；不要让插件启动失败。
- 依赖尽量保持最新；升级 DSH 依赖后跑 `pnpm check`，并检查 `docs/architecture.md` 中的模块表。

## I18n

- UI 支持简体中文和英文，跟随 DSH locale。
- 新增或修改 UI 文案时同时更新两种语言，删除废弃 key。
- 文档默认英文；中文放同目录同名 `.zh.md`，不要只改其中一边。

## 微信桥（wechat/）

- 它是插件功能的一部分，但按设计是独立进程：**未登录时只在用户打开微信接入弹窗时按需启动**（无凭据时插件加载不预拉起）；已有保存的 `creds.json` 时，宿主在加载和后台巡检时自动恢复并保活桥进程。
- `src/wechat-bridge.ts` 负责生命周期：先探测 `8790/health`，已有桥则复用；否则 spawn `wechat/src/service.mjs`，把 `SUPERCHAT_URL` 指向当前面板端口；只停止自己启动的子进程，外部桥不动。
- 登录态、游标和待发队列存在 `stateDir/wechat/`；旧的手动 `wechat/creds.json` 只复制一次。永远不要提交这些文件。
- 桥只监听 loopback `127.0.0.1:8790`，测试用 mock 微信后端；不要把桥并入 DSH 进程。

## 文档

- `docs/` 只放面向用户的文档。
- `README.md` 是英文默认版，中文为 `README.zh.md`；`CHANGELOG.md`、`SECURITY.md`、`wechat/README.md`、`docs/architecture.md` 同理。
- 文档中的命令、路径、配置键和环境变量必须与实际代码一致；不要写机器相关的绝对路径、个人账号、token 或聊天内容。
- 截图使用合成或脱敏数据；不要暴露真实会话。
- 文档改名或新增时同步更新 `package.json` 的 `files` 和正文交叉链接。

## Git

- 按任务或目的拆分提交，主题用短的 `area: summary`（`host:`、`client:`、`superagent:`、`wechat:`、`docs:`）。
- 不要提交生成的 `lib/`、`node_modules/`、`.artifacts/`、聊天数据、微信凭据或日志。
- 未明确要求时不要 `git push`；提交前确认工作区没有无关改动。

## 发布

- 版本遵循 `X.Y.Z`（大版本.次版本.小版本）；发布前复查自上次 tag 以来的提交。
- `pnpm check` 必须全绿；重新构建 `lib/` 后确认 `package.json` 的 `files` 包含当前文档和 `wechat/`。
- 打 tag 和创建 release 由维护者执行；发布说明写清用户可见变化、兼容性和破坏性变更。
