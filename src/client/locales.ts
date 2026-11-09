/** Super Chat panel strings, following DSH's locale registration shape. */
import type { Translate } from './dsh.ts'

export type SuperChatKey =
  | 'lang'
  | 'panelTitle'
  | 'panelEntry'
  | 'generalChat'
  | 'untagged'
  | 'topics'
  | 'newTopic'
  | 'topicPlaceholder'
  | 'emptyGeneral'
  | 'emptyUntagged'
  | 'emptyTopic'
  | 'placeholder'
  | 'send'
  | 'sendHint'
  | 'you'
  | 'agent'
  | 'stop'
  | 'stopHint'
  | 'busy'
  | 'loading'
  | 'loadingOlder'
  | 'olderHint'
  | 'connectionFailed'
  | 'resize'
  | 'close'
  | 'openTopic'
  | 'removeTopic'
  | 'editTags'
  | 'removeTag'
  | 'showRaw'
  | 'showRawHint'
  | 'showRendered'
  | 'showRenderedHint'
  | 'save'
  | 'cancel'
  | 'tagPlaceholder'
  | 'autoTag'
  | 'autoTagHint'
  | 'autoTagRunning'
  | 'autoTagNoTopics'
  | 'autoTagDone'
  | 'autoTagNone'
  | 'modeSuperagent'
  | 'modeSession'
  | 'chatWechat'
  | 'chatWechatTitle'
  | 'chatWechatSubtitle'
  | 'chatWechatLoggedOut'
  | 'chatWechatConnecting'
  | 'chatWechatWaiting'
  | 'chatWechatScanned'
  | 'chatWechatStarting'
  | 'chatWechatError'
  | 'chatWechatRetry'
  | 'chatWechatLogin'
  | 'chatWechatQrAlt'
  | 'chatWechatNoQr'
  | 'chatWechatScanHint'
  | 'chatWechatConnected'
  | 'chatWechatConnectedHint'
  | 'chatWechatAccount'
  | 'chatWechatLogout'
  | 'chatWechatLogoutConfirm'
  | 'chatWechatUnreachable'
  | 'chatWechatStateConnected'
  | 'chatWechatStateLoggedOut'
  | 'chatWechatStateUnreachable'
  | 'models'
  | 'modelsTitle'
  | 'modelsSubtitle'
  | 'modelOrchestrator'
  | 'modelOrchestratorHint'
  | 'modelWorker'
  | 'modelWorkerHint'
  | 'modelProvider'
  | 'modelName'
  | 'modelChoose'
  | 'modelInherit'
  | 'modelEffort'
  | 'modelEffortDefault'
  | 'modelsDefault'
  | 'modelsSaved'
  | 'modelsUnavailable'
  | 'modelsDirectiveHint'
  | 'modelsFailures'
  | 'modelsInvalid'
  | 'listSeparator'

export type T = Translate

