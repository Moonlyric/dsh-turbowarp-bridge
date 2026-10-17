// dsh-plugin-scratch — M0 原型入口
// 把 TurboWarp 编辑器接入 DeepSeek Harness：
//   本插件 = WebSocket 桥（服务端） + scratch_* 工具
//   tw-bridge-extension（MV3 扩展）= 桥客户端 + turbowarp.org 页面 MAIN world 执行器
//
// 工具注册走 @deepseek-ai/dsh-tools 的 defineTool（0.2.0-rc.2 实测通过）。

import { defineTool as rawDefineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join, dirname, resolve, sep } from 'node:path'
import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, copyFileSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
import { basename } from 'node:path'
// CDP 直连（不需要浏览器扩展）—— 见 cdp.js 顶部注释。TurboWarp Desktop 走的就是这条路。
import { attachCdp, findFreePort, tagForPage, probeCdp } from './cdp.js'

export const name = 'dsh-plugin-scratch'
export const inject = ['tools'] // dsh 规范：用到 ctx.tools 必须声明，框架保证注入后才加载

// ---------------- 配置 schema ----------------
// 为什么是 `.volatile()`：dsh 的「插件页 → 点进组合包 → 点某一行 → 配置」只渲染
// **volatile 字段**（dsh-settings 的 volatileForm）。普通字段依旧只能改 YAML 文件，
// 页面上根本不会出现配置控件 —— 这就是「设置参数用不了」的根因。
// volatile 字段在运行时是 `{ get() }` 引用（cosmokit 的 createVolatile），不改 profile、
// 不重挂插件就能读到新值；所以下面所有读取都走 cfg（每次读都 get() 一次），改完立即生效。
// ⚠️ 字段名/类型必须与已写入 profile 的 YAML 值兼容（字符串存端口会报校验错）。
export const Config = z.object({
  safety: z.union(['auto', 'preview', 'suggest']).default('preview').volatile()
    .description('写操作落地方式：preview 先给 diff 等确认，auto 直接落盘，suggest 只给建议'),
  bridgePort: z.natural().min(1).max(65535).default(31820).volatile()
    .description('桥监听端口（浏览器扩展连这个端口）。改完 ~2 秒内自动重绑，不用重启'),
  snapshotsDir: z.string().default('').volatile()
    .description('快照目录，留空 = 系统临时目录。大项目别堆在系统盘'),
  maxSnapshots: z.natural().default(30).volatile().description('内存里最多留几份快照'),
  maxSnapshotMemMb: z.natural().default(64).volatile().description('快照内存上限（MB）'),
  maxSnapshotDiskMb: z.natural().default(256).volatile().description('快照落盘上限（MB）'),
  skillsEnabled: z.boolean().default(true).volatile()
    .description('Skill 经验库总开关（关掉后 scratch_skills 只回 disabled）'),
  desktopPath: z.string().default('').volatile()
    .description('TurboWarp Desktop 的 exe 路径，留空 = 自动找'),
  desktopDebugPort: z.natural().min(1).max(65535).default(31821).volatile()
    .description('「AI 可接管」的固定调试端口（与仓库里的 启动TurboWarp(AI可接管).cmd 保持一致）'),
  browserPath: z.string().default('').volatile()
    .description('网页版用哪个浏览器打开，留空 = 系统默认浏览器'),
})

/** 读 volatile 引用（`{ get() }`）或普通值；每次读都取最新，UI 保存后立即生效 */
const readLive = (value) => (value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value)

// ---------------- 返回值清洗：必须是「无损 JSON」----------------
// 真实的 harness 会校验工具返回值（`value is not lossless JSON`），而 `undefined`
// 之类的值会让**整个工具调用失败**。实验室的替身层是直接 execute()，不走那道校验，
// 所以这个坑藏了很久：装上真 dsh 后第一次调 scratch_list_sessions 就报
// "tool returned invalid output: value is not lossless JSON"（`tokenIsNew: xxx || undefined` 干的）。
// 这里统一兜住：每一个工具返回值都过一遍清洗，作者不用再操心。
function jsonSafe(v, seen) {
  if (v === null) return null
  const t = typeof v
  if (t === 'string' || t === 'boolean') return v
  if (t === 'number') return Number.isFinite(v) ? v : null
  if (t === 'bigint') return String(v)
  if (t === 'undefined' || t === 'function' || t === 'symbol') return undefined // 交给调用方决定丢不丢这个键
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) {
    return { bytes: v.byteLength, note: '二进制数据不能直接进工具返回值' }
  }
  if (Array.isArray(v)) {
    return v.map(x => { const y = jsonSafe(x, seen); return y === undefined ? null : y })
  }
  if (t === 'object') {
    if (!seen) seen = new Set()
    if (seen.has(v)) return null // 循环引用
    seen.add(v)
    const out = {}
    for (const [k, val] of Object.entries(v)) {
      const y = jsonSafe(val, seen)
      if (y !== undefined) out[k] = y
    }
    seen.delete(v)
    return out
  }
  return String(v)
}
/** 包一层：所有工具返回值先清洗再交给 harness */
const defineTool = (def) => rawDefineTool(
  Object.assign({}, def, { execute: async (...args) => jsonSafe(await def.execute(...args)) })
)

