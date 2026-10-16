// test-bridge-auth.mjs — 桥的握手认证与应答来源校验
//
// 覆盖的是**安全控制**本身，别删：
//   1. 不带 token / 带错 token 的连接必须被拒（WebSocket 不受同源策略约束，
//      用户访问的任意网页都能连 ws://127.0.0.1:31820）
//   2. 没先发 hello 就发指令的连接必须被拒
//   3. 带对 token 的连接必须被接受并收到 hello-ack
//   4. 一个会话不能替另一个会话应答（串答 = 伪造工具返回值）
//
// 用法：node test-bridge-auth.mjs
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dsh-bridge-auth-'))
process.env.DSH_HOME = HOME

const PORT = 31998
let pass = 0, fail = 0
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' | ' + detail : '')) }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const registered = new Map()
const logged = []
const effects = []
const fakeCtx = {
  logger: () => ({
    info: (...a) => logged.push(['info', a.map(String).join(' ')]),
    warn: (...a) => logged.push(['warn', a.map(String).join(' ')]),
    error: (...a) => logged.push(['error', a.map(String).join(' ')]),
    debug: () => {}
  }),
  effect: (fn) => { const d = fn(); if (typeof d === 'function') effects.push(d) },
  tools: { register: (tool) => registered.set(tool.name, tool) }
}

const mod = await import('./index.js')
mod.apply(fakeCtx, { safety: 'auto', bridgePort: PORT, maxSnapshots: 2, skillsEnabled: false })
t('插件 apply 未抛错', true)

const { default: WebSocket } = await import('ws')

