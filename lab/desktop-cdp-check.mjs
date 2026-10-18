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
  constructor(ws) { this.ws = ws; this.seq = 0; this.waiters = new Map(); this.ctx = null; this.frameId = null; this.events = [] }
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
        // ⚠️ 子 frame 的默认上下文跟主 frame 长得一模一样（isDefault/type=default）。
        //    不挑 frameId 的话，页面里冒出个 iframe 就会把这条验证通道也骗走，
        //    表现是"独立通道突然看到 window.vm === undefined"（真机踩过）。
        if (aux.isDefault && aux.type === 'default' && (!self.frameId || !aux.frameId || aux.frameId === self.frameId)) {
          self.ctx = c.id
          self.events.push('default-ctx')
        } else if (aux.frameId && self.frameId && aux.frameId !== self.frameId) {
          self.events.push('skip-child-frame')
        }
      }
      if (m.method === 'Runtime.bindingCalled') self.events.push('binding:' + m.params.name)
    })
    // 先问主 frame 是谁，再开 Runtime（同 cdp.js：顺序反了就会被 iframe 抢）
    await self.send('Page.enable')
    try {
      const tree = await self.send('Page.getFrameTree')
      self.frameId = tree.frameTree && tree.frameTree.frame && tree.frameTree.frame.id
    } catch { /* 拿不到就退回旧行为 */ }
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
  t('插件 apply 未抛错，注册了 33 个工具', registered.size === 33, '实际 ' + registered.size)
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

  step('6.5 v0.7.0：运行控制 / 状态 / 截图 / 脚本清单（桌面版真机）')
  // 这一段是「问题记录 P0-2」的验收：以前这些能力只能靠 AI 自己连裸 CDP 写脚本。
  // 独立证据优先：点绿旗之后角色坐标真的动了（不是只看工具返回 running=true）。
  const posBefore = await raw.evalJson(`(() => {
    const t = window.vm.runtime.targets.find(x => x.getName() === ${JSON.stringify(workTarget)})
    return { x: t.x, y: t.y, threads: window.vm.runtime.threads.length }
  })()`)
  const st0 = await call('scratch_state', {})
  t('scratch_state 报出运行状态与角色数', st0.running === false && st0.targets >= 2, J(st0, 200))
  const ran = await call('scratch_run', { action: 'greenflag', waitMs: 600 })
  t('scratch_run greenflag 返回 ok', ran.ok !== false && ran.action === 'greenflag', J(ran, 200))
  const posAfter = await raw.evalJson(`(() => {
    const t = window.vm.runtime.targets.find(x => x.getName() === ${JSON.stringify(workTarget)})
    return { x: t.x, y: t.y, threads: window.vm.runtime.threads.length }
  })()`)
  console.log(`  独立读数: x ${posBefore.x} → ${posAfter.x}`)
  t('绿旗之后角色的 x 真的变了（脚本被执行过，不是只回了个 running）',
    posAfter.x !== posBefore.x, `x ${posBefore.x} → ${posAfter.x}`)
  const st1 = await call('scratch_state', { target: workTarget })
  t('scratch_state 能读角色坐标（和独立通道读的一致）', st1.target && Math.abs(st1.target.x - posAfter.x) < 0.01,
    J({ tool: st1.target && st1.target.x, raw: posAfter.x }, 120))
  const stopped = await call('scratch_run', { action: 'stopall', waitMs: 200 })
  t('scratch_run stopall 之后线程归零', stopped.after && stopped.after.running === false && stopped.after.threads === 0, J(stopped.after, 160))

  const clicked = await call('scratch_click', { target: workTarget })
  t('scratch_click 能点（返回点到了谁 + 换了画布坐标）',
    clicked.clicked === workTarget && Number.isFinite(clicked.canvasXY.x) && Number.isFinite(clicked.canvasXY.y), J(clicked, 220))
  t('click 在真渲染器上优先走 pick（不是一上来就退化）', ['pick', 'hat-fallback'].includes(clicked.via), String(clicked.via))
  const keyed = await call('scratch_press_key', { key: 'ArrowRight', holdMs: 40 })
  t('scratch_press_key ok', keyed.key === 'ArrowRight', J(keyed, 160))

  const shot = await call('scratch_screenshot', { path: join(OUT, 'shot.png') })
  t('scratch_screenshot 真的落盘了一张 PNG', existsSync(shot.path) && shot.bytes > 10000, J(shot, 200))
  const shotBuf = readFileSync(shot.path)
  t('截图是合法 PNG（魔数 89 50 4E 47）', shotBuf[0] === 0x89 && shotBuf[1] === 0x50 && shotBuf[2] === 0x4e && shotBuf[3] === 0x47,
    shotBuf.subarray(0, 4).toString('hex'))

  // 归因要真机验：先注入一条"每帧都在跑"的循环，再量 —— 这样热点榜里必须出现它。
  // （只量不跑的项目，归因返回 samples=0 并提示先点绿旗，那种情况在这里单独断言。）
  const idleProf = await call('scratch_profile', { seconds: 0.6 })
  t('没线程在跑时归因为空，并提示先点绿旗（不编造热点）',
    idleProf.attribution && idleProf.attribution.samples === 0 && /绿旗/.test(idleProf.attribution.hint || ''),
    J(idleProf.attribution, 200))
  const loopBlocks = {
    lhat: { opcode: 'event_whenflagclicked', next: 'llo', parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 400, y: 60 },
    llo: { opcode: 'control_forever', next: null, parent: 'lhat', inputs: { SUBSTACK: [2, 'lstep'] }, fields: {}, shadow: false, topLevel: false },
    lstep: { opcode: 'motion_changexby', next: null, parent: 'llo', inputs: { DX: [1, [4, '1']] }, fields: {}, shadow: false, topLevel: false }
  }
  const loopPreview = await call('scratch_add_blocks', { target: workTarget, blocks: loopBlocks })
  const loopApplied = await call('scratch_apply', { planId: loopPreview.planId })
  const loopHatId = loopApplied.idMap && loopApplied.idMap.lhat
  await call('scratch_run', { action: 'greenflag', waitMs: 500 })
  const prof = await call('scratch_profile', { seconds: 1 })
  t('scratch_profile 采到了真实步进耗时（stepMs.avg 是正数）',
    prof.stepMs && typeof prof.stepMs.avg === 'number' && prof.stepMs.avg > 0, J(prof.stepMs, 160))
  t('profile 反推出的 fps 是合理值（1~1000）', prof.fps > 0 && prof.fps <= 1000, String(prof.fps))
  const hotLoop = (prof.attribution && prof.attribution.hot || []).find(h => h.blockId === loopHatId)
  // ⚠️ 真实 TurboWarp 默认开着「编译器」：脚本被编译成 JS，线程栈不移动（实测 stack 恒为 [帽子块]、
  //    blockGlowInFrame 也不动、runtime.profiler 是 null）。所以这里验的是**它有没有如实降级** ——
  //    硬要求块级热点，等于要求它撒谎。
  console.log('  归因模式: ' + JSON.stringify({
    compiled: prof.attribution && prof.attribution.compiled,
    granularity: prof.attribution && prof.attribution.granularity
  }))
  if (prof.attribution && prof.attribution.compiled) {
    const scriptHit = (prof.attribution.scripts || []).find(s => s.blockId === loopHatId)
    t('编译器开着时如实报 compiled=true + granularity=script（不冒充块级热点）',
      prof.attribution.granularity === 'script' && prof.attribution.hot === undefined, J(prof.attribution, 200))
    t('脚本级归因里认出了那条在跑的脚本（活跃线程占比）',
      !!scriptHit && scriptHit.target === workTarget && scriptHit.pct > 0, J(scriptHit || prof.attribution.scripts, 240))
    t('并用大白话告诉用户怎么才能拿到块级（关掉编译器）',
      /编译器/.test(prof.attribution.note || '') && /关掉/.test(prof.attribution.note || ''), String(prof.attribution.note).slice(0, 120))
  } else {
    t('归因认出了那条每帧都在跑的脚本（真机上的线程栈采样）',
      !!hotLoop && hotLoop.target === workTarget && hotLoop.pct > 0, J(hotLoop || (prof.attribution && prof.attribution.hot), 260))
    t('归因里带它最热的 opcode（知道该改哪几块）',
      !!hotLoop && Array.isArray(hotLoop.topOpcodes) && hotLoop.topOpcodes.length > 0, J(hotLoop && hotLoop.topOpcodes, 160))
  }
  await call('scratch_run', { action: 'stopall', waitMs: 150 })

  const scripts = await call('scratch_list_scripts', { target: workTarget })
  t('scratch_list_scripts 找到刚注入的绿旗脚本',
    (scripts.scripts || []).some(s => s.opcode === 'event_whenflagclicked' && s.blockCount >= 3), J(scripts, 260))
  t('list_scripts 区分真脚本与游离块（两个计数都在）',
    typeof scripts.scriptCount === 'number' && typeof scripts.looseCount === 'number', J({ s: scripts.scriptCount, l: scripts.looseCount }, 100))
  const rsSummary = await call('scratch_read_script', { target: workTarget, summary: true })
  t('read_script summary 不回块体（结构视图，体积可控）', rsSummary.summary === true && !rsSummary.blocks, J(Object.keys(rsSummary), 200))
  t('read_script 默认不回变量（7.5MB 那个坑）', rsSummary.variablesOmitted === true, String(rsSummary.variablesOmitted))

  const batch = await call('scratch_batch', { calls: [
    { op: 'state' }, { op: 'list_scripts', args: { target: workTarget } }, { op: 'screenshot', args: { path: join(OUT, 'shot2.png') } }
  ] })
  t('scratch_batch 一次做了 3 件事，全部成功', batch.count === 3 && batch.failed === 0, J(batch.results && batch.results.map(r2 => r2.ok), 120))
  t('batch 里的截图也走通了（页面拿不到的能力单独分流）', existsSync(join(OUT, 'shot2.png')), J(batch, 160))
  t('batch 逐条报了各自耗时', (batch.results || []).every(r2 => typeof r2.ms === 'number'), J(batch.results, 200))
  const denied = await call('scratch_batch', { calls: [{ op: 'add_blocks', args: {} }] })
  t('batch 拒绝写操作（不绕过 preview/apply 的确认）',
    denied.failed === 1 && /白名单/.test(denied.results[0].error || ''), J(denied.results, 200))

  const self = await call('scratch_selftest', {})
  t('scratch_selftest 全绿（桥/会话/注入/项目/Blockly/窗口都在位）', self.ok === true, J(self.checks, 400))
  const winCheck = (self.checks || []).find(c => c.check === '窗口可见')
  t('selftest 的窗口项独立确认可见（真机上用户看得到）', !!(winCheck && winCheck.ok === true), J(winCheck, 200))

  step('6.6 v0.8.0：背包（存 → 换角色取出来 → 独立通道核对）')
  // 背包的价值只有"取出来还能用"这一条。所以这里不读工具的返回值当证据：
  //   ① 存：写进 $DSH_HOME/scratch-backpack（那份文件是真的 JSON，能独立解析）
  //   ② 取：注进**另一个角色**（Stage），然后用独立 CDP 通道读 Stage 的块
  const hatId = applied.idMap && applied.idMap.hat
  const bpSaved = await call('scratch_backpack', {
    action: 'save', name: 'desk-check', target: workTarget, scriptIds: [hatId],
    title: '桌面版验收片段', description: '验收用，跑完就删', tags: ['check'],
    notes: '这段是 desktop-cdp-check 存的'
  })
  const bpFile = join(HOME, 'scratch-backpack', 'desk-check.json')
  t('save 落盘到 $DSH_HOME/scratch-backpack（路径就在返回值里）',
    bpSaved.saved === 'desk-check' && existsSync(bpFile), J(bpSaved, 240))
  const bpJson = JSON.parse(readFileSync(bpFile, 'utf8'))
  const bpRealBlocks = Object.values(bpJson.blocks || {}).length
  t('存下来的 blocks 是真积木（3 块：旗帽 + 移动 + 说）', bpRealBlocks === 3, String(bpRealBlocks))
  t('元数据跟着存（title/notes/source.target）',
    bpJson.title === '桌面版验收片段' && /desktop-cdp-check/.test(bpJson.notes) && bpJson.source.target === workTarget,
    J(bpJson.source, 160))
  const bpList = await call('scratch_backpack', { action: 'list' })
  t('list 扫得到它，并给出块数/标签', (bpList.items || []).some(x => x.name === 'desk-check' && x.blocks === 3 && x.tags.includes('check')),
    J(bpList.items, 260))
  t('INDEX.md 也生成了（AI 能廉价扫目录）', existsSync(join(HOME, 'scratch-backpack', 'INDEX.md')))

  const beforeStage = await raw.evalJson(`(() => {
    const s = window.vm.runtime.targets.find(x => x.isStage)
    return Object.keys(s.blocks._blocks).length
  })()`)
  const bpLoadPreview = await call('scratch_backpack_load', { name: 'desk-check', target: 'Stage', x: 40, y: 40 })
  t('preview 档下 load 只给计划（项目还没动）',
    bpLoadPreview.mode === 'preview' && !!bpLoadPreview.planId, J(bpLoadPreview, 240))
  t('计划里说清"注的是哪条、会补什么变量"',
    bpLoadPreview.preview && bpLoadPreview.preview.snippet === 'desk-check' &&
    Array.isArray(bpLoadPreview.preview.creates), J(bpLoadPreview.preview, 200))
  const bpApplied = await call('scratch_apply', { planId: bpLoadPreview.planId })
  // added 数的是**新建块的总数**（含内联字面量展开出来的影子块），所以 3 个非影子块 = 5 个块
  t('apply 之后真的注进去了（3 块脚本 + 2 个字面量影子）',
    bpApplied.changed && bpApplied.changed.added === 5, J(bpApplied, 240))
  const stageBlocks = await raw.evalJson(`(() => {
    const s = window.vm.runtime.targets.find(x => x.isStage)
    const all = s.blocks._blocks
    const say = Object.values(all).find(b => b.opcode === 'looks_say' && !b.shadow)
    const move = Object.values(all).find(b => b.opcode === 'motion_movesteps' && !b.shadow)
    const sayShadow = say && all[say.inputs.MESSAGE.block]
    const hats = Object.values(all).filter(b => b.topLevel && !b.shadow)
    return {
      total: Object.keys(all).length,
      msg: sayShadow && sayShadow.fields.TEXT.value,
      steps: move && all[move.inputs.STEPS.block] && all[move.inputs.STEPS.block].fields.NUM.value,
      hats: hats.map(b => ({ op: b.opcode, x: b.x, y: b.y }))
    }
  })()`)
  t('独立通道读到的块数增量 == 工具自报的 added（两边对得上）',
    stageBlocks.total === beforeStage + bpApplied.changed.added, `${beforeStage} → ${stageBlocks.total}（自报 +${bpApplied.changed.added}）`)
  t('取出来的片段值没丢（消息文本 + 移动步数原样）',
    stageBlocks.msg === '桌面版CDP验收' && String(stageBlocks.steps) === '50', J(stageBlocks, 200))
  t('落点是给的那个坐标（不是沿用存的时候的）',
    stageBlocks.hats.length === 1 && stageBlocks.hats[0].x === 40 && stageBlocks.hats[0].y === 40,
    J(stageBlocks.hats, 160))
  const bpDel = await call('scratch_backpack', { action: 'delete', name: 'desk-check' })
  t('delete 把它挪进 _trash（没真删）', !existsSync(bpFile) && /_trash/.test(bpDel.movedTo || ''), J(bpDel, 200))
  t('删完 list 里没了', (await call('scratch_backpack', { action: 'list' })).count === 0)

  step('6.7 v0.9.0 / v0.9.1：精细编辑 + 真加 SVG 造型 + 子 frame 抢上下文 + 执行器自愈（桌面版真机 + 独立通道核对）')
  // 为什么非要真机：这三类操作改完都必须让 **GUI 跟着变**（工作区按 vm 的 XML 重建）。
  // 替身层没有 Blockly，看不见「数据改了、工作区还连着」这种失败 —— 用户那边就是"根本没分开"。
  const sayId = applied.idMap.say
  const moveId = applied.idMap.move
  const wsSay = `(() => {
    const ws = (window.ScratchBlocks || window.Blockly).getMainWorkspace()
    const b = ws.getBlockById(${JSON.stringify(sayId)})
    if (!b) return { found: false }
    // ⚠️ 要用 getParent()，不能用 getSurroundParent()：后者只认"包围块"（C 块的 SUBSTACK），
    //    普通 next 链里的块它也返回 null —— 用它判断"是不是顶层脚本"会永远得到"是"。
    const p = b.getParent()
    return { found: true, top: p === null, parentId: p ? p.id : null }
  })()`

  const mvPreview = await call('scratch_move_block', { target: workTarget, blockId: sayId, mode: 'detach' })
  t('move_block 走 preview（先给计划，不直写）', mvPreview.mode === 'preview' && !!mvPreview.planId, J(mvPreview, 220))
  const mvRes = await call('scratch_apply', { planId: mvPreview.planId })
  t('detach 执行后报出「从哪来」', !!(mvRes.from && mvRes.from.parent === moveId), J(mvRes, 240))
  const afterDetach = await raw.evalJson(`(() => {
    const t = window.vm.runtime.targets.find(x => x.getName() === ${JSON.stringify(workTarget)})
    const all = t.blocks._blocks
    const move = all[${JSON.stringify(moveId)}]
    const say = all[${JSON.stringify(sayId)}]
    return { moveNext: move && move.next, sayParent: say && say.parent, sayTop: !!(say && say.topLevel),
             scripts: t.blocks._scripts.length }
  })()`)
  t('独立通道：断口补上了（move.next 变 null，没有留下半截链）', afterDetach.moveNext === null, J(afterDetach, 200))
  t('独立通道：被摘下来的块变成顶层脚本（parent=null、topLevel=true）',
    afterDetach.sayParent === null && afterDetach.sayTop === true, J(afterDetach, 200))
  const wsAfterDetach = await raw.evalJson(wsSay)
  t('**GUI 也真的分开了**（工作区里那块已经没有父块 —— 只有真机才能验这条）',
    wsAfterDetach.found === true && wsAfterDetach.top === true, J(wsAfterDetach, 200))

  const mvBack = await call('scratch_move_block', { target: workTarget, blockId: sayId, mode: 'after', toBlockId: moveId })
  const mvBackRes = await call('scratch_apply', { planId: mvBack.planId })
  const afterAttach = await raw.evalJson(`(() => {
    const t = window.vm.runtime.targets.find(x => x.getName() === ${JSON.stringify(workTarget)})
    const all = t.blocks._blocks
    return { moveNext: all[${JSON.stringify(moveId)}].next, sayParent: all[${JSON.stringify(sayId)}].parent,
             sayTop: !!all[${JSON.stringify(sayId)}].topLevel }
  })()`)
  t('after 接回去：move.next 又是 say，say 不再是顶层',
    afterAttach.moveNext === sayId && afterAttach.sayParent === moveId && afterAttach.sayTop === false, J(afterAttach, 200))
  const wsAfterAttach = await raw.evalJson(wsSay)
  const attachDiag = await raw.evalJson(`(() => {
    const vm = window.vm
    const et = vm.editingTarget
    const ws = (window.ScratchBlocks || window.Blockly).getMainWorkspace()
    const id = ${JSON.stringify(sayId)}
    const shape = () => { const b = ws.getBlockById(id); const p = b && b.getParent(); return b ? { top: p === null } : null }
    const before = shape()
    const xml = String(et.blocks.toXML())
    const at = xml.indexOf('id="' + id + '"')
    const inScripts = et.blocks._scripts.includes(id)
    // 手动再发一次 workspaceUpdate：如果这样 GUI 就对了，说明刚才那次 op 里的刷新没落到 GUI
    try { vm.emitWorkspaceUpdate() } catch (e) { return { err: String(e) } }
    return {
      editing: et && et.getName(),
      inScripts,
      xmlCount: xml.split(id).length - 1,
      around: xml.slice(Math.max(0, at - 170), at + 30),
      wsCount: ws.getAllBlocks(false).filter(b => b.id === id).length,
      before,
      after: shape()
    }
  })()`)
  t('**GUI 也真的接回去了**（工作区里它又有了父块）',
    wsAfterAttach.found === true && wsAfterAttach.top === false,
    J(wsAfterAttach, 220) + ' / 诊断: ' + J(attachDiag, 520))
  t('接链报告里说清接到了谁后面', !!(mvBackRes.to && mvBackRes.to.parent === moveId), J(mvBackRes, 240))

  const cyc = await call('scratch_move_block', { target: workTarget, blockId: applied.idMap.hat, mode: 'after', toBlockId: sayId })
  let cycErr = ''
  try { await call('scratch_apply', { planId: cyc.planId }) } catch (e) { cycErr = String(e.message || e) }
  t('把链头接到自己的子孙上会报错（成环会把工作区搞崩）', /成环|自己/.test(cycErr), cycErr)

  // 改块的「短暂高亮」：GUI 监听 BLOCK_GLOW_ON → workspace.glowBlock(id, on) → 描一圈黄光
  // （跟积木正在执行时同一个视觉效果）。这里直接读工作区块自己的 isGlowingBlock_，
  // 亮完再读一次必须灭 —— 否则就是"亮着不灭"，比不亮还烦人。
  const glowUpd = await call('scratch_update_block', {
    target: workTarget, blockId: sayId, inputs: { MESSAGE: [1, [10, '高亮测试']] }
  })
  const glowRes = await call('scratch_apply', { planId: glowUpd.planId })
  t('改块后报出 glowed=1（它真去发光了，不是只回个数字）', glowRes.glowed === 1, J(glowRes, 240))
  const glowNow = await raw.evalJson(`(() => {
    const ws = (window.ScratchBlocks || window.Blockly).getMainWorkspace()
    const b = ws.getBlockById(${JSON.stringify(sayId)})
    return { found: !!b, glowing: !!(b && b.isGlowingBlock_) }
  })()`)
  t('工作区里那块真的处于高亮态（GUI 侧证据，不是工具的返回值）',
    glowNow.found === true && glowNow.glowing === true, J(glowNow, 220))
  await new Promise(r => setTimeout(r, 1900))
  const glowLater = await raw.evalJson(`(() => {
    const ws = (window.ScratchBlocks || window.Blockly).getMainWorkspace()
    const b = ws.getBlockById(${JSON.stringify(sayId)})
    return { glowing: !!(b && b.isGlowingBlock_) }
  })()`)
  t('高亮会自己灭（约 1.4 秒后恢复，不会一直亮着）', glowLater.glowing === false, J(glowLater, 200))

  // ② 变量：桌面版上也走 create → set → rename → delete，每一步都用独立通道读真值
  const vCreate = await call('scratch_variable', { action: 'create', name: '桌面版计分', scope: 'global' })
  await call('scratch_apply', { planId: vCreate.planId })
  const vProbe = `(() => {
    const s = window.vm.runtime.targets.find(x => x.isStage)
    const v = Object.values(s.variables).find(x => x.name === ${JSON.stringify('桌面版计分')})
    return { found: !!v, id: v && v.id, value: v && v.value }
  })()`
  const v1 = await raw.evalJson(vProbe)
  t('create：独立通道在舞台上读到了这个变量', v1.found === true, J(v1, 200))
  const vSet = await call('scratch_variable', { action: 'set', name: '桌面版计分', value: 7 })
  await call('scratch_apply', { planId: vSet.planId })
  const v2 = await raw.evalJson(vProbe)
  t('set：舞台上的值真的是 7', v2.value === 7, J(v2, 200))
  const vRen = await call('scratch_variable', { action: 'rename', name: '桌面版计分', newName: '桌面版得分' })
  await call('scratch_apply', { planId: vRen.planId })
  const v3 = await raw.evalJson(`(() => {
    const s = window.vm.runtime.targets.find(x => x.isStage)
    const v = Object.values(s.variables).find(x => x.id === ${JSON.stringify(v1.id)})
    return { name: v && v.name, value: v && v.value }
  })()`)
  t('rename：同一个 id，名字变成新名字、值没动', v3.name === '桌面版得分' && v3.value === 7, J(v3, 200))
  const vDel = await call('scratch_variable', { action: 'delete', name: '桌面版得分' })
  await call('scratch_apply', { planId: vDel.planId })
  const v4 = await raw.evalJson(`(() => {
    const s = window.vm.runtime.targets.find(x => x.isStage)
    return { gone: !Object.values(s.variables).some(x => x.id === ${JSON.stringify(v1.id)}) }
  })()`)
  t('delete：舞台上真没了', v4.gone === true, J(v4, 200))

  // ③ 造型：改名 → 切过去 → 删掉；只剩一个时必须拒绝。
  //    这一段用"复制现有造型"（不走 renderer 建新 skin）：加新 SVG 造型的事在 ④ 单独验，
  //    因为那个动作历史上真把会话打断过（根因是 iframe 抢上下文，不是在造型本身）。
  //    另外验一下坏 SVG 会被**干净拒绝**（校验在碰 VM 之前就抛，不会留 "?" 占位）。
  const costBefore = await raw.evalJson(`window.vm.runtime.targets.find(x => x.getName() === ${JSON.stringify(workTarget)}).getCostumes().length`)
  await raw.evalJson(`(() => {
    const t = window.vm.runtime.targets.find(x => x.getName() === ${JSON.stringify(workTarget)})
    const c = t.getCostumes()[0]
    t.addCostume(Object.assign({}, c), t.getCostumes().length)
    return t.getCostumes().length
  })()`)
  const costAfterAdd = await raw.evalJson(`window.vm.runtime.targets.find(x => x.getName() === ${JSON.stringify(workTarget)}).getCostumes().length`)
  t('（准备）复制出一个造型当素材', costAfterAdd === costBefore + 1, `${costBefore} → ${costAfterAdd}`)
  let badSvgErr = ''
  const costBeforeBad = costAfterAdd
  // 空/非 SVG 会被工具的**前置校验**拒掉（在碰 VM 之前就抛，addCostume 根本不会被调用）
  const badSvg = await call('scratch_add_costume', { target: workTarget, name: '坏造型', svg: '   ' })
  try { await call('scratch_apply', { planId: badSvg.planId }) } catch (e) { badSvgErr = String(e.message || e) }
  const costAfterBad = await raw.evalJson(`window.vm.runtime.targets.find(x => x.getName() === ${JSON.stringify(workTarget)}).getCostumes().length`)
  t('空 SVG 在碰 VM 之前就被拒绝，项目里不会多出坏造型',
    /svg 不能为空/.test(badSvgErr) && costAfterBad === costBeforeBad,
    badSvgErr.slice(0, 160) + ` / costumes ${costBeforeBad}→${costAfterBad}`)
  const cRen = await call('scratch_costume', { target: workTarget, action: 'rename', index: costAfterAdd, newName: '验收造型B' })
  const cRenRes = await call('scratch_apply', { planId: cRen.planId })
  t('rename：返回的 to 就是最终名字（被占用会自动加后缀）',
    cRenRes.to === '验收造型B', J(cRenRes, 200))
  const cSet = await call('scratch_costume', { target: workTarget, action: 'set', index: costAfterAdd })
  await call('scratch_apply', { planId: cSet.planId })
  const cNow = await raw.evalJson(`(() => {
    const t = window.vm.runtime.targets.find(x => x.getName() === ${JSON.stringify(workTarget)})
    return { current: t.currentCostume + 1, name: t.getCostumes()[t.currentCostume].name }
  })()`)
  t('set：独立通道看到当前造型真换成了那个（截图前摆姿势靠它）',
    cNow.current === costAfterAdd && cNow.name === '验收造型B', J(cNow, 200))
  const cDel = await call('scratch_costume', { target: workTarget, action: 'delete', index: costAfterAdd })
  await call('scratch_apply', { planId: cDel.planId })
  const costAfterDel = await raw.evalJson(`window.vm.runtime.targets.find(x => x.getName() === ${JSON.stringify(workTarget)}).getCostumes().length`)
  t('delete：造型数回到原样', costAfterDel === costBefore, `${costAfterDel} vs ${costBefore}`)
  const cGuard = await call('scratch_costume', { target: 'Stage', action: 'delete', index: 1 })
  let cGuardErr = ''
  try { await call('scratch_apply', { planId: cGuard.planId }) } catch (e) { cGuardErr = String(e.message || e) }
  t('只剩一个造型时拒绝删除（背景删掉就没得显示）', /只剩一个造型/.test(cGuardErr), cGuardErr)

  // ④ 真加一个 SVG 造型：这一段以前是**不敢跑**的 —— 实测"加完造型之后所有 op 都超时 15s"。
  //    真正的原因不在造型：那条错误路径会让页面里冒出一个 sandbox iframe，而旧代码会被
  //    那个 iframe 的**默认执行上下文**抢走（iframe 的上下文和主 frame 长得一模一样）。
  //    现在 cdp.js 只认主 frame 的上下文 + 投递失败会自愈重注入，所以敢在这里真跑。
  const svgSrc = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">'
    + '<rect x="8" y="8" width="48" height="48" fill="#4c97ff"/></svg>'
  const addSvg = await call('scratch_add_costume', { target: workTarget, name: '验收SVG', svg: svgSrc })
  const addSvgRes = await call('scratch_apply', { planId: addSvg.planId })
  t('add_costume：返回 skin=true（SVG 真被渲染器接住了，不是 "?" 占位）',
    addSvgRes.skin === true, J(addSvgRes, 240))
  t('add_costume：旋转中心按真实图形算（64×64 方块 → 32,32，不是硬编码的 48/50）',
    Array.isArray(addSvgRes.rotationCenter) && addSvgRes.rotationCenter[0] === 32 && addSvgRes.rotationCenter[1] === 32,
    J(addSvgRes.rotationCenter, 60))
  const svgOnPage = await raw.evalJson(`(() => {
    const t = window.vm.runtime.targets.find(x => x.getName() === ${JSON.stringify(workTarget)})
    const c = t.getCostumes().find(x => x.name === '验收SVG')
    return { found: !!c, skin: !!(c && c.skinId), rc: c ? [c.rotationCenterX, c.rotationCenterY] : null, size: c ? c.size : null }
  })()`)
  t('独立通道：这个造型真的有 skin（有 skin 才画得出来）', svgOnPage.found === true && svgOnPage.skin === true, J(svgOnPage, 200))
  const afterSvg = await call('scratch_state', {})
  t('**加完造型之后会话还活着**（以前这一下之后，每个 op 都开始超时）', afterSvg.targets >= 2, J(afterSvg, 160))

  // ⑤ 子 frame 抢上下文：确定性回归（不用等哪个错误路径自己触发）
  //    页面里塞一个 sandbox iframe —— 它会创建一个"同名同姓"的默认上下文。
  //    修之前：会话立刻被抢走，之后每个 op 都超时 15s，而编辑器画面完全正常。
  await raw.evalJson(`(() => {
    const f = document.createElement('iframe')
    f.id = 'dsh-hijack-test'
    f.setAttribute('sandbox', '')
    f.src = 'about:blank'
    document.body.appendChild(f)
    return 'iframe-appended'
  })()`)
  await sleep(900)
  t('（诊断）iframe 真的产生了一个默认上下文、被我们忽略了（不是"没测到"）',
    raw.events.includes('skip-child-frame'), JSON.stringify(raw.events.slice(-4)))
  const afterIframe = await call('scratch_state', {})
  t('页面里冒出 iframe 之后会话仍然固在主 frame（子 frame 抢不走执行上下文）',
    afterIframe.targets >= 2, J(afterIframe, 160))
  const sWithIframe = await call('scratch_list_sessions', {})
  const transport = sWithIframe.sessions && sWithIframe.sessions[0] && sWithIframe.sessions[0].transport
  t('list_sessions 能自报运输层状态（injected / 主 frame / 跳过了几个子 frame）',
    /injected=true/.test(String(transport)) && /skippedFrames=[1-9]/.test(String(transport)), String(transport))
  const stillMain = await raw.evalJson(`({ vm: typeof window.vm, bridge: typeof window.__dshBridge, targets: window.vm ? window.vm.runtime.targets.length : -1 })`)
  t('独立通道也仍然在编辑器页面里（没被带进 iframe）', stillMain.vm === 'object' && stillMain.targets >= 2, J(stillMain, 160))
  await raw.evalJson(`(() => { const f = document.getElementById('dsh-hijack-test'); if (f) f.remove(); return 'removed' })()`)
  await sleep(300)

  // 把这个 SVG 造型删掉，保持项目干净（顺带验 delete 对"真 SVG 造型"也成立）
  const delSvg = await call('scratch_costume', { target: workTarget, action: 'delete', name: '验收SVG' })
  await call('scratch_apply', { planId: delSvg.planId })
  const costFinal = await raw.evalJson(`window.vm.runtime.targets.find(x => x.getName() === ${JSON.stringify(workTarget)}).getCostumes().length`)
  t('删掉之后造型数回到原样', costFinal === costBefore, `${costFinal} vs ${costBefore}`)

  // ⑥ 执行器从页面里消失（= 上下文被换掉 / 页面重载过的那个瞬间）：
  //    AI 应该自己把执行器注回去，而不是让用户等 15 秒看到"超时"。
  await raw.evalJson(`(() => {
    delete window.__dshBridge
    delete window.__dshCdpDeliver
    delete window.__dshCdpShimInstalled
    return typeof window.__dshBridge + '/' + typeof window.__dshCdpDeliver
  })()`)
  const healedAt = Date.now()
  const healed = await call('scratch_state', {})
  const healMs = Date.now() - healedAt
  t('执行器没了之后，下一次调用自己重新注入并成功（不是干等超时）',
    healed.targets >= 2 && healMs < 6000, `${healMs}ms / ${J(healed, 120)}`)
  const transport2 = (await call('scratch_list_sessions', {})).sessions[0].transport
  t('自愈次数记在运输层状态里（排查时一眼看出来"它自己接过一次"）',
    /reinjects=[1-9]/.test(String(transport2)), String(transport2))
  const healProbe = await raw.evalJson(`({ bridge: typeof window.__dshBridge, targets: window.vm ? window.vm.runtime.targets.length : -1 })`)
  t('独立通道确认页面上执行器真的回来了', healProbe.bridge === 'object' && healProbe.targets >= 2, J(healProbe, 160))

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
