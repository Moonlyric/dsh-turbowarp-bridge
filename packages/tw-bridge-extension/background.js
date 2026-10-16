// background.js — MV3 service worker：**桥的 WebSocket 唯一持有者**
//
// 为什么 socket 在这儿而不是在页面里（2026-10 改，LNA 事故）：
//   Chrome 137+ 引入 / 155 上默认强制 Local Network Access 检查。公网页面（turbowarp.org
//   解析到真实公网 IP）里 new WebSocket('ws://127.0.0.1:...') 会被直接拒：
//     net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS
//   且页面里 navigator.permissions.query({name:'local-network-access'}) 返回 **denied**
//   （不是"弹个窗让用户点允许"，是没得点）。--disable-features=LocalNetworkAccessChecks
//   也只把它降级到 prompt，无头浏览器给不了。
//   实测（三端口隔离实验）：页面被拒 / 扩展页面被拒 / **扩展 service worker 放行**。
//   所以：socket 必须在 SW 里，页面只做 vm 操作。
//
// 代价与对策（MV3 SW 空闲 30s 就被回收，socket 会跟着死）：
//   1. 每 20s 往桥发 {"type":"ping"}，桥回 {"type":"pong"}（入站流量，Chrome 116+ 会把
//      WebSocket 收发算作"活动"从而续命）
//   2. 每 20s 同时 ping 一次页面侧（顺带刷新项目标题等 meta），端口流量也算活动
//   3. chrome.alarms 每 30s 兜底：真被回收了就重新连（断电式自愈，页面无感）
//   4. 页面侧 relay-isolated.js 监听 port.onDisconnect 自动重连（把 SW 唤起来）
//
// 数据流：
//   插件 --ws(id,op,args)--> [本 SW] --port(TAG:'op')--> relay-isolated.js --postMessage-->
//   content-main.js 执行 vm 操作 --postMessage--> relay-isolated.js --port(TAG:'result')--> [本 SW] --ws--> 插件
//
// 多标签页：每个 turbowarp 标签页贡献一个端口。指令只发给**当前目标页**
// （最近被激活的那个；没有激活记录就是最近连上的），meta 里带上 tabId 和页数，
// 免得 AI 以为"只有一个编辑器"。

const TAG = '__dshBridgeRelay'
// 桥地址可以在选项页里改（默认值就是它）。为什么需要可配：验收脚本要起自己的桥，
// 而它默认也用 31820 —— 用户开着 dsh 的时候两边抢同一个端口，
// 现象是"脚本里的扩展连到了 dsh 的桥、token 对不上、全红"，很难查。
const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:31820'
let bridgeUrl = DEFAULT_BRIDGE_URL
const PING_MS = 20000
const RETRY_MS = 3000
const AUTH_RETRY_MS = 10000
// 只当"泄漏保险"，不是业务超时：真正的超时由插件侧按 op 分档决定（最长 300s）。
// 这里必须比插件长，否则大项目操作会被 SW 先掐断、报出一个莫名其妙的错。
const OP_TIMEOUT_MS = 600000
const CLOSE_AUTH = {
  4001: '握手超时（10s 内没把 token 交上去）',
  4003: '认证失败：token 不对或没填'
}
const BADGE_OK = '#2F9E44'
const BADGE_BAD = '#E03131'

let ws = null
let authed = false
let helloTokened = null
let reconnectTimer = null
let pingTimer = null
let lastCloseCode = 0
let lastReason = ''

let opSeq = 0
const pending = new Map() // id -> { tabId, timer }
const pages = new Map()   // tabId -> { port, meta, url }
let targetTabId = null

const wsStateName = () => {
  if (!ws) return 'none'
  return { 0: 'connecting', 1: 'open', 2: 'closing', 3: 'closed' }[ws.readyState] || 'none'
}

// ---------------- 图标徽标 ----------------
async function refreshBadge() {
  const text = authed ? 'DSH' : (pages.size ? '!' : '')
  const color = authed ? BADGE_OK : BADGE_BAD
  try {
    await chrome.action.setBadgeBackgroundColor({ color })
    await chrome.action.setBadgeText({ text })
  } catch { /* SW 正在被回收，忽略 */ }
}

