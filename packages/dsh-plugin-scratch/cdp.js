// cdp.js — 用 Chrome DevTools Protocol 直接驱动编辑器（**不需要浏览器扩展**）
//
// 为什么要有这条路：
//   扩展那条路（background.js 里的 service worker 持 socket）要求用户「装扩展 + 填 token」，
//   而且 Electron 应用（TurboWarp Desktop）根本装不了扩展 —— 官方不支持，那条路对它无解。
//   但只要编辑器进程是**我们自己拉起来的**，就能给它带上 --remote-debugging-port，
//   然后用 CDP 把**同一份页面执行器**（vm-executor.js，与扩展用的 content-main.js 同源）
//   注进默认执行上下文 —— 于是 28 个工具全部照常工作，零安装、零 token。
//
// 关键事实（2026-10 真机验证，TurboWarp Desktop 1.16.0 / Electron 42 / Chromium 148）：
//   · TurboWarp Desktop 接受 --remote-debugging-port，/json/list 里是 tw-editor://./gui/gui.html
//   · 该 target 的**默认上下文**（auxData.isDefault）里 window.vm 就是真 VM：
//     window.vm.runtime.targets → ["Stage","角色1"]，window.Blockly 也在
//   · 隔离上下文（Electron Isolated Context）里没有 vm —— 注入必须挑默认上下文（踩过）
//   · **子 frame 也有"默认上下文"，而且长得一模一样**（auxData.isDefault / type=default）。
//     编辑器里只要冒出任何一个 iframe（sandbox 的 about:blank 也算），旧代码就会把
//     会话切到那个 iframe 上：evaluate 不报错、只是返回 undefined → 之后每个 op 都
//     「超时 15s」，可编辑器画面完全正常（真机踩过一整轮，误判成"加造型把会话搞坏了"）。
//     现在先问 Page.getFrameTree 拿到主 frame id，只认这个 frame 的默认上下文。
//   · CDP 的 Runtime.evaluate 不受页面 CSP 限制（DevTools 特权），约 47KB 的执行器能直接灌进去
//
// 页面执行器本来就用 window.postMessage 跟"隔离世界那一侧"说话（它自己不含任何 chrome.*），
// 所以这里只要提供一个垫片：把 postMessage 拦下来转成 CDP binding 调用，反向把消息
// 合成 MessageEvent 派发回页面。执行器一行都不用改。

import { createServer } from 'node:net'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 找一个空闲端口（编辑器进程要用的调试端口） */
export function findFreePort() {
  return new Promise((res, rej) => {
    const s = createServer()
    s.once('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => res(p))
    })
    if (s.unref) s.unref()
  })
}

/** CDP 的 HTTP 端点探活：/json/version */
export async function probeCdp(port, timeoutMs = 1500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs)
    })
    const v = await res.json()
    return { ok: true, browser: v.Browser || '', ua: v['User-Agent'] || '' }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

/** 等 CDP 端点出现，并挑一个可用的 page target（默认优先编辑器 GUI 那个） */
export async function waitForPageTarget(port, { timeoutMs = 45000, prefer = /gui|turbowarp|editor/i } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = '还没起来'
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) })
      const list = await res.json()
      const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      const pick = pages.find((t) => prefer.test(String(t.url))) || pages[0]
      if (pick) return pick
      last = pages.length ? 'page target 没有调试地址' : '还没有 page target'
    } catch (e) {
      last = String((e && e.message) || e)
    }
    await sleep(400)
  }
  throw new Error(`等 CDP 端点超时（${timeoutMs}ms，127.0.0.1:${port}）：${last}`)
}

/**
 * 页面侧垫片：把执行器的 window.postMessage 转成 __dshCdpSend（CDP binding），
 * 并把插件发来的消息合成 MessageEvent 派发回去。
 * 注意 e.source 必须是 window —— 执行器的监听里有 `if (e.source !== window) return`。
 */
const SHIM = `(function () {
  if (window.__dshCdpShimInstalled) return 'already'
  window.__dshCdpShimInstalled = true
  var TAG = '__dshBridgeRelay'
  var orig = window.postMessage ? window.postMessage.bind(window) : null
  window.postMessage = function (msg) {
    if (msg && typeof msg === 'object' && typeof msg[TAG] === 'string') {
      try { window.__dshCdpSend(JSON.stringify(msg)) } catch (e) { /* binding 没装上 */ }
      return
    }
    if (!orig) return
    try { return orig.apply(null, arguments) } catch (e) { /* tw-editor:// 这类 targetOrigin 非法，吞掉 */ }
  }
  window.__dshCdpDeliver = function (json) {
    var data
    try { data = JSON.parse(json) } catch (e) { return 'bad-json' }
    window.dispatchEvent(new MessageEvent('message', { data: data, origin: location.origin, source: window }))
    return 'ok'
  }
  return 'installed'
})()`

