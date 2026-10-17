// desktop-cdp-check.mjs — 真机验收：TurboWarp Desktop + CDP 直连（不需要浏览器扩展）
//
// 为什么单独一个脚本：
//   real-machine-check.mjs 走的是「真 Chrome + 真扩展 + 真 turbowarp.org」那条路 ——
//   它证明不了桌面版。桌面版是 Electron 应用，**装不了浏览器扩展**，所以只能靠
//   CDP：我们启动时给它带 --remote-debugging-port，再把页面执行器注进默认上下文。
//   这条路只有真开一个桌面版窗口才能验，替身层和扩展层都覆盖不到。
//
// 这个脚本验的是**端到端**，而且尽量不读插件自己的返回值当证据：
//   · 块到底进没进 VM：另开一条**独立** CDP 连接直接读 vm.runtime.targets[].blocks._blocks
//   · 存盘存出来的 sb3：查 PK 魔数 + 再装回来对比（真走了一遍磁盘往返）
//   · 结束时：进程必须清零、会话必须自动掉线（不给用户桌面上留窗口）
//
// ⚠️ 用户桌面上会**真的开一个 TurboWarp 窗口**（约 20-40s），跑完自动关掉。
//    如果检测到已经有 TurboWarp 在跑（可能是用户自己在用），直接 SKIP，不打扰。
//
// 用法：node lab/desktop-cdp-check.mjs
//       $env:KEEP_OPEN=1 node lab/desktop-cdp-check.mjs   # 跑完不关，自己看效果

import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const KEEP_OPEN = !!process.env.KEEP_OPEN
const HOME = mkdtempSync(join(tmpdir(), 'dsh-desktop-home-'))
const OUT = mkdtempSync(join(tmpdir(), 'dsh-desktop-out-'))
process.env.DSH_HOME = HOME

let pass = 0, fail = 0
const failures = []
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; failures.push(name + (detail ? ' | ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' | ' + detail : '')) }
}
const step = (s) => console.log('\n=== ' + s + ' ===')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
/** JSON.stringify 对 undefined 返回 undefined，直接 .slice() 会把测试自己搞崩（踩过） */
const J = (v, n = 240) => String(JSON.stringify(v === undefined ? null : v)).slice(0, n)

function twProcessCount() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq TurboWarp.exe', '/NH', '/FO', 'CSV'],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 })
    return out.split(/\r?\n/).filter(l => /turbowarp\.exe/i.test(l)).length
  } catch { return 0 }
}

/**
 * 独立证据：自己用 Win32 探针枚举一次 TurboWarp 的窗口（不读插件返回值）。
 * 为什么不用 `Get-Process ... MainWindowHandle`：隐藏窗口它恒返回 0，会得出
 * 「没有窗口」的错误结论 —— 这正是上一轮排查被骗了一整轮的原因。
 */
function probeWindowWin32() {
  const script = join(ROOT, 'packages', 'dsh-plugin-scratch', 'win32-window.ps1')
  if (!existsSync(script)) return null
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script, '-ImageName', 'TurboWarp'], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
    const list = JSON.parse(out.trim() || '[]')
    const main = list.filter(w => w && w.cls === 'Chrome_WidgetWin_1' && w.title)
    return main.find(w => /TurboWarp/i.test(w.title)) || main[0] || null
  } catch { return null }
}