export const en: Record<SuperChatKey, string> = {
  lang: 'en',
  panelTitle: 'Super Chat',
  panelEntry: 'Super Chat',
  generalChat: 'All messages',
  untagged: '<No topic>',
  topics: 'Topics',
  newTopic: 'New topic',
  topicPlaceholder: 'Topic name',
  emptyGeneral: 'No messages yet. Tell Superagent what you need.',
  emptyUntagged: 'No untagged messages.',
  emptyTopic: 'No messages in this topic yet.',
  placeholder: 'Message Superagent…',
  send: 'Send',
  sendHint: 'Enter sends, Shift+Enter adds a line. Add a topic chip to cue dispatch.',
  you: 'You',
  agent: 'Superagent',
  stop: 'Stop',
  stopHint: 'Stop the work for this view',
  busy: 'Working',
  loading: 'Loading…',
  loadingOlder: 'Loading older messages…',
  olderHint: 'Scroll up for older messages',
  connectionFailed: 'The Super Chat server is unreachable. Retrying…',
  resize: 'Resize the topic list',
  close: 'Close',
  openTopic: 'Open this topic',
  removeTopic: 'Remove topic',
  editTags: 'Edit tags',
  removeTag: 'Remove tag',
  showRaw: 'Raw',
  showRawHint: 'Show the original message text',
  showRendered: 'Rendered',
  showRenderedHint: 'Show the Markdown rendering',
  save: 'Save',
  cancel: 'Cancel',
  tagPlaceholder: 'Add a topic…',
  autoTag: 'Auto-tag',
  autoTagHint: 'Use the model to label untagged messages with existing topics; existing tags are kept',
  autoTagRunning: 'Tagging…',
  autoTagNoTopics: 'Create a topic first to auto-tag messages',
  autoTagDone: 'Tagged {count} messages',
  autoTagNone: 'No messages needed tagging',
  modeSuperagent: 'Superagent handles this chat; topics are dispatch cues',
  modeSession: 'Standalone Session (Superagent unavailable)',
  chatWechat: 'WeChat access',
  chatWechatTitle: 'WeChat remote access',
  chatWechatSubtitle: 'WeChat File Transfer Helper',
  chatWechatLoggedOut: 'Not connected. Scan the code with mobile WeChat to sign in to File Transfer Helper.',
  chatWechatConnecting: 'Fetching a QR code…',
  chatWechatWaiting: 'Scan the QR code with mobile WeChat',
  chatWechatScanned: 'Scanned; confirm the sign-in on your phone',
  chatWechatStarting: 'Signed in; connecting…',
  chatWechatError: 'Sign-in failed; try again',
  chatWechatRetry: 'Get a new QR code',
  chatWechatLogin: 'Scan to sign in',
  chatWechatQrAlt: 'WeChat sign-in QR code',
  chatWechatNoQr: 'The QR code will appear here',
  chatWechatScanHint: 'After signing in, message Super Chat from WeChat File Transfer Helper; replies go back to both this panel and WeChat.',
  chatWechatConnected: 'Connected',
  chatWechatConnectedHint: 'File Transfer Helper is connected; messages sent in WeChat appear in Super Chat.',
  chatWechatAccount: 'WeChat account',
  chatWechatLogout: 'Sign out',
  chatWechatLogoutConfirm: 'Signing out stops WeChat access until you scan again. Sign out?',
  chatWechatUnreachable: 'Cannot reach the WeChat bridge (127.0.0.1:8790). Run ./run-superchat.sh in the repository\'s wechat/ directory; if the panel is not on port 3080, set SUPERCHAT_URL.',
  chatWechatStateConnected: 'Connected',
  chatWechatStateLoggedOut: 'Not connected',
  chatWechatStateUnreachable: 'Unavailable',
  models: 'Models',
  modelsTitle: 'Model settings',
  modelsSubtitle: 'Choose the orchestrator model and the default model for new workers.',
  modelOrchestrator: 'Orchestrator model',
  modelOrchestratorHint: 'Used by the assessment and main Session; saving also switches the running orchestrator. Existing worker Sessions keep their model.',
  modelWorker: 'Default worker model',
  modelWorkerHint: 'Used by worker Sessions created after saving; already-running workers keep their model.',
  modelProvider: 'Provider',
  modelName: 'Model',
  modelChoose: 'Choose a model',
  modelInherit: 'Inherit default',
  modelEffort: 'Reasoning',
  modelEffortDefault: 'Provider default',
  modelsDefault: 'Deployment default: {model}',
  modelsSaved: 'Saved.',
  modelsUnavailable: 'Superagent is unavailable, so model settings cannot be edited.',
  modelsDirectiveHint: 'In chat, write “use <model> model to start a new worker for …” or “用<模型>模型启动一个新 worker 做…” to give that new worker the model. The model must appear in the list above.',
  modelsFailures: 'Some providers could not be listed: {names}.',
  modelsInvalid: 'Choose a model for every provider you selected.',
  listSeparator: ', ',
}

