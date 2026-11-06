/** Super Chat panel strings, following DSH's locale registration shape. */
import type { Translate } from './dsh.ts'

export type SuperChatKey =
  | 'lang'
  | 'panelTitle'
  | 'panelEntry'
  | 'generalChat'
  | 'topics'
  | 'newTopic'
  | 'topicPlaceholder'
  | 'emptyGeneral'
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
  | 'connectionFailed'
  | 'resize'
  | 'close'
  | 'openTopic'
  | 'removeTopic'
  | 'tagPlaceholder'
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

export type T = Translate

export const en: Record<SuperChatKey, string> = {
  lang: 'en',
  panelTitle: 'Super Chat',
  panelEntry: 'Super Chat',
  generalChat: 'General chat',
  topics: 'Topics',
  newTopic: 'New topic',
  topicPlaceholder: 'Topic name',
  emptyGeneral: 'No messages yet. Tell Superagent what you need.',
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
  connectionFailed: 'The Super Chat server is unreachable. Retrying…',
  resize: 'Resize the topic list',
  close: 'Close',
  openTopic: 'Open this topic',
  removeTopic: 'Remove topic',
  tagPlaceholder: 'Add a topic…',
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
}

export const zh: Record<SuperChatKey, string> = {
  lang: 'zh',
  panelTitle: 'Super Chat',
  panelEntry: 'Super Chat',
  generalChat: '通用聊天',
  topics: '主题',
  newTopic: '新建主题',
  topicPlaceholder: '主题名称',
  emptyGeneral: '还没有消息。直接告诉 Superagent 你要做什么。',
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
  connectionFailed: '无法连接 Super Chat 服务，正在重试…',
  resize: '调整主题列表宽度',
  close: '关闭',
  openTopic: '打开该主题',
  removeTopic: '移除主题',
  tagPlaceholder: '添加主题…',
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
}
