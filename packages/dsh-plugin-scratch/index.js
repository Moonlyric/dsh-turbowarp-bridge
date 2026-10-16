// dsh-plugin-scratch — M0 原型入口
// 把 TurboWarp 编辑器接入 DeepSeek Harness：
//   本插件 = WebSocket 桥（服务端） + scratch_* 工具
//   tw-bridge-extension（MV3 扩展）= 桥客户端 + turbowarp.org 页面 MAIN world 执行器
//
// 工具注册走 @deepseek-ai/dsh-tools 的 defineTool（0.2.0-rc.2 实测通过）。

import { defineTool as rawDefineTool } from '@deepseek-ai/dsh-tools'
import { homedir } from 'node:os'
import { join, dirname, resolve, sep } from 'node:path'
import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, copyFileSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
import { basename } from 'node:path'

export const name = 'dsh-plugin-scratch'
export const inject = ['tools'] // dsh 规范：用到 ctx.tools 必须声明，框架保证注入后才加载

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
  log.info('TurboWarp bridge plugin loaded, safety=%s port=%s', config.safety, config.bridgePort)

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
    function listen() {
      let wss
      try {
        wss = new WebSocketServer({ host: '127.0.0.1', port: config.bridgePort })
      } catch (e) {
        log.error('桥服务创建失败: %s', e.message)
        schedule()
        return
      }
      attach(wss)
      wss.on('listening', () => {
        attempts = 0
        log.info('桥监听 %s:%d（等浏览器扩展连进来）', '127.0.0.1', config.bridgePort)
      })
      wss.on('error', (e) => {
        if (e && e.code === 'EADDRINUSE') {
          // 自己人重入（比如同一 profile 被加载两次）也会走到这儿
          log.warn('端口 %d 已被占用，%ds 后重试（另一个 dsh 实例/残留进程占着？）',
            config.bridgePort, RETRY_BRIDGE_MS / 1000)
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
      if (attempts === 12) log.error('端口 %d 连续 %d 次被占用，桥仍未起来（用户会连不上）', config.bridgePort, attempts)
    }
    // dsh 规范：手动资源用 ctx.effect 注册清理（卸载/热替换时自动调用）
    ctx.effect(() => () => {
      clearTimeout(retryTimer)
      try { activeWss && activeWss.close() } catch {}
    })
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

        const s = sessions.get(id)
        if (!s) return
        // 扩展的 WebSocket 在 MV3 service worker 里，SW 空闲 ~30s 就会被回收、socket 跟着死。
        // Chrome 116+ 把 WebSocket 的收发算作 SW 的活动，所以这个 pong 是**必须回**的：
        // 不回 = 放任对面掉线。对接方每 20s ping 一次。
        if (msg.type === 'ping') { try { socket.send('{"type":"pong"}') } catch {} ; return }
        if (msg.type === 'watch') {
          // M2 观察者：扩展侧轮询到的变量变化帧，存队列等 scratch_watch 拉
          s.watchEvents.push(...(msg.changes || []).map(c => Object.assign({ at: msg.at, target: msg.target }, c)))
          if (s.watchEvents.length > MAX_EVENTS) s.watchEvents.splice(0, s.watchEvents.length - MAX_EVENTS)
        } else if (msg.type === 'event') {
          // M2 双向联动：绿旗等运行事件
          s.userEvents.push(msg)
          if (s.userEvents.length > MAX_EVENTS) s.userEvents.splice(0, s.userEvents.length - MAX_EVENTS)
        } else if (msg.type === 'hello') {
          s.meta = msg.meta || s.meta // 允许重发 hello 更新 meta
        } else if (msg.id && pending.has(msg.id)) {
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
      })
      socket.on('close', () => {
        clearTimeout(authTimer)
        if (!sessions.has(id)) return
        sessions.delete(id)
        // 掉线时立刻把这会话的挂起请求全部拒掉，别让调用方干等 15s 超时
        for (const [reqId, p] of pending) {
          if (p.sessionId === id) {
            clearTimeout(p.timer)
            pending.delete(reqId)
            p.reject(new Error(`会话 ${id} 已断开（请求 ${reqId} 未完成）`))
          }
        }
        log.info('编辑器断开: %s', id)
      })
      socket.on('error', () => {})
      })
    }
    listen()
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
      if (!s) return reject(new Error(`没有连接的编辑器会话 ${sessionId}（先让用户打开 turbowarp.org 并装 tw-bridge-extension）`))
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
  // config.snapshotsDir 可以把它挪到别的盘（大项目一份 project.json 就 7MB，别都堆系统盘上）
  const snapDir = config.snapshotsDir
    ? resolve(String(config.snapshotsDir))
    : join(process.env.DSH_HOME || (homedir() + '/.dsh'), 'scratch-snapshots')
  const MAX_SNAP_MEM_MB = Number(config.maxSnapshotMemMb) || 64 // 内存里最多留多少 MB 的快照
  const MAX_SNAP_DISK_MB = Number(config.maxSnapshotDiskMb) || 256 // 盘上最多留多少 MB
  const snapBytesOf = (pj) => { try { return JSON.stringify(pj).length } catch { return 0 } }
  async function takeSnapshot(sessionId, label) {
    const pj = await call(sessionId, 'snapshot')
    const bytes = snapBytesOf(pj)
    const snap = { at: new Date().toISOString(), sessionId, label, projectJson: pj, bytes }
    snapshots.unshift(snap)
    snapBytes += bytes
    // 两个上限都管：条数（防止小项目刷屏）+ 总字节（防止大项目吃爆内存）
    while (snapshots.length > config.maxSnapshots || (snapBytes > MAX_SNAP_MEM_MB * 1024 * 1024 && snapshots.length > 1)) {
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
      while (files.length > config.maxSnapshots * 2 || (total > MAX_SNAP_DISK_MB * 1024 * 1024 && files.length > 1)) {
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
    const safety = config.safety || 'preview'
    if (safety === 'suggest') {
      return { mode: 'suggest', hint: '当前为 suggest 档：只把改动作为建议交给用户，不落项目。', plan: { op, args }, preview }
    }
    if (safety === 'preview') return stagePlan(sessionId, op, args, label, preview)
    return executePlan({ sessionId, op, args, label })
  }

  // ---------------- Skill 区：Scratch 实践经验库 ----------------
  // 内置 skill（插件包 skills/ 目录）首启时复制到 $DSH_HOME/scratch-skills/，
  // 之后 agent/用户自由编辑，插件升级不覆盖（除非带 .reset 标记）。
  // 开关三层：config.skillsEnabled（总闸）→ .enabled.json（单文件开关）→ agent 自主选读。
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
  //   browser（默认）→ 打开 turbowarp.org/editor。桥只驱动得了这一种。
  //   desktop        → 起本地 TurboWarp Desktop（Electron）。
  // ⚠️ Desktop 装不了浏览器扩展（它只有自己的 userscript addon 系统，实测 app.asar 里
  //    没有任何 session.loadExtension 调用），所以**桥连不上 Desktop**。那条路只用于
  //    "帮用户把软件打开自己玩"，返回值里必须说清楚，免得 AI 以为连上了。
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const EDITOR_URL = 'https://turbowarp.org/editor'
  const DESKTOP_DOWNLOAD = 'https://desktop.turbowarp.org/'

  /** 找本地 TurboWarp Desktop：配置 > 环境变量 > 注册表卸载项 > 常见路径 */
  function findDesktopApp() {
    const tried = []
    const push = (p) => { if (p) tried.push(p); return p }
    const cands = [
      push(config.desktopPath),
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

  /** 起一个分离进程（不阻塞、不弹控制台）。Windows 下 .cmd/.bat 不能直接 spawn，得经 cmd.exe */
  function spawnDetached(cmd, args) {
    const isBatch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd)
    const realCmd = isBatch ? 'cmd.exe' : cmd
    const realArgs = isBatch ? ['/c', cmd, ...args] : args
    const child = spawn(realCmd, realArgs, { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => {}) // 失败靠调用方超时兜底，别让未处理的 error 崩掉插件
    child.unref()
    return child.pid
  }

  /** 打开外部目标。config.browserPath 可指定浏览器（Windows 下也接受 .cmd/.bat 包装脚本） */
  function openTarget(target, kind) {
    if (kind === 'desktop') return spawnDetached(target, [])
    const exe = config.browserPath
    if (exe) return spawnDetached(exe, [target])
    if (process.platform === 'win32') return spawnDetached('cmd.exe', ['/c', 'start', '', target])
    if (process.platform === 'darwin') return spawnDetached('open', [target])
    return spawnDetached('xdg-open', [target])
  }

  /** 没会话时给 AI 的「怎么让用户接上」信息包（list_sessions 和 open_editor 共用） */
  function setupPayload() {
    return {
      token: bridgeToken,
      tokenFile: bridgeTokenFile,
      tokenIsNew: bridgeTokenIsNew || undefined,
      step1: 'Chrome 打开 chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选 packages/tw-bridge-extension',
      step2: `点扩展的「详情 → 扩展程序选项」，把 token 粘进去保存：${bridgeToken}`,
      step3: '打开 https://turbowarp.org/editor ，F12 应看到 [dsh-bridge] connected & authenticated',
      recentRejected: rejectedConnections.length ? rejectedConnections : undefined
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
          hint: '先让用户装扩展并填 token；也可以直接调 scratch_open_editor 帮用户把编辑器打开'
        }
      }
      const list = []
      for (const [id, s] of sessions) {
        const meta = await call(id, 'project_meta').catch(() => null)
        list.push({ sessionId: id, meta: s.meta, detail: meta })
      }
      // 轻提示：skill 区存在（不注入内容，agent 自主决定是否读）
      const skills = config.skillsEnabled === false ? null : listSkills()
      return { sessions: list, skillHint: skills && skills.length ? `有 ${skills.length} 篇 Scratch 实践经验可用（scratch_skills list，不强制）` : null }
    }
  }))

  ctx.tools.register(defineTool({
    name: 'scratch_open_editor',
    description: '主动帮用户打开 TurboWarp 编辑器（用户说「打开 TurboWarp」「我想做 Scratch」，而你这边还没有会话时用这个，别让用户自己去点）。'
      + 'app=browser（默认）打开 turbowarp.org/editor，打开后 AI 就能直接读写积木；'
      + 'app=desktop 启动本地 TurboWarp Desktop（**已经在运行就不会重复开**，除非传 force）。'
      + '⚠️ Desktop 是 Electron，装不了浏览器扩展，所以**桥驱动不了它**（只能帮用户把软件开起来，AI 改不了里面的项目）。'
      + '打开后会等一段时间看会话有没有连上，返回值里的 connected 就是结论。',
    parameters: {
      app: { type: 'string', description: 'browser（默认）| desktop' },
      url: { type: 'string', description: '要打开的地址（默认 https://turbowarp.org/editor，也可以传具体作品链接）' },
      waitMs: { type: 'number', description: '打开后等多久看会话连上，默认 20000，上限 60000' },
      force: { type: 'boolean', description: '已经有会话时也照样再开一个' }
    },
    output: jsonOut,
    async execute(args) {
      const app = String(args?.app || 'browser').toLowerCase()
      if (sessions.size && !args?.force) {
        return {
          alreadyConnected: true,
          sessions: [...sessions.keys()],
          hint: '已经有连着的编辑器了，直接干活就行（想再开一个就传 force: true）'
        }
      }
      const waitMs = Math.min(Math.max(Number(args?.waitMs ?? 20000) || 0, 0), 60000)
      const launched = { app }
      let error = null

      if (app === 'desktop') {
        const found = findDesktopApp()
        if (!found.path) {
          return {
            launched: { app, ok: false },
            connected: false,
            desktopNotFound: true,
            triedPaths: found.tried,
            hint: `本地没找到 TurboWarp Desktop。可以告诉用户去 ${DESKTOP_DOWNLOAD} 下载（Windows 选 Setup x64），`
              + '或者把安装路径写进插件配置 desktopPath。注意：Desktop 装不了浏览器扩展，桥驱动不了它——'
              + '要让 AI 改积木，还是用 app=browser 打开 turbowarp.org。'
          }
        }
        // 已经在跑就别再拉一个 —— 桌面版没有单实例锁，重复调就会满屏窗口（踩过）
        const running = countRunning(found.path)
        if (running > 0 && !args?.force) {
          return {
            launched: { app, path: found.path, via: found.via, skipped: true },
            alreadyRunning: true,
            runningProcesses: running,
            connected: false,
            bridgeCanDrive: false,
            why: 'TurboWarp Desktop 已经在运行了，没有重复启动。',
            hint: '桌面版是 Electron 应用，装不了浏览器扩展，桥驱动不了它——'
              + '要让 AI 读写积木请用 turbowarp.org（app=browser）。真想再开一个窗口就传 force: true。'
          }
        }
        try { spawnDetached(found.path, []); launched.path = found.path; launched.via = found.via } catch (e) { error = e.message }
        return {
          launched,
          connected: false,
          bridgeCanDrive: false,
          why: 'TurboWarp Desktop 是 Electron 应用，不支持 Chrome 扩展（它只有自己的 userscript addon 系统），所以桥连不上它。',
          hint: '已经帮用户把桌面版打开了，但 AI 改不了里面的项目。要让我能读写积木，请用 turbowarp.org（app=browser）那一路。'
            + (error ? '（启动时出错：' + error + '）' : '')
        }
      }

      const url = String(args?.url || EDITOR_URL)
      if (!/^https?:\/\//i.test(url)) {
        throw new Error(`只允许 http/https 地址，收到：${url}`)
      }
      launched.url = url
      try { launched.pid = openTarget(url, 'browser') } catch (e) { error = e.message }

      // 等会话连上（浏览器冷启动 + 编辑器加载 + 扩展握手，真机实测十几秒是常态）
      const deadline = Date.now() + waitMs
      while (Date.now() < deadline && !sessions.size) await sleep(400)
      const connected = sessions.size > 0
      return Object.assign({
        launched,
        connected,
        sessions: [...sessions.keys()],
        waitedMs: waitMs - Math.max(0, deadline - Date.now())
      }, connected
        ? { hint: '编辑器已连上，可以直接 scratch_snapshot 看项目了' }
        : {
            error,
            setup: setupPayload(),
            hint: '已经帮用户把 turbowarp.org 打开了，但桥还没连上：要么扩展没装，要么 token 没填。'
              + '把 setup 里的步骤念给用户（token 一定要原样给出），填完不用刷新页面，几秒内会自己连上——可以再调一次 scratch_list_sessions 确认。'
          })
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
      const p = resolve(String(args.path))
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
        snapshotAt: snap.at,
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
      if (config.skillsEnabled === false) {
        return { skillsDisabled: true, hint: '用户关闭了 skill 功能（config.skillsEnabled=false）' }
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
