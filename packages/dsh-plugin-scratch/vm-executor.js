// content-main.js — 注入 turbowarp.org 页面（MAIN world），暴露 window.__dshBridge
// 职责：执行扩展 service worker 转发来的 vm 操作；监听用户事件回传。
// 为什么 MAIN world：window.vm 挂在页面主世界（vm-manager-hoc L42），
// isolated world 拿不到（CSP 也不拦扩展注入脚本）。
//
// ⚠️ 本脚本**不持有 WebSocket**（2026-10 从"页面直连 ws://127.0.0.1:31820"改过来的）。
//    Chrome 155 起，公网页面连 loopback 会被 Local Network Access 检查直接拒：
//      net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS
//    （页面里 permissions.query('local-network-access') = denied，没得授权；
//      --disable-features=LocalNetworkAccessChecks 也只降到 prompt）
//    而扩展的 service worker 是豁免的 —— 所以 socket 搬进了 background.js，
//    本脚本只负责"收到 op → 操作 vm → 回结果"。
//
// 传输：window.postMessage ↔ relay-isolated.js ↔ chrome.runtime 端口 ↔ background.js(SW) ↔ 插件

(function () {
  if (window.__dshBridge) return // 已注入

  // ---------------- 传输层（对上面那些文件，本文件只认 __dshBridgeRelay 消息） ----------------
  const TAG = '__dshBridgeRelay'
  let linkOk = false      // 对端的 socket 是否已握手通过（由对端告知，本页自己判断不了）
  let tokenSet = false    // 仅供状态展示：对端手里有没有 token
  let linkReason = ''     // 断开原因（握手超时/token 不对…）
  // 谁在转发消息：'sw' = 浏览器扩展的 service worker（公网页面连不了 loopback，socket 只能在 SW 里），
  // 'cdp' = 插件用 DevTools 协议直接注入本脚本（TurboWarp Desktop 这条路，没有扩展也没有 token）。
  // 这个字段只影响**自报状态**，但很重要：排查时"到底谁在跟我说话"必须一眼看得出。
  let linkVia = 'sw'

  function relaySend(type, extra) {
    try { window.postMessage(Object.assign({ [TAG]: type }, extra), window.location.origin) } catch { /* 非浏览器环境 */ }
  }
  function pageMeta() {
    const hasVM = typeof window.vm === 'object' && window.vm !== null
    return {
      url: location.href,
      projectTitle: document.title,
      turbowarp: hasVM,
      vmApi: hasVM ? 'legacy' : 'none'
    }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return
    const d = e.data
    if (!d || typeof d[TAG] !== 'string') return
    if (d[TAG] === 'op') { handle(d); return }
    if (d[TAG] === 'ping') { relaySend('pong', { meta: pageMeta() }); return }
    if (d[TAG] === 'link') {
      const wasOk = linkOk
      linkOk = !!d.ok
      tokenSet = d.tokenSet !== undefined ? !!d.tokenSet : tokenSet
      linkReason = d.reason || ''
      if (d.via) linkVia = String(d.via)
      if (linkOk && !wasOk) console.info('[dsh-bridge] 桥已连上（' + (linkVia === 'cdp' ? 'CDP 直连，没有扩展' : 'socket 在扩展 SW 里') + '）')
      if (!linkOk && linkReason) console.warn('[dsh-bridge] ' + linkReason)
      return
    }
  })

  // ---------------- M2 状态：观察者 + 用户事件缓存 ----------------
  // includeLists 默认 false：真机踩过 —— 一个 160000 项的列表让单次 poll 回了 14.8MB
  // （问题记录 P1-5）。要看列表就显式 includeLists: true，且只回长度/首个变化位/样本。
  const watchState = { timer: null, targetName: null, values: {}, queue: [], includeLists: false, maxQueue: 400 }
  const userEvents = [] // {type, blockId, opcode, at} 最近 20 条
  // 上一次 state 的列表长度：用来给 pageListDelta（C2：列表是不是在泄漏，不该靠运气发现）
  let stateLastLengths = null

  function watchTick() {
    // 轮询变量变化，推帧给插件侧。合并两层：Stage 全局变量 + 目标角色局部变量
    try {
      const vm = window.vm
      if (!vm || !watchState.targetName) return
      const stage = vm.runtime.getTargetForStage()
      const t = vm.runtime.targets.find(t2 => t2.getName() === watchState.targetName)
      if (!t) return
      const changes = []
      const check = (target, scope) => {
        if (!target) return
        for (const [id, v] of Object.entries(target.variables)) {
          const key = scope + ':' + v.name
          const isList = v.type === 'list' || Array.isArray(v.value)
          if (isList) {
            if (!watchState.includeLists) continue
            const arr = Array.isArray(v.value) ? v.value : []
            const prev = watchState.values[key] || { length: arr.length, sample: arr.slice(0, 20).map(x => JSON.stringify(x)) }
            const sample = arr.slice(0, 20).map(x => JSON.stringify(x))
            let firstDiff = -1
            const n = Math.min(sample.length, prev.sample.length)
            for (let i = 0; i < n; i++) { if (sample[i] !== prev.sample[i]) { firstDiff = i; break } }
            if (firstDiff < 0 && arr.length !== prev.length) firstDiff = n
            if (firstDiff < 0) continue
            watchState.values[key] = { length: arr.length, sample }
            changes.push({
              name: v.name, scope, type: 'list', length: arr.length, prevLength: prev.length,
              firstChangedIndex: firstDiff,
              sample: arr.slice(firstDiff, firstDiff + 3).map(clipScalar)
            })
            continue
          }
          const cur = clipScalar(v.value)
          const known = Object.prototype.hasOwnProperty.call(watchState.values, key)
          if (known && watchState.values[key] === cur) continue
          changes.push({ name: v.name, scope, from: known ? watchState.values[key] : undefined, to: cur })
          watchState.values[key] = cur
        }
      }
      check(stage, 'global')
      check(t, 'local')
      if (changes.length) {
        // 本地队列**无条件**记：scratch_watch 的 poll 读的就是这个队列，
        // 断线时也照样采（重连后用户还能看到断线期间的变化）。
        // ⚠️ 之前把整段记在 `if (linkOk)` 里 → 一旦没连上，轨迹就永远是空的（真机抓到过）。
        watchState.queue.push(...changes.map(c => Object.assign({ at: Date.now() }, c)))
        if (watchState.queue.length > watchState.maxQueue) {
          watchState.queue.splice(0, watchState.queue.length - watchState.maxQueue)
        }
        if (linkOk) relaySend('watch', { target: watchState.targetName, changes, at: Date.now() })
      }
    } catch { /* 页面切换等瞬态，忽略 */ }
  }

  function setupUserEventCapture() {
    // 双向联动数据源：Blockly ui 事件（选中块）+ 绿旗运行状态
    try {
      const vm = window.vm
      if (!vm) return
      // 绿旗/停止：推事件帧给插件
      vm.runtime.on('PROJECT_RUN_START', () => {
        userEvents.push({ type: 'run_start', at: Date.now() })
        if (linkOk) relaySend('event', { name: 'run_start', at: Date.now() })
        trimEvents()
      })
      vm.runtime.on('PROJECT_RUN_STOP', () => {
        userEvents.push({ type: 'run_stop', at: Date.now() })
        if (linkOk) relaySend('event', { name: 'run_stop', at: Date.now() })
        trimEvents()
      })
      // 用户选块：Blockly workspace 的 ui 事件
      const tryBind = (n) => {
        const ws2 = getBlocklyWorkspace()
        if (!ws2) { if (n < 60) setTimeout(() => tryBind(n + 1), 1000); return } // 懒加载 + 晚就绪，重试
        ws2.addChangeListener((e) => {
          // scratch-blocks 把「什么动作」放在 **e.element** 上，e.type 恒为 'ui'。
          // 真机实测（一次真鼠标点击触发三个 ui 事件）：
          //   {element:'selected',   blockId:null}      取消选中（没有块可指）
          //   {element:'click',      blockId:'<块id>'}  点中一个块
          //   {element:'stackclick', blockId:'<块id>'}  点中一叠
          // 旧代码判的是 `e.type === 'click'` —— 永远不成立；而唯一能过第一关的
          // 'selected' 事件 blockId 又是 null，于是整个「用户选块感知」一次都没生效过。
          if (!e || !e.blockId) return
          const el = e.element
          if (el !== 'click' && el !== 'stackclick' && el !== 'selected') return
          const block = ws2.getBlockById(e.blockId)
          userEvents.push({
            type: 'selected', blockId: e.blockId, via: el,
            opcode: block ? block.type : null, at: Date.now()
          })
          trimEvents()
          if (linkOk) {
            relaySend('event', { name: 'selected', blockId: e.blockId, at: Date.now() })
          }
        })
      }
      tryBind(0)
    } catch { /* 双向联动尽力而为，不影响核心功能 */ }
  }

  function trimEvents() { if (userEvents.length > 20) userEvents.splice(0, userEvents.length - 20) }


  // ---------------- 操作分发（原来这里是一整套 WebSocket 客户端，已搬到 background.js） ----------------
  // 页面侧现在只做三件事：收 op → 操作 vm → 回结果；外加把就绪状态报给 SW。
  // 断线重连、token 握手、心跳、多标签页路由全部由 SW 负责 —— 因为只有它能连 loopback。
  function reply(id, ok, payload) {
    relaySend('result', Object.assign({ id, ok }, ok ? { result: payload } : { error: String(payload) }))
  }

  // ---------------- vm 操作实现（宿主 API 兼容层） ----------------
  function getVM() {
    const vm = window.vm
    if (!vm) throw new Error('此页面没有 window.vm（不是编辑器页？）')
    return vm
  }

  function snapshotJson(vm) {
    // 两代 VM 都有 toJSON()，优先用它 —— 它直接给 project.json 的字符串。
    if (typeof vm.toJSON === 'function') return JSON.parse(vm.toJSON())
    // 兜底：TurboWarp 的 saveProjectSb3DontZip() **不是**返回 project.json，
    // 它返回 { 'project.json': Uint8Array, '<md5>.svg': Uint8Array, ... } 的"未打包文件表"
    // （TurboWarp/scratch-vm develop src/virtual-machine.js:613 的 @returns 写得很清楚）。
    // 老代码直接把它当 project.json 用 → 快照存进去的是一堆 Uint8Array，restore 必然崩。
    if (typeof vm.saveProjectSb3DontZip === 'function') {
      const files = vm.saveProjectSb3DontZip()
      const raw = files && files['project.json']
      if (typeof raw === 'string') return JSON.parse(raw)
      if (raw && typeof raw.byteLength === 'number') return JSON.parse(new TextDecoder().decode(raw))
      throw new Error('saveProjectSb3DontZip() 没给出 project.json（宿主实现变了？）')
    }
    throw new Error('这个宿主既没有 toJSON() 也没有 saveProjectSb3DontZip()，拿不到项目 JSON')
  }

  /**
   * 数块：**两种数法都要给出**，因为 project.json 里的 blocks 表**含影子块**
   * （输入框里的字面量、SUBSTACK 的占位都是独立块）。
   * 只报一个数字的话，两边对账永远对不上——用户/AI 看到「5035」和「6083」会以为谁算错了。
   * 实测：伊旬园 14.6MB 那个项目，文件里含影子 5035、真块 4809；
   * 而真 VM 装完还会多出监视器（monitor）对应的块，所以"活的真块数"可能比文件里更多。
   */
  function countBlocksOf(blocks) {
    let real = 0, withShadow = 0
    for (const b of Object.values(blocks || {})) {
      if (!b || typeof b !== 'object') continue
      withShadow++
      if (!b.shadow) real++
    }
    return { real, withShadow }
  }
  function countProjectBlocks(pj) {
    let real = 0, withShadow = 0
    for (const t of (pj && pj.targets) || []) {
      const c = countBlocksOf(t.blocks)
      real += c.real
      withShadow += c.withShadow
    }
    return { real, withShadow }
  }

  function safeEmitWorkspaceUpdate(vm) {
    // emitWorkspaceUpdate() 在没有 editingTarget / 没加载项目时会 TypeError：
    // 它无保护地读 runtime.getTargetForStage().variables 和 this.editingTarget.isStage
    // （TurboWarp/scratch-vm develop src/virtual-machine.js:1726-1777）。
    // 失败只影响 GUI 刷新，项目数据已经改好了，所以这里降级成警告而不是抛。
    try {
      if (!vm.editingTarget || !vm.runtime.getTargetForStage()) return false
      vm.emitWorkspaceUpdate()
      return true
    } catch (e) {
      console.warn('[dsh-bridge] emitWorkspaceUpdate 失败（编辑器不会自动刷新，但项目数据已改）:', e.message)
      return false
    }
  }

  function getBlocklyWorkspace() {
    // 注意：**vm.workspace 从来不存在**。scratch-gui 把 Blockly workspace 挂在自己的
    // React 组件实例上（TurboWarp/scratch-gui develop src/containers/blocks.jsx:167
    // `this.workspace = this.ScratchBlocks.inject(...)`），从没挂到 vm 上。
    // 能拿到它的路只有两条全局：
    //   window.ScratchBlocks —— TurboWarp 显式挂的（blocks.jsx:94）
    //   window.Blockly       —— scratch-blocks 的 UMD 包会挂全局（turbowarp.org 有效）
    // 另外 scratch-blocks 是**懒加载 chunk**：积木区没挂载前 window.Blockly 还不存在，
    // 所以调用方要容忍 null 并重试。scratch.mit.edu 新版编辑器只挂 {Msg}，这两条都拿不到。
    for (const cand of [window.ScratchBlocks, window.Blockly]) {
      try {
        if (cand && typeof cand.getMainWorkspace === 'function') {
          const ws = cand.getMainWorkspace()
          if (ws) return ws
        }
      } catch { /* 换下一个候选 */ }
    }
    return null
  }

  // ---------------- 「刚动过的积木亮一下」 ----------------
  // 用编辑器自己的那套，不自己画：GUI 监听 vm 的 BLOCK_GLOW_ON/OFF → workspace.glowBlock(id, on)
  // → Blockly 给块描一圈黄光（就是积木正在执行时的那种高亮，用户一看就懂）。
  // ⚠️ 两个坑：
  //   1) `Blockly.WorkspaceSvg.glowBlock` 对**工作区里没有的块**会直接 throw（扔的是字符串）；
  //   2) 工作区只有**当前编辑目标**的积木，别的角色的块调了必炸。
  //   所以每次都先 getBlockById 查一遍，只给查得到的块发光。
  const GLOW_MS = 1400
  const glowTimers = new Map()
  function glowBlocks(vm, ids) {
    const ws = getBlocklyWorkspace()
    if (!ws || typeof ws.glowBlock !== 'function' || typeof vm.runtime.glowBlock !== 'function') return 0
    let n = 0
    for (const id of (ids || []).slice(0, 8)) {
      try {
        if (!id || !ws.getBlockById(id)) continue
        const prev = glowTimers.get(id)
        if (prev) clearTimeout(prev)
        vm.runtime.glowBlock(id, true)
        glowTimers.set(id, setTimeout(() => {
          glowTimers.delete(id)
          try { vm.runtime.glowBlock(id, false) } catch { /* 工作区重建/换角色了，无所谓 */ }
        }, GLOW_MS))
        n++
      } catch { /* 单块失败不影响别的块 */ }
    }
    return n
  }

  function findTarget(vm, name) {
    const targets = vm.runtime.targets
    if (!name) return vm.editingTarget
    const t = targets.find(t => t.getName() === name)
    if (!t) throw new Error(`找不到角色 "${name}"，现有: ${targets.map(t => t.getName()).join(', ')}`)
    return t
  }

  // ==================== 运行时 / 静态分析的小工具（v0.7.0） ====================
  // 这一组是从「问题记录」里的 P1-1 / P1-5 / P2-2 / P0-2 / P1-6 提炼出来的：
  // 之前 AI 每次都要自己连裸 CDP 写一套（36 个脚本 / 2300 行），现在收进执行器。

  const sleepMs = (ms) => new Promise(r => setTimeout(r, ms))

  /** 同名 target 的全部实例：原身 + 克隆体。按造型找「可见的那个克隆体」必须用它 */
  function findTargets(vm, name) {
    const all = vm.runtime.targets || []
    if (!name) return vm.editingTarget ? [vm.editingTarget] : []
    return all.filter(t => t.getName() === name)
  }

  function clipScalar(v) {
    // 数字/布尔原样给（AI 要判断真假和大小，别全变字符串）；字符串超长才截断
    if (typeof v === 'number' || typeof v === 'boolean') return v
    const s = v === null || v === undefined ? '' : String(v)
    return s.length > 120 ? s.slice(0, 117) + '…' : s
  }

  /**
   * 变量摘要。**默认不回列表内容** —— 真机踩过：一个 160000 项的列表
   * （`地图.细胞类别`）让 scratch_watch 单次 poll 回了 14.8MB、read_script 回 7.5MB。
   * 标量直出（截断到 120 字），列表只报长度 + 前几项样本。
   */
  function varSummary(target, opts) {
    const o = opts || {}
    const maxVars = Number(o.maxVars) || 40
    const scalars = {}
    const listLengths = {}
    let dropped = 0
    let n = 0
    if (!target || !target.variables) return { scalars, listLengths }
    for (const v of Object.values(target.variables)) {
      const isList = v.type === 'list' || Array.isArray(v.value)
      if (isList) {
        const arr = Array.isArray(v.value) ? v.value : []
        listLengths[v.name] = arr.length
        if (o.includeLists === true) {
          scalars[v.name] = arr.slice(0, Number(o.listLimit) || 50).map(clipScalar)
        }
        continue
      }
      if (n >= maxVars) { dropped++; continue }
      scalars[v.name] = clipScalar(v.value)
      n++
    }
    const out = { scalars, listLengths }
    if (dropped) out.droppedVars = dropped
    if (!Object.keys(listLengths).length) delete out.listLengths
    return out
  }

  /** 顶层块 id（parent 为空）。活块形态里 parent 比 topLevel 标记更可靠 */
  function topLevelIds(blocks) {
    const out = []
    for (const [id, b] of Object.entries(blocks)) {
      if (b && !b.parent) out.push(id)
    }
    return out
  }

  /** 从一个块出发收全「它这一坨」的 id：next 链 + 所有输入（含 SUBSTACK）+ 影子块 */
  function collectIds(blocks, rootId) {
    const out = []
    const seen = new Set()
    const stack = [rootId]
    while (stack.length) {
      const id = stack.pop()
      if (!id || seen.has(id)) continue
      const b = blocks[id]
      if (!b) continue
      seen.add(id)
      out.push(id)
      if (b.next) stack.push(b.next)
      for (const inp of Object.values(b.inputs || {})) {
        if (!inp) continue
        if (inp.block) stack.push(inp.block)
        if (inp.shadow) stack.push(inp.shadow)
      }
    }
    return out
  }

  function opcodeHistogram(blocks, ids) {
    const h = {}
    for (const id of ids) {
      const b = blocks[id]
      if (b) h[b.opcode] = (h[b.opcode] || 0) + 1
    }
    return h
  }

  /**
   * 块数三种口径一次说清（B2）。真机踩过：同一个角色 plugin 报 2364、list_scripts 报 5657，
   * AI 直接按 5657 判断体量、按它找热点，全错 —— 因为 5657 是 **Blockly 展开视图**
   * （inline 字面量被物化成带合成 id 的影子块），2364 才是 project.json 里的真块数。
   */
  function blockCounts(blocks) {
    let total = 0
    let shadows = 0
    for (const b of Object.values(blocks || {})) {
      if (!b || typeof b !== 'object') continue
      total++
      if (b.shadow) shadows++
    }
    return { total, shadows, raw: total - shadows }
  }

  /**
   * 从任意块出发收子树。和 collectIds 的区别：
   *   - branchOnly：只往这几个输入里走（"只给我这个 if 的 true 分支"）
   *   - maxDepth：只下钻 N 层（深脚本不想一次吞 1600 块）
   * next 链**不算一层深度**（同一层顺序执行），影子块默认带上（不然字面量值都看不见）。
   */
  function collectIds2(blocks, rootId, opts) {
    const o = opts || {}
    const out = []
    const seen = new Set()
    const walk = (id, depth) => {
      if (!id || seen.has(id)) return
      const b = blocks[id]
      if (!b) return
      if (o.maxDepth !== null && o.maxDepth !== undefined && depth > o.maxDepth) return
      seen.add(id)
      out.push(id)
      const inputs = b.inputs || {}
      const names = o.branchOnly && o.branchOnly.length
        ? Object.keys(inputs).filter(n => o.branchOnly.includes(n))
        : Object.keys(inputs)
      for (const name of names) {
        const inp = inputs[name]
        if (!inp) continue
        if (inp.block) walk(inp.block, depth + 1)
        if (inp.shadow && inp.shadow !== inp.block) walk(inp.shadow, depth + 1)
      }
      // next 链不算一层深度（同一层顺序执行）；但 depth:0 的含义是"只要这一个块"，
      // 所以那种情况下连 next 也不跟（否则"只回 1 块"永远不成立）。
      if (!o.branchOnly && b.next && o.maxDepth !== 0) walk(b.next, depth)
    }
    walk(rootId, 0)
    return out
  }

  /**
   * 脚本索引：顶层块清单。
   * ⚠️ 关键区分：真脚本（帽子块打头）vs **游离块**（作者调试拖出来的孤立块）。
   * 真机实测某角色 185 个顶层块里约 150 个是游离块 —— 不区分的话"按块数排名"全是噪音。
   * 判定用 runtime._hats（VM 自己注册的帽子表），不靠 opcode 前缀猜。
   */
  function scriptIndex(vm, t) {
    const blocks = t.blocks._blocks
    const hats = (vm.runtime && vm.runtime._hats) || {}
    // 先数一遍 proccode → 被调用次数。C1 的教训：实测 38 个"游离块"里 32 个是
    // procedures_definition（被 141 处 procedures_call 调用，是引擎主干）——
    // 把它们标成"作者调试拖出来的垃圾"会让 AI 直接删掉作者的函数。
    const callCount = Object.create(null)
    for (const b of Object.values(blocks)) {
      if (b && b.opcode === 'procedures_call' && b.mutation && b.mutation.proccode) {
        callCount[b.mutation.proccode] = (callCount[b.mutation.proccode] || 0) + 1
      }
    }
    const out = []
    for (const id of topLevelIds(blocks)) {
      const b = blocks[id]
      const ids = collectIds(blocks, id)
      const calls = []
      for (const bid of ids) {
        const bb = blocks[bid]
        if (bb && bb.opcode === 'procedures_call' && bb.mutation && bb.mutation.proccode) {
          if (!calls.includes(bb.mutation.proccode)) calls.push(bb.mutation.proccode)
        }
      }
      let kind = hats[b.opcode] ? 'script' : 'loose'
      const entry = {
        blockId: id,
        opcode: b.opcode,
        kind,
        blockCount: ids.length,
        x: b.x, y: b.y,
        calls: calls.length ? calls : undefined
      }
      if (b.opcode === 'procedures_definition') {
        // 自定义积木定义：单列一档，并报"被调用几次" + 参数原型 + 是否 warp
        kind = 'definition'
        entry.kind = kind
        const protoRef = b.inputs && b.inputs.custom_block && b.inputs.custom_block.block
        const proto = protoRef ? blocks[protoRef] : null
        const mut = proto && proto.mutation
        if (mut) {
          entry.proccode = mut.proccode
          try { entry.params = JSON.parse(mut.argumentnames || '[]') } catch { entry.params = undefined }
          entry.warp = mut.warp === true || mut.warp === 'true' || undefined
          entry.calledBy = callCount[mut.proccode] || 0
        }
      }
      out.push(entry)
    }
    // 真脚本/定义在前（块数降序），游离块垫底（块数降序）
    out.sort((a, b2) => {
      const real = (s) => s.kind !== 'loose'
      if (real(a) !== real(b2)) return real(a) ? -1 : 1
      return b2.blockCount - a.blockCount
    })
    return out
  }

  /** 一段脚本的"人话"名字：帽子块 + 自定义积木名，方便 AI 在清单里认人 */
  function scriptLabel(blocks, s) {
    if (s.opcode === 'procedures_definition') {
      const protoId = blocks[s.blockId] && blocks[s.blockId].inputs && blocks[s.blockId].inputs.custom_block
      const proto = protoId && protoId.block && blocks[protoId.block]
      if (proto && proto.mutation && proto.mutation.proccode) return proto.mutation.proccode
    }
    return undefined
  }

  // ==================== opcode 形状表（G3：拼错的输入名会被**静默**丢掉） ====================
  // 为什么非要有这张表：注入走的是块模型（Blocks.createBlock），不经过 Blockly 的校验，
  // 所以给 operator_add 塞一个 OPERAND1 **不会报任何错** —— 工作区里甚至显示正常，
  // 但运行时那个输入恒为空，算术按 0 算。实测这一条把人带偏了 8~10 轮
  // （先怀疑变量、再怀疑编译器、再怀疑存盘，最后才发现是 input 名写错）。
  // 表里没有的 opcode（扩展 / 冷门块）依次用 Blockly 块定义、项目里已有的同类块兜底；
  // 都兜不到就标 unverified，**不冤枉**。
  // 值输入（NUM1/OPERAND1/MESSAGE…）都在这里；SUBSTACK 是语句输入，也一起列进去。
  const INPUTS_BY_OPCODE = {
    // 运动
    motion_movesteps: ['STEPS'], motion_turnright: ['DEGREES'], motion_turnleft: ['DEGREES'],
    motion_goto: ['TO'], motion_gotoxy: ['X', 'Y'], motion_glideto: ['SECS', 'TO'],
    motion_glidesecstoxy: ['SECS', 'X', 'Y'], motion_pointindirection: ['DIRECTION'],
    motion_pointtowards: ['TOWARDS'], motion_changexby: ['DX'], motion_setx: ['X'],
    motion_changeyby: ['DY'], motion_sety: ['Y'],
    // 外观
    looks_say: ['MESSAGE'], looks_think: ['MESSAGE'], looks_sayforsecs: ['MESSAGE', 'SECS'],
    looks_thinkforsecs: ['MESSAGE', 'SECS'], looks_switchcostumeto: ['COSTUME'],
    looks_switchbackdropto: ['BACKDROP'], looks_switchbackdroptoandwait: ['BACKDROP'],
    looks_changeeffectby: ['VALUE'], looks_seteffectto: ['VALUE'],
    looks_changesizeby: ['CHANGE'], looks_setsizeto: ['SIZE'],
    looks_goforwardbackward: ['NUM'],
    // 声音
    sound_playuntildone: ['SOUND_MENU'], sound_play: ['SOUND_MENU'],
    sound_changeeffectby: ['VALUE'], sound_seteffectto: ['VALUE'],
    sound_changevolumeby: ['VOLUME'], sound_setvolumeto: ['VOLUME'],
    // 事件
    event_whengreaterthan: ['VALUE'], event_broadcast: ['BROADCAST_INPUT'],
    event_broadcastandwait: ['BROADCAST_INPUT'],
    // 控制
    control_wait: ['DURATION'], control_repeat: ['TIMES', 'SUBSTACK'],
    control_forever: ['SUBSTACK'], control_if: ['CONDITION', 'SUBSTACK'],
    control_if_else: ['CONDITION', 'SUBSTACK', 'SUBSTACK2'], control_wait_until: ['CONDITION'],
    control_repeat_until: ['CONDITION', 'SUBSTACK'], control_while: ['CONDITION', 'SUBSTACK'],
    control_for_each: ['VALUE', 'SUBSTACK'], control_create_clone_of: ['CLONE_OPTION'],
    control_all_at_once: ['SUBSTACK'],
    // 侦测
    sensing_touchingobject: ['TOUCHINGOBJECTMENU'], sensing_touchingcolor: ['COLOR'],
    sensing_coloristouchingcolor: ['COLOR', 'COLOR2'], sensing_distanceto: ['DISTANCETOMENU'],
    sensing_askandwait: ['QUESTION'], sensing_keypressed: ['KEY_OPTION'],
    sensing_of: ['OBJECT', 'PROPERTY'],
    // 运算（G3 的重灾区：同一族三种命名）
    operator_add: ['NUM1', 'NUM2'], operator_subtract: ['NUM1', 'NUM2'],
    operator_multiply: ['NUM1', 'NUM2'], operator_divide: ['NUM1', 'NUM2'],
    operator_mod: ['NUM1', 'NUM2'], operator_random: ['FROM', 'TO'],
    operator_gt: ['OPERAND1', 'OPERAND2'], operator_lt: ['OPERAND1', 'OPERAND2'],
    operator_equals: ['OPERAND1', 'OPERAND2'], operator_and: ['OPERAND1', 'OPERAND2'],
    operator_or: ['OPERAND1', 'OPERAND2'], operator_not: ['OPERAND'],
    operator_join: ['STRING1', 'STRING2'], operator_letter_of: ['LETTER', 'STRING'],
    operator_length: ['STRING'], operator_contains: ['STRING1', 'STRING2'],
    operator_round: ['NUM'], operator_mathop: ['NUM'],
    // 数据
    data_setvariableto: ['VALUE'], data_changevariableby: ['VALUE'],
    data_addtolist: ['ITEM'], data_deleteoflist: ['INDEX'],
    data_insertatlist: ['ITEM', 'INDEX'], data_replaceitemoflist: ['INDEX', 'ITEM'],
    data_itemoflist: ['INDEX'], data_itemnumoflist: ['ITEM'],
    data_listcontainsitem: ['ITEM'],
    // 画笔（扩展）
    pen_setPenColorToColor: ['COLOR'], pen_changePenColorParamBy: ['VALUE'],
    pen_setPenColorParamTo: ['VALUE'], pen_setPenSizeTo: ['SIZE'], pen_changePenSizeBy: ['SIZE'],
    // 音乐（扩展）
    music_playDrumForBeats: ['DRUM', 'BEATS'], music_restForBeats: ['BEATS'],
    music_playNoteForBeats: ['NOTE', 'BEATS'], music_setInstrument: ['INSTRUMENT'],
    music_setTempo: ['TEMPO'], music_changeTempo: ['TEMPO'],
    // 自制积木
    argument_reporter_string_number: [], argument_reporter_boolean: [],
    procedures_definition: ['custom_block']
  }
  // 只有这些 opcode 的字段名校验是可靠的（表里写了才校验；写漏了就不校验，宁可不报）
  const FIELDS_BY_OPCODE = {
    event_whenkeypressed: ['KEY_OPTION'], event_whenbroadcastreceived: ['BROADCAST_OPTION'],
    event_whenbackdropswitchesto: ['BACKDROP'], event_whengreaterthan: ['WHENGREATERTHANMENU'],
    looks_changeeffectby: ['EFFECT'], looks_seteffectto: ['EFFECT'],
    looks_setrotationstyle: ['STYLE'], looks_gotofrontback: ['FRONT_BACK'],
    looks_goforwardbackward: ['FORWARD_BACKWARD'], looks_costumenumbername: ['NUMBER_NAME'],
    looks_backdropnumbername: ['NUMBER_NAME'],
    sound_changeeffectby: ['EFFECT'], sound_seteffectto: ['EFFECT'],
    data_setvariableto: ['VARIABLE'], data_changevariableby: ['VARIABLE'],
    data_addtolist: ['LIST'], data_deleteoflist: ['LIST'], data_deletealloflist: ['LIST'],
    data_insertatlist: ['LIST'], data_replaceitemoflist: ['LIST'], data_itemoflist: ['LIST'],
    data_itemnumoflist: ['LIST'], data_lengthoflist: ['LIST'], data_listcontainsitem: ['LIST'],
    control_for_each: ['VARIABLE'], operator_mathop: ['OPERATOR'],
    sensing_current: ['CURRENTMENU'], sensing_setdragmode: ['DRAG_MODE'],
    pen_changePenColorParamBy: ['COLOR_PARAM'], pen_setPenColorParamTo: ['COLOR_PARAM'],
    argument_reporter_string_number: ['VALUE'], argument_reporter_boolean: ['VALUE']
  }
  // 同一族命名对照：拼错时直接把正确答案摆出来（AI 一次就能改对）
  const INPUT_FAMILY_HINT = '算术 operator_add/subtract/multiply/divide/mod 用 NUM1/NUM2；'
    + '比较 operator_gt/lt/equals 和逻辑 and/or 用 OPERAND1/OPERAND2；'
    + '字符串 join/contains 用 STRING1/STRING2，letter_of 用 LETTER/STRING，random 用 FROM/TO'

  const opcodeSpecCache = new Map()
  /** 从 GUI 的 Blockly 块定义里现推输入名（扩展/冷门块的正路；拿不到就 null） */
  function specFromBlockly(opcode) {
    const B = window.ScratchBlocks || window.Blockly
    if (!B || !B.Blocks || !B.Blocks[opcode] || typeof B.Workspace !== 'function') return null
    let ws = null
    try {
      ws = new B.Workspace()
      const b = ws.newBlock(opcode)
      const inputs = []
      for (const inp of (b.inputList || [])) {
        // 值输入和语句输入都有 connection；只剩字段的行没有（那部分不是输入名）
        if (inp && inp.name && inp.connection) inputs.push(inp.name)
      }
      return { inputs, fields: [], source: 'blockly' }
    } catch {
      return null
    } finally {
      try { if (ws) ws.dispose() } catch { /* headless workspace 释放失败无所谓 */ }
    }
  }
  /** 项目里已经有一模一样的 opcode？直接看它的输入名（最贴近这个项目的方言） */
  function specFromProject(vm, opcode) {
    const seen = new Set()
    for (const t of (vm.runtime.targets || [])) {
      for (const b of Object.values(t.blocks._blocks)) {
        if (!b || b.opcode !== opcode) continue
        for (const name of Object.keys(b.inputs || {})) seen.add(name)
      }
      if (seen.size) return { inputs: [...seen], fields: [], source: 'project' }
    }
    return null
  }
  /** opcode → {inputs, fields, source}；自定义块的输入名是**参数 id**，静态推不出来，返回 null */
  // procedures_call / procedures_prototype 的输入槽键名就是 mutation.argumentids 里那些随机串，
  // 没有任何静态形状表能对上。早先只放过了 procedures_call，结果**带自定义块的片段一律注不进去**
  // （背包里 142 块的字库引擎就是这么被拦下的），报的还是"输入名写错了"这种最误导的错。
  const ARG_ID_OPCODES = new Set(['procedures_call', 'procedures_prototype'])
  function opcodeSpec(vm, opcode) {
    if (ARG_ID_OPCODES.has(opcode)) return null
    if (opcodeSpecCache.has(opcode)) return opcodeSpecCache.get(opcode) || null
    let spec = null
    if (INPUTS_BY_OPCODE[opcode]) {
      spec = { inputs: INPUTS_BY_OPCODE[opcode], fields: FIELDS_BY_OPCODE[opcode] || [], source: 'table' }
    } else {
      spec = specFromBlockly(opcode) || specFromProject(vm, opcode)
      // 只有 Blockly 给的那份才把字段名也收进来（项目/表里字段信息不全，宁可不说）
    }
    opcodeSpecCache.set(opcode, spec || false)
    return spec
  }

  /**
   * 注入前校验输入/字段名。**默认硬失败**（lenient:true 才降级成警告）：
   * 这条错误静默得太彻底，宁可让 AI 当场改，也不要它半小时后才发现算式全是 0。
   * @returns {{errors: string[], warnings: string[], checked: number, unverified: number}}
   */
  function validatePayload(vm, dict, opts) {
    const o = opts || {}
    const errors = []
    const warnings = []
    let checked = 0
    let unverified = 0
    for (const [id, b] of Object.entries(dict || {})) {
      if (Array.isArray(b) || !b || typeof b !== 'object' || typeof b.opcode !== 'string') continue
      const spec = opcodeSpec(vm, b.opcode)
      if (!spec) { unverified++; continue }
      checked++
      const inputs = b.inputs || {}
      for (const name of Object.keys(inputs)) {
        if (spec.inputs.includes(name)) continue
        errors.push(`块 ${id}（${b.opcode}）没有输入 "${name}" —— 它的输入是 ${spec.inputs.join('、') || '（无）'}。`
          + '拼错**不会报错**，运行时那个输入恒为空（算术按 0 算），症状就是「脚本在跑但结果一直是 0」')
      }
      const fields = b.fields || {}
      for (const name of Object.keys(fields)) {
        if (!spec.fields.length || spec.fields.includes(name)) continue
        errors.push(`块 ${id}（${b.opcode}）没有字段 "${name}" —— 它是 ${spec.fields.join('、')}`
          + '（字段是下拉框/变量选择，不是输入槽；写错同样静默无效）')
      }
      if (!o.skipMissingWarn) {
        for (const name of spec.inputs) {
          if (name in inputs) continue
          if (/^SUBSTACK/.test(name)) continue // 空 C 块本来就允许没有 SUBSTACK
          if (b.shadow) continue
          warnings.push(`块 ${id}（${b.opcode}）少了输入 ${name} —— 会当空值/0 算`)
        }
      }
    }
    if (errors.length && o.lenient !== true) {
      const head = errors.slice(0, 4).join('；')
      throw new Error(
        `${errors.length} 处输入/字段名写错了（这类错误不会报错，先在注入前拦下来）：${head}`
        + (errors.length > 4 ? `；还有 ${errors.length - 4} 处` : '')
        + `。\n提示：${INPUT_FAMILY_HINT}。\n`
        + '确认写法是刻意试验（或扩展块拿不到形状表）就传 lenient:true 强行注入。'
      )
    }
    return { errors, warnings, checked, unverified }
  }

  // ---------------- 布局：给新积木找个不叠的位置（G4） ----------------
  // 实测坑：AI 按 240px 间距给了 (40,380)/(40,620)/(40,900)，但脚本真实渲染高度 600~1600px，
  // 三者完全叠在一起；用户想把它们拖开时块黏在鼠标上，最后连带帽子丢了 41 块。
  // 所以：没给坐标 → 按估算高度自己往下排；给了坐标但算下来会叠 → 也重排（layout:"given" 可关）。
  const LAYOUT_COL_W = 480
  const LAYOUT_ROW_GAP = 80
  const LAYOUT_PAGE_H = 1400
  const BLOCK_PX = 48

  /** 估算一段 sb3 形态脚本的高度（注入前只有 sb3 dict，拿不到活块） */
  function estStackHeightSb3(dict, rootId) {
    let rows = 0
    const seen = new Set()
    const walk = (id) => {
      const b = dict[id]
      if (!b || Array.isArray(b) || seen.has(id) || rows > 400) return
      seen.add(id)
      rows++
      for (const desc of Object.values(b.inputs || {})) {
        if (!Array.isArray(desc)) continue
        // [1, 字面量] 是内联值，不占行；[2, 块id] / [3, 块id, 默认值] 的第一个才是积木
        const child = desc[0] === 1 ? null : desc[1]
        if (typeof child === 'string' && dict[child]) walk(child)
      }
      if (typeof b.next === 'string') walk(b.next)
    }
    walk(rootId)
    return Math.max(rows * BLOCK_PX + 40, 120)
  }

  /** 估算一段活块脚本（顶层块 + 它下面全部嵌套/next）渲染出来多高（像素） */
  function estStackHeight(blocks, rootId) {
    let rows = 0
    const seen = new Set()
    const walk = (bid) => {
      const b = blocks[bid]
      if (!b || seen.has(bid) || rows > 400) return
      seen.add(bid)
      rows++
      for (const inp of Object.values(b.inputs || {})) {
        if (inp && inp.block && inp.block !== inp.shadow) walk(inp.block)
      }
      if (b.next) walk(b.next)
    }
    walk(rootId)
    return Math.max(rows * BLOCK_PX + 40, 120)
  }

  /** 当前角色里已占用的最右 / 最下边界（用来把新脚本放到它们右边，不压住作者的东西） */
  function workspaceExtent(blocks) {
    let maxRight = 0
    let minTop = 48
    let any = false
    for (const id of topLevelIds(blocks)) {
      const b = blocks[id]
      if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) continue
      any = true
      maxRight = Math.max(maxRight, b.x)
      minTop = Math.min(minTop, b.y)
    }
    return any ? { maxRight, minTop } : null
  }

  /**
   * 给「这次要注入的顶层块」算坐标。
   * @param {object} dict  sb3 blocks dict（AI 给的）
   * @param {string[]} rootIds 顶层块 id（旧 id）
   * @param {object} blocks 目标角色现有块（算占用边界用）
   * @param {'smart'|'auto'|'given'} mode
   *   smart（缺省）：坐标**都给全了**就尊重（背包 load 给 40,40 就落 40,40），
   *                  缺一个就整批自动排（别一半叠一半不叠）
   *   auto：一律自动排（无视给的坐标）
   *   given：一律尊重（只报告重叠）
   */
  function planLayout(dict, rootIds, blocks, mode) {
    const extent = workspaceExtent(blocks)
    const given = rootIds.filter(id => {
      const b = dict[id]
      return Number.isFinite(b && b.x) && Number.isFinite(b && b.y)
    })
    const allGiven = rootIds.length > 0 && given.length === rootIds.length
    const effective = mode === 'given' ? 'given' : (mode === 'auto' ? 'auto' : (allGiven ? 'given' : 'auto'))
    if (effective === 'given') {
      // 就算尊重坐标，也检查一下"按估算高度会不会叠"—— 叠了就报出来，让调用方知道
      const sorted = given.slice().sort((a, b2) => (dict[a].x - dict[b2].x) || (dict[a].y - dict[b2].y))
      const overlap = []
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const a = dict[sorted[i]]
          const b2 = dict[sorted[j]]
          if (Math.abs(a.x - b2.x) > LAYOUT_COL_W) continue
          const ha = estStackHeightSb3(dict, sorted[i])
          if (b2.y < a.y + ha) overlap.push([sorted[i], sorted[j]])
        }
      }
      return { positions: null, overlap, mode: 'given' }
    }
    // auto：从现有内容的右边起一列，按估算高度往下排，超过一页高就换列
    const x0 = extent ? extent.maxRight + LAYOUT_COL_W : 48
    const y0 = 48
    let x = x0
    let y = y0
    const positions = {}
    const placed = []
    for (const id of rootIds) {
      const h = estStackHeightSb3(dict, id)
      if (y + h > y0 + LAYOUT_PAGE_H && y > y0) { x += LAYOUT_COL_W; y = y0 }
      positions[id] = { x, y }
      placed.push({ id, x, y, estHeight: h })
      y += h + LAYOUT_ROW_GAP
    }
    // auto 下也要检查 AI 显式给的坐标有没有叠（给了也照排，但要如实报）
    const overlap = []
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i]
        const b2 = placed[j]
        if (a.x === b2.x && b2.y < a.y + a.estHeight) overlap.push([a.id, b2.id])
      }
    }
    return { positions, overlap, mode: 'auto', placed }
  }

  /** 滚到某个块并等高亮用：切到该角色 → 等 GUI 把块渲染出来 → 滚过去 */
  async function followBlock(vm, t, blockId) {
    if (!blockId) return null
    const ws = getBlocklyWorkspace()
    if (!ws) return null
    if (vm.editingTarget && vm.editingTarget.id !== t.id) {
      vm.setEditingTarget(t.id)
      safeEmitWorkspaceUpdate(vm)
      await sleepMs(120)
    }
    for (let i = 0; i < 8; i++) {
      let has = false
      try { has = !!ws.getBlockById(blockId) } catch { has = false }
      if (has) return scrollToBlock(ws, blockId)
      await sleepMs(150)
    }
    return null
  }

  // ---------------- 注入账本：谁是我塞进去的（F0：绝不自动清理） ----------------
  // 旧行为（问题清单 F0）：AI 把作者的积木 move_block 挂到一个"刚注入、还游离"的块上，
  // 下一次 add_blocks 之后**那个块连同作者的子树一起消失**（5664 → 5650，locate 报找不到）。
  // 不管底层到底是谁删的（VM 的 createBlock 不会删、shareBlocksToTarget 也不会），
  // 插件这边的承诺改成两条硬规则：
  //   ① 永不自动清理任何块 —— 要清必须显式 discardStale:true，而且只清"整棵子树都是我注入的"；
  //   ② 每次注入后对账：原来有的块少了就当场报 lost（数据丢失不能静默）。
  // 账本按 targetId 记，执行器被重注入就清空（reload 后 id 本来也全变了）。
  const injectedLedger = new Map() // targetId -> Map<blockId, {opcode, at}>
  function ledgerOf(t) {
    let m = injectedLedger.get(t.id)
    if (!m) { m = new Map(); injectedLedger.set(t.id, m) }
    return m
  }
  /** 之前注入、现在**仍是顶层**（= 没被 AI 拼进脚本，也没被用户拖走）的块 */
  function staleInjected(t) {
    const m = injectedLedger.get(t.id)
    if (!m) return []
    const out = []
    for (const [id, info] of m) {
      const b = t.blocks._blocks[id]
      if (!b) { m.delete(id); continue } // 已经被删/被重开工程，账本跟着清
      if (b.parent) continue // 已经接到别处去了，不算游离
      out.push({ id, opcode: b.opcode, at: info.at })
    }
    return out
  }
  /** 显式清理游离块：只删"整棵子树都是自己注入的"，碰到作者积木就跳过 */
  function discardStale(vm, t, stale) {
    const tracked = new Set((injectedLedger.get(t.id) || new Map()).keys())
    const deleted = []
    const skipped = []
    for (const s of stale) {
      const sub = [...subtreeIds(t.blocks, s.id)]
      if (sub.some(id => !tracked.has(id))) { skipped.push(s.id); continue } // 上面挂着作者的东西，不碰
      try {
        t.blocks.deleteBlock(s.id)
        deleted.push(s.id)
        const m = injectedLedger.get(t.id)
        if (m) for (const id of sub) m.delete(id)
      } catch { skipped.push(s.id) }
    }
    if (deleted.length) {
      t.blocks.emitProjectChanged()
      safeEmitWorkspaceUpdate(vm)
    }
    return { deleted, skipped }
  }

  // ---------------- 把视口带过去（F1：用户当场看不到改了啥） ----------------
  /** 滚到某个块（只看得到、不改数据）。返回实际走的 API，全失败给 null */
  function scrollToBlock(ws, blockId) {
    if (!ws || !blockId) return null
    let block = null
    try { block = ws.getBlockById(blockId) } catch { block = null }
    try {
      if (typeof ws.centerOnBlock === 'function') { ws.centerOnBlock(blockId); return 'centerOnBlock' }
      if (!block) return null
      const xy = block.getRelativeToSurfaceXY()
      if (typeof ws.scrollBounds === 'function') {
        ws.scrollBounds(xy.x, xy.y, xy.x + 200, xy.y + 80)
        return 'scrollBounds'
      }
      if (typeof ws.scroll === 'function') {
        const m = typeof ws.getMetrics === 'function' ? ws.getMetrics() : null
        const s = ws.scale || 1
        ws.scroll(xy.x * s - (m ? m.viewWidth / 2 : 400), xy.y * s - (m ? m.viewHeight / 2 : 300))
        return 'scroll'
      }
    } catch { /* 回落 null */ }
    return null
  }

  /** 运行时快照（只读，全用 try 兜：不同 VM 版本字段有差异，别让工具整个炸掉） */
  function runtimeState(vm, opts) {
    const o = opts || {}
    const rt = vm.runtime
    const threads = rt.threads || []
    const active = threads.filter(th => th.status !== 4 /* STATUS_DONE */)
    const clones = {}
    let targets = 0
    for (const t of rt.targets || []) {
      targets++
      if (!t.sprite || t.isOriginal) continue
      clones[t.sprite.name] = (clones[t.sprite.name] || 0) + 1
    }
    const stage = rt.getTargetForStage()
    const vars = varSummary(stage, { includeLists: o.includeLists === true, listLimit: o.listLimit })
    const stepTime = typeof rt.currentStepTime === 'number' ? rt.currentStepTime : null
    const out = {
      running: active.length > 0,
      threads: active.length,
      threadsTotal: threads.length,
      targets,
      clones: Object.keys(clones).length ? clones : undefined,
      stepMs: stepTime,
      fps: stepTime ? Math.round(1000 / stepTime) : null,
      pageVars: vars.scalars
    }
    if (vars.listLengths) out.pageLists = vars.listLengths
    if (!o.targetName) return out
    const t = (rt.targets || []).find(x => x.getName() === o.targetName)
    if (t) {
      const tv = varSummary(t)
      out.target = { name: t.getName(), isClone: !t.isOriginal, x: t.x, y: t.y, size: t.size, visible: t.visible, localVars: tv.scalars }
      out.x = t.x
      out.y = t.y
    }
    return out
  }

  /** 文档标题去掉站名后缀（TurboWarp / TurboWarp Desktop 两种都兜） */
  function docTitle() {
    try { return document.title.replace(/ - TurboWarp.*$/, '') } catch { return null }
  }

  /** base64 → Uint8Array。分块解，别对几 MB 的字符串用展开运算符 */
  function base64ToBytes(b64) {
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }

  /** Uint8Array → base64。String.fromCharCode.apply 的参数个数有上限，必须分块 */
  function bytesToBase64(bytes) {
    let bin = ''
    const CHUNK = 0x8000
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
    }
    return btoa(bin)
  }

  // ---------------- sb3 序列化形态 → scratch-vm 活块形态 ----------------
  //
  // 为什么必须自己转：shareBlocksToTarget 收的是「活块形态」**数组**。
  // 名字很像会做转换的 deserializeStandaloneBlocks 其实只深拷贝 + 拆 extensionURLs 包装
  // （TurboWarp/scratch-vm develop src/serialization/sb3.js:383），不做格式转换；
  // 而 newBlockIds 的入参声明就是 array（src/util/new-block-ids.js 的 JSDoc）。
  //
  // 直接把 sb3 形态喂进去的后果（npm 5.0.300 与 TurboWarp spork 两代 VM 实测一致）：
  //   · blockToXML 只认 input.block / input.shadow → 数组型 input 被整段跳过 → GUI 里输入空白
  //   · serializeInputs 判 input.block === input.shadow（都是 undefined）→ 值序列化成 null → 快照丢值
  //   · execute.js 的 if (input.block) 取不到参数 → 积木跑起来毫无效果
  //   · deleteBlock 的 input.block !== null 恒真 → 嵌套子块删不掉，变成孤儿
  //
  // 转换规则照抄 scratch-vm/src/serialization/sb3.js 的
  // deserializeBlocks / deserializeInputs / deserializeInputDesc（十年未变的格式）。
  // 关键点：inline 字面量会被展开成**独立的 primitive 影子块**，所以注入后的块数
  // 一定多于 AI 给的块数 —— idMap 不能按「第 i 个新块对应第 i 个旧块」来算。

  // 类型码 → [opcode, field 名]（sb3.js:63-81 的常量表）
  const PRIMITIVE_BY_CODE = {
    4: ['math_number', 'NUM'],
    5: ['math_positive_number', 'NUM'],
    6: ['math_whole_number', 'NUM'],
    7: ['math_integer', 'NUM'],
    8: ['math_angle', 'NUM'],
    9: ['colour_picker', 'COLOUR'],
    10: ['text', 'TEXT'],
    11: ['event_broadcast_menu', 'BROADCAST_OPTION'],
    12: ['data_variable', 'VARIABLE'],
    13: ['data_listcontents', 'LIST']
  }
  const VAR_TYPE_BY_FIELD = { BROADCAST_OPTION: 'broadcast_msg', VARIABLE: '', LIST: 'list' }

  let primSeq = 0
  const mintPrimitiveId = () => `dshp${(++primSeq).toString(36)}-${Math.random().toString(36).slice(2, 8)}`

  /**
   * 把 sb3 形态的 blocks dict 转成 shareBlocksToTarget 要的活块数组。
   * @param {object} dict  sb3 blocks dict
   * @param {object} [positions]  旧 id → {x, y}：顶层块该放哪（不传就用 dict 里的 x/y，再不行顺序下排）
   * @returns {{blocks: Array, index: Object, warnings: string[]}}
   *   index: AI 给的块 id → 它在 blocks 数组里的下标（用于反推注入后的新 id）
   */
  function toLiveBlocks(dict, positions) {
    const out = []
    const index = Object.create(null)
    const warnings = []
    const known = new Set(Object.keys(dict))
    const push = (b) => { out.push(b); return out.length - 1 }

    // 一个 input 描述：[遮挡标志, 值] / [遮挡标志, 块id] / [遮挡标志, 块id, 影子描述]
    const deserializeInputDesc = (desc, parentId, isShadow) => {
      if (!Array.isArray(desc)) return desc // 已经是块 id
      const code = desc[0]
      const spec = PRIMITIVE_BY_CODE[code]
      if (!spec) throw new Error(`不认识的输入字面量类型码 ${JSON.stringify(code)}（合法 4-13；见 sb3-json-reference.md 的表）`)
      const [opcode, fieldName] = spec
      const id = mintPrimitiveId()
      const field = { name: fieldName, value: desc[1] }
      if (VAR_TYPE_BY_FIELD[fieldName] !== undefined) {
        // 广播/变量/列表的 primitive 带 id 和 variableType（sb3.js:693-737）
        field.id = desc[2]
        field.variableType = VAR_TYPE_BY_FIELD[fieldName]
      }
      push({
        id, opcode, next: null, parent: parentId, shadow: !!isShadow,
        inputs: {}, fields: { [fieldName]: field }, topLevel: false
      })
      return id
    }

    const deserializeInputs = (raw, parentId) => {
      const o = {}
      for (const name of Object.keys(raw || {})) {
        const v = raw[name]
        if (!Array.isArray(v)) { o[name] = v; continue } // 已是活块形态，原样带过
        let block = null
        let shadow = null
        if (v[0] === 1) {
          // 块和影子是同一个：只给了值
          block = shadow = deserializeInputDesc(v[1], parentId, true)
        } else if (v[0] === 2) {
          // 只有块、没有影子（布尔 / C 块子栈）
          block = deserializeInputDesc(v[1], parentId, false)
        } else if (v[0] === 3) {
          // 块和影子不同：值和默认值都给了
          block = deserializeInputDesc(v[1], parentId, false)
          shadow = deserializeInputDesc(v[2], parentId, true)
        } else {
          throw new Error(`输入 ${name} 的遮挡标志 ${JSON.stringify(v[0])} 非法（合法 1/2/3）`)
        }
        o[name] = { name, block, shadow }
      }
      return o
    }

    const deserializeFields = (raw) => {
      const o = {}
      for (const name of Object.keys(raw || {})) {
        const v = raw[name]
        if (!Array.isArray(v)) { o[name] = v; continue }
        const field = { name, value: v[0] }
        if (v.length > 1) field.id = v[1]
        if (VAR_TYPE_BY_FIELD[name] !== undefined) field.variableType = VAR_TYPE_BY_FIELD[name]
        o[name] = field
      }
      return o
    }

    let topLevelSeen = 0
    for (const oldId of Object.keys(dict)) {
      const src = dict[oldId]
      if (Array.isArray(src)) {
        // 顶层裸字面量（reporter 被单独拖出来）
        deserializeInputDesc(src, null, false)
        continue
      }
      if (!src || typeof src !== 'object') {
        warnings.push(`忽略了非对象条目 ${oldId}`)
        continue
      }
      if (typeof src.opcode !== 'string' || !src.opcode) {
        throw new Error(`块 ${oldId} 缺 opcode`)
      }
      const next = src.next && known.has(src.next) ? src.next : null
      if (src.next && !next) warnings.push(`块 ${oldId} 的 next 指向不存在的 ${src.next}，已置空`)
      const parent = src.parent && known.has(src.parent) ? src.parent : null
      if (src.parent && !parent) warnings.push(`块 ${oldId} 的 parent 指向不存在的 ${src.parent}，已置空`)
      const blk = {
        id: oldId, opcode: src.opcode, next, parent,
        shadow: !!src.shadow, topLevel: !!src.topLevel,
        inputs: {}, fields: {}
      }
      if (src.mutation) blk.mutation = src.mutation
      if (src.comment) blk.comment = src.comment
      if (blk.topLevel) {
        // 坐标优先级：调用方排好的位置 > dict 里的 x/y > 顺序往下排（G4：别再叠成一堆）
        const planned = positions && positions[oldId]
        const hasXY = planned || (Number.isFinite(src.x) && Number.isFinite(src.y))
        blk.x = planned ? planned.x : (hasXY ? src.x : 48)
        blk.y = planned ? planned.y : (hasXY ? src.y : 48 + topLevelSeen * 150)
        if (!hasXY) topLevelSeen++
      }
      index[oldId] = push(blk) // 先占下标，再转换（转换会把影子块追加在这个块后面）
      blk.inputs = deserializeInputs(src.inputs, oldId)
      blk.fields = deserializeFields(src.fields)
    }
    return { blocks: out, index, warnings }
  }

  // ---------------- 背包用：子树导出 / 变量引用落地 ----------------
  // 导出**不经过 vm.toJSON()**：TurboWarp 桌面版的 toJSON 会把 block id 压缩成 a/b/c
  // （真机实测：我手里的真 id 在输出里根本不存在，报"一个都没找到"）。
  // 所以自己把 live 块转成 sb3 dict —— 只用 sb3 的两条编码：
  //   ① 内联字面量：[4,"10"] 这种（10 个 math/text/colour 类型）+ 变量/列表/广播带 id
  //   ② 输入压缩：[1, 值] / [2, 块] / [3, 块, 默认值]
  // 正确性由 lab/test-content-ops.js 的 v0.8.0 节对拍守着（跟**官方序列化器的输出**逐块比）。

  const CODE_BY_PRIMITIVE_OPCODE = Object.fromEntries(
    Object.entries(PRIMITIVE_BY_CODE).map(([code, [opcode]]) => [opcode, Number(code)])
  )

  /** live 影子块 → 内联字面量描述；不是那 10 种就返回 null（菜单影子要当普通块引用） */
  function primitiveDesc(id, all) {
    const s = all[id]
    if (!s || !s.shadow) return null
    const code = CODE_BY_PRIMITIVE_OPCODE[s.opcode]
    if (code === undefined) return null
    const fname = PRIMITIVE_BY_CODE[code][1]
    const f = s.fields && s.fields[fname]
    if (!f) return null
    // 广播/变量/列表字面量必须带 id（[code, name, id]），否则注回去就丢了指向
    return code >= 11 ? [code, f.value, f.id] : [code, f.value]
  }

  /** live input（{name, block, shadow}）→ sb3 输入描述数组 */
  function inputToSb3(inp, all) {
    if (!inp || typeof inp !== 'object') return null
    const block = inp.block
    const shadow = inp.shadow
    // 顺序和官方 serializeInputs 一致（block===shadow → 1；shadow 就是 null → 2；其余 → 3），
    // 否则跟官方输出对不上：shareBlocksToTarget 建出来的语句输入 shadow 是 **undefined**
    // 而不是 null，官方会把它当"有影子"写成 [3, block, null]。
    const done = (id) => (id === undefined || id === null ? id : (primitiveDesc(id, all) || id))
    if (block === shadow) return [1, done(block)]
    if (shadow === null) return [2, done(block)]
    const s = done(shadow)
    return [3, done(block), s === undefined ? null : s]
  }

  function liveBlockToSb3(b, all) {
    const o = {
      opcode: b.opcode,
      next: b.next || null,
      parent: b.parent || null,
      inputs: {},
      fields: {},
      shadow: !!b.shadow,
      topLevel: !!b.topLevel
    }
    if (b.topLevel) {
      o.x = Number.isFinite(b.x) ? b.x : 0
      o.y = Number.isFinite(b.y) ? b.y : 0
    }
    if (b.mutation) o.mutation = JSON.parse(JSON.stringify(b.mutation))
    for (const [name, f] of Object.entries(b.fields || {})) {
      if (!f) continue
      // 变量/列表/广播的 field 带 id（[值, id]），其余只有一个值
      o.fields[name] = f.id ? [f.value, f.id] : [f.value]
    }
    for (const [name, inp] of Object.entries(b.inputs || {})) {
      const d = inputToSb3(inp, all)
      if (d) o.inputs[name] = d
    }
    return o
  }

  /**
   * 把这个角色的若干脚本子树导成 sb3 dict（含 next 链、嵌套块、影子块、mutation）。
   * @returns {{blocks: Object, warnings: string[]}}
   */
  function exportSubtreeLive(t, rootIds) {
    const all = t.blocks._blocks
    const out = {}
    const warnings = []
    const seen = new Set()
    // 队列而不是栈：导出顺序跟着 roots 给（脚本清单第一条就是第一个根），人读着顺
    const queue = []
    for (const id of rootIds) {
      if (!all[id]) { warnings.push(`块 ${id} 不在这角色里（已被删？或是克隆体里的块）`); continue }
      queue.push(id)
    }
    let head = 0
    while (head < queue.length) {
      const id = queue[head++]
      if (!id || seen.has(id)) continue
      const b = all[id]
      if (!b) continue
      seen.add(id)
      out[id] = liveBlockToSb3(b, all)
      if (b.next) queue.push(b.next)
      for (const inp of Object.values(b.inputs || {})) {
        // 内联字面量（[4,"10"] 这种）会被压进父块的 input 里，**不能**再单独占一个 dict 位置
        // —— 官方序列化器也是这么做的（compressInputTree 会把它们删掉）。
        // 菜单影子（looks_costume / sound_sounds_menu 这类）不是 primitive，必须留着当块引用。
        for (const id of [inp && inp.block, inp && inp.shadow]) {
          if (id && !primitiveDesc(id, all)) queue.push(id)
        }
      }
    }
    return { blocks: out, warnings }
  }

  const REF_KIND_BY_CODE = { 11: 'broadcast', 12: 'variable', 13: 'list' }
  const VAR_TYPE_BY_KIND = { variable: '', list: 'list', broadcast: 'broadcast_msg' }
  const KIND_BY_VAR_TYPE = { '': 'variable', list: 'list', broadcast_msg: 'broadcast' }
  const REFS_KEY = { variable: 'variables', list: 'lists', broadcast: 'broadcasts' }

  /** 遍历块（含影子、含内联字面量），把每个变量/列表/广播引用交给 fn */
  function eachRef(blocks, fn) {
    const fieldKind = (fname) => fname === 'VARIABLE' ? 'variable' : fname === 'LIST' ? 'list' : fname === 'BROADCAST_OPTION' ? 'broadcast' : null
    for (const b of Object.values(blocks || {})) {
      if (Array.isArray(b)) {
        const kind = REF_KIND_BY_CODE[b[0]]
        if (kind) fn(kind, b, 1, 2) // [code, name, id]
        continue
      }
      if (!b || typeof b !== 'object') continue
      for (const [fname, v] of Object.entries(b.fields || {})) {
        const kind = fieldKind(fname)
        if (kind && Array.isArray(v)) fn(kind, v, 0, 1) // [name, id]
      }
      for (const desc of Object.values(b.inputs || {})) {
        if (!Array.isArray(desc)) continue
        for (let i = 1; i < desc.length; i++) {
          const v = desc[i]
          if (Array.isArray(v) && REF_KIND_BY_CODE[v[0]]) fn(REF_KIND_BY_CODE[v[0]], v, 1, 2)
        }
      }
    }
  }

  /** 子树引用了哪些变量/列表/广播，各自的值是多少（背包要带着值走，字模列表就是命） */
  function collectRefs(blocks, t, stage, opts) {
    const out = { variables: [], lists: [], broadcasts: [] }
    const listCap = Math.max(0, Number(opts && opts.listLimit) || 1000)
    const seen = new Set()
    // 在**活变量**里查（不再读 sb3）：id 命中就用它，否则按名字 + 类型找
    // 同时记下"它在谁身上"—— 舞台上的是全局，角色上的是局部。背包要能原样搬回去：
    // 字库那种 5MB 的表是**全局**的，一个角色一份的话第二个角色就再也接不上了。
    const lookup = (kind, name, id) => {
      for (const owner of [t, stage]) {
        if (!owner) continue
        const vars = owner.variables || {}
        if (id && vars[id] && (KIND_BY_VAR_TYPE[vars[id].type] || 'variable') === kind) return { v: vars[id], owner }
        for (const v of Object.values(vars)) {
          if (!v || v.name !== name) continue
          if ((KIND_BY_VAR_TYPE[v.type] || 'variable') === kind) return { v, owner }
        }
      }
      return null
    }
    eachRef(blocks, (kind, arr, nameIdx, idIdx) => {
      const name = arr[nameIdx]
      if (!name) return
      const key = kind + '|' + name
      if (seen.has(key)) return
      seen.add(key)
      const found = lookup(kind, name, arr[idIdx])
      const v = found && found.v
      const item = { name }
      if (kind !== 'broadcast') item.scope = found && found.owner && found.owner.isStage ? 'global' : 'local'
      if (kind === 'broadcast') {
        // 广播只有名字，没有值
      } else if (kind === 'list') {
        const full = Array.isArray(v && v.value) ? v.value : []
        // 列表封顶：字模这类列表只有几十项，但脚本也可能引用 5000 项的巨型列表 ——
        // 整份搬进背包就是把 7MB 又搬一次。超了截断 + 明确标出来。
        if (full.length > listCap) {
          item.value = full.slice(0, listCap)
          item.truncated = true
          item.length = full.length
        } else {
          item.value = full
        }
      } else {
        item.value = v && v.value !== undefined ? v.value : ''
      }
      out[REFS_KEY[kind]].push(item)
    })
    return out
  }

  /**
   * 把块里的变量引用「落地」到目标角色：
   *   ① id 在目标/舞台里有效 → 不动
   *   ② id 无效但同名的存在 → 改指向那个 id（跨角色/跨项目搬脚本时最常见）
   *   ③ 都没有 → 就地新建（标量 ''、列表 []；带 value 的用 value）
   * 为什么必须做：官方 GUI 对不存在的变量 id 显示「变量未找到」，积木跑起来是空值 ——
   * 这是 AI 手写 blocks、或把背包里的片段注进别的角色时**必然**踩的坑。
   * @returns {{created: Array, remapped: Array, kept: number}}
   */
  function resolveRefs(vm, t, blocks, declared) {
    const stage = vm.runtime.getTargetForStage()
    const created = []
    const remapped = []
    let kept = 0
    const cache = new Map() // kind|name -> id（同一次注入里别重复建）

    const owners = () => [t, stage].filter(Boolean)
    const byId = (kind, id) => {
      if (!id) return null
      for (const owner of owners()) {
        const v = owner.variables && owner.variables[id]
        if (v && (KIND_BY_VAR_TYPE[v.type] || 'variable') === kind) return { owner, id, v }
      }
      return null
    }
    const byName = (kind, name) => {
      for (const owner of owners()) {
        for (const [id, v] of Object.entries(owner.variables || {})) {
          if (v && v.name === name && (KIND_BY_VAR_TYPE[v.type] || 'variable') === kind) return { owner, id, v }
        }
      }
      return null
    }
    const declaredValue = (kind, name) => {
      if (!Array.isArray(declared)) return undefined
      for (const d of declared) {
        if (!d || typeof d !== 'object') continue
        if (d.name !== name) continue
        const dk = d.type === 'list' ? 'list' : d.type === 'broadcast' ? 'broadcast' : 'variable'
        if (dk === kind) return d.value
      }
      return undefined
    }
    // 片段可以要求"这个变量/列表挂舞台上"（scope:'global'）：字库那种几 MB 的表必须全局，
    // 否则注进第二个角色时又是一份副本，两边内容还会各自漂移。
    const declaredScope = (kind, name) => {
      if (!Array.isArray(declared)) return undefined
      for (const d of declared) {
        if (!d || typeof d !== 'object' || d.name !== name) continue
        const dk = d.type === 'list' ? 'list' : d.type === 'broadcast' ? 'broadcast' : 'variable'
        if (dk === kind && (d.scope === 'global' || d.scope === 'local')) return d.scope
      }
      return undefined
    }
    const create = (kind, name) => {
      // 广播挂在舞台上（收报积木按 id 查舞台）；标量/列表默认挂当前目标（跟原角色一致），
      // 声明了 scope:'global' 的挂舞台。
      const scope = declaredScope(kind, name)
      const owner = kind === 'broadcast' || scope === 'global' ? stage : t
      if (!owner) return null
      const id = `dshv-${Math.random().toString(36).slice(2, 10)}`
      try {
        owner.createVariable(id, name, VAR_TYPE_BY_KIND[kind])
      } catch (e) {
        return null
      }
      const v = owner.variables && owner.variables[id]
      if (!v) return null
      const val = declaredValue(kind, name)
      if (kind === 'variable') v.value = val === undefined ? '' : val
      else if (kind === 'list') v.value = Array.isArray(val) ? val.slice() : []
      created.push({ kind, name, id, on: kind === 'broadcast' ? 'stage' : (owner.isStage ? 'stage' : 'target'), valueProvided: val !== undefined })
      return { owner, id, v }
    }
    const resolveOne = (kind, name, id) => {
      if (!name) return null
      const hit = byId(kind, id)
      if (hit) { kept++; return null } // ① 不动
      const key = kind + '|' + name
      if (cache.has(key)) return cache.get(key)
      const same = byName(kind, name)
      if (same) {
        remapped.push({ kind, name, from: id || '(空)', to: same.id })
        cache.set(key, same.id)
        return same.id
      }
      const made = create(kind, name)
      if (!made) return null
      cache.set(key, made.id)
      return made.id
    }

    eachRef(blocks, (kind, arr, nameIdx, idIdx) => {
      const nid = resolveOne(kind, arr[nameIdx], arr[idIdx])
      if (nid && nid !== arr[idIdx]) arr[idIdx] = nid
    })
    return { created, remapped, kept }
  }

  // ==================== M3：精细编辑（断链/接链、变量/列表、造型）====================
  // 这三个 op 改的是**已有结构**，不是往里加东西。两条共同要求：
  //   1) 指针必须自己收拾干净 —— 官方 Blocks.moveBlock 只负责"挂到新位置"，
  //      不 heal 原来的 next 链、也不清 inputs 里的旧指针（Blockly 那边靠多条事件补）。
  //      直接借它的后果是**重复挂载 + 孤儿块**，跑起来还会双执行。
  //   2) 改完必须让 GUI 跟着变：safeEmitWorkspaceUpdate(vm) 让编辑器按 vm 的 XML 重建工作区。
  //      这也是 TurboWarp 自己的做法（`vm.emitWorkspaceUpdate` 会把 xml 推给 GUI）。

  /** 某个块挂在父块的哪儿：{parent, input} 表示输入，{parent, input:null} 表示 next 链；顶层返回 null */
  function blockSlot(blocks, parentId, childId) {
    const p = blocks.getBlock(parentId)
    if (!p) return null
    for (const [name, inp] of Object.entries(p.inputs || {})) {
      if (inp.block === childId) return { parent: parentId, input: name }
    }
    if (p.next === childId) return { parent: parentId, input: null }
    return null
  }

  /** 块自己 + 全部子孙（inputs 的实块/影子块 + next 链）。防环用 */
  function subtreeIds(blocks, rootId) {
    const seen = new Set()
    const walk = (bid) => {
      const b = blocks.getBlock(bid)
      if (!b || seen.has(bid)) return
      seen.add(bid)
      for (const inp of Object.values(b.inputs || {})) {
        if (inp.block) walk(inp.block)
        if (inp.shadow && inp.shadow !== inp.block) walk(inp.shadow)
      }
      if (b.next) walk(b.next)
    }
    walk(rootId)
    return seen
  }

  /**
   * 把块从当前位置摘下来，并**顺手把断口补上**：
   *   - 在 next 链中间 → 前后两段接起来（Blockly 拖走中间块时就是这个效果）
   *   - 挂在输入上 → 输入退回影子块（默认值还在，不是空槽）
   * @returns {null|{from: object|string}} 顶层块返回 null（顺手从 _scripts 摘掉）
   */
  function unlinkBlock(blocks, id) {
    const b = blocks.getBlock(id)
    if (!b) return null
    if (!b.parent) {
      blocks._deleteScript(id) // 本来就是顶层脚本：出链准备挂到别处
      return null
    }
    const slot = blockSlot(blocks, b.parent, id)
    const p = blocks.getBlock(b.parent)
    if (!slot || !p) {
      // parent 指针不可信（历史损坏的项目里有）—— 只把自己标成顶层，别动别人
      b.parent = null
      return { from: 'stale' }
    }
    if (slot.input) {
      const inp = p.inputs[slot.input]
      inp.block = inp.shadow && inp.shadow !== id ? inp.shadow : null
    } else {
      p.next = b.next || null
      if (b.next) {
        const n = blocks.getBlock(b.next)
        if (n) n.parent = p.id
      }
      b.next = null
    }
    b.parent = null
    return { from: slot }
  }

  /**
   * 接到 parentId 的后面（next 槽）。槽里已经有块时**不挤掉**，插在中间：
   *   parent → id（+ 自己那段） → 原来的 next → …
   * 官方 moveBlock 会直接把 parent.next 改成 id，让原来的 next 变孤儿（父指针还指着
   * parent，于是这块既不在链上、又不在 _scripts 里 —— 既不显示也不执行），所以这里自己拼。
   */
  function attachAfter(blocks, id, parentId) {
    const b = blocks.getBlock(id)
    const p = blocks.getBlock(parentId)
    if (!b || !p) throw new Error(`接链失败：找不到块 ${!b ? id : parentId}`)
    const oldNext = p.next && p.next !== id ? p.next : null
    p.next = id
    b.parent = parentId
    if (oldNext) {
      // 找 b 这条链的尾巴（刚摘下来的块可能自己就带着一段），把后面那段接回去
      let tail = b
      const guard = new Set([id])
      while (tail.next && !guard.has(tail.next)) {
        const n = blocks.getBlock(tail.next)
        if (!n) break
        guard.add(n.id)
        tail = n
      }
      tail.next = oldNext
      const on = blocks.getBlock(oldNext)
      if (on) on.parent = tail.id
    }
    blocks._deleteScript(id)
  }

  /**
   * 补建输入槽（F2）。真机踩过：move_block 把 repeat_until 的 CONDITION 里的块拔走后，
   * 这个空槽在 sb3 序列化里会整条消失，再想接回去时 update_block / move_block 都报
   * 「块 a% 没有输入 CONDITION（现有: SUBSTACK）」—— 于是这个 repeat_until 永久变成
   * "没有条件"的死块，只能删掉重建。这里按**该 opcode 的合法输入名**当场补一个空槽。
   */
  function ensureInputSlot(vm, blocks, parentId, inputName) {
    const p = blocks.getBlock(parentId)
    if (!p) return null
    if (p.inputs && p.inputs[inputName]) return p.inputs[inputName]
    const spec = opcodeSpec(vm, p.opcode)
    if (!spec || !spec.inputs.includes(inputName)) return null
    p.inputs[inputName] = { name: inputName, block: null, shadow: null }
    return p.inputs[inputName]
  }

  /** 同 opcode 的别的块上，这个输入用的什么影子块 → 拿来做模板（补空槽时别用错类型） */
  function siblingShadowTemplate(vm, opcode, inputName) {
    for (const target of (vm.runtime.targets || [])) {
      const all = target.blocks._blocks
      for (const b of Object.values(all)) {
        if (!b || b.opcode !== opcode || !b.inputs) continue
        const inp = b.inputs[inputName]
        if (!inp) continue
        const sid = inp.shadow || (inp.block && all[inp.block] && all[inp.block].shadow ? inp.block : null)
        const s = sid ? all[sid] : null
        if (s && s.shadow) return { opcode: s.opcode, fields: JSON.parse(JSON.stringify(s.fields || {})) }
      }
    }
    return null
  }

  /** 造一个影子块（补空槽时连默认值一起补；没有模板就用空文本，视觉上无害） */
  function makeShadowBlock(blocks, parentId, tpl) {
    const id = `dshs${(++primSeq).toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const fields = tpl ? tpl.fields : { TEXT: { name: 'TEXT', value: '' } }
    blocks._blocks[id] = {
      id, opcode: tpl ? tpl.opcode : 'text', next: null, parent: parentId,
      shadow: true, topLevel: false, inputs: {}, fields
    }
    return id
  }

  /** 把块塞进 parentId 的某个输入槽。原来挂着的块（不是影子）退回顶层，不删 */
  function attachInput(vm, blocks, id, parentId, inputName, opts) {
    const p = blocks.getBlock(parentId)
    const b = blocks.getBlock(id)
    if (!p || !b) throw new Error(`接链失败：找不到块 ${!p ? parentId : id}`)
    let input = p.inputs && p.inputs[inputName]
    if (!input) {
      if (opts && opts.createIfMissing) input = ensureInputSlot(vm, blocks, parentId, inputName)
      if (!input) {
        throw new Error(`块 ${parentId} 没有输入 "${inputName}"（现有: ${Object.keys(p.inputs || {}).join(', ') || '无'}）`
          + '。要补建只有"这个 opcode 的合法输入名"才行（用 scratch_get_opcodes({ opcode }) 查）')
      }
    }
    const displaced = input.block && input.block !== input.shadow && input.block !== id ? input.block : null
    if (displaced) {
      const d = blocks.getBlock(displaced)
      if (d) {
        d.parent = null
        blocks._addScript(displaced)
        d.topLevel = true
      }
    }
    const shadow = input.shadow && input.shadow !== id ? input.shadow : null
    p.inputs[inputName] = { name: inputName, block: id, shadow }
    b.parent = parentId
    blocks._deleteScript(id)
    return { displaced }
  }

  /** 断链/接链主体。返回一份"从哪来、到哪去、挤掉了谁"的报告 */
  async function moveBlockIn(vm, t, spec) {
    const blocks = t.blocks
    const id = String(spec.id || '')
    const mode = String(spec.mode || 'after')
    const to = spec.to ? String(spec.to) : ''
    const b = blocks.getBlock(id)
    if (!b) throw new Error(`找不到块 ${id}`)
    if (to && !blocks.getBlock(to)) throw new Error(`找不到目标块 ${to}`)
    if (to === id) throw new Error('不能把块接到它自己身上')
    if (to && subtreeIds(blocks, id).has(to)) {
      throw new Error(`不能把 ${id} 接到它自己的子孙块 ${to} 上（会成环，工作区直接崩）`)
    }

    const report = { blockId: id, opcode: b.opcode, mode, from: null, to: null, displaced: null }

    if (mode === 'detach') {
      const r = unlinkBlock(blocks, id)
      report.from = r ? r.from : 'already-top-level'
      blocks._addScript(id)
      blocks.getBlock(id).topLevel = true
    } else if (mode === 'after' || mode === 'before') {
      if (!to) throw new Error('after/before 需要 toBlockId')
      const dest = blocks.getBlock(to)
      report.from = (unlinkBlock(blocks, id) || {}).from || null
      if (mode === 'before') {
        if (!dest.parent) throw new Error(`块 ${to} 是顶层脚本，没有"前面"可插 —— 用 after，或先 detach`)
        const slot = blockSlot(blocks, dest.parent, to)
        if (!slot) throw new Error(`块 ${to} 的父指针不对（parent=${dest.parent}），先 scratch_rollback 或手工修`)
        const parentId = dest.parent
        const wasInput = slot.input
        unlinkBlock(blocks, to) // 腾出槽位（它后面的链跟着它走）
        if (wasInput) attachInput(vm, blocks, id, parentId, wasInput, { createIfMissing: true })
        else attachAfter(blocks, id, parentId)
        attachAfter(blocks, to, id)
        report.to = { parent: parentId, input: wasInput || null, before: to }
      } else {
        attachAfter(blocks, id, to)
        report.to = { parent: to, input: null }
      }
    } else if (mode === 'input') {
      if (!to) throw new Error('input 模式需要 toBlockId')
      if (!spec.input) throw new Error('input 模式需要 inputName（如 CONDITION / SUBSTACK / OPERAND1）')
      report.from = (unlinkBlock(blocks, id) || {}).from || null
      const r = attachInput(vm, blocks, id, to, spec.input, { createIfMissing: true })
      report.displaced = r.displaced
      report.to = { parent: to, input: spec.input }
    } else {
      throw new Error(`未知 mode "${mode}"（detach / after / before / input）`)
    }

    blocks.resetCache()
    blocks.emitProjectChanged()
    safeEmitWorkspaceUpdate(vm)
    // 移动/接链后亮一下 + 把视口带过去（F1：用户看着窗口，得能看见这块被挪到哪儿了）
    report.glowed = glowBlocks(vm, [id, to].filter(Boolean)) || undefined
    if (spec.follow !== false) report.followed = (await followBlock(vm, t, id)) || undefined
    return report
  }

  const VAR_TYPE_BY_KIND2 = { variable: '', list: 'list', broadcast: 'broadcast_msg' }

  /** 找变量：先按 id、再按名字；scope=local 只看角色、global 只看舞台、缺省先角色再舞台 */
  function findVariable(vm, t, spec) {
    const kind = spec.kind === 'list' ? 'list' : 'variable'
    const type = VAR_TYPE_BY_KIND2[kind]
    const stage = vm.runtime.getTargetForStage()
    const owners = []
    if (spec.scope === 'local') owners.push(t)
    else if (spec.scope === 'global') owners.push(stage)
    else owners.push(t, stage)
    for (const owner of owners) {
      if (!owner || !owner.variables) continue
      if (spec.id && owner.variables[spec.id]) return { owner, variable: owner.variables[spec.id], kind, type }
    }
    if (spec.name) {
      for (const owner of owners) {
        if (!owner || !owner.variables) continue
        for (const v of Object.values(owner.variables)) {
          if (v && v.name === spec.name && (v.type || '') === type) return { owner, variable: v, kind, type }
        }
      }
    }
    return null
  }

  /** 哪些积木在引用这个变量（全角色扫，删/改名前必须知道） */
  function variableRefs(vm, varId, kind) {
    const fieldName = kind === 'list' ? 'LIST' : 'VARIABLE'
    const hits = []
    for (const target of vm.runtime.targets || []) {
      const all = (target.blocks && target.blocks._blocks) || {}
      for (const [bid, b] of Object.entries(all)) {
        const f = b && b.fields && b.fields[fieldName]
        if (f && f.id === varId) hits.push({ target: target.getName(), blockId: bid, opcode: b.opcode })
      }
    }
    return hits
  }

  /** 造型下标：name 优先，其次 index（1 起，跟编辑器里看到的一致），都没有 = 当前造型 */
  function costumeIndexOf(t, spec) {
    const list = t.getCostumes()
    if (spec.name) {
      const i = list.findIndex(c => c.name === spec.name)
      if (i < 0) throw new Error(`角色「${t.getName()}」没有造型「${spec.name}」，现有: ${list.map(c => c.name).join(', ')}`)
      return i
    }
    if (spec.index !== undefined && spec.index !== null && spec.index !== '') {
      const n = Number(spec.index)
      if (!Number.isFinite(n) || n < 1 || n > list.length) {
        throw new Error(`造型序号 ${spec.index} 越界（1..${list.length}）`)
      }
      return Math.floor(n) - 1
    }
    return t.currentCostume
  }

  async function ops(op, args) {
    const vm = getVM()
    switch (op) {
      case 'project_meta': {
        const pj = snapshotJson(vm)
        const total = pj.targets.reduce((n, t) => n + countBlocksOf(t.blocks).real, 0)
        return {
          title: document.title.replace(/ - TurboWarp.*$/, ''),
          extensions: pj.extensions,
          // AI 写积木时要知道"现在光标在哪个角色上"（read_script 缺省也用它）
          editingTarget: vm.editingTarget ? vm.editingTarget.getName() : null,
          // 口径（B2）：targets[].blockCount 是**文件里的真块数**（不含影子）；
          // read_script / list_scripts 报的是**展开视图**（inline 字面量被物化成影子块）。
          blockCount: total,
          blockCountView: 'raw',
          targets: pj.targets.map(t => {
            const c = countBlocksOf(t.blocks)
            return {
              name: t.name, isStage: t.isStage,
              blockCount: c.real, blockCountWithShadows: c.withShadow,
              variables: Object.keys(t.variables || {}),
              costumes: (t.costumes || []).map(c2 => c2.name)
            }
          })
        }
      }
      case 'snapshot': {
        // A2：以前不管多大都整份回（25MB 工程 → 1.8MB JSON），到工具层被**静默**截断，
        // ok:true 依旧成立、数据其实没进来。现在自己先量：超预算就明确说「截断了」+ 给续读路，
        // 而不是让调用方去 spill 文件里 grep。
        const a = args || {}
        const budget = Math.min(Math.max(Number(a.maxBytes) || 240000, 20000), 4000000)
        const full = snapshotJson(vm)
        const only = a.target ? full.targets.filter(t => t.name === a.target || t.isStage) : full.targets
        const pj = { targets: only }
        if (full.extensions) pj.extensions = full.extensions
        for (const k of Object.keys(full)) {
          if (k !== 'targets' && k !== 'extensions') pj[k] = full[k]
        }
        let bytes = 0
        try { bytes = JSON.stringify(pj).length } catch { bytes = 0 }
        if (bytes <= budget) return pj
        // 超了：按 target 切一份"索引"，明确告诉调用方怎么接着拿
        return {
          truncated: true,
          bytes,
          maxBytes: budget,
          targets: only.map(t => ({
            name: t.name,
            isStage: !!t.isStage,
            blockCount: countBlocksOf(t.blocks).real,
            blockCountWithShadows: countBlocksOf(t.blocks).withShadow,
            variables: Object.keys(t.variables || {}).length,
            lists: Object.keys(t.lists || {}).length,
            costumes: (t.costumes || []).length,
            sounds: (t.sounds || []).length
          })),
          howToContinue: 'snapshot 太大（整份 ' + Math.round(bytes / 1024) + 'KB > ' + Math.round(budget / 1024) + 'KB）。'
            + '① 加 target:"角色名" 只拿一个角色，或 ② maxBytes:' + Math.max(budget * 4, 1000000) + ' 放宽（注意别把上下文撑爆），'
            + '③ 读代码优先用 scratch_read_script / scratch_project_overview（它们按块/字节分页，不会静默丢数据）。',
          hint: '别把这个 truncated 结果当完整项目用。'
        }
      }
      case 'read_script': {
        // 瘦身版（问题记录 P2-2 / §15.4）：以前无论要什么，都回「全部块 + 全部变量」，
        // 真机踩过 Stage 26 个块却回 7.5MB（全是 variables 里的长列表）、按钮 475KB。
        // 现在默认：只回块、不回变量、块数/字节双上限、可翻页。
        // 块数口径（B2）：这里的 blockCount 是**展开视图**（inline 字面量被物化成影子块），
        // 和 project.json 里的真块数不是一个数 —— 两个都报，别再让人对不上账。
        const t = findTarget(vm, args && args.target)
        const a = args || {}
        const blocks = t.blocks._blocks
        const allIds = Object.keys(blocks)
        const counts = blockCounts(blocks)
        const scripts = scriptIndex(vm, t).map(s => Object.assign(s, { label: scriptLabel(blocks, s) }))
        const meta = a.meta === false ? {} : {
          target: t.getName(),
          isClone: !t.isOriginal,
          blockCount: counts.total,
          blockCountRaw: counts.raw,
          shadowCount: counts.shadows || undefined,
          blockCountView: 'expanded',
          scriptCount: scripts.filter(s => s.kind === 'script').length,
          definitionCount: scripts.filter(s => s.kind === 'definition').length || undefined,
          looseCount: scripts.filter(s => s.kind === 'loose').length
        }

        // summary=true：只给"结构"，不给块体（找块 / 判断某 opcode 存不存在时用这个）
        if (a.summary === true) {
          const limit = Math.min(Math.max(Number(a.limit) || 200, 1), 2000)
          const vs = varSummary(t)
          return Object.assign(meta, {
            summary: true,
            opcodes: opcodeHistogram(blocks, allIds),
            scripts: scripts.slice(0, limit),
            scriptsTruncated: scripts.length > limit || undefined,
            // 变量名给（便宜、有用），值不给 —— 与默认路径一致，别让 summary 变成"变量消失"的错觉
            variablesOmitted: true,
            variableNames: Object.keys(vs.scalars),
            listNames: vs.listLengths,
            hint: '要看某段脚本的块体：scratch_read_script({ scriptId: <scripts[].blockId> })，或 opcodes: [...] 过滤'
          })
        }

        // 选块集合：起点块 > opcode 过滤 > 全部。
        // blockId（F3）：起点可以是**任意块**（不一定是顶层）—— 只回它这一棵；
        // 配合 branch:"SUBSTACK" 只看那个分支、depth:N 只看前 N 层，就不必整段读。
        const root = a.scriptId || a.blockId || a.topLevelBlockId
        const branchOnly = Array.isArray(a.branch) ? a.branch.filter(Boolean)
          : (typeof a.branch === 'string' && a.branch ? [a.branch] : null)
        const maxDepth = Number.isFinite(Number(a.depth)) && Number(a.depth) >= 0 ? Number(a.depth) : null
        let ids
        if (root) {
          if (!blocks[root]) {
            throw new Error(`找不到块 ${root}（角色 "${t.getName()}" 里没有这个 id；先用 summary:true / list_scripts 拿清单）`)
          }
          ids = collectIds2(blocks, root, { branchOnly, maxDepth })
        } else {
          ids = allIds
        }
        const opFilters = Array.isArray(a.opcodes) ? a.opcodes.filter(Boolean) : (a.opcodes ? [a.opcodes] : null)
        if (opFilters && opFilters.length) {
          const set = new Set(opFilters)
          ids = ids.filter(id => blocks[id] && set.has(blocks[id].opcode))
        }
        const offset = Math.min(Math.max(Number(a.offset) || 0, 0), ids.length)
        // 双上限：块数（缺省 1500）+ 字节（缺省 40KB）。以前只有块数，
        // 结果 354 块的脚本也回 100KB —— 到工具层就被静默截断了（A2），等于白读。
        const limit = Math.min(Math.max(Number(a.limit) || 1500, 1), 20000)
        const budget = Math.min(Math.max(Number(a.maxBytes) || 40000, 2000), 400000)
        const page = []
        let bytes = 0
        for (let i = offset; i < ids.length && page.length < limit; i++) {
          const b = blocks[ids[i]]
          if (!b) continue
          let len = 0
          try { len = JSON.stringify(b).length + 20 } catch { len = 200 }
          if (page.length && bytes + len > budget) break
          page.push(ids[i])
          bytes += len
        }
        const out = Object.assign(meta, {
          returned: page.length,
          filteredCount: ids.length,
          offset: offset || undefined,
          bytes: bytes || undefined,
          maxBytes: budget,
          hasMore: offset + page.length < ids.length || undefined,
          nextOffset: offset + page.length < ids.length ? offset + page.length : undefined,
          truncated: offset + page.length < ids.length || undefined,
          blocks: {}
        })
        for (const id of page) out.blocks[id] = blocks[id]
        if (root) {
          // 这块在哪、上面是谁（F3：插完想确认位置，不该整段读一遍）
          const chain = []
          let cur = blocks[root] && blocks[root].parent
          let guard = 0
          while (cur && blocks[cur] && guard++ < 12) {
            chain.push({ id: cur, opcode: blocks[cur].opcode })
            cur = blocks[cur].parent
          }
          const slot = (() => {
            const b = blocks[root]
            if (!b || !b.parent) return null
            const s = blockSlot(t.blocks, b.parent, root)
            return s ? (s.input || 'next') : null
          })()
          out.context = { root, opcode: blocks[root].opcode, slot, ancestors: chain.length ? chain : undefined }
        }
        // 变量默认不回（这是 7.5MB 的元凶）；要就显式 includeVariables: true
        if (a.includeVariables === true) {
          const vs = varSummary(t, { includeLists: a.includeLists === true, listLimit: a.listLimit })
          out.variables = t.variables
          out.variablesSummary = vs
        } else {
          const vs = varSummary(t)
          out.variableNames = Object.keys(vs.scalars)
          if (vs.listLengths) out.listNames = vs.listLengths
          out.variablesOmitted = true
        }
        if (!root && !opFilters && a.meta !== false) out.scripts = scripts.slice(0, Number(a.scriptLimit) || 60)
        if (out.hasMore) {
          out.hint = `只回了 ${page.length}/${ids.length} 块（约 ${bytes} 字节，上限 ${budget}；offset=${offset}）。`
            + `继续读传 offset:${offset + page.length}，或用 scriptId/blockId/opcodes/depth 收窄。`
        }
        return out
      }
      case 'add_blocks': {
        // 宿主 API 事实（npm scratch-vm 5.0.300 / TurboWarp spork 5.0.301 实测一致）：
        //   shareBlocksToTarget(blocks, targetId) 要求 blocks 是**数组**，元素是 scratch-vm
        //   的「活块形态」。两代 VM 都不吃 sb3 序列化形态，也都不吃 dict ——
        //   传 dict 会直接 `TypeError: copiedBlocks.map is not a function`（newBlockIds
        //   与后面的 .map 都按数组写）。所以这里一律：先自转活块形态 → 再传数组。
        const t = findTarget(vm, args && args.target)
        const input = args.blocks
        if (!input || typeof input !== 'object') throw new Error('blocks 必填（sb3 blocks dict）')
        if (Array.isArray(input)) throw new Error('blocks 要传 sb3 dict（{id: 块对象}），不是数组')

        // ① 形状校验（G3）：拼错的 input 名/字段名**默认直接拦下来**。
        //    这类错误不报错、不警告，只在运行时表现为"算式恒为 0" —— 必须提前拦。
        const shape = validatePayload(vm, input, { lenient: args.lenient === true })

        // ② 变量引用先落地（AI 手写的空 id、背包跨角色搬来的旧 id，都在这儿被接上或补建）
        const refs = resolveRefs(vm, t, input, args.variables)

        // ③ 布局（G4）：先算顶层块坐标，别让它们叠成一坨（用户想拖开时块黏手，容易连带丢块）
        const roots = Object.keys(input).filter(id => {
          const b = input[id]
          return b && !Array.isArray(b) && !b.shadow && !b.parent
        })
        const layoutMode = args.layout === 'given' ? 'given' : (args.layout === 'auto' ? 'auto' : 'smart')
        const lay = planLayout(input, roots, t.blocks._blocks, layoutMode)

        // ④ 上一轮注入仍游离的块：**只报告，永不自动删**（F0）
        const stale = staleInjected(t)
        const discard = args.discardStale === true ? discardStale(vm, t, stale) : null
        const staleLeft = args.discardStale === true ? staleInjected(t) : stale

        const { blocks: liveBlocks, index, warnings } = toLiveBlocks(input, lay.positions)
        if (!liveBlocks.length) throw new Error('blocks 里没有可注入的块')

        const before = new Set(Object.keys(t.blocks._blocks))
        const beforeOpcode = {}
        for (const id of before) {
          const b = t.blocks._blocks[id]
          if (b) beforeOpcode[id] = b.opcode
        }
        await vm.shareBlocksToTarget(liveBlocks, t.id)
        const newIds = Object.keys(t.blocks._blocks).filter(id => !before.has(id))
        // ⑤ 只增不删自检（F0 的兜底）：注入绝不该让任何原有块消失。真消失了就当场喊，
        //    别让 AI 过几轮才发现「作者的判定逻辑没了」（那次是 5664→5650，谁也说不清谁删的）。
        const lost = [...before].filter(id => !t.blocks._blocks[id])

        // idMap：newBlockIds 按数组下标顺序换 id，createBlock 也按数组顺序插入 _blocks，
        // 所以 index[旧 id] 就是它在 newIds 里的位置。逐条用 opcode 自校验，错位就招供。
        let idMap = null
        let idMapReliable = false
        if (newIds.length === liveBlocks.length) {
          idMap = {}
          idMapReliable = true
          for (const oldId of Object.keys(index)) {
            const nid = newIds[index[oldId]]
            const got = nid && t.blocks._blocks[nid] ? t.blocks._blocks[nid].opcode : null
            idMap[oldId] = nid || null
            if (got !== input[oldId].opcode) idMapReliable = false
          }
        } else {
          warnings.push(`注入后新增 ${newIds.length} 块，但送入 ${liveBlocks.length} 块，数量对不上`)
        }
        // 记账：这些 id 是"我注入的"，下次 add_blocks 只用来报告游离状态，不删
        {
          const m = ledgerOf(t)
          const at = new Date().toISOString()
          for (const nid of newIds) {
            const b = t.blocks._blocks[nid]
            if (b) m.set(nid, { opcode: b.opcode, at })
          }
        }

        // 触发 GUI 刷新（用户实时看到新积木）
        safeEmitWorkspaceUpdate(vm)
        // 新积木亮一下（用户当场能看到"AI 刚往这儿塞了东西"）；影子块不发光，最多 8 块
        const glowed = glowBlocks(vm, newIds.filter(nid => t.blocks._blocks[nid] && !t.blocks._blocks[nid].shadow))
        // ⑥ 把视口带过去（F1）：用户看着窗口也得能看见我往哪儿塞了东西。
        //    排在 emitWorkspaceUpdate 之后 —— GUI 重建工作区是异步的，要先给它一点时间。
        let followed = null
        if (args.follow !== false) {
          followed = await followBlock(vm, t, idMap && roots.length ? idMap[roots[0]] : null)
        }
        return {
          added: newIds.length,
          inputBlocks: Object.keys(index).length,
          // 送进去的是"展开后"的活块（每个 inline 字面量都会变成独立影子块），块数必然更多
          expandedBlocks: liveBlocks.length,
          idMap,
          idMapReliable,
          glowed: glowed || undefined,
          followed: followed || undefined,
          layout: { mode: lay.mode, placed: lay.placed ? lay.placed.length : undefined, overlap: lay.overlap.length ? lay.overlap.slice(0, 5) : undefined },
          // 变量引用发生了什么（只在真动过时才出现，免得把小输出撑大）
          refs: (refs.created.length || refs.remapped.length)
            ? { created: refs.created.length ? refs.created : undefined, remapped: refs.remapped.length ? refs.remapped : undefined, kept: refs.kept }
            : undefined,
          refsHint: refs.created.length
            ? `补建了 ${refs.created.length} 个变量/列表（内容已在 requires 里带上）：${refs.created.map(c => c.name).join('、')}`
            : (refs.remapped.length ? `有 ${refs.remapped.length} 个变量引用按名字改指向了目标角色里已有的同名变量` : undefined),
          // 形状校验的结果：checked/unverified 是覆盖度，inputWarnings 是"少输入"这类提醒
          shapeCheck: { checked: shape.checked, unverified: shape.unverified, errors: shape.errors.length || undefined },
          inputWarnings: shape.warnings.length ? shape.warnings.slice(0, 6) : undefined,
          staleInjected: staleLeft.length
            ? {
                count: staleLeft.length,
                ids: staleLeft.slice(0, 8).map(s => s.id),
                hint: '这些是之前注入、现在仍游离在顶层的块（不会被自动清理，也不会被自动删）。'
                  + '想把它们收掉：scratch_add_blocks({ ... , discardStale: true })（只清"整棵子树都是 AI 注入的"）。'
              }
            : undefined,
          discarded: discard ? { count: discard.deleted.length, ids: discard.deleted.slice(0, 8), skipped: discard.skipped.length || undefined, skippedWhy: discard.skipped.length ? '这些块上面挂着作者原有的积木，没敢删' : undefined } : undefined,
          lost: lost.length
            ? {
                count: lost.length,
                opcodes: [...new Set(lost.map(id => (beforeOpcode[id] || '?')))].slice(0, 8),
                warning: '⚠️ 注入后**原有块消失了**（本操作只该新增）。先 scratch_rollback 回滚，再把这次的 blocks 报给开发者。'
              }
            : undefined,
          warnings: warnings.length ? warnings : undefined,
          hint: idMapReliable
            ? '后续引用新块请用 idMap 里的新 ID（shareBlocksToTarget 会全部换新 ID）'
            : 'idMap 不可靠（opcode 校验没过），请用 scratch_read_script 重新读一次拿真实 ID'
        }
      }
      case 'export_blocks': {
        // 背包的「存」这一半：把指定脚本（子树）导出成 sb3 dict，连同它引用的变量/列表的值。
        // 这样存下来的片段是**自包含**的：搬家/换项目也能注回去（变量引用由 resolveRefs 接上或补建）。
        const t = findTarget(vm, args && args.target)
        const roots = []
        if (Array.isArray(args.scriptIds)) roots.push(...args.scriptIds)
        if (Array.isArray(args.blockIds)) roots.push(...args.blockIds)
        const given = roots.filter(x => typeof x === 'string' && x)
        const rootIds = given.length ? given : (args.all === true ? topLevelIds(t.blocks._blocks) : [])
        if (!rootIds.length) throw new Error('要给 scriptIds（顶层块 id）/ blockIds；整份导出传 all: true')
        if (!t.isOriginal) throw new Error('这是克隆体，导不了（克隆体没有自己的积木定义）；请对原始角色操作')
        const { blocks, warnings } = exportSubtreeLive(t, rootIds)
        if (!Object.keys(blocks).length) {
          throw new Error(`这些 id 都不在角色「${t.getName()}」里（先 scratch_list_scripts 拿真实脚本 id）。`
            + `要的 id=${JSON.stringify(rootIds.slice(0, 5))}；这个角色一共 ${Object.keys(t.blocks._blocks).length} 块`)
        }
        const requires = collectRefs(blocks, t, vm.runtime.getTargetForStage(), { listLimit: args.listLimit })
        // 自定义积木：调了 proccode 但片段里没有它的 definition —— 注进去就是空转（GUI 也不报错），
        // 必须在存的时候就说清楚"得把定义那条一起存"
        const defined = new Set()
        const called = new Set()
        for (const b of Object.values(blocks)) {
          if (Array.isArray(b) || !b.mutation || !b.mutation.proccode) continue
          if (b.opcode === 'procedures_definition') defined.add(b.mutation.proccode)
          else if (b.opcode === 'procedures_call') called.add(b.mutation.proccode)
        }
        for (const pc of called) {
          if (!defined.has(pc)) warnings.push(`调用了自定义积木「${pc}」但片段里没有它的定义（procedures_definition）—— 注进去会是空转，把定义那条脚本一起存`)
        }
        const hats = Object.values(blocks).filter(b => !Array.isArray(b) && b.topLevel).map(b => b.opcode)
        return {
          target: t.getName(),
          project: docTitle(),
          roots: rootIds,
          blocks,
          blockCount: Object.keys(blocks).length,
          scripts: hats.length,
          topLevelOpcodes: hats,
          requires,
          warnings: warnings.length ? warnings : undefined
        }
      }
      case 'locate': {
        // 定位块：滚到它 + 高亮。
        // 坑一：workspace 只在**当前编辑角色**的积木区里，别的角色的块根本不在里面
        //       → 先把目标角色切成 editingTarget 并刷新，再找。
        // 坑二：emitWorkspaceUpdate 之后 GUI 是异步重建的，块不会立刻出现 → 重试。
        const blockId = args && args.blockId
        if (!blockId) throw new Error('blockId 必填')
        const ws = getBlocklyWorkspace()
        if (!ws) {
          throw new Error('拿不到 Blockly workspace（积木区还没挂载 / 这是播放器页；scratch.mit.edu 新版编辑器不暴露 window.Blockly）')
        }
        // 跨角色搜索（P1-1）：以前只在「当前编辑目标」里找，多角色项目里必然失败，
        // 而且错误信息把原因归到「ID 可能被 add_blocks 换新」—— 完全误导（实测就是这么被绕的）。
        // 现在：给了 target 就只搜它；没给就按「当前编辑角色 → 其它角色 → 舞台」全搜，命中后自动切过去。
        const allTargets = (vm.runtime.targets || []).filter(x => x.isOriginal)
        const scope = args && args.target
          ? allTargets.filter(x => x.getName() === args.target)
          : allTargets.slice()
        if (args && args.target && !scope.length) {
          throw new Error(`找不到角色 "${args.target}"，现有: ${allTargets.map(x => x.getName()).join(', ')}`)
        }
        const rank = (x) => (vm.editingTarget && x.id === vm.editingTarget.id ? 0 : (x.isStage ? 2 : 1))
        scope.sort((a, b) => rank(a) - rank(b))
        // 先在 VM 里确认这个块真的存在：不存在就没必要等着 GUI 慢慢渲染（否则要空转 1 秒多）
        const t = scope.find(x => x.blocks._blocks[blockId])
        if (!t) {
          throw new Error(
            `找不到块 ${blockId}：${scope.length} 个角色/舞台里都没有（找过 ${scope.map(x => x.getName()).join('、')}）。`
            + '两种可能：① 它已经被 add_blocks 换过新 ID —— 用 scratch_read_script({ summary: true }) 重读，清单里都是真实 ID；'
            + '② 这个块只活在某个克隆体里（运行期克隆的积木不在工作区上，定位不了）。'
          )
        }
        const fromTarget = vm.editingTarget && vm.editingTarget.getName()
        if (!args || !args.target) args.target = t.getName() // 命中后统一按"这个角色"处理
        // 存在但可能还没渲染：先切角色刷新，再重试等 GUI 重建完
        let switched = false
        if (vm.editingTarget && vm.editingTarget.id !== t.id) {
          vm.setEditingTarget(t.id)
          safeEmitWorkspaceUpdate(vm)
          switched = true
          await new Promise(r => setTimeout(r, 150))
        }
        let block = ws.getBlockById(args.blockId)
        for (let i = 0; i < 8 && !block; i++) {
          await new Promise(r => setTimeout(r, 150))
          block = ws.getBlockById(args.blockId)
        }
        if (!block) throw new Error(`块 ${args.blockId} 在 VM 里存在，但工作区里还没渲染出来（GUI 没开或正在重建，稍后再试）`)
        const xy = block.getRelativeToSurfaceXY()
        // 滚动到块。真机实测（TurboWarp 的 scratch-blocks）：workspace 上**没有** scrollBounds
        // —— 那是上游 Blockly 的 API。scratch-blocks 给的是 centerOnBlock(id) / scroll(x,y) / scrollCenter()。
        // 旧代码写「typeof 有才调」+ try/catch，真机上就是静默不滚动、还照样回 ok：
        // 用户看到的现象是「说定位了但工作区没动」。这里按可用性依次降级，
        // 并把实际走的哪条路报回去（scrolledBy），一条都走不通时明确给 warnings 而不是假装成功。
        let scrolledBy = null
        try {
          if (typeof ws.centerOnBlock === 'function') {
            ws.centerOnBlock(args.blockId) // scratch-blocks 正路：把这个块居中
            scrolledBy = 'centerOnBlock'
          } else if (typeof ws.scrollBounds === 'function') {
            ws.scrollBounds(xy.x, xy.y, xy.x + 200, xy.y + 80) // 上游 Blockly（scratch-blocks 没有）
            scrolledBy = 'scrollBounds'
          } else if (typeof ws.scroll === 'function') {
            // 不要 clamp 到 0：工作区允许负坐标（块可以放在原点左上），
            // 钳到 0 会让靠近原点的块永远居中不了。越界由 Blockly 自己的 scrollbar 收。
            const m = typeof ws.getMetrics === 'function' ? ws.getMetrics() : null
            const s = ws.scale || 1
            ws.scroll(xy.x * s - (m ? m.viewWidth / 2 : 400), xy.y * s - (m ? m.viewHeight / 2 : 300))
            scrolledBy = 'scroll'
          }
        } catch (e) { scrolledBy = 'error: ' + e.message }
        // 视觉高亮：给块的 SVG 加发光描边
        try {
          const svgRoot = block.getSvgRoot()
          if (svgRoot && svgRoot.style) {
            svgRoot.style.filter = 'drop-shadow(0 0 6px #4c97ff) drop-shadow(0 0 12px #4c97ff)'
            setTimeout(() => { try { svgRoot.style.filter = '' } catch {} }, 3000)
          }
        } catch {}
        return {
          found: true,
          target: t.getName(),
          opcode: block.type,
          position: { x: xy.x, y: xy.y },
          scrolledBy,
          // 跨角色定位命中时把"从哪个角色切过来"也报出来，用户才知道工作区为什么整体换了
          switchedFrom: switched ? fromTarget : undefined,
          searchedTargets: scope.length,
          warnings: scrolledBy && !scrolledBy.startsWith('error')
            ? undefined
            : [`工作区没有可用的滚动 API（centerOnBlock / scrollBounds / scroll 都没有），只做了高亮、没有滚动${scrolledBy ? '：' + scrolledBy : ''}`]
        }
      }
      case 'add_costume': {
        // SVG → 造型：storage.createAsset + addCostume
        //
        // ⚠️ 坑（真机两轮才定位）：SVG 必须按**字节**存，不能把字符串塞给 createAsset。
        //    scratch-storage 的 Asset.decodeText() 无条件 `new TextDecoder().decode(this.data)`
        //    （源码注释自己都写了"data 可能是字符串，但这函数只在字节数组时被调用"），
        //    传字符串 → 抛 `parameter 1 is not of type 'ArrayBuffer'` → loadCostume 进 catch →
        //    造型永远拿不到 skin：编辑器里显示成一张 **"?" 占位图**，
        //    更麻烦的是：这条错误路径还会把整页搞成白屏（桌面版会挂一个 sandbox iframe，
        //    旧代码的 CDP 会话会被那个 iframe 的默认上下文抢走 —— 见 cdp.js 顶部那条）
        //    之前浏览器真机那条断言太弱（只判 rotationCenter !== 48），所以一直"绿着坏"。
        const t = findTarget(vm, args && args.target)
        const storage = vm.runtime.storage
        if (!storage) throw new Error('storage 不可用')
        const svgText = String((args && args.svg) || '')
        if (!svgText.trim()) throw new Error('svg 不能为空')
        if (!/<svg[\s>]/i.test(svgText)) throw new Error('svg 看起来不是 SVG 源码（要以 <svg …> 开头）')
        const bytes = new TextEncoder().encode(svgText)
        const asset = storage.createAsset(
          storage.AssetType.ImageVector, 'svg', bytes, null, true
        )
        const md5ext = asset.assetId + '.' + asset.dataFormat
        const name = (args && args.name) || 'ai-costume'
        await vm.addCostume(md5ext, {
          name,
          assetId: asset.assetId, // 5.x 序列化器直接读此字段（缺了会导致快照 sb3 验证失败）
          md5ext, dataFormat: 'svg',
          asset // load-costume 会从它派生 md5 / dataFormat
          // 故意不给 rotationCenterX/Y：留空时 load-costume 会用 renderer.getSkinRotationCenter
          // 按真实图形算旋转中心（load-costume.js:409-412）。硬编码 48/50 会把任意尺寸的
          // SVG 旋转中心都钉死在 (48,50)，转起来就歪。
        }, t.id)
        // 加完**必须验一下它到底载入没有**：没有 skin 就是坏的，别把 "?" 留在用户项目里
        const list = t.getCostumes() || []
        const added = list.filter(c => c && c.assetId === asset.assetId).slice(-1)[0] || list[list.length - 1]
        const ok = added && added.skinId && Number.isFinite(added.rotationCenterX) && Number.isFinite(added.rotationCenterY)
        if (!ok) {
          const idx = list.indexOf(added)
          if (idx >= 0 && list.length > 1) {
            try { t.deleteCostume(idx) } catch { /* 撤不掉也要把错误报出来 */ }
          }
          throw new Error(
            '这个 SVG 渲染器没载入（skin 为空）—— 多半是缺 width/height/viewBox、或图形为空。'
            + '已经把它从项目里撤掉了（不留 "?" 占位造型）。换一个带实际图形和宽高的 SVG 再来。'
          )
        }
        return {
          costume: added.name || name,
          md5ext,
          skin: !!added.skinId,
          rotationCenter: [added.rotationCenterX, added.rotationCenterY],
          size: Array.isArray(added.size) ? added.size : undefined
        }
      }
      case 'restore': {
        // 回滚：整项目重载（快照存的是 project.json）
        await vm.loadProject(args.projectJson)
        safeEmitWorkspaceUpdate(vm)
        return { restored: true }
      }

      case 'load_project': {
        // 把本机的 .sb3 / .sb2 / project.json 打开进编辑器（等于用户手动拖文件进去）。
        // vm.loadProject 三种输入都吃：已解析的对象 / JSON 字符串 / ArrayBuffer（sb3 zip，
        // 解压交给 VM 自己的 JSZip，我们不用在插件侧实现 zip）。
        let input
        if (args && args.projectJson) input = args.projectJson
        else if (args && args.sb3Base64) input = base64ToBytes(args.sb3Base64).buffer
        else throw new Error('load_project 需要 projectJson 或 sb3Base64')
        let replaced = null
        try { replaced = snapshotJson(vm).targets.map(t => t.name) } catch { /* 当前项目读不出来也无所谓 */ }
        await vm.loadProject(input)
        safeEmitWorkspaceUpdate(vm)
        const pj = snapshotJson(vm)
        const cnt = countProjectBlocks(pj)
        return {
          loaded: true,
          filename: (args && args.filename) || null,
          title: docTitle(),
          targets: pj.targets.map(t => t.name),
          extensions: pj.extensions || [],
          blockCount: cnt.real,
          blockCountWithShadows: cnt.withShadow,
          replacedTargets: replaced
        }
      }

      case 'save_project': {
        // 把编辑器里的项目序列化成 sb3 字节回传，由插件侧落盘（浏览器写不了任意路径）。
        // TurboWarp 的 saveProjectSb3() 返回 Blob；别的构建可能给 Uint8Array —— 都兜住。
        if (typeof vm.saveProjectSb3 !== 'function') {
          throw new Error('这个宿主的 vm 没有 saveProjectSb3()，拿不到 sb3 字节')
        }
        const out = await vm.saveProjectSb3()
        // 类型判断要**跨 realm 安全**：浏览器里 VM 和我们同 realm，instanceof 够用；
        // 但 Node vm 沙箱（lab 的验靶）里 VM 是宿主 realm 的对象，`instanceof Uint8Array`
        // 会返回 false（两个 realm 的构造器不是同一个）。所以用内部 class 标记 + isView 判。
        let bytes
        const tag = Object.prototype.toString.call(out)
        if (tag === '[object Uint8Array]' || (typeof ArrayBuffer.isView === 'function' && ArrayBuffer.isView(out))) {
          bytes = new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
        } else if (tag === '[object ArrayBuffer]') {
          bytes = new Uint8Array(out)
        } else if (out && typeof out.arrayBuffer === 'function') {
          bytes = new Uint8Array(await out.arrayBuffer())
        } else {
          throw new Error('saveProjectSb3 返回了不认识的类型：' + tag)
        }
        return { sb3Base64: bytesToBase64(bytes), bytes: bytes.length, title: docTitle() }
      }

      // ==================== M1：改块 / 删块 / 整理 ====================

      case 'update_block': {
        // AI 改已有块。changes 三类：
        //   field: {FIELD_NAME: newValue}  → 走官方 changeBlock（element:'field'）
        //   input: {INPUT_NAME: [1, [4, '50']]} / [1, '块id'] / 直接给值
        //          ⚠️ 绝不能把 sb3 数组写回 block.inputs[name]！活块模型要求
        //          inputs[name] = {name, block, shadow}，字面量的值存在**影子块**的 field 里。
        //          写数组的后果（实测）：值从工作区消失、快照变 [1,null] 救不回来、
        //          原影子块变孤儿，scratch-vm 还会警告 "unexpected top level primitive"。
        //          正解 = 改影子块的 field（下面 literal 分支）。
        //   x/y: 新坐标 → 走官方 moveBlock
        const t = findTarget(vm, args && args.target)
        const blocks = t.blocks
        const id = args.blockId
        if (!blocks.getBlock(id)) throw new Error(`找不到块 ${id}`)
        const changes = args.changes || {}
        const applied = { field: [], input: [], move: null }
        const notes = []

        for (const [name, value] of Object.entries(changes.fields || {})) {
          const target = blocks.getBlock(id)
          if (!target.fields[name]) {
            throw new Error(`块 ${id} 没有字段 "${name}"（现有: ${Object.keys(target.fields).join(', ') || '无'}）`)
          }
          blocks.changeBlock({ id, element: 'field', name, value: String(value) }, t.id)
          applied.field.push(name)
        }

        for (const [name, value] of Object.entries(changes.inputs || {})) {
          const target = blocks.getBlock(id)
          // F2：空槽被 sb3 序列化丢掉后，按「该 opcode 的合法输入名」补建，不再逼人删块重建
          const input = target.inputs[name] || ensureInputSlot(vm, blocks, id, name)
          if (!input) {
            const spec = opcodeSpec(vm, target.opcode)
            throw new Error(`块 ${id}（${target.opcode}）没有输入 "${name}"（现有: ${Object.keys(target.inputs).join(', ') || '无'}）`
              + (spec ? `。这个积木的输入是 ${spec.inputs.join('、')}` : '。用 scratch_get_opcodes({ opcode }) 查它有哪些输入'))
          }
          // 字面量可能是 [1,[10,'x']]（带遮挡标志）或直接给值
          const desc = Array.isArray(value) && (value[0] === 1 || value[0] === 2 || value[0] === 3) ? value[1] : value

          if (input.block && input.block !== input.shadow) {
            const occupant = blocks.getBlock(input.block)
            throw new Error(
              `输入 ${name} 上挂着积木（id ${input.block}，opcode ${occupant ? occupant.opcode : '?'}），` +
              '不能直接改成字面量。要么先用 scratch_delete_blocks 删掉那个积木，要么直接改那个积木自己的字段。'
            )
          }

          // 分支 1：接上一个已存在的块（sb3 形态 [1, '块 id']）
          if (typeof desc === 'string' && blocks.getBlock(desc)) {
            const child = blocks.getBlock(desc)
            if (child.id === id) throw new Error(`输入 ${name} 不能接自己`)
            input.block = child.id
            child.parent = id
            notes.push(`输入 ${name} 接上了积木 ${child.id}（${child.opcode}）`)
            applied.input.push(name)
            continue
          }

          // 分支 2：写字面量 → 改影子块的 field
          let shadowId = input.shadow || input.block
          let shadow = shadowId ? blocks.getBlock(shadowId) : null
          if (!shadow) {
            // F2 续：槽是新的/空的，连默认影子块都没有 —— 按同 opcode 的别的块补一个同类型影子
            shadowId = makeShadowBlock(blocks, id, siblingShadowTemplate(vm, target.opcode, name))
            shadow = blocks.getBlock(shadowId)
            input.block = shadowId
            input.shadow = shadowId
            notes.push(`输入 ${name} 原来没有影子块（空槽），补了一个 ${shadow.opcode} 默认值`)
          }
          const fieldNames = Object.keys(shadow.fields || {})
          if (fieldNames.length !== 1) {
            throw new Error(`影子块 ${shadow.opcode} 有 ${fieldNames.length} 个字段（${fieldNames.join(', ')}），改不了`)
          }
          const fieldName = fieldNames[0]
          const literal = Array.isArray(desc) ? desc[1] : desc
          if (VAR_TYPE_BY_FIELD[fieldName] !== undefined) {
            // 变量/列表/广播：field.id 才是真身，直接写（changeBlock 那条路要求传变量 id）
            shadow.fields[fieldName].value = literal
            if (Array.isArray(desc) && desc[2]) shadow.fields[fieldName].id = desc[2]
            notes.push(`输入 ${name} 指向 ${fieldName}=${JSON.stringify(literal)}（变量类影子块，直接写 field）`)
          } else {
            blocks.changeBlock({ id: shadow.id, element: 'field', name: fieldName, value: String(literal) }, t.id)
          }
          applied.input.push(name)
        }

        if (changes.x !== undefined || changes.y !== undefined) {
          const block = blocks.getBlock(id)
          blocks.moveBlock({
            id,
            newCoordinate: {
              x: changes.x !== undefined ? changes.x : block.x,
              y: changes.y !== undefined ? changes.y : block.y
            }
          })
          applied.move = { x: changes.x, y: changes.y }
        }
        // 触发项目变更 + GUI 刷新（changeBlock/moveBlock 内部不保证全发）
        blocks.emitProjectChanged()
        safeEmitWorkspaceUpdate(vm)
        const glowed = glowBlocks(vm, [id])
        // F1：改完把视口带到这个块上（用户看得见"AI 改了这儿"）
        const followed = args.follow !== false ? await followBlock(vm, t, id) : null
        const after = blocks.getBlock(id)
        return {
          updated: id,
          applied,
          glowed: glowed || undefined,
          followed: followed || undefined,
          notes: notes.length ? notes : undefined,
          block: { opcode: after.opcode, x: after.x, y: after.y }
        }
      }

      case 'delete_blocks': {
        // 删块。deleteBlock 递归删除 next 链 + 嵌套实块（与 GUI 行为一致）。
        // 这里额外做两件事，因为"静默留孤儿"是这个 API 最容易出事的地方：
        //   1) 用 collect() 预测会删哪些，和实际删掉的集合对账，不一致就报出来
        //   2) 删完扫一遍全角色，把 parent/next 指向已不存在块的悬空块列出来
        const t = findTarget(vm, args && args.target)
        const blocks = t.blocks
        const ids = args.blockIds || (args.blockId ? [args.blockId] : [])
        if (!ids.length) throw new Error('blockIds 不能为空')
        const predicted = []
        const predictedSet = new Set()
        // 镜像 Blocks.deleteBlock 的递归：inputs 里的 .block（**包含影子块**）+ next 链。
        // 之前漏了影子块，导致返回给 AI 的 deleted 清单比实际少（实测 3 vs 5）。
        const collect = (bid) => {
          const b = blocks.getBlock(bid)
          if (!b || predictedSet.has(bid)) return
          predictedSet.add(bid)
          predicted.push(bid)
          for (const input of Object.values(b.inputs || {})) {
            // 镜像 deleteBlock 的两条分支：实块 + 「被遮挡的影子块」
            if (input.block) collect(input.block)
            if (input.shadow && input.shadow !== input.block) collect(input.shadow)
          }
          if (b.next) collect(b.next)
        }
        for (const id of ids) {
          if (!blocks.getBlock(id)) continue
          collect(id)
          blocks.deleteBlock(id)
        }
        blocks.emitProjectChanged()
        safeEmitWorkspaceUpdate(vm)

        // 实际删掉了哪些：以"删前存在、删后不存在"为准
        const missing = predicted.filter(bid => !blocks.getBlock(bid))
        const survived = predicted.filter(bid => blocks.getBlock(bid))
        // 全角色扫悬空引用（不只本角色，删块可能让别的角色指向空）
        const dangling = []
        for (const target of vm.runtime.targets) {
          const all = target.blocks._blocks
          for (const bid of Object.keys(all)) {
            const b = all[bid]
            if (b.next && !all[b.next]) dangling.push({ target: target.getName(), block: bid, kind: 'next', missing: b.next })
            if (b.parent && !all[b.parent]) dangling.push({ target: target.getName(), block: bid, kind: 'parent', missing: b.parent })
          }
        }
        return {
          deleted: missing,
          count: missing.length,
          survivedPredicted: survived.length ? survived : undefined,
          dangling: dangling.length ? dangling : undefined,
          warning: survived.length
            ? '有预测该删却还留着的块——项目里可能存在结构性损坏，建议检查/回滚'
            : (dangling.length ? '检测到悬空引用，继续操作前建议 scratch_rollback' : undefined)
        }
      }

      case 'move_block': {
        // 断链 / 接链。只动**同一个角色**内的块：跨角色搬运用背包（save → load），
        // 那条路已经处理好了变量落地和 id 换新，别在这里再造一套。
        const t = findTarget(vm, args && args.target)
        if (!args || !args.blockId) throw new Error('blockId 不能为空')
        return await moveBlockIn(vm, t, {
          id: args.blockId,
          mode: args.mode,
          to: args.toBlockId,
          input: args.inputName,
          follow: args.follow
        })
      }

      case 'variable': {
        // 变量 / 列表的增删改与赋值。名字和 id 二选一，scope 不传 = 先角色后舞台。
        const a = Object.assign({}, args || {})
        let action = String(a.action || 'set')
        const kind = a.kind === 'list' ? 'list' : 'variable'
        const type = VAR_TYPE_BY_KIND2[kind]
        const stage = vm.runtime.getTargetForStage()
        const t = a.target ? findTarget(vm, a.target) : vm.editingTarget
        const label = kind === 'list' ? '列表' : '变量'
        const notFound = () => new Error(`找不到${label}「${a.name || a.id || ''}」${a.scope ? `（${a.scope === 'local' ? '本角色' : '舞台'}里）` : ''}`
          + '。要新建就传 action:"create"；想知道现在有哪些，看 snapshot 的 targets[].variables')

        // 赋值时顺手建一个（AI 常先赋值后声明）—— 只在明确传了 create:true 时才这么做
        if (action === 'set' && !findVariable(vm, t, { id: a.id, name: a.name, kind, scope: a.scope })
          && (a.create === true)) {
          action = 'create'
          if (!a.scope) a.scope = 'local'
        }
        const scope = a.scope === 'local' || a.scope === 'global' ? a.scope : undefined
        const hit = findVariable(vm, t, { id: a.id, name: a.name, kind, scope })

        if (action === 'set') {
          if (!hit) throw notFound()
          let value
          if (kind === 'list') {
            if (!Array.isArray(a.value)) throw new Error('给列表赋值要传数组（例如 ["甲","乙"]）；只改一项可以整体重写这个数组')
            value = a.value.slice()
          } else {
            value = a.value === undefined || a.value === null ? '' : a.value
          }
          vm.setVariableValue(hit.owner.id, hit.variable.id, value)
          const now = hit.variable.value
          return {
            action: 'set',
            kind,
            name: hit.variable.name,
            id: hit.variable.id,
            scope: hit.owner.isStage ? 'global' : 'local',
            value: kind === 'list' ? (now || []).slice(0, 200) : clipScalar(now),
            length: kind === 'list' ? (now || []).length : undefined,
            truncated: kind === 'list' && (now || []).length > 200 ? true : undefined
          }
        }

        if (action === 'create') {
          const name = String(a.name || '').trim()
          if (!name) throw new Error('create 需要 name')
          const owner = scope === 'local' && t && !t.isStage ? t : stage
          if (scope === 'local' && (!t || t.isStage)) {
            throw new Error('舞台上的"局部变量"就是全局变量 —— 舞台上直接用 scope:"global"')
          }
          // 同名同类型冲突：与官方 var_create 的判定一致（全局要把所有原身角色都扫一遍）
          const scan = owner.isStage ? (vm.runtime.targets || []).filter(x => x.isOriginal) : [owner]
          for (const x of scan) {
            for (const v of Object.values(x.variables || {})) {
              if (v && v.name === name && (v.type || '') === type) {
                throw new Error(`${x.isStage ? '舞台' : `角色「${x.getName()}」`}已经有同名${label}「${name}」（id ${v.id}）`)
              }
            }
          }
          const id = `dshv-${Math.random().toString(36).slice(2, 10)}`
          owner.createVariable(id, name, type, false)
          const v = owner.variables && owner.variables[id]
          if (!v) throw new Error('创建失败：宿主没接受这个变量')
          if (kind === 'list') v.value = Array.isArray(a.value) ? a.value.slice() : []
          else v.value = a.value === undefined || a.value === null ? 0 : a.value
          safeEmitWorkspaceUpdate(vm) // 工具箱的分类要跟着多一项
          return {
            action: 'create',
            kind,
            name,
            id,
            scope: owner.isStage ? 'global' : 'local',
            value: kind === 'list' ? v.value.slice() : v.value
          }
        }

        if (action === 'delete') {
          if (!hit) throw notFound()
          const refs = variableRefs(vm, hit.variable.id, kind)
          const who = hit.owner.isStage ? '舞台（全局）' : `角色「${hit.owner.getName()}」（局部）`
          if (refs.length && !a.force) {
            const head = refs.slice(0, 8).map(r => `${r.target}:${r.blockId}(${r.opcode})`).join('、')
            throw new Error(`${label}「${hit.variable.name}」（${who}）还被 ${refs.length} 个积木引用：${head}${refs.length > 8 ? ' …' : ''}。`
              + '先把这些积木改掉/删掉，或者传 force:true 连它们一起删（会一并删掉这些积木及其子块）')
          }
          const removed = []
          for (const r of refs) {
            const bt = (vm.runtime.targets || []).find(x => x.getName() === r.target)
            if (!bt || !bt.blocks.getBlock(r.blockId)) continue
            unlinkBlock(bt.blocks, r.blockId) // 先补断口再删，别留悬空指针
            bt.blocks.deleteBlock(r.blockId)
            removed.push(r.blockId)
          }
          hit.owner.deleteVariable(hit.variable.id)
          if (hit.owner.blocks) hit.owner.blocks.emitProjectChanged()
          safeEmitWorkspaceUpdate(vm)
          return {
            action: 'delete',
            kind,
            name: hit.variable.name,
            id: hit.variable.id,
            scope: hit.owner.isStage ? 'global' : 'local',
            removedBlocks: removed.length ? removed : undefined
          }
        }

        if (action === 'rename') {
          if (!hit) throw notFound()
          const newName = String(a.newName || a.value || '').trim()
          if (!newName) throw new Error('rename 需要 newName')
          for (const v of Object.values(hit.owner.variables || {})) {
            if (v && v.id !== hit.variable.id && v.name === newName && (v.type || '') === type) {
              throw new Error(`${hit.owner.isStage ? '舞台' : `角色「${hit.owner.getName()}」`}里已经有「${newName}」了`)
            }
          }
          const from = hit.variable.name
          hit.owner.renameVariable(hit.variable.id, newName)
          // 引用它的积木里，字段存的是**名字**，必须同步改（stage 的变量可能被任意角色引用）
          const updaters = hit.owner.isStage ? (vm.runtime.targets || []) : [hit.owner]
          for (const x of updaters) {
            try {
              if (x.blocks && x.blocks.updateBlocksAfterVarRename) x.blocks.updateBlocksAfterVarRename(hit.variable.id, newName)
            } catch { /* 宿主差异：字段没同步只影响显示 */ }
          }
          safeEmitWorkspaceUpdate(vm)
          return { action: 'rename', kind, id: hit.variable.id, scope: hit.owner.isStage ? 'global' : 'local', from, to: hit.variable.name }
        }

        // G7：只想确认"第 328 项是 0 还是 1"，不该被迫整份拉两条列表。
        // 下标照 Scratch 的 **1-based** 习惯（这是 H1 那个坑：0/越界会静默返回空串）。
        if (action === 'get') {
          if (!hit) throw notFound()
          const raw = hit.variable.value
          const base = {
            action: 'get',
            kind,
            name: hit.variable.name,
            id: hit.variable.id,
            scope: hit.owner.isStage ? 'global' : 'local'
          }
          if (kind !== 'list') return Object.assign(base, { value: clipScalar(raw) })
          const arr = Array.isArray(raw) ? raw : []
          if (a.index !== undefined) {
            const idx = Number(a.index)
            if (!Number.isFinite(idx) || idx < 1 || idx > arr.length) {
              throw new Error(`第 ${a.index} 项越界（列表「${hit.variable.name}」共 ${arr.length} 项）。`
                + 'Scratch 列表从 1 开始；越界本身会静默返回空串，这里直接报错免得你误判成"值是空"')
            }
            return Object.assign(base, { index: idx, value: clipScalar(arr[idx - 1]), length: arr.length })
          }
          const from = Math.max(1, Number(a.from) || 1)
          const count = Math.min(Math.max(Number(a.count) || 50, 1), 1000)
          return Object.assign(base, {
            from,
            count: Math.min(count, Math.max(arr.length - from + 1, 0)),
            length: arr.length,
            values: arr.slice(from - 1, from - 1 + count).map(clipScalar),
            truncated: from - 1 + count < arr.length || undefined
          })
        }

        throw new Error(`未知 action "${action}"（set / get / create / delete / rename）`)
      }

      case 'costume': {
        // 造型的改名/删除/切换。造型是"序号 + 名字"双身份的，改名会自动去重加后缀，
        // 删除会连带把"下一个造型"之类的引用错位（下标型积木天然如此），所以只在本角色内动。
        const a = args || {}
        const t = findTarget(vm, a.target)
        const action = String(a.action || '')
        const idx = costumeIndexOf(t, a)
        const list = t.getCostumes()

        if (action === 'rename') {
          if (!a.newName) throw new Error('rename 需要 newName')
          const before = list[idx].name
          if (typeof t.renameCostume === 'function') t.renameCostume(idx, String(a.newName))
          else list[idx].name = String(a.newName)
          const after = t.getCostumes()[idx].name
          // 造型名会出现在 "looks_switchcostumeto" 的字段里，改名后要让积木跟着变
          safeEmitWorkspaceUpdate(vm)
          return {
            action: 'rename',
            target: t.getName(),
            index: idx + 1,
            from: before,
            to: after,
            deduped: after !== String(a.newName) || undefined
          }
        }

        if (action === 'delete') {
          if (list.length <= 1) {
            throw new Error(`角色「${t.getName()}」只剩一个造型（${list[0].name}），删掉就没得显示了`)
          }
          const gone = t.deleteCostume(idx)
          if (!gone) throw new Error(`删除失败：下标 ${idx + 1} 越界，或宿主拒绝`)
          return {
            action: 'delete',
            target: t.getName(),
            deleted: gone.name,
            index: idx + 1,
            remaining: t.getCostumes().map(c => c.name),
            current: t.currentCostume + 1
          }
        }

        if (action === 'set') {
          t.setCostume(idx)
          return { action: 'set', target: t.getName(), current: t.currentCostume + 1, name: list[idx].name }
        }

        throw new Error(`未知 action "${action}"（rename / delete / set）`)
      }

      case 'rename_target': {
        // G2：以前角色名改不了（只有 variable / costume 的 rename），只能手改 project.json。
        // 走 VM 自己的 renameSprite：它会去重、并同步「碰到角色名」的积木字段（sensing_of 之类）。
        const a = args || {}
        const t = findTarget(vm, a.target)
        const to = String(a.to || a.newName || '').trim()
        if (!to) throw new Error('to 必填（新角色名）')
        if (t.isStage) throw new Error('舞台不能改名（Scratch 里舞台名字固定，改了会破坏 sense/引用）')
        if (!t.isOriginal) throw new Error('这是克隆体，没有独立的角色名；请对原始角色操作')
        const from = t.getName()
        if (from === to) return { from, to, unchanged: true }
        if (typeof vm.renameSprite !== 'function') throw new Error('这个宿主没有 vm.renameSprite，改不了角色名')
        vm.renameSprite(t.id, to)
        const after = t.getName()
        // GUI 的角色栏/工具箱都要刷（renameSprite 只 emitTargetsUpdate）
        safeEmitWorkspaceUpdate(vm)
        return {
          from,
          to: after,
          deduped: after !== to || undefined,
          hint: after !== to ? `目标里有同名角色，实际改成了「${after}」` : undefined
        }
      }

      case 'tidy_blocks': {
        // 整理布局：把目标角色的全部 top-level 脚本按「列排布」重排。
        // 算法：链高度估算（块数×44px + C块子链），列宽 400px，行距 60px，超高换列。
        const t = findTarget(vm, args && args.target)
        const blocks = t.blocks
        const scripts = blocks.getScripts() // top-level block id 数组
        if (!scripts.length) return { tidied: 0, scripts: [] }

        const COL_W = 400, ROW_GAP = 60, PAGE_H = 1200, X0 = 48, Y0 = 48
        const blockHeight = (bid, depth) => {
          const b = blocks.getBlock(bid)
          if (!b || depth > 50) return 1
          let h = 1
          if (b.next !== null) h += blockHeight(b.next, depth + 1)
          // C 块：inputs 里挂的是实块时算子链高度
          for (const input of Object.values(b.inputs)) {
            if (input.block && input.block !== input.shadow) h += blockHeight(input.block, depth + 1)
          }
          return h
        }
        let x = X0, y = Y0
        const placed = []
        for (const id of scripts) {
          const h = blockHeight(id, 0) * 44 + 40
          if (y + h > PAGE_H && y > Y0) { x += COL_W; y = Y0 }
          blocks.moveBlock({ id, newCoordinate: { x, y } })
          placed.push({ id, x, y, estHeight: h })
          y += h + ROW_GAP
        }
        blocks.emitProjectChanged()
        safeEmitWorkspaceUpdate(vm)
        return {
          tidied: placed.length,
          scripts: placed,
          note: 'estHeight 是估算行高（块数×44px），真实渲染由 Blockly 布局'
        }
      }

      case 'get_opcodes': {
        // opcode 白名单，三源合并：
        //   runtime._primitives — 全部可执行 opcode（内置 + 已加载扩展，loadExtension 时自动注册）
        //   runtime._hats — 帽子块
        //   runtime._blockInfo — 扩展分类信息（含 pen 等显式加载的扩展，带分类名）
        const rt = vm.runtime
        const fromPrimitives = Object.keys(rt._primitives || {})
        const fromHats = Object.keys(rt._hats || {})
        const set = new Set([...fromPrimitives, ...fromHats])
        const byCategory = {}
        // _blockInfo 有扩展分类名，把已知扩展的 opcode 归类
        for (const cat of (rt._blockInfo || [])) {
          const ops2 = (cat.blocks || []).map(b => b.info && b.info.opcode).filter(Boolean)
          if (ops2.length) { byCategory[cat.id] = ops2; ops2.forEach(o => set.add(o)) }
        }
        const list = [...set].sort()
        // 只问一个 opcode 时，直接把它的形状（输入名 / 字段名）给出来 —— G3 的正解入口：
        // 写 add_blocks 之前先查一次，就不会把 OPERAND1 塞进 operator_add。
        const ask = args && (args.opcode || args.opcodes)
        const asked = Array.isArray(ask) ? ask.slice(0, 20) : (ask ? [String(ask)] : null)
        if (asked) {
          const schemas = {}
          for (const op of asked) {
            const spec = opcodeSpec(vm, op)
            schemas[op] = spec
              ? { inputs: spec.inputs, fields: spec.fields.length ? spec.fields : undefined, source: spec.source }
              : { unknown: true, hint: op === 'procedures_call' ? 'procedures_call 的输入名是参数 id（来自 mutation.argumentids），不固定' : '没拿到形状表（扩展没加载 / 冷门块），注入时不校验输入名' }
          }
          return { asked: asked.length, schemas, familyHint: INPUT_FAMILY_HINT }
        }
        return { count: list.length, opcodes: list, byCategory, hatBlocks: fromHats.sort() }
      }

      // ==================== M2：观察者 / 双向联动 ====================

      case 'watch': {
        // 订阅变量。action: start | stop | poll
        // start 后扩展侧每 500ms 轮询（全局 Stage + 目标角色局部 两层），变化时推帧
        const action = (args && args.action) || 'poll'
        const collectVars = () => {
          // 返回 {全局+局部变量名: 值} 扁平视图。
          // ⚠️ 只取标量：以前连列表整段回传，一次 poll 14.8MB（问题记录 P1-5）。
          const stage = vm.runtime.getTargetForStage()
          const t = vm.runtime.targets.find(t2 => t2.getName() === watchState.targetName)
          const out = {}
          const lists = {}
          for (const src of [stage, t]) {
            if (!src) continue
            const vs = varSummary(src, { includeLists: watchState.includeLists })
            Object.assign(out, vs.scalars)
            if (vs.listLengths) Object.assign(lists, vs.listLengths)
          }
          return { values: out, lists }
        }
        if (action === 'start') {
          const t = findTarget(vm, args && args.target)
          watchState.targetName = t.getName()
          watchState.values = {}
          watchState.includeLists = !!(args && args.includeLists === true)
          watchState.queue.length = 0
          if (watchState.timer) clearInterval(watchState.timer)
          watchState.timer = setInterval(watchTick, 500)
          watchTick() // 立即首采
          const snap = collectVars()
          return {
            watching: watchState.targetName,
            includeLists: watchState.includeLists,
            variables: Object.keys(snap.values),
            listLengths: Object.keys(snap.lists).length ? snap.lists : undefined,
            hint: '列表默认不跟踪（includeLists:false）。要看列表变化就重新 start 并传 includeLists: true'
          }
        }
        if (action === 'stop') {
          if (watchState.timer) clearInterval(watchState.timer)
          watchState.timer = null
          return { stopped: true }
        }
        // poll：返回当前值 + 清空变化队列
        const changes = watchState.queue.splice(0)
        const snap = collectVars()
        return {
          current: snap.values,
          listLengths: Object.keys(snap.lists).length ? snap.lists : undefined,
          changes,
          changeCount: changes.length,
          watching: watchState.targetName,
          includeLists: watchState.includeLists
        }
      }

      // ==================== 运行控制 / 可观测（P0-2，v0.7.0） ====================
      // 这些在问题记录里是「AI 每次都要自己写驱动脚本」的那一层。全部是只读或运行期动作，
      // 不碰项目数据，所以不受 preview/apply 那套写保护约束（也不产生快照）。

      case 'run': {
        const action = (args && args.action) || 'greenflag'
        const rt = vm.runtime
        const a = args || {}
        // D5：以前每次返回完整 before/after 状态转储（30+ 变量 + 38 个列表长度），
        // 而调用方通常只要「线程/克隆数有没有动」。现在默认 brief，要看全量传 detail:true。
        const brief = a.detail !== true
        const snap = () => {
          const s = runtimeState(vm, { includeLists: false })
          return brief
            ? { running: s.running, threads: s.threads, clones: s.clones || {}, stepMs: s.stepMs }
            : s
        }
        const before = snap()
        if (action === 'greenflag') {
          vm.greenFlag()
          if (typeof vm.start === 'function') vm.start() // GUI 里通常在跑；headless/暂停时可自愈
        } else if (action === 'stopall') {
          vm.stopAll()
        } else if (action === 'start') {
          if (typeof vm.start === 'function') vm.start()
        } else if (action === 'stoploop') {
          if (typeof vm.stop === 'function') vm.stop()
        } else {
          throw new Error(`未知 action ${action}（greenflag | stopall | start | stoploop）`)
        }
        // 让绿旗线程真的跑起来几帧，用户才看得到变化（也给调用方一个稳定的读数）
        const wait = Math.min(Math.max(Number(a.waitMs) || 300, 0), 5000)
        if (wait) await sleepMs(wait)
        const after = snap()
        return {
          action,
          before,
          after,
          // 变量真的动了几个：给"绿旗到底有没有跑起来"一个不看全量也能懂的读数
          changedVars: (() => {
            if (brief) return undefined
            const b = before.pageVars || {}
            const af = after.pageVars || {}
            const out = {}
            let n = 0
            for (const k of Object.keys(af)) {
              if (b[k] !== af[k]) { out[k] = af[k]; n++ }
              if (n >= 20) break
            }
            return n ? out : undefined
          })(),
          hint: action === 'greenflag' && !after.running
            ? '绿旗点了，但没有任何线程在跑 —— 项目可能没有接绿旗的脚本，或者脚本第一帧就结束了（这种是正常现象）。'
              + '注意：running:true 只代表 VM 在跑，不代表界面在响应（窗口卡死时 VM 照样在跑，用 scratch_selftest 的帧心跳判断）。'
            : '注意：running:true 只代表 VM 有活线程，不代表界面在响应；界面是否卡死看 scratch_selftest 的"帧心跳"'
        }
      }

      case 'state': {
        const a = args || {}
        const st = runtimeState(vm, {
          targetName: a.target,
          includeLists: !!a.includeLists === true
        })
        // 顺手把"点绿旗之后到底有没有在动"这件事说清楚：线程清单比单个布尔值有用
        const rt = vm.runtime
        const threads = (rt.threads || [])
          .filter(th => th.status !== 4)
          .slice(0, 20)
          .map(th => ({
            target: th.target && th.target.getName(),
            topBlock: th.topBlock,
            status: th.status,
            stackDepth: th.stack && th.stack.length
          }))
        if (threads.length) st.activeThreads = threads
        // C2：列表只报长度，想知道"是不是泄漏了"只能靠运气（那次是从两次 run 的 before/after 里偶然看出来
        // 4358→4379 的）。这里直接和上一次 state 比，给 lengthDelta。
        const lenNow = st.pageLists || {}
        if (stateLastLengths && Object.keys(lenNow).length) {
          const delta = {}
          for (const [k, v] of Object.entries(lenNow)) {
            const prev = stateLastLengths[k]
            if (typeof prev === 'number' && prev !== v) delta[k] = v - prev
          }
          if (Object.keys(delta).length) st.pageListDelta = delta
        }
        if (Object.keys(lenNow).length) stateLastLengths = Object.assign({}, lenNow)
        // G7：想确认 520 项里第 328 项是 0 还是 1，以前只能整份拉（两条列表 ≈ 6KB）
        if (a.listSlice && typeof a.listSlice === 'object') {
          const name = a.listSlice.name
          const from = Math.max(1, Number(a.listSlice.from) || 1) // Scratch 列表 1-based
          const count = Math.min(Math.max(Number(a.listSlice.count) || 20, 1), 500)
          const stage = rt.getTargetForStage()
          const named = a.target ? (rt.targets || []).find(x => x.getName() === a.target) : null
          const owner = [vm.editingTarget, named, stage].find(o => o && o.variables && Object.values(o.variables).some(v => v.name === name && (v.type === 'list' || Array.isArray(v.value))))
          const v = owner && Object.values(owner.variables).find(x => x.name === name)
          if (!v) throw new Error(`找不到列表「${name}」（可用于 state.listSlice 的列表见 pageLists）`)
          const arr = Array.isArray(v.value) ? v.value : []
          st.listSlice = {
            name,
            length: arr.length,
            from,
            // 下标照 Scratch 的 1-based 习惯来，省得 AI 自己减一（这是 H1 那个坑）
            values: arr.slice(from - 1, from - 1 + count).map(clipScalar)
          }
        }
        return st
      }

      case 'list_scripts': {
        const t = findTarget(vm, args && args.target)
        const blocks = t.blocks._blocks
        const all = scriptIndex(vm, t).map(s => Object.assign(s, { label: scriptLabel(blocks, s) }))
        const minBlocks = Number(args && args.minBlocks) || 0
        // kind：all | script（帽子打头）| definition（自定义积木定义）| loose（真·游离）| called（定义 + 被调用的）
        const kind = (args && args.kind) || 'all'
        const counts = blockCounts(blocks)
        const pick = (s) => {
          if (kind === 'all') return true
          if (kind === 'called') return s.kind === 'definition' && s.calledBy > 0
          return s.kind === kind
        }
        const list = all.filter(s => s.blockCount >= minBlocks && pick(s))
        const limit = Math.min(Math.max(Number(args && args.limit) || 100, 1), 500)
        return {
          target: t.getName(),
          isClone: !t.isOriginal,
          // 口径（B2）：blockCount 是展开视图（含物化影子），blockCountRaw 才是 project.json 里的真块数
          blockCount: counts.total,
          blockCountRaw: counts.raw,
          blockCountView: 'expanded',
          scriptCount: all.filter(s => s.kind === 'script').length,
          definitionCount: all.filter(s => s.kind === 'definition').length,
          looseCount: all.filter(s => s.kind === 'loose').length,
          returned: Math.min(list.length, limit),
          scripts: list.slice(0, limit),
          note: 'kind=script 是帽子块打头的真脚本；kind=definition 是**自定义积木定义**（calledBy 是被调用次数，'
            + '这类是引擎主干、不是垃圾）；kind=loose 才是作者拖出来的真·游离块（没有帽子、不会自己运行）。'
            + '看某段脚本的块体：scratch_read_script({ scriptId: blockId })'
        }
      }

      case 'project_overview': {
        // D1：一次问清「整个项目长什么样」。以前要靠 N 次 list_scripts / read_script 拼，
        // 每次都可能被截断 —— 实测把 AI 逼到自己解压 sb3、写了个 148 行的 dumper。
        // 这里给的是**结构索引**（不是块体）：每个角色/舞台的 opcode 直方图、自定义积木清单
        // （参数原型 / 是否 warp / 被调用几次）、调用关系、每段脚本一行摘要。
        const a = args || {}
        const topOpcodes = Math.min(Math.max(Number(a.topOpcodes) || 12, 1), 40)
        const scriptsPerTarget = Math.min(Math.max(Number(a.scriptsPerTarget) || 12, 1), 200)
        const only = typeof a.target === 'string' && a.target ? a.target : null
        const all = (vm.runtime.targets || []).filter(t => t.isOriginal && (!only || t.getName() === only))
        if (only && !all.length) throw new Error(`找不到角色 "${only}"`)
        let extensions = null
        try {
          const em = vm.runtime.extensionManager
          const loaded = em && em._loadedExtensions
          if (loaded) extensions = typeof loaded.keys === 'function' ? [...loaded.keys()] : [...loaded]
        } catch { /* 不同 VM 版本字段不同，拿不到就不报 */ }
        const targets = all.map(t => {
          const blocks = t.blocks._blocks
          const counts = blockCounts(blocks)
          const scripts = scriptIndex(vm, t).map(s => Object.assign(s, { label: scriptLabel(blocks, s) }))
          const hist = {}
          for (const b of Object.values(blocks)) {
            if (!b || b.shadow) continue
            hist[b.opcode] = (hist[b.opcode] || 0) + 1
          }
          const opcodes = Object.entries(hist).sort((x, y) => y[1] - x[1]).slice(0, topOpcodes)
          const definitions = scripts.filter(s => s.kind === 'definition')
          const oneLine = (s) => ({
            id: s.blockId,
            kind: s.kind,
            name: s.label || s.opcode,
            blocks: s.blockCount,
            at: [s.x, s.y],
            calls: s.calls && s.calls.length ? s.calls.slice(0, 6) : undefined,
            calledBy: s.kind === 'definition' ? s.calledBy : undefined,
            warp: s.kind === 'definition' ? s.warp : undefined
          })
          return {
            name: t.getName(),
            isStage: t.isStage,
            blockCount: counts.total,
            blockCountRaw: counts.raw,
            shadowCount: counts.shadows || undefined,
            scripts: scripts.filter(s => s.kind === 'script').length,
            definitions: definitions.length,
            loose: scripts.filter(s => s.kind === 'loose').length,
            opcodes: Object.fromEntries(opcodes),
            customBlocks: definitions.map(s => ({ proccode: s.proccode, params: s.params, warp: s.warp, calledBy: s.calledBy, scriptId: s.blockId })),
            // 未定义就被调用 / 定义了没人调用 —— 结构性问题的两个典型信号
            unusedDefinitions: definitions.filter(s => !s.calledBy).map(s => s.proccode).filter(Boolean).slice(0, 10),
            headScripts: scripts.filter(s => s.kind !== 'loose').slice(0, scriptsPerTarget).map(oneLine),
            looseHeads: scripts.filter(s => s.kind === 'loose').slice(0, 10).map(oneLine)
          }
        })
        return {
          title: docTitle(),
          editingTarget: vm.editingTarget ? vm.editingTarget.getName() : null,
          extensions: extensions || undefined,
          blockCountView: 'expanded',
          blockCount: targets.reduce((n, t) => n + t.blockCount, 0),
          blockCountRaw: targets.reduce((n, t) => n + t.blockCountRaw, 0),
          targets,
          hint: '要看某段脚本的块体：scratch_read_script({ scriptId })；只看某个分支：read_script({ blockId, branch:"SUBSTACK", depth:2 })；'
            + '单块上下文：scratch_inspect({ blockId })'
        }
      }

      case 'inspect': {
        // F3：插完一块想确认"它落在哪、上面是谁、输入槽都接了什么"——
        // 以前只能整段读（354 块 / 100KB）或整份 snapshot（1.8MB），代价高到不可能做验证。
        const t = findTarget(vm, args && args.target)
        const blocks = t.blocks
        const id = args && args.blockId
        if (!id) throw new Error('blockId 必填')
        const b = blocks.getBlock(id)
        if (!b) throw new Error(`找不到块 ${id}（角色 "${t.getName()}"；先用 list_scripts / read_script summary 拿真实 id）`)
        const desc = (bid) => {
          if (!bid) return null
          const x = blocks.getBlock(bid)
          if (!x) return { id: bid, missing: true }
          return { id: bid, opcode: x.opcode, shadow: !!x.shadow }
        }
        // 内联字面量的值藏在小影子块的字段里 —— 直接给出来，省得 AI 再读一遍
        const literalOf = (bid) => {
          const x = bid ? blocks.getBlock(bid) : null
          if (!x || !x.shadow) return undefined
          const fs = x.fields || {}
          const k = Object.keys(fs)[0]
          return k ? fs[k].value : undefined
        }
        const inputs = {}
        for (const [name, inp] of Object.entries(b.inputs || {})) {
          inputs[name] = {
            block: inp.block || null,
            opcode: inp.block ? (blocks.getBlock(inp.block) || {}).opcode : undefined,
            value: inp.block === inp.shadow || !inp.block ? literalOf(inp.block || inp.shadow) : undefined,
            shadow: inp.shadow && inp.shadow !== inp.block ? inp.shadow : undefined
          }
        }
        let slot = null
        if (b.parent) {
          const s = blockSlot(blocks, b.parent, id)
          slot = s ? (s.input || 'next') : 'stale-parent'
        }
        // 往上找到这条脚本的帽子（顶层块），报告嵌套深度
        let stackTop = id
        let depth = 0
        for (let cur = b.parent; cur && depth < 200; cur = (blocks.getBlock(cur) || {}).parent) {
          stackTop = cur
          depth++
        }
        const topBlock = blocks.getBlock(stackTop)
        return {
          target: t.getName(),
          blockId: id,
          opcode: b.opcode,
          shadow: !!b.shadow,
          topLevel: !b.parent,
          position: { x: b.x, y: b.y },
          fields: Object.fromEntries(Object.entries(b.fields || {}).map(([k, v]) => [k, { value: v.value, id: v.id }])),
          inputs,
          parent: b.parent ? { id: b.parent, opcode: (blocks.getBlock(b.parent) || {}).opcode, slot } : null,
          next: b.next ? { id: b.next, opcode: (blocks.getBlock(b.next) || {}).opcode } : null,
          // 谁指着我（next 链上前一个）—— 用 parent 反查不稳，直接扫一遍
          previous: (() => {
            if (!b.parent) return null
            const p = blocks.getBlock(b.parent)
            return p && p.next === id ? { id: p.id, opcode: p.opcode } : null
          })(),
          script: { topId: stackTop, topOpcode: topBlock ? topBlock.opcode : null, depth, isScript: !!(topBlock && ((vm.runtime._hats || {})[topBlock.opcode])) },
          subtree: { blocks: collectIds(blocks._blocks, id).length },
          mutation: b.mutation ? b.mutation : undefined,
          hint: '改输入值用 scratch_update_block({ blockId, changes:{ inputs:{ 名字: 值 } } })，改字段用 changes.fields'
        }
      }

      case 'click': {
        // 点舞台上的东西。两条路：先按真实鼠标事件走（renderer.pick 命中就是真点击），
        // 没命中再退化到「显式启动这个角色的点击帽子」——克隆体/无渲染环境下 pick 不可靠。
        const rt = vm.runtime
        const a = args || {}
        let target = null
        if (a.target) {
          const cands = findTargets(vm, a.target)
          if (!cands.length) {
            throw new Error(`找不到角色 "${a.target}"，现有: ${(rt.targets || []).map(x => x.getName()).join(', ')}`)
          }
          // 有克隆体时优先"可见且非隐藏"的那个（用户看的也是它）
          const visible = cands.filter(c => c.visible !== false)
          let pool = visible.length ? visible : cands
          if (a.costume) {
            const byCostume = pool.filter(c => {
              try { return c.getCostumes().some(cs => cs.name === a.costume) } catch { return false }
            })
            if (byCostume.length) pool = byCostume
          }
          target = pool[0]
        }
        let sx
        let sy
        if (typeof a.x === 'number' || typeof a.y === 'number') {
          sx = Number(a.x) || 0
          sy = Number(a.y) || 0
        } else if (target) {
          let bounds = null
          try { bounds = target.getBounds() } catch { bounds = null }
          if (bounds && typeof bounds.left === 'number') {
            sx = (bounds.left + bounds.right) / 2
            sy = (bounds.top + bounds.bottom) / 2
          } else {
            // 没有 renderer（headless / 播放器）就拿不出包围盒，退到角色坐标
            sx = target.x || 0
            sy = target.y || 0
          }
        } else {
          throw new Error('要嘛给 target（点这个角色的造型中心）要嘛给 x/y（舞台坐标，范围 -240..240 / -180..180）')
        }
        // mouse.postData 吃的是「画布像素」：scratchX = 480*(x/canvasWidth - 0.5)
        // 所以 canvasWidth=480、canvasHeight=360 时 x = scratchX+240、y = 180-scratchY
        const px = Math.round(sx + 240)
        const py = Math.round(180 - sy)
        const mouse = rt.ioDevices && rt.ioDevices.mouse
        if (!mouse) throw new Error('拿不到 runtime.ioDevices.mouse')
        const threadsBefore = (rt.threads || []).map(th => th.id)
        const idsBefore = new Set(threadsBefore)
        const payload = { x: px, y: py, canvasWidth: 480, canvasHeight: 360, isDown: true }
        // 先自己 pick 一下"这个坐标上到底有没有东西"（F4：以前 hatsStarted:0 但流程确实推进了，
        // 分不清是"没命中"还是"命中了但这个角没有点击帽子"）。renderer 不存在时 pick 会抛，兜住。
        const renderer = rt.renderer
        let pickHit = null
        let pickError = null
        try {
          if (renderer && typeof renderer.pick === 'function') {
            const drawableID = renderer.pick(px, py)
            if (drawableID !== null && drawableID !== undefined && drawableID >= 0) {
              const hit = (rt.targets || []).find(x => x.drawableID === drawableID)
              pickHit = hit
                ? { target: hit.getName(), isClone: !hit.isOriginal, drawableID }
                : { drawableID, target: null }
            }
          }
        } catch (e) { pickError = e && e.message ? e.message : String(e) }
        // ⚠️ postData 在「没有 renderer.pick」的宿主里会抛（headless / 播放器页）。
        //    这种情况不该整个 op 失败 —— 记下原因，走下面的 hat 退化路。
        let postError = null
        try {
          mouse.postData(payload)
          await sleepMs(60)
          mouse.postData(Object.assign({}, payload, { isDown: false }))
          await sleepMs(120)
        } catch (e) {
          postError = e && e.message ? e.message : String(e)
        }
        const started = () => (rt.threads || [])
          .filter(th => th && !idsBefore.has(th.id))
          .map(th => ({
            target: th.target && th.target.getName(),
            opcode: (() => {
              try { const b = th.target && th.target.blocks.getBlock(th.topBlock); return b ? b.opcode : null } catch { return null }
            })()
          }))
        let via = postError ? 'pick-error' : (pickHit ? 'pick' : (renderer && typeof renderer.pick === 'function' ? 'pick-miss' : 'pick'))
        let startedList = started()
        if (!startedList.length && target && a.forceHat !== false) {
          // 退化路：直接按角色启动点击帽子（克隆体的点击也是这样触发的）
          try {
            const th = rt.startHats('event_whenthisspriteclicked', null, target)
            const n = Array.isArray(th) ? th.length : (th ? 1 : 0)
            via = 'hat-fallback'
            startedList = n ? started() : []
            if (!startedList.length && n) startedList = [{ target: target.getName(), opcode: 'event_whenthisspriteclicked' }]
          } catch (e) { via = 'hat-error: ' + e.message }
        }
        const aliveThreads = (rt.threads || []).filter(th => th.status !== 4).length
        return {
          clicked: target ? target.getName() : null,
          isClone: target ? !target.isOriginal : undefined,
          costume: target ? (() => { try { return target.getCostumes()[target.currentCostume].name } catch { return null } })() : undefined,
          stageXY: { x: Math.round(sx), y: Math.round(sy) },
          canvasXY: { x: px, y: py },
          via,
          // pick 的结果：命中谁 / 什么都没命中 / pick 不可用，三种情况分开说
          pick: pickHit || undefined,
          pickMissed: !pickHit && !pickError && !postError ? true : undefined,
          started: startedList.length ? startedList : undefined,
          hatsStarted: startedList.length,
          running: aliveThreads > 0,
          threads: aliveThreads,
          hint: via === 'hat-fallback'
            ? '没启动点击帽子（pick 没命中 / 这个角没有「当角色被点击」），改成直接启动该角色的点击帽子。'
              + (postError ? ` postData 失败原因：${postError}` : '')
            : (startedList.length === 0 && aliveThreads > 0
                ? `这次点击没有启动新线程，但已有 ${aliveThreads} 条线程在跑 —— 流程可能是它们推进的（别据此判断点击失败）。`
                : undefined)
        }
      }

      case 'press_key': {
        const kb = vm.runtime.ioDevices && vm.runtime.ioDevices.keyboard
        if (!kb) throw new Error('拿不到 runtime.ioDevices.keyboard')
        const key = (args && args.key) || ' '
        const holdMs = Math.min(Math.max(Number(args && args.holdMs) || 80, 0), 5000)
        kb.postData({ key, isDown: true })
        if (holdMs) await sleepMs(holdMs)
        kb.postData({ key, isDown: false })
        return { key, holdMs, note: 'key 用 DOM 键名：空格是 " "、"ArrowUp"/"Up"、"Enter"，字母直接给 "a"' }
      }

      case 'profile': {
        // 采样 VM 自己报的步进耗时（runtime.currentStepTime），比项目里那个 fps 变量可信。
        // 默认还做**归因**（attribution）：每隔 100ms 看一眼每个线程正卡在哪个块，
        // 顺着 parent 链归到"哪条脚本"。这样 AI 量出 p95 高之后，下一步就知道去改哪条，
        // 而不是笼统地说"项目慢"。纯只读，不改 VM 任何状态。
        const secs = Math.min(Math.max(Number(args && args.seconds) || 3, 0.5), 10)
        const wantAttr = args.attribution !== false
        const topN = Math.min(Math.max(Number(args && args.topN) || 8, 1), 20)
        const samples = []
        const threadPeak = { n: 0 }
        const attr = {
          ticks: 0, base: 0, wait: 0, opcodes: Object.create(null),
          scripts: Object.create(null), roots: new Map()
        }
        /** 当前线程栈顶块 → 它所属脚本的根（父链走到底）。按 (target,blockId) 缓存，别每次重走 */
        const rootOf = (target, blockId, blocks) => {
          const ck = target.id + '|' + blockId
          const hit = attr.roots.get(ck)
          if (hit !== undefined) return hit
          let cur = blocks[blockId]
          let rootId = blockId
          let guard = 0
          while (cur && cur.parent && blocks[cur.parent] && guard++ < 4000) {
            rootId = cur.parent
            cur = blocks[cur.parent]
          }
          attr.roots.set(ck, rootId)
          return rootId
        }
        const tick = () => {
          attr.ticks++
          const threads = (vm.runtime.threads || []).filter(th => th.status !== 4)
          if (threads.length > threadPeak.n) threadPeak.n = threads.length
          // 极端情况（几千个克隆体同时跑）别把采样本身变成瓶颈：每轮最多看 400 个线程
          const cap = threads.length > 400 ? 400 : threads.length
          const stride = threads.length > 400 ? Math.ceil(threads.length / 400) : 1
          for (let i = 0; i < cap; i += 1) {
            const th = threads[i * stride]
            if (!th) continue
            let blockId = null
            try { blockId = typeof th.peekStack === 'function' ? th.peekStack() : null } catch { blockId = null }
            if (!blockId) continue
            const target = th.target
            const blocks = target && target.blocks && target.blocks._blocks
            if (!blocks || !blocks[blockId]) continue
            const b = blocks[blockId]
            // 「等 1 秒」「等条件」这类是空转，不是吃帧；单独计数，别让它们污染热点排名
            if (b.opcode === 'control_wait' || b.opcode === 'control_wait_until' || b.opcode === 'control_glide_to') {
              attr.wait++
              continue
            }
            attr.base++
            attr.opcodes[b.opcode] = (attr.opcodes[b.opcode] || 0) + 1
            const rootId = rootOf(target, blockId, blocks)
            const root = blocks[rootId] || b
            const key = target.getName() + '#' + rootId
            let s = attr.scripts[key]
            if (!s) {
              s = attr.scripts[key] = {
                target: target.getName(), blockId: rootId, hat: root.opcode,
                label: scriptLabel(blocks, { opcode: root.opcode, blockId: rootId }),
                count: 0, opcodes: Object.create(null)
              }
            }
            s.count++
            s.opcodes[b.opcode] = (s.opcodes[b.opcode] || 0) + 1
          }
        }
        const t0 = Date.now()
        while (Date.now() - t0 < secs * 1000) {
          const v = vm.runtime.currentStepTime
          if (typeof v === 'number' && v > 0) samples.push(v)
          if (wantAttr) tick()
          await sleepMs(100)
        }
        const pct = (p) => (samples.length ? samples.slice().sort((x, y) => x - y)[Math.min(samples.length - 1, Math.floor((samples.length - 1) * p))] : null)
        const avg = samples.length ? samples.reduce((x, y) => x + y, 0) / samples.length : null
        // D4：桌面版实测 stepMs 恒等 33.333（=30fps 的帧帽）—— 那只说明"被帧率卡住"，
        // **看不出还有多少余量**。这里把帧帽和余量一起报，别再让 AI 把它当"刚好跑满"。
        let frameCapMs = null
        try {
          const fr = vm.runtime.framerate
          frameCapMs = typeof fr === 'number' && fr > 0 ? 1000 / fr : 1000 / 30
        } catch { frameCapMs = 1000 / 30 }
        let compiled = false
        try { compiled = !!(vm.runtime.compilerOptions && vm.runtime.compilerOptions.enabled) } catch { compiled = false }
        const atCap = avg !== null && frameCapMs !== null && avg >= frameCapMs * 0.97
        const out = {
          seconds: secs,
          samples: samples.length,
          stepMs: {
            avg: avg && Number(avg.toFixed(2)),
            p50: pct(0.5), p95: pct(0.95), max: samples.length ? Math.max(...samples) : null
          },
          fps: avg ? Number((1000 / avg).toFixed(1)) : null,
          frameCapMs: frameCapMs !== null ? Number(frameCapMs.toFixed(2)) : undefined,
          atFrameCap: atCap || undefined,
          headroomMs: avg !== null && frameCapMs !== null ? Number((frameCapMs - avg).toFixed(2)) : undefined,
          compiler: compiled,
          threadsPeak: threadPeak.n,
          note: 'stepMs = VM 每帧步进耗时（含所有脚本）。fps 由它反推；项目自己的 fps 变量常常是存档残留值，别信。'
            + (atCap ? ' ⚠️ 这次 stepMs 已经顶到帧帽（' + (frameCapMs || 0).toFixed(1) + 'ms = '
              + Math.round(1000 / (frameCapMs || 33.3)) + 'fps 上限）：说明帧时间被帧率闸住，'
              + '**看不出还有多少余量**，只能做改前/改后对比。' : '')
            + (compiled ? ' 编译器开着：块级热点拿不到，别把 100% 挂在帽子块上当成热点。' : '')
        }
        if (wantAttr) {
          const total = attr.base + attr.wait
          const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => [k, v])
          // ⚠️ TurboWarp 的「编译器」开着时（compilerOptions.enabled=true —— 桌面版默认就是），
          // 脚本被编译成 JS 执行，线程栈**不再移动**：真机实测 stack 恒等于 [帽子块]，
          // blockGlowInFrame 也停在帽子上，runtime.profiler 是 null。
          // 所以这时只能给「哪条脚本的线程活着」，给不出块级热点。必须如实说 ——
          // 否则就会把 100% 挂在帽子上，冒充"热点是 event_whenflagclicked"。
          if (compiled) {
            out.attribution = {
              compiled: true,
              granularity: 'script',
              ticks: attr.ticks,
              samples: total,
              scripts: Object.values(attr.scripts).sort((a, b) => b.count - a.count).slice(0, topN).map(s => ({
                target: s.target,
                blockId: s.blockId,
                hat: s.hat,
                label: s.label,
                count: s.count,
                pct: total ? Number((s.count / total * 100).toFixed(1)) : 0
              })),
              note: 'TurboWarp 的编译器开着（compilerOptions.enabled=true）：脚本被编译成 JS 跑，线程栈不移动，'
                + '所以只能看「哪条脚本的线程活着」，看不到块级热点（连"在算还是在等"都分不出来）。'
                + '要块级热点：在 TurboWarp 设置里关掉「编译器」再量一次；或者用 stepMs 做改前/改后对比。'
            }
          } else {
            out.attribution = {
              compiled: false,
              granularity: 'block',
              ticks: attr.ticks,
              samples: total,
              // 热脚本排行：pct 是"有线程卡在这条脚本上的采样占比"
              hot: Object.values(attr.scripts).sort((a, b) => b.count - a.count).slice(0, topN).map(s => ({
                target: s.target,
                blockId: s.blockId,
                hat: s.hat,
                label: s.label,
                count: s.count,
                pct: total ? Number((s.count / total * 100).toFixed(1)) : 0,
                topOpcodes: top(s.opcodes, 3).map(([op, n]) => op + '×' + n)
              })),
              topOpcodes: top(attr.opcodes, topN).map(([op, n]) => ({ opcode: op, count: n, pct: total ? Number((n / total * 100).toFixed(1)) : 0 })),
              waitPct: total ? Number((attr.wait / total * 100).toFixed(1)) : 0,
              idlePct: total ? 0 : 100
            }
          }
          if (!total) {
            out.attribution.hint = '这一轮没有线程在跑（没点绿旗 / 项目是静态的），所以归因为空。先 scratch_run greenflag 再量'
          }
        }
        return out
      }

      case 'user_context': {
        // 最近用户动作（Blockly ui 事件缓存，双向联动数据源）
        const since = args && args.sinceMs ? Date.now() - args.sinceMs : 0
        const recent = userEvents.filter(e => e.at >= since)
        // 当前选中的块：直接问 Blockly，不依赖事件捕获。
        // 事件可能漏（页面比监听器先加载、工作区被重建），但「用户现在在看哪块」随时可查——
        // 这对 agent 来说比事件流更有用。
        let selected = null
        try {
          const B = window.ScratchBlocks || window.Blockly
          const w = getBlocklyWorkspace()
          const b = (B && B.selected) || (w && typeof w.getSelected === 'function' ? w.getSelected() : null)
          if (b && b.id) selected = { blockId: b.id, opcode: b.type }
        } catch { /* 没有工作区就算了 */ }
        return {
          events: recent,
          selected,
          running: vm.runtime.threads.some(th => th.status !== 4 /* STATUS_DONE */),
          note: 'events: 用户选中/点击的块（blockId + opcode + 时间戳）；selected: 当前正选中的块'
        }
      }

      default:
        throw new Error(`未知操作 ${op}`)
    }
  }

  async function handle(msg) {
    try {
      const result = await ops(msg.op, msg.args || {})
      reply(msg.id, true, result)
    } catch (e) {
      reply(msg.id, false, e && e.message || String(e))
    }
  }

  // ---------------- 用户事件回传（双向联动，M0 只埋点） ----------------
  // 用户选中块时通知 dsh 侧（agent.inject 上下文）——M2 完整实现
  // window.addEventListener('block_select', ...) 由 scratch-blocks 派发

  window.__dshBridge = {
    ops, snapshotJson, watchState, userEvents,
    // 状态查询（扩展图标点击时在 MAIN world 读；lab 的真机层也读它）
    // 注意：本页不持有 socket。扩展路径下 linkOk 是 SW 通过 'link' 消息告知的；
    // CDP 路径下同一句话说给插件的 cdp.js 听。想核对"到底谁持有连接"，
    // 扩展路径要读 SW 侧的 __dshBridgeSW.state()（CDP 连 service_worker target）。
    state () {
      const socket = linkOk ? 'open' : (linkReason ? 'closed' : 'connecting')
      const tok = linkVia === 'cdp' ? '不需要' : (tokenSet ? '已配置' : '未配置')
      return `transport=${linkVia} socket=${socket} authed=${linkOk} token=${tok} vm=${typeof window.vm}`
        + (linkReason ? ` reason=${linkReason}` : '')
    },
    linkState: () => ({ linkOk, tokenSet, linkReason, via: linkVia })
  }
  console.info('[dsh-bridge] executor ready, vm =', typeof window.vm, '（本页只做 vm 操作，连接由扩展 SW 或 CDP 持有）')
  // 向 SW 报"执行器就绪"（SW 可能比本脚本晚/早，谁也说不准；20s 心跳里也会带 meta 兜底）
  relaySend('ready', { meta: pageMeta() })

  // M2 事件捕获：vm 未就绪时轮询重试（编辑器 SPA 加载慢）
  ;(function waitVM(n) {
    if (window.vm) { setupUserEventCapture(); return }
    if (n < 60) setTimeout(() => waitVM(n + 1), 1000)
  })(0)
})()