// ---------------- 页面台账 ----------------
function pickTarget() {
  if (targetTabId !== null && pages.has(targetTabId)) return targetTabId
  const first = pages.keys().next()
  return first.done ? null : first.value
}
function targetPage() {
  const id = pickTarget()
  return id === null ? null : pages.get(id) || null
}
function pageMeta() {
  const id = pickTarget()
  const p = id === null ? null : pages.get(id)
  const m = (p && p.meta) || {}
  return {
    url: m.url || (p && p.url) || '',
    projectTitle: m.projectTitle || '',
    turbowarp: !!m.turbowarp,
    vmApi: m.vmApi || 'none',
    tabId: id,
    tabsConnected: pages.size,
    transport: 'service-worker'
  }
}
function sendToPage(port, msg) {
  try { port.postMessage(msg) } catch (e) { console.warn('[dsh-bridge] 端口发送失败:', e.message) }
}
function broadcastToPages(msg) {
  for (const rec of pages.values()) sendToPage(rec.port, msg)
}
// 目标页变了/页面重新就绪时，把 meta 同步给插件（插件允许重发 hello 刷 meta）
function pushHello() {
  if (!authed) return
  chrome.storage.local.get({ bridgeToken: '' }).then(({ bridgeToken }) => {
    sendWs({ type: 'hello', token: bridgeToken, meta: pageMeta() })
  }).catch(() => {})
}
function sendWs(obj) {
  if (!ws || ws.readyState !== 1) return false
  try { ws.send(JSON.stringify(obj)); return true } catch { return false }
}
// 页面侧看不到 socket，linkOk 完全是"被告知"的。所以每次页面报到（ready/pong/端口新连）
// 都把当前状态重发一遍 —— 边沿触发会丢：MAIN world 是 document_idle，可能比第一次
// link 消息还晚，那条消息就永远没人收（真机抓到过：SW 明明 authed=true，页面一直 connecting）。
function pushLinkState(tabId) {
  const rec = tabId === undefined ? null : pages.get(tabId)
  const msg = { [TAG]: 'link', ok: authed, tokenSet: !!helloTokened, reason: lastReason }
  if (rec) sendToPage(rec.port, msg)
  else broadcastToPages(msg)
}

// ---------------- 页面 → SW ----------------
function onPageMessage(tabId, msg) {
  if (!msg || typeof msg[TAG] !== 'string') return
  const rec = pages.get(tabId)
  switch (msg[TAG]) {
    case 'ready':
      if (rec) { rec.meta = msg.meta || rec.meta; rec.url = (msg.meta && msg.meta.url) || rec.url }
      if (targetTabId === null) targetTabId = tabId
      pushLinkState(tabId)
      if (tabId === pickTarget()) pushHello()
      refreshBadge()
      break
    case 'pong':
      if (rec && msg.meta) { rec.meta = msg.meta; rec.url = msg.meta.url || rec.url }
      pushLinkState(tabId)
      break
    case 'result': {
      const p = pending.get(msg.id)
      if (!p) return
      if (p.tabId !== tabId) {
        console.warn('[dsh-bridge] 丢弃跨标签页应答', msg.id, '来自', tabId, '期望', p.tabId)
        return
      }
      pending.delete(msg.id)
      clearTimeout(p.timer)
      sendWs(msg.ok
        ? { id: msg.id, ok: true, result: msg.result }
        : { id: msg.id, ok: false, error: msg.error || 'bridge error' })
      break
    }
    case 'event':
      // 只转目标页的事件：否则两个编辑器标签页的事件会在插件侧混成一锅
      if (tabId === pickTarget()) sendWs({ type: 'event', name: msg.name, blockId: msg.blockId, at: msg.at })
      break
    case 'watch':
      if (tabId === pickTarget()) sendWs({ type: 'watch', target: msg.target, changes: msg.changes, at: msg.at })
      break
    default:
      break
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (!port.name || port.name !== 'dsh-bridge-page') return
  const tab = port.sender && port.sender.tab
  const tabId = tab && tab.id
  if (tabId === undefined || tabId === null || tabId < 0) {
    console.warn('[dsh-bridge] 端口没有 tab 信息，忽略')
    try { port.disconnect() } catch {}
    return
  }
  // 同一标签页刷新后旧端口可能还挂着：直接顶掉
  const old = pages.get(tabId)
  if (old) { try { old.port.disconnect() } catch {} }
  const rec = { port, meta: null, url: tab.url || '' }
  pages.set(tabId, rec)
  // ⚠️ 这里必须判 `targetTabId === null`，不能判 `pickTarget() === null`：
  //    pickTarget() 会退化成"第一个已连页面"，刚 set 完必然非 null，
  //    于是 targetTabId 永远是 null（真机抓到：SW 报 target=null，但能干活，很隐蔽）。
  if (targetTabId === null) targetTabId = tabId

  port.onMessage.addListener((msg) => onPageMessage(tabId, msg))
  port.onDisconnect.addListener(() => {
    if (pages.get(tabId) === rec) pages.delete(tabId)
    if (targetTabId === tabId) targetTabId = pickTarget()
    // 该页的挂起请求全部立刻拒掉，别让插件干等 15s 超时
    for (const [id, p] of [...pending]) {
      if (p.tabId !== tabId) continue
      clearTimeout(p.timer)
      pending.delete(id)
      sendWs({ id, ok: false, error: '编辑器标签页已关闭/刷新（操作未完成）' })
    }
    pushHello()
    refreshBadge()
  })

  console.info('[dsh-bridge] 页面接管 tab', tabId, tab.url || '')
  connect()
  // 立刻要一次 meta：MAIN world 是 document_idle，可能比本端口晚就绪，
  // 那就靠 20s 的心跳补上（心跳里也带 meta）
  sendToPage(port, { [TAG]: 'ping' })
  refreshBadge()
})