async function webSocketCtor() {
  // Node 22+ / Electron 42+ 有全局 WebSocket；老环境退回 ws 包
  if (typeof WebSocket === 'function') return WebSocket
  const ws = await import('ws')
  return ws.default ? ws.default.WebSocket || ws.default : ws.WebSocket
}

/**
 * 插件 → 页面的消息包装。
 * 扩展路径里，"给消息贴 __dshBridgeRelay 标签"这层活是 relay-isolated.js + service worker 干的
 * （SW 收到 WS 上的 {id,op,args} 后，转给页面时变成 {__dshBridgeRelay:'op', id, op, args}）。
 * CDP 路径没有那一层，必须在这里补 —— 否则页面执行器**完全不认识**这条消息。
 * 症状极具误导性：{__dshBridgeRelay:'ping'} 手写了标签所以 ping/pong 正常、页面自报
 * "socket=open authed=true"，但每个 op 都超时（真机踩过：project_meta 15s、snapshot 120s）。
 */
export function tagForPage(text) {
  try {
    const msg = JSON.parse(text)
    if (msg && typeof msg === 'object' && !msg.__dshBridgeRelay && (msg.op || msg.id !== undefined)) {
      return JSON.stringify(Object.assign({ __dshBridgeRelay: 'op' }, msg))
    }
  } catch { /* 不是 JSON（理论上不会有）：原样投递 */ }
  return text
}

/**
 * 这个执行上下文是不是**主 frame 的默认上下文**？——CDP 里最容易踩的一处。
 *
 * 三种情况（都真的遇到过）：
 *   · `isolated`    隔离世界（Electron Isolated Context）：没有 window.vm，注进去也是白注
 *   · `child-frame` 子 frame（iframe）的默认上下文：**和主 frame 长得一模一样**
 *                   （`auxData.isDefault === true` / `type === 'default'`），
 *                   按 isDefault 选就一定会被它抢走 —— 之后每条消息都投进那个空 iframe，
 *                   evaluate 不报错只返回 undefined，调用方只能等超时，而编辑器画面完全正常。
 *   · `main`        主 frame 的默认上下文：只有这个里面才有 window.vm
 *
 * @param {{auxData?:object}} context  Runtime.executionContextCreated 里的 context
 * @param {string|null} mainFrameId    Page.getFrameTree 拿到的主 frame id（不认识就传 null）
 */
export function classifyContext(context, mainFrameId) {
  const aux = (context && context.auxData) || {}
  if (!(aux.isDefault && aux.type === 'default')) return 'isolated'
  if (mainFrameId && aux.frameId && aux.frameId !== mainFrameId) return 'child-frame'
  return 'main'
}

/**
 * 连上一个编辑器进程的 CDP 端点，注入执行器，之后就能收发桥消息。
 *
 * @param {object} o
 * @param {number} o.port            调试端口
 * @param {string} o.executorSource  页面执行器源码（vm-executor.js 的内容）
 * @param {(msg:object)=>void} o.onMessage  页面 → 插件（已解析的桥消息）
 * @param {(info:object)=>void} [o.onReady] 注入成功回调
 * @param {(info:object)=>void} [o.onClose] socket 断开
 * @param {(s:string)=>void} [o.log]
 */
