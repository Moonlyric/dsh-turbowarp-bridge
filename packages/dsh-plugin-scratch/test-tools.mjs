// test-tools.mjs — 插件侧工具行为单测（不碰浏览器）
//
// 覆盖 scratch_open_editor（AI 主动唤起编辑器）的每条分支，以及 list_sessions 的
// 「没会话时给配置包」这条路。用桩脚本冒充浏览器/桌面版，断言真的把 URL 传出去了。
//
// 用法：node test-tools.mjs
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const HOME = mkdtempSync(join(tmpdir(), 'dsh-tools-home-'))
const STUB_DIR = mkdtempSync(join(tmpdir(), 'dsh-tools-stub-'))
process.env.DSH_HOME = HOME

// 端口要现取现用，不能写死：写死的话，上一次跑崩了留下来的 node 进程占着端口，
// 会让这一轮莫名其妙地全红（踩过，排查半天才发现是"上一次的自己"占着）。
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer()
  s.once('error', rej)
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) })
})
const PORT = await freePort()
let pass = 0, fail = 0
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' | ' + detail : '')) }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
// v0.7.0 加了 9 个运行控制/可观测工具（19 → 28），v0.8.0 加了 2 个背包工具（→ 30）
// v0.10.0 加了 5 个（结构总览 / 单块上下文 / 空白作品 / 角色改名 / 重启窗口）→ 38
const TOOL_COUNT = 38

// ---- 桩：把收到的参数追加到一个文件里，冒充「被打开的程序」 ----
const browserStub = join(STUB_DIR, 'stub-browser.cmd')
const desktopStub = join(STUB_DIR, 'stub-desktop.cmd')
const logFile = join(STUB_DIR, 'launched.txt')
for (const [p, tag] of [[browserStub, 'browser'], [desktopStub, 'desktop']]) {
  writeFileSync(p, `@echo off\r\necho ${tag} %* >> "${logFile}"\r\n`)
}
const launches = () => existsSync(logFile)
  ? readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean)
  : []

const registered = new Map()
const fakeCtx = {
  logger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  effect: (fn) => { const d = fn(); if (typeof d === 'function') process.on('exit', () => { try { d() } catch {} }) },
  tools: { register: (tool) => registered.set(tool.name, tool) }
}

const mod = await import('./index.js')
mod.apply(fakeCtx, {
  safety: 'preview', bridgePort: PORT, maxSnapshots: 2, skillsEnabled: false,
  browserPath: browserStub, desktopPath: desktopStub
})
t('插件 apply 未抛错', true)
t('注册了 ' + TOOL_COUNT + ' 个工具', registered.size === TOOL_COUNT, '实际 ' + registered.size)

const call = async (name, args) => {
  const tool = registered.get(name)
  if (!tool) throw new Error('没有工具 ' + name)
  const clean = {}
  for (const k of Object.keys(args || {})) if (args[k] !== undefined) clean[k] = args[k]
  return await tool.execute(clean)
}
const thrown = async (fn) => { try { await fn(); return null } catch (e) { return e.message } }

// ==================== 1. 没有会话：唤起浏览器 + 给配置包 ====================
console.log('\n[1] 没有会话时唤起浏览器')
let r = await call('scratch_open_editor', { waitMs: 1500 })
await sleep(500)
t('返回 connected=false（还没连上）', r.connected === false, JSON.stringify(r).slice(0, 200))
t('真的把 turbowarp.org 传给了浏览器（桩脚本收到了）',
  launches().some(l => l.startsWith('browser') && l.includes('turbowarp.org/editor')), JSON.stringify(launches()))
t('返回里带上 token 与三步配置指引（AI 可以直接念给用户）',
  !!(r.setup && /^[0-9a-f]{32}$/.test(r.setup.token) && r.setup.step1 && r.setup.step2 && r.setup.step3),
  JSON.stringify(r.setup || {}).slice(0, 200))
t('waitMs 生效（等了大约那么久，没有立刻返回）', r.waitedMs >= 1200, 'waitedMs=' + r.waitedMs)
t('launched.url 如实回报打开的是哪个地址', r.launched.url === 'https://turbowarp.org/editor', JSON.stringify(r.launched))

// ==================== 2. 自定义地址 ====================
console.log('\n[2] 打开指定作品地址')
r = await call('scratch_open_editor', { url: 'https://turbowarp.org/123456789', waitMs: 0, force: true })
await sleep(400)
t('自定义 url 被原样传出去', launches().some(l => l.includes('turbowarp.org/123456789')), JSON.stringify(launches()))
t('waitMs=0 时不等待', r.connected === false && r.waitedMs < 500, 'waitedMs=' + r.waitedMs)

console.log('\n[3] 只允许 http/https')
let err = await thrown(() => call('scratch_open_editor', { url: 'file:///C:/Windows/System32/calc.exe', waitMs: 0 }))
t('file:// 地址被拒', !!err && /只允许 http\/https/.test(err), String(err))
err = await thrown(() => call('scratch_open_editor', { url: 'javascript:alert(1)', waitMs: 0 }))
t('javascript: 地址被拒', !!err && /只允许 http\/https/.test(err), String(err))
t('被拒的地址没有传给桩（没有多出启动记录）', launches().filter(l => /calc\.exe|javascript/.test(l)).length === 0, JSON.stringify(launches()))

// ==================== 4. Desktop 分支（CDP 直连那条路） ====================
// 桌面版现在**能被驱动**了：我们启动时给它带上 --remote-debugging-port，再用 CDP 把
// 页面执行器注进去（TurboWarp Desktop 装不了浏览器扩展，所以扩展那条路对它无解）。
// 这里用桩脚本冒充桌面版：桩不会起 CDP 端点，所以必然走到"接不上"的诚实分支。
console.log('\n[4] app=desktop（本地 TurboWarp Desktop + CDP 直连）')
r = await call('scratch_open_editor', { app: 'desktop', waitMs: 0 })
await sleep(500)
t('桌面版桩被启动了', launches().some(l => l.startsWith('desktop')), JSON.stringify(launches()))
t('启动时带了 --remote-debugging-port（CDP 直连的前提）',
  launches().some(l => l.startsWith('desktop') && /--remote-debugging-port=\d+/.test(l)),
  JSON.stringify(launches().filter(l => l.startsWith('desktop'))))
t('启动本身没报错（launched.error 为空 —— .cmd 桩走的是 cmd.exe 那条路）',
  !r.launched.error, String(r.launched.error || ''))
