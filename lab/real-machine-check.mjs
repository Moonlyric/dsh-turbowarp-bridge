// real-machine-check.mjs — 真机验收（全自动）
//
// lab/ 里其它测试都是**替身 VM**（npm scratch-vm）跑的，有四个盲区（见 README）。
// 这个脚本补的就是那四个盲区里唯一无法静态证明的一环：
//   「插件 + 扩展 + 真 Chrome + 真 turbowarp.org 编辑器」连起来到底通不通。
//
// 它做的是完整的真机链路，不是模拟：
//   1. 用真配置 apply() 本插件（起真的 31820 桥服务端），从 $DSH_HOME 读 token
//   2. 拉起真 Chrome（临时 profile）+ --load-extension 装真扩展
//   3. 扩展 ID 靠 SHA256(路径) 复算 + CDP 里的 service_worker target 双向核对
//   4. 打开扩展选项页，用 chrome.storage.local 写进 token（等价于用户手填）
//   5. 打开真 https://turbowarp.org/editor
//   6. 等 MAIN world 执行器自报 socket=open authed=true
//   7. 用真工具在真编辑器上跑一遍：snapshot → add_blocks → apply → 独立校验活块模型
//      → update_block → locate → delete_blocks → 再 snapshot 查孤儿
//
// 校验不读插件自己的返回值当证据：积木是否真的进了 VM，是**页面里**直接读
// vm.runtime.targets[].blocks._blocks 和 Blockly XML 得出的（独立信源）。
//
// 用法：
//   node lab/real-machine-check.mjs                 # 默认用 Chrome
//   $env:CHROME_PATH='...\msedge.exe'; node lab/real-machine-check.mjs   # 换 Edge
//   $env:KEEP_OPEN=1 node lab/real-machine-check.mjs  # 跑完不关浏览器（手动看效果）
//
// 需要：真实 Chrome/Edge + 能访问 turbowarp.org（首次要下编辑器资源，约 20-60s）。

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const EXT_DIR = join(ROOT, 'packages', 'tw-bridge-extension')
const PLUGIN_DIR = join(ROOT, 'packages', 'dsh-plugin-scratch')

// ⚠️ 默认**不用** 31820：那是产品的默认端口，用户八成正开着 dsh（插件就监听在那儿）。
//    两边抢同一个端口时，本脚本起的桥绑不上，而测试浏览器里的扩展会连到**用户的桥**上 →
//    token 对不上 → 一把全红，还特别难查（真踩过）。所以验收用自己的端口，
//    并在第 3 步把 `bridgeUrl` 一起写进扩展存储（选项页里也能手改）。
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT || 31830)
const CDP_PORT = Number(process.env.CDP_PORT || 19333)
const EDITOR_URL = process.env.EDITOR_URL || 'https://turbowarp.org/editor'
const HEADLESS = process.env.HEADFUL ? false : true
const KEEP_OPEN = !!process.env.KEEP_OPEN

const BROWSER = process.env.CHROME_PATH || [
  join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe')
].find(p => p && existsSync(p))