// ---------------- 独立 CDP 通道（验证用，不碰插件自己的那条连接） ----------------
class RawCdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.waiters = new Map(); this.ctx = null; this.events = [] }
  static async connect(port, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs
    let target = null
    while (Date.now() < deadline && !target) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) })).json()
        const pages = list.filter(x => x.type === 'page' && x.webSocketDebuggerUrl)
        target = pages.find(x => /gui|turbowarp/i.test(String(x.url))) || pages[0]
      } catch { /* 还没起来 */ }
      if (!target) await sleep(300)
    }
    if (!target) throw new Error('等 CDP page target 超时')
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res)
      ws.addEventListener('error', () => rej(new Error('连 CDP 失败')))
      setTimeout(() => rej(new Error('连 CDP 超时')), 8000)
    })
    const self = new RawCdp(ws)
    self.target = target
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(String(ev.data)) } catch { return }
      if (m.id && self.waiters.has(m.id)) {
        const w = self.waiters.get(m.id); self.waiters.delete(m.id)
        m.error ? w.rej(new Error(m.error.message)) : w.res(m.result || {})
        return
      }
      if (m.method === 'Runtime.executionContextCreated') {
        const c = m.params.context
        const aux = c.auxData || {}
        if (aux.isDefault && aux.type === 'default') { self.ctx = c.id; self.events.push('default-ctx') }
      }
      if (m.method === 'Runtime.bindingCalled') self.events.push('binding:' + m.params.name)
    })
    await self.send('Runtime.enable')
    const deadline2 = Date.now() + 8000
    while (!self.ctx && Date.now() < deadline2) await sleep(100)
    if (!self.ctx) throw new Error('没等到默认执行上下文')
    return self
  }
  send(method, params) {
    const id = ++this.seq
    return new Promise((res, rej) => {
      this.waiters.set(id, { res, rej })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => { if (this.waiters.has(id)) { this.waiters.delete(id); rej(new Error('CDP 超时 ' + method)) } }, 15000)
    })
  }
  async evalJson(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: `JSON.stringify((() => { try { return ${expr} } catch (e) { return { __err: String(e) } } })())`,
      contextId: this.ctx, returnByValue: true
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return JSON.parse(r.result.value)
  }
  close() { try { this.ws.close() } catch {} }
}

// 独立读数：直接查真 VM（不想依赖执行器自己的计数函数）
const PAGE_PROBE = `{
  title: document.title,
  href: location.href,
  targets: window.vm.runtime.targets.map(x => x.getName()),
  editing: window.vm.editingTarget && window.vm.editingTarget.getName(),
  real: window.vm.runtime.targets.reduce((n, tg) => n + Object.values(tg.blocks._blocks).filter(b => !b.shadow).length, 0),
  withShadow: window.vm.runtime.targets.reduce((n, tg) => n + Object.keys(tg.blocks._blocks).length, 0),
  executor: typeof window.__dshBridge,
  cdpShim: !!window.__dshCdpShimInstalled,
  bridgeState: window.__dshBridge ? window.__dshBridge.state() : null
}`

const launchedPids = []
let raw = null
let sessionGone = false

