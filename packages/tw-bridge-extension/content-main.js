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
  let linkOk = false      // SW 侧的 socket 是否已握手通过（由 SW 告知，本页自己判断不了）
  let tokenSet = false    // 仅供状态展示：SW 手里有没有 token
  let linkReason = ''     // 断开原因（握手超时/token 不对…）

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
      if (linkOk && !wasOk) console.info('[dsh-bridge] 桥已连上（socket 在扩展 SW 里）')
      if (!linkOk && linkReason) console.warn('[dsh-bridge] ' + linkReason)
      return
    }
  })

  // ---------------- M2 状态：观察者 + 用户事件缓存 ----------------
  const watchState = { timer: null, targetName: null, values: {}, queue: [] }
  const userEvents = [] // {type, blockId, opcode, at} 最近 20 条

  function watchTick() {
    // 轮询变量变化，推帧给插件侧。合并两层：Stage 全局变量 + 目标角色局部变量
    try {
      const vm = window.vm
      if (!vm || !watchState.targetName) return
      const stage = vm.runtime.getTargetForStage()
      const t = vm.runtime.targets.find(t => t.getName() === watchState.targetName)
      if (!t) return
      const changes = []
      const check = (target, scope) => {
        if (!target) return
        for (const [id, v] of Object.entries(target.variables)) {
          const key = scope + ':' + v.name
          if (!Object.prototype.hasOwnProperty.call(watchState.values, key) || watchState.values[key] !== v.value) {
            changes.push({ name: v.name, scope, from: watchState.values[key], to: v.value })
            watchState.values[key] = v.value
          }
        }
      }
      check(stage, 'global')
      check(t, 'local')
      if (changes.length) {
        // 本地队列**无条件**记：scratch_watch 的 poll 读的就是这个队列，
        // 断线时也照样采（重连后用户还能看到断线期间的变化）。
        // ⚠️ 之前把整段记在 `if (linkOk)` 里 → 一旦没连上，轨迹就永远是空的（真机抓到过）。
        watchState.queue.push(...changes.map(c => Object.assign({ at: Date.now() }, c)))
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
        const t = findTarget(vm, args && args.target)
        return { target: t.getName(), blocks: t.blocks._blocks, variables: t.variables }
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
        const t = findTarget(vm, args && args.target)
        const ws = getBlocklyWorkspace()
        if (!ws) {
          throw new Error('拿不到 Blockly workspace（积木区还没挂载 / 这是播放器页；scratch.mit.edu 新版编辑器不暴露 window.Blockly）')
        }
        // 先在 VM 里确认这个块真的存在：不存在就没必要等着 GUI 慢慢渲染（否则要空转 1 秒多）
        if (!t.blocks.getBlock(args.blockId)) {
          throw new Error(`找不到块 ${args.blockId}（角色 "${t.getName()}" 里没有这个 ID；它可能已被 add_blocks 换新，用 scratch_read_script 重读一次）`)
        }
        // 存在但可能还没渲染：先切角色刷新，再重试等 GUI 重建完
        if (vm.editingTarget && vm.editingTarget.id !== t.id) {
          vm.setEditingTarget(t.id)
          safeEmitWorkspaceUpdate(vm)
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
          // 返回 {全局+局部变量名: 值} 扁平视图
          const stage = vm.runtime.getTargetForStage()
          const t = vm.runtime.targets.find(t => t.getName() === watchState.targetName)
          const out = {}
          if (stage) for (const v of Object.values(stage.variables)) out[v.name] = v.value
          if (t) for (const v of Object.values(t.variables)) out[v.name] = v.value
          return out
        }
        if (action === 'start') {
          const t = findTarget(vm, args && args.target)
          watchState.targetName = t.getName()
          watchState.values = {}
          if (watchState.timer) clearInterval(watchState.timer)
          watchState.timer = setInterval(watchTick, 500)
          watchTick() // 立即首采
          return { watching: watchState.targetName, variables: Object.keys(collectVars()) }
        }
        if (action === 'stop') {
          if (watchState.timer) clearInterval(watchState.timer)
          watchState.timer = null
          return { stopped: true }
        }
        // poll：返回当前值 + 清空变化队列
        const changes = watchState.queue.splice(0)
        return { current: collectVars(), changes, watching: watchState.targetName }
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
    // 注意：socket 不在本页，linkOk 是 SW 通过 'link' 消息告知的。
    // 想核对"到底谁持有 socket"，要读 SW 侧的 __dshBridgeSW.state()（CDP 连 service_worker target）。
    state () {
      const socket = linkOk ? 'open' : (linkReason ? 'closed' : 'connecting')
      return `transport=sw socket=${socket} authed=${linkOk} token=${tokenSet ? '已配置' : '未配置'} vm=${typeof window.vm}`
        + (linkReason ? ` reason=${linkReason}` : '')
    },
    linkState: () => ({ linkOk, tokenSet, linkReason })
  }
  console.info('[dsh-bridge] executor ready, vm =', typeof window.vm, '（socket 在扩展 SW，本页只做 vm 操作）')
  // 向 SW 报"执行器就绪"（SW 可能比本脚本晚/早，谁也说不准；20s 心跳里也会带 meta 兜底）
  relaySend('ready', { meta: pageMeta() })

  // M2 事件捕获：vm 未就绪时轮询重试（编辑器 SPA 加载慢）
  ;(function waitVM(n) {
    if (window.vm) { setupUserEventCapture(); return }
    if (n < 60) setTimeout(() => waitVM(n + 1), 1000)
  })(0)
})()