export async function attachCdp({ port, executorSource, onMessage, onReady, onClose, log = () => {}, prefer, timeoutMs }) {
  const target = await waitForPageTarget(port, Object.assign(prefer ? { prefer } : {}, timeoutMs ? { timeoutMs } : {}))
  const WS = await webSocketCtor()
  const ws = new WS(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('连 CDP WebSocket 超时（10s）')), 10000)
    ws.addEventListener('open', () => { clearTimeout(to); res() })
    ws.addEventListener('error', (e) => {
      clearTimeout(to)
      rej(new Error('CDP WebSocket 出错: ' + String((e && (e.message || e.error)) || '')))
    })
  })

  let seq = 0
  const waiters = new Map()
  const st = {
    url: target.url, title: target.title || '', injected: false, pongs: 0,
    contextId: null, frameId: null, closes: 0, closed: false, errors: 0,
    // 被子 frame 抢走的执行上下文次数（诊断用；正常应该一直是 0）
    skippedFrames: 0, reinjects: 0
  }

  function send(method, params, timeoutMs = 20000) {
    const id = ++seq
    return new Promise((res, rej) => {
      waiters.set(id, { res, rej })
      try { ws.send(JSON.stringify({ id, method, params })) } catch (e) {
        waiters.delete(id)
        return rej(e)
      }
      setTimeout(() => {
        if (waiters.has(id)) {
          waiters.delete(id)
          rej(new Error('CDP 调用超时: ' + method))
        }
      }, timeoutMs)
    })
  }

  async function inject(reason) {
    if (st.closed) return
    try {
      await send('Runtime.addBinding', { name: '__dshCdpSend' })
    } catch (e) {
      log('addBinding: ' + e.message)
    }
    // ⚠️ 垫片和执行器都是 IIFE，**中间必须有分号**：否则 JS 会把
    //    `(function(){…})()` 后面跟着的 `(function(){…})()` 解析成"调用前一个的返回值"，
    //    报 TypeError: (intermediate value)(...) is not a function（真机踩过，注入直接失败）。
    const r = await send('Runtime.evaluate', {
      expression: SHIM + ';\n' + executorSource
        + ';\n({ shim: window.__dshCdpShimInstalled === true, executor: typeof window.__dshBridge, href: String(location.href) })',
      contextId: st.contextId || undefined,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: true
    })
    const ex = r.exceptionDetails
    if (ex) throw new Error('注入执行器失败: ' + (ex.exception && ex.exception.description ? ex.exception.description : ex.text))
    const probe = r.result && r.result.value
    if (!probe || probe.executor !== 'object') {
      throw new Error('执行器注进去了但 window.__dshBridge 没出现（页面不是 TurboWarp 编辑器？）：' + JSON.stringify(probe))
    }
    st.injected = true
    log(`页面执行器已注入（${reason}）`)
    if (onReady) onReady({ url: st.url, value: probe })
  }

  ws.addEventListener('message', (ev) => {
    let m
    try { m = JSON.parse(String(ev.data)) } catch { return }
    if (m.id && waiters.has(m.id)) {
      const w = waiters.get(m.id)
      waiters.delete(m.id)
      m.error ? w.rej(new Error(m.error.message || JSON.stringify(m.error))) : w.res(m.result || {})
      return
    }
    switch (m.method) {
      case 'Runtime.executionContextCreated': {
        const c = m.params.context
        const aux = c.auxData || {}
        // ⚠️ 只有主 frame 的默认上下文里有 window.vm：
        //    隔离世界是空的；子 frame（iframe）的默认上下文又跟主 frame 长得一模一样 ——
        //    光看 isDefault 一定会被抢走（见 classifyContext 的注释，真机踩过一整轮）。
        const kind = classifyContext(c, st.frameId)
        if (kind === 'child-frame') {
          st.skippedFrames++
          log(`忽略子 frame 的默认上下文（frame=${aux.frameId}，主 frame=${st.frameId}）`)
          return
        }
        if (kind !== 'main') return
        if (!st.frameId && aux.frameId) st.frameId = aux.frameId // getFrameTree 没拿到时的兜底
        st.contextId = c.id
        st.injected = false
        inject('默认上下文就绪').catch((e) => { st.errors++; log('注入失败: ' + e.message) })
        return
      }
      case 'Runtime.executionContextDestroyed':
        // 我们正在用的那个上下文没了（页面重载/进程换了）：赶紧忘掉它，
        // 别拿着一个死 contextId 去 evaluate —— 那种情况只会静默失败。
        if (m.params.executionContextId === st.contextId) {
          st.injected = false
          st.contextId = null
        }
        return
      case 'Runtime.executionContextsCleared':
        st.injected = false
        st.contextId = null
        return
      case 'Page.frameNavigated':
        // 只认主 frame（parentId 为空）。子 frame 的导航跟我们的会话无关 ——
        // 以前这里没判 parentId，结果一个 iframe 导航就能把 url 改掉。
        if (!m.params.frame.parentId) {
          st.url = m.params.frame.url
          st.frameId = m.params.frame.id
          st.injected = false
        }
        return
      case 'Page.loadEventFired':
        inject('页面加载完成').catch((e) => { st.errors++; log('注入失败: ' + e.message) })
        return
      case 'Runtime.bindingCalled':
        if (m.params.name !== '__dshCdpSend') return
        try {
          const msg = JSON.parse(m.params.payload)
          if (msg && msg.__dshBridgeRelay === 'pong') st.pongs++
          if (onMessage) onMessage(msg)
        } catch (e) {
          log('页面消息解析失败: ' + e.message)
        }
        return
      default:
    }
  })

  ws.addEventListener('close', () => {
    st.closed = true
    st.closes++
    if (onClose) onClose({ url: st.url, closes: st.closes })
  })
  ws.addEventListener('error', () => { st.errors++ })

  // 顺序很重要：**先拿到主 frame 的 id，再开 Runtime**。
  // Runtime.enable 会把已存在的上下文一次性报给我们（executionContextCreated），
  // 那时候必须已经知道"主 frame 是谁"，否则第一个报上来的可能是某个 iframe 的默认上下文。
  await send('Page.enable')
  try {
    const tree = await send('Page.getFrameTree')
    st.frameId = tree && tree.frameTree && tree.frameTree.frame && tree.frameTree.frame.id
  } catch (e) {
    log('getFrameTree 失败（退回"见到第一个默认上下文就用"）: ' + e.message)
  }
  await send('Runtime.enable')
  // 上下文/导航事件可能已经发生过，补一次显式注入（幂等：垫片和执行器自己都有已注入判断）
  await sleep(200)
  if (!st.injected) await inject('attach 后立即注入')

  return {
    target,
    state: () => `transport=cdp url=${st.url} injected=${st.injected} ctx=${st.contextId} frame=${st.frameId} pongs=${st.pongs}`
      + (st.skippedFrames ? ` skippedFrames=${st.skippedFrames}` : '')
      + (st.reinjects ? ` reinjects=${st.reinjects}` : '')
      + (st.errors ? ` errors=${st.errors}` : ''),
    raw: st,
    /** 插件 → 页面：投递一条桥消息（JSON 字符串） */
    async deliver(text) {
      if (st.closed) throw new Error('CDP 会话已关闭（编辑器进程没了？）')
      let back = null // { ok, value, error }
      const tryPush = async () => {
        try {
          const r = await send('Runtime.evaluate', {
            expression: `window.__dshCdpDeliver && window.__dshCdpDeliver(${JSON.stringify(text)})`,
            contextId: st.contextId || undefined,
            returnByValue: true
          })
          const ex = r.exceptionDetails
          if (ex) {
            return {
              ok: false,
              error: new Error('投递失败: ' + (ex.exception && ex.exception.description ? ex.exception.description : ex.text))
            }
          }
          const value = r.result && r.result.value
          return { ok: value === 'ok', value }
        } catch (e) {
          return { ok: false, error: e }
        }
      }
      back = await tryPush()
      // 页面里没有执行器（上下文被换掉/页面重载过/被塞进了 iframe）时，
      // evaluate 不会报错，只会返回 undefined —— 于是调用方干等到 15s 超时。
      // 真机踩过：用户看到的就是"AI 卡住了"，而编辑器其实好好的。
      // 这里自己接回去：重注入一次，再投一遍。
      if (!back.ok) {
        st.reinjects++
        log(`投递没被接收（${back.error ? back.error.message : back.value}），重新注入执行器后重试`)
        try { await inject('投递失败后自愈') } catch (e) { st.errors++; log('自愈注入失败: ' + e.message) }
        back = await tryPush()
      }
      if (!back.ok) {
        const why = back.error ? back.error.message : String(back.value)
        throw new Error(
          `编辑器页面里没有可用的执行器（${why}）：页面可能被重置/重载过，或者已经不再是编辑器页。`
          + `桌面版：在窗口里按 Ctrl+R 刷新一下，或 scratch_open_editor({ app: "desktop" }) 重新接；`
          + `网页版：刷新那个标签页。`
        )
      }
      return back.value
    },
    /** 调试/验收用：在页面里求值（返回字符串化的结果） */
    async evaluate(expression) {
      const r = await send('Runtime.evaluate', {
        expression,
        contextId: st.contextId || undefined,
        returnByValue: true,
        awaitPromise: false
      })
      if (r.exceptionDetails) {
        const ex = r.exceptionDetails
        throw new Error(ex.exception && ex.exception.description ? ex.exception.description : ex.text)
      }
      return r.result && r.result.value
    },
    /**
     * 直接发一条 CDP 命令（给页面拿不到的能力用，比如 Page.captureScreenshot —— 截图是
     * 浏览器层的事，页面里的执行器做不到）。返回原始 result。
     */
    async cdpSend(method, params, timeoutMs) {
      if (st.closed) throw new Error('CDP 会话已关闭（编辑器进程没了？）')
      return await send(method, params, timeoutMs)
    },
    async close() {
      st.closed = true
      try { ws.close() } catch { /* 已经断了 */ }
    }
  }
}