/** 连上去；resolve 成 { ws, frames, closeInfo } */
function dial() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`)
    const frames = []
    let closeInfo = null
    const timer = setTimeout(() => reject(new Error('connect timeout')), 5000)
    ws.on('open', () => {
      clearTimeout(timer)
      resolve({ ws, frames, get closeInfo () { return closeInfo } })
    })
    ws.on('message', (raw) => { try { frames.push(JSON.parse(String(raw))) } catch {} })
    ws.on('close', (code, reason) => { closeInfo = { code, reason: String(reason) } })
    ws.on('error', (e) => { clearTimeout(timer); reject(e) })
  })
}

// 服务端是异步 start()，等它真的在监听
let ready = false
for (let i = 0; i < 40 && !ready; i++) {
  try { const c = await dial(); c.ws.close(); ready = true } catch { await sleep(100) }
}
t('桥已监听', ready, `port ${PORT}`)

// token 落盘了没
const tokenFile = join(HOME, 'scratch-bridge-token.txt')
t('token 落盘到 $DSH_HOME/scratch-bridge-token.txt', existsSync(tokenFile))
const TOKEN = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : ''
t('token 是 32 位十六进制', /^[0-9a-f]{32}$/.test(TOKEN), `"${TOKEN}"`)
t('日志里打出了 token（用户能照着填进扩展）',
  logged.some(([lvl, msg]) => lvl === 'info' && msg.includes(TOKEN)),
  JSON.stringify(logged.filter(([l]) => l === 'info').map(([, m]) => m.slice(0, 60))))

// ---- 1. 不带 token ----
console.log('[auth] 不带 token')
{
  const c = await dial()
  c.ws.send(JSON.stringify({ type: 'hello', meta: { url: 'https://evil.example/' } }))
  await sleep(300)
  t('无 token 的连接被关闭', !!c.closeInfo, JSON.stringify(c.closeInfo))
  t('关闭码是 4003（bad token）', c.closeInfo && c.closeInfo.code === 4003, JSON.stringify(c.closeInfo))
  t('没有收到 hello-ack', !c.frames.some(f => f.type === 'hello-ack'))
}

// ---- 2. 错 token ----
console.log('[auth] 错 token')
{
  const c = await dial()
  c.ws.send(JSON.stringify({ type: 'hello', token: 'deadbeef'.repeat(4), meta: {} }))
  await sleep(300)
  t('错 token 的连接被关闭', c.closeInfo && c.closeInfo.code === 4003, JSON.stringify(c.closeInfo))
}

// ---- 3. 不握手就发指令 ----
console.log('[auth] 跳过握手直接发指令')
{
  const c = await dial()
  c.ws.send(JSON.stringify({ id: 'r1', op: 'snapshot', args: {} }))
  await sleep(300)
  t('未握手就发指令的连接被关闭', c.closeInfo && c.closeInfo.code === 4003, JSON.stringify(c.closeInfo))
}

// ---- 4. 正确 token ----
console.log('[auth] 正确 token')
let A = null, B = null
{
  A = await dial()
  A.ws.send(JSON.stringify({ type: 'hello', token: TOKEN, meta: { url: 'https://turbowarp.org/editor', projectTitle: 'p' } }))
  await sleep(300)
  t('正确 token 收到 hello-ack', A.frames.some(f => f.type === 'hello-ack'), JSON.stringify(A.frames))
  t('正确 token 的连接没被关', !A.closeInfo, JSON.stringify(A.closeInfo))
  B = await dial()
  B.ws.send(JSON.stringify({ type: 'hello', token: TOKEN, meta: { url: 'https://turbowarp.org/editor', projectTitle: 'p2' } }))
  await sleep(200)
  t('第二个连接也握手成功（多标签页）', B.frames.some(f => f.type === 'hello-ack'))
}

// ---- 5. 会话列表能看到两个 ----
console.log('[auth] 会话可见性')
{
  const r = await registered.get('scratch_list_sessions').execute({})
  t('list_sessions 报出 2 个会话', r.sessions.length === 2, JSON.stringify(r.sessions.map(s => s.sessionId)))
}

// ---- 6. 跨会话串答必须被忽略 ----
console.log('[auth] 跨会话伪造应答')
{
  // scratch_snapshot 走桥，会发往「第一个会话」（A）
  const snapPromise = registered.get('scratch_snapshot').execute({})
  await sleep(250)
  const reqFrame = A.frames.find(f => f.id && f.op === 'snapshot')
  t('插件把 snapshot 请求发给了 A', !!reqFrame, JSON.stringify(A.frames.map(f => f.op || f.type)))
  if (reqFrame) {
    // B 冒充 A 应答同一条请求
    B.ws.send(JSON.stringify({ id: reqFrame.id, ok: true, result: { spoofed: true } }))
    await sleep(250)
    // A 正常应答
    A.ws.send(JSON.stringify({ id: reqFrame.id, ok: true, result: { targets: [{ name: 'real' }] } }))
    const r = await snapPromise
    t('结果来自真正的会话 A，不是 B 伪造的',
      r && r.project && r.project.targets && r.project.targets[0].name === 'real',
      JSON.stringify(r && r.project))
    t('日志里记录了跨会话应答被忽略',
      logged.some(([, m]) => m.includes('跨会话应答')), JSON.stringify(logged.slice(-4)))
  } else {
    t('结果来自真正的会话 A，不是 B 伪造的', false, '没抓到请求帧')
    t('日志里记录了跨会话应答被忽略', false, '没抓到请求帧')
  }
}

// ---- 7. 断开时挂起请求立刻被拒（不是干等 15s 超时）----
console.log('[auth] 断开时挂起请求的处理')
{
  B.ws.close()
  await sleep(150)
  // 注意：立刻挂上 rejection 处理，否则 Node 会把它当 unhandled rejection 直接崩进程
  const p = registered.get('scratch_snapshot').execute({}).then(() => null, (e) => e)
  await sleep(250)
  const reqFrame2 = A.frames.filter(f => f.id && f.op === 'snapshot').pop()
  t('确实发出了请求才断的', !!reqFrame2)
  const t0 = Date.now()
  A.ws.close()
  const err = await p
  const elapsed = Date.now() - t0
  t('会话断开后挂起请求被拒', !!err, err && err.message)
  t('报的是断开而不是超时', err && /断开/.test(err.message), err && err.message)
  t('立刻返回（没等满 15s 超时）', elapsed < 3000, `${elapsed}ms`)
}

// ---- 收尾 ----
console.log(`\n===== 桥认证单测: ${pass} pass / ${fail} fail =====`)
for (const d of effects) { try { d() } catch {} }
try { rmSync(HOME, { recursive: true, force: true }) } catch {}
process.exit(fail ? 1 : 0)
