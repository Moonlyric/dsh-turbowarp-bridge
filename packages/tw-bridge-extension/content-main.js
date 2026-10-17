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
   * 脚本索引：顶层块清单。
   * ⚠️ 关键区分：真脚本（帽子块打头）vs **游离块**（作者调试拖出来的孤立块）。
   * 真机实测某角色 185 个顶层块里约 150 个是游离块 —— 不区分的话"按块数排名"全是噪音。
   * 判定用 runtime._hats（VM 自己注册的帽子表），不靠 opcode 前缀猜。
   */
  function scriptIndex(vm, t) {
    const blocks = t.blocks._blocks
    const hats = (vm.runtime && vm.runtime._hats) || {}
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
      out.push({
        blockId: id,
        opcode: b.opcode,
        kind: hats[b.opcode] ? 'script' : 'loose',
        blockCount: ids.length,
        x: b.x, y: b.y,
        calls: calls.length ? calls : undefined
      })
    }
    // 真脚本在前（块数降序），游离块垫底（块数降序）
    out.sort((a, b2) => {
      if (a.kind !== b2.kind) return a.kind === 'script' ? -1 : 1
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
   * @returns {{blocks: Array, index: Object, warnings: string[]}}
   *   index: AI 给的块 id → 它在 blocks 数组里的下标（用于反推注入后的新 id）
   */
  function toLiveBlocks(dict) {
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
        // 没给坐标的顶层块自动往下排，免得全叠在 (0,0) 让用户找不到
        const hasXY = Number.isFinite(src.x) && Number.isFinite(src.y)
        blk.x = hasXY ? src.x : 48
        blk.y = hasXY ? src.y : 48 + topLevelSeen * 150
        if (!hasXY) topLevelSeen++
      }
      index[oldId] = push(blk) // 先占下标，再转换（转换会把影子块追加在这个块后面）
      blk.inputs = deserializeInputs(src.inputs, oldId)
      blk.fields = deserializeFields(src.fields)
    }
    return { blocks: out, index, warnings }
  }

  async function ops(op, args) {
    const vm = getVM()
    switch (op) {
      case 'project_meta': {
        const pj = snapshotJson(vm)
        return {
          title: document.title.replace(/ - TurboWarp$/, ''),
          extensions: pj.extensions,
          // AI 写积木时要知道"现在光标在哪个角色上"（read_script 缺省也用它）
          editingTarget: vm.editingTarget ? vm.editingTarget.getName() : null,
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
        let pj = snapshotJson(vm)
        if (args && args.target) pj = { targets: pj.targets.filter(t => t.name === args.target || t.isStage) }
        return pj
      }
      case 'read_script': {
        // 瘦身版（问题记录 P2-2 / §15.4）：以前无论要什么，都回「全部块 + 全部变量」，
        // 真机踩过 Stage 26 个块却回 7.5MB（全是 variables 里的长列表）、按钮 475KB。
        // 现在默认：只回块、不回变量、块数超上限要分页，并且**总是带脚本索引**（很小、最有用）。
        const t = findTarget(vm, args && args.target)
        const a = args || {}
        const blocks = t.blocks._blocks
        const allIds = Object.keys(blocks)
        const scripts = scriptIndex(vm, t).map(s => Object.assign(s, { label: scriptLabel(blocks, s) }))
        const meta = {
          target: t.getName(),
          isClone: !t.isOriginal,
          blockCount: allIds.length,
          scriptCount: scripts.filter(s => s.kind === 'script').length,
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

        // 选块集合：单个脚本 > opcode 过滤 > 全部
        let ids
        const root = a.scriptId || a.topLevelBlockId
        if (root) {
          if (!blocks[root]) {
            throw new Error(`找不到脚本 ${root}（角色 "${t.getName()}" 里没有这个块 id；先用 summary:true 拿清单）`)
          }
          ids = collectIds(blocks, root)
        } else {
          ids = allIds
        }
        const opFilters = Array.isArray(a.opcodes) ? a.opcodes.filter(Boolean) : (a.opcodes ? [a.opcodes] : null)
        if (opFilters && opFilters.length) {
          const set = new Set(opFilters)
          ids = ids.filter(id => blocks[id] && set.has(blocks[id].opcode))
        }
        const offset = Math.min(Math.max(Number(a.offset) || 0, 0), ids.length)
        // 缺省上限 1500 块：够读绝大多数角色，又不至于把上下文打爆
        const limit = Math.min(Math.max(Number(a.limit) || 1500, 1), 20000)
        const page = ids.slice(offset, offset + limit)
        const out = Object.assign(meta, {
          returned: page.length,
          filteredCount: ids.length,
          offset: offset || undefined,
          hasMore: offset + page.length < ids.length || undefined,
          blocks: {}
        })
        for (const id of page) out.blocks[id] = blocks[id]
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
        if (!root && !opFilters) out.scripts = scripts.slice(0, Number(a.scriptLimit) || 60)
        if (out.hasMore) {
          out.hint = `只回了 ${page.length}/${ids.length} 块（offset=${offset}）。用 offset 翻页、或 scriptId/opcodes 收窄。`
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
        const { blocks: liveBlocks, index, warnings } = toLiveBlocks(input)
        if (!liveBlocks.length) throw new Error('blocks 里没有可注入的块')

        const before = new Set(Object.keys(t.blocks._blocks))
        await vm.shareBlocksToTarget(liveBlocks, t.id)
        const newIds = Object.keys(t.blocks._blocks).filter(id => !before.has(id))

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

        // 触发 GUI 刷新（用户实时看到新积木）
        safeEmitWorkspaceUpdate(vm)
        return {
          added: newIds.length,
          inputBlocks: Object.keys(index).length,
          // 送进去的是"展开后"的活块（每个 inline 字面量都会变成独立影子块），块数必然更多
          expandedBlocks: liveBlocks.length,
          idMap,
          idMapReliable,
          warnings: warnings.length ? warnings : undefined,
          hint: idMapReliable
            ? '后续引用新块请用 idMap 里的新 ID（shareBlocksToTarget 会全部换新 ID）'
            : 'idMap 不可靠（opcode 校验没过），请用 scratch_read_script 重新读一次拿真实 ID'
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
        const t = findTarget(vm, args && args.target)
        const storage = vm.runtime.storage
        if (!storage) throw new Error('storage 不可用')
        const asset = storage.createAsset(
          storage.AssetType.ImageVector, 'svg', args.svg, null, true
        )
        const md5ext = asset.assetId + '.' + asset.dataFormat
        await vm.addCostume(md5ext, {
          name: args.name || 'ai-costume',
          assetId: asset.assetId, // 5.x 序列化器直接读此字段（缺了会导致快照 sb3 验证失败）
          md5ext, dataFormat: 'svg',
          asset // load-costume 会从它派生 md5 / dataFormat
          // 故意不给 rotationCenterX/Y：留空时 load-costume 会用 renderer.getSkinRotationCenter
          // 按真实图形算旋转中心（load-costume.js:409-412）。硬编码 48/50 会把任意尺寸的
          // SVG 旋转中心都钉死在 (48,50)，转起来就歪。
        }, t.id)
        return { costume: args.name || 'ai-costume', md5ext }
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
          const input = target.inputs[name]
          if (!input) {
            throw new Error(`块 ${id} 没有输入 "${name}"（现有: ${Object.keys(target.inputs).join(', ') || '无'}）`)
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

          // 分支 1：接上一个已存在的块（sb3 形态 [1, '块id']）
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
          const shadowId = input.shadow || input.block
          const shadow = shadowId ? blocks.getBlock(shadowId) : null
          if (!shadow) {
            throw new Error(`输入 ${name} 没有影子块，无法写值（现有形态: ${JSON.stringify(input)}）`)
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
        const after = blocks.getBlock(id)
        return {
          updated: id,
          applied,
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
        const before = runtimeState(vm)
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
        const wait = Math.min(Math.max(Number(args && args.waitMs) || 300, 0), 5000)
        if (wait) await sleepMs(wait)
        const after = runtimeState(vm)
        return {
          action,
          before: { running: before.running, threads: before.threads },
          after,
          hint: action === 'greenflag' && !after.running
            ? '绿旗点了，但没有任何线程在跑 —— 项目可能没有接绿旗的脚本，或者脚本第一帧就结束了（这种是正常现象）'
            : undefined
        }
      }

      case 'state': {
        const st = runtimeState(vm, {
          targetName: args && args.target,
          includeLists: !!(args && args.includeLists === true)
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
        return st
      }

      case 'list_scripts': {
        const t = findTarget(vm, args && args.target)
        const blocks = t.blocks._blocks
        const all = scriptIndex(vm, t).map(s => Object.assign(s, { label: scriptLabel(blocks, s) }))
        const minBlocks = Number(args && args.minBlocks) || 0
        const kind = (args && args.kind) || 'all' // all | script | loose
        const list = all.filter(s => s.blockCount >= minBlocks && (kind === 'all' || s.kind === kind))
        const limit = Math.min(Math.max(Number(args && args.limit) || 100, 1), 500)
        return {
          target: t.getName(),
          isClone: !t.isOriginal,
          blockCount: Object.keys(blocks).length,
          scriptCount: all.filter(s => s.kind === 'script').length,
          looseCount: all.filter(s => s.kind === 'loose').length,
          returned: Math.min(list.length, limit),
          scripts: list.slice(0, limit),
          note: 'kind=script 是帽子块打头的真脚本；kind=loose 是作者拖出来的游离块（没有帽子、不会自己运行）。'
            + '看某段脚本的块体：scratch_read_script({ scriptId: blockId })'
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
        const threadsBefore = (rt.threads || []).length
        const payload = { x: px, y: py, canvasWidth: 480, canvasHeight: 360, isDown: true }
        // ⚠️ postData 在「没有 renderer.pick」的宿主里会抛（headless / 播放器页）。
        //    这种情况不该整个 op 失败 —— 记下原因，走下面的 hat 退化路。
        let pickError = null
        try {
          mouse.postData(payload)
          await sleepMs(60)
          mouse.postData(Object.assign({}, payload, { isDown: false }))
          await sleepMs(120)
        } catch (e) {
          pickError = e && e.message ? e.message : String(e)
        }
        let via = pickError ? 'pick-error' : 'pick'
        let hats = (rt.threads || []).length - threadsBefore
        if (hats <= 0 && target && a.forceHat !== false) {
          // 退化路：直接按角色启动点击帽子（克隆体的点击也是这样触发的）
          try {
            const th = rt.startHats('event_whenthisspriteclicked', null, target)
            hats = Array.isArray(th) ? th.length : (th ? 1 : 0)
            via = 'hat-fallback'
          } catch (e) { via = 'hat-error: ' + e.message }
        }
        return {
          clicked: target ? target.getName() : null,
          isClone: target ? !target.isOriginal : undefined,
          costume: target ? (() => { try { return target.getCostumes()[target.currentCostume].name } catch { return null } })() : undefined,
          stageXY: { x: Math.round(sx), y: Math.round(sy) },
          canvasXY: { x: px, y: py },
          via,
          hatsStarted: Math.max(hats, 0),
          running: (rt.threads || []).some(th => th.status !== 4),
          hint: via === 'hat-fallback'
            ? '没走 renderer.pick（无渲染/没点中），改成直接启动该角色的「当角色被点击」帽子。'
              + (pickError ? ` pick 失败原因：${pickError}` : '')
            : undefined
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
        // 采样 VM 自己报的步进耗时（runtime.currentStepTime），比项目里那个 fps 变量可信
        const secs = Math.min(Math.max(Number(args && args.seconds) || 3, 0.5), 10)
        const samples = []
        const threadPeak = { n: 0 }
        const t0 = Date.now()
        while (Date.now() - t0 < secs * 1000) {
          const v = vm.runtime.currentStepTime
          if (typeof v === 'number' && v > 0) samples.push(v)
          const active = (vm.runtime.threads || []).filter(th => th.status !== 4).length
          if (active > threadPeak.n) threadPeak.n = active
          await sleepMs(100)
        }
        const pct = (p) => (samples.length ? samples.slice().sort((x, y) => x - y)[Math.min(samples.length - 1, Math.floor((samples.length - 1) * p))] : null)
        const avg = samples.length ? samples.reduce((x, y) => x + y, 0) / samples.length : null
        return {
          seconds: secs,
          samples: samples.length,
          stepMs: {
            avg: avg && Number(avg.toFixed(2)),
            p50: pct(0.5), p95: pct(0.95), max: samples.length ? Math.max(...samples) : null
          },
          fps: avg ? Number((1000 / avg).toFixed(1)) : null,
          threadsPeak: threadPeak.n,
          note: 'stepMs = VM 每帧步进耗时（含所有脚本）。fps 由它反推；项目自己的 fps 变量常常是存档残留值，别信。'
        }
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
