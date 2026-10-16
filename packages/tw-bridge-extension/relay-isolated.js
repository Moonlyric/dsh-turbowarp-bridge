// relay-isolated.js — ISOLATED world 的内容脚本（document_start）
//
// 职责：MAIN world 的 content-main.js ↔ 扩展 service worker 之间的**双向中继**。
//
// 为什么需要这一层：
//   1. content-main.js 必须跑在 MAIN world（window.vm 在页面主世界），而 MAIN world
//      的脚本拿不到任何 chrome.* API；两个世界唯一的通道是 window.postMessage。
//   2. 桥的 WebSocket 现在在 background.js（SW）里，不在页面里 —— Chrome 155 的
//      Local Network Access 检查会把公网页面连 ws://127.0.0.1 直接拒掉
//      （net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS），扩展 SW 才豁免。
//
// 消息名（都用 __dshBridgeRelay 做标记，避免和页面自己的 postMessage 撞车）：
//   SW    → 页面: 'op'   {id, op, args}   一条 vm 操作
//                'ping' {}                心跳（页面回 pong，顺带带 meta）
//                'link' {ok, tokenSet, reason}  SW 侧 socket/认证状态
//   页面 → SW:  'ready'  {meta}           执行器就绪
//               'result' {id, ok, result|error}
//               'event'  {name, blockId, at}     用户事件（绿旗/选块）
//               'watch'  {target, changes, at}   变量变化帧
//               'pong'   {meta}
//
// MV3 注意：SW 空闲约 30s 会被回收，**长连接端口会随之断开**。所以这里必须自己重连，
// 否则 SW 醒来后页面这一侧永远接不回来（这正是很多 MV3 扩展"过一会儿就失灵"的原因）。

const TAG = '__dshBridgeRelay'
const RECONNECT_MS = 1000
const WATCHDOG_MS = 3000

let port = null
let reconnectTimer = null
let outbox = [] // 端口没就绪时先攒着（MAIN world 是 document_idle，可能比端口晚）

function toPage(msg) {
  try { window.postMessage(msg, window.location.origin) } catch { /* 非浏览器环境 */ }
}

function flush() {
  if (!port || !outbox.length) return
  const q = outbox
  outbox = []
  for (const m of q) {
    try { port.postMessage(m) } catch { outbox.push(m); break }
  }
}

function ensurePort() {
  if (port) return port
  clearTimeout(reconnectTimer)
  try {
    port = chrome.runtime.connect({ name: 'dsh-bridge-page' })
  } catch (e) {
    port = null
    scheduleReconnect()
    return null
  }
  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg[TAG] !== 'string') return
    toPage(msg)
  })
  port.onDisconnect.addListener(() => {
    port = null
    toPage({ [TAG]: 'link', ok: false, reason: '扩展后台正在休眠/重启，自动重连中…' })
    scheduleReconnect()
  })
  flush()
  return port
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(() => { ensurePort() }, RECONNECT_MS)
}

// 看门狗：端口"存在但已死"的情况（浏览器没派发 onDisconnect 时）也能兜住
setInterval(() => { if (!port) ensurePort() }, WATCHDOG_MS)

window.addEventListener('message', (e) => {
  // 只认本窗口自己发来的消息（排除 iframe / 其它窗口冒名）
  if (e.source !== window) return
  const d = e.data
  if (!d || typeof d[TAG] !== 'string') return
  const kind = d[TAG]
  // SW → 页面的三个由上面的 onMessage 直通，这里只处理页面 → SW
  if (kind !== 'ready' && kind !== 'result' && kind !== 'event' && kind !== 'watch' && kind !== 'pong') return
  if (!port) {
    if (kind !== 'pong') outbox.push(d) // 心跳丢了无所谓，操作类不能丢
    ensurePort()
    return
  }
  try { port.postMessage(d) } catch { outbox.push(d); port = null; scheduleReconnect() }
})

chrome.storage.onChanged.addListener((changes, area) => {
  // token 变了由 SW 自己处理（它直接读 chrome.storage）；这里只提醒页面刷状态
  if (area === 'local' && changes.bridgeToken) toPage({ [TAG]: 'link', ok: false, reason: 'token 已更新，正在重连…' })
})

ensurePort()
