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
import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, copyFileSync, statSync, renameSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
import { basename } from 'node:path'
import { createHash } from 'node:crypto'
// 空白作品生成器（G1）：手写最小 sb3 太劝退，插件直接造一份给你（md5 命名 / zip / 两个内联 SVG）
import { buildBlankProject, buildSprite3 } from './sb3.js'
import { readAssetFile, readJsonFile, normalizeBlocksFile } from './assets.js'
// CDP 直连（不需要浏览器扩展）—— 见 cdp.js 顶部注释。TurboWarp Desktop 走的就是这条路。
import { attachCdp, findFreePort, tagForPage, probeCdp } from './cdp.js'

export const name = 'dsh-plugin-scratch'
export const inject = ['tools'] // dsh 规范：用到 ctx.tools 必须声明，框架保证注入后才加载

// ---------------- 配置 schema ----------------
// 页面上只放**用户真会改**的三项（`.volatile()` = 会出现在插件页的配置表单里，
// 且改完立即生效、不用重挂插件）：写操作档位 / 桌面版路径 / 快照目录。
// 其余是工程参数（端口、快照上限、浏览器路径、skill 总开关）：它们**不进配置页**，
// 需要时改 profile 的 cordis.patch.yml，然后重挂这一行（端口类本来就要重连才生效）。
// 为什么必须留 volatile：dsh-settings 靠 volatile 字段生成表单，一个都没有 = 配置页直接不出现。
// volatile 字段在运行时是 `{ get() }` 引用（cosmokit 的 createVolatile），下面所有读取都走 cfg。
// ⚠️ 字段名/类型必须与已写入 profile 的 YAML 值兼容（字符串存端口会报校验错）。
export const Config = z.object({
  safety: z.union(['auto', 'preview', 'suggest']).default('preview').volatile()
    .description('写操作落地方式：preview 先给 diff 等确认，auto 直接落盘，suggest 只给建议'),
  desktopPath: z.string().default('').volatile()
    .description('TurboWarp Desktop 的 exe 路径，留空 = 自动找'),
  snapshotsDir: z.string().default('').volatile()
    .description('快照目录，留空 = 系统临时目录。大项目别堆在系统盘'),

  // ---- 以下仅 YAML 可改（不进配置页）----
  bridgePort: z.natural().min(1).max(65535).default(31820)
    .description('桥监听端口（浏览器扩展连这个端口）。改完重挂本行生效'),
  maxSnapshots: z.natural().default(30).description('内存里最多留几份快照'),
  maxSnapshotMemMb: z.natural().default(64).description('快照内存上限（MB）'),
  maxSnapshotDiskMb: z.natural().default(256).description('快照落盘上限（MB）'),
  skillsEnabled: z.boolean().default(true)
    .description('Skill 经验库总开关（关掉后 scratch_skills 只回 disabled）'),
  desktopDebugPort: z.natural().min(1).max(65535).default(31821)
    .description('「AI 可接管」的固定调试端口（与仓库里的 启动TurboWarp(AI可接管).cmd 保持一致）'),
  browserPath: z.string().default('')
    .description('网页版用哪个浏览器打开，留空 = 系统默认浏览器'),
})

/** 读 volatile 引用（`{ get() }`）或普通值；每次读都取最新，UI 保存后立即生效 */
const readLive = (value) => (value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value)
/** dsh 家目录（DSH_HOME 已经是 ~/.dsh，别再拼一层） */
const homeDir = () => process.env.DSH_HOME || join(homedir(), '.dsh')

// ---------------- 本机资源文件读取（造型/音效） ----------------
// 真机反馈（A1/A6）：桥以前只收 SVG **源码**，而这个 AI 真做的作品素材是 PNG（头像 180×180、
// 敌人图标 158×158）+ WAV 音效 —— 于是"导入美术资源"这一步只能自己去写 sb3 打包器。
// 现在插件侧直接读盘转 base64，页面侧 storage.createAsset 建资源：PNG/WAV 和 SVG 一样一条调用。
// 实现在 assets.js（纯函数，能单独测）。

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
  Object.assign({}, def, {
    execute: async (...args) => clipToolResult(jsonSafe(await def.execute(...args)), def.name)
  })
)