// defineTool 公共 output 规格：M0 一律返回 JSON（TA 决策：全程 JSON）
const jsonOut = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx, config) {
  const log = ctx.logger('scratch')
  // 配置的「活视图」：volatile 字段是 { get() } 引用，每次读都拿到最新值。
  // 这样用户在插件页的配置表单里改完，下一次工具调用就按新值走，不用重启 dsh。
  const cfg = new Proxy({}, {
    get: (_t, key) => readLive(config[key]),
    has: (_t, key) => key in config,
    ownKeys: () => Reflect.ownKeys(config),
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
  })
  log.info('TurboWarp bridge plugin loaded, safety=%s port=%s', cfg.safety, cfg.bridgePort)

  // ---------------- 桥：管理已连接的 TW 编辑器会话 ----------------
  // 每个「会话」= 一个连上桥、且**通过 token 认证**的 turbowarp.org 编辑器标签页。
  // 协议（JSON-RPC 风格）：
  //   扩展 -> 插件: { type:'hello', token, meta }        握手（必须先过这一步）
  //   插件 -> 扩展: { id, op, args }                     op ∈ snapshot | read_script | add_blocks | ...
  //   扩展 -> 插件: { id, ok, result } | { id, ok: false, error }
  //
  // 为什么要 token：WebSocket 不受同源策略约束，用户访问的**任意网页**都能连
  // ws://127.0.0.1:31820。没有认证的话，那个页面可以冒充编辑器（抢占会话）、
  // 伪造 {id, ok:true} 的应答、还能往 watch/event 帧里塞文本 —— 而后者会进
  // scratch_watch / scratch_user_context 的返回值，等于一条写进 agent 上下文的注入通道。
  const sessions = new Map() // sessionId -> { socket, meta, watchEvents, userEvents }
  const cdpHandles = new Map() // sessionId -> CDP 句柄（只有 CDP 直连会话有；卸载时要关掉）
  const pending = new Map() // 请求 id -> { resolve, reject, timer, sessionId }
  const MAX_EVENTS = 500 // 每个会话的 watch/event 队列上限（页面一直开着也不会无限涨）
  let reqSeq = 0
  let sessionSeq = 0

  // 桥 token：$DSH_HOME/scratch-bridge-token.txt，首次启动自动生成。
  // 用户去扩展的选项页填一次即可（扩展把它存 chrome.storage.local）。
  const bridgeTokenFile = join(process.env.DSH_HOME || (homedir() + '/.dsh'), 'scratch-bridge-token.txt')
  let bridgeToken = ''
  let bridgeTokenIsNew = false
  try {
    if (existsSync(bridgeTokenFile)) bridgeToken = readFileSync(bridgeTokenFile, 'utf8').trim()
    if (!bridgeToken) {
      bridgeToken = randomBytes(16).toString('hex')
      mkdirSync(dirname(bridgeTokenFile), { recursive: true })
      writeFileSync(bridgeTokenFile, bridgeToken + '\n')
      bridgeTokenIsNew = true
    }
  } catch (e) {
    bridgeToken = randomBytes(16).toString('hex')
    log.warn('token 落盘失败（本次用临时 token，重启会变）: %s', e.message)
  }
  log.info('桥 token: %s  （首次使用：打开 tw-bridge-extension 的选项页粘进去；文件在 %s）',
    bridgeToken, bridgeTokenFile)

  const rejectedConnections = [] // 最近被拒的连接，用于把"token 填错了"这件事讲清楚
  const RETRY_BRIDGE_MS = 5000 // 端口被占时的重试间隔

  async function startBridge() {
    // Node 22+ 有全局 WebSocket（Undici），但那是客户端；服务端需要 ws 包。
    let WebSocketServer
    try {
      const ws = await import('ws')
      WebSocketServer = ws.default?.WebSocketServer ?? ws.WebSocketServer
    } catch {
      log.warn('ws 包不可用，桥未启动（npm i ws 后重启）')
      return
    }
    // ⚠️ 端口被占**必须重试**，不能一次失败就永久躺平。
    //    真实踩到过：装好插件那一刻，另一个 dsh 实例（或测试残留）正占着 31820，
    //    于是这个实例的桥再也没起来 —— 用户看到的是"扩展明明装好了却怎么也连不上"，
    //    而且没有任何补救入口（插件的桥只在 apply 时起一次）。
    let retryTimer = null
    let attempts = 0
    let lastWantedPort = cfg.bridgePort
    function listen() {
      // 重绑时先把旧监听关掉（端口没变的重入也走这里，交给 error/EADDRINUSE 兜）
      if (activeWss) { try { activeWss.close() } catch {} }
      let wss
      try {
        wss = new WebSocketServer({ host: '127.0.0.1', port: cfg.bridgePort })
      } catch (e) {
        log.error('桥服务创建失败: %s', e.message)
        schedule()
        return
      }
      attach(wss)
      wss.on('listening', () => {
        attempts = 0
        log.info('桥监听 %s:%d（等浏览器扩展连进来）', '127.0.0.1', cfg.bridgePort)
      })
      wss.on('error', (e) => {
        if (e && e.code === 'EADDRINUSE') {
          // 自己人重入（比如同一 profile 被加载两次）也会走到这儿
          log.warn('端口 %d 已被占用，%ds 后重试（另一个 dsh 实例/残留进程占着？）',
            cfg.bridgePort, RETRY_BRIDGE_MS / 1000)
          try { wss.close() } catch {}
          schedule()
          return
        }
        log.error('桥服务出错: %s', e.message)
      })
    }
    function schedule() {
      if (retryTimer) return
      attempts++
      retryTimer = setTimeout(() => { retryTimer = null; listen() }, RETRY_BRIDGE_MS)
      if (retryTimer.unref) retryTimer.unref() // 别因为这个定时器把进程钉住
      if (attempts === 12) log.error('端口 %d 连续 %d 次被占用，桥仍未起来（用户会连不上）', cfg.bridgePort, attempts)
    }
    // dsh 规范：手动资源用 ctx.effect 注册清理（卸载/热替换时自动调用）
    ctx.effect(() => () => {
      clearTimeout(retryTimer)
      try { activeWss && activeWss.close() } catch {}
    })
    // 配置表单里改端口是「volatile 热改」：不重挂插件、不重启 dsh，
    // 所以必须自己盯着端口变化重绑（2s 一次，成本可忽略）。
    const watchPort = setInterval(() => {
      const want = cfg.bridgePort
      if (want === lastWantedPort) return
      lastWantedPort = want
      attempts = 0
      log.info('配置里的桥端口改成 %d，正在重绑监听', want)
      listen()
    }, 2000)
    if (watchPort.unref) watchPort.unref()
    ctx.effect(() => () => clearInterval(watchPort))
    let activeWss = null
    function attach(wss) {
      activeWss = wss
      wss.on('connection', (socket, req) => {
      const id = 'tw-' + (++sessionSeq)
      const peer = (req && req.socket && req.socket.remoteAddress) || '?'
      const origin = (req && req.headers && req.headers.origin) || '(无 Origin)'
      let authed = false
      // 握手超时：10s 内没交对 token 就断
      const authTimer = setTimeout(() => {
        if (!authed) { try { socket.close(4001, 'handshake timeout') } catch {} }
      }, 10000)

      socket.on('message', (raw) => {
        let msg
        try { msg = JSON.parse(String(raw)) } catch { return }

        if (!authed) {
          if (msg.type !== 'hello') {
            try { socket.close(4003, 'hello required') } catch {}
            return
          }
          if (msg.token !== bridgeToken) {
            authed = false
            rejectedConnections.unshift({ at: new Date().toISOString(), peer, origin, hadToken: !!msg.token })
            if (rejectedConnections.length > 10) rejectedConnections.pop()
            log.warn('拒绝未认证连接（%s / Origin: %s）：token %s。正确 token 见上一条日志或 scratch_list_sessions',
              peer, origin, msg.token ? '不匹配' : '缺失')
            try { socket.close(4003, 'bad token') } catch {}
            return
          }
          authed = true
          clearTimeout(authTimer)
          sessions.set(id, { socket, meta: msg.meta || null, watchEvents: [], userEvents: [] })
          try { socket.send(JSON.stringify({ type: 'hello-ack', sessionId: id })) } catch {}
          log.info('编辑器已连接: %s（当前 %d 个会话）Origin=%s', id, sessions.size, origin)
          return
        }

        dispatchClientMessage(id, msg)
      })
      socket.on('close', () => {
        clearTimeout(authTimer)
        dropSession(id, '扩展断开')
      })
      socket.on('error', () => {})
      })
    }
    listen()
  }

  // ---------------- 会话消息分发（扩展的 WS 与 CDP 直连共用同一条路） ----------------
  // 抽出来的原因：CDP 会话（TurboWarp Desktop 等）走的是同一套协议，只是"运输层"
  // 从 WebSocket 换成了 DevTools binding。工具层不需要知道区别。
  function dispatchClientMessage(id, msg) {
    const s = sessions.get(id)
    if (!s) return
    // 扩展的 WebSocket 在 MV3 service worker 里，SW 空闲 ~30s 就会被回收、socket 跟着死。
    // Chrome 116+ 把 WebSocket 的收发算作 SW 的活动，所以这个 pong 是**必须回**的：
    // 不回 = 放任对面掉线。对接方每 20s ping 一次。
    if (msg.type === 'ping') { try { s.socket.send('{"type":"pong"}') } catch {} ; return }
    if (msg.type === 'watch') {
      // M2 观察者：页面侧轮询到的变量变化帧，存队列等 scratch_watch 拉
      s.watchEvents.push(...(msg.changes || []).map(c => Object.assign({ at: msg.at, target: msg.target }, c)))
      if (s.watchEvents.length > MAX_EVENTS) s.watchEvents.splice(0, s.watchEvents.length - MAX_EVENTS)
      return
    }
    if (msg.type === 'event') {
      // M2 双向联动：绿旗等运行事件
      s.userEvents.push(msg)
      if (s.userEvents.length > MAX_EVENTS) s.userEvents.splice(0, s.userEvents.length - MAX_EVENTS)
      return
    }
    if (msg.type === 'hello' || msg.type === 'ready' || msg.type === 'pong') {
      // 允许重发 meta（页面刷新/换标签页后 meta 会变）
      if (msg.meta) s.meta = msg.meta
      return
    }
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)
      // 关键：应答必须来自该请求发往的那个会话，否则就是串答/伪造
      if (p.sessionId !== id) {
        log.warn('忽略来自 %s 的跨会话应答 %s（该请求发往 %s）', id, msg.id, p.sessionId)
        return
      }
      pending.delete(msg.id)
      clearTimeout(p.timer)
      msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error || 'bridge error'))
    }
  }

  /** 会话下线：挂起请求全部拒掉，别让调用方干等超时 */
  function dropSession(id, why = '断开') {
    const s = sessions.get(id)
    if (!s) return
    sessions.delete(id)
    if (s.pingTimer) clearInterval(s.pingTimer)
    if (s.cdp) { try { s.cdp.close() } catch {} ; cdpHandles.delete(id) }
    for (const [reqId, p] of pending) {
      if (p.sessionId === id) {
        clearTimeout(p.timer)
        pending.delete(reqId)
        p.reject(new Error(`会话 ${id} 已断开（请求 ${reqId} 未完成）`))
      }
    }
    log.info('编辑器断开: %s（%s）', id, why)
  }

  // 操作超时按 op 分档。默认 15s 是「改几个块」的量级，但**整项目级**的操作远超它：
  // 真机实测（用户的伊旬园，14.6MB / project.json 7MB）——restore 直接超时，
  // 表现就是"回滚不了自己的作品"。这类操作给足时间，别让用户觉得功能坏了。
  const OP_TIMEOUTS = {
    snapshot: 120000,     // 大项目序列化 project.json
    restore: 300000,      // 把 7MB 的 JSON 灌回 VM
    load_project: 300000, // 解压 + 装载整个 sb3
    save_project: 300000  // 大项目打包成 sb3（含全部资源）
  }
  // 给指定会话发指令，等结果
  function call(sessionId, op, args, timeoutMs = OP_TIMEOUTS[op] || 15000) {
    return new Promise((resolve, reject) => {
      const s = sessions.get(sessionId)
      if (!s) {
        // 会话失效最常见的原因是「那个窗口/标签页已经关了」，不是「用户没装扩展」——
        // 以前这条错误把桌面版用户直接引向装扩展，实测把人带偏了。两条路都写清楚。
        return reject(new Error(
          `会话 ${sessionId} 已不存在（那个编辑器窗口/标签页可能已经被关了，或 dsh 重启过）。`
          + `重新连：① 桌面版 scratch_open_editor({ app: "desktop" })（零安装零 token，通常最快）；`
          + `② 网页版：打开 turbowarp.org/editor 并确认 tw-bridge-extension 已装好、token 已填。`
        ))
      }
      const id = 'r' + (++reqSeq)
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`操作 ${op} 超时`))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer, sessionId })
      try {
        s.socket.send(JSON.stringify({ id, op, args }))
      } catch (e) {
        pending.delete(id)
        clearTimeout(timer)
        reject(new Error(`发送失败（会话可能刚断开）: ${e.message}`))
      }
    })
  }

  const activeSession = () => sessions.size ? [...sessions.keys()][0] : null
  const needSession = (sid) => {
    const id = sid || activeSession()
    if (!id) throw new Error('没有已连接的 TurboWarp 编辑器')
    return id
  }

  // 快照存档（AI 每次写操作前自动调用；三档安全的基础）
  const snapshots = [] // { at, sessionId, label, projectJson, bytes }（内存最近快照，盘上有全量）
  let snapBytes = 0
  // M1 持久化：快照写盘到 $DSH_HOME/scratch-snapshots/（dsh 重启后仍可救）
  // cfg.snapshotsDir 可以把它挪到别的盘（大项目一份 project.json 就 7MB，别都堆系统盘上）
  const snapDir = cfg.snapshotsDir
    ? resolve(String(cfg.snapshotsDir))
    : join(process.env.DSH_HOME || (homedir() + '/.dsh'), 'scratch-snapshots')
  const MAX_SNAP_MEM_MB = Number(cfg.maxSnapshotMemMb) || 64 // 内存里最多留多少 MB 的快照
  const MAX_SNAP_DISK_MB = Number(cfg.maxSnapshotDiskMb) || 256 // 盘上最多留多少 MB
  const snapBytesOf = (pj) => { try { return JSON.stringify(pj).length } catch { return 0 } }
  async function takeSnapshot(sessionId, label) {
    const pj = await call(sessionId, 'snapshot')
    const bytes = snapBytesOf(pj)
    const snap = { at: new Date().toISOString(), sessionId, label, projectJson: pj, bytes }
    snapshots.unshift(snap)
    snapBytes += bytes
    // 两个上限都管：条数（防止小项目刷屏）+ 总字节（防止大项目吃爆内存）
    while (snapshots.length > cfg.maxSnapshots || (snapBytes > MAX_SNAP_MEM_MB * 1024 * 1024 && snapshots.length > 1)) {
      snapBytes -= snapshots.pop().bytes
    }
    // 落盘（失败不阻塞操作，只打日志）
    try {
      mkdirSync(snapDir, { recursive: true })
      const fname = `${sessionId}-${snap.at.replace(/[:.]/g, '-')}-${label}.json`
      writeFileSync(join(snapDir, fname), JSON.stringify(snap))
      // 清理：条数上限（maxSnapshots*2）或总字节上限（MAX_SNAP_DISK_MB）任一超了就删最旧的。
      // 用 `${sessionId}-` 而不是裸 sessionId：否则 tw-1 会把 tw-10 的快照算进来
      const files = readdirSync(snapDir).filter(f => f.startsWith(sessionId + '-')).sort()
      const sizeOf = (f) => { try { return statSync(join(snapDir, f)).size } catch { return 0 } }
      let total = files.reduce((n, f) => n + sizeOf(f), 0)
      while (files.length > cfg.maxSnapshots * 2 || (total > MAX_SNAP_DISK_MB * 1024 * 1024 && files.length > 1)) {
        const victim = files.shift()
        total -= sizeOf(victim)
        unlinkSync(join(snapDir, victim))
      }
    } catch (e) {
      log.warn('快照落盘失败（不影响运行）: %s', e.message)
    }
    return snap
  }
  // dsh 重启后内存空了：rollback 回退到读盘上该会话最近的快照
  async function findSnapshot(sessionId, index = 0) {
    if (snapshots.length) {
      const list = snapshots.filter(s => s.sessionId === sessionId)
      if (list[index]) return list[index]
    }
    try {
      const files = readdirSync(snapDir).filter(f => f.startsWith(sessionId + '-')).sort().reverse()
      if (files[index]) {
        return JSON.parse(readFileSync(join(snapDir, files[index]), 'utf8'))
      }
    } catch { /* 目录还没有就算了 */ }
    return null
  }

  // ---------------- 三档安全（对所有写操作生效，不只是 add_blocks） ----------------
  // auto    ：先快照再落项目
  // preview ：不落项目，把 plan 返回给 AI 展示给用户；用户点头后调 scratch_apply({planId})
  // suggest ：只把 plan 当建议给用户，连 apply 都不提供
  const pendingPlans = new Map() // planId -> { sessionId, op, args, label, at }
  const MAX_PLANS = 20
  let planSeq = 0

  function stagePlan(sessionId, op, args, label, preview) {
    const planId = 'p' + (++planSeq)
    pendingPlans.set(planId, { sessionId, op, args, label, at: new Date().toISOString() })
    while (pendingPlans.size > MAX_PLANS) pendingPlans.delete(pendingPlans.keys().next().value)
    return {
      mode: 'preview',
      planId,
      plan: { op, args },
      preview,
      hint: `当前为 preview 档，项目**尚未**改动。把 plan/preview 给用户确认，用户同意后调 scratch_apply({ planId: "${planId}" }) 落盘。`
    }
  }

  async function executePlan(plan) {
    const snap = await takeSnapshot(plan.sessionId, plan.label)
    const r = await call(plan.sessionId, plan.op, plan.args)
    return Object.assign({ snapshotAt: snap.at, label: plan.label }, r)
  }

  async function guardedWrite(sessionId, op, args, label, preview) {
    const safety = cfg.safety || 'preview'
    if (safety === 'suggest') {
      return { mode: 'suggest', hint: '当前为 suggest 档：只把改动作为建议交给用户，不落项目。', plan: { op, args }, preview }
    }
    if (safety === 'preview') return stagePlan(sessionId, op, args, label, preview)
    return executePlan({ sessionId, op, args, label })
  }

  // ---------------- Skill 区：Scratch 实践经验库 ----------------
  // 内置 skill（插件包 skills/ 目录）首启时复制到 $DSH_HOME/scratch-skills/，
  // 之后 agent/用户自由编辑，插件升级不覆盖（除非带 .reset 标记）。
  // 开关三层：cfg.skillsEnabled（总闸）→ .enabled.json（单文件开关）→ agent 自主选读。
  const skillDir = join(process.env.DSH_HOME || (homedir() + '/.dsh'), 'scratch-skills')
  const builtinSkillDir = join(dirname(fileURLToPath(import.meta.url)), 'skills')
  const skillStateFile = join(skillDir, '.enabled.json')
  const builtinVersionFile = join(skillDir, '.builtin-version')
  const SKILL_BUILTIN_VERSION = '2' // 升级内置 skill 时 bump（2 = 去掉块数普查、只留做法）

  function skillEnabledMap() {
    try { return JSON.parse(readFileSync(skillStateFile, 'utf8')) } catch { return {} }
  }
  function isSkillOn(name) {
    const map = skillEnabledMap()
    return map[name] !== false // 缺省 = 开
  }
  function initSkillDir() {
    try {
      mkdirSync(skillDir, { recursive: true })
      // 首次（或版本升级）：复制内置 skill，**不动已存在的**（用户/agent 可能改过）。
      // 想强制回到内置版本：在 skill 目录里放一个 `.reset` 空文件，下次加载就整份覆盖
      // （插件升级后内置文档会更新，但按契约不覆盖用户改过的版本 —— 这个标记是那个出口）。
      let ver = ''
      try { ver = readFileSync(builtinVersionFile, 'utf8').trim() } catch {}
      const resetMark = join(skillDir, '.reset')
      const force = existsSync(resetMark)
      if ((ver !== SKILL_BUILTIN_VERSION || force) && existsSync(builtinSkillDir)) {
        let copied = 0
        for (const f of readdirSync(builtinSkillDir)) {
          if (!f.endsWith('.md')) continue
          const dst = join(skillDir, f)
          if (force || !existsSync(dst)) { copyFileSync(join(builtinSkillDir, f), dst); copied++ }
        }
        writeFileSync(builtinVersionFile, SKILL_BUILTIN_VERSION)
        if (force) {
          try { unlinkSync(resetMark) } catch {}
          log.info('skill 区已按 .reset 标记重置（覆盖 %d 篇内置文档）', copied)
        }
      }
    } catch (e) {
      log.warn('skill 区初始化失败（不影响核心功能）: %s', e.message)
    }
  }
  function skillSummary(name, content) {
    // 从 frontmatter 之后的第一行抓标题与「什么时候读」
    const m = content.match(/^# (.+)$/m)
    const w = content.match(/适用场景[：:] *(.+)$/m) || content.match(/> 适用场景[：:] *(.+)$/m)
    return { title: m ? m[1] : name, when: w ? w[1].slice(0, 80) : '' }
  }
  function listSkills() {
    initSkillDir()
    const out = []
    try {
      for (const f of readdirSync(skillDir)) {
        if (!f.endsWith('.md')) continue
        const content = readFileSync(join(skillDir, f), 'utf8')
        const s = skillSummary(f, content)
        out.push({ name: f, on: isSkillOn(f), lines: content.split('\n').length, ...s })
      }
    } catch { /* 空目录 */ }
    return out
  }

  // ---------------- 主动唤起编辑器 ----------------
  // 用户说「打开 TurboWarp」时，AI 不该只会说"请你自己去开"。这里给两条路：
  //   browser（默认）→ 打开 turbowarp.org/editor，走**浏览器扩展**那条路（用户要装扩展 + 填 token）。
  //   desktop        → 起本地 TurboWarp Desktop（Electron），走 **CDP 直连**那条路（零安装、零 token）。
  // ⚠️ Desktop 装不了浏览器扩展（它只有自己的 userscript addon 系统，实测 app.asar 里
  //    没有任何 session.loadExtension 调用），所以扩展那条路对它无解；但它接受
  //    --remote-debugging-port，默认执行上下文里就有 window.vm，于是 cdp.js 能把同一份页面
  //    执行器注进去直接驱动它（2026-10-17 真机打通：lab/desktop-cdp-check.mjs 54/54）。
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const EDITOR_URL = 'https://turbowarp.org/editor'
  const DESKTOP_DOWNLOAD = 'https://desktop.turbowarp.org/'
  // 桌面版的「可接管」固定调试端口：仓库里的 `启动TurboWarp(AI可接管).cmd` 用这个端口启动，
  // 插件每次 app=desktop 都会先探它 —— 于是**用户自己开的窗口**也能被 AI 接管（不用 AI 再开一个）。
  // 想换端口：插件配置 desktopDebugPort。
  const DESKTOP_DEBUG_PORT = 31821

  /** 找本地 TurboWarp Desktop：配置 > 环境变量 > 注册表卸载项 > 常见路径 */
  function findDesktopApp() {
    const tried = []
    const push = (p) => { if (p) tried.push(p); return p }
    const cands = [
      push(cfg.desktopPath),
      push(process.env.TURBOWARP_DESKTOP),
      push(join(process.env.LOCALAPPDATA || '', 'Programs', 'TurboWarp', 'TurboWarp.exe')),
      push(join(process.env['ProgramFiles'] || '', 'TurboWarp', 'TurboWarp.exe')),
      push(join(process.env['ProgramFiles(x86)'] || '', 'TurboWarp', 'TurboWarp.exe'))
    ]
    for (const p of cands) { if (p && existsSync(p)) return { path: p, via: 'path', tried } }
    // 注册表：安装到自定义目录（比如 G 盘）时只有这里知道装在哪
    if (process.platform === 'win32') {
      try {
        const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/v', 'DisplayIcon'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
        for (const line of out.split(/\r?\n/)) {
          const m = line.match(/REG_SZ\s+(.+?TurboWarp\.exe)/i)
          if (m) {
            const p = m[1].replace(/^"|"$/g, '').replace(/,\d+$/, '')
            if (!tried.includes(p)) tried.push(p)
            if (existsSync(p)) return { path: p, via: 'registry', tried }
          }
        }
      } catch { /* 没有注册表项就算了 */ }
    }
    return { path: null, via: null, tried }
  }

  /** 数一下这个可执行文件已经起了几个进程（Windows 用 tasklist，类 Unix 用 pgrep） */
  function countRunning(exePath) {
    const exeName = exePath.split(/[\\/]/).pop()
    try {
      if (process.platform === 'win32') {
        // 没有匹配时 tasklist 只打一行"没有运行的任务匹配指定标准"，按名字过滤后自然是 0
        const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${exeName}`, '/NH', '/FO', 'CSV'],
          { encoding: 'utf8', windowsHide: true, timeout: 5000 })
        return out.split(/\r?\n/).filter(l => l.toLowerCase().includes(exeName.toLowerCase())).length
      }
      const out = execFileSync('pgrep', ['-f', exePath], { encoding: 'utf8', timeout: 5000 })
      return out.split('\n').filter(Boolean).length
    } catch { return 0 }
  }

  /**
   * 起一个分离进程（不阻塞、不弹控制台）。
   * ⚠️ `windowsHide` 只该用给 **控制台**（.cmd/.bat、cmd /c start）——
   *    对 GUI 程序（TurboWarp.exe / chrome.exe）带上它，窗口会以 SW_HIDE 状态被创建：
   *    进程在、CDP 连得上、积木也改得了，但用户屏幕上什么都看不到。
   *    真机踩过（窗口 vis=False、rect 明明在屏幕内、任务栏没图标），A/B 验过：
   *    同一条命令去掉这个字段就正常显示。
   */
  function spawnDetached(cmd, args, { hide = false } = {}) {
    const isBatch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd)
    const realCmd = isBatch ? 'cmd.exe' : cmd
    const realArgs = isBatch ? ['/c', cmd, ...args] : args
    const child = spawn(realCmd, realArgs, { detached: true, stdio: 'ignore', windowsHide: hide })
    child.on('error', () => {}) // 失败靠调用方超时兜底，别让未处理的 error 崩掉插件
    child.unref()
    return child.pid
  }

  /** 打开外部目标。cfg.browserPath 可指定浏览器（Windows 下也接受 .cmd/.bat 包装脚本） */
  function openTarget(target, kind) {
    if (kind === 'desktop') return spawnDetached(target, [])
    const exe = cfg.browserPath
    if (exe) return spawnDetached(exe, [target])
    // `start` 只是个启动器：这里藏掉的是它自己的控制台，被启动的浏览器照常显示
    if (process.platform === 'win32') return spawnDetached('cmd.exe', ['/c', 'start', '', target], { hide: true })
    if (process.platform === 'darwin') return spawnDetached('open', [target])
    return spawnDetached('xdg-open', [target])
  }

  // ---------------- 窗口可见性（Win32，Windows only，失败静默） ----------------
  // 为什么插件自己要看窗口：桌面版可能被以隐藏状态拉起（见 spawnDetached 注释），而
  // `MainWindowHandle`、`document.visibilityState` 都**查不出来**（前者隐藏态恒为 0，
  // 后者在 Electron 里照样是 visible）。唯一可靠的是 EnumWindows + IsWindowVisible，
  // 所以这里调 win32-window.ps1（附带 ShowWindow 修复）。
  const WIN32_PROBE = join(dirname(fileURLToPath(import.meta.url)), 'win32-window.ps1')
  let win32Unavailable = false
  function desktopWindowInfo({ pid, show = false } = {}) {
    if (process.platform !== 'win32' || win32Unavailable || !existsSync(WIN32_PROBE)) return null
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WIN32_PROBE]
    if (pid) args.push('-TargetPid', String(pid))
    else args.push('-ImageName', 'TurboWarp')
    if (show) args.push('-Show')
    try {
      const out = execFileSync('powershell', args, { encoding: 'utf8', timeout: 8000, windowsHide: true })
      const list = JSON.parse(out.trim() || '[]')
      const main = list.filter((w) => w && w.cls === 'Chrome_WidgetWin_1' && w.title)
      const winner = main.find((w) => /TurboWarp/i.test(w.title)) || main[0]
      return winner || null
    } catch (e) {
      // 只报一次：沙箱里 powershell 可能起不来，不该每条日志都刷
      if (!win32Unavailable) {
        win32Unavailable = true
        log.warn('查不了窗口可见性（powershell 调不起来：%s）；不影响读写积木，只是看不到「窗口是否显示」', e.message)
      }
      return null
    }
  }

  /** 没会话时给 AI 的「怎么让用户接上」信息包（list_sessions 和 open_editor 共用） */
  function setupPayload() {
    return {
      // 两条路一起给：桌面版通常最快（零安装零 token），网页版适合用户本来就在浏览器里改
      firstChoice: '最快：scratch_open_editor({ app: "desktop", path: "作品.sb3" }) —— 零安装、零 token，'
        + '我直接连本机 TurboWarp Desktop（CDP 直连），读写积木、存盘都能干。本机没装桌面版再看下面那条。',
      webVersion: `网页版：Chrome/Edge 打开 chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选 packages/tw-bridge-extension`
        + `；然后点扩展「详情 → 扩展程序选项」把 token 粘进去（${bridgeToken}）；再打开 https://turbowarp.org/editor 。`,
      token: bridgeToken,
      tokenFile: bridgeTokenFile,
      tokenIsNew: bridgeTokenIsNew || undefined,
      step1: '（只有网页版这条路需要扩展）chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → packages/tw-bridge-extension',
      step2: `点扩展的「详情 → 扩展程序选项」，把 token 粘进去保存：${bridgeToken}`,
      step3: '打开 https://turbowarp.org/editor ，F12 应看到 [dsh-bridge] connected & authenticated',
      // 零安装的那条路：本机有 TurboWarp Desktop 就用它，不需要扩展也不需要 token
      easierAlternative: '用户想自己开窗口也行 —— 用仓库里的「启动TurboWarp(AI可接管).cmd」启动（带固定调试端口 31821），'
        + '我照样能接管他开的那份（scratch_open_editor({ app: "desktop" }) 会先探这个端口）',
      recentRejected: rejectedConnections.length ? rejectedConnections : undefined
    }
  }

  // ---------------- CDP 直连：不需要扩展的第二种会话 ----------------
  // 执行器源码 = 扩展用的那份 content-main.js 的同步副本（lab/sync-executor.mjs 保证一致，
  // test-tools.mjs 有逐字节断言）。CDP 会话把它注进编辑器进程的默认上下文即可。
  const executorPath = join(dirname(fileURLToPath(import.meta.url)), 'vm-executor.js')
  let executorSource = ''
  try {
    executorSource = readFileSync(executorPath, 'utf8')
  } catch (e) {
    log.warn('vm-executor.js 读不到，CDP 直连（桌面版那条路）不可用：%s', e.message)
  }

  /**
   * 把一个已连上的 CDP 端点注册成**普通会话**：19 个工具全都照常工作，无需改工具层。
   * 会话的 socket 接口只需要一个 send(text) —— 正好对上 call() 的用法。
   */
  async function registerCdpSession(handle, meta, { waitPongMs = 4000 } = {}) {
    const id = 'cd-' + (++sessionSeq)
    const session = {
      // 复用 call() 的发送接口。tagForPage 补的是"扩展路径里 relay/SW 那层"干的活：
      // 给 op 消息贴 __dshBridgeRelay 标签（少了它页面执行器不认，op 会全部超时）。
      socket: { send: (text) => handle.deliver(tagForPage(text)) },
      meta: Object.assign({ transport: 'cdp', kind: 'desktop' }, meta),
      watchEvents: [], userEvents: [], cdp: handle
    }
    sessions.set(id, session)
    cdpHandles.set(id, handle)
    const push = (obj) => { try { handle.deliver(JSON.stringify(obj)) } catch { /* 断线由 close 事件兜 */ } }
    // 页面执行器要知道"可以往外推帧了"（扩展路径里这条由 SW 发；这里由我们发）
    // via:'cdp' 让页面自报状态时说清"谁在跟我说话"（否则它会一直自称 transport=sw）
    push({ __dshBridgeRelay: 'link', ok: true, tokenSet: true, via: 'cdp' })
    // 心跳：既是保活，也是"页面还活着吗"的探针（页面收到 ping 必回 pong）
    session.pingTimer = setInterval(() => push({ __dshBridgeRelay: 'ping' }), 20000)
    if (session.pingTimer.unref) session.pingTimer.unref()
    push({ __dshBridgeRelay: 'ping' })
    const deadline = Date.now() + waitPongMs
    while (Date.now() < deadline && !(handle.raw && handle.raw.pongs > 0)) await sleep(100)
    session.pageResponded = !!(handle.raw && handle.raw.pongs > 0)
    log.info('CDP 会话已注册: %s（%s，页面应答=%s）', id, handle.target && handle.target.url, session.pageResponded)
    return id
  }

  // 插件卸载/热替换时把 CDP 通道关掉（编辑器进程本身不动 —— 那是用户的窗口）
  ctx.effect(() => () => {
    for (const [, h] of cdpHandles) { try { h.close() } catch {} }
    cdpHandles.clear()
  })

  /**
   * 连上一个 CDP 端点 → 注册成会话 → 等编辑器就绪 →（可选）装入作品 → 组装返回值。
   * 「AI 自己开的桌面版」和「用户自己开的可接管实例」两条路共用这一段。
   */
  async function cdpAttachAndReport({ port, launched, wantPath, waitMs = 20000 }) {
    // 等 CDP 的时间用 waitMs 兜住（桌面版冷启动实测 2-6s；waitMs=0 表示"别等"，
    // 但还是给 3s —— 完全不试就下结论没有意义）
    const cdpTimeoutMs = waitMs === 0 ? 3000 : Math.max(waitMs, 5000)
    let sid = null
    let handle = null
    try {
      handle = await attachCdp({
        port,
        executorSource,
        timeoutMs: cdpTimeoutMs,
        log: (m) => log.info('CDP: %s', m),
        onMessage: (msg) => { if (sid) dispatchClientMessage(sid, msg) },
        onClose: () => { if (sid) dropSession(sid, 'CDP 通道关闭（桌面版被关了？）') }
      })
      sid = await registerCdpSession(handle, {
        app: 'TurboWarp Desktop',
        url: handle.target && handle.target.url,
        debugPort: port
      })
      const sess = sessions.get(sid)
      // 记下进程/端口：后面查窗口可见性（list_sessions / 再次 open_editor）都要用
      if (sess) {
        if (launched.pid) sess.meta.pid = launched.pid
        sess.meta.debugPort = port
      }
      // ⚠️ 桌面版冷启动是"GUI 先出来、项目后加载"：刚接上时 vm 里可能**一个角色都没有**。
      //    这时候回报"就绪"会误导 AI 往不存在的角色里塞积木（真机踩过）。所以等 vm 里
      //    真有角色了再回报 ready（上限也用 waitMs 兜住）。
      let meta = null
      const readyDeadline = Date.now() + Math.max(cdpTimeoutMs, 8000)
      while (Date.now() < readyDeadline) {
        meta = await call(sid, 'project_meta').catch((e) => ({ error: e.message }))
        if (meta && Array.isArray(meta.targets) && meta.targets.length) break
        await sleep(500)
      }
      const ready = !!(meta && Array.isArray(meta.targets) && meta.targets.length)
      const out = {
        launched,
        connected: true,
        transport: 'cdp-desktop', // 零安装那套：没有扩展、没有 token
        sessionId: sid,
        pageResponded: !!(sess && sess.pageResponded),
        ready,
        targets: meta && meta.targets,
        editingTarget: meta && (meta.editingTarget || meta.target),
        target: handle.target && handle.target.url,
        meta,
        path: wantPath || undefined
      }
      // 窗口可见性：连上了 ≠ 用户看得见。隐藏态会自动 ShowWindow 救回来，
      // 并把「救之前/之后」都报出来（AI 一开始就能跟用户说清楚，而不是陪他猜）。
      const before = desktopWindowInfo({ pid: launched.pid, show: false })
      if (before) {
        sess.window = before
        out.window = before
        if (!before.visible || before.minimized) {
          const after = desktopWindowInfo({ pid: before.pid, show: true })
          if (after) {
            sess.window = after
            out.window = after
            out.windowRepair = !before.visible
              ? (after.visible
                  ? '窗口原本是**隐藏的**（EnumWindows: visible=false），已调 ShowWindow 显示出来'
                  : '窗口原本是隐藏的，ShowWindow 没救回来 —— 让用户看任务栏/按 Alt+Tab 找「TurboWarp Desktop」')
              : (after.minimized ? '窗口是最小化的，ShowWindow 还原也没成功' : '窗口原本是最小化的，已还原并置前')
            if (!after.visible) out.windowHidden = true
          }
        }
      }
      if (wantPath) {
        try { out.loaded = await loadFileIntoSess(sid, wantPath) } catch (e) { out.loadError = e.message }
      }
      out.hint = ready
        ? (launched.attached
            ? '已经接上**用户自己开的**那份桌面版（CDP 直连，没动他的窗口）：可以直接 scratch_snapshot / scratch_read_script / scratch_add_blocks 干活。'
            : '桌面版已经接上了（CDP 直连）：可以直接 scratch_snapshot / scratch_read_script / scratch_add_blocks 干活，')
          + '改完用 scratch_save_project 存盘（默认不覆盖原文件）。'
        : '桌面版接上了，但编辑器里**还没有项目/角色**（冷启动时 GUI 先出来、项目后加载）。'
          + '等一下再调 scratch_list_sessions 看，或者让用户在桌面版里新建一个作品。'
      return out
    } catch (e) {
      // 接不上就把 CDP 通道关掉，别留一条半死的连接（桌面版窗口本身不动，那是用户的窗口）
      if (handle) { try { handle.close() } catch {} }
      return {
        launched,
        connected: false,
        error: e.message,
        hint: (launched.attached
          ? '那个端口上确实有个 CDP 端点，但接不上（可能不是 TurboWarp 的编辑器页）。'
          : '桌面版启动了但 CDP 没接上（可能刚启动就退出 / 调试端口没起来）。')
          + '可以再试一次，或改用 app=browser（浏览器扩展那条路）。'
      }
    }
  }

  // ---------------- 工具注册（defineTool 官方格式） ----------------

  ctx.tools.register(defineTool({
    name: 'scratch_list_sessions',
    description: '列出已连接的 TurboWarp 编辑器标签页：项目名、精灵列表、已启用扩展。没有已连接会话时，会返回桥的 token 和连接步骤（用户首次配置要用）。',
    parameters: {},
    output: jsonOut,
    async execute() {
      if (!sessions.size) {
        return {
          sessions: [],
          // 没有会话时把首次配置需要的东西一次性给全，AI 可以直接照着念给用户
          setup: setupPayload(),
          hint: '两条路：① 最快 scratch_open_editor({ app: "desktop", path }) —— 零安装零 token，直接连本机 TurboWarp Desktop；'
            + '② 网页版要先装 tw-bridge-extension 并填 token（见 setup.webVersion）。'
        }
      }
      const list = []
      for (const [id, s] of sessions) {
        const meta = await call(id, 'project_meta').catch(() => null)
        const entry = { sessionId: id, meta: s.meta, detail: meta }
        // 连上了 ≠ 用户看得见：桌面版会话顺手查一次窗口可见性（约 0.3-0.6s，只在这条路上查）
        if (s.cdp) {
          const win = desktopWindowInfo({ pid: s.meta && s.meta.pid, show: false })
          if (win) {
            s.window = win
            entry.window = win
            if (!win.visible) {
              entry.windowHint = '窗口在屏幕上**不可见**（EnumWindows: visible=false）—— 用户看不到编辑器不是错觉。'
                + '再调一次 scratch_open_editor({ app: "desktop" }) 会顺手 ShowWindow 把它显示出来。'
            } else if (win.minimized) {
              entry.windowHint = '窗口是最小化的'
            }
          }
        }
        list.push(entry)
      }
      // 轻提示：skill 区存在（不注入内容，agent 自主决定是否读）
      const skills = cfg.skillsEnabled === false ? null : listSkills()
      return { sessions: list, skillHint: skills && skills.length ? `有 ${skills.length} 篇 Scratch 实践经验可用（scratch_skills list，不强制）` : null }
    }
  }))

  /** 把一个本机作品文件装进指定会话（scratch_open_editor(path) 与 scratch_load_project 共用） */
  async function loadFileIntoSess(sid, filePath) {
    const p = resolve(String(filePath))
    if (!existsSync(p)) throw new Error(`文件不存在：${p}`)
    const st = statSync(p)
    if (!st.isFile()) throw new Error(`不是文件：${p}`)
    const MAX_MB = 200
    if (st.size > MAX_MB * 1024 * 1024) throw new Error(`文件太大（${(st.size / 1048576).toFixed(1)}MB > ${MAX_MB}MB），浏览器端解压会卡死`)
    const buf = readFileSync(p)
    const head = buf.subarray(0, 1).toString('utf8')
    const isJson = /\.json$/i.test(p) || head === '{'
    // 先快照：开文件是破坏性操作（顶掉当前项目），后悔药必须有
    const snap = await takeSnapshot(sid, 'pre-load_project')
    let r
    if (isJson) {
      let parsed
      try { parsed = JSON.parse(buf.toString('utf8')) } catch (e) { throw new Error(`project.json 解析失败：${e.message}`) }
      r = await call(sid, 'load_project', { projectJson: parsed, filename: basename(p) }, 60000)
    } else {
      r = await call(sid, 'load_project', { sb3Base64: buf.toString('base64'), filename: basename(p) }, 120000)
    }
    return Object.assign({
      loadedFrom: p,
      bytes: st.size,
      format: isJson ? 'json' : 'sb3',
      snapshotAt: snap.at
    }, r)
  }

  ctx.tools.register(defineTool({
    name: 'scratch_open_editor',
    description: '帮用户把 TurboWarp 打开、并把作品装进去 —— 「AI 帮我打开我的作品」就是这一条。'
      + '两条路：app=browser（默认）打开 turbowarp.org/editor，走**浏览器扩展**那套（用户要装扩展 + 填 token），装好后 AI 能读写积木；'
      + 'app=desktop 启动本机 TurboWarp Desktop，走 **CDP 直连**那套（零安装、零 token，我给进程带上调试端口后直接驱动它），AI 一样能读写里面的积木；'
      + '已经在跑的那份桌面版没带调试端口，接不进去，会如实告诉你，并给出重启的办法。'
      + 'path 传 .sb3 / .sb2 / project.json 绝对路径就顺手把作品打开（等于用户手动拖文件进去）；'
      + '已经有会话时不重复开，直接把文件装进那个会话。'
      + '不传 path 只开编辑器也行。返回值里的 connected / transport 是结论，别自己猜。',
    parameters: {
      app: { type: 'string', description: 'browser（默认，扩展那条路）| desktop（CDP 直连，零安装）' },
      path: { type: 'string', description: '要打开的作品文件绝对路径（.sb3/.sb2/project.json），可选' },
      url: { type: 'string', description: 'app=browser 时要打开的地址（默认 https://turbowarp.org/editor，也可以传具体作品链接）' },
      waitMs: { type: 'number', description: '打开后等多久看会话连上，默认 20000，上限 60000' },
      force: { type: 'boolean', description: '已经有会话 / 桌面版已在运行时，照样再开一个' }
    },
    output: jsonOut,
    async execute(args) {
      const app = String(args?.app || 'browser').toLowerCase()
      const wantPath = args?.path ? resolve(String(args.path)) : null
      if (wantPath && !existsSync(wantPath)) throw new Error(`文件不存在：${wantPath}`)

      // 已经有会话：不重复开窗口，直接把文件装进现有会话（这才是用户要的效果）
      if (sessions.size && !args?.force) {
        const sid = activeSession()
        const out = { alreadyConnected: true, sessionId: sid, sessions: [...sessions.keys()], path: wantPath || undefined }
        // 顺带确认一下"用户到底看得到窗口吗"（桌面版会话才有；隐藏态直接救回来）
        const sess = sessions.get(sid)
        if (sess && sess.cdp) {
          const win = desktopWindowInfo({ pid: sess.meta && sess.meta.pid, show: true })
          if (win) {
            sess.window = win
            out.window = win
            if (!win.visible) out.windowHint = '窗口在屏幕上不可见，ShowWindow 也没救回来 —— 让用户看任务栏 / Alt+Tab 找「TurboWarp Desktop」'
          }
        }
        if (wantPath) {
          try { out.loaded = await loadFileIntoSess(sid, wantPath) } catch (e) { out.loadError = e.message }
        }
        out.hint = wantPath
          ? (out.loaded ? '已经装进现有编辑器了（想开新窗口就传 force: true）' : '装文件失败，看 loadError（想开新窗口就传 force: true）')
          : '已经有连着的编辑器了，直接干活就行（想再开一个就传 force: true）'
        return out
      }
      const waitMs = Math.min(Math.max(Number(args?.waitMs ?? 20000) || 0, 0), 60000)

      // ============ 桌面版：CDP 直连（不需要扩展，也不需要 token） ============
      if (app === 'desktop') {
        const found = findDesktopApp()
        // 先看"固定调试端口"上有没有一个现成的可接管实例 —— 用户可以用仓库里的
        // `启动TurboWarp(AI可接管).cmd` 自己开一份（那条启动命令带 --remote-debugging-port=31821），
        // 之后 AI 就能直接接管**用户自己开的那份**，而不是非要 AI 再开一个窗口。
        const probePort = Number(cfg.desktopDebugPort) || DESKTOP_DEBUG_PORT
        const existing = await probeCdp(probePort)
        if (existing.ok) {
          log.info('发现可接管的桌面版实例（调试端口 %d：%s）', probePort, existing.browser)
          return await cdpAttachAndReport({
            port: probePort,
            launched: { app, attached: true, via: 'existing-debug-port', debugPort: probePort, browser: existing.browser },
            wantPath,
            waitMs
          })
        }
        if (!found.path) {
          return {
            launched: { app, ok: false },
            connected: false,
            desktopNotFound: true,
            triedPaths: found.tried,
            hint: `本地没找到 TurboWarp Desktop。可以让用户去 ${DESKTOP_DOWNLOAD} 下载（Windows 选 Setup x64），`
              + '或者把安装路径写进插件配置 desktopPath。'
              + '不想装桌面版就用 app=browser（需要浏览器扩展）。'
          }
        }
        if (!executorSource) {
          return {
            launched: { app, ok: false, path: found.path },
            connected: false,
            error: '插件的 vm-executor.js 缺失，CDP 直连不可用',
            hint: '在仓库里跑 `node lab/sync-executor.mjs` 同步执行器，或改用 app=browser'
          }
        }
        const running = countRunning(found.path)
        if (running > 0 && !args?.force) {
          // 已经在跑的那份是**没有**调试端口的进程，我们没法给运行中的进程补启动参数
          return {
            launched: { app, path: found.path, via: found.via, skipped: true },
            alreadyRunning: true,
            runningProcesses: running,
            connected: false,
            why: 'TurboWarp Desktop 已经在运行，而且那份没带 --remote-debugging-port，CDP 接不进去。',
            hint: '三个办法：1) 让用户先存盘、关掉桌面版，再调一次这个工具（我启动时会带调试端口，之后 AI 就能直接读写它）；'
              + `想让我直接接管就传 force: true —— 注意会先关掉现有窗口，**未保存的改动会丢**，务必先让用户存盘。`
              + ` 2) 让用户以后改用仓库里的「启动TurboWarp(AI可接管).cmd」（= 带 --remote-debugging-port=${probePort} 启动），`
              + '这样他自己开的窗口我也能直接接管。 3) 改用网页版 app=browser。'
          }
        }
        if (running > 0 && args?.force) {
          // 用户明确要求接管：先关掉那份没有调试端口的旧窗口，再带调试端口开一份。
          // ⚠️ 这是**破坏性**动作（未保存的改动会丢），所以只在 force=true 时做，
          //    而且工具的 description/hint 里必须讲清楚。
          const exeName = basename(found.path)
          try { execFileSync('taskkill', ['/IM', exeName, '/F'], { stdio: 'ignore', windowsHide: true }) } catch {}
          for (let i = 0; i < 20 && countRunning(found.path) > 0; i++) await sleep(300)
        }
        const port = await findFreePort()
        const launched = { app, path: found.path, via: found.via, debugPort: port }
        try { launched.pid = spawnDetached(found.path, [`--remote-debugging-port=${port}`]) } catch (e) { launched.error = e.message }
        return await cdpAttachAndReport({ port, launched, wantPath, waitMs })
      }

      // ============ 浏览器版：扩展那条路 ============
      const url = String(args?.url || EDITOR_URL)
      if (!/^https?:\/\//i.test(url)) {
        throw new Error(`只允许 http/https 地址，收到：${url}`)
      }
      const launched = { app, url }
      let error = null
      try { launched.pid = openTarget(url, 'browser') } catch (e) { error = e.message }

      // 等会话连上（浏览器冷启动 + 编辑器加载 + 扩展握手，真机实测十几秒是常态）
      const deadline = Date.now() + waitMs
      while (Date.now() < deadline && !sessions.size) await sleep(400)
      const connected = sessions.size > 0
      const out = Object.assign({
        launched,
        connected,
        transport: connected ? 'extension-bridge' : undefined,
        sessions: [...sessions.keys()],
        path: wantPath || undefined,
        waitedMs: waitMs - Math.max(0, deadline - Date.now())
      }, connected
        ? { hint: '编辑器已连上，可以直接 scratch_snapshot 看项目了' }
        : {
            error,
            setup: setupPayload(),
            hint: '已经帮用户把 turbowarp.org 打开了，但桥还没连上：要么扩展没装，要么 token 没填。'
              + '把 setup 里的步骤念给用户（token 一定要原样给出），填完不用刷新页面，几秒内会自己连上——可以再调一次 scratch_list_sessions 确认。'
              + '（不想装扩展就走 setup.easierAlternative：桌面版 + CDP 直连）'
          })
      if (connected && wantPath) {
        try { out.loaded = await loadFileIntoSess(activeSession(), wantPath) } catch (e) { out.loadError = e.message }
      }
      return out
    }
  }))

  ctx.tools.register(defineTool({
    name: 'scratch_load_project',
    description: '把**本机上**的 .sb3 / .sb2 / project.json 打开到编辑器里（等于用户手动拖文件进去）。'
      + '用户说「打开我的作品 / 改改我这个 sb3」时用这个，别让他自己去拖。'
      + '打开前会自动快照（可 scratch_rollback），但会**顶掉编辑器里当前的项目**（未保存的改动会没），'
      + '所以对着用户已有的项目操作前先确认一下他要不要留。',
    parameters: {
      session: { type: 'string' },
      path: { type: 'string', required: true, description: '.sb3 / .sb2 / project.json 的绝对路径' }
    },
    output: jsonOut,
    async execute(args) {
      const sid = needSession(args?.session)
      if (!args?.path) throw new Error('path 必填（要打开的 .sb3 绝对路径）')
      const r = await loadFileIntoSess(sid, String(args.path))
      return Object.assign({
        hint: '已经打开在编辑器里了。改完记得 scratch_save_project 存回磁盘（默认不会覆盖原文件）。'
      }, r)
    }
  }))

  ctx.tools.register(defineTool({
    name: 'scratch_save_project',
    description: '把编辑器里的项目**存成 .sb3 文件**（用户说「保存 / 导出 / 存一份」时用）。'
      + '默认**不覆盖**已有文件——会写到同目录的 xxx-ai-时间戳.sb3，想覆盖原文件得显式 overwrite: true。',
    parameters: {
      session: { type: 'string' },
      path: { type: 'string', required: true, description: '要写到的绝对路径（.sb3）' },
      overwrite: { type: 'boolean', description: '目标文件已存在时是否覆盖（默认 false，会另存为 xxx-ai-时间戳.sb3）' }
    },
    output: jsonOut,
    async execute(args) {
      const sid = needSession(args?.session)
      if (!args?.path) throw new Error('path 必填（要写到哪里）')
      let target = resolve(String(args.path))
      if (!/\.sb3$/i.test(target)) target += '.sb3'
      const r = await call(sid, 'save_project', {}, 180000) // 大项目序列化 + base64 要时间
      if (!r || !r.sb3Base64) throw new Error('扩展没回传 sb3 字节：' + JSON.stringify(r).slice(0, 200))
      const buf = Buffer.from(r.sb3Base64, 'base64')
      let finalPath = target
      let renamed = false
      if (existsSync(target) && !args.overwrite) {
        // 默认不覆盖：用户的作品文件比什么都重要，AI 不该悄悄盖掉
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
        finalPath = target.replace(/\.sb3$/i, '') + `-ai-${stamp}.sb3`
        renamed = true
      }
      mkdirSync(dirname(finalPath), { recursive: true })
      writeFileSync(finalPath, buf)
      return {
        savedTo: finalPath,
        bytes: buf.length,
        overwrote: !renamed,
        renamedFrom: renamed ? target : undefined,
        title: r.title,
        hint: renamed
          ? '目标文件已存在，为安全起见另存为新文件了（要覆盖原文件下次传 overwrite: true）'
          : '已写入原路径'
      }
    }
  }))

  ctx.tools.register(defineTool({
    name: 'scratch_snapshot',
    description: '读取当前 TurboWarp 项目的完整 sb3 JSON（project.json 格式，含 targets/blocks/variables/monitors）。',
    parameters: {
      session: { type: 'string', description: '会话 ID，缺省用第一个' },
      target: { type: 'string', description: '精灵名过滤，缺省全部' }
    },
    output: jsonOut,
    async execute(args) {
      const sid = needSession(args?.session)
      const pj = await call(sid, 'snapshot', { target: args?.target })
      return { project: pj, note: 'blocks 为 sb3 dict 格式；每个 top-level 块的 x/y 是工作区坐标', skillHint: '写积木前建议 scratch_skills read sb3-json-reference（输入编码字典）' }
    }
  }))

  ctx.tools.register(defineTool({
    name: 'scratch_read_script',
    description: '读取某个精灵/角色的积木 JSON（懒加载省 token）。target 缺省为当前编辑中的角色。',
    parameters: {
      session: { type: 'string' },
      target: { type: 'string', description: '精灵名，如 "Sprite1"' }
    },
    output: jsonOut,
    async execute(args) {
      const sid = needSession(args?.session)
      return await call(sid, 'read_script', { target: args?.target })
    }
  }))

  ctx.tools.register(defineTool({
    name: 'scratch_add_blocks',
    description: '向角色注入积木（sb3 blocks dict 格式，带临时 id + parent/next 链 + x/y 坐标）。注入走 shareBlocksToTarget 官方管线：ID 自动换新、所需扩展自动加载、inline 字面量自动展开成影子块。返回 idMap（旧 ID → 新 ID）——后续引用新块必须用新 ID。preview 档下不会立刻落盘，会返回 planId 等 scratch_apply。',
    parameters: {
      session: { type: 'string' },
      target: { type: 'string', description: '目标精灵名' },
      blocks: { type: 'object', additionalProperties: true, description: 'sb3 blocks dict（同 project.json 里 targets[].blocks 的格式）' }
    },
    output: jsonOut,
    async execute(args) {
      const sid = needSession(args?.session)
      if (!args?.blocks) throw new Error('blocks 必填')
      return guardedWrite(sid, 'add_blocks', { target: args.target, blocks: args.blocks },
        'pre-add_blocks', { target: args.target, blocks: args.blocks })
    }
  }))

  ctx.tools.register(defineTool({
    name: 'scratch_apply',
    description: 'preview 档下，用户确认后应用改动。传 planId（别的写工具在 preview 档返回的那个）即可；也兼容直接传 blocks+target（等价于应用一次 add_blocks）。',
    parameters: {
      session: { type: 'string' },
      planId: { type: 'string', description: 'preview 档返回的 planId' },
      blocks: { type: 'object', additionalProperties: true, description: '兼容用法：直接给要注入的 blocks' },
      target: { type: 'string' }
    },
    output: jsonOut,
    async execute(args) {
      const sid = needSession(args?.session)
      if (args?.planId) {
        const plan = pendingPlans.get(args.planId)
        if (!plan) throw new Error(`planId ${args.planId} 不存在或已过期（重新调一次那个写工具生成新的）`)
        if (plan.sessionId !== sid) throw new Error(`planId ${args.planId} 属于另一个会话（${plan.sessionId}）`)
        pendingPlans.delete(args.planId)
        return executePlan(plan)
      }
      if (!args?.blocks) throw new Error('scratch_apply 需要 planId（preview 档返回的）或 blocks+target')
      return executePlan({ sessionId: sid, op: 'add_blocks', args: { target: args.target, blocks: args.blocks }, label: 'pre-apply' })
    }
  }))

  ctx.tools.register(defineTool({
    name: 'scratch_locate',
    description: '让 TurboWarp 工作区滚动到指定积木并高亮（视觉定位，帮用户找到 AI 正在说的块）。',
    parameters: {
      session: { type: 'string' },
      blockId: { type: 'string', required: true }
    },
    output: jsonOut,
    async execute(args) {
      const sid = needSession(args?.session)
      return await call(sid, 'locate', { blockId: args.blockId })
    }
  }))

  ctx.tools.register(defineTool({
    name: 'scratch_add_costume',
    description: '向角色添加 SVG 造型。svg 参数为 SVG 源码文本。',
    parameters: {
      session: { type: 'string' },
      target: { type: 'string' },
      name: { type: 'string', description: '造型名' },
      svg: { type: 'string', required: true, description: 'SVG 源码' }
    },
    output: jsonOut,
    async execute(args) {
      const sid = needSession(args?.session)
      return guardedWrite(sid, 'add_costume',
        { target: args.target, name: args.name, svg: args.svg },
        'pre-add_costume',
        { target: args.target, name: args.name, svgBytes: (args.svg || '').length })
    }
  }))

  ctx.tools.register(defineTool({
    name: 'scratch_rollback',
    description: '回滚到某个快照（AI 改坏项目时的后悔药）。不带参数回滚到最近一次。快照双保险：内存 + 磁盘（dsh 重启后也能滚）。',
    parameters: {
      session: { type: 'string' },
      index: { type: 'number', description: '快照序号，0 = 最近' }
    },
    output: jsonOut,
    async execute(args) {
      const sid = needSession(args?.session)
      const snap = await findSnapshot(sid, args?.index ?? 0)
      if (!snap) throw new Error('没有可用快照')
      const r = await call(sid, 'restore', { projectJson: snap.projectJson })
      return Object.assign({ restoredFrom: snap.at, label: snap.label }, r)
    }
  }))

  // ==================== Skill 区：Scratch 实践经验库 ====================

  ctx.tools.register(defineTool({
    name: 'scratch_skills',
    description: 'Scratch 实践经验库（基于社区高完成度作品逆向分析）。action=list 列出全部 skill（含摘要和开关状态）；action=read 读取某篇全文；action=toggle 开关某篇（用户表示不想让你用某经验时用它）。经验仅供参考，不是强制要求——但写积木前建议扫 sb3-json-reference。',
    parameters: {
      action: { type: 'string', description: 'list | read | toggle（缺省 list）' },
      name: { type: 'string', description: 'skill 文件名（如 sb3-json-reference.md），read/toggle 必填' }
    },
    output: jsonOut,
    async execute(args) {
      if (cfg.skillsEnabled === false) {
        return { skillsDisabled: true, hint: '用户关闭了 skill 功能（cfg.skillsEnabled=false）' }
      }
      const action = args?.action || 'list'
      if (action === 'list') {
        const list = listSkills()
        return {
          count: list.length,
          skills: list,
          note: 'on=false 的 skill 是用户/你之前关掉的。按需 read，没必读完。'
        }
      }
      if (action === 'read') {
        if (!args?.name) throw new Error('read 需要 name')
        const f = resolve(skillDir, args.name)
        // 注意要带 sep：只比前缀的话 ../scratch-skills-x/a.md 也能过
        if (!f.startsWith(resolve(skillDir) + sep) || !f.endsWith('.md')) throw new Error(`非法 skill 名 ${args.name}`)
        let content
        try { content = readFileSync(f, 'utf8') } catch { throw new Error(`skill 不存在：${args.name}（先 list）`) }
        return { name: args.name, on: isSkillOn(args.name), content }
      }
      if (action === 'toggle') {
        if (!args?.name) throw new Error('toggle 需要 name')
        const map = skillEnabledMap()
        map[args.name] = !isSkillOn(args.name)
        writeFileSync(skillStateFile, JSON.stringify(map, null, 2))
        return { name: args.name, on: map[args.name] }
      }
      throw new Error(`未知 action ${action}（list | read | toggle）`)
    }
  }))

  ctx.tools.register(defineTool({
    name: 'scratch_skill_edit',
    description: '编辑 skill 区（Scratch 经验库）：action=create 新建、update 覆写、delete 删除、append 追加一节。学到新经验（用户纠正了你的做法/发现新的社区惯用法）就写进来，下次直接用。格式约定：文件头保持「# 标题」+「> 适用场景」，方便别人选读。',
    parameters: {
      action: { type: 'string', description: 'create | update | delete | append（缺省 append）' },
      name: { type: 'string', required: true, description: 'skill 文件名，形如 my-experience.md' },
      content: { type: 'string', description: 'md 内容（create/update 必填；append 是要追加的一节）' },
      section: { type: 'string', description: 'append 时的节标题' }
    },
    output: jsonOut,
    async execute(args) {
      const action = args?.action || 'append'
      if (!args?.name) throw new Error('name 必填')
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*\.md$/.test(args.name)) {
        throw new Error('skill 名格式：字母数字开头 + [a-zA-Z0-9_-] + .md，如 gravity-tuning.md')
      }
      const f = resolve(skillDir, args.name)
      if (!f.startsWith(resolve(skillDir) + sep)) throw new Error('路径越界')
      if (action === 'create') {
        if (existsSync(f)) throw new Error(`已存在（要覆盖用 update）：${args.name}`)
        writeFileSync(f, args?.content || `# ${args.name.replace('.md', '')}\n\n> 适用场景：\n`)
        return { created: args.name }
      }
      if (action === 'update') {
        if (!existsSync(f)) throw new Error(`不存在（新建用 create）：${args.name}`)
        writeFileSync(f, args?.content || '')
        return { updated: args.name }
      }
      if (action === 'append') {
        initSkillDir()
        const old = existsSync(f) ? readFileSync(f, 'utf8') : `# ${args.name.replace('.md', '')}\n\n> 适用场景：\n`
        const sec = `\n\n## ${args?.section || '经验 ' + new Date().toISOString().slice(0, 10)}\n\n${args?.content || ''}\n`
        writeFileSync(f, old.trimEnd() + sec)
        return { appended: args.name, section: args?.section }
      }
      if (action === 'delete') {
        if (args.name === 'INDEX.md') throw new Error('INDEX.md 是目录，不许删')
        if (!existsSync(f)) throw new Error(`不存在：${args.name}`)
        unlinkSync(f)
        return { deleted: args.name }
      }
      throw new Error(`未知 action ${action}`)
    }
  }))

  // ==================== M1：改块 / 删块 / 整理 / 白名单 ====================

  ctx.tools.register(defineTool({
    name: 'scratch_update_block',
    description: '修改已有积木。fields 改下拉/选项值（走官方 changeBlock）；inputs 改输入值（sb3 input 数组格式，如 {"STEPS": [1, [4, "10"]]}）；x/y 改工作区坐标。块 ID 必须是项目里现存的（add_blocks 返回的新 ID 或 read 出的）。',
    parameters: {
      session: { type: 'string' },
      target: { type: 'string', description: '目标精灵名' },
      blockId: { type: 'string', required: true },
      fields: { type: 'object', additionalProperties: true, description: '要改的字段，如 {"STOP_OPTION": "all"}' },
      inputs: { type: 'object', additionalProperties: true, description: '要改的输入，sb3 数组格式，如 {"STEPS": [1, [4, "10"]]}' },
      x: { type: 'number', description: '新工作区坐标 x' },
      y: { type: 'number', description: '新工作区坐标 y' }
    },
    output: jsonOut,
    async execute(args) {
      const sid = needSession(args?.session)
      const changes = {}
      if (args.fields) changes.fields = args.fields
      if (args.inputs) changes.inputs = args.inputs
      if (args.x !== undefined) changes.x = args.x
      if (args.y !== undefined) changes.y = args.y
      if (!Object.keys(changes).length) throw new Error('changes 为空：至少要给 fields / inputs / x / y 之一')
      return guardedWrite(sid, 'update_block',
        { target: args.target, blockId: args.blockId, changes },
        'pre-update_block',
        { blockId: args.blockId, changes })
    }
  }))

  ctx.tools.register(defineTool({
    name: 'scratch_delete_blocks',
    description: '删除积木（blockIds 数组）。注意：删除会级联删除 next 链上的后续块和嵌套实块（与 GUI 行为一致），返回实际删除的全部块 ID。删链中间某块前先想清楚后面要不要保留。',
    parameters: {
      session: { type: 'string' },
      target: { type: 'string' },
      blockIds: { type: 'array', required: true, description: '要删的块 ID 列表' }
    },
    output: jsonOut,
    async execute(args) {
      const sid = needSession(args?.session)
      return guardedWrite(sid, 'delete_blocks',
        { target: args.target, blockIds: args.blockIds },
        'pre-delete_blocks',
        { target: args.target, blockIds: args.blockIds })
    }
  }))

  ctx.tools.register(defineTool({
    name: 'scratch_tidy_blocks',
    description: '整理工作区布局：把目标角色的全部脚本按列排布（等距网格，估算行高）。用于散乱积木的自动整理。',
    parameters: {
      session: { type: 'string' },
      target: { type: 'string' }
    },
    output: jsonOut,
    async execute(args) {
      const sid = needSession(args?.session)
      return guardedWrite(sid, 'tidy_blocks', { target: args.target }, 'pre-tidy_blocks',
        { target: args.target, note: '把该角色的全部顶层脚本按列重排' })
    }
  }))

  ctx.tools.register(defineTool({
    name: 'scratch_get_opcodes',
    description: '获取当前宿主全部可用积木的 opcode 白名单（内置 + 已加载扩展）。AI 生成 add_blocks/update 前建议先查这个，避免编造不存在的 opcode。',
    parameters: {
      session: { type: 'string' },
      target: { type: 'string', description: '精灵名（不同目标扩展加载可能不同），缺省当前编辑目标' }
    },
    output: jsonOut,
    async execute(args) {
      const sid = needSession(args?.session)
      return await call(sid, 'get_opcodes', { target: args?.target })
    }
  }))

  // ==================== M2：观察者 / 双向联动 ====================

  ctx.tools.register(defineTool({
    name: 'scratch_watch',
    description: '订阅/读取变量变化（观察者模式）。action=start 开始监听目标角色全部变量（500ms 轮询）；action=poll 拉取当前值+积累的变化（拉完清空）；action=stop 停止。绿旗跑起来后用它看变量轨迹。',
    parameters: {
      session: { type: 'string' },
      action: { type: 'string', description: 'start | poll | stop（缺省 poll）' },
      target: { type: 'string', description: 'start 时指定要监听的角色' }
    },
    output: jsonOut,
    async execute(args) {
      const sid = needSession(args?.session)
      const r = await call(sid, 'watch', { action: args?.action || 'poll', target: args?.target })
      // 合并桥侧推来的变化帧（扩展直推的部分）
      const s = sessions.get(sid)
      if (s && s.watchEvents && s.watchEvents.length && args?.action !== 'start') {
        r.bridgePushed = s.watchEvents.splice(0)
      }
      return r
    }
  }))

  ctx.tools.register(defineTool({
    name: 'scratch_user_context',
    description: '读取用户最近的编辑动作（选中了哪些块、按没按绿旗、是否正在运行）——双向联动数据源。AI 在动手前先看一眼用户在关注什么。',
    parameters: {
      session: { type: 'string' },
      sinceMs: { type: 'number', description: '只返回最近 N 毫秒内的动作，缺省 30000' }
    },
    output: jsonOut,
    async execute(args) {
      const sid = needSession(args?.session)
      const r = await call(sid, 'user_context', { sinceMs: args?.sinceMs ?? 30000 })
      // 合并桥侧事件帧（绿旗等）
      const s = sessions.get(sid)
      if (s && s.userEvents && s.userEvents.length) {
        r.runtimeEvents = s.userEvents.splice(0)
      }
      return r
    }
  }))

  // 桥启动放最后（工具注册失败时不占端口）
  startBridge().catch(e => log.error('桥启动失败: %s', e.message))
}