t('接不上时不谎报连上，且说清是 CDP 的问题',
  r.connected === false && typeof r.error === 'string' && /CDP/.test(r.error + (r.hint || '')),
  JSON.stringify({ connected: r.connected, error: r.error }).slice(0, 240))
t('桌面版分支不需要 token（那条路没有 token 这回事）', r.setup === undefined, JSON.stringify(Object.keys(r)))
t('返回值里如实带上调试端口，方便排查', Number.isInteger(r.launched && r.launched.debugPort), JSON.stringify(r.launched))

console.log('\n[4.5] CDP 上下文挑选（子 frame 抢走会话 —— v0.9.1 的根因，纯函数层守着）')
const { classifyContext } = await import('./cdp.js')
const MAIN = 'FRAME-MAIN'
const ctxMain = { id: 1, auxData: { isDefault: true, type: 'default', frameId: MAIN } }
const ctxChild = { id: 3, auxData: { isDefault: true, type: 'default', frameId: 'FRAME-IFRAME' } }
const ctxIsolated = { id: 2, auxData: { isDefault: false, type: 'isolated', frameId: MAIN } }
t('主 frame 的默认上下文 → main（只有它里面有 window.vm）', classifyContext(ctxMain, MAIN) === 'main')
t('子 frame 的默认上下文 → child-frame（isDefault 也是 true，光看它一定被骗）',
  classifyContext(ctxChild, MAIN) === 'child-frame')
t('隔离世界 → isolated（注进去也是白注）', classifyContext(ctxIsolated, MAIN) === 'isolated')
t('还不知道主 frame 是谁时，先接受默认上下文（getFrameTree 失败的兜底）',
  classifyContext(ctxMain, null) === 'main')
t('上下文没带 frameId 时不当成子 frame（宁可接受也别把编辑器的上下文拒了）',
  classifyContext({ auxData: { isDefault: true, type: 'default' } }, MAIN) === 'main')
t('没有 auxData 的怪上下文不会让它崩', classifyContext({}, MAIN) === 'isolated' && classifyContext(undefined, MAIN) === 'isolated')

// ==================== 5. 桌面版：已在运行 / 找不到 两条分支 ====================
// ⚠️ 这一节以前会**在用户桌面上真开一个 TurboWarp 窗口**：它故意不传 desktopPath 来测"自动定位"，
//    结果在装了 TurboWarp 的机器上，自动定位真的找到了 exe 并把它拉起来了（踩过，被用户抓到）。
//    现在改成两条都不会有副作用的路：
//      a) desktopPath 指向**正在运行的进程**（node.exe 就是本测试自己）→ 验"已在运行不重复开"
//      b) 把注册表探测隔离掉（PATH 前置一个假的 reg.exe）+ desktopPath 指向不存在的路径 → 验"找不到"
console.log('\n[5] 桌面版：已在运行 → 不重复开（它那份没有调试端口，接不进去）')
const mod2 = await import('./index.js')
const reg2 = new Map()
const ctx2 = {
  logger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  effect: () => {},
  tools: { register: (tool) => reg2.set(tool.name, tool) }
}
// process.execPath = node.exe，此刻至少有一个在跑（就是测试自己）→ 必然命中"已在运行"
mod2.apply(ctx2, { safety: 'auto', bridgePort: PORT + 1, maxSnapshots: 1, desktopPath: process.execPath })
const r5 = await reg2.get('scratch_open_editor').execute({ app: 'desktop', waitMs: 0 })
t('检测到已在运行 → alreadyRunning，且 launched.skipped 标出来了',
  r5.alreadyRunning === true && r5.launched && r5.launched.skipped === true,
  JSON.stringify(r5).slice(0, 260))
t('已经在运行时进程数如实回报（>0）', r5.runningProcesses > 0, String(r5.runningProcesses))
t('已经在运行时也不谎报「连上了」', r5.connected === false, JSON.stringify({ c: r5.connected }))
t('讲清楚为什么接不进去（没带调试端口）', /remote-debugging-port|调试端口/.test(r5.why || ''), String(r5.why).slice(0, 140))
t('给出两个出路（重启接管 / 用网页版）', /force/.test(r5.hint || '') && /browser/.test(r5.hint || ''), String(r5.hint).slice(0, 200))
t('⚠️ 接管会丢未保存改动这件事写进提示里了', /存盘/.test(r5.hint || ''), String(r5.hint).slice(0, 200))

console.log('\n[6] 桌面版：找不到时给下载地址（隔离注册表探测，不碰真安装）')
// 让 reg 这个命令解析到一个假 exe：装到非默认目录的机器上，注册表是唯一的线索来源，
// 不隔离掉它这条分支在那些机器上永远测不到。假 reg.exe 用系统的 where.exe 冒充（带这些参数必然报错）。
let pathBackup = null
let fakeDir = null
if (process.platform === 'win32') {
  fakeDir = join(STUB_DIR, 'fakebin')
  mkdirSync(fakeDir, { recursive: true })
  copyFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe'), join(fakeDir, 'reg.exe'))
  pathBackup = process.env.PATH
  process.env.PATH = fakeDir + ';' + process.env.PATH
}
const reg3 = new Map()
mod2.apply({
  logger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  effect: () => {},
  tools: { register: (tool) => reg3.set(tool.name, tool) }
}, { safety: 'auto', bridgePort: PORT + 2, maxSnapshots: 1, desktopPath: join(STUB_DIR, 'not-installed.exe') })
const r6 = await reg3.get('scratch_open_editor').execute({ app: 'desktop', waitMs: 0 })
if (pathBackup !== null) process.env.PATH = pathBackup
if (r6.desktopNotFound) {
  t('返回 desktopNotFound + 试过的路径列表',
    Array.isArray(r6.triedPaths) && r6.triedPaths.length > 0, JSON.stringify(r6).slice(0, 240))
  t('提示里给了下载地址', /desktop\.turbowarp\.org/.test(r6.hint || ''), String(r6.hint).slice(0, 160))
  t('找不到时不假装启动成功', r6.launched && r6.launched.ok === false, JSON.stringify(r6.launched))
} else {
  // 非 Windows 或者系统里真的装了到默认位置 → 只保证"没乱开窗口"这一点
  t('（环境里真装了）没给路径也能定位到，且不谎报连上',
    !!r6.launched && r6.connected === false, JSON.stringify(r6.launched))
}