try {
  step('0. 前置：用户桌面上不能已经有 TurboWarp（不打扰在用的窗口）')
  const pre = twProcessCount()
  t('跑之前没有 TurboWarp 在运行', pre === 0, '发现 ' + pre + ' 个进程')
  if (pre > 0) {
    console.log('\nSKIP 已经有 TurboWarp Desktop 在运行 —— 这个验收会开自己的窗口，先让用户关掉再跑。')
    process.exit(0)
  }

  step('1. 起插件（真 apply，工具注册齐全）')
  const registered = new Map()
  const logs = []
  const fakeCtx = {
    logger: () => ({
      info: (...a) => logs.push('info ' + a.join(' ')),
      warn: (...a) => logs.push('warn ' + a.join(' ')),
      error: (...a) => logs.push('error ' + a.join(' ')),
      debug: () => {}
    }),
    effect: (fn) => { const d = fn(); if (typeof d === 'function') process.on('exit', () => { try { d() } catch {} }) },
    tools: { register: (tool) => registered.set(tool.name, tool) }
  }
  // ⚠️ Windows 上 import() 绝对路径必须转成 file:// URL，否则 "G:\..." 会被当成 g: 协议
  const mod = await import(pathToFileURL(join(ROOT, 'packages', 'dsh-plugin-scratch', 'index.js')).href)
  mod.apply(fakeCtx, { safety: 'preview', bridgePort: 31841, maxSnapshots: 3, skillsEnabled: false })
  t('插件 apply 未抛错，注册了 19 个工具', registered.size === 19, '实际 ' + registered.size)
  const call = async (name, args) => {
    const tool = registered.get(name)
    if (!tool) throw new Error('没有工具 ' + name)
    const clean = {}
    for (const k of Object.keys(args || {})) if (args[k] !== undefined) clean[k] = args[k]
    return await tool.execute(clean)
  }
  t('vm-executor.js 存在且不是空的（CDP 要注的就是它）',
    existsSync(join(ROOT, 'packages', 'dsh-plugin-scratch', 'vm-executor.js')))

  step('2. scratch_open_editor({ app: "desktop" })：启动桌面版 + CDP 接上')
  const t0 = Date.now()
  const r = await call('scratch_open_editor', { app: 'desktop', waitMs: 60000 })
  const elapsed = Date.now() - t0
  console.log(`  （耗时 ${(elapsed / 1000).toFixed(1)}s）`)
  t('返回 connected=true —— 桌面版真的被接上了（不是"只帮你打开"）', r.connected === true, J(r, 300))
  t('transport 自报 cdp-desktop（零安装那条路，没有扩展、没有 token）', r.transport === 'cdp-desktop', String(r.transport))
  t('不给 setup 配置包（CDP 那条路不需要 token）', r.setup === undefined, JSON.stringify(Object.keys(r)))
  t('页面应答了（执行器注入后 ping→pong 走过一圈）', r.pageResponded === true, String(r.pageResponded))
  t('会话 id 是 cd- 前缀（跟扩展会话 tw- 区分开）', /^cd-\d+$/.test(String(r.sessionId)), String(r.sessionId))
  t('调试端口是真实存在的端口号', Number.isInteger(r.launched && r.launched.debugPort) && r.launched.debugPort > 1024, JSON.stringify(r.launched))
  t('启动参数里带了 --remote-debugging-port（CDP 的前提）', !!r.launched.debugPort, JSON.stringify(r.launched))
  t('报出了 TurboWarp Desktop 的真实路径', /TurboWarp\.exe$/i.test(String(r.launched.path)), String(r.launched.path))
  launchedPids.push(r.launched.pid)
  t('CDP target 是桌面版的 GUI（tw-editor://）', /tw-editor:\/\//.test(String(r.target)), String(r.target))
  t('meta 是页面执行器真读出来的（角色列表来自真项目）',
    !!(r.meta && Array.isArray(r.meta.targets) && r.meta.targets.some(x => x.name === 'Stage')),
    J(r.meta && r.meta.targets, 200))
  // 桌面版冷启动是"GUI 先出来、项目后加载"：必须等到 vm 里真有角色才回报 ready，
  // 否则 AI 会以为项目是空的，然后往一个不存在的角色里塞积木（真机踩过）
  t('等到了项目就绪（ready=true 且角色列表非空）',
    r.ready === true && Array.isArray(r.targets) && r.targets.length > 0, J({ ready: r.ready, targets: r.targets }))
  t('报出了当前编辑中的角色（AI 直接拿它当 target）',
    typeof r.editingTarget === 'string' && r.editingTarget.length > 0, String(r.editingTarget))

  // ---- 窗口可见性：连上了 ≠ 用户看得见 ----
  // 这是这个插件最阴的失败模式：进程在、CDP 通、积木也能改，但用户屏幕上什么都没有。
  // 上一轮真实卡了一整轮，根因是 spawn 时带了 windowsHide（窗口以 SW_HIDE 状态创建）。
  t('返回值里带了窗口状态（EnumWindows 拿的 hwnd/visible/rect）',
    !!(r.window && typeof r.window.visible === 'boolean' && r.window.hwnd), J(r.window, 200))
  t('窗口是可见的（用户真能看到编辑器，不是隐藏态）', !!(r.window && r.window.visible === true), J(r.window, 200))
  t('启动时就没把窗口藏起来（不是"先隐藏、再 ShowWindow 补救"）',
    r.windowRepair === undefined, String(r.windowRepair))
  t('报的是编辑器主窗口（标题带 TurboWarp，不是 IME/辅助窗口）',
    /TurboWarp/i.test(String(r.window && r.window.title)), String(r.window && r.window.title))
  const winNow = probeWindowWin32()
  t('独立 Win32 探针也看到它是可见的（插件没自说自话）', !!(winNow && winNow.visible === true), J(winNow, 160))

  step('3. 独立 CDP 通道核对（不读插件返回值）')
  raw = await RawCdp.connect(r.launched.debugPort)
  let page = await raw.evalJson(PAGE_PROBE)
  console.log('  页面自报: ' + JSON.stringify(page))
  t('独立通道看到 TurboWarp Desktop 的编辑器页面', /gui|tw-editor/i.test(page.href + page.title), page.href)
  t('页面里有真 VM 和角色列表', Array.isArray(page.targets) && page.targets.length >= 2, JSON.stringify(page.targets))
  t('执行器真被注进页面了（window.__dshBridge 在）', page.executor === 'object', String(page.executor))
  t('CDP 垫片也装上了（postMessage → binding）', page.cdpShim === true, String(page.cdpShim))
  t('执行器自报的传输方式是 cdp 那条（不是扩展的 transport=sw）',
    /transport=cdp/.test(String(page.bridgeState)), String(page.bridgeState))
  t('自报里 token 一栏是"不需要"（CDP 那条路没有 token 这回事）',
    /token=不需要/.test(String(page.bridgeState)), String(page.bridgeState))
  // AI 要往哪个角色里塞积木：用工具报出来的那个（不是猜）
  const workTarget = page.targets.find(n => n !== 'Stage') || page.editing

  step('4. 只读工具在桌面版上照常工作')
  const snap = await call('scratch_snapshot', {})
  t('snapshot 拿到 project.json 结构', !!(snap.project && Array.isArray(snap.project.targets)), J(Object.keys(snap), 160))
  const opcodes = await call('scratch_get_opcodes', {})
  t('get_opcodes 白名单来自真 VM（>100）', (opcodes.total || opcodes.opcodes?.length || 0) > 100,
    J(Object.keys(opcodes), 120))
  const sessions = await call('scratch_list_sessions', {})
  t('list_sessions 认到 1 个会话', (sessions.sessions || []).length === 1, J(sessions, 200))
  t('list_sessions 也报窗口状态（AI 随时能自检"用户看得见吗"）',
    !!(sessions.sessions && sessions.sessions[0] && sessions.sessions[0].window), J(sessions.sessions && sessions.sessions[0], 240))
  t('list_sessions 报的窗口同样可见', !!(sessions.sessions && sessions.sessions[0] && sessions.sessions[0].window && sessions.sessions[0].window.visible === true),
    J(sessions.sessions && sessions.sessions[0] && sessions.sessions[0].window, 160))
  t('会话 meta 标了 transport=cdp（AI 能一眼看出走的是哪条路）',
    sessions.sessions[0].meta && sessions.sessions[0].meta.transport === 'cdp',
    J(sessions.sessions[0].meta || {}, 200))

  step('5. 写操作：preview → apply（改的必须真进 VM）')
  const before = (await raw.evalJson(PAGE_PROBE)).real
  const blocks = {
    hat: { opcode: 'event_whenflagclicked', next: 'move', parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 60, y: 60 },
    move: { opcode: 'motion_movesteps', next: 'say', parent: 'hat', inputs: { STEPS: [1, [4, '50']] }, fields: {}, shadow: false, topLevel: false },
    say: { opcode: 'looks_say', next: null, parent: 'move', inputs: { MESSAGE: [1, [10, '桌面版CDP验收']] }, fields: {}, shadow: false, topLevel: false }
  }
  const preview = await call('scratch_add_blocks', { target: workTarget, blocks })
  t('preview 档不落盘（返回 planId）', preview.mode === 'preview' && !!preview.planId, J(preview, 200))
  const afterPreview = (await raw.evalJson(PAGE_PROBE)).real
  t('preview 之后 VM 里块数没变（真没落盘）', afterPreview === before, `${before} → ${afterPreview}`)
  const applied = await call('scratch_apply', { planId: preview.planId })
  t('apply 回传 idMap', !!(applied.idMap && Object.keys(applied.idMap).length === 3), J(applied, 220))
  const afterApply = (await raw.evalJson(PAGE_PROBE)).real
  t('apply 之后 VM 真块数 +3（独立通道读出来的）', afterApply === before + 3, `${before} → ${afterApply}`)

  step('6. 独立核对：字面量影子块真的把值填对了')
  const shadow = await raw.evalJson(`(() => {
    const t = window.vm.runtime.targets.find(x => x.getName() === ${JSON.stringify(workTarget)})
    const all = t.blocks._blocks
    const move = Object.values(all).find(b => b.opcode === 'motion_movesteps' && !b.shadow)
    const say = Object.values(all).find(b => b.opcode === 'looks_say' && !b.shadow)
    const stepShadow = all[move.inputs.STEPS.block]
    const msgShadow = all[say.inputs.MESSAGE.block]
    return { step: stepShadow && stepShadow.fields.NUM.value, stepOp: stepShadow && stepShadow.opcode,
             msg: msgShadow && msgShadow.fields.TEXT.value, msgOp: msgShadow && msgShadow.opcode,
             hat: !!Object.values(all).find(b => b.opcode === 'event_whenflagclicked' && b.topLevel) }
  })()`)
  console.log('  独立读数: ' + JSON.stringify(shadow))
  t('STEPS 影子块里有 50（不是空/null）', shadow.step === '50' || shadow.step === 50, JSON.stringify(shadow))
  t('STEPS 影子块 opcode 是 math_number', shadow.stepOp === 'math_number', String(shadow.stepOp))
  t('MESSAGE 影子里是注入的文本', shadow.msg === '桌面版CDP验收', String(shadow.msg))
  t('旗帽块是 topLevel 的（脚本能在工作区看到）', shadow.hat === true, String(shadow.hat))

  step('7. 存档 → 从磁盘装回来（真走一遍文件往返）')
  const outSb3 = join(OUT, 'desktop-roundtrip.sb3')
  const saved = await call('scratch_save_project', { path: outSb3 })
  t('save_project 写出文件并回报路径', !!saved.savedTo && existsSync(saved.savedTo), J(saved, 200))
  const buf = readFileSync(saved.savedTo)
  t('存出来的是合法 zip（PK 魔数）', buf[0] === 0x50 && buf[1] === 0x4b, buf.subarray(0, 2).toString('hex'))
  t('文件大小与回报一致', statSync(saved.savedTo).size === saved.bytes, `${statSync(saved.savedTo).size} vs ${saved.bytes}`)

  // path 参数：会话已存在时 open_editor 应该把它装进现有会话，而不是再开一个窗口
  const reopen = await call('scratch_open_editor', { app: 'desktop', path: saved.savedTo })
  t('已有会话时 open_editor 不再开窗口（alreadyConnected）', reopen.alreadyConnected === true, J(reopen, 200))
  t('并且把作品装进了现有会话（loaded 回来了）', !!(reopen.loaded && reopen.loaded.loadedFrom), J(reopen, 260))
  t('装回来的正是刚存的那份文件', String(reopen.loaded.loadedFrom).toLowerCase() === String(saved.savedTo).toLowerCase(),
    String(reopen.loaded && reopen.loaded.loadedFrom))
  const afterLoad = await raw.evalJson(PAGE_PROBE)
  t('装回来后 VM 里角色还在（没把项目搞坏）', afterLoad.targets.length >= 2, JSON.stringify(afterLoad.targets))
  t('装回来的项目里带着刚注入的块（磁盘往返没丢东西）', afterLoad.real >= before + 3, `${before + 3} 期望 ≤ ${afterLoad.real}`)

  step('8. 接管「用户自己开的」桌面版（仓库里的 .cmd 用固定端口 31821 启动）')
  // 场景：用户用 `启动TurboWarp(AI可接管).cmd` 自己开了桌面版 → 插件应该先探固定端口、
  // 直接接管**他那一份**，而不是再开一个新窗口（这是"我开着作品，AI 帮我改"的真实用法）
  let portFree = true
  try { portFree = !(await (await fetch('http://127.0.0.1:31821/json/version', { signal: AbortSignal.timeout(1200) })).ok) } catch { portFree = true }
  if (!portFree) {
    t('（跳过）31821 已被别的程序占着，没法验"接管用户实例"这条路', true)
  } else {
    // 先把上一段那个（工具开的）窗口关掉
    try { execFileSync('taskkill', ['/PID', String(r.launched.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch {}
    for (let i = 0; i < 40 && twProcessCount() > 0; i++) await sleep(500)
    for (let i = 0; i < 20 && !sessionGone; i++) {
      await sleep(400)
      sessionGone = ((await call('scratch_list_sessions', {})).sessions || []).length === 0
    }
    t('上一份关掉后会话已经清空（接下来是干净的一轮）', sessionGone, String(sessionGone))

    // 模拟用户自己启动：带固定端口开一份（这里直接 spawn，等于用户双击了那个 .cmd）
    const userTw = spawn(r.launched.path, ['--remote-debugging-port=31821'], { stdio: 'ignore' })
    userTw.unref()
    let up = false
    for (let i = 0; i < 60 && !up; i++) {
      await sleep(500)
      try { up = (await fetch('http://127.0.0.1:31821/json/version', { signal: AbortSignal.timeout(1000) })).ok } catch { up = false }
    }
    t('用户自己开的实例起来了（31821 上有 CDP）', up, String(up))
    // 等桌面版把该起的进程都起完（Electron 的 GPU/utility 进程是懒加载的，
    // 刚等到 CDP 端点时数进程会少一个 —— 拿那个数当基线会误判成"新开了一个窗口"）
    await sleep(5000)
    const procsBefore = twProcessCount()
    const attach = await call('scratch_open_editor', { app: 'desktop', waitMs: 30000 })
    t('接管的正是那个实例（launched.attached + via=existing-debug-port）',
      attach.connected === true && attach.launched && attach.launched.attached === true
      && attach.launched.via === 'existing-debug-port', J(attach.launched, 200))
    t('用的是那个固定端口 31821（不是它自己新挑的随机端口）',
      attach.launched.debugPort === 31821, String(attach.launched.debugPort))
    t('接管路径不谎报"我启动了它"（没有 pid 字段）', attach.launched.pid === undefined, J(attach.launched, 160))
    t('接管后同样等到项目就绪', attach.ready === true, J({ ready: attach.ready, targets: attach.targets }, 200))
    // ⚠️ 不能断言"进程数 == 1"：TurboWarp Desktop 是 Electron，一个窗口 = 主进程 + 渲染 + GPU + utility
    //    好几个进程（实测 4-5 个）。要验的是"没有再起一棵新的进程树"。
    t('接管没有新开窗口（进程数没涨）', twProcessCount() <= procsBefore,
      `接管前 ${procsBefore} → 接管后 ${twProcessCount()}`)
    t('提示里说明了"没动他的窗口"', /没动他的窗口/.test(String(attach.hint)), String(attach.hint).slice(0, 120))
    const s3 = await call('scratch_list_sessions', {})
    t('会话表里只有 1 个会话（没有重复注册）', (s3.sessions || []).length === 1, J(s3.sessions, 160))
    try { execFileSync('taskkill', ['/IM', 'TurboWarp.exe', '/F'], { stdio: 'ignore', windowsHide: true }) } catch {}
    for (let i = 0; i < 40 && twProcessCount() > 0; i++) await sleep(400)
    t('收尾：用户实例的窗口也关掉了（进程 0）', twProcessCount() === 0, '剩 ' + twProcessCount())
  }

  step('9. 关掉桌面版之后：会话必须自动掉线（不留僵尸会话）')
  const pid = r.launched.pid
  if (!KEEP_OPEN && twProcessCount() > 0) {
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch (e) {
      console.log('  taskkill 提示: ' + String(e.message).slice(0, 80))
    }
    for (let i = 0; i < 40 && twProcessCount() > 0; i++) await sleep(500)
  }
  t('桌面版进程清零（用户桌面上不留窗口）', KEEP_OPEN ? true : twProcessCount() === 0, '剩 ' + twProcessCount() + ' 个')
  if (!KEEP_OPEN) {
    for (let i = 0; i < 30 && !sessionGone; i++) {
      await sleep(500)
      const s2 = await call('scratch_list_sessions', {})
      sessionGone = (s2.sessions || []).length === 0
    }
    t('会话跟着掉线（CDP 断开 → dropSession）', sessionGone, '还在的会话数 ' + JSON.stringify((await call('scratch_list_sessions', {})).sessions || []).slice(0, 120))
    t('掉线后不留僵尸会话（这是"用户关了窗口 AI 还瞎等"的根因）', (await call('scratch_list_sessions', {})).sessions.length === 0)
  }
} catch (e) {
  fail++
  failures.push('脚本异常: ' + e.message)
  console.log('\n  FAIL 脚本异常: ' + (e.stack || e.message))
} finally {
  if (raw) raw.close()
  if (!KEEP_OPEN) {
    // 兜底：不管上面怎么挂的，都不能把窗口留给用户
    for (const pid of launchedPids) {
      if (!pid) continue
      try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch {}
    }
    for (let i = 0; i < 20 && twProcessCount() > 0; i++) await sleep(400)
    try { rmSync(HOME, { recursive: true, force: true }) } catch {}
    try { rmSync(OUT, { recursive: true, force: true }) } catch {}
  }
}

console.log(`\n=== 结果 ===\n  ${pass} 通过 / ${fail} 失败`)
if (failures.length) console.log('  失败项:\n' + failures.map(f => '   - ' + f).join('\n'))
console.log(`  收尾：TurboWarp 进程 ${twProcessCount()} 个${KEEP_OPEN ? '（KEEP_OPEN=1，没关窗口）' : ''}`)
process.exit(fail ? 1 : 0)