// ---------------- 桥连接 ----------------
async function connect() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return
  if (!pages.size) return // 没页面就不占着桥，免得插件看到一个"空会话"
  let bridgeToken = ''
  try {
    const got = await chrome.storage.local.get({ bridgeToken: '', bridgeUrl: DEFAULT_BRIDGE_URL })
    bridgeToken = got.bridgeToken
    bridgeUrl = got.bridgeUrl || DEFAULT_BRIDGE_URL
  } catch {}
  try {
    ws = new WebSocket(bridgeUrl)
  } catch (e) {
    lastReason = '创建 WebSocket 失败: ' + e.message
    scheduleReconnect(RETRY_MS)
    return
  }
  const sock = ws
  sock.onopen = () => {
    if (sock !== ws) return
    helloTokened = bridgeToken
    lastReason = ''
    console.info('[dsh-bridge] socket open (SW), 握手 token =',
      bridgeToken ? bridgeToken.slice(0, 6) + '…' : '(空)')
    sendWs({
      type: 'hello',
      token: bridgeToken,
      meta: pageMeta()
    })
    clearInterval(pingTimer)
    pingTimer = setInterval(() => {
      if (!ws || ws.readyState !== 1) return
      sendWs({ type: 'ping' })                 // 入站 pong 是 SW 的续命口粮
      broadcastToPages({ [TAG]: 'ping' })      // 页面端口流量同理
    }, PING_MS)
  }
  sock.onclose = (ev) => {
    if (sock !== ws) return
    clearInterval(pingTimer)
    pingTimer = null
    authed = false
    lastCloseCode = (ev && ev.code) || 0
    lastReason = CLOSE_AUTH[lastCloseCode] || ''
    broadcastToPages({ [TAG]: 'link', ok: false, tokenSet: !!helloTokened, reason: lastReason })
    if (lastReason) {
      console.error(
        `[dsh-bridge] ${lastReason}。\n` +
        '  去 chrome://extensions → 本扩展「详情 → 扩展程序选项」，把 dsh 给的 token 粘进去。\n' +
        '  token 可以从 dsh 里问 AI（scratch_list_sessions 会返回），或看 dsh 启动日志的「桥 token:」那一行。'
      )
    }
    for (const [id, p] of [...pending]) {
      clearTimeout(p.timer)
      pending.delete(id)
      sendWsSafe({ id, ok: false, error: '桥连接断开（操作未完成）' })
    }
    refreshBadge()
    scheduleReconnect(lastReason ? AUTH_RETRY_MS : RETRY_MS)
  }
  sock.onerror = () => { /* onclose 会跟着来 */ }
  sock.onmessage = (ev) => {
    let msg
    try { msg = JSON.parse(ev.data) } catch { return }
    if (msg.type === 'hello-ack') {
      authed = true
      lastReason = ''
      console.info('[dsh-bridge] connected & authenticated (SW transport)')
      broadcastToPages({ [TAG]: 'link', ok: true, tokenSet: true })
      refreshBadge()
      return
    }
    if (msg.type === 'pong') return
    if (msg.op) {
      authed = true
      handleOp(msg)
    }
  }
}
// onclose 里 ws 已经废了，用它发不出去：临时借用一个裸 ws 引用没意义，
// 所以断开时的"失败应答"统一走这里（socket 还在 closing 状态时其实仍可 send）
function sendWsSafe(obj) {
  try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)) } catch {}
}

function handleOp(msg) {
  const id = msg.id
  const tabId = pickTarget()
  const rec = tabId === null ? null : pages.get(tabId)
  if (!rec) {
    sendWs({ id, ok: false, error: '没有可执行的编辑器页面（turbowarp 标签页已关闭或 content script 没注进去）' })
    return
  }
  const timer = setTimeout(() => {
    if (!pending.has(id)) return
    pending.delete(id)
    sendWs({ id, ok: false, error: `操作 ${msg.op} 在页面侧超时（${OP_TIMEOUT_MS}ms）` })
  }, OP_TIMEOUT_MS)
  pending.set(id, { tabId, timer })
  sendToPage(rec.port, { [TAG]: 'op', id, op: msg.op, args: msg.args || {} })
}