// ==================== 7. 已经有会话时不重复开 ====================
console.log('\n[7] 已经有会话时不重复开标签页')
const { default: WebSocket } = await import('ws')
const token = readFileSync(join(HOME, 'scratch-bridge-token.txt'), 'utf8').trim()
function connectFake () {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`)
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', token, meta: { title: '假编辑器' } }))
      ws.on('message', (raw) => {
        let m = null
        try { m = JSON.parse(String(raw)) } catch {}
        if (m && m.type === 'hello-ack') resolve(ws)
        if (m && m.id) ws.send(JSON.stringify({ id: m.id, ok: true, result: { pong: true } }))
      })
    })
    ws.on('error', reject)
  })
}
const before = launches().length
const sock = await connectFake()
await sleep(300)
r = await call('scratch_open_editor', { waitMs: 3000 })
await sleep(400)
t('已有会话时直接返回 alreadyConnected，不再开新标签页',
  r.alreadyConnected === true && r.sessions.length === 1, JSON.stringify(r).slice(0, 200))
t('确实没有再启动浏览器', launches().length === before, `before=${before} after=${launches().length}`)
r = await call('scratch_open_editor', { waitMs: 0, force: true })
await sleep(400)
t('force=true 时照样开', launches().length === before + 1, `before=${before} after=${launches().length}`)

// list_sessions 在**有**会话时不该再发 setup
const ls = await call('scratch_list_sessions', {})
t('有会话时 list_sessions 不再返回 token', ls.setup === undefined && ls.sessions.length === 1, JSON.stringify(ls).slice(0, 200))
sock.close()
await sleep(500)
const ls2 = await call('scratch_list_sessions', {})
t('会话断开后又回到「给配置包」状态', ls2.sessions.length === 0 && !!ls2.setup, JSON.stringify(ls2).slice(0, 160))

// ==================== 7. 端口被占：桥必须自己重试，不能永久躺平 ====================
// 真机上踩到过：装好插件那一刻 31820 被别的实例占着，插件只 bind 一次 → 桥再也没起来，
// 用户看到的现象是「扩展装了却怎么也连不上」，而且没有任何补救入口。
console.log('\n[7] 桥端口被占 → 占用释放后自愈')
const BUSY_PORT = PORT + 5
const blocker = net.createServer()
await new Promise((res, rej) => { blocker.once('error', rej); blocker.listen(BUSY_PORT, '127.0.0.1', res) })
const logs3 = []
const mod3 = await import('./index.js')
const reg3b = new Map()
mod3.apply({
  logger: () => ({ info: (...a) => logs3.push('info ' + a.join(' ')), warn: (...a) => logs3.push('warn ' + a.join(' ')),
    error: (...a) => logs3.push('error ' + a.join(' ')), debug: () => {} }),
  effect: () => {},
  tools: { register: (tool) => reg3b.set(tool.name, tool) }
}, { safety: 'auto', bridgePort: BUSY_PORT, maxSnapshots: 1, desktopPath: process.execPath })
await sleep(400)
t('端口被占时如实记一条 warn，而且不抛（插件照常可用）',
  logs3.some(l => /已被占用/.test(l)) && reg3b.size === TOOL_COUNT,
  JSON.stringify(logs3.slice(-3)) + ' tools=' + reg3b.size)
const { default: WsClient } = await import('ws')
const tryConnect = () => new Promise((resolve) => {
  const s = new WsClient(`ws://127.0.0.1:${BUSY_PORT}`)
  const fin = (v) => { clearTimeout(to); try { s.terminate() } catch {} ; resolve(v) } // terminate：别等对端回 close 帧（对面是裸 TCP，永远不会回）
  const to = setTimeout(() => fin('timeout'), 2000)
  s.on('open', () => fin('open'))
  s.on('error', () => fin('refused'))
})
t('占着的时候确实连不上（这条断言是前提，不然下面等于没测）',
  (await tryConnect()) !== 'open', 'unexpected open')
// ⚠️ 不能 await 'close'：裸 net.Server 上可能还挂着刚才那条没握完手的连接，
//    close() 会一直等它结束（踩过，测试卡死）。
blocker.close()
await sleep(300)
console.log('  占用已释放，等重试窗口（5s）…')
await sleep(6500)
const tok3 = readFileSync(join(HOME, 'scratch-bridge-token.txt'), 'utf8').trim()
const ack = await new Promise((resolve) => {
  const s = new WsClient(`ws://127.0.0.1:${BUSY_PORT}`)
  const to = setTimeout(() => { try { s.close() } catch {} ; resolve(null) }, 4000)
  s.on('open', () => s.send(JSON.stringify({ type: 'hello', token: tok3, meta: {} })))
  s.on('message', (d) => {
    const m = JSON.parse(String(d))
    if (m.type === 'hello-ack') { clearTimeout(to); s.close(); resolve(m) }
  })
  s.on('error', () => { clearTimeout(to); resolve(null) })
})
t('占用释放后桥自己回来了（重试生效，握手能过 —— 用户不用重启 dsh）',
  !!(ack && ack.type === 'hello-ack'), JSON.stringify(ack))