export const zh: Record<SuperChatKey, string> = {
  lang: 'zh',
  panelTitle: 'Super Chat',
  panelEntry: 'Super Chat',
  generalChat: '全部消息',
  untagged: '<无主题>',
  topics: '主题',
  newTopic: '新建主题',
  topicPlaceholder: '主题名称',
  emptyGeneral: '还没有消息。直接告诉 Superagent 你要做什么。',
  emptyUntagged: '没有未打标签的消息。',
  emptyTopic: '这个主题还没有消息。',
  placeholder: '给 Superagent 发消息…',
  send: '发送',
  sendHint: 'Enter 发送，Shift+Enter 换行。添加主题标签可作为分发线索。',
  you: '你',
  agent: 'Superagent',
  stop: '停止',
  stopHint: '停止当前视图的工单',
  busy: '处理中',
  loading: '加载中…',
  loadingOlder: '正在加载更早的消息…',
  olderHint: '上滚加载更早的消息',
  connectionFailed: '无法连接 Super Chat 服务，正在重试…',
  resize: '调整主题列表宽度',
  close: '关闭',
  openTopic: '打开该主题',
  removeTopic: '移除主题',
  editTags: '编辑标签',
  removeTag: '移除标签',
  showRaw: '原文',
  showRawHint: '显示消息的原始文本',
  showRendered: '渲染',
  showRenderedHint: '显示 Markdown 渲染结果',
  save: '保存',
  cancel: '取消',
  tagPlaceholder: '添加主题…',
  autoTag: '自动打标签',
  autoTagHint: '用模型判断未打标签的消息，套用已有主题；已有标签不会改动',
  autoTagRunning: '正在判断…',
  autoTagNoTopics: '先创建主题才能自动打标签',
  autoTagDone: '已为 {count} 条消息打上标签',
  autoTagNone: '没有需要打标签的消息',
  modeSuperagent: '由 Superagent 接单；主题只是分发线索',
  modeSession: '独立 Session（Superagent 不可用）',
  chatWechat: '微信远程接入',
  chatWechatTitle: '微信远程接入',
  chatWechatSubtitle: '微信文件传输助手',
  chatWechatLoggedOut: '未登录。用手机微信扫码，登录文件传输助手。',
  chatWechatConnecting: '正在获取二维码…',
  chatWechatWaiting: '请使用手机微信扫码',
  chatWechatScanned: '已扫码，请在手机上确认登录',
  chatWechatStarting: '登录成功，正在连接…',
  chatWechatError: '登录失败，请重试',
  chatWechatRetry: '重新获取二维码',
  chatWechatLogin: '扫码登录',
  chatWechatQrAlt: '微信登录二维码',
  chatWechatNoQr: '二维码将在这里显示',
  chatWechatScanHint: '扫码登录后，在微信「文件传输助手」里给 Super Chat 发消息，回复会回到这里和微信。',
  chatWechatConnected: '已连接',
  chatWechatConnectedHint: '文件传输助手已连接，微信里发的消息会进入 Super Chat。',
  chatWechatAccount: '微信账号',
  chatWechatLogout: '退出登录',
  chatWechatLogoutConfirm: '退出后微信消息会停止接入，需要重新扫码。确定退出？',
  chatWechatUnreachable: '无法连接微信接入服务（127.0.0.1:8790）。请在仓库的 wechat/ 目录运行 ./run-superchat.sh；如果面板不在 3080，请设置 SUPERCHAT_URL。',
  chatWechatStateConnected: '已连接',
  chatWechatStateLoggedOut: '未登录',
  chatWechatStateUnreachable: '不可用',
  models: '模型',
  modelsTitle: '模型设置',
  modelsSubtitle: '选择 orchestrator 的模型，以及新 worker 的默认模型。',
  modelOrchestrator: 'Orchestrator 模型',
  modelOrchestratorHint: '用于研判和主 Session；保存后会立即切换当前 orchestrator。已运行的 worker Session 保持原模型。',
  modelWorker: '默认 worker 模型',
  modelWorkerHint: '只对保存后新建的 worker Session 生效；已在运行的 worker 保持原模型。',
  modelProvider: '服务商',
  modelName: '模型',
  modelChoose: '选择模型',
  modelInherit: '继承默认',
  modelEffort: '推理档位',
  modelEffortDefault: '服务商默认',
  modelsDefault: '部署默认：{model}',
  modelsSaved: '已保存。',
  modelsUnavailable: 'Superagent 不可用，无法修改模型设置。',
  modelsDirectiveHint: '在对话里写“用<模型>模型启动一个新 worker 做…”或“use <model> model to start a new worker for …”，该新 worker 会用指定模型；模型需在上面的列表里。',
  modelsFailures: '部分服务商无法列出：{names}。',
  modelsInvalid: '为已选择的服务商选好模型。',
  listSeparator: '、',
}