function scheduleReconnect(delayMs) {
  clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(() => { connect() }, delayMs === undefined ? RETRY_MS : delayMs)
}

// ---------------- 生命周期 ----------------
chrome.storage.onChanged.addListener((changes, area) => {
  // 用户在选项页粘完 token / 改了桥地址：不用刷新页面，直接重连
  if (area !== 'local') return
  if (!changes.bridgeToken && !changes.bridgeUrl) return
  const nextUrl = changes.bridgeUrl ? (changes.bridgeUrl.newValue || DEFAULT_BRIDGE_URL) : bridgeUrl
  const nextTok = changes.bridgeToken ? (changes.bridgeToken.newValue || '') : helloTokened
  if (nextTok === helloTokened && nextUrl === bridgeUrl && authed) return
  console.info('[dsh-bridge] 配置已更新，重连中 →', nextUrl)
  bridgeUrl = nextUrl
  authed = false
  try { if (ws) { ws.onclose = null; ws.close() } } catch {}
  ws = null
  clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(() => connect(), 200)
})

chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (!pages.has(tabId)) return
  targetTabId = tabId
  console.info('[dsh-bridge] 目标标签页切到', tabId)
  pushHello()
})

chrome.tabs.onRemoved.addListener((tabId) => {
  if (pages.has(tabId)) return // onDisconnect 会处理
  if (targetTabId === tabId) { targetTabId = pickTarget(); pushHello() }
})

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== 'dsh-bridge-ensure') return
  if (!pages.size) return
  if (!ws || ws.readyState > 1) connect()
  else broadcastToPages({ [TAG]: 'ping' })
})

chrome.runtime.onInstalled.addListener(async () => {
  console.info('[dsh-bridge] extension installed')
  chrome.alarms.create('dsh-bridge-ensure', { periodInMinutes: 0.5 })
  const { bridgeToken } = await chrome.storage.local.get({ bridgeToken: '' })
  await refreshBadge()
  if (!bridgeToken) chrome.runtime.openOptionsPage()
})
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('dsh-bridge-ensure', { periodInMinutes: 0.5 })
  refreshBadge()
})
// SW 被回收后重新拉起（端口连接 / 心跳唤醒）：确保闹钟还在，然后补连
chrome.alarms.create('dsh-bridge-ensure', { periodInMinutes: 0.5 }).catch(() => {})

// 点图标：没配 token 就去选项页，配了就把两边状态都报出来
chrome.action.onClicked.addListener(async (tab) => {
  const { bridgeToken } = await chrome.storage.local.get({ bridgeToken: '' })
  if (!bridgeToken) {
    chrome.runtime.openOptionsPage()
    return
  }
  if (!tab || !tab.id) return
  const swSide = [
    'DSH TurboWarp Bridge — 状态',
    `传输: service worker（页面直连 ws://127.0.0.1 会被 Chrome 的 Local Network Access 拦掉）`,
    `socket: ${wsStateName()} authed=${authed}`,
    `已连编辑器页: ${pages.size} 个${targetTabId !== null ? `（当前目标 tab ${targetTabId}）` : ''}`,
    lastReason ? `最近一次断开原因: ${lastReason}` : ''
  ].filter(Boolean).join('\n')
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    // ⚠️ window.__dshBridge 在 MAIN world。不写 world:'MAIN' 的话这里读的是隔离世界，
    //    永远拿到 undefined，于是"桥已注入"永远报不出来。
    world: 'MAIN',
    func: (head) => {
      const b = window.__dshBridge
      if (!b) return alert(head + '\n\n⚠️ 本页没有 DSH 桥执行器。\n确认地址是 turbowarp.org/editor（不是 /embed），然后刷新页面。')
      alert(head + '\n\n页面侧: ' + b.state() +
        '\n可用操作: snapshot / read_script / add_blocks / update_block / delete_blocks / tidy_blocks / locate / add_costume / watch / user_context / load_project / save_project')
    },
    args: [swSide]
  }).catch((e) => console.warn('[dsh-bridge] 状态查询失败:', e.message))
})

// 给自动化（lab/real-machine-check.mjs）用的 SW 侧真值探针：
// CDP 连到 service_worker target 后 evaluate '__dshBridgeSW.state()'，
// 这样"到底是谁持有的 socket"是可验证的，不用靠页面自报。
globalThis.__dshBridgeSW = {
  state () {
    return `transport=service-worker url=${bridgeUrl} socket=${wsStateName()} authed=${authed} pages=${pages.size} target=${targetTabId}`
  },
  pages: () => [...pages.keys()],
  reconnect: () => { try { if (ws) { ws.onclose = null; ws.close() } } catch {} ; ws = null; return connect() }
}