// ==================== 8. 返回值必须是「无损 JSON」 ====================
// 真 harness 会校验工具返回值，`undefined` / `NaN` 之类会让**整个工具调用失败**：
//   Error: tool "scratch_list_sessions" returned invalid output: value is not lossless JSON
// 装进真 dsh 后第一次调就撞上了（`tokenIsNew: x || undefined` 干的），而替身层直接
// execute() 不走那道校验，所以一直没暴露。现在所有返回值统一过 jsonSafe 清洗。
console.log('\n[8] 工具返回值是无损 JSON（真 harness 的校验）')
const badJson = (v, path = '$') => {
  if (v === null) return null
  const ty = typeof v
  if (ty === 'string' || ty === 'boolean') return null
  if (ty === 'number') return Number.isFinite(v) ? null : `${path} = 非有限数字 ${v}`
  if (ty === 'undefined') return `${path} = undefined`
  if (ty === 'function' || ty === 'symbol' || ty === 'bigint') return `${path} = ${ty}`
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) { const r = badJson(v[i], `${path}[${i}]`); if (r) return r }
    return null
  }
  if (ty === 'object') {
    for (const [k, val] of Object.entries(v)) { const r = badJson(val, `${path}.${k}`); if (r) return r }
    return null
  }
  return `${path} = 未知类型 ${ty}`
}
const losslessIssues = []
// 覆盖：无会话（配置包那条路，就是它炸的）、有会话、以及几个会拼字符串的只读工具
const probes = [['scratch_list_sessions', {}], ['scratch_skills', { action: 'list' }]]
const skList = await registered.get('scratch_skills').execute({ action: 'list' })
for (const [n, args] of probes) {
  const tool = registered.get(n)
  if (!tool) continue
  let out
  try { out = await tool.execute(args) } catch (e) { out = { __err: String(e.message) } }
  const issue = badJson(out)
  if (issue) losslessIssues.push(`${n}: ${issue}`)
}
if (registered.get('scratch_skills')) {
  const sk = await registered.get('scratch_skills').execute({ action: 'list' })
  const issue = badJson(sk)
  if (issue) losslessIssues.push(`scratch_skills: ${issue}`)
}
const lsNoSess = await call('scratch_list_sessions', {})
const issueLs = badJson(lsNoSess)
if (issueLs) losslessIssues.push(`list_sessions(无会话): ${issueLs}`)
t('代表性工具返回值里没有 undefined/NaN/函数（否则真 dsh 会直接判整个工具失败）',
  losslessIssues.length === 0, losslessIssues.join(' ; '))
// `tokenIsNew: bridgeTokenIsNew || undefined` 这种写法在「不是新 token」时会留一个
// undefined，正是它让真 dsh 报 "not lossless JSON"。清洗后：要么键在且为 true，要么键根本不存在。
t('缺省的可选字段不会以 undefined 形式残留（要么 true，要么整个键没有）',
  !Object.prototype.hasOwnProperty.call(lsNoSess.setup || {}, 'tokenIsNew') || lsNoSess.setup.tokenIsNew === true,
  JSON.stringify(Object.keys(lsNoSess.setup || {})))
t('JSON.stringify 往返无损（stringify → parse → stringify 完全一致）',
  JSON.stringify(JSON.parse(JSON.stringify(lsNoSess))) === JSON.stringify(lsNoSess))
// 这套实例是 skillsEnabled:false 起的 → 必须如实说"关了"，而不是偷偷给内容
t('skillsEnabled=false 时如实回 skillsDisabled（不装作有）',
  skList.skillsDisabled === true, JSON.stringify(skList).slice(0, 160))
// 换个实例（没显式给 skillsEnabled = 默认开）验另一条路：undefined 不等于 false
const skOn = await reg2.get('scratch_skills').execute({ action: 'list' })
t('没配 skillsEnabled 时默认是**开**（undefined 不该被当成 false）',
  Array.isArray(skOn.skills) && skOn.skills.length >= 8, JSON.stringify(skOn).slice(0, 200))
t('skill 列表内容也是无损 JSON', badJson(skOn) === null, String(badJson(skOn)))

// ==================== 9. CDP 直连的执行器副本不能漂移 ====================
// CDP 那条路（TurboWarp Desktop）注进页面的就是 vm-executor.js，它是扩展的
// content-main.js 的同步副本。两份一旦不一致，扩展和桌面版的行为就会分叉 ——
// 而且这种漂移在真机上极难发现（两边都"能跑"，只是行为不同）。
console.log('\n[9] vm-executor.js 与扩展的 content-main.js 逐字节一致')
const extDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tw-bridge-extension')
const srcPath = join(extDir, 'content-main.js')
const dstPath = join(dirname(fileURLToPath(import.meta.url)), 'vm-executor.js')
const cdpSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'cdp.js'), 'utf8')
const srcBuf = readFileSync(srcPath)
const dstBuf = readFileSync(dstPath)
t('两份执行器逐字节一致（改完记得 node lab/sync-executor.mjs）',
  srcBuf.equals(dstBuf), `${srcBuf.length}B vs ${dstBuf.length}B`)
t('执行器里没有任何 chrome.* 依赖（否则 CDP 注入进桌面版会直接炸）',
  // 只看代码，不看清注释（注释里提到 chrome.runtime 是在讲协议，不是依赖）
  !/chrome\s*\.\s*(runtime|storage|tabs|scripting|alarms)/
    .test(dstBuf.toString('utf8').split(/\r?\n/).map(l => l.replace(/\/\/.*$/, '')).join('\n')))
t('执行器认的是 postMessage 那条协议（垫片就是照它写的）',
  dstBuf.toString('utf8').includes('__dshBridgeRelay'))
t('cdp.js 的垫片用 __dshCdpDeliver/__dshCdpSend 这两个名字',
  cdpSrc.includes('__dshCdpDeliver') && cdpSrc.includes('__dshCdpSend'))
t('垫片合成的事件带 source: window（执行器的监听会按这个过滤）', cdpSrc.includes('source: window'))
// tagForPage：CDP 路径必须自己给 op 消息贴标签（扩展路径里这层是 relay/SW 干的）。
// 少了它：ping/pong 正常、页面自报 authed=true，但**每个 op 都超时**（真机踩过）。
const { tagForPage } = await import('./cdp.js')
const tagged = JSON.parse(tagForPage(JSON.stringify({ id: 'r7', op: 'snapshot', args: { target: 'a' } })))
t('tagForPage 给 op 消息贴上 __dshBridgeRelay=op', tagged.__dshBridgeRelay === 'op', JSON.stringify(tagged).slice(0, 120))
t('贴标签时不动 id/op/args（路由靠它）',
  tagged.id === 'r7' && tagged.op === 'snapshot' && tagged.args.target === 'a', JSON.stringify(tagged))
t('已经带标签的消息不会被贴第二层', JSON.parse(tagForPage(JSON.stringify({ __dshBridgeRelay: 'ping' }))).__dshBridgeRelay === 'ping')
t('{type:"pong"} 这类控制消息原样透传（页面本来就会忽略未知标签）',
  tagForPage('{"type":"pong"}') === '{"type":"pong"}')

// ==================== 10. 「能被 DSH 插件页管起来」的打包契约 ====================
// 这一节守的是**安装形态**，不是运行时行为：插件页只列组合包、只给有 volatile 字段的
// 插件渲染配置表单、只给注册了 plugins.row.config 的行显示「配置」按钮。
// 三条里任何一条退化，用户那边就是「插件页里没有它 / 开关用不了 / 设置参数用不了」，
// 而运行时测试全绿也发现不了（上一版正是如此，真机才暴露）。
console.log('\n[10] 打包契约：组合包 / 配置表单 / 浏览器半侧')
const PKG_DIR = dirname(fileURLToPath(import.meta.url))
const pkgJson = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'))
t('声明了 dsh.bundle.patch（否则它不是组合包，插件页里根本不列）',
  !!(pkgJson.dsh && pkgJson.dsh.bundle && pkgJson.dsh.bundle.patch), JSON.stringify(pkgJson.dsh))