// ---------------- 断言收集 ----------------
let pass = 0, fail = 0
const failures = []
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else {
    fail++
    failures.push(name + (detail ? ' | ' + detail : ''))
    console.log('  FAIL ' + name + (detail ? ' | ' + detail : ''))
  }
}
const step = (s) => console.log('\n=== ' + s + ' ===')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ---------------- CDP 小客户端（只用 Node 内置 WebSocket，不引依赖） ----------------
async function httpJson(path, method = 'GET') {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}${path}`, { method })
  const txt = await res.text()
  try { return JSON.parse(txt) } catch { return { raw: txt, status: res.status } }
}

class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.waiters = new Map(); this.onEvent = () => {} }
  static async attach(wsUrl) {
    const ws = new WebSocket(wsUrl)
    const self = new Cdp(ws)
    ws.addEventListener('message', (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.id && self.waiters.has(msg.id)) {
        const w = self.waiters.get(msg.id); self.waiters.delete(msg.id)
        msg.error ? w.reject(new Error(msg.error.message || JSON.stringify(msg.error))) : w.resolve(msg.result)
      } else if (msg.method) self.onEvent(msg)
    })
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('CDP 连接超时: ' + wsUrl)), 10000)
      ws.addEventListener('open', () => { clearTimeout(to); res() })
      ws.addEventListener('error', () => { clearTimeout(to); rej(new Error('CDP 连接失败: ' + wsUrl)) })
    })
    return self
  }
  send(method, params = {}) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.waiters.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.waiters.has(id)) { this.waiters.delete(id); reject(new Error('CDP ' + method + ' 超时')) }
      }, 30000)
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception?.description || r.exceptionDetails.text
      throw new Error('页面求值异常: ' + d)
    }
    return r.result?.value
  }
  close() { try { this.ws.close() } catch {} }
}

/** 新开一个标签页并 attach（/json/new 只接受 PUT） */
async function openTab(url) {
  const info = await httpJson('/json/new?' + encodeURIComponent(url), 'PUT')
  if (!info.webSocketDebuggerUrl) throw new Error('开标签页失败: ' + JSON.stringify(info).slice(0, 300))
  return Cdp.attach(info.webSocketDebuggerUrl)
}

/** 找扩展的 service worker target（socket 现在住在那儿，真值只能从它里面读） */
async function findSwTarget(extId) {
  const list = await httpJson('/json/list').catch(() => [])
  return (Array.isArray(list) ? list : []).find(x =>
    x && x.type === 'service_worker' && String(x.url).includes(extId) && x.webSocketDebuggerUrl)
}

/** 轮询页面求值直到条件成立 */
async function waitFor(cdp, expression, predicate, { timeout = 90000, every = 1000, label = expression } = {}) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    try {
      last = await cdp.eval(expression)
      if (predicate(last)) return last
    } catch (e) { last = 'ERR: ' + e.message }
    await sleep(every)
  }
  return { __timeout: true, last, label }
}

// 扩展 ID = SHA256(解压目录绝对路径) 前 16 字节按 a-p 编码（Chrome 的算法）
const extIdFromPath = (p) => createHash('sha256').update(p, 'utf8').digest('hex')
  .slice(0, 32).split('').map(c => String.fromCharCode(97 + parseInt(c, 16))).join('')

// ---------------- 页面侧探针（在真 VM 上读活块模型） ----------------
const PROBE_ENV = `(() => {
  const vm = window.vm
  return {
    href: location.href,
    vmIsObject: !!vm && typeof vm === 'object',
    vmHasRuntime: !!(vm && vm.runtime),
    targets: vm && vm.runtime ? vm.runtime.targets.filter(x => !x.isStage).map(x => x.getName()) : null,
    editingTarget: vm && vm.editingTarget ? vm.editingTarget.getName() : null,
    ScratchBlocks: typeof window.ScratchBlocks,
    Blockly: typeof window.Blockly,
    bridge: window.__dshBridge ? window.__dshBridge.state() : null,
    hasWorkspace: !!(window.vm && window.vm.workspace)
  }
})()`

// LNA（Local Network Access）体检：从**页面**直连 loopback 到底通不通。
// 这一条是整轮结论的地基：页面直连要是通的，就说明环境（VPN/代理/fake-IP）把检查绕过去了，
// 后面的"绿"不能代表用户机器上的真实情况 —— 之前的假绿就是这么来的。
const LNA_PROBE = `(async () => {
  const out = { href: location.href }
  try {
    const p = await navigator.permissions.query({ name: 'local-network-access' })
    out.permission = p.state
  } catch (e) { out.permission = 'unsupported:' + (e && e.name) }
  out.pageSocket = await new Promise((resolve) => {
    let done = false, sock = null
    const fin = (v) => { if (done) return; done = true; clearTimeout(t); try { sock && sock.close() } catch {} ; resolve(v) }
    const t = setTimeout(() => fin('timeout'), 4000)
    try { sock = new WebSocket('ws://127.0.0.1:${BRIDGE_PORT}') } catch (e) { return fin('throw:' + e.message) }
    sock.onopen = () => fin('open')
    sock.onerror = () => fin('blocked')
    sock.onclose = () => fin('blocked')
  })
  return out
})()`

// 直接读 VM 活块模型：每个非影子块的 inputs 指向的影子块里到底有没有值
const PROBE_BLOCKS = `(() => {
  const vm = window.vm
  const out = {}
  for (const tgt of vm.runtime.targets) {
    const bm = tgt.blocks
    if (!bm || !bm._blocks) continue
    const list = []
    for (const id of Object.keys(bm._blocks)) {
      const b = bm._blocks[id]
      if (b.shadow) continue
      const inputs = {}
      for (const name of Object.keys(b.inputs || {})) {
        const inp = b.inputs[name]
        const isStr = typeof inp === 'string'
        const key = isStr ? inp : inp.block
        const sh = key ? bm._blocks[key] : null
        inputs[name] = sh
          ? { via: isStr ? 'string' : 'object', opcode: sh.opcode, shadow: !!sh.shadow,
              fields: Object.fromEntries(Object.entries(sh.fields || {}).map(([k, v]) => [k, v.value])) }
          : null
      }
      list.push({ id, opcode: b.opcode, topLevel: !!b.topLevel, x: b.x, y: b.y,
                  parent: b.parent || null, next: b.next || null,
                  fields: Object.fromEntries(Object.entries(b.fields || {}).map(([k, v]) => [k, v.value])),
                  inputs })
    }
    if (list.length) out[tgt.getName()] = list
  }
  return out
})()`

// GUI 那一侧的独立信源：Blockly 工作区序列化出的 XML（输入空不空一眼就看出来）
const PROBE_XML = `(() => {
  const B = window.ScratchBlocks || window.Blockly
  if (!B || !B.getMainWorkspace) return { error: '没有 Blockly 工作区' }
  const ws = B.getMainWorkspace()
  if (!ws) return { error: 'getMainWorkspace() 返回空' }
  return { xml: B.Xml.domToText(B.Xml.workspaceToDom(ws)),
           scrollX: ws.scrollX, scrollY: ws.scrollY,
           selected: (ws.getSelected && ws.getSelected()) ? ws.getSelected().id : null }
})()`

/**
 * 块在不在「看得见」的区域里 —— 用 client 坐标问浏览器本人，
 * 不碰 scrollX 的正负号约定（scratch-blocks 的 scrollX 是负向的，猜错就会误判）。
 */
const probeOnScreen = (id) => `(() => {
  const B = window.ScratchBlocks || window.Blockly
  const ws = B && B.getMainWorkspace ? B.getMainWorkspace() : null
  if (!ws) return { error: 'no workspace' }
  const b = ws.getBlockById(${JSON.stringify(id)})
  if (!b || !b.getSvgRoot) return { error: 'block not rendered' }
  const svg = b.getSvgRoot()
  if (!svg.getBoundingClientRect) return { error: 'no rect' }
  const br = svg.getBoundingClientRect()
  const wr = ws.getParentSvg().getBoundingClientRect()
  const inter = br.right > wr.left && br.left < wr.right && br.bottom > wr.top && br.top < wr.bottom
  const inside = br.left >= wr.left && br.right <= wr.right && br.top >= wr.top && br.bottom <= wr.bottom
  return { visible: inter, fullyInside: inside,
           block: [Math.round(br.left), Math.round(br.top), Math.round(br.right), Math.round(br.bottom)],
           canvas: [Math.round(wr.left), Math.round(wr.top), Math.round(wr.right), Math.round(wr.bottom)],
           scroll: [Math.round(ws.scrollX), Math.round(ws.scrollY)], scale: ws.scale }
})()`

// ---------------- 主体 ----------------
async function main() {
  console.log('真机验收 — 桥端口 %d / CDP 端口 %d / 编辑器 %s', BRIDGE_PORT, CDP_PORT, EDITOR_URL)
  console.log('浏览器: %s (%s)', BROWSER, HEADLESS ? 'headless=new' : '有窗口')
  if (!BROWSER) throw new Error('找不到 Chrome/Edge，用 $env:CHROME_PATH 指定')
  if (!existsSync(join(EXT_DIR, 'manifest.json'))) throw new Error('找不到扩展目录: ' + EXT_DIR)

  const HOME = mkdtempSync(join(tmpdir(), 'dsh-rm-home-'))
  const PROFILE = mkdtempSync(join(tmpdir(), 'dsh-rm-profile-'))
  process.env.DSH_HOME = HOME
  let chrome = null
  let editorCdp = null
  // 放外面是为了在 cleanup 里也能删：中途抛错时 try 末尾那行 rmSync 根本执行不到，
  // 会在 %TEMP% 里留下 dsh-sb3-out-* （踩过，跑了五六轮攒了一堆）。
  let sb3OutDir = null

  const cleanup = async () => {
    if (editorCdp) editorCdp.close()
    if (sb3OutDir) { try { rmSync(sb3OutDir, { recursive: true, force: true }) } catch {} }
    if (KEEP_OPEN) return
    if (chrome) {
      try { spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
    }
    // Windows 上 Chrome 刚被杀时还占着 profile 里的文件句柄，立刻删会 EBUSY/EPERM。
    // 等它真正退出再删，别在临时目录里留一堆垃圾。
    for (let i = 0; i < 12; i++) {
      await sleep(500)
      try {
        rmSync(PROFILE, { recursive: true, force: true })
        rmSync(HOME, { recursive: true, force: true })
        return
      } catch { /* 还占着，再等一轮 */ }
    }
    console.log('\n⚠️ 临时目录没能自动清掉（浏览器还占着句柄），手动删一下：\n  ' + PROFILE + '\n  ' + HOME)
  }

  try {
    // ---- 0. 环境体检：别让 VPN/代理把 LNA 检查掩盖掉 ----
    // 教训（2026-10）：之前那几轮"真机 98/98 全绿"**全是假的**。用户开着 VPN（Clash 类）
    // 时 turbowarp.org 被解析到 fake-IP（198.18.x.x 之类的私网段），Chrome 判定
    // "本页也是本地"，于是页面里直连 ws://127.0.0.1 畅通无阻。VPN 一关立刻变成
    // net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS。
    // 所以开跑先确认解析结果不是私网/fake-IP，否则这一轮的绿不算数。
    step('0. 环境体检（这一轮的 LNA 结论可不可信）')
    let resolved = []
    try { resolved = await lookup('turbowarp.org', { all: true }) } catch (e) { resolved = [{ address: 'ERR:' + e.message }] }
    const PRIVATE_RE = /^(10\.|127\.|192\.168\.|0\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|198\.1[89]\.)/
    const masked = resolved.length > 0 && resolved.every(r => PRIVATE_RE.test(String(r.address || '')))
    t('turbowarp.org 解析到公网 IP（不是 VPN/fake-IP 私网段——那种环境下 LNA 被绕过，结论不算数）',
      !masked, JSON.stringify(resolved.length ? resolved : 'no-answer'))
    if (masked) {
      console.log('  ⚠️⚠️ 检测到 fake-IP/私网解析，这一轮的"绿"不能代表用户机器：请关掉 VPN/代理再跑。')
    }
    console.log('  浏览器: ' + BROWSER + ' / headless=' + HEADLESS + ' / 编辑器: ' + EDITOR_URL)

    // ---- 1. 起真插件（真配置：preview 档，和 cordis.patch.yml 一致）----
    step('1. 插件装到临时 $DSH_HOME 并起桥')
    const registered = new Map()
    const logged = []
    const fakeCtx = {
      logger: () => ({
        info: (...a) => logged.push('info ' + a.map(String).join(' ')),
        warn: (...a) => logged.push('warn ' + a.map(String).join(' ')),
        error: (...a) => logged.push('error ' + a.map(String).join(' ')),
        debug: () => {}
      }),
      effect: (fn) => { const d = fn(); if (typeof d === 'function') process.on('exit', () => { try { d() } catch {} }) },
      tools: { register: (tool) => registered.set(tool.name, tool) }
    }
    const mod = await import('../packages/dsh-plugin-scratch/index.js')
    // 唤起浏览器这件事本身用桩脚本验（别在用户桌面上真开窗口）；真正的「用户点一下就能开」
    // 由用户自己触发一次即可。桩脚本把收到的参数写进日志，我们据此断言 URL 传对了。
    const STUB = join(tmpdir(), 'dsh-rm-browser-stub-' + Date.now() + '.cmd')
    const STUB_LOG = STUB + '.launches'
    writeFileSync(STUB, `@echo off\r\necho %* >> "${STUB_LOG}"\r\n`)
    mod.apply(fakeCtx, {
      safety: 'preview', bridgePort: BRIDGE_PORT, maxSnapshots: 5, skillsEnabled: true,
      browserPath: STUB, desktopPath: STUB
    })
    const stubLaunches = () => existsSync(STUB_LOG)
      ? readFileSync(STUB_LOG, 'utf8').split(/\r?\n/).filter(Boolean)
      : []
    const TOKEN = readFileSync(join(HOME, 'scratch-bridge-token.txt'), 'utf8').trim()
    t('插件 apply 未抛错，注册了 19 个工具', registered.size === 19, '实际 ' + registered.size)
    t('桥 token 已生成（32 位 hex）', /^[0-9a-f]{32}$/.test(TOKEN), TOKEN)
    const call = async (name, args) => {
      const tool = registered.get(name)
      if (!tool) throw new Error('没有工具 ' + name)
      // dsh-tools 会校验参数是「无损 JSON」：显式传 undefined 会被它拒掉
      // （真实 agent 调用不会出现这种情况——缺省参数是「键不存在」，不是「值为 undefined」）
      const clean = {}
      for (const k of Object.keys(args || {})) if (args[k] !== undefined) clean[k] = args[k]
      return await tool.execute(clean)
    }

    // ---- 1.5 AI 主动唤起编辑器（还没连上时的分支） ----
    step('1.5 scratch_open_editor：还没有会话时')
    const oe1 = await call('scratch_open_editor', { waitMs: 2500 })
    t('把 turbowarp.org/editor 交给了浏览器（真机上是默认浏览器）',
      stubLaunches().some(l => l.includes('turbowarp.org/editor')), JSON.stringify(stubLaunches()))
    t('如实回报 connected=false（没有扩展就是连不上，不假装成功）', oe1.connected === false, JSON.stringify(oe1).slice(0, 200))
    t('同时给出 token + 三步配置指引（AI 能直接念给用户）',
      !!(oe1.setup && oe1.setup.token === TOKEN && oe1.setup.step1 && oe1.setup.step3), JSON.stringify(oe1.setup || {}).slice(0, 240))
    t('等满了 waitMs 才返回（不是立刻放弃）', oe1.waitedMs >= 2000, 'waitedMs=' + oe1.waitedMs)
    const oeDesk = await call('scratch_open_editor', { app: 'desktop', waitMs: 0 })
    t('app=desktop 能定位到本地 TurboWarp Desktop（desktopPath / 注册表那条路）',
      !!(oeDesk.launched && oeDesk.launched.path), JSON.stringify(oeDesk.launched))
    t('启动时带了 --remote-debugging-port（桌面版靠 CDP 直连，不靠扩展）',
      /--remote-debugging-port=\d+/.test(JSON.stringify(stubLaunches())), JSON.stringify(stubLaunches()).slice(0, 200))
    t('桩起不了 CDP 端点时如实报错，不谎报连上',
      oeDesk.connected === false && typeof oeDesk.error === 'string', JSON.stringify({ c: oeDesk.connected, e: oeDesk.error }).slice(0, 200))
    // 桌面版真正的端到端验收在 lab/desktop-cdp-check.mjs（那边会真开一个 TurboWarp 窗口）

    // ---- 2. 拉真浏览器 + 真扩展 ----
    // 关于装扩展：Chrome 137 起**品牌版 Chrome 直接忽略 --load-extension**
    // （日志明说：WARNING:extension_service.cc --load-extension is not allowed in Google Chrome,
    //   ignoring；--disable-extensions-except 同样被拒）。所以自动化不能用命令行开关。
    // 正路是 CDP 的 Extensions 域 Extensions.loadUnpacked（Chrome 130+ / Edge 同源都有），
    // 它返回真实扩展 ID，正好省掉「按路径复算 ID」那套会错的东西。
    // 用户手动走的是 chrome://extensions → 加载已解压的扩展程序，那条路不受这个限制影响。
    step('2. 装扩展（CDP Extensions.loadUnpacked）')
    const launch = (extra = []) => {
      const a = [
        `--user-data-dir=${PROFILE}`,
        `--remote-debugging-port=${CDP_PORT}`,
        '--remote-allow-origins=*',
        '--no-first-run', '--no-default-browser-check', '--disable-features=Translate,MediaRouter',
        '--enable-unsafe-swiftshader', // headless 下 TurboWarp 要 WebGL 才肯初始化 VM
        '--window-size=1440,900',
        ...extra,
        'about:blank'
      ]
      if (HEADLESS) a.unshift('--headless=new')
      const child = spawn(BROWSER, a, { stdio: ['ignore', 'pipe', 'pipe'] })
      child.stderr.on('data', (d) => { browserErr += String(d) })
      return child
    }
    let browserErr = ''
    chrome = launch()

    const waitCdp = async () => {
      for (let i = 0; i < 60; i++) {
        try { const v = await httpJson('/json/version'); if (v.webSocketDebuggerUrl) return v } catch {}
        await sleep(500)
      }
      return null
    }
    let ver = await waitCdp()
    t('浏览器起来了，CDP 可用', !!ver, (ver && ver.Browser) || browserErr.slice(0, 200))
    if (!ver) throw new Error('CDP 不可用，无法继续')

    const PROBE_EXT = `(() => {
      const c = typeof chrome !== 'undefined' ? chrome : null
      return {
        hasStorage: !!(c && c.storage && c.storage.local),
        id: c && c.runtime ? c.runtime.id : null,
        manifest: (c && c.runtime && c.runtime.getManifest) ? c.runtime.getManifest().version : null,
        hasTokenInput: !!document.querySelector('input')
      }
    })()`
    /** 打开候选扩展的 options.html，确认那真的是我们能用的扩展页 */
    const probeExtPage = async (cand) => {
      let tab = null
      try {
        tab = await openTab(`chrome-extension://${cand}/options.html`)
        await tab.send('Runtime.enable')
        await sleep(300)
        const p = await tab.eval(PROBE_EXT)
        return (p && p.hasStorage && p.id === cand) ? p : null
      } catch { return null } finally { if (tab) tab.close() }
    }

    let EXT_ID = null
    let extProbe = null
    let loadUnpackedErr = ''
    const browserWs = await Cdp.attach(ver.webSocketDebuggerUrl)
    try {
      const r = await browserWs.send('Extensions.loadUnpacked', { path: EXT_DIR })
      EXT_ID = r && r.id ? r.id : null
    } catch (e) {
      loadUnpackedErr = e.message
      console.log('  Extensions.loadUnpacked 不可用（' + e.message.slice(0, 80) + '），回退 --load-extension')
    }
    // Edge 没有 Extensions 这个 CDP 域（那是 Chrome 专属），所以这里判"两条路有一条走通"：
    // loadUnpacked 给了 ID，或者确认它不可用→回退（回退是否真装上，下面几条断言会验）。
    t('装扩展：loadUnpacked 给了真实 ID，或（Edge 等无此域时）明确走回退 --load-extension',
      !!EXT_ID || !!loadUnpackedErr,
      `EXT_ID=${EXT_ID} loadUnpackedErr=${loadUnpackedErr ? 'yes' : 'no'}`)
    if (EXT_ID) extProbe = await probeExtPage(EXT_ID)

    if (!EXT_ID) {
      // 回退：命令行开关 + 从 /json/list 里找线索
      // （品牌版 Chrome 上这条路会失败；Chromium / 旧版仍可用）
      browserWs.close()
      try { spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
      await sleep(1000)
      browserErr = ''
      chrome = launch([`--load-extension=${EXT_DIR}`])
      ver = await waitCdp()
      const computedId = extIdFromPath(EXT_DIR)
      const cands = [computedId]
      for (let i = 0; i < 20 && cands.length < 4; i++) {
        const list = await httpJson('/json/list').catch(() => [])
        for (const x of (Array.isArray(list) ? list : [])) {
          const m = String(x.url).match(/^chrome-extension:\/\/([a-p]{32})\//)
          // 后台脚本装完会自己开一次 options.html，那正是我们扩展的 ID
          if (m && /options\.html/.test(String(x.url)) && !cands.includes(m[1])) cands.push(m[1])
        }
        if (cands.length > 1) break
        await sleep(500)
      }
      console.log('  回退候选 ID: ' + JSON.stringify(cands))
      for (const cand of cands) {
        const p = await probeExtPage(cand)
        if (p) { EXT_ID = cand; extProbe = p; break }
      }
    }
    t('扩展真的装上了（options.html 里能拿到 chrome.storage）', !!EXT_ID, 'ID=' + String(EXT_ID))
    t('扩展 manifest 能读到版本（说明 manifest.json 合法）', !!(extProbe && extProbe.manifest), JSON.stringify(extProbe))
    t('选项页里有输入框（用户手动填 token 的入口在）', !!(extProbe && extProbe.hasTokenInput), JSON.stringify(extProbe))
    const manifestErr = browserErr.match(/(Manifest|manifest)[^\n]{0,160}/g)
    t('浏览器没报 manifest 错误', !manifestErr, manifestErr && manifestErr.join(' / '))
    if (!EXT_ID) throw new Error('扩展没装成功，后面测不了')
    if (KEEP_OPEN) console.log('  [KEEP_OPEN] 扩展 ID = ' + EXT_ID)

    // ---- 3. 填 token（等价于用户在选项页手填）----
    step('3. 往扩展里写 token（等价于用户在选项页粘贴）')
    const opt = await openTab(`chrome-extension://${EXT_ID}/options.html`)
    await opt.send('Runtime.enable')
    const LAB_URL = `ws://127.0.0.1:${BRIDGE_PORT}`
    const setOk = await opt.eval(`new Promise(r => chrome.storage.local.set({ bridgeToken: ${JSON.stringify(TOKEN)}, bridgeUrl: ${JSON.stringify(LAB_URL)} }, () => r(chrome.runtime.lastError ? String(chrome.runtime.lastError) : 'ok')))`)
    const back = await opt.eval(`new Promise(r => chrome.storage.local.get(['bridgeToken', 'bridgeUrl'], v => r(v)))`)
    t('选项页能写 chrome.storage.local（扩展真的装了）', setOk === 'ok', String(setOk))
    t('token 存进去又读回来了', back && back.bridgeToken === TOKEN, String(back && back.bridgeToken))
    t('桥地址也写进去了（验收用独立端口，不去抢用户 dsh 的 31820）',
      back && back.bridgeUrl === LAB_URL, String(back && back.bridgeUrl))
    opt.close()

    // ---- 4. 打开真编辑器 ----
    step('4. 打开真 TurboWarp 编辑器并等 MAIN world 执行器认证')
    editorCdp = await openTab(EDITOR_URL)
    await editorCdp.send('Runtime.enable')
    await editorCdp.send('Log.enable').catch(() => {})
    const consoleLines = []
    editorCdp.onEvent = (msg) => {
      if (msg.method === 'Runtime.consoleAPICalled') {
        const txt = (msg.params.args || []).map(a => a.value ?? a.description ?? '').join(' ')
        if (/dsh-bridge|Blockly|blockly/i.test(txt)) consoleLines.push(txt.slice(0, 200))
      } else if (msg.method === 'Log.entryAdded') {
        consoleLines.push('[log:' + msg.params.entry.level + '] ' + String(msg.params.entry.text).slice(0, 200))
      }
    }

    const env0 = await waitFor(editorCdp, PROBE_ENV, v => v && v.vmIsObject && v.vmHasRuntime, { timeout: 120000, label: 'window.vm' })
    if (env0 && env0.__timeout) {
      t('编辑器加载出 window.vm', false, '超时；最后探针=' + JSON.stringify(env0.last) + ' 控制台=' + JSON.stringify(consoleLines.slice(-8)))
    } else {
      t('编辑器加载出 window.vm', true)
    }
    // window.vm 在项目加载前就存在了，得再等「项目真的进了 VM + 积木区挂载完」
    const env = await waitFor(editorCdp, PROBE_ENV,
      v => v && v.targets && v.targets.length > 0 && v.ScratchBlocks !== 'undefined',
      { timeout: 120000, every: 1000, label: 'project + blockly' })
    const ready = env && !env.__timeout
    t('默认项目加载完成（有角色）且积木区已挂载（ScratchBlocks 出现）', ready,
      '探针=' + JSON.stringify(env && (env.last || env)) + ' 控制台=' + JSON.stringify(consoleLines.slice(-8)))
    console.log('  环境: ' + JSON.stringify(ready ? env : env0))

    // ---- 4.5 LNA 体检（socket 为什么搬进 SW 的现场证据） ----
    step('4.5 Local Network Access 体检：页面直连 loopback 通不通')
    const lna = await editorCdp.eval(LNA_PROBE).catch(e => ({ error: e.message }))
    console.log('  LNA 探针: ' + JSON.stringify(lna))
    t('页面里能查 local-network-access 权限状态（这台机器上确实有 Chrome 的新检查）',
      typeof lna.permission === 'string' && !/^unsupported/.test(lna.permission), String(lna.permission))
    t('页面直连 ws://127.0.0.1 被拦（没被 VPN/代理掩盖 —— 这一轮的绿才算数）',
      lna.pageSocket !== 'open', `pageSocket=${lna.pageSocket} permission=${lna.permission}`)

    const st = await waitFor(editorCdp, 'window.__dshBridge ? window.__dshBridge.state() : null',
      v => typeof v === 'string' && /socket=open authed=true/.test(v), { timeout: 60000, label: 'bridge authed' })
    t('页面侧报出 socket=open authed=true（这个状态是 SW 告诉它的，页面自己不持有 socket）',
      typeof st === 'string' && /authed=true/.test(st), String(st))
    t('执行器看得见 window.vm（真机上是 window.vm 挂载，不是 vm.workspace）',
      typeof st === 'string' && /vm=object/.test(st), String(st))
    t('vm.workspace 确实不存在（旧代码假设错了的那条）', env0 && env0.hasWorkspace === false, String(env0 && env0.hasWorkspace))
    console.log('  桥自报: ' + st)
    if (consoleLines.length) console.log('  控制台: ' + JSON.stringify(consoleLines.slice(-6)))

    // ---- 4.6 socket 到底在谁手里（页面自报不算证据，去 SW 里读真值） ----
    step('4.6 SW 侧真值核对（socket 在扩展 service worker 里）')
    let swState = null
    const swTarget = await findSwTarget(EXT_ID)
    if (swTarget) {
      const swCdp = await Cdp.attach(swTarget.webSocketDebuggerUrl).catch(() => null)
      if (swCdp) {
        await swCdp.send('Runtime.enable').catch(() => {})
        swState = await swCdp.eval('globalThis.__dshBridgeSW ? __dshBridgeSW.state() : "(SW 里没有探针)"')
          .catch(e => 'ERR:' + e.message)
        // ⚠️ 立刻断开：调试器挂着会让 SW 永不休眠，后面第 22 步"空闲不重连"就假了
        swCdp.close()
      }
    }
    console.log('  SW 自报: ' + swState)
    t('CDP 找得到扩展的 service_worker target', !!swTarget, swTarget ? swTarget.url : '(没找到)')
    t('SW 里 socket 真的握着且已认证（authed=true）',
      typeof swState === 'string' && /authed=true/.test(swState), String(swState))
    t('SW 认到了编辑器页面（pages>=1 且有目标 tab）',
      typeof swState === 'string' && /pages=[1-9]/.test(swState) && /target=\d+/.test(swState), String(swState))
    t('传输方式自报 service-worker（不是页面直连那条老路）',
      typeof swState === 'string' && /transport=service-worker/.test(swState), String(swState))
    t('SW 连的是本脚本起的那个桥（端口对得上，没误连到用户正在跑的 dsh）',
      typeof swState === 'string' && swState.includes(`url=ws://127.0.0.1:${BRIDGE_PORT}`), String(swState))

    // 插件侧也要认这个会话
    let list = null
    for (let i = 0; i < 20; i++) {
      list = await call('scratch_list_sessions', {})
      if (list.sessions && list.sessions.length) break
      await sleep(500)
    }
    t('插件侧看到会话（握手 token 双边都对）', !!(list.sessions && list.sessions.length), JSON.stringify(list).slice(0, 300))
    if (!list.sessions || !list.sessions.length) throw new Error('没有会话，后面的写操作没法测')

    // ---- 5. 真快照 ----
    step('5. scratch_snapshot（真 project.json）')
    const snap = await call('scratch_snapshot', {})
    const pj = snap.project
    t('snapshot 返回的是 project.json 结构（不是 saveProjectSb3DontZip 的文件映射）',
      !!(pj && Array.isArray(pj.targets) && pj.targets.every(x => x && typeof x.blocks === 'object' && !x.blocks.__raw)),
      'keys=' + (pj && Object.keys(pj).slice(0, 8).join(',')))
    t('snapshot 里有 targets 和 meta', !!(pj && pj.targets && pj.meta), 'targets=' + (pj && pj.targets && pj.targets.length))
    const spriteName = ((pj.targets || []).find(x => !x.isStage) || {}).name
    console.log('  项目: ' + JSON.stringify({ targets: (pj.targets || []).map(x => x.name), sprite: spriteName, blocks: (pj.targets || []).reduce((n, x) => n + Object.keys(x.blocks || {}).length, 0) }))

    // ---- 6. 真注入：preview → apply ----
    step('6. scratch_add_blocks（preview 档）→ scratch_apply')
    // 故意放到视口外（默认视口只看到 0,0 附近一千像素），这样 locate 的「滚动过去」
    // 才有可验证的位移：块就在眼前时 scrollBounds 本来就该不动。
    const OLD = {
      rm_hat: { opcode: 'event_whenflagclicked', next: 'rm_move', parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 2400, y: 1600 },
      rm_move: {
        opcode: 'motion_movesteps', next: 'rm_say', parent: 'rm_hat',
        inputs: { STEPS: [1, [4, '50']] }, fields: {}, shadow: false, topLevel: false
      },
      rm_say: {
        opcode: 'looks_say', next: 'rm_wait', parent: 'rm_move',
        inputs: { MESSAGE: [1, [10, '真机验收']] }, fields: {}, shadow: false, topLevel: false
      },
      // control_wait 有两个作用：多覆盖一个类型码（5 = math_positive_number），
      // 以及让脚本真的跑够 1 秒——user_context 的 running 字段需要一段可观察的运行窗口
      rm_wait: {
        opcode: 'control_wait', next: 'rm_rep', parent: 'rm_say',
        inputs: { DURATION: [1, [5, '1']] }, fields: {}, shadow: false, topLevel: false
      },
      rm_rep: {
        opcode: 'control_repeat', next: null, parent: 'rm_wait',
        inputs: { TIMES: [1, [6, '3']], SUBSTACK: [2, 'rm_turn'] }, fields: {}, shadow: false, topLevel: false
      },
      rm_turn: {
        opcode: 'motion_turnright', next: null, parent: 'rm_rep',
        inputs: { DEGREES: [1, [4, '15']] }, fields: {}, shadow: false, topLevel: false
      }
    }
    const ALL_OLD = Object.keys(OLD)
    const prev = await call('scratch_add_blocks', { target: spriteName, blocks: OLD })
    t('preview 档不落盘：返回 planId 而不是改动', prev.mode === 'preview' && !!prev.planId, JSON.stringify(prev).slice(0, 200))
    const beforeApply = await editorCdp.eval(PROBE_BLOCKS)
    const beforeCount = Object.values(beforeApply).reduce((n, l) => n + l.length, 0)

    const applied = await call('scratch_apply', { planId: prev.planId })
    t('scratch_apply 走通并回传 idMap', !!(applied && applied.idMap), JSON.stringify(applied).slice(0, 300))
    t('idMap 覆盖了全部 6 个 AI 给的 id', applied.idMap && ALL_OLD.every(k => applied.idMap[k]),
      JSON.stringify(applied.idMap))
    t('idMap 可靠（idMapReliable 未被否认）', applied.idMapReliable !== false, String(applied.idMapReliable))
    t('AI 给了 6 块 → 展开成 11 块（5 个字面量变成影子块）',
      applied.inputBlocks === 6 && applied.expandedBlocks === 11 && applied.added === 11,
      JSON.stringify({ inputBlocks: applied.inputBlocks, expandedBlocks: applied.expandedBlocks, added: applied.added }))
    t('插件侧没报结构警告', !applied.warnings || applied.warnings.length === 0, JSON.stringify(applied.warnings))
    console.log('  注入结果: ' + JSON.stringify({ added: applied.added, inputBlocks: applied.inputBlocks, idMap: applied.idMap }).slice(0, 400))
    const NEW = applied.idMap

    // ---- 7. 独立校验：真 VM 的活块模型 + GUI 的 XML ----
    step('7. 独立校验（不读插件返回值，直接查真 VM 和真工作区）')
    const live = await editorCdp.eval(PROBE_BLOCKS)
    const all = Object.values(live).flat()
    const byId = Object.fromEntries(all.map(b => [b.id, b]))
    t('注入后非影子块数 = 原块数 + 6', all.length === beforeCount + 6, `before=${beforeCount} after=${all.length}`)
    t('旗帽块在，且是 topLevel 带坐标', !!byId[NEW.rm_hat] && byId[NEW.rm_hat].topLevel === true && typeof byId[NEW.rm_hat].x === 'number',
      JSON.stringify(byId[NEW.rm_hat]))
    const mv = byId[NEW.rm_move]
    t('motion_movesteps 的 STEPS 指向一个影子块', !!(mv && mv.inputs.STEPS && mv.inputs.STEPS.shadow === true), JSON.stringify(mv && mv.inputs))
    t('STEPS 影子里真有值 50（旧代码在这里留空 / null）', mv && mv.inputs.STEPS && mv.inputs.STEPS.fields.NUM === '50',
      JSON.stringify(mv && mv.inputs.STEPS))
    t('STEPS 影子的 opcode 是 math_number（类型码 4 翻译正确）', mv && mv.inputs.STEPS.opcode === 'math_number', mv && mv.inputs.STEPS.opcode)
    const say = byId[NEW.rm_say]
    t('looks_say 的 MESSAGE 影子里是「真机验收」', say && say.inputs.MESSAGE && say.inputs.MESSAGE.fields.TEXT === '真机验收',
      JSON.stringify(say && say.inputs.MESSAGE))
    const wait = byId[NEW.rm_wait]
    t('control_wait 的 DURATION 影子是 1，opcode 是 math_positive_number（类型码 5）',
      !!(wait && wait.inputs.DURATION && wait.inputs.DURATION.opcode === 'math_positive_number' && wait.inputs.DURATION.fields.NUM === '1'),
      JSON.stringify(wait && wait.inputs.DURATION))
    const rep = byId[NEW.rm_rep]
    t('control_repeat 的 TIMES 影子是 3', rep && rep.inputs.TIMES && rep.inputs.TIMES.fields.NUM === '3', JSON.stringify(rep && rep.inputs.TIMES))
    t('control_repeat 的 SUBSTACK 指向真块（不是影子）', !!(rep && rep.inputs.SUBSTACK && rep.inputs.SUBSTACK.shadow === false), JSON.stringify(rep && rep.inputs.SUBSTACK))
    t('SUBSTACK 里的块就是注入的 motion_turnright 新 id', rep && rep.inputs.SUBSTACK && rep.inputs.SUBSTACK.opcode === 'motion_turnright')
    t('子栈里的块 parent 指回 control_repeat（嵌套没断）', byId[NEW.rm_turn] && byId[NEW.rm_turn].parent === NEW.rm_rep,
      JSON.stringify({ turn: byId[NEW.rm_turn] && byId[NEW.rm_turn].parent, rep: NEW.rm_rep }))
    t('链头 next 链完整（hat→move→say→wait→repeat）',
      byId[NEW.rm_hat].next === NEW.rm_move && byId[NEW.rm_move].next === NEW.rm_say &&
      byId[NEW.rm_say].next === NEW.rm_wait && byId[NEW.rm_wait].next === NEW.rm_rep,
      JSON.stringify([byId[NEW.rm_hat].next, NEW.rm_move, byId[NEW.rm_move].next, NEW.rm_say, byId[NEW.rm_say].next, NEW.rm_wait, byId[NEW.rm_wait].next, NEW.rm_rep]))
    t('turnright 的 DEGREES 影子是 15', byId[NEW.rm_turn] && byId[NEW.rm_turn].inputs.DEGREES && byId[NEW.rm_turn].inputs.DEGREES.fields.NUM === '15',
      JSON.stringify(byId[NEW.rm_turn] && byId[NEW.rm_turn].inputs))
    t('没有 input 指向不存在的块（无孤儿）',
      all.every(b => Object.values(b.inputs).every(i => i && i.opcode) && (!b.parent || byId[b.parent]) && (!b.next || byId[b.next])),
      JSON.stringify(all.filter(b => Object.values(b.inputs).some(i => !i)).map(b => b.opcode)))

    const xml1 = await editorCdp.eval(PROBE_XML)
    t('GUI 工作区能取到 XML（ScratchBlocks/Blockly 拿到了）', !!(xml1 && xml1.xml), JSON.stringify(xml1).slice(0, 200))
    if (xml1 && xml1.xml) {
      t('XML 里出现注入的文本字面量（输入不是空的）', xml1.xml.includes('真机验收'), 'xml len=' + xml1.xml.length)
      t('XML 里出现 math_number 的值 50', /<field name="NUM">50<\/field>/.test(xml1.xml))
      t('XML 里没有空 <value> 节点（旧的畸形注入会留空输入）', !/<value name="[A-Z]+"><\/value>/.test(xml1.xml))
    }

    // ---- 8. 改字面量 ----
    step('8. scratch_update_block（改影子块里的字面量）')
    const updPlan = await call('scratch_update_block', { blockId: NEW.rm_say, inputs: { MESSAGE: [1, [10, '改过了']] } })
    t('update_block 也受 preview 档管（先给 plan 不落盘）', updPlan.mode === 'preview' && !!updPlan.planId,
      JSON.stringify(updPlan).slice(0, 200))
    const upd = await call('scratch_apply', { planId: updPlan.planId })
    t('update_block 的 plan 应用成功且认下 MESSAGE', !!upd && upd.updated === NEW.rm_say && Array.isArray(upd.applied?.input) && upd.applied.input.includes('MESSAGE'),
      JSON.stringify(upd).slice(0, 300))
    const live2 = await editorCdp.eval(PROBE_BLOCKS)
    const say2 = Object.values(live2).flat().find(b => b.id === NEW.rm_say)
    t('真 VM 里 MESSAGE 影子已变成「改过了」', say2 && say2.inputs.MESSAGE && say2.inputs.MESSAGE.fields.TEXT === '改过了',
      JSON.stringify(say2 && say2.inputs.MESSAGE))
    t('改字面量没有把块数改坏', Object.values(live2).flat().length === all.length, String(Object.values(live2).flat().length))

    // ---- 9. locate ----
    step('9. scratch_locate（滚到块并高亮）')
    // 块在 (2400,1744)，远在视口外 —— 先确认「定位前确实看不见」，否则这个测试没意义
    const before = await editorCdp.eval(probeOnScreen(NEW.rm_rep))
    console.log('  定位前: ' + JSON.stringify(before))
    t('定位前这块看不全（测试前提：被画布边缘切掉）', !!(before && before.fullyInside === false), JSON.stringify(before))

    const loc = await call('scratch_locate', { blockId: NEW.rm_rep })
    t('locate 找到块并回报位置', !!loc && loc.found === true && loc.opcode === 'control_repeat' && loc.position && loc.position.x > 2000,
      JSON.stringify(loc).slice(0, 300))
    // locate 的「滚动过去」依赖 scratch-blocks 的滚动 API。先确认这个 API 真的存在——
    // 否则 content-main.js 里那句 try/catch 会把「方法不存在」吞掉，表现为「不滚动但也不报错」。
    const wsApi = await editorCdp.eval(`(() => {
      const B = window.ScratchBlocks || window.Blockly
      const ws = B.getMainWorkspace()
      const names = []
      for (const k in ws) if (/scroll|center|zoom|Viewport|scale/i.test(k)) names.push(k + ':' + typeof ws[k])
      return { names, centerOnBlock: typeof ws.centerOnBlock, scrollBounds: typeof ws.scrollBounds,
               scroll: typeof ws.scroll, scrollX: ws.scrollX, scrollY: ws.scrollY, scale: ws.scale }
    })()`)
    t('工作区提供 locate 需要的滚动 API', !!(wsApi && (wsApi.centerOnBlock === 'function' || wsApi.scrollBounds === 'function')),
      JSON.stringify(wsApi))
    console.log('  滚动 API: ' + JSON.stringify({ centerOnBlock: wsApi && wsApi.centerOnBlock, scrollBounds: wsApi && wsApi.scrollBounds, scroll: wsApi && wsApi.scroll, scale: wsApi && wsApi.scale }))
    t('locate 用的是真机上存在的那条路（scrolledBy 有值且不是 error）',
      !!(loc && loc.scrolledBy && !String(loc.scrolledBy).startsWith('error')), JSON.stringify(loc && loc.scrolledBy))
    const glow = await editorCdp.eval(`(() => {
      const B = window.ScratchBlocks || window.Blockly
      if (!B || !B.getMainWorkspace) return null
      const b = B.getMainWorkspace().getBlockById(${JSON.stringify(NEW.rm_rep)})
      if (!b) return null
      const svg = b.getSvgRoot()
      return { filter: svg && svg.style ? svg.style.filter : null }
    })()`)
    t('locate 给块加上了发光高亮（用户肉眼能看到的那个效果）', !!(glow && /drop-shadow/.test(glow.filter)), JSON.stringify(glow))
    const xml2 = await editorCdp.eval(PROBE_XML)
    const after = await editorCdp.eval(probeOnScreen(NEW.rm_rep))
    console.log('  定位后: ' + JSON.stringify(after))
    t('locate 后这块完整进入可视区（用户眼睛能看到整块）',
      !!(after && after.fullyInside === true), JSON.stringify({ before, after, via: loc.scrolledBy }))
    t('工作区确实滚了（scroll 从原点移开）',
      !!after && (after.scroll[0] !== 0 || after.scroll[1] !== 0),
      JSON.stringify({ beforeScroll: before && before.scroll, afterScroll: after && after.scroll, want: loc.position }))
    t('locate 时切到了目标精灵（editingTarget 正确）',
      (await editorCdp.eval(PROBE_ENV)).editingTarget === spriteName, JSON.stringify((await editorCdp.eval(PROBE_ENV)).editingTarget))

    // ---- 10. 删块 ----
    step('10. scratch_delete_blocks（连同影子块和子栈一起清）')
    const delPlan = await call('scratch_delete_blocks', { blockIds: [NEW.rm_hat] })
    t('delete 同样受 preview 档管', delPlan.mode === 'preview' && !!delPlan.planId, JSON.stringify(delPlan).slice(0, 200))
    const del = await call('scratch_apply', { planId: delPlan.planId })
    t('delete 返回实际删除清单', !!del && Array.isArray(del.deleted) && del.count === del.deleted.length,
      JSON.stringify(del).slice(0, 300))
    t('删链头连带 6 真块 + 5 影子块一起删（预测=实际）', del.count === 11, 'count=' + del.count + ' ' + JSON.stringify(del.deleted))
    t('delete 没有「预测该删却还留着」的块', del.survivedPredicted === undefined, String(del.survivedPredicted))
    t('delete 报的悬挂引用为 0', !del.dangling || del.dangling.length === 0, JSON.stringify(del.dangling))
    t('delete 没给结构性损坏警告', !del.warning, String(del.warning))
    const live3 = await editorCdp.eval(PROBE_BLOCKS)
    const all3 = Object.values(live3).flat()
    t('真 VM 里注入的 6 个块全没了', all3.every(b => !ALL_OLD.map(k => NEW[k]).includes(b.id)),
      JSON.stringify(all3.filter(b => ALL_OLD.map(k => NEW[k]).includes(b.id)).map(b => b.opcode)))
    t('影子块也一起清了（块数回到注入前）', all3.length === beforeCount, `now=${all3.length} before=${beforeCount}`)
    t('剩下的块没有指向已删块的悬挂引用',
      all3.every(b => (!b.parent || all3.some(x => x.id === b.parent)) && (!b.next || all3.some(x => x.id === b.next))),
      JSON.stringify(all3.filter(b => (b.parent && !all3.some(x => x.id === b.parent)) || (b.next && !all3.some(x => x.id === b.next))).map(b => b.opcode)))

    // ---- 11. 删完再快照 ----
    step('11. 再快照：删干净了、project.json 仍然合法')
    const snap2 = await call('scratch_snapshot', {})
    const pj2 = snap2.project
    const tgt = (pj2.targets || []).find(x => x.name === spriteName) || {}
    t('快照仍然能出（删块没把项目搞坏）', !!(pj2 && pj2.targets), Object.keys(pj2 || {}).join(','))
    const idsInSnap = Object.keys(tgt.blocks || {})
    t('sb3 快照里没有残留注入块 id', !idsInSnap.some(id => Object.values(NEW).includes(id)), JSON.stringify(idsInSnap.slice(0, 12)))
    t('sb3 快照里的输入数组不是 [1,null]（值没丢）',
      !JSON.stringify(tgt.blocks || {}).includes(',null]'),
      JSON.stringify(tgt.blocks || {}).slice(0, 200))

    // ---- 12. 恢复 ----
    step('12. scratch_rollback（恢复到注入前）')
    // 每次写操作落盘前都会存一份快照，所以序号是倒着数的：
    //   0 = pre-delete_blocks（块都在） 1 = pre-update_block  2 = pre-add_blocks（注入前）
    const rb = await call('scratch_rollback', { index: 2 })
    t('rollback 走通并回到「注入前」那份快照', !!rb && rb.restored === true && rb.label === 'pre-add_blocks',
      JSON.stringify(rb).slice(0, 300))
    const live4 = await editorCdp.eval(PROBE_BLOCKS)
    t('恢复后块数回到注入前', Object.values(live4).flat().length === beforeCount,
      `now=${Object.values(live4).flat().length} before=${beforeCount}`)

    // ---- 13. opcode 白名单 ----
    step('13. scratch_get_opcodes（防 AI 编造的白名单）')
    const ops = await call('scratch_get_opcodes', {})
    t('白名单来自真 VM 且数量合理（>100）', !!(ops && ops.count > 100), 'count=' + (ops && ops.count))
    t('白名单含内置积木 motion_movesteps', !!(ops && ops.opcodes.includes('motion_movesteps')))
    t('白名单含帽子块 event_whenflagclicked', !!(ops && ops.hatBlocks && ops.hatBlocks.includes('event_whenflagclicked')))
    t('白名单里没有笔扩展（这个项目还没用 pen，不该凭空出现）',
      !(ops && ops.opcodes.some(o => o.startsWith('pen_'))),
      JSON.stringify((ops && ops.opcodes || []).filter(o => o.startsWith('pen_')).slice(0, 5)))

    // ---- 14. 整理布局 ----
    step('14. scratch_tidy_blocks（把散乱脚本排成列）')
    const MESSY = {
      td_hat: {
        opcode: 'event_whenflagclicked', next: 'td_wait', parent: null, inputs: {}, fields: {},
        shadow: false, topLevel: true, x: 3700, y: 2900 // 故意丢在很远的地方
      },
      td_wait: {
        opcode: 'control_wait', next: null, parent: 'td_hat',
        inputs: { DURATION: [1, [5, '2']] }, fields: {}, shadow: false, topLevel: false
      }
    }
    const tdPlan = await call('scratch_add_blocks', { target: spriteName, blocks: MESSY })
    const td = await call('scratch_apply', { planId: tdPlan.planId })
    const tdHat = td.idMap.td_hat
    const posBefore = (Object.values(await editorCdp.eval(PROBE_BLOCKS)).flat().find(b => b.id === tdHat) || {})
    t('乱放的脚本注入成功且坐标就是 3700,2900', posBefore.x === 3700 && posBefore.y === 2900, JSON.stringify({ x: posBefore.x, y: posBefore.y }))

    const tidyPlan = await call('scratch_tidy_blocks', { target: spriteName })
    t('tidy 同样受 preview 档管', tidyPlan.mode === 'preview' && !!tidyPlan.planId, JSON.stringify(tidyPlan).slice(0, 160))
    const tidied = await call('scratch_apply', { planId: tidyPlan.planId })
    t('tidy 报告整理了 1 个顶层脚本', !!(tidied && tidied.tidied === 1), JSON.stringify(tidied).slice(0, 240))
    const posAfter = Object.values(await editorCdp.eval(PROBE_BLOCKS)).flat().find(b => b.id === tdHat)
    t('整理后坐标回到网格起点 48,48（真 VM 里读出来的）', posAfter && posAfter.x === 48 && posAfter.y === 48,
      JSON.stringify({ x: posAfter && posAfter.x, y: posAfter && posAfter.y }))

    // ---- 15. SVG 造型 ----
    step('15. scratch_add_costume（SVG → 造型）')
    const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><circle cx="30" cy="30" r="28" fill="#ff4c4c"/></svg>'
    const cosBefore = await editorCdp.eval(`window.vm.runtime.targets.find(t => t.getName() === ${JSON.stringify(spriteName)}).sprite.costumes.map(c => c.name)`)
    const cosPlan = await call('scratch_add_costume', { target: spriteName, name: 'ai-costume', svg: SVG })
    const cos = await call('scratch_apply', { planId: cosPlan.planId })
    t('add_costume 返回造型名与 md5ext', !!(cos && cos.costume === 'ai-costume' && /^[0-9a-f]{32}\.svg$/.test(cos.md5ext || '')),
      JSON.stringify(cos).slice(0, 200))
    const cosAfter = await editorCdp.eval(`window.vm.runtime.targets.find(t => t.getName() === ${JSON.stringify(spriteName)}).sprite.costumes.map(c => c.name)`)
    t('真 VM 的造型列表多了一项 ai-costume', cosAfter.length === cosBefore.length + 1 && cosAfter.includes('ai-costume'),
      JSON.stringify({ before: cosBefore, after: cosAfter }))
    const cosCenter = await editorCdp.eval(`(() => {
      const c = window.vm.runtime.targets.find(t => t.getName() === ${JSON.stringify(spriteName)}).sprite.costumes.slice(-1)[0]
      return { name: c.name, rc: [c.rotationCenterX, c.rotationCenterY], size: [c.size, c.bitmapResolution] }
    })()`)
    t('造型旋转中心是渲染器按真实图形算的（不是硬编码 48/50）',
      !!(cosCenter && cosCenter.rc && (cosCenter.rc[0] !== 48 || cosCenter.rc[1] !== 50)),
      JSON.stringify(cosCenter))

    // ---- 16. 变量观察者（这块替身层永远测不到：setInterval 被桩掉了） ----
    step('16. scratch_watch（500ms 轮询观察者，真浏览器里跑定时器）')
    // 默认空项目没有变量，也不该为测试去扩展产品面 —— 直接用页面 API 造一个全局变量当被观察对象
    await editorCdp.eval(`(() => {
      const stage = window.vm.runtime.getTargetForStage()
      stage.variables['dshTestScore'] = { id: 'dshTestScore', name: '分数', value: 0, type: '' }
      return Object.keys(stage.variables)
    })()`)
    const wStart = await call('scratch_watch', { action: 'start', target: spriteName })
    t('watch start 报出被观察的变量名（认到了刚造的「分数」）',
      !!(wStart && wStart.watching === spriteName && (wStart.variables || []).includes('分数')), JSON.stringify(wStart))
    // 改两次值，间隔大于轮询周期，让定时器真的采到（0 → 10 → 25）
    await editorCdp.eval(`window.vm.runtime.getTargetForStage().variables['dshTestScore'].value = 10`)
    await sleep(900)
    await editorCdp.eval(`window.vm.runtime.getTargetForStage().variables['dshTestScore'].value = 25`)
    await sleep(900)
    const wPoll = await call('scratch_watch', { action: 'poll' })
    t('watch poll 报出当前值 25（定时器真的在跑）', !!(wPoll && wPoll.current && wPoll.current['分数'] === 25), JSON.stringify(wPoll).slice(0, 300))
    const traj = (wPoll && wPoll.changes || []).map(c => c.to)
    t('watch 采到了 10 → 25 的变化轨迹（替身层做不到这条）', traj.includes(10) && traj.includes(25), JSON.stringify(wPoll.changes))
    const wStop = await call('scratch_watch', { action: 'stop' })
    t('watch stop 停掉定时器', !!(wStop && wStop.stopped === true), JSON.stringify(wStop))

    // ---- 17. 用户上下文 ----
    step('17. scratch_user_context（选块 / 运行态感知）')
    const ucIdle = await call('scratch_user_context', {})
    t('没跑脚本时 running=false（真 VM 的线程状态）', !!(ucIdle && ucIdle.running === false), JSON.stringify(ucIdle).slice(0, 200))

    // 用**真鼠标事件**点块（走完整的 gesture 路径，等价于用户拿鼠标点它），
    // 而不是程序化 b.select()——后者不一定发 ui 事件，拿它当断言会误判。
    await call('scratch_locate', { blockId: tdHat }) // 先确保它在可视区里，点得到
    const scr = await editorCdp.eval(probeOnScreen(tdHat))
    const cx = Math.round((scr.block[0] + scr.block[2]) / 2)
    const cy = Math.round((scr.block[1] + scr.block[3]) / 2)
    t('点之前块在可视区里（点得到）', !!(scr && scr.fullyInside === true), JSON.stringify(scr))
    // 诊断：自己挂一个 change listener 当对照，看到底是「事件形状不对」还是「桥挂在了旧 workspace 上」
    const bindDiag = await editorCdp.eval(`(() => {
      const B = window.ScratchBlocks || window.Blockly
      const ws = B.getMainWorkspace()
      window.__probeSeen = []
      ws.addChangeListener(e => {
        window.__probeSeen.push({ element: e.element, type: e.type,
          blockId: e.blockId ? String(e.blockId) : null, keys: Object.keys(e).slice(0, 16) })
      })
      return { wsId: ws.id, listeners: ws.changeListeners_ ? ws.changeListeners_.length : 'n/a',
               hasGetSelected: typeof ws.getSelected }
    })()`)
    await editorCdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 })
    await editorCdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 })
    await sleep(800)
    const rawDiag = await editorCdp.eval(`(() => {
      const B = window.ScratchBlocks || window.Blockly
      const ws = B.getMainWorkspace()
      const sel = B.selected || (ws.getSelected && ws.getSelected())
      return { wsId: ws.id, probeSaw: window.__probeSeen,
               listeners: ws.changeListeners_ ? ws.changeListeners_.length : 'n/a',
               blocklySelected: sel ? sel.id : null, want: ${JSON.stringify(tdHat)},
               bridgeEvents: (window.__dshBridge && window.__dshBridge.userEvents || []) }
    })()`)
    console.log('  选块诊断(挂监听前): ' + JSON.stringify(bindDiag))
    console.log('  选块诊断(点击后): ' + JSON.stringify(rawDiag).slice(0, 700))
    const selDiag = rawDiag
    const uc = await call('scratch_user_context', {})
    t('真鼠标点块后，user_context 报出了那个块（blockId + opcode）',
      !!(uc && Array.isArray(uc.events) && uc.events.some(e => e.blockId === tdHat)),
      JSON.stringify(uc).slice(0, 400) + ' 诊断=' + JSON.stringify(selDiag))
    t('user_context 报的事件里带 opcode',
      !!(uc && (uc.events || []).some(e => e.blockId === tdHat && e.opcode === 'event_whenflagclicked')),
      JSON.stringify((uc && uc.events) || []).slice(0, 300))

    // 跑绿旗：那块 control_wait 2 会撑出一个可观察的运行窗口
    await editorCdp.eval('window.vm.greenFlag()')
    await sleep(300)
    const ucRun = await call('scratch_user_context', {})
    t('跑绿旗时 running=true（绿旗感知，M2 双向联动）', !!(ucRun && ucRun.running === true), JSON.stringify(ucRun).slice(0, 200))
    t('跑绿旗被记成 run_start 事件', !!(ucRun && (ucRun.events || []).some(e => e.type === 'run_start')),
      JSON.stringify((ucRun && ucRun.events) || []).slice(0, 300))
    await editorCdp.eval('window.vm.stopAll()')
    await sleep(400)
    const ucStop = await call('scratch_user_context', {})
    t('停下来了 running 回到 false 且记到 run_stop',
      !!(ucStop && ucStop.running === false && (ucStop.events || []).some(e => e.type === 'run_stop')),
      JSON.stringify(ucStop).slice(0, 240))

    // ---- 18. 已经有会话时的唤起（不该重复开标签页） ----
    step('18. scratch_open_editor：已经有会话时')
    const before18 = stubLaunches().length
    const oe3 = await call('scratch_open_editor', { waitMs: 1500 })
    t('已有会话时直接回 alreadyConnected，不再开新标签页',
      oe3.alreadyConnected === true && stubLaunches().length === before18,
      JSON.stringify(oe3).slice(0, 200) + ` launches ${before18}->${stubLaunches().length}`)
    const oe4 = await call('scratch_open_editor', { force: true, waitMs: 1500 })
    // 已有会话时工具会立刻返回（不等），桩脚本可能还没把日志写完 —— 等一下再数
    await sleep(700)
    t('force=true 时照样开，并且立刻看到已连上的会话',
      oe4.connected === true && stubLaunches().length === before18 + 1,
      JSON.stringify(oe4).slice(0, 200) + ` launches ${before18}->${stubLaunches().length}`)
    try { rmSync(STUB, { force: true }); rmSync(STUB_LOG, { force: true }) } catch {}

    // ---- 19. 存成 .sb3 文件（本机落盘） ----
    step('19. scratch_save_project（编辑器 → 磁盘上的 .sb3）')
    const outDir = mkdtempSync(join(tmpdir(), 'dsh-sb3-out-'))
    sb3OutDir = outDir
    const outPath = join(outDir, 'harness-save.sb3')
    const sv = await call('scratch_save_project', { path: outPath })
    t('save_project 写出了文件并回报路径', !!(sv && sv.savedTo === outPath && sv.bytes > 0),
      JSON.stringify(sv).slice(0, 200))
    const savedBuf = existsSync(outPath) ? readFileSync(outPath) : Buffer.alloc(0)
    t('磁盘上的文件是合法 zip（PK 魔数）且大小与回报一致',
      savedBuf.length > 500 && savedBuf[0] === 0x50 && savedBuf[1] === 0x4b && Math.abs(savedBuf.length - sv.bytes) <= 2,
      `bytes=${savedBuf.length} reported=${sv.bytes} magic=${savedBuf.subarray(0, 2).toString('hex')}`)
    const sv2 = await call('scratch_save_project', { path: outPath })
    t('同名再存一次不会覆盖原文件（默认另存为 -ai-时间戳.sb3）',
      !!(sv2 && sv2.savedTo !== outPath && /-ai-\d{14}\.sb3$/.test(sv2.savedTo) && sv2.overwrote === false),
      JSON.stringify(sv2).slice(0, 240))
    t('另存出来的那个文件也真的存在', existsSync(sv2.savedTo), String(sv2.savedTo))

    // ---- 20. 打开本机的真 sb3（用户的实际工作流） ----
    const fixture = process.env.SB3_FIXTURE
    if (!fixture) {
      console.log('  （设 SB3_FIXTURE=<某个 .sb3 路径> 可以顺带验一下真实作品能不能打开）')
    } else {
      step('20. scratch_load_project：打开真实作品 ' + basename(fixture))
      const fxSize = statSync(fixture).size
      // 回滚的参照必须是**打开文件前那一刻**的块数，不能拿第 5 步刚开局的数字：
      // 中间第 14/15 步注入过脚本、加过造型，都没删（0 → 2 那个差就是这么来的）。
      const preLoadCount = Object.values(await editorCdp.eval(PROBE_BLOCKS)).flat().length
      const lp = await call('scratch_load_project', { path: fixture })
      t('load_project 报告装载成功', !!(lp && lp.loaded === true), JSON.stringify(lp).slice(0, 240))
      t('角色清单里出现真实作品的角色（不是默认的「角色1」）',
        !!(lp && Array.isArray(lp.targets) && lp.targets.length >= 5 && lp.targets.some(n => !/^角色\d*$/.test(n))),
        JSON.stringify(lp && lp.targets).slice(0, 200))
      t('块数上万/上千（真项目的规模）', !!(lp && lp.blockCount > 1000), 'blockCount=' + (lp && lp.blockCount))
      t('同时回报含影子块数（两种数法都给，否则和页面/文件对账永远对不上）',
        !!(lp && lp.blockCountWithShadows > lp.blockCount),
        `真块=${lp && lp.blockCount} 含影子=${lp && lp.blockCountWithShadows}`)
      // 页面侧独立确认：VM 里真的换了项目
      const liveBig = await editorCdp.eval(PROBE_BLOCKS)
      const bigNames = Object.keys(liveBig)
      t('真 VM 里确实换成了那个项目（页面侧读到的角色名对得上）',
        bigNames.length >= 5 && bigNames.every(n => (lp.targets || []).includes(n) || n === 'Stage'),
        JSON.stringify(bigNames).slice(0, 240))
      const bigBlocks = Object.values(liveBig).flat().length
      // 两边数法必须一致：页面侧只数**非影子**块，所以和 blockCount（真块）比。
      // 不能要求相等——项目装进 VM 后，可见的监视器（monitor）会在 Stage 上生成额外的
      // data_variable / data_listcontents 块，所以"活的真块数"只会 ≥ 文件里的真块数。
      // 真机实测（伊旬园 14.6MB）：文件里真块 4809 / 含影子 5035，活的真块 6083。
      t('页面侧数出来的真块数 ≥ 文件里的真块数（VM 装完会多出监视器块，不会少）',
        bigBlocks >= lp.blockCount && bigBlocks < lp.blockCount * 3,
        `page=${bigBlocks} tool真块=${lp.blockCount} 含影子=${lp.blockCountWithShadows}`)

      // ---- 21. 把刚打开的大项目再存出来（大文件往返 = 日常保存路径） ----
      step('21. 大项目 round-trip（存出来 + 校验字节）')
      const bigOut = join(outDir, 'big-roundtrip.sb3')
      const svBig = await call('scratch_save_project', { path: bigOut })
      const bigBuf = existsSync(bigOut) ? readFileSync(bigOut) : Buffer.alloc(0)
      t('大项目也存得出来，且大小与源文件同量级',
        bigBuf.length > fxSize * 0.5 && bigBuf.length < fxSize * 2,
        `src=${fxSize} out=${bigBuf.length}`)
      let zipOk = false
      try {
        const JSZip = (await import('jszip')).default
        const z = await JSZip.loadAsync(bigBuf)
        zipOk = !!z.file('project.json')
      } catch (e) { zipOk = 'err:' + e.message }
      t('存出来的大 sb3 是能解开的 zip 且含 project.json', zipOk === true, String(zipOk))
      // 开文件前自动快照过 → 能滚回小项目
      const rbBig = await call('scratch_rollback', { index: 0 })
      t('rollback 能撤回「打开文件」这一步（打开前是自动快照过的）',
        !!(rbBig && rbBig.restored === true), JSON.stringify(rbBig).slice(0, 200))
      const afterRb = Object.values(await editorCdp.eval(PROBE_BLOCKS)).flat().length
      t('回滚后项目回到打开文件之前的样子（块数一致）', afterRb === preLoadCount,
        `after=${afterRb} 打开文件前=${preLoadCount}`)
    }
    // ---- 22. MV3 service worker 存活（socket 搬进 SW 的代价，必须实测） ----
    // SW 空闲约 30s 就被回收，socket 会跟着死。对策：每 20s ping/pong 心跳（Chrome 116+
    // 把 WebSocket 收发算作 SW 活动）+ chrome.alarms 兜底重连。
    // 验证方式：**不挂调试器**（挂着等于给 SW 上了呼吸机，会假绿），纯等 45s，
    // 然后看会话 ID 变没变、插件日志里有没有新的断开/重连。
    step('22. 空闲 45s 后连接还在（心跳保活的验收）')
    const sessBefore = ((await call('scratch_list_sessions', {})).sessions || []).map(s => s.sessionId)
    const reconnectsBefore = logged.filter(l => /编辑器断开|编辑器已连接/.test(l)).length
    console.log('  等待 45s 完全不碰它（模拟用户去干别的事）…')
    await sleep(45000)
    const listAfter = await call('scratch_list_sessions', {})
    const sessAfter = (listAfter.sessions || []).map(s => s.sessionId)
    const reconnectsAfter = logged.filter(l => /编辑器断开|编辑器已连接/.test(l)).length
    t('45s 空闲后会话还在，且 sessionId 没变（socket 一直没断）',
      sessAfter.length > 0 && JSON.stringify(sessAfter) === JSON.stringify(sessBefore),
      `before=${JSON.stringify(sessBefore)} after=${JSON.stringify(sessAfter)}`)
    t('这 45s 里没发生重连（插件日志没有新的断开/连接；SW 没被回收）',
      reconnectsAfter === reconnectsBefore, `before=${reconnectsBefore} after=${reconnectsAfter}`)
    const opAfterIdle = await call('scratch_snapshot', {})
    t('空闲之后照样能干活（snapshot 仍能拿到 project.json）',
      !!(opAfterIdle && opAfterIdle.project && Array.isArray(opAfterIdle.project.targets)),
      JSON.stringify(opAfterIdle).slice(0, 200))

    // 清理挪到 cleanup() 里（中途抛错也能删干净）

  } catch (e) {
    t('脚本执行到底（没有中途抛错）', false, e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e.message)
  } finally {
    await cleanup()
  }

  step('结果')
  console.log(`  ${pass} 通过 / ${fail} 失败`)
  if (failures.length) { console.log('  失败项:'); failures.forEach(f => console.log('   - ' + f)) }
  console.log('\n（若失败项含「浏览器没报 manifest 错误」之外的加载类问题，检查 31820 端口是否被别的进程占了）')
  process.exit(fail ? 1 : 0)
}

main()