// ---------------- 大返回的最后一道闸（A2） ----------------
// 问题清单 A2：`scratch_snapshot` 回 1.8MB、`batch` 回 65KB，到工具层被**静默**截成
// "Omitted … spill 文件" —— ok:true 依旧成立，AI 以为拿到了、其实没有。
// 各 op 自己已经按块/字节分页了；这里是兜底：超过预算就**显式**换成
// {truncated, bytes, spillPath, preview}，全文落到盘上，绝不闷声丢。
const MAX_RESULT_JSON = 60000 // 渲染后（pretty JSON）字符数上限，留足余量给模型上下文
function clipToolResult(value, toolName) {
  if (value === null || value === undefined) return value
  let text = ''
  try { text = JSON.stringify(value, null, 2) } catch { return value }
  if (text.length <= MAX_RESULT_JSON) return value
  let spillPath = null
  try {
    const dir = join(homeDir(), 'scratch-payloads')
    mkdirSync(dir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    spillPath = join(dir, `${toolName || 'result'}-${ts}.json`)
    writeFileSync(spillPath, text)
  } catch { spillPath = null }
  return {
    truncated: true,
    tool: toolName,
    bytes: text.length,
    limit: MAX_RESULT_JSON,
    spillPath: spillPath || undefined,
    preview: text.slice(0, 4000),
    hint: `这个返回值太大（${Math.round(text.length / 1024)}KB > ${Math.round(MAX_RESULT_JSON / 1024)}KB），已换成"截断信封"：`
      + (spillPath ? `全文在 ${spillPath}（可以直接 grep/read）。` : '全文没落盘（写盘失败）。')
      + ' 更省的做法：用分页/收窄参数重调（read_script 的 limit/offset/scriptId/blockId/depth，snapshot 的 target/maxBytes），'
      + '或 scratch_project_overview 先看结构。'
  }
}

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
  // 桥的存活状态（scratch_selftest 要如实报"桥还在不在监听"，不能靠猜）
  let bridgeListening = false
  let bridgePortLive = 0
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
        bridgeListening = true
        bridgePortLive = cfg.bridgePort
        log.info('桥监听 %s:%d（等浏览器扩展连进来）', '127.0.0.1', cfg.bridgePort)
      })
      wss.on('close', () => { bridgeListening = false })
      wss.on('error', (e) => {
        if (e && e.code === 'EADDRINUSE') {
          // 自己人重入（比如同一 profile 被加载两次）也会走到这儿
          bridgeListening = false
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
  // 给指定会话发指令，等结果。
  // opts.noGate：跳过「装载闸」（装载流程自己要用，否则会等自己）
  async function call(sessionId, op, args, timeoutMs = OP_TIMEOUTS[op] || 15000, opts) {
    // 装载闸（A1）：scratch_open_editor 现在窗口一出来就先返回，文件在后台装。
    // 后续任何 op 到这儿都会先等装载完 —— 于是调用方拿到的永远是"装好的项目"，
    // 不会读到桌面版冷启动那个空白默认工程（B1 的根因就是没这道闸）。
    const s0 = sessions.get(sessionId)
    if (!(opts && opts.noGate) && s0 && s0.loading) {
      try { await s0.loading } catch { /* 装载失败：让这条 op 自己如实报错 */ }
    }
    return await new Promise((resolve, reject) => {
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
  async function takeSnapshot(sessionId, label, opts) {
    // 快照要的是**完整** project.json（回滚靠它）：maxBytes 放到最大，且跳过装载闸
    // （装载流程自己也要先快照，不能等自己）。
    const pj = await call(sessionId, 'snapshot', { maxBytes: 4000000 }, OP_TIMEOUTS.snapshot, opts || {})
    if (pj && pj.truncated) {
      log.warn('快照被截断（%d 字节 > 上限），这份快照不能用来回滚', pj.bytes || 0)
    }
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
    // 多目标批量注入（blocksFile 的 {targets:{...}} 形状）：一条计划、一次快照，
    // 落盘时逐个 target 注入。失败的 target 单独记下来，不吞掉其余成功的。
    if (plan.op === 'add_blocks_batch' && plan.args && Array.isArray(plan.args.items)) {
      const targets = []
      for (const it of plan.args.items) {
        try {
          const r = await call(plan.sessionId, 'add_blocks', {
            target: it.target, blocks: it.blocks, variables: it.variables,
            lenient: it.lenient, layout: it.layout, follow: it.follow, discardStale: it.discardStale
          })
          targets.push(Object.assign({ target: it.target, ok: true }, r))
        } catch (e) {
          targets.push({ target: it.target, ok: false, error: e && e.message ? e.message : String(e) })
        }
      }
      const failed = targets.filter(t => !t.ok)
      return {
        snapshotAt: snap.at,
        label: plan.label,
        targets,
        added: targets.map(t => t.target),
        totals: {
          targets: targets.length,
          ok: targets.length - failed.length,
          failed: failed.length
        },
        error: failed.length ? `有 ${failed.length} 个目标注入失败：${failed.map(f => `${f.target}（${f.error}）`).join('；')}` : undefined
      }
    }
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

  /**
   * P3-2：写操作「哪变了」的字段名统一。
   * 老字段（added/deleted/updated）**保留不动**（文档、skill、旧脚本都在用），
   * 额外补一个统一的 `changed: { added?, updated?, deleted? }`，让脚本消费时不用各写一出。
   */
  function withChanged(r) {
    if (!r || typeof r !== 'object' || r.mode === 'preview' || r.mode === 'suggest') return r
    const n = (v) => (Array.isArray(v) ? v.length : (typeof v === 'number' ? v : (v === undefined ? undefined : 1)))
    const added = n(r.added)
    const updated = n(r.updated)
    const deleted = n(r.deleted)
    const changed = {}
    if (added !== undefined) changed.added = added
    if (updated !== undefined) changed.updated = updated
    if (deleted !== undefined) changed.deleted = deleted
    if (Object.keys(changed).length) r.changed = changed
    return r
  }

  // ---------------- Skill 区：Scratch 实践经验库 ----------------
  // 内置 skill（插件包 skills/ 目录）首启时复制到 $DSH_HOME/scratch-skills/，
  // 之后 agent/用户自由编辑，插件升级不覆盖（除非带 .reset 标记）。
  // 开关三层：cfg.skillsEnabled（总闸）→ .enabled.json（单文件开关）→ agent 自主选读。
  const skillDir = join(process.env.DSH_HOME || (homedir() + '/.dsh'), 'scratch-skills')
  const builtinSkillDir = join(dirname(fileURLToPath(import.meta.url)), 'skills')
  const skillStateFile = join(skillDir, '.enabled.json')
  const builtinVersionFile = join(skillDir, '.builtin-version')
  const SKILL_BUILTIN_VERSION = '14' // 升级内置 skill 时 bump（14 = sprite-split 加「一张卡一个角色」反例
                                    //     （12 角色 / 444 块 = 19%）；getting-started 加「先看背包有什么」+
                                    //     素材导入工具表；13 = 新增 multi-minigame-shell.md：
                                    //     章节式作品的共用壳（界面变量 + 三态门 + 台词队列 + 存档码）；
                                    //     12 = backpack/injection-semantics 补
                                    //     listLimit、变量 scope、creates 的 (全局) 标记；
                                    //     11 = sb3-json-reference 修 inputs 编码
                                    //     （影子的第 1 位规则 / argumentids 随机键 / 11-13 是报告器三元组）；
                                    //     10 = platform-traps 补广播无参数/画笔状态/作用域，recipes 修掉编造的 split 块，
                                    //     animation-visual 挂上新架构；
                                    //     9 = 重整 architecture/performance/getting-started/code-patterns；
                                    //     8 = 新增 sprite-split / boot-pipeline 两篇；
                                    //     7 = 新增 pen-3d / one-sprite-clones-ui /
                                    //     render-queue 三篇整套架构；6 = 新增 pen-text.md（画笔文字引擎）；
                                    //     5 = 新增 proven-patterns.md：从真实高完成度作品里读出来的十种写法；
                                    //     4 = 注入语义/平台陷阱/任务路由；3 = 背包那篇；2 = 去掉块数普查）

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
        let backedUp = 0
        // 升级时**覆盖**内置文档：它们是 AI 的操作手册，过期版本比没有更糟
        // （用户反馈原话："那个内置 skill 真的太简陋了，这 ai 仍旧疯狂试错"）。
        // 但不丢用户改过的东西 —— 覆盖前把旧文件整份备份到 .backup-v<旧版本>-<时间>/。
        // 用户自己新增的（不同名的）文件不受影响；强刷（.reset）不备份。
        const backupDir = join(skillDir, `.backup-v${ver || '0'}-${Date.now().toString(36)}`)
        for (const f of readdirSync(builtinSkillDir)) {
          if (!f.endsWith('.md')) continue
          const dst = join(skillDir, f)
          const existed = existsSync(dst)
          if (existed && !force) {
            try {
              mkdirSync(backupDir, { recursive: true })
              copyFileSync(dst, join(backupDir, f))
              backedUp++
            } catch { /* 备份失败也要继续升级：文档旧了更糟 */ }
          }
          copyFileSync(join(builtinSkillDir, f), dst)
          copied++
        }
        writeFileSync(builtinVersionFile, SKILL_BUILTIN_VERSION)
        if (force) {
          try { unlinkSync(resetMark) } catch {}
          log.info('skill 区已按 .reset 标记重置（覆盖 %d 篇内置文档）', copied)
        } else if (backedUp) {
          log.info('skill 区从 v%s 升到 v%s：覆盖 %d 篇，旧版备份在 %s', ver || '0', SKILL_BUILTIN_VERSION, copied, backupDir)
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
  // ⚠️ 每次注入前按 mtime 重读：以前是在插件加载时读一次就缓存 —— 结果改完执行器
  //    （sync-executor + 重启编辑器）注进去的还是旧代码，真机上白验一轮。
  const executorPath = join(dirname(fileURLToPath(import.meta.url)), 'vm-executor.js')
  const executorCache = { at: 0, bytes: 0, source: '' }
  function executorSourceNow() {
    try {
      const st = statSync(executorPath)
      if (executorCache.source && executorCache.at === st.mtimeMs && executorCache.bytes === st.size) return executorCache.source
      const src = readFileSync(executorPath, 'utf8')
      executorCache.at = st.mtimeMs
      executorCache.bytes = st.size
      executorCache.source = src
      return src
    } catch (e) {
      log.warn('vm-executor.js 读不到，CDP 直连（桌面版那条路）不可用：%s', e.message)
      return executorCache.source || ''
    }
  }
  // 保留这个名字：有几处（selftest / 文档）读的是「有没有执行器」
  const executorSource = executorSourceNow()

  /**
   * 把一个已连上的 CDP 端点注册成**普通会话**：28 个工具全都照常工作，无需改工具层。
   * 会话的 socket 接口只需要一个 send(text) —— 正好对上 call() 的用法。
   */
  async function registerCdpSession(handle, meta, { waitPongMs = 6000 } = {}) {
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
    // ⚠️ 只 ping 一次是不够的：冷启动时这个窗口刚创建、页面还在加载，我们这条 push
    //    会被丢掉（执行器还没注进去），于是 pageResponded 假阴性 —— 真机复现过
    //    （其余全绿、只有"页面应答"这一条红）。所以等的时候每隔 500ms 重发一次。
    const deadline = Date.now() + waitPongMs
    let lastPing = 0
    while (Date.now() < deadline && !(handle.raw && handle.raw.pongs > 0)) {
      if (Date.now() - lastPing >= 500) { push({ __dshBridgeRelay: 'ping' }); lastPing = Date.now() }
      await sleep(100)
    }
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
  async function cdpAttachAndReport({ port, launched, wantPath, wantBuf, wantName, waitMs = 20000, show = true }) {
    // 等 CDP 的时间用 waitMs 兜住（桌面版冷启动实测 2-6s；waitMs=0 表示"别等"，
    // 但还是给 3s —— 完全不试就下结论没有意义）
    const cdpTimeoutMs = waitMs === 0 ? 3000 : Math.max(waitMs, 5000)
    let sid = null
    let handle = null
    try {
      handle = await attachCdp({
        port,
        executorSource: executorSourceNow(),
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
      // 先确认页面醒了（能回答 project_meta），但**不等项目装载**：窗口一出来就先返回（A1）。
      // 冷启动时页面可能还没挂好 vm，所以这里给一个短重试（只为了拿到"现在是什么"，
      // 有文件要装的话不等 —— 装载本身在后台，后续 op 有装载闸）。
      const metaDeadline = Date.now() + (wantPath || wantBuf ? 1500 : Math.min(Math.max(cdpTimeoutMs, 3000), 15000))
      let metaBeforeLoad = { error: 'not tried' }
      while (true) {
        metaBeforeLoad = await call(sid, 'project_meta', {}, 15000, { noGate: true }).catch((e) => ({ error: e.message }))
        const okNow = !!(metaBeforeLoad && Array.isArray(metaBeforeLoad.targets) && metaBeforeLoad.targets.length > 0)
        if (okNow || Date.now() >= metaDeadline) break
        await sleep(250)
      }
      const pageOk = !!(metaBeforeLoad && Array.isArray(metaBeforeLoad.targets) && metaBeforeLoad.targets.length > 0)
      const out = {
        launched,
        connected: true,
        transport: 'cdp-desktop', // 零安装那套：没有扩展、没有 token
        sessionId: sid,
        pageResponded: pageOk,
        // B1：桌面版冷启动会先挂一个**自己的空白默认工程**（Stage + 角色1）。
        // 以前把这个当成"文件已打开"报出去，AI 会对着不存在的角色干活。现在明确标注它是什么。
        beforeLoad: pageOk
          ? { targets: metaBeforeLoad.targets.map(t => t.name), note: '桌面版冷启动的默认空工程，不是用户的作品；真正的装载在后台进行' }
          : undefined,
        target: handle.target && handle.target.url,
        path: wantPath || undefined
      }
      // 窗口可见性：连上了 ≠ 用户看得见。隐藏态会自动 ShowWindow 救回来，
      // 并把「救之前/之后」都报出来（AI 一开始就能跟用户说清楚，而不是陪他猜）。
      // show=false 是给"我要它后台跑、别弹窗"的场景（P2-4 的窗口选项）。
      const before = desktopWindowInfo({ pid: launched.pid, show: false })
      if (before) {
        sess.window = before
        out.window = before
        if (!before.visible) out.windowHidden = true
        if ((!before.visible || before.minimized) && show) {
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
        } else if (show === false && (!before.visible || before.minimized)) {
          out.windowHint = '按你的要求没有把窗口显示出来（show:false）。想让它出现：scratch_open_editor({ app: "desktop" }) 不带 show，或 scratch_selftest 看窗口状态'
        }
      }
      if (wantPath || wantBuf) {
        // A1：装载丢到后台，工具立刻返回。后续任何工具调用都会经过 call() 的装载闸，
        // 自动等它装完 —— 所以这里不 await，也不需要调用方轮询。
        const loading = (async () => {
          try {
            const r = wantBuf
              ? await loadBytesIntoSess(sid, wantBuf, wantName || 'new-project.sb3', 'pre-new_project')
              : await loadFileIntoSess(sid, wantPath)
            sess.loaded = r
            return r
          } catch (e) {
            sess.loadError = e.message
            return null
          } finally {
            sess.loading = null
          }
        })()
        sess.loading = loading
        out.loading = true
        out.hint = '窗口已经打开了，文件正在后台装载（大作品十几秒是常态）。'
          + '**下一条工具调用会自动等它装完**，不用手动轮询；想显式确认就 scratch_list_sessions 看 loaded。'
      } else {
        // 不带文件：把"现在编辑器里是什么"一起回（和以前一样，别让调用方多跑一次）
        const hasTargets = pageOk && metaBeforeLoad.targets.length > 0
        out.ready = hasTargets
        out.targets = pageOk ? metaBeforeLoad.targets : undefined
        out.editingTarget = pageOk ? metaBeforeLoad.editingTarget : undefined
        out.meta = pageOk ? metaBeforeLoad : undefined
        out.hint = hasTargets
          ? (launched.attached
              ? '已经接上**用户自己开的**那份桌面版（CDP 直连，没动他的窗口）：可以直接 scratch_snapshot / scratch_read_script / scratch_add_blocks 干活。'
              : '桌面版已经接上了（CDP 直连）：可以直接 scratch_snapshot / scratch_read_script / scratch_add_blocks 干活。')
            + '改完用 scratch_save_project 存盘（默认不覆盖原文件）。'
          : '桌面版接上了，但项目还没就绪（冷启动中 / 空项目）。等一秒再 scratch_list_sessions。'
      }
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
        // noGate：装载中也要能查（否则 list_sessions 会卡到装完，就看不到 loading 状态了）
        const meta = await call(id, 'project_meta', {}, undefined, { noGate: true }).catch(() => null)
        const entry = { sessionId: id, meta: s.meta, detail: meta }
        // 装载状态（A1）：open_editor 现在先返回、文件后台装 —— 这里就是看它装完没的地方
        if (s.loading) entry.loading = true
        if (s.loaded) {
          entry.loaded = {
            from: s.loaded.loadedFrom || s.loaded.filename || '(空白作品)',
            targets: s.loaded.targets,
            blockCount: s.loaded.blockCount,
            bytes: s.loaded.bytes,
            at: s.lastProjectAt
          }
        }
        if (s.loadError) entry.loadError = s.loadError
        // CDP 会话自报一句运输层状态（injected / 主 frame / 被忽略的子 frame 数 / 自愈次数）。
        // 排查"编辑器好好的但每个 op 都超时"时，这一行就是答案 —— 不用再猜。
        if (s.cdp && typeof s.cdp.state === 'function') entry.transport = s.cdp.state()
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

  /**
   * 把一段 sb3/json 字节装进会话（本机文件、以及 new_project 现造的空白作品都走这里）。
   * noGate：装载流程自己不能被"装载闸"挡住（否则等自己，死锁）。
   */
  async function loadBytesIntoSess(sid, buf, filename, label) {
    const head = buf.subarray(0, 1).toString('utf8')
    const isJson = /\.json$/i.test(filename) || head === '{'
    const snap = await takeSnapshot(sid, label || 'pre-load_project', { noGate: true })
    let r
    if (isJson) {
      let parsed
      try { parsed = JSON.parse(buf.toString('utf8')) } catch (e) { throw new Error(`project.json 解析失败：${e.message}`) }
      r = await call(sid, 'load_project', { projectJson: parsed, filename }, 60000, { noGate: true })
    } else {
      r = await call(sid, 'load_project', { sb3Base64: buf.toString('base64'), filename }, 120000, { noGate: true })
    }
    return Object.assign({ bytes: buf.length, format: isJson ? 'json' : 'sb3', snapshotAt: snap.at }, r)
  }

  /** 把一个本机作品文件装进指定会话（scratch_open_editor(path) 与 scratch_load_project 共用） */
  async function loadFileIntoSess(sid, filePath) {
    const p = resolve(String(filePath))
    if (!existsSync(p)) throw new Error(`文件不存在：${p}`)
    const st = statSync(p)
    if (!st.isFile()) throw new Error(`不是文件：${p}`)
    const MAX_MB = 200
    if (st.size > MAX_MB * 1024 * 1024) throw new Error(`文件太大（${(st.size / 1048576).toFixed(1)}MB > ${MAX_MB}MB），浏览器端解压会卡死`)
    const buf = readFileSync(p)
    const r = await loadBytesIntoSess(sid, buf, basename(p), 'pre-load_project')
    const sess = sessions.get(sid)
    if (sess) { sess.lastProjectPath = p; sess.lastProjectAt = new Date().toISOString() }
    return Object.assign({ loadedFrom: p }, r)
  }

  ctx.tools.register(defineTool({
    name: 'scratch_open_editor',
    description: '帮用户把 TurboWarp 打开、并把作品装进去 —— 「AI 帮我打开我的作品」就是这一条。'
      + '两条路：**装了 TurboWarp Desktop 就优先 app=desktop**（CDP 直连，零安装、零 token，我给进程带上调试端口后直接驱动它；而且只有这条路能截图）；'
      + 'app=browser（参数默认值）打开 turbowarp.org/editor，走**浏览器扩展**那套（用户要装扩展 + 填 token，不能截图；只在该机器没装桌面版、或要改浏览器里已开着的在线作品时用）；'
      + '已经在跑的那份桌面版没带调试端口，接不进去，会如实告诉你，并给出重启的办法。'
      + 'path 传 .sb3 / .sb2 / project.json 绝对路径就顺手把作品打开（等于用户手动拖文件进去）；'
      + '已经有会话时不重复开，直接把文件装进那个会话。'
      + 'port：接一个**已经带调试端口在跑**的实例（比如用户手动 TurboWarp.exe --remote-debugging-port=9222）；'
      + 'show:false 则只接管、不把窗口显示出来。'
      + '不传 path 只开编辑器也行；**blank:true 直接开一个空白作品**（舞台 + 一个角色，各带造型，不用自己手搓 sb3）。'
      + '返回值里的 connected / transport 是结论，别自己猜。带 path（或 blank）时**窗口一出来就返回**（loading:true），'
      + '文件在后台装，下一条工具调用会自动等它装完。',
    parameters: {
      app: { type: 'string', description: 'desktop（CDP 直连，零安装零 token，**装了桌面版就用这个**）| browser（扩展那条路，参数默认值；要装扩展 + token，不能截图）' },
      path: { type: 'string', description: '要打开的作品文件绝对路径（.sb3/.sb2/project.json），可选' },
      blank: { type: 'boolean', description: 'true = 新建一个空白作品（舞台 + 一个角色）再打开。和 path 二选一' },
      sprite: { type: 'string', description: 'blank 时角色的名字（缺省「角色1」）' },
      url: { type: 'string', description: 'app=browser 时要打开的地址（默认 https://turbowarp.org/editor，也可以传具体作品链接）' },
      waitMs: { type: 'number', description: '等 CDP 接上的上限，默认 20000，上限 60000（装载不等，后面自动会等）' },
      force: { type: 'boolean', description: '已经有会话 / 桌面版已在运行时，照样再开一个' },
      port: { type: 'number', description: 'CDP 调试端口：接这个已存在的实例（不传就探 desktopDebugPort，再不行自己开一个）' },
      show: { type: 'boolean', description: '是否把桌面版窗口显示出来，缺省 true' }
    },
    output: jsonOut,
    async execute(args) {
      const app = String(args?.app || 'browser').toLowerCase()
      const wantPath = args?.path ? resolve(String(args.path)) : null
      if (wantPath && !existsSync(wantPath)) throw new Error(`文件不存在：${wantPath}`)
      const blank = args?.blank === true && !wantPath
      // G1：空白作品在插件侧现造（md5 命名 + zip + 两个内联 SVG），不用 AI 手写 sb3
      const blankBuf = blank ? buildBlankProject({ spriteName: args?.sprite }).buffer : null
      const blankName = 'blank-project.sb3'

      // 已经有会话：不重复开窗口，直接把文件装进现有会话（这才是用户要的效果）
      if (sessions.size && !args?.force) {
        const sid = activeSession()
        const out = { alreadyConnected: true, sessionId: sid, sessions: [...sessions.keys()], path: wantPath || undefined, blank: blank || undefined }
        // 顺带确认一下"用户到底看得到窗口吗"（桌面版会话才有；隐藏态直接救回来）
        const sess = sessions.get(sid)
        if (sess && sess.cdp) {
          const win = desktopWindowInfo({ pid: sess.meta && sess.meta.pid, show: args?.show !== false })
          if (win) {
            sess.window = win
            out.window = win
            if (!win.visible) out.windowHint = '窗口在屏幕上不可见，ShowWindow 也没救回来 —— 让用户看任务栏 / Alt+Tab 找「TurboWarp Desktop」'
          }
        }
        if (wantPath || blank) {
          try {
            out.loaded = blank
              ? await loadBytesIntoSess(sid, blankBuf, blankName, 'pre-new_project')
              : await loadFileIntoSess(sid, wantPath)
          } catch (e) { out.loadError = e.message }
        }
        out.hint = (wantPath || blank)
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
        // 传了 port 就只认那个端口（P2-1：手动带 --remote-debugging-port=9222 起的实例）。
        const wantPort = Number(args?.port) || 0
        const probePort = wantPort || Number(cfg.desktopDebugPort) || DESKTOP_DEBUG_PORT
        const existing = await probeCdp(probePort)
        if (existing.ok) {
          log.info('发现可接管的桌面版实例（调试端口 %d：%s）', probePort, existing.browser)
          return await cdpAttachAndReport({
            port: probePort,
            launched: { app, attached: true, via: 'existing-debug-port', debugPort: probePort, browser: existing.browser },
            wantPath,
            wantBuf: blankBuf,
            wantName: blankName,
            waitMs,
            show: args?.show !== false
          })
        }
        if (wantPort) {
          return {
            launched: { app, ok: false, debugPort: wantPort },
            connected: false,
            portNotAttachable: true,
            error: `端口 ${wantPort} 上没有可接管的 CDP 端点（${existing.error || '连不上'}）`,
            hint: `要接已有实例，那个 TurboWarp 必须带 --remote-debugging-port=${wantPort} 启动（而且要是同一台机器/同一用户）。`
              + '不传 port 的话我会自己开一个窗口并带上调试端口。'
          }
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
        return await cdpAttachAndReport({ port, launched, wantPath, wantBuf: blankBuf, wantName: blankName, waitMs, show: args?.show !== false })
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
      if (connected && (wantPath || blank)) {
        try {
          out.loaded = blank
            ? await loadBytesIntoSess(activeSession(), blankBuf, blankName, 'pre-new_project')
            : await loadFileIntoSess(activeSession(), wantPath)
        } catch (e) { out.loadError = e.message }
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
      // F5：以前 `overwrote: !renamed` —— 存到**不存在**的新路径也报 overwrote:true。
      // 语义必须是"目标原本就存在、而且真被覆盖了"。
      const existed = existsSync(target)
      if (existed && !args.overwrite) {
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
        overwrote: existed && !renamed,
        created: !existed,
        renamedFrom: renamed ? target : undefined,
        title: r.title,
        hint: renamed
          ? '目标文件已存在，为安全起见另存为新文件了（要覆盖原文件下次传 overwrite: true）'
          : (existed ? '已覆盖原文件' : '目标是个新文件，已创建')
      }
    }
  }))

  ctx.tools.register(defineTool({
    name: 'scratch_snapshot',
    description: '读取当前 TurboWarp 项目的完整 sb3 JSON（project.json 格式，含 targets/blocks/variables/monitors）。'
      + '**大项目一定要收窄**：不带 target 读 25MB 工程会回 1.8MB，虽然现在会明确标 truncated + 给续读办法（A2），'
      + '但那是浪费。读代码优先用 scratch_read_script / scratch_project_overview（它们按块/字节分页）。',
    parameters: {
      session: { type: 'string', description: '会话 ID，缺省用第一个' },
      target: { type: 'string', description: '精灵名过滤，缺省全部' },
      maxBytes: { type: 'number', description: '字节上限（缺省 240000，最大 4000000）。超了会返回 truncated 索引而不是闷声截断' }
    },
    output: jsonOut,
    async execute(args) {
      const sid = needSession(args?.session)
      const pj = await call(sid, 'snapshot', { target: args?.target, maxBytes: args?.maxBytes })
      return { project: pj, note: 'blocks 为 sb3 dict 格式；每个 top-level 块的 x/y 是工作区坐标', skillHint: '写积木前建议 scratch_skills read sb3-json-reference（输入编码字典）' }
    }
  }))

  ctx.tools.register(defineTool({
    name: 'scratch_read_script',
    description: '读取某个精灵/角色的积木 JSON（懒加载省 token）。target 缺省为当前编辑中的角色。'
      + '**默认不回变量**（曾经因为连带回列表，一个 26 块的角色回了 7.5MB）——要看变量显式 includeVariables:true。'
      + '想先看结构（有哪些脚本、各是什么 opcode、多少块）就用 summary:true，那次回传很小。'
      + '读单个脚本用 scriptId（从 summary/scripts 里拿）；按 opcode 过滤用 opcodes。'
      + '**按子树读（D2）**：scriptId/blockId 可以是任意块，branch:"SUBSTACK" 只看那个分支，depth:2 只看前两层 —— '
      + '1669 块的脚不用再整段吞。'
      + '块数和字节**双上限**分页（hasMore/nextOffset/bytes），超过会说 truncated，不会静默丢数据。',
    parameters: {
      session: { type: 'string' },
      target: { type: 'string', description: '精灵名，如 "Sprite1"' },
      summary: { type: 'boolean', description: 'true = 只回结构（opcode 直方图 + 顶层脚本清单），不回块体' },
      scriptId: { type: 'string', description: '读这段脚本（顶层块 id）；与 summary/opcodes 互斥' },
      blockId: { type: 'string', description: '从任意块开始读它这一棵（不必是顶层；配合 branch/depth 用）' },
      branch: { type: 'string', description: '只往这个输入里走，如 "SUBSTACK"（"只给我这个 if 的 true 分支"）' },
      depth: { type: 'number', description: '只下钻 N 层（0 = 只要起点块自己）' },
      opcodes: { type: 'array', description: '只回这些 opcode 的块，如 ["event_whenflagclicked"]' },
      limit: { type: 'number', description: '最多回多少块（缺省 1500；summary 时是脚本条数，缺省 200）' },
      offset: { type: 'number', description: '分页偏移（配合 hasMore/nextOffset 用）' },
      maxBytes: { type: 'number', description: '这次返回的字节上限（缺省 40000，最大 400000）' },
      meta: { type: 'boolean', description: 'false = 不重复回 target/块数/脚本索引（翻页时省 token）' },
      includeVariables: { type: 'boolean', description: 'true = 连变量一起回（危险：长列表会炸）' },
      includeLists: { type: 'boolean', description: '配合 includeVariables：连列表内容一起回' }
    },
    output: jsonOut,
    async execute(args) {
      const sid = needSession(args?.session)
      return await call(sid, 'read_script', {
        target: args?.target,
        summary: args?.summary === true ? true : undefined,
        scriptId: args?.scriptId,
        blockId: args?.blockId,
        branch: args?.branch,
        depth: args?.depth,
        opcodes: Array.isArray(args?.opcodes) ? args.opcodes : (args?.opcodes ? [args.opcodes] : undefined),
        limit: args?.limit,
        offset: args?.offset,
        maxBytes: args?.maxBytes,
        meta: args?.meta === false ? false : undefined,
        includeVariables: args?.includeVariables === true ? true : undefined,
        includeLists: args?.includeLists === true ? true : undefined
      }, args?.summary ? 60000 : 30000)
    }
  }))

  ctx.tools.register(defineTool({
    name: 'scratch_add_blocks',
    description: '向角色注入积木（sb3 blocks dict 格式，带临时 id + parent/next 链 + 可选 x/y）。'
      + '走 shareBlocksToTarget 官方管线：ID 自动换新、所需扩展自动加载、inline 字面量自动展开成影子块；'
      + '缺的变量/列表会**自动补建**（refs.created 里有真实 id；同名已存在则复用 refs.kept）。'
      + '**注入前会校验输入名/字段名**：把 OPERAND1 塞进 operator_add 这种拼错会直接报错（这类错不会报错、只让算式恒为 0），'
      + '确需强行注入传 lenient:true。形状不确定就先 scratch_get_opcodes({ opcode:"operator_add" })。'
      + '**只增不删**：绝不清理你上次注入的游离块（返回里 staleInjected 只是提醒）；真要清传 discardStale:true（只清整棵子树都是 AI 注入的）。'
      + '没给坐标时按估算高度自动排到现有内容右边（不会叠在一起）；改完会把视口带过去（follow:false 可关）。'
      + '返回 idMap（旧 ID → 新 ID）——后续引用新块必须用新 ID。preview 档下不会立刻落盘，会返回 planId 等 scratch_apply。'
      + '**上千块别写在参数里**：用 blocksFile 指一个本机 .json（三种形状：纯 blocks dict / {target,blocks} / {targets:{名字:blocks}}），'
      + '插件读盘后一次注入；多目标形状只做一次快照、一条调用。',
    parameters: {
      session: { type: 'string' },
      target: { type: 'string', description: '目标精灵名（多目标文件里可省略）' },
      blocks: { type: 'object', additionalProperties: true, description: 'sb3 blocks dict（同 project.json 里 targets[].blocks 的格式）' },
      blocksFile: { type: 'string', description: '本机 .json 路径：blocks dict / {target,blocks,variables} / {targets:{名字:blocks}} 三种都收' },
      variables: { type: 'array', description: '可选：要一起建的变量/列表声明 [{name, type:"variable"|"list"|"broadcast", scope:"local"|"global", value}]（不传则按块里的名字自动建、值为空；scope:"global" 挂舞台 —— 几 MB 的字库表必须是全局的）' },
      lenient: { type: 'boolean', description: 'true = 输入名/字段名写错也只警告、照样注入（缺省是直接报错拦下来）' },
      layout: { type: 'string', description: 'auto（缺省，自动排到现有内容右边）| given（尊重你给的 x/y）' },
      follow: { type: 'boolean', description: 'false = 改完不把视口滚过去（缺省会滚）' },
      discardStale: { type: 'boolean', description: 'true = 顺手清掉上次注入且仍游离的块（只清整棵子树都是 AI 注入的，碰到作者积木会跳过）' }
    },
    output: jsonOut,
    async execute(args) {
      const sid = needSession(args?.session)
      let jobs
      if (args?.blocksFile) {
        jobs = normalizeBlocksFile(readJsonFile(args.blocksFile), args.target)
      } else {
        if (!args?.blocks) throw new Error('blocks 或 blocksFile 必填')
        jobs = [{ target: args.target, blocks: args.blocks, variables: args.variables }]
      }
      const common = {
        lenient: args.lenient === true ? true : undefined,
        layout: args.layout === 'given' ? 'given' : undefined,
        follow: args.follow === false ? false : undefined,
        discardStale: args.discardStale === true ? true : undefined
      }
      if (jobs.length === 1) {
        const j = jobs[0]
        if (!j.target) throw new Error('单目标注入必须给 target（或让文件里带 target/名字）')
        return withChanged(await guardedWrite(sid, 'add_blocks', {
          target: j.target,
          blocks: j.blocks,
          variables: Array.isArray(j.variables) ? j.variables : (Array.isArray(args.variables) ? args.variables : undefined),
          ...common
        },
        'pre-add_blocks', { target: j.target, blocks: j.blocks }))
      }
      // 多目标：一条计划、一次快照，落盘时逐个 target 注入（executePlan 里展开）
      const missing = jobs.filter(j => !j.target).length
      if (missing) throw new Error(`有 ${missing} 个目标没名字（targets 的键就是角色名）`)
      const r = await guardedWrite(sid, 'add_blocks_batch',
        { items: jobs.map(j => ({ target: j.target, blocks: j.blocks, variables: j.variables, ...common })) },
        'pre-add_blocks',
        { targets: jobs.map(j => ({ target: j.target, blocks: Object.keys(j.blocks).length })) })
      if (r && r.mode) return r
      return withChanged(r)
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
        // apply 也补统一的 changed（P3-2）：preview 档下真正的写操作发生在这里，
        // 不补的话「preview → apply」这条路上唯一拿不到「哪变了」的恰好是落盘那一步。
        return withChanged(await executePlan(plan))
      }
      if (!args?.blocks) throw new Error('scratch_apply 需要 planId（preview 档返回的）或 blocks+target')
      return withChanged(await executePlan({ sessionId: sid, op: 'add_blocks', args: { target: args.target, blocks: args.blocks }, label: 'pre-apply' }))
    }
  }))

  ctx.tools.register(defineTool({
    name: 'scratch_locate',
    description: '让 TurboWarp 工作区滚动到指定积木并高亮（视觉定位，帮用户找到 AI 正在说的块）。'
      + '不给 target 时会**跨全部角色/舞台搜索**这个 blockId，命中后自动把工作区切到那个角色（返回值里的 switchedFrom 说明从哪切过来的）。',
    parameters: {
      session: { type: 'string' },
      blockId: { type: 'string', required: true },
      target: { type: 'string', description: '只在这个角色里找（缺省：全部角色 + 舞台）' }
    },
    output: jsonOut,
    async execute(args) {
      const sid = needSession(args?.session)
      return await call(sid, 'locate', { blockId: args.blockId, target: args.target })
    }
  }))

  ctx.tools.register(defineTool({
    name: 'scratch_add_costume',
    description: '给角色加造型。两种来源：path（**本机图片文件**，png/jpg/jpeg/gif/bmp/svg/webp —— 插件读盘转 base64 传过去）'
      + '或 svg（直接给 SVG 源码）。加完会验 skin：载不进去就自动撤掉、不留 "?" 占位造型。'
      + 'PNG 的旋转中心交给渲染器按真实图形算，不用手填。加多个造型就多调几次（或 scratch_add_sprite 一次带一堆）。',
    parameters: {
      session: { type: 'string' },
      target: { type: 'string' },
      name: { type: 'string', description: '造型名（缺省用文件名）' },
      path: { type: 'string', description: '本机图片路径（绝对路径，或相对当前工作目录）' },
      svg: { type: 'string', description: 'SVG 源码（跟 path 二选一）' }
    },
    output: jsonOut,
    async execute(args) {
      const sid = needSession(args?.session)
      let payload
      let preview
      if (args?.path) {
        const f = readAssetFile(args.path)
        if (!['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp'].includes(f.format)) {
          throw new Error(`不认识的图片格式 .${f.format}（支持 png/jpg/jpeg/gif/bmp/svg/webp）：${f.abs}`)
        }
        payload = { target: args.target, name: args.name || f.name, bytes: f.base64, format: f.format }
        preview = { target: args.target, name: payload.name, file: f.abs, bytes: f.bytes.length, format: f.format }
      } else if (args?.svg) {
        payload = { target: args.target, name: args.name, svg: args.svg }
        preview = { target: args.target, name: args.name, svgBytes: args.svg.length }
      } else {
        throw new Error('要嘛给 path（本机图片文件）要嘛给 svg（SVG 源码）')
      }
      return withChanged(await guardedWrite(sid, 'add_costume', payload, 'pre-add_costume', preview))
    }
  }))

  ctx.tools.register(defineTool({
    name: 'scratch_add_sound',
    description: '给角色加音效（本机 wav/mp3/ogg/m4a/flac，插件读盘转 base64）。'
      + '加完会回报 rate / sampleCount / 秒数 —— 拿不到这些说明解码失败（存进去了但播不出声）。',
    parameters: {
      session: { type: 'string' },
      target: { type: 'string' },
      name: { type: 'string', description: '音效名（缺省用文件名）' },
      path: { type: 'string', required: true, description: '本机音频路径' }
    },
    output: jsonOut,
    async execute(args) {
      const sid = needSession(args?.session)
      if (!args?.path) throw new Error('path 必填')
      const f = readAssetFile(args.path)
      if (!['wav', 'mp3', 'ogg', 'm4a', 'flac'].includes(f.format)) {
        throw new Error(`不认识的音频格式 .${f.format}（支持 wav/mp3/ogg/m4a/flac）：${f.abs}`)
      }
      return withChanged(await guardedWrite(sid, 'add_sound', {
        target: args.target, name: args.name || f.name, bytes: f.base64, format: f.format
      }, 'pre-add_sound', { target: args.target, name: args.name || f.name, file: f.abs, bytes: f.bytes.length }))
    }
  }))

  ctx.tools.register(defineTool({
    name: 'scratch_add_sprite',
    description: '新建角色（等于编辑器里点「添加角色」）。角色自带造型：costumePath 给本机图片、costumeSvg 给 SVG 源码，'
      + '都不给就一个默认方块。costumePaths 可以一次塞一堆（头像/卡面这种一角色 N 造型的场景一条调用就够）。'
      + '走官方 sprite3 解析（含校验），**不会**改写已有角色的块 id。新角色在最上层、没有积木。',
    parameters: {
      session: { type: 'string' },
      name: { type: 'string', required: true, description: '新角色名' },
      costumePath: { type: 'string', description: '本机图片路径（做第一个造型）' },
      costumePaths: { type: 'array', items: { type: 'string' }, description: '本机图片路径数组（一次加多个造型，造型名取文件名）' },
      costumeSvg: { type: 'string', description: 'SVG 源码（做第一个造型，跟 path 二选一）' },
      color: { type: 'string', description: '默认方块的颜色（默认 #4c97ff）' },
      x: { type: 'number', description: '初始 x（缺省 0）' },
      y: { type: 'number', description: '初始 y（缺省 0）' },
      size: { type: 'number', description: '初始大小 1-540（缺省 100）' },
      visible: { type: 'boolean', description: 'false = 建好就隐藏（缺省显示）' }
    },
    output: jsonOut,
    async execute(args) {
      const sid = needSession(args?.session)
      if (!args?.name) throw new Error('name 必填')
      const costumeList = []
      const paths = Array.isArray(args.costumePaths) && args.costumePaths.length
        ? args.costumePaths
        : (args.costumePath ? [args.costumePath] : [])
      for (const p of paths) {
        const f = readAssetFile(p)
        costumeList.push({ name: f.name, data: f.bytes, format: f.format })
      }
      if (args.costumeSvg) costumeList.push({ name: '造型1', data: Buffer.from(String(args.costumeSvg), 'utf8'), format: 'svg' })
      const built = buildSprite3({ name: args.name, color: args.color, costumes: costumeList })
      return withChanged(await guardedWrite(sid, 'add_sprite', {
        zipB64: built.buffer.toString('base64'),
        x: typeof args.x === 'number' ? args.x : undefined,
        y: typeof args.y === 'number' ? args.y : undefined,
        size: typeof args.size === 'number' ? args.size : undefined,
        visible: args.visible === false ? false : undefined
      }, 'pre-add_sprite', { name: args.name, costumes: built.costumeNames, bytes: built.buffer.length }))
    }
  }))

  ctx.tools.register(defineTool({
    name: 'scratch_costume',
    description: '造型的改名 / 删除 / 切换（添加造型仍用 scratch_add_costume）。'
      + 'action=rename（新名被占用会自动加后缀，返回的 to 才是最终名字）/ delete（只剩一个造型时会拒绝）/ '
      + 'set（切到指定造型 —— 截图前把角色摆成某个造型常用）。'
      + '用 name 或 index（1 起，跟编辑器里显示的一致）指定，都不给 = 当前造型。',
    parameters: {
      session: { type: 'string' },
      target: { type: 'string', description: '角色名，缺省当前编辑目标' },
      action: { type: 'string', description: 'rename | delete | set' },
      name: { type: 'string', description: '按造型名指定' },
      index: { type: 'integer', description: '按序号指定（1 起）' },
      newName: { type: 'string', description: 'rename 必填：新名字' }
    },
    output: jsonOut,
    async execute(args) {
      const sid = needSession(args?.session)
      const action = String(args?.action || '')
      if (!action) throw new Error('action 必填：rename / delete / set')
      return await guardedWrite(sid, 'costume', {
        target: args.target, action, name: args.name, index: args.index, newName: args.newName
      }, `pre-costume-${action}`, {
        target: args.target,
        action,
        which: args.name || (args.index !== undefined ? `第 ${args.index} 个` : '当前造型'),
        newName: args.newName
      })
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
    description: 'Scratch 实践经验库（公开作品里常见做法的归纳）。action=list 列出全部 skill（含摘要和开关状态）；action=read 读取某篇全文；action=toggle 开关某篇（用户表示不想让你用某经验时用它）。经验仅供参考，不是强制要求——但写积木前建议扫 sb3-json-reference、platform-traps。'
      + 'list 的返回里还带 `backpack`（**已经做好的整块东西**：文字引擎、常用片段），别自己重造。',
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
        // 真机教训（A3）：AI 要显示中文/数字 HUD，最后自己手绘了 7 段数码管 —— 而背包里
        // 早就躺着 142 块的「文字引擎」（4 万多个字形，纯画笔）。这不是能力缺失，是**没找到**。
        // 所以把"背包里有什么"直接塞进 skill 列表的返回里：AI 几乎总会先扫一眼 skill。
        let backpack = []
        try {
          backpack = listBackpack().items.map(x => ({ name: x.name, title: x.title, when: x.when, blocks: x.blocks }))
        } catch { /* 背包读不了不影响 skill */ }
        return {
          count: list.length,
          skills: list,
          backpack: backpack.length ? backpack : undefined,
          note: 'on=false 的 skill 是用户/你之前关掉的。按需 read，没必读完。'
            + (backpack.length ? ' 背包里的东西直接 scratch_backpack_load 注进项目，别自己重写。' : '')
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

  // ==================== 背包：AI 自己维护的可复用积木库 ====================
  // 用户原话：「文字引擎这种完全可以直接预存到 ai 代码块背包里，后面可以加个类似这种
  // 背包的东西让 ai 自己维护」。
  //   skill 区存「怎么做」（经验/做法），背包存「做好的东西」（整块积木 + 它要的变量值）。
  // 存储：$DSH_HOME/scratch-backpack/<名字>.json 一条一个 + INDEX.md 一份目录
  //   （照抄 skill 区的做法：AI 能廉价扫目录、按需取用，而不是一次性全灌进上下文）。
  // 不做自动收集：自动攒会变垃圾堆，用户就再也不看了 —— 存之前问用户一句。
  // 删除不真删：挪进 _trash/（存进去的东西可能是几小时的活，手滑一次不该没了）。
  const backpackDir = join(process.env.DSH_HOME || (homedir() + '/.dsh'), 'scratch-backpack')
  const backpackTrashDir = join(backpackDir, '_trash')
  const BACKPACK_INDEX = 'INDEX.md'
  const BP_NAME_MAX = 64

  /** 名字 → 安全文件名（保留中文；Windows 非法字符换成 -） */
  function bpSlug(raw) {
    const s = String(raw || '').trim()
      .replace(/[\\/:*?"<>|\s]+/g, '-')
      .replace(/^[.-]+/, '')
      .replace(/-+$/g, '')
      .slice(0, BP_NAME_MAX)
    return s
  }
  function bpPath(name) {
    const slug = bpSlug(name)
    if (!slug) throw new Error('name 必填（会作为文件名，用英文/数字/中文都行）')
    const f = resolve(backpackDir, slug + '.json')
    if (!f.startsWith(resolve(backpackDir) + sep)) throw new Error('路径越界')
    return f
  }
  function bpRead(name) {
    const f = bpPath(name)
    if (!existsSync(f)) {
      const have = listBackpack().items.map(x => x.name)
      throw new Error(`背包里没有「${name}」（现有：${have.join('、') || '空'}）`)
    }
    return JSON.parse(readFileSync(f, 'utf8'))
  }
  function listBackpack() {
    try { mkdirSync(backpackDir, { recursive: true }) } catch { /* 只读也能用 */ }
    const items = []
    let bytes = 0
    try {
      for (const f of readdirSync(backpackDir)) {
        if (!f.endsWith('.json')) continue
        const full = join(backpackDir, f)
        try {
          const s = readFileSync(full, 'utf8')
          bytes += s.length
          const o = JSON.parse(s)
          items.push({
            name: o.name || basename(f, '.json'),
            title: o.title || '',
            when: o.description || '',
            tags: Array.isArray(o.tags) ? o.tags : [],
            blocks: o.stats && o.stats.blocks || (o.blocks ? Object.keys(o.blocks).length : 0),
            scripts: o.stats && o.stats.scripts || 0,
            updated: o.updatedAt || '',
            bytes: s.length
          })
        } catch { /* 坏文件跳过，不让一条烂数据废掉整个目录 */ }
      }
    } catch { /* 空目录 */ }
    items.sort((a, b) => String(b.updated).localeCompare(String(a.updated)))
    return { dir: backpackDir, count: items.length, items, indexBytes: bytes }
  }
  function rebuildBackpackIndex() {
    const { items } = listBackpack()
    const lines = [
      '# Scratch 背包（AI 维护的可复用积木）',
      '',
      '> skill 区存「怎么做」，这里存「做好的东西」。取用：`scratch_backpack_load({ name })`。',
      '> 存之前先问用户一句（不要自动攒 —— 攒成垃圾堆就没人看了）。',
      '',
      `共 ${items.length} 条。按更新时间倒序。`,
      ''
    ]
    if (items.length) {
      lines.push('| 名字 | 标题 | 块数 | 标签 | 更新 |', '|---|---|---|---|---|')
      for (const it of items) {
        lines.push(`| ${it.name} | ${it.title || it.when || ''} | ${it.blocks} | ${(it.tags || []).join(', ')} | ${String(it.updated).slice(0, 10)} |`)
      }
    } else {
      lines.push('（空。做完一件有难度的事 → `scratch_backpack({ action: "save", ... })` 存进来。）')
    }
    try {
      mkdirSync(backpackDir, { recursive: true })
      writeFileSync(join(backpackDir, BACKPACK_INDEX), lines.join('\n') + '\n')
      return join(backpackDir, BACKPACK_INDEX)
    } catch (e) {
      log.warn('背包目录索引写入失败: %s', e.message)
      return null
    }
  }
  /**
   * 注入前把坐标搬到指定位置：保留片段内部的相对排布，只做整体平移。
   * （直接沿用存的时候的坐标，多半会跟用户现有脚本叠在一起）
   */
  function shiftBackpackBlocks(blocks, x, y) {
    const out = JSON.parse(JSON.stringify(blocks || {}))
    const tops = Object.values(out).filter(b => b && !Array.isArray(b) && b.topLevel)
    const pts = tops.filter(b => Number.isFinite(b.x) && Number.isFinite(b.y))
    if (!tops.length) return out
    // 没给位置就落到 48,48（别沿用存的时候的坐标 —— 那多半跟用户现有脚本叠在一起）
    const tx = Number.isFinite(x) ? x : 48
    const ty = Number.isFinite(y) ? y : 48
    if (pts.length) {
      const minX = Math.min(...pts.map(b => b.x))
      const minY = Math.min(...pts.map(b => b.y))
      for (const b of pts) { b.x += tx - minX; b.y += ty - minY }
    } else {
      tops.forEach((b, i) => { b.x = tx; b.y = ty + i * 200 })
    }
    return out
  }

  ctx.tools.register(defineTool({
    name: 'scratch_backpack',
    description: '积木背包（AI 自己维护的可复用积木库）：把做好的整块积木存下来，下次直接取用。'
      + 'action=list 扫目录（很便宜，只回名字/标题/块数/标签）；action=read 读一条的完整 blocks；'
      + 'action=save 把当前项目里的脚本存进来（用 scriptId/blockIds，或 all:true）；action=delete 删（进 _trash，不真删）。'
      + '**存之前先问用户一句**（不要自动攒）。取用走 scratch_backpack_load。',
    parameters: {
      action: { type: 'string', description: 'list | read | save | delete（缺省 list）' },
      name: { type: 'string', description: '条目名（文件名；中英文都行）。read/save/delete 必填（save 时可省略，从 title 生成）' },
      session: { type: 'string', description: '会话 ID（save 时用），缺省用第一个' },
      target: { type: 'string', description: 'save 时从哪个角色导出，缺省当前编辑中的角色' },
      scriptIds: { type: 'array', description: 'save：要存的脚本根 id（顶层块 id，从 scratch_list_scripts 拿）' },
      blockIds: { type: 'array', description: 'save：要存的块 id（会自动连带 next 链/嵌套块/影子块）' },
      all: { type: 'boolean', description: 'save：把这个角色的全部脚本都存进来（想存整个角色时用）' },
      listLimit: { type: 'number', description: 'save：列表最多带多少项（默认 1000）。字库/字模这种几万项的大表要显式给大（如 50000），否则存进去的是截断版 —— 取出来会少一半字且不报错' },
      title: { type: 'string', description: 'save：一句话标题（给人看）' },
      description: { type: 'string', description: 'save：什么时候用它（相当于 skill 的「适用场景」）' },
      notes: { type: 'string', description: 'save：怎么用/怎么改参数（会原样带给下次的自己）' },
      tags: { type: 'array', description: 'save：标签，如 ["pen","text"]' },
      overwrite: { type: 'boolean', description: 'save：同名已存在时是否覆盖（默认 false，会报错提醒）' }
    },
    output: jsonOut,
    async execute(args) {
      const action = args?.action || 'list'
      if (action === 'list') {
        const r = listBackpack()
        return {
          dir: r.dir,
          count: r.count,
          items: r.items,
          indexFile: join(r.dir, BACKPACK_INDEX),
          hint: r.count
            ? '用 scratch_backpack({ action: "read", name }) 看某一条的 blocks，或 scratch_backpack_load 直接注进项目。'
            : '背包是空的。做完一件有难度的事（比如 pen 文字引擎）可以问用户要不要存进来。'
        }
      }
      if (action === 'read') {
        const s = bpRead(args?.name)
        return {
          name: s.name,
          title: s.title,
          description: s.description,
          notes: s.notes,
          tags: s.tags,
          stats: s.stats,
          requires: s.requires,
          source: s.source,
          warnings: s.warnings,
          blocks: s.blocks,
          hint: 'blocks 是 sb3 dict，可直接喂 scratch_add_blocks；改参数用 add_blocks/update_block。若只想注入不改，用 scratch_backpack_load。'
        }
      }
      if (action === 'save') {
        const sid = needSession(args?.session)
        const name = bpSlug(args?.name || args?.title)
        if (!name) throw new Error('save 需要 name（或用 title 生成）')
        const file = bpPath(name)
        const prev = existsSync(file) ? (() => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null } })() : null
        if (prev && args?.overwrite !== true) {
          throw new Error(`背包里已经有「${name}」了。要覆盖传 overwrite: true；想另存就换个 name。`)
        }
        const exp = await call(sid, 'export_blocks', {
          target: args?.target,
          scriptIds: Array.isArray(args?.scriptIds) ? args.scriptIds : undefined,
          blockIds: Array.isArray(args?.blockIds) ? args.blockIds : undefined,
          all: args?.all === true ? true : undefined,
          listLimit: Number.isFinite(args?.listLimit) && args.listLimit > 0 ? Math.floor(args.listLimit) : undefined
        }, 60000)
        const now = new Date().toISOString()
        const snippet = {
          name,
          // 覆盖时不传元数据 = 保留上次写的（改完积木再存一次，不该把「怎么用」的笔记弄丢）
          title: args?.title || prev?.title || exp.topLevelOpcodes.join(' / ') || name,
          description: args?.description || prev?.description || '',
          notes: args?.notes || prev?.notes || '',
          tags: Array.isArray(args?.tags) ? args.tags : (args?.tags ? [String(args.tags)] : (prev?.tags || [])),
          createdAt: prev?.createdAt || now,
          updatedAt: now,
          source: {
            session: sid,
            project: exp.project || prev?.source?.project || '',
            target: exp.target,
            scripts: exp.scripts,
            blockCount: exp.blockCount,
            topLevelOpcodes: exp.topLevelOpcodes
          },
          stats: { blocks: exp.blockCount, scripts: exp.scripts },
          requires: exp.requires,
          warnings: exp.warnings,
          blocks: exp.blocks
        }
        const text = JSON.stringify(snippet, null, 2)
        mkdirSync(backpackDir, { recursive: true })
        writeFileSync(file, text)
        rebuildBackpackIndex()
        // 列表被截断是"取出来少一半字还不报错"那类坑，单独拎出来说，别混在 warnings 里
        const truncatedLists = (exp.requires.lists || []).filter(v => v.truncated)
          .map(v => `${v.name}（存了 ${(v.value || []).length} / 共 ${v.length}）`)
        return {
          saved: name,
          file,
          bytes: text.length,
          blocks: exp.blockCount,
          scripts: exp.scripts,
          requires: {
            variables: (exp.requires.variables || []).map(v => v.name),
            lists: (exp.requires.lists || []).map(v => `${v.name}(${(v.value || []).length}${v.truncated ? '/' + v.length : ''})`),
            broadcasts: (exp.requires.broadcasts || []).map(v => v.name)
          },
          truncatedLists: truncatedLists.length ? truncatedLists : undefined,
          overwritten: !!prev,
          warnings: truncatedLists.length
            ? [...(exp.warnings || []), `列表被截断了：${truncatedLists.join('、')} —— 取出来会缺项且不报错。要存全就带 listLimit（如 listLimit: ${Math.max(...(exp.requires.lists || []).map(v => v.length || 0))}）重存一次。`]
            : exp.warnings,
          hint: '存好了。下次用 scratch_backpack_load({ name }) 直接注进项目（变量/列表会按名字接上或补建）。'
        }
      }
      if (action === 'delete') {
        const s = bpRead(args?.name)
        const f = bpPath(s.name)
        mkdirSync(backpackTrashDir, { recursive: true })
        const dst = join(backpackTrashDir, `${bpSlug(s.name)}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
        renameSync(f, dst)
        rebuildBackpackIndex()
        return { deleted: s.name, movedTo: dst, hint: '没真删，挪进 _trash/ 了（想恢复就把它移回背包目录）。' }
      }
      throw new Error(`未知 action ${action}（list | read | save | delete）`)
    }
  }))

  ctx.tools.register(defineTool({
    name: 'scratch_backpack_load',
    description: '把背包里的一条注入到项目（带变量/列表补建：目标里没有的会被建出来，内容用背包存的那份）。'
      + 'x/y 给新位置（缺省 48,48；片段内部的相对排布会保留）。variableValues 可覆盖列表/变量的内容（如换字模表）。'
      + '写操作，受 safety 档位约束（preview 档会返回 planId，等 scratch_apply 落盘）。',
    parameters: {
      session: { type: 'string' },
      name: { type: 'string', required: true, description: '背包条目名（scratch_backpack list 里有）' },
      target: { type: 'string', description: '注到哪个角色，缺省当前编辑中的角色' },
      x: { type: 'number', description: '第一个脚本的左上角 x（工作区坐标）' },
      y: { type: 'number', description: '第一个脚本的左上角 y' },
      variableValues: { type: 'object', additionalProperties: true, description: '按名字覆盖变量/列表内容，如 {"字模": ["甲","乙"]}' }
    },
    output: jsonOut,
    async execute(args) {
      const sid = needSession(args?.session)
      const s = bpRead(args?.name)
      const blocks = shiftBackpackBlocks(s.blocks, args?.x, args?.y)
      // 变量/列表：用背包里存的声明（含值），再按 variableValues 覆盖
      const overrides = (args?.variableValues && typeof args.variableValues === 'object') ? args.variableValues : {}
      const declared = []
      for (const v of (s.requires?.variables || [])) declared.push({ name: v.name, type: 'variable', scope: v.scope, value: overrides[v.name] !== undefined ? overrides[v.name] : v.value })
      for (const v of (s.requires?.lists || [])) declared.push({ name: v.name, type: 'list', scope: v.scope, value: Array.isArray(overrides[v.name]) ? overrides[v.name] : v.value })
      for (const v of (s.requires?.broadcasts || [])) declared.push({ name: v.name, type: 'broadcast' })
      const preview = {
        snippet: s.name,
        title: s.title,
        target: args?.target || '(当前编辑角色)',
        blocks: Object.keys(blocks).length,
        creates: declared.map(d => `${d.name}${d.type === 'list' ? '[]' : ''}${d.scope === 'global' ? '(全局)' : ''}`)
      }
      const r = withChanged(await guardedWrite(sid, 'add_blocks', { target: args?.target, blocks, variables: declared },
        `pre-bp-${s.name}`, preview))
      return Object.assign({ snippet: s.name, at: { x: args?.x, y: args?.y }, declared: declared.map(d => d.name) }, r)
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
      y: { type: 'number', description: '新工作区坐标 y' },
      follow: { type: 'boolean', description: 'false = 改完不把视口滚到这个块（缺省会滚，用户看得见改了哪儿）' }
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
      return withChanged(await guardedWrite(sid, 'update_block',
        { target: args.target, blockId: args.blockId, changes, follow: args.follow === false ? false : undefined },
        'pre-update_block',
        { blockId: args.blockId, changes }))
    }
  }))

  ctx.tools.register(defineTool({
    name: 'scratch_variable',
    description: '变量 / 列表的增删改查（写操作，受 safety 档位管）。'
      + 'action=get 读（列表可给 index 或 from+count，**下标从 1 开始**，越界会直接报错而不是静默返回空串）/ '
      + 'set 赋值（kind=list 时 value 给数组 = 整体替换）/ create 新建 / delete 删除 / rename 改名。'
      + 'scope=global 挂舞台、local 挂当前角色；不传则先角色后舞台地找。'
      + 'delete 时如果还有积木在引用它会被拒绝，并列出是哪几个块；确认要连积木一起删就传 force:true。'
      + 'rename 会把引用它的积木字段一起改（不改就会变成「变量未找到」）。',
    parameters: {
      session: { type: 'string' },
      action: { type: 'string', required: true, description: 'get | set | create | delete | rename' },
      kind: { type: 'string', description: 'variable（缺省）| list' },
      name: { type: 'string', description: '变量名（create 必填；其它动作按名字找）' },
      id: { type: 'string', description: '变量 id（比名字更准，可选）' },
      scope: { type: 'string', description: 'global（舞台）| local（当前角色）；不传则两个都找' },
      target: { type: 'string', description: '局部变量所属角色，缺省当前编辑目标' },
      value: { type: 'json', description: 'set 的值；create 时可带初始值（列表给数组）' },
      index: { type: 'number', description: 'get + list：只读第几项（从 1 开始）' },
      from: { type: 'number', description: 'get + list：从第几项开始（从 1 开始，缺省 1）' },
      count: { type: 'number', description: 'get + list：读几项（缺省 50）' },
      newName: { type: 'string', description: 'rename 的新名字' },
      force: { type: 'boolean', description: 'delete 时连引用它的积木一起删' }
    },
    output: jsonOut,
    async execute(args) {
      const sid = needSession(args?.session)
      const action = String(args?.action || '')
      if (!action) throw new Error('action 必填：get / set / create / delete / rename')
      if (action === 'create' && !args?.name) throw new Error('create 需要 name')
      // get 是只读：直接调，不进 preview/快照那套（读个列表还等确认会很烦）
      if (action === 'get') {
        return await call(sid, 'variable', {
          target: args.target, action, kind: args.kind, name: args.name, id: args.id, scope: args.scope,
          index: args.index, from: args.from, count: args.count
        })
      }
      const valueMeta = Array.isArray(args?.value)
        ? `[${args.value.length} 项]`
        : (typeof args?.value === 'string' && args.value.length > 60 ? args.value.slice(0, 57) + '…' : args?.value)
      return await guardedWrite(sid, 'variable', {
        target: args.target, action, kind: args.kind, name: args.name, id: args.id,
        scope: args.scope, value: args.value, newName: args.newName, force: args.force === true
      }, `pre-variable-${action}`, {
        target: args.target, action, kind: args.kind || 'variable',
        name: args.name, id: args.id, scope: args.scope, newName: args.newName, value: valueMeta
      })
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
      return withChanged(await guardedWrite(sid, 'delete_blocks',
        { target: args.target, blockIds: args.blockIds },
        'pre-delete_blocks',
        { target: args.target, blockIds: args.blockIds }))
    }
  }))

  ctx.tools.register(defineTool({
    name: 'scratch_move_block',
    description: '断链 / 接链：把一块从它现在的位置摘下来、接到别处（**同一个角色内**）。'
      + 'mode=detach 摘成独立脚本（原来的断口会自动接上）；'
      + 'after 接到 toBlockId 后面（槽里已有块就插在中间，后面那段跟着走，不会丢）；'
      + 'before 插到 toBlockId 前面；input 塞进 toBlockId 的输入槽（inputName 例如 CONDITION / SUBSTACK / OPERAND1，被替换的块退回顶层、不删）。'
      + '跨角色搬积木请用背包（scratch_backpack save → scratch_backpack_load），别用这个。'
      + '接到自己的子孙上会被拒绝（成环会把工作区搞崩）。',
    parameters: {
      session: { type: 'string' },
      target: { type: 'string', description: '块所在角色，缺省当前编辑目标' },
      blockId: { type: 'string', required: true, description: '要移动的块 id' },
      mode: { type: 'string', description: 'detach | after | before | input（缺省 after）' },
      toBlockId: { type: 'string', description: '目标块 id（after / before / input 必填）' },
      inputName: { type: 'string', description: 'input 模式必填：目标输入槽名，如 CONDITION / SUBSTACK / OPERAND1' },
      follow: { type: 'boolean', description: 'false = 挪完不把视口滚过去（缺省会滚）' }
    },
    output: jsonOut,
    async execute(args) {
      const sid = needSession(args?.session)
      if (!args?.blockId) throw new Error('blockId 必填')
      return await guardedWrite(sid, 'move_block', {
        target: args.target, blockId: args.blockId, mode: args.mode,
        toBlockId: args.toBlockId, inputName: args.inputName,
        follow: args.follow === false ? false : undefined
      }, 'pre-move_block', {
        target: args.target, blockId: args.blockId, mode: args.mode || 'after',
        toBlockId: args.toBlockId, inputName: args.inputName
      })
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
      return withChanged(await guardedWrite(sid, 'tidy_blocks', { target: args.target }, 'pre-tidy_blocks',
        { target: args.target, note: '把该角色的全部顶层脚本按列重排' }))
    }
  }))

  ctx.tools.register(defineTool({
    name: 'scratch_get_opcodes',
    description: '两个用途：① 不传 opcode —— 列当前宿主全部可用 opcode（内置 + 已加载扩展），避免编造不存在的块；'
      + '② 传 opcode（或 opcodes 数组）—— 查这个块的**形状**：输入名、字段名。'
      + '写 add_blocks 之前查一次，就不会把 OPERAND1 塞进 operator_add（那种拼错不会报错，只会让算式恒为 0）。',
    parameters: {
      session: { type: 'string' },
      target: { type: 'string', description: '精灵名（不同目标扩展加载可能不同），缺省当前编辑目标' },
      opcode: { type: 'string', description: '查这个 opcode 的输入/字段名，如 "operator_add"' },
      opcodes: { type: 'array', description: '一次查多个（最多 20 个）' }
    },
    output: jsonOut,
    async execute(args) {
      const sid = needSession(args?.session)
      return await call(sid, 'get_opcodes', {
        target: args?.target,
        opcode: args?.opcode,
        opcodes: Array.isArray(args?.opcodes) ? args.opcodes : undefined
      })
    }
  }))

  // ==================== M2：观察者 / 双向联动 ====================

  ctx.tools.register(defineTool({
    name: 'scratch_watch',
    description: '订阅/读取变量变化（观察者模式）。action=start 开始监听目标角色变量（500ms 轮询）；action=poll 拉取当前值+积累的变化（拉完清空）；action=stop 停止。绿旗跑起来后用它看变量轨迹。'
      + '**列表变量默认不跟踪**（一个 16 万项的列表曾让单次 poll 回 14.8MB）——要看列表就 start 时传 includeLists:true，返回的是长度/首个变化位/样本，不是全量。',
    parameters: {
      session: { type: 'string' },
      action: { type: 'string', description: 'start | poll | stop（缺省 poll）' },
      target: { type: 'string', description: 'start 时指定要监听的角色' },
      includeLists: { type: 'boolean', description: 'start 时：是否跟踪列表变量（缺省 false）' }
    },
    output: jsonOut,
    async execute(args) {
      const sid = needSession(args?.session)
      const r = await call(sid, 'watch', {
        action: args?.action || 'poll',
        target: args?.target,
        includeLists: args?.includeLists === true ? true : undefined
      })
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

  // ==================== 运行控制 / 可观测 / 批处理（P0-2、P1-6、§16.4） ====================
  // 这一组来自问题记录里最贵的那部分：以前 AI 要自己连裸 CDP 写驱动脚本（36 个文件 2300 行）
  // 才能完成「点绿旗 → 看状态 → 截图 → 定位 → 改 → 再截图」这条闭环。现在收进插件。

  /** 截图落盘目录：快照目录的同级 scratch-shots/（快照目录可选配置，这里跟着走） */
  function shotsDir() {
    return join(dirname(snapDir), 'scratch-shots')
  }

  /** 截一张编辑器窗口。只有 CDP 会话能截（扩展那条路在浏览器里没有截图权限） */
  // ---------------- 截图（D3 裁剪 + G9 帧心跳） ----------------
  // 两个真机教训：
  //   D3：整窗 1899×1145，舞台只占约 1/4，想确认画面细节只能靠肉眼放大 → 支持 region: stage / workspace。
  //   G9：窗口"假活"时（VM 在跑、界面已冻结）连续两张截图**字节完全相同**。
  //       所以每张都回 frameHash，并和上一张比：一样就明确说"可能是旧帧"。
  const shotHashOf = (buf) => createHash('sha1').update(buf).digest('hex').slice(0, 16)

  async function shotRegionRect(s, region) {
    if (!s || !s.cdp || typeof s.cdp.evaluate !== 'function') return null
    const expr = region === 'stage'
      ? `(() => {
          const el = document.querySelector('[class*="stage_stage"] canvas') || document.querySelector('[class*="stage_stage"]') || document.querySelector('canvas');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return (r.width > 10 && r.height > 10) ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
        })()`
      : `(() => {
          const el = document.querySelector('.blocklySvg') || document.querySelector('[class*="blocks_blocks"]');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return (r.width > 10 && r.height > 10) ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
        })()`
    try {
      const r = await s.cdp.evaluate(expr)
      if (!r || !Number.isFinite(r.width) || r.width < 10) return null
      return r
    } catch { return null }
  }

  async function captureShot(sid, args) {
    const s = sessions.get(sid)
    if (!s || !s.cdp || typeof s.cdp.cdpSend !== 'function') {
      throw new Error('截图只能走桌面版 CDP 会话（网页版走扩展那条路，页面里没有截图权限）。'
        + '先用 scratch_open_editor({ app: "desktop" }) 连一个桌面版。')
    }
    const format = String(args?.format || 'png').toLowerCase() === 'jpeg' ? 'jpeg' : 'png'
    const params = { format }
    if (format === 'jpeg') params.quality = Math.min(Math.max(Number(args?.quality) || 80, 1), 100)
    // D3：region=stage / workspace 只截那块（默认 full 整窗）
    const region = ['stage', 'workspace'].includes(String(args?.region || '')) ? String(args.region) : 'full'
    let rect = null
    let regionFallback = null
    if (region !== 'full') {
      rect = await shotRegionRect(s, region)
      if (!rect) regionFallback = `拿不到 ${region} 的矩形（GUI 还没挂载 / 选择器变了），这次退回整窗截图`
      else params.clip = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height), scale: 1 }
    }
    const r = await s.cdp.cdpSend('Page.captureScreenshot', params, 20000)
    const b64 = r && r.data
    if (!b64) throw new Error('CDP 没回截图数据')
    const buf = Buffer.from(b64, 'base64')
    // G9：和上一张比。窗口冻结时连续截图字节相同 —— 这是唯一能自动发现的信号。
    const frameHash = shotHashOf(buf)
    const prev = s.lastShot
    const sameAsPrev = !!(prev && prev.hash === frameHash)
    const capturedAt = new Date().toISOString()
    s.lastShot = { hash: frameHash, at: capturedAt, region }
    let out
    const want = args?.path ? resolve(String(args.path)) : null
    if (want) {
      mkdirSync(dirname(want), { recursive: true })
      writeFileSync(want, buf)
      out = { path: want, bytes: buf.length, format, region }
    } else {
      const dir = shotsDir()
      mkdirSync(dir, { recursive: true })
      const ts = capturedAt.replace(/[:.]/g, '-').slice(0, 19)
      const file = join(dir, `shot-${ts}${region !== 'full' ? '-' + region : ''}.${format === 'jpeg' ? 'jpg' : 'png'}`)
      writeFileSync(file, buf)
      out = {
        path: file,
        bytes: buf.length,
        format,
        region,
        hint: '把 path 用 markdown 图片给用户看（![截图](绝对路径)），或者自己 read_image 核对画面'
      }
    }
    out.capturedAt = capturedAt
    out.frameHash = frameHash
    out.sameAsPrev = sameAsPrev || undefined
    out.size = rect ? { width: params.clip.width, height: params.clip.height } : undefined
    out.regionFallback = regionFallback || undefined
    if (sameAsPrev) {
      out.frozenHint = '这张和上一张**字节完全相同**（frameHash 一样）。如果 VM 同时在跑，多半是界面冻结了'
        + '（G9：VM 在跑、舞台/画面不动，绿旗和停止按钮也没反应）→ 用 scratch_selftest 看"帧心跳"，'
        + '或 scratch_restart_window 杀掉重开（会顺手把当前作品重新装上）。'
    }
    return out
  }

  /** 只取一个帧哈希（帧心跳用，不落盘） */
  async function frameHashOnce(s) {
    const r = await s.cdp.cdpSend('Page.captureScreenshot', { format: 'png' }, 20000)
    if (!r || !r.data) return null
    return shotHashOf(Buffer.from(r.data, 'base64'))
  }

  ctx.tools.register(defineTool({
    name: 'scratch_run',
    description: '控制项目运行：greenflag 点绿旗（顺手确保 VM 在跑）、stopall 停止全部线程（红灯）、start/stoploop 起停 VM 循环。'
      + '默认**只回** running/threads/clones/stepMs 这几个数（D5：以前每次都回完整 before/after 状态转储，30+ 变量 + 38 个列表长度）。'
      + '要看全量变量/线程就传 detail:true。running:true **只代表 VM 有活线程**，不代表界面在响应（窗口假活看 scratch_selftest 的帧心跳）。'
      + '**别用固定时长等游戏走到某一步**，用 until 等状态：{var:"MODE",op:"==",value:2}（op 支持 == != > < >= <= contains）。'
      + 'waitMs 上限 30000（以前 5000，真机实测"跑到 Boss"十几秒根本不够）。',
    parameters: {
      session: { type: 'string' },
      action: { type: 'string', description: 'greenflag | stopall | start | stoploop（缺省 greenflag）' },
      waitMs: { type: 'number', description: '动作后等多久再读数（缺省 300ms；给了 until 时它是**超时上限**，缺省 10000，最大 30000）' },
      until: { type: 'object', additionalProperties: true, description: '等到条件满足就立刻返回：{var:"变量名", op:"==", value:期望值}；返回 until:{met,waitedMs,value,reason}' },
      detail: { type: 'boolean', description: 'true = 连完整状态（页面变量、克隆体分布、线程清单）一起回' }
    },
    output: jsonOut,
    async execute(args) {
      const sid = needSession(args?.session)
      return await call(sid, 'run', {
        action: args?.action || 'greenflag',
        waitMs: args?.waitMs,
        until: args?.until && typeof args.until === 'object' ? args.until : undefined,
        detail: args?.detail === true
      }, 40000)
    }
  }))

  ctx.tools.register(defineTool({
    name: 'scratch_state',
    description: '读运行时状态（只读）：running（有没有线程在跑）、threads、targets、克隆体分布、stepMs/fps、舞台标量变量。'
      + '列表默认只报长度，但会给 pageListDelta（和上一次 state 比，C2：列表是不是在泄漏不用再靠运气发现）。'
      + '想看某几项就传 listSlice:{name, from, count}（**下标从 1 开始**）；要一次看多条就传数组 '
      + 'listSlice:[{name:"E_ALIVE"},{name:"O_HP",from:4,count:12}]（或简写 ["E_ALIVE","O_HP"]），'
      + '结果在 listSlices 里（以前一次只能问一条，查 4 条列表要 4 次调用）。'
      + '「点了没反应」「到底跑没跑」这类问题先看这个；但 running:true 只代表 VM 在跑，界面是否冻结看 scratch_selftest。',
    parameters: {
      session: { type: 'string' },
      target: { type: 'string', description: '顺带报这个角色的坐标/大小/可见/局部变量' },
      includeLists: { type: 'boolean', description: '把列表内容也回传（长列表会很大，缺省只看长度）' },
      listSlice: { type: 'object', additionalProperties: true, description: '只读某个列表的一段：{name:"列表名", from:1, count:20}（from 从 1 开始）' },
      listSlices: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '一次读多条列表：[{name:"E_ALIVE"},{name:"O_HP",from:4,count:12}]' }
    },
    output: jsonOut,
    async execute(args) {
      const sid = needSession(args?.session)
      return await call(sid, 'state', {
        target: args?.target,
        includeLists: args?.includeLists === true,
        listSlice: args?.listSlice,
        listSlices: Array.isArray(args?.listSlices) ? args.listSlices : undefined
      })
    }
  }))

  ctx.tools.register(defineTool({
    name: 'scratch_click',
    description: '点舞台上的东西：给 target（按名字找角色/克隆体，用造型包围盒中心）或给 x/y（舞台坐标 -240..240 / -180..180）。'
      + '先发真实鼠标事件，再用 renderer.pick 确认**这个坐标上到底有没有东西**（F4：以前 hatsStarted:0 但流程确实推进了，'
      + '分不清是"没命中"还是"命中了但没点击帽子"）。'
      + '返回：pick（命中谁）/ pickMissed / started（这次新起了哪些线程）/ hatsStarted / via / changedVars（**点击前后变量变了哪几个**）。'
      + 'hatsStarted:0 且 threads>0 时会明确说"流程可能是已有线程推进的，别据此判断点击失败"——'
      + '实测广播接收线程在同一 tick 里跑完时 hatsStarted 经常是 0，这时看 changedVars 才是准的。',
    parameters: {
      session: { type: 'string' },
      target: { type: 'string', description: '要点的角色名（有克隆体时优先可见的那个）' },
      costume: { type: 'string', description: '用造型名进一步筛（克隆体区分用）' },
      x: { type: 'number', description: '舞台坐标 x（不点角色、点某个位置时用）' },
      y: { type: 'number', description: '舞台坐标 y' }
    },
    output: jsonOut,
    async execute(args) {
      const sid = needSession(args?.session)
      return await call(sid, 'click', {
        target: args?.target, costume: args?.costume, x: args?.x, y: args?.y
      }, 30000)
    }
  }))

  ctx.tools.register(defineTool({
    name: 'scratch_press_key',
    description: '按一个键（空格用 " "、方向键 "ArrowUp"、字母 "a"、"Enter"），按下 holdMs 后松开。给游戏类项目的输入用。',
    parameters: {
      session: { type: 'string' },
      key: { type: 'string', description: 'DOM 键名' },
      holdMs: { type: 'number', description: '按住多久，缺省 80ms' }
    },
    output: jsonOut,
    async execute(args) {
      const sid = needSession(args?.session)
      return await call(sid, 'press_key', { key: args?.key || ' ', holdMs: args?.holdMs }, 30000)
    }
  }))

  ctx.tools.register(defineTool({
    name: 'scratch_profile',
    description: '量性能：采样 VM 每一步的耗时（runtime.currentStepTime），给 avg/p50/p95/max 和反推的 fps。'
      + '比项目里那个 fps 变量可信（那个常常是存档残留值）。'
      + '**默认还做归因**（attribution）：每隔 100ms 看每个线程正卡在哪个块、顺着父链归到哪条脚本 —— '
      + '于是「p95 是 12ms」这种数字能接着回答「是哪条脚本吃的帧」。'
      + 'attribution 里的 pct 是有线程卡在这条脚本上的采样占比；「等 1 秒」这类空转单独算 waitPct，不算热点。'
      + '⚠️ TurboWarp 的「编译器」开着时（桌面版默认开）脚本被编译成 JS、线程栈不移动，'
      + '这时只能给脚本级（granularity:"script"，看哪条脚本的线程活着），要块级热点得先在设置里关掉编译器。',
    parameters: {
      session: { type: 'string' },
      seconds: { type: 'number', description: '采样几秒（缺省 3，上限 10）' },
      attribution: { type: 'boolean', description: 'false = 只量总耗时，不做热点归因' },
      topN: { type: 'number', description: '热点榜取前几名（缺省 8，上限 20）' }
    },
    output: jsonOut,
    async execute(args) {
      const sid = needSession(args?.session)
      return await call(sid, 'profile', {
        seconds: args?.seconds,
        attribution: args?.attribution === false ? false : undefined,
        topN: args?.topN
      }, 30000)
    }
  }))

  ctx.tools.register(defineTool({
    name: 'scratch_list_scripts',
    description: '列出一个角色的顶层脚本清单（id / opcode / 块数 / 调用的自定义积木 / 自定义积木名），并且**分三档**：'
      + 'kind=script（帽子块打头的真脚本）、kind=definition（**自定义积木定义** —— 带 calledBy/warp/params，'
      + '这是引擎主干、不是垃圾；C1 那次把 32 个定义当成"游离块"差点删掉作者的核心函数）、'
      + 'kind=loose（作者调试拖出来的真·游离块）。kind=called 只看"被调用过的定义"。'
      + '块数是**展开视图**（含物化影子块），blockCountRaw 才是 project.json 里的真块数（B2：以前三个 API 三个口径）。'
      + '要读某段脚本的块体就把它 blockId 传给 scratch_read_script({ scriptId })。',
    parameters: {
      session: { type: 'string' },
      target: { type: 'string', description: '角色名，缺省当前编辑角色' },
      kind: { type: 'string', description: 'all | script | definition | loose | called（缺省 all）' },
      minBlocks: { type: 'number', description: '只看块数 >= N 的' },
      limit: { type: 'number', description: '最多回几条（缺省 100）' }
    },
    output: jsonOut,
    async execute(args) {
      const sid = needSession(args?.session)
      return await call(sid, 'list_scripts', {
        target: args?.target, kind: args?.kind, minBlocks: args?.minBlocks, limit: args?.limit
      })
    }
  }))

  ctx.tools.register(defineTool({
    name: 'scratch_screenshot',
    description: '截当前编辑器窗口（CDP Page.captureScreenshot，实测 180-208ms），返回落盘路径 + 字节数。'
      + 'region:"stage" 只截舞台、"workspace" 只截积木区（D3：整窗里舞台只占 1/4，看不清细节）。'
      + '每次都回 frameHash；和上一张**完全相同**会标 sameAsPrev + frozenHint（界面冻结的信号，见 scratch_selftest 的"帧心跳"）。'
      + '只有桌面版 CDP 会话能用（浏览器扩展那条路没有这个能力，也不打算加 —— 要截图就用 open_editor({app:"desktop"}) 开桌面版）。',
    parameters: {
      session: { type: 'string' },
      path: { type: 'string', description: '存到哪（缺省 <快照目录同级>/scratch-shots/时间戳.png）。要交付/写进 README 就直接给项目里的路径，省得再拷一次' },
      format: { type: 'string', description: 'png | jpeg（缺省 png）' },
      quality: { type: 'number', description: 'jpeg 质量 1-100（缺省 80）' },
      region: { type: 'string', description: 'full（缺省）| stage（只截舞台）| workspace（只截积木区）' }
    },
    output: jsonOut,
    async execute(args) {
      const sid = needSession(args?.session)
      return await captureShot(sid, args)
    }
  }))

  // 批处理白名单：只读 + 运行期动作 + **轻量写**。
  // 为什么加 variable：从零建工程要 8 个变量 + 3 个列表，不许进批处理就是 11 次串行往返（G6）。
  // 但只放开 variable 的 create/set —— 它们只动变量表，不碰积木结构，风险远低于 add/update/delete；
  // 而且仍然会先快照（批处理这条路上不走 preview，所以只给"最不可能出事"的那几个动作）。
  const BATCH_OPS = new Set([
    'project_meta', 'snapshot', 'read_script', 'list_scripts', 'get_opcodes',
    'watch', 'user_context', 'state', 'profile', 'locate', 'run', 'click', 'press_key',
    'inspect', 'project_overview'
  ])
  const BATCH_LIGHT_WRITES = { variable: new Set(['create', 'set']) }

  ctx.tools.register(defineTool({
    name: 'scratch_batch',
    description: '一次往返做多件事（把 N 次工具调用压成 1 次；真机实测把 7 条命令合并后总耗时从 N×等待降到几百毫秒）。'
      + 'calls 是 [{op, args}] 数组，顺序执行，逐条返回 ok/result 或 error，单条失败不影响后面。'
      + `只允许只读/运行期 op：${[...BATCH_OPS].join(', ')}，外加 screenshot（截图，特殊处理）、`
      + 'variable 的 create/set（轻量写，只动变量表不碰积木；批处理里不走 preview，只给这两个动作）。'
      + 'add/update/delete/tidy/load/save 这些**改结构的**写操作必须单独调（要过 preview/apply 确认）。',
    parameters: {
      session: { type: 'string' },
      calls: { type: 'array', description: '形如 [{ op: "state" }, { op: "variable", args: { action:"create", name:"x", kind:"variable" } }]' }
    },
    output: jsonOut,
    async execute(args) {
      const sid = needSession(args?.session)
      const calls = Array.isArray(args?.calls) ? args.calls : null
      if (!calls || !calls.length) throw new Error('calls 必填：如 [{ op: "state" }]')
      if (calls.length > 12) throw new Error(`一次最多 12 条（收到 ${calls.length} 条）—— 再多就分两批，别一条消息里塞爆`)
      const results = []
      const t0 = Date.now()
      for (const c of calls) {
        const op = String(c?.op || '')
        const t1 = Date.now()
        if (op === 'screenshot') {
          try {
            results.push({ op, ok: true, ms: Date.now() - t1, result: await captureShot(sid, c?.args || {}) })
          } catch (e) {
            results.push({ op, ok: false, ms: Date.now() - t1, error: e.message })
          }
          continue
        }
        const lightAction = BATCH_LIGHT_WRITES[op]
        if (lightAction) {
          const act = String(c?.args?.action || '')
          if (!lightAction.has(act)) {
            results.push({ op, ok: false, error: `批处理里只允许 variable 的 ${[...lightAction].join('/')}（收到 action:"${act}"）；其它动作请单独调` })
            continue
          }
          try {
            const r = await call(sid, op, c?.args || {})
            results.push({ op, ok: true, ms: Date.now() - t1, result: r })
          } catch (e) {
            results.push({ op, ok: false, ms: Date.now() - t1, error: e.message })
          }
          continue
        }
        if (!BATCH_OPS.has(op)) {
          results.push({ op, ok: false, error: `op "${op}" 不在批处理白名单里（只读/运行期 + variable 轻写）：${[...BATCH_OPS].join(', ')}` })
          continue
        }
        try {
          results.push({ op, ok: true, ms: Date.now() - t1, result: await call(sid, op, c?.args || {}) })
        } catch (e) {
          results.push({ op, ok: false, ms: Date.now() - t1, error: e.message })
        }
      }
      return {
        count: results.length,
        failed: results.filter(r => !r.ok).length,
        ms: Date.now() - t0,
        results
      }
    }
  }))

  ctx.tools.register(defineTool({
    name: 'scratch_selftest',
    description: '自检一遍整条链路：桥还在监听吗、有没有会话、CDP 注入活着吗、项目/角色就绪吗、Blockly 工作区在不在、桌面版窗口可见吗，'
      + '以及**帧心跳**（连截两张比哈希 —— G9 那种"VM 在跑、界面已冻结、但所有自检全绿"的情况只有这一项能发现）。'
      + '用户说"连不上/没反应/看不到/点了没反应"时先跑这个，别猜。',
    parameters: {
      session: { type: 'string' },
      heartbeat: { type: 'boolean', description: '是否做帧心跳（缺省 true；会多花约 0.5s 截两张图）' }
    },
    output: jsonOut,
    async execute(args) {
      const checks = []
      const add = (check, ok, detail) => checks.push({ check, ok: !!ok, detail })
      add('bridge 监听', bridgeListening, bridgeListening ? `127.0.0.1:${bridgePortLive}` : `没在监听（想要 ${cfg.bridgePort}，可能被别的进程占了）`)
      const sid = args?.session || activeSession()
      add('有会话', !!sid, sid ? `${sid}（${sessions.get(sid)?.meta?.transport || '?'}）` : '没有已连接的编辑器')
      if (!sid) {
        return {
          ok: false,
          checks,
          hint: '没有会话。最快：scratch_open_editor({ app: "desktop", path }) —— 零安装零 token；'
            + '网页版要先装 tw-bridge-extension 并填 token（scratch_list_sessions 的 setup 里有）'
        }
      }
      const s = sessions.get(sid)
      const isCdp = !!(s && s.cdp)
      if (s && s.loading) add('装载中', null, '文件正在后台装载（下一条工具调用会自动等它装完）')
      add('CDP 注入', !isCdp ? null : !!(s.cdp.raw && s.cdp.raw.injected), isCdp
        ? (s.cdp.state ? s.cdp.state() : (s.cdp.raw && s.cdp.raw.injected ? '已注入' : '执行器没注进去'))
        : '这条会话走扩展，不经 CDP')
      const meta = await call(sid, 'project_meta').catch((e) => ({ error: e.message }))
      const ready = !!(meta && Array.isArray(meta.targets) && meta.targets.length)
      add('项目就绪', ready, ready ? `${meta.targets.length} 个角色/舞台` : (meta?.error || '编辑器里还没有角色（冷启动未完成或空项目）'))
      if (isCdp && typeof s.cdp.evaluate === 'function') {
        const hasBlockly = await s.cdp.evaluate('!!(window.ScratchBlocks||window.Blockly)').catch(() => null)
        add('Blockly 工作区', hasBlockly, hasBlockly ? '在' : '拿不到（积木区没挂载 / 播放器页）—— locate 会失败，读写不受影响')
        const hasVm = await s.cdp.evaluate('typeof window.vm').catch(() => 'unknown')
        add('window.vm', hasVm === 'object', String(hasVm))
        const win = desktopWindowInfo({ pid: s.meta && s.meta.pid, show: false })
        if (win) {
          add('窗口可见', win.visible && !win.minimized,
            `pid=${win.pid} hwnd=${win.hwnd} visible=${win.visible} minimized=${win.minimized} rect=${JSON.stringify(win.rect)} title=${win.title || '(空)'}`
            + (win.visible ? '' : ' ← 用户看不到编辑器；scratch_open_editor({ app: "desktop" }) 会顺手 ShowWindow 救回来'))
        } else {
          add('窗口可见', null, '查不到（powershell 起不来或不是 Windows）')
        }
        // G9：帧心跳。这一项比上面所有项都值钱 —— 真机上那 7 项全绿的时候，
        // 用户点了绿旗/停止毫无反应、舞台画面冻结，而 VM 线程还在跑（变量还在涨）。
        // 唯一能自动发现的信号就是"连截两张，字节完全相同"。
        if (args?.heartbeat !== false && typeof s.cdp.cdpSend === 'function') {
          try {
            const running = !!(await call(sid, 'state').then(x => x && x.running).catch(() => false))
            const h1 = await frameHashOnce(s)
            await sleep(400)
            const h2 = await frameHashOnce(s)
            const same = !!(h1 && h2 && h1 === h2)
            add('帧心跳', same && running ? false : true, same && running
              ? `连截两张**字节完全相同**（${h1}），但 VM 有线程在跑 → **界面很可能已冻结**：用户点绿旗/停止没反应就是这个。`
                + '用 scratch_restart_window 杀掉重开（会顺手把当前作品装回来）'
              : (same ? `两张相同（${h1}），但 VM 没在跑 —— 静态画面，正常` : `画面在动（${h1} → ${h2}）`))
          } catch (e) {
            add('帧心跳', null, '截图失败：' + e.message)
          }
        }
      }
      const failed = checks.filter(c => c.ok === false).length
      return {
        ok: failed === 0,
        failed,
        checks,
        hint: failed
          ? '看 ok:false 的那几条；detail 里就是原因。帧心跳 false → 窗口假活，scratch_restart_window；'
            + '窗口不可见 → open_editor 会救；Blockly 拿不到 → locate 用不了但读写照常。'
          : '全绿：桥、会话、注入、项目、工作区、窗口、画面都在位，可以直接干活'
      }
    }
  }))

  // ==================== v0.10.0：结构总览 / 单块上下文 / 空白作品 / 角色改名 / 重启窗口 ====================

  ctx.tools.register(defineTool({
    name: 'scratch_project_overview',
    description: '一次看清整个项目结构（D1）：每个角色/舞台的 opcode 直方图、自定义积木清单（参数原型 / 是否 warp / 被调用几次）、'
      + '调用关系、每段脚本一行摘要。**读代码前先跑这个**，比 N 次 list_scripts/read_script 拼便宜得多，也不会被截断。'
      + '块数是**展开视图**（含物化影子块）；blockCountRaw 才是 project.json 里的真块数（两个都给了，别再对不上账）。',
    parameters: {
      session: { type: 'string' },
      target: { type: 'string', description: '只看这个角色（缺省全部）' },
      topOpcodes: { type: 'number', description: '每个角色列前 N 个 opcode（缺省 12，上限 40）' },
      scriptsPerTarget: { type: 'number', description: '每个角色列前 N 段脚本（缺省 12）' }
    },
    output: jsonOut,
    async execute(args) {
      const sid = needSession(args?.session)
      return await call(sid, 'project_overview', {
        target: args?.target, topOpcodes: args?.topOpcodes, scriptsPerTarget: args?.scriptsPerTarget
      })
    }
  }))

  ctx.tools.register(defineTool({
    name: 'scratch_inspect',
    description: '看**一个块**的上下文（F3）：它挂在谁下面（parent + 是哪个输入槽）、next 是谁、每个输入接了什么/字面量值多少、'
      + '它属于哪条脚本（帽子块 + 嵌套深度）、子树多少块。'
      + '插完/改完想确认"位置对不对"就查这个 —— 不用整段读（354 块 ≈ 100KB）也不用整份 snapshot（1.8MB）。',
    parameters: {
      session: { type: 'string' },
      blockId: { type: 'string', required: true, description: '要看的块 id' },
      target: { type: 'string', description: '块所在角色（缺省当前编辑角色）' }
    },
    output: jsonOut,
    async execute(args) {
      const sid = needSession(args?.session)
      if (!args?.blockId) throw new Error('blockId 必填')
      return await call(sid, 'inspect', { blockId: args.blockId, target: args.target })
    }
  }))

  ctx.tools.register(defineTool({
    name: 'scratch_new_project',
    description: '新建一个**空白作品**（G1：以前只能自己手写最小 sb3、md5 命名资源、拼 targets 结构）。'
      + '插件现场生成一份标准 sb3（舞台 + 一个角色，各带一个内联 SVG 造型）并装进编辑器；'
      + '传 savePath 还会顺手落盘一份给你（等价于"新建并保存"）。'
      + '⚠️ 会顶掉编辑器里当前项目 —— 已经自动快照（scratch_rollback 可回）。',
    parameters: {
      session: { type: 'string' },
      sprite: { type: 'string', description: '角色名（缺省「角色1」）' },
      backdrop: { type: 'string', description: '背景名（缺省「背景1」）' },
      costume: { type: 'string', description: '角色造型名（缺省「造型1」）' },
      spriteColor: { type: 'string', description: '角色颜色（CSS 颜色，缺省 #4c97ff）' },
      savePath: { type: 'string', description: '顺便存到这个 .sb3 路径（可选）' }
    },
    output: jsonOut,
    async execute(args) {
      const sid = needSession(args?.session)
      const built = buildBlankProject({
        spriteName: args?.sprite,
        backdropName: args?.backdrop,
        costumeName: args?.costume,
        spriteColor: args?.spriteColor
      })
      const r = await loadBytesIntoSess(sid, built.buffer, 'new-project.sb3', 'pre-new_project')
      const out = Object.assign({ created: true, files: built.files }, r)
      if (args?.savePath) {
        const p = resolve(String(args.savePath))
        mkdirSync(dirname(p), { recursive: true })
        writeFileSync(p, built.buffer)
        out.savedTo = p
      }
      out.hint = '空白作品已经装好了：可以直接 scratch_add_blocks 往里写；'
        + '想改角色名用 scratch_target({ action: "rename", to: "新名字" })'
      return out
    }
  }))

  ctx.tools.register(defineTool({
    name: 'scratch_target',
    description: '角色级的操作：action:"list" 列角色（名字 / 是否舞台 / 块数 / 造型数），'
      + 'action:"rename" 给角色改名（G2：以前改不了，只能手改 project.json；会同步引用角色名的积木，重名会自动去重），'
      + 'action:"delete" 删角色（连同它的克隆体；**不能**删舞台、也不会删最后一个角色）。'
      + '新建角色用 scratch_add_sprite。',
    parameters: {
      session: { type: 'string' },
      action: { type: 'string', description: 'list（缺省）| rename | delete' },
      target: { type: 'string', description: 'rename / delete 的目标角色名' },
      to: { type: 'string', description: 'rename 的新名字' }
    },
    output: jsonOut,
    async execute(args) {
      const sid = needSession(args?.session)
      const action = String(args?.action || 'list')
      if (action === 'list') {
        const meta = await call(sid, 'project_meta')
        return {
          editingTarget: meta.editingTarget,
          targets: (meta.targets || []).map(t => ({
            name: t.name, isStage: t.isStage, blockCount: t.blockCount, costumes: (t.costumes || []).length
          }))
        }
      }
      if (action === 'rename') {
        if (!args?.to) throw new Error('rename 需要 to（新名字）')
        return withChanged(await guardedWrite(sid, 'rename_target', { target: args.target, to: args.to },
          `pre-rename-${args.target || ''}`, { target: args.target, to: args.to }))
      }
      if (action === 'delete') {
        if (!args?.target) throw new Error('delete 需要 target（要删哪个角色）')
        return withChanged(await guardedWrite(sid, 'delete_sprite', { target: args.target },
          `pre-delete-${args.target}`, { target: args.target }))
      }
      throw new Error(`未知 action "${action}"（list / rename / delete）`)
    }
  }))

  ctx.tools.register(defineTool({
    name: 'scratch_restart_window',
    description: '把桌面版窗口**杀掉重开**（G9 的恢复动作）：窗口"假活"时（VM 在跑、界面冻结、绿旗停止按钮没反应、自检全绿）用这个。'
      + '会按当前 pid 结束进程，再用调试端口重新拉起，并把**上次打开的作品文件**重新装回去（reload:false 则不装）。'
      + '⚠️ 是破坏性动作：没存盘的改动会丢（所以重开前先 scratch_save_project）。',
    parameters: {
      session: { type: 'string' },
      reload: { type: 'boolean', description: '重开后把上次打开的 sb3 再装回去（缺省 true）' },
      show: { type: 'boolean', description: '是否显示窗口（缺省 true）' }
    },
    output: jsonOut,
    async execute(args) {
      const sid = needSession(args?.session)
      const s = sessions.get(sid)
      if (!s || !s.cdp) throw new Error('只有桌面版 CDP 会话能重启窗口（网页版：让用户自己刷新那个标签页）')
      const pid = Number(s.meta && s.meta.pid) || 0
      if (!pid) throw new Error('不知道这个窗口的 pid（可能接的是别人的实例），不敢乱杀')
      const port = Number(s.meta && s.meta.debugPort) || 0
      const filePath = s.lastProjectPath || null
      const found = findDesktopApp()
      if (!found.path) throw new Error('找不到 TurboWarp Desktop 可执行文件，重启不了')
      const alive = (p) => {
        try {
          const o = execFileSync('tasklist', ['/FI', `PID eq ${p}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
          return o.includes(String(p))
        } catch { return false }
      }
      dropSession(sid, '重启窗口（用户/AI 要求）')
      try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* 可能已经退了 */ }
      for (let i = 0; i < 40 && alive(pid); i++) await sleep(250)
      const newPort = port || await findFreePort()
      const launched = { app: 'desktop', path: found.path, via: found.via, debugPort: newPort, restartedFrom: pid }
      try { launched.pid = spawnDetached(found.path, [`--remote-debugging-port=${newPort}`]) } catch (e) { launched.error = e.message }
      const out = await cdpAttachAndReport({
        port: newPort,
        launched,
        wantPath: args?.reload === false ? null : filePath,
        waitMs: 30000,
        show: args?.show !== false
      })
      return Object.assign({
        restarted: true,
        killedPid: pid,
        reloadedFrom: args?.reload === false ? undefined : (filePath || undefined)
      }, out)
    }
  }))

  // 桥启动放最后（工具注册失败时不占端口）
  startBridge().catch(e => log.error('桥启动失败: %s', e.message))
}