t('声明了 dsh.client.platform=web（否则插件页没有配置控件）',
  !!(pkgJson.dsh && pkgJson.dsh.client && pkgJson.dsh.client.platform === 'web'), JSON.stringify(pkgJson.dsh))
t('exports 里导出了 ./client（宿主按这个路径取浏览器半侧）',
  !!(pkgJson.exports && pkgJson.exports['./client'] === './lib/client.js'), JSON.stringify(pkgJson.exports))
t('依赖里不再出现 @deepseek-ai/*（宿主提供；写进 deps 会遮蔽运行时版本，把 tools 行搞挂）',
  Object.keys(pkgJson.dependencies || {}).every(k => !k.startsWith('@deepseek-ai/')), JSON.stringify(pkgJson.dependencies))
t('engines.dsh 声明了（版本不合时宿主会跳过组合包，提前写清楚省得猜）',
  !!(pkgJson.engines && pkgJson.engines.dsh), JSON.stringify(pkgJson.engines))

const Config = mod.Config
t('导出了 Config（dsh 的 settings 服务靠它生成配置表单）', !!Config, typeof Config)
const configDict = (Config && (Config.dict || (Config.meta && Config.meta.dict))) || {}
const configKeys = Object.keys(configDict)
t('Config 有 10 个字段（字段名与 profile YAML / 代码读取处一致）', configKeys.length === 10, configKeys.join(','))
const volatileKeys = configKeys.filter(k => configDict[k] && configDict[k].meta && configDict[k].meta.volatile).sort()
t('配置页只暴露三项（写操作档位 / 桌面版路径 / 快照目录），工程参数不进表单',
  volatileKeys.join(',') === 'desktopPath,safety,snapshotsDir', volatileKeys.join(','))

const clientSrc = readFileSync(join(PKG_DIR, 'lib', 'client.js'), 'utf8')
t('浏览器半侧的表单与 volatile 字段一一对应（多了 = 页面上出现改了不生效的控件）',
  volatileKeys.every(k => clientSrc.includes("key: '" + k + "'"))
  && !/key: '(bridgePort|desktopDebugPort|browserPath|maxSnapshots|maxSnapshotMemMb|maxSnapshotDiskMb|skillsEnabled)'/.test(clientSrc),
  volatileKeys.join(','))
t('浏览器半侧是 __ModuleLoader__ 的惰性 bundle（宿主只认这种格式）',
  clientSrc.includes('window.__ModuleLoader__.load(') && clientSrc.includes('factory:'))
t('浏览器半侧的模块 id 就是包名（写错 = 挂不上 Loader 行）',
  clientSrc.includes(`id: '${pkgJson.name}'`), pkgJson.name)
t('注册的是 plugins.row.config 这个 keyed slot', clientSrc.includes("'plugins.row.config'"))
t('slot key 带 <包名>#<行 id> 结构（插件页按这个 key 找配置页）',
  clientSrc.includes('#${ROW_ID}') || clientSrc.includes('#scratch'), '')
t('浏览器半侧导出了 apply（cordis 插件形态）',
  clientSrc.includes('exports.apply = apply') && clientSrc.includes('exports.inject'))
t('浏览器半侧只 require 外壳共享模块表里的东西（react / 官方 client 包）',
  (clientSrc.match(/require\(['"]([^'"]+)['"]\)/g) || []).every(m => /require\(['"](react|react\/jsx-runtime|@deepseek-ai\/dsh-client-[^'"]+)['"]\)/.test(m)),
  (clientSrc.match(/require\(['"]([^'"]+)['"]\)/g) || []).join(','))

t('带了 Win32 窗口探针（隐藏窗口只能靠 EnumWindows 查出来）',
  existsSync(join(PKG_DIR, 'win32-window.ps1')))
const psBuf = existsSync(join(PKG_DIR, 'win32-window.ps1')) ? readFileSync(join(PKG_DIR, 'win32-window.ps1')) : Buffer.alloc(0)
const psProbe = psBuf.toString('utf8')
t('探针用的是 EnumWindows + IsWindowVisible（MainWindowHandle 对隐藏窗口恒为 0，会误判）',
  psProbe.includes('EnumWindows') && psProbe.includes('IsWindowVisible'))
t('探针能修：ShowWindow 用 SW_RESTORE/SW_SHOW', psProbe.includes('ShowWindow'))
t('探针文件带 UTF-8 BOM（Windows PowerShell 5.1 不带 BOM 会把中文读成乱码 → 语法错）',
  psBuf.slice(0, 3).toString('hex') === 'efbbbf', psBuf.slice(0, 3).toString('hex'))

