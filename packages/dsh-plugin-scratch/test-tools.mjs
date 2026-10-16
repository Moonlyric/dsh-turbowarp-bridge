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
t('注册了 19 个工具', registered.size === 19, '实际 ' + registered.size)

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
  logs3.some(l => /已被占用/.test(l)) && reg3b.size === 19,
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

console.log(`\n===== 插件工具单测: ${pass} pass / ${fail} fail =====`)
try { rmSync(STUB_DIR, { recursive: true, force: true }); rmSync(HOME, { recursive: true, force: true }) } catch {}
process.exit(fail ? 1 : 0)