const indexSrc = readFileSync(join(PKG_DIR, 'index.js'), 'utf8')
t('GUI 启动不再硬编码 windowsHide: true（带了窗口会以隐藏态创建，用户什么都看不到）',
  !/spawn\([^;\n]*windowsHide:\s*true/.test(indexSrc), '')
t('spawnDetached 的控制台隐藏是「按需」的（hide 参数 + windowsHide: hide）',
  /function spawnDetached\(cmd, args, \{ hide = false \}/.test(indexSrc) && indexSrc.includes('windowsHide: hide'))
t('桌面版连上后报窗口可见性（window 字段）', indexSrc.includes('out.window = before'))
t('隐藏态会自动 ShowWindow 救回来（windowRepair / windowHidden）',
  indexSrc.includes('out.windowRepair') && indexSrc.includes('out.windowHidden'))
t('会话失效的错误提示同时给两条路（桌面版 / 网页版）',
  /scratch_open_editor\(\{ app: "desktop" \}\)/.test(indexSrc) && indexSrc.includes('tw-bridge-extension'))

// ==================== 11. v0.7.0：运行控制 / 可观测 / 批处理 ====================
// 这一节守的是「问题记录里那四个 P0/P1/P2 没有被悄悄退回去」：
//   窗口可见性(P0-1) / 跨角色定位(P1-1) / 回传爆炸(P2-2、P1-5) / 运行控制缺失(P0-2)
// 断言尽量落在「行为契约」上（工具参数真的往下传了、回传结构里真有那个字段），
// 而不是只数一数工具有没有注册。
console.log('\n[11] 运行控制 / 可观测 / 批处理（问题记录 P0-2、P1-1、P1-5、P1-6、P2-2）')
const NEW_TOOLS = ['scratch_run', 'scratch_state', 'scratch_click', 'scratch_press_key',
  'scratch_screenshot', 'scratch_profile', 'scratch_list_scripts', 'scratch_batch', 'scratch_selftest']
const missingTools = NEW_TOOLS.filter(n => !registered.has(n))
t('9 个新工具都在（运行控制/状态/点击/按键/截图/性能/脚本清单/批处理/自检）',
  missingTools.length === 0, '缺: ' + missingTools.join(','))

const paramNames = (name) => Object.keys(((registered.get(name) || {}).parameters || {}).properties || {})
t('scratch_locate 带 target 参数（跨角色定位的入口）',
  paramNames('scratch_locate').includes('target'), paramNames('scratch_locate').join(','))
t('scratch_read_script 带 summary/scriptId/opcodes/offset（瘦身与分页的入口）',
  ['summary', 'scriptId', 'opcodes', 'offset'].every(k => paramNames('scratch_read_script').includes(k)),
  paramNames('scratch_read_script').join(','))
t('scratch_watch 带 includeLists（长列表默认不跟）',
  paramNames('scratch_watch').includes('includeLists'), paramNames('scratch_watch').join(','))
t('scratch_open_editor 带 port（接管手动开的实例）与 show（窗口选项）',
  paramNames('scratch_open_editor').includes('port') && paramNames('scratch_open_editor').includes('show'),
  paramNames('scratch_open_editor').join(','))
t('scratch_run 的 action 说明里列出了 greenflag/stopall',
  /greenflag/.test(registered.get('scratch_run').description) && /stopall/.test(registered.get('scratch_run').description))

// 批处理白名单：写操作绝对不能进去（那会绕过 preview/apply 的确认）
const batchDesc = registered.get('scratch_batch').description
t('scratch_batch 的白名单里没有写操作（add_blocks/update/delete/restore 都不许）',
  !/add_blocks/.test(indexSrc.match(/BATCH_OPS = new Set\(\[[\s\S]*?\]\)/)[0]),
  indexSrc.match(/BATCH_OPS = new Set\(\[[\s\S]*?\]\)/)[0].replace(/\s+/g, ' '))
t('scratch_batch 描述里把白名单原文告诉 AI（省得它瞎试）',
  /read_script/.test(batchDesc) && /state/.test(batchDesc))
t('批处理有单次条数上限（不让人一条消息塞爆）', indexSrc.includes('一次最多 12 条'))

// 截图只能走 CDP：扩展那条路页面里没有浏览器层权限
t('截图走 Page.captureScreenshot，且对扩展会话明确拒绝',
  indexSrc.includes('Page.captureScreenshot') && indexSrc.includes('截图只能走桌面版 CDP 会话'))
t('selftest 真的检查桥在不在监听（不是只看有没有会话）',
  indexSrc.includes("add('bridge 监听'") && indexSrc.includes('bridgeListening'))
t('写操作的「哪变了」统一成 changed（P3-2），且老字段保留',
  (indexSrc.match(/return withChanged\(await guardedWrite\(/g) || []).length >= 5 && indexSrc.includes('changed.added'),
  String((indexSrc.match(/return withChanged\(await guardedWrite\(/g) || []).length))

// 执行器侧：新 op 都在，而且都在**同步后的** vm-executor.js 里（CDP 那条路读的是它）
const executorSrc = readFileSync(join(PKG_DIR, 'vm-executor.js'), 'utf8')
const missingOps = ['run', 'state', 'click', 'press_key', 'profile', 'list_scripts']
  .filter(op => !new RegExp(`case '${op}'`).test(executorSrc))
t('执行器里 6 个新 op 都在（run/state/click/press_key/profile/list_scripts）',
  missingOps.length === 0, '缺: ' + missingOps.join(','))
t('read_script 默认不回变量（7.5MB 那个坑的根因就是它连带回列表）',
  executorSrc.includes('variablesOmitted') && executorSrc.includes('includeVariables === true'))
t('watch 默认不跟列表，且回传前先裁长度（14.8MB 那个坑）',
  executorSrc.includes('includeLists: false') && executorSrc.includes('maxQueue'))
t('state/profile 用 runtime.currentStepTime 反推 fps（比项目里的 fps 变量可信）',
  executorSrc.includes('currentStepTime'))
t('click 用的是 mouse.postData 的像素坐标换算（x = scratchX+240，y = 180-scratchY）',
  executorSrc.includes('canvasWidth: 480') && executorSrc.includes('scratchX'))
t('locate 会跨角色搜索并在错误里列出找过谁',
  executorSrc.includes('个角色/舞台里都没有'))
t('窗口探针额外报 active + screen 工作区（判断"被别的窗口盖住/跑到屏幕外"）',
  psProbe.includes('"active"') && psProbe.includes('"screen"') && psProbe.includes('GetForegroundWindow'))
// v0.8.0：profile 带归因（量出"慢"之后要能说出"哪条脚本慢"）
t('scratch_profile 带 attribution/topN 参数（归因开关与榜单长度）',
  ['attribution', 'topN'].every(k => paramNames('scratch_profile').includes(k)),
  paramNames('scratch_profile').join(','))
t('执行器里 profile 真的采样线程栈（peekStack → 顺着 parent 链归到脚本根）',
  executorSrc.includes('peekStack') && executorSrc.includes('rootOf(target, blockId, blocks)'))
t('归因把「等 N 秒」这类空转单列（waitPct），不混进热点排行',
  executorSrc.includes('control_wait_until') && executorSrc.includes('waitPct'))
t('归因有采样上限（几千个克隆体时别让采样本身变成瓶颈）',
  executorSrc.includes('threads.length > 400'))
t('执行器源码按 mtime 重读（改完 sync-executor 不用重启 dsh，重开编辑器就生效）',
  /function executorSourceNow\(\)/.test(indexSrc) && /executorSource: executorSourceNow\(\)/.test(indexSrc) &&
  !/let executorSource\s*=\s*''/.test(indexSrc))
t('编译器开着时的降级契约写在执行器里（compiled/granularity=script，不给 hot 冒充块级）',
  executorSrc.includes("granularity: 'script'") && executorSrc.includes("granularity: 'block'") &&
  executorSrc.includes('compilerOptions'))

// ==================== 12. v0.8.0：背包 ====================
// 背包的存在意义是「AI 自己攒可复用的整块积木」（用户提的需求）。这里守的是**契约**：
//   · 存 = 从项目导出（走执行器 export_blocks，不是让 AI 手动抄 JSON）
//   · 取 = 注入 + 变量/列表按名字接上或补建（否则搬过去全是「变量未找到」）
//   · 存/删不动项目 → 不该被 preview 拦；注入动项目 → 必须受 safety 管
console.log('\n[12] 背包（存/取可复用积木）')
t('两个背包工具都注册了（scratch_backpack / scratch_backpack_load）',
  registered.has('scratch_backpack') && registered.has('scratch_backpack_load'), [...registered.keys()].join(','))
t('scratch_backpack 的 action 说明列出 list/read/save/delete（AI 一眼能用）',
  ['list', 'read', 'save', 'delete'].every(a => registered.get('scratch_backpack').description.includes(a)))
t('save 的入参带 scriptIds/blockIds/all（三种存法）',
  ['scriptIds', 'blockIds', 'all'].every(k => paramNames('scratch_backpack').includes(k)),
  paramNames('scratch_backpack').join(','))
t('load 的入参带 x/y 与 variableValues（换位置、换字模表）',
  ['x', 'y', 'variableValues'].every(k => paramNames('scratch_backpack_load').includes(k)),
  paramNames('scratch_backpack_load').join(','))
t('load 明确受 safety 档位管（preview 档返回 planId，不是绕过确认直写项目）',
  /guardedWrite\(sid, 'add_blocks'/.test(indexSrc) && /preview 档会返回 planId/.test(registered.get('scratch_backpack_load').description))
t('存之前问用户（不做自动收集 —— 自动攒会变垃圾堆）',
  /问用户/.test(registered.get('scratch_backpack').description), registered.get('scratch_backpack').description.slice(0, 120))
t('删除只是挪进 _trash（几小时的活不该被手滑删掉）',
  indexSrc.includes('backpackTrashDir') && indexSrc.includes('renameSync(f, dst)'))
t('背包目录在 $DSH_HOME 下（照 skill 区的做法，不散落在项目里）',
  indexSrc.includes("'scratch-backpack'") && indexSrc.includes('BACKPACK_INDEX'))
t('执行器里有 export_blocks（子树导出走官方序列化器，不自己转 sb3）',
  executorSrc.includes("case 'export_blocks'") && executorSrc.includes('vm.toJSON()'))
t('注入时会落地变量引用（resolveRefs：有效不动 / 同名改指向 / 缺的补建）',
  executorSrc.includes('function resolveRefs') &&
  executorSrc.includes('byName(kind, name)') && executorSrc.includes('create(kind, name)'),
  String(['resolveRefs', 'byName', 'create'].filter(k => !executorSrc.includes(k)).join(',')))
t('背包片段导出时列表封顶（不然 5000 项的巨型列表又被搬一遍）',
  executorSrc.includes('listCap') && executorSrc.includes('truncated'))

// ==================== 13. M3：精细编辑（断链/接链、变量/列表、造型）====================
// 这一类操作最容易「看着成功、项目其实坏了」：指针不收拾 = 重复挂载/孤儿块，
// 变量改名不同步 = 「变量未找到」。所以契约必须写死在描述和执行器里。
console.log('\n[13] 精细编辑（move_block / variable / costume）')
t('三个工具都注册了（scratch_move_block / scratch_variable / scratch_costume）',
  ['scratch_move_block', 'scratch_variable', 'scratch_costume'].every(n => registered.has(n)),
  [...registered.keys()].filter(k => /move_block|variable|costume/.test(k)).join(','))
t('move_block 把四种模式写在描述里（detach / after / before / input）',
  ['detach', 'after', 'before', 'input'].every(m => registered.get('scratch_move_block').description.includes(m)),
  registered.get('scratch_move_block').description.slice(0, 160))
t('move_block 明说跨角色要用背包（不让人以为它能跨角色搬）',
  /背包/.test(registered.get('scratch_move_block').description) &&
  /同一个角色/.test(registered.get('scratch_move_block').description))
t('三个工具都受 safety 档位管（preview 档只出 plan，不直写）',
  ['move_block', 'variable', 'costume'].every(op =>
    new RegExp(`guardedWrite\\(sid, '${op}'`).test(indexSrc)))
t('variable 把四个动作写在描述里（set / create / delete / rename），并说明 delete 有引用时的 force',
  ['set', 'create', 'delete', 'rename'].every(a => registered.get('scratch_variable').description.includes(a)) &&
  /force/.test(registered.get('scratch_variable').description))
t('variable 的 value 用 type:"json"（列表要能传数组，用 string 就会被拒）',
  /value: \{ type: 'json'/.test(indexSrc), paramNames('scratch_variable').join(','))
t('costume 三个动作（rename / delete / set）都说明白了，且写清「只剩一个造型会拒绝」',
  ['rename', 'delete', 'set'].every(a => registered.get('scratch_costume').description.includes(a)) &&
  /只剩一个造型/.test(registered.get('scratch_costume').description),
  registered.get('scratch_costume').description.slice(0, 140))
t('执行器里三个 op 都在，且改完都让 GUI 重建工作区（safeEmitWorkspaceUpdate）',
  ["case 'move_block'", "case 'variable'", "case 'costume'"].every(k => executorSrc.includes(k)) &&
  (executorSrc.match(/safeEmitWorkspaceUpdate\(vm\)/g) || []).length >= 6,
  String((executorSrc.match(/safeEmitWorkspaceUpdate\(vm\)/g) || []).length))
t('断链/接链自己收拾指针（unlinkBlock 补断口 + attachAfter 插中间，不借官方 moveBlock）',
  executorSrc.includes('function unlinkBlock') && executorSrc.includes('function attachAfter') &&
  executorSrc.includes('function attachInput'))
t('接到自己的子孙上会被拒绝（成环会把工作区搞崩）',
  /成环/.test(executorSrc) && executorSrc.includes('subtreeIds'))
t('变量改名会把引用它的积木字段一起改（updateBlocksAfterVarRename）',
  executorSrc.includes('updateBlocksAfterVarRename'))
t('删变量前数一遍引用块；force 时先补断口再删（不留悬空指针）',
  executorSrc.includes('function variableRefs') &&
  /还被 \$\{refs\.length\} 个积木引用/.test(executorSrc) &&
  /unlinkBlock\(bt\.blocks, r\.blockId\)/.test(executorSrc))

// ==================== v0.10.0：实地反馈清单的回归位 ====================
console.log('\n[v0.10.0] 实地反馈清单：新工具 + 静默错误的护栏')
const V010_TOOLS = ['scratch_project_overview', 'scratch_inspect', 'scratch_new_project', 'scratch_target', 'scratch_restart_window']
t('v0.10.0 的 5 个新工具都注册了', V010_TOOLS.every(n => registered.has(n)), V010_TOOLS.filter(n => !registered.has(n)).join(','))
for (const n of V010_TOOLS) {
  const msg = await thrown(() => call(n, { blockId: 'x', action: 'list', to: 'y' }))
  t(`${n} 没有会话时明确报错（不是崩溃，也不是假装成功）`, !!msg && /没有已连接的 TurboWarp 编辑器/.test(msg), String(msg))
}

// G1：空白作品生成器（id/md5/zip 都在插件侧现造，AI 不用手搓 sb3）
const { buildBlankProject } = await import('./sb3.js')
const blank = buildBlankProject({ spriteName: '细胞' })
t('空白作品是个合法的 zip（PK\\x03\\x04）', blank.buffer[0] === 0x50 && blank.buffer[1] === 0x4b, String(blank.buffer[0]))
t('空白作品含 project.json + 2 个 svg', blank.files.length === 3 && blank.files[0] === 'project.json', JSON.stringify(blank.files))
t('资源文件名 = 内容 md5（存盘后重开也能找到）', blank.files.slice(1).every(f => /^[0-9a-f]{32}\.svg$/.test(f)), JSON.stringify(blank.files))

// A2：大返回的最后一道闸（超预算就换成显式信封 + 全文落盘，绝不闷声丢）
t('defineTool 统一过 clipToolResult（A2：大返回不再被工具层静默截断）',
  indexSrc.includes('clipToolResult(jsonSafe(await def.execute(...args))') && indexSrc.includes('function clipToolResult'))
t('截断信封里带 spillPath + preview + 怎么翻页的建议',
  indexSrc.includes('spillPath: spillPath || undefined') && indexSrc.includes('preview: text.slice(0, 4000)'))

// B1/A1：open_editor 先返回、装载在后台，并且明确标注"冷启动的默认空工程"
t('open_editor 把装载丢到后台（loading:true），不再同步阻塞',
  indexSrc.includes('sess.loading = loading') && indexSrc.includes('out.loading = true'))
t('返回值里明确标注 beforeLoad 是默认空工程（B1 的误判来源）',
  indexSrc.includes('桌面版冷启动的默认空工程'))
t('call() 有装载闸：后续 op 自动等装完（不带 noGate 时）',
  indexSrc.includes('await s0.loading') && indexSrc.includes('noGate'))

// G9：帧心跳 + 重启窗口
t('selftest 加了一帧心跳（连截两张比哈希）', indexSrc.includes('frameHashOnce') && indexSrc.includes("add('帧心跳'"))
t('截图返回 frameHash + sameAsPrev + frozenHint',
  indexSrc.includes('frameHash') && indexSrc.includes('sameAsPrev') && indexSrc.includes('frozenHint'))
t('提供了 scratch_restart_window（假活时的恢复动作）',
  indexSrc.includes('scratch_restart_window') && indexSrc.includes('taskkill'))

// F5：save 的 overwrote 语义
t('save_project 的 overwrote 只在"目标原本存在且真被覆盖"时为 true',
  indexSrc.includes('overwrote: existed && !renamed') && indexSrc.includes('created: !existed'))

// D3：截图裁剪
t('截图支持 region: stage / workspace（D3）', indexSrc.includes('shotRegionRect') && indexSrc.includes("'workspace'"))

// G6：批处理放开 variable 轻写
t('batch 允许 variable 的 create/set（G6），但明确拒绝其它写动作',
  indexSrc.includes('BATCH_LIGHT_WRITES') && indexSrc.includes("new Set(['create', 'set'])"))

// 执行器侧的 v0.10.0 关键实现（确保同步后的 vm-executor.js 里真的有）
const v010 = [
  ['输入名白名单校验', 'function validatePayload'],
  ['只增不删账本', 'function staleInjected'],
  ['显式清理（子树全是自己注入的）', 'function discardStale'],
  ['自动布局（估算高度）', 'function estStackHeightSb3'],
  ['写后跟随视口', 'async function followBlock'],
  ['单块上下文', "case 'inspect'"],
  ['结构总览', "case 'project_overview'"],
  ['角色改名', "case 'rename_target'"],
  ['输入槽补建', 'function ensureInputSlot'],
  ['列表切片/增量', "stateLastLengths"]
]
for (const [label, needle] of v010) {
  t(`执行器：${label}`, executorSrc.includes(needle), needle)
}

// v0.11.0：两处"带自定义块的片段根本注不进去"的根修
const v011 = [
  // procedures_call/prototype 的输入键名就是 argumentids 里那些随机串，形状表里永远查不到。
  // 早先只放过了 procedures_call，于是**任何带自定义块定义的片段**都会被当成"输入名写错"拒掉
  // （背包里那个 142 块的字库引擎就是这么被拦下的）。
  ['自定义块的参数 id 不算"输入名写错"（call + prototype 都放过）', "ARG_ID_OPCODES.has(opcode)"],
  ['ARG_ID_OPCODES 同时含 call 和 prototype', "'procedures_call', 'procedures_prototype'"],
  ['背包变量/列表可声明 scope:global 挂舞台', 'const declaredScope = (kind, name) =>'],
  ['导出时记下变量在谁身上（舞台 = global）', "item.scope = found && found.owner && found.owner.isStage"]
]
for (const [label, needle] of v011) {
  t(`执行器：${label}`, executorSrc.includes(needle), needle)
}

console.log(`\n===== 插件工具单测: ${pass} pass / ${fail} fail =====`)
try { rmSync(STUB_DIR, { recursive: true, force: true }); rmSync(HOME, { recursive: true, force: true }) } catch {}
process.exit(fail ? 1 : 0)
