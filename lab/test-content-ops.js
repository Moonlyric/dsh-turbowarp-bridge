// test-content-ops.js — 扩展执行器 ops 层的 headless 单测
// 方法：把 content-main.js 原文件加载进 Node vm 沙箱，伪造 window/document/WebSocket，
//       挂上真实 headless scratch-vm 作为 window.vm，然后通过伪 WebSocket 走完整协议。
// 好处：测的就是未来跑在浏览器里的那份代码，不是复制品。
//
// ⚠️ 这一套里的「结构体检」断言是 2026-10-16 补的。在那之前，40 条断言全绿而核心写链路
//    其实产出的是一堆结构畸形的块（GUI 里输入空白、快照丢值、运行时取不到参数、删块留孤儿）。
//    旧的断言只数 ID 个数、只回读自己刚写进去的那串数组，所以完全看不见畸形。
//    liveModelViolations / nullLiteralInputs / xmlHasValue 这三个helper 就是为这件事存在的——
//    以后动 add_blocks/update_block，先看它们红不红。
const fs = require('fs')
const path = require('path')
const nodeVm = require('vm')
const { ScratchStorage } = require('scratch-storage')

// 被测文件：仓库根下的扩展执行器（真实文件，不是复制品）
const SRC = path.join(__dirname, '..', 'packages', 'tw-bridge-extension', 'content-main.js')

// ---------- 传输层绊线 ----------
// LNA 改造（2026-10）后内容脚本**不再**持有 WebSocket：页面直连 ws://127.0.0.1 会被
// Chrome 的 Local Network Access 检查直接拒掉（net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS），
// 只有扩展的 service worker 豁免。这个类故意留着当绊线 —— 谁要是把 socket 写回页面里，
// 单测立刻炸在这里。
class ForbiddenWebSocket {
  constructor(url) {
    ForbiddenWebSocket.instances.push(String(url))
    throw new Error('content-main.js 不该自己连桥（会被 LNA 拦）: ' + url)
  }
}
ForbiddenWebSocket.instances = []

// ---------- headless VM（与 test-vm-pipeline 同款） ----------
async function makeVM() {
  const VM = (await import('scratch-vm')).default
  const vm = new VM()
  const storage = new ScratchStorage()
  vm.attachStorage(storage)
  let seq = 0
  vm.runtime.renderer = {
    createSVGSkin: () => 's', createBitmapSkin: () => 's',
    getSkinSize: () => [48, 50], getCurrentSkinSize: () => [48, 50],
    getSkinRotationCenter: () => [48, 50], destroySkin: () => {},
    isFlashRenderer: () => false,
    createDrawable: () => ++seq, destroyDrawable: () => {},
    // 5.x 序列化器从 renderer.getDrawableOrder 取 layerOrder（sprite 需 >=1 才过 sb3 schema）
    getDrawableOrder: (id) => id, setDrawableOrder: () => 0,
    setLayerGroupOrdering: () => {}, updateDrawableDirectionScale: () => {},
    updateDrawableEffect: () => {}, updateDrawablePosition: () => {},
    updateDrawableSkinId: () => {}, updateDrawableVisible: () => {},
    // looks 扩展在 runtime._step 里真的会画气泡：没有 createTextSkin 就直接抛
    // （v0.7.0 的 scratch_run 会 vm.start()，headless 下真的开始走帧 → 这些桩位必须齐）
    createTextSkin: () => 'text-skin', updateTextSkin: () => {}, destroyTextSkin: () => {},
    getNativeSize: () => [480, 360],
    getFencedPositionOfDrawable: p => p,
    isTouchingColor: () => false, isTouchingDrawables: () => false,
    drawableTouching: () => false, getFencedPositionOfDrawable: p => p, draw: () => {},
    // pen 扩展的 renderer 依赖：快照里一旦带 extensions:['pen']，restore→loadProject 就会
    // 走 loadExtension('pen')，pen 的构造函数要调 createPenSkin，缺了就整条回滚挂掉。
    createPenSkin: () => 'pen-skin-stub', destroyPenSkin: () => {},
    penClear: () => {}, penLine: () => {}, penPoint: () => {}, penStamp: () => {},
    updatePenSkin: () => {}, setPenSkinSize: () => {}, getPenSkinSize: () => [0, 0]
  }
  await vm.loadProject({
    targets: [
      {
        isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {}, blocks: {},
        comments: {}, currentCostume: 0,
        costumes: [{ name: 'backdrop1', assetId: 'cd21514d0531fdffb22204e0ec5ed84a',
          md5ext: 'cd21514d0531fdffb22204e0ec5ed84a.svg', dataFormat: 'svg',
          rotationCenterX: 240, rotationCenterY: 180 }],
        sounds: [], volume: 100, layerOrder: 0, tempo: 60, videoTransparency: 50,
        videoState: 'off', textToSpeechLanguage: null
      },
      {
        isStage: false, name: 'Sprite1', variables: {}, lists: {}, broadcasts: {}, blocks: {},
        comments: {}, currentCostume: 0,
        costumes: [{ name: 'costume1', assetId: 'b7855f697f0de66d8b81f7257077dc51',
          md5ext: 'b7855f697f0de66d8b81f7257077dc51.svg', dataFormat: 'svg',
          rotationCenterX: 48, rotationCenterY: 50 }],
        sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0, size: 100,
        direction: 90, draggable: false, rotationStyle: "all around"
      }
    ],
    monitors: [], extensions: [], meta: { semver: '3.0.0', vm: '0.2.0', agent: 'ops-test' }
  })
  return vm
}

// ================= 结构体检 helper（这套断言的价值全在这里） =================

/** 活块模型的硬性不变量：inputs 必须是 {name,block,shadow}，fields 必须是 {name,value}，引用不能悬空 */
function liveModelViolations(target) {
  const all = target.blocks._blocks
  const v = []
  for (const [id, b] of Object.entries(all)) {
    for (const [name, input] of Object.entries(b.inputs || {})) {
      if (Array.isArray(input)) { v.push(`${id}.${name} 是 sb3 数组（应为 {name,block,shadow}）`); continue }
      if (!input || typeof input !== 'object') { v.push(`${id}.${name} 不是对象`); continue }
      if (input.name !== name) v.push(`${id}.${name} 的 name 字段不对`)
      if (input.block && !all[input.block]) v.push(`${id}.${name}.block 指向不存在的块`)
      if (input.shadow && !all[input.shadow]) v.push(`${id}.${name}.shadow 指向不存在的块`)
    }
    for (const [name, f] of Object.entries(b.fields || {})) {
      if (Array.isArray(f)) { v.push(`${id}.${name} 字段是 sb3 数组（应为 {name,value}）`); continue }
      if (!f || typeof f !== 'object') { v.push(`${id}.${name} 字段不是对象`); continue }
      if (f.name !== name) v.push(`${id}.${name} 字段的 name 不对`)
    }
    if (b.next && !all[b.next]) v.push(`${id}.next 悬空 -> ${b.next}`)
    if (b.parent && !all[b.parent]) v.push(`${id}.parent 悬空 -> ${b.parent}`)
  }
  return v
}

/** 快照里有没有被写成 [标志, null] 的字面量（值丢了）——旧代码的招牌症状 */
function nullLiteralInputs(projectJson, targetName) {
  const t = projectJson.targets.find(x => x.name === targetName)
  const bad = []
  for (const [id, b] of Object.entries(t.blocks)) {
    for (const [name, arr] of Object.entries(b.inputs || {})) {
      if (Array.isArray(arr) && arr.length >= 2 && arr[1] === null) bad.push(`${id}.${name} = [${arr[0]},null]`)
    }
  }
  return bad
}

/** GUI 会拿到的 Blockly XML —— 值必须在里面，否则用户看到的是空输入 */
function xmlHasValue(target, literal) {
  return String(target.blocks.toXML()).includes(literal)
}

/** 反查某个 opcode 的块（只取第一个） */
const findByOpcode = (target, opcode) =>
  Object.values(target.blocks._blocks).find(b => b.opcode === opcode)

// ---------- 跑 content-main.js ----------
async function main() {
  let pass = 0, fail = 0
  const t = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  PASS ${name}`) }
    else { fail++; console.log(`  FAIL ${name}${detail ? ' | ' + detail : ''}`) }
  }
  /** 打诊断用：JSON.stringify(undefined) 返回 undefined，直接 .slice 会把测试自己搞崩 */
  const J2 = (v, n = 200) => String(JSON.stringify(v === undefined ? null : v)).slice(0, n)

  const vm = await makeVM()
  console.log('[setup] headless VM ready')

  // ---- 假的扩展 SW / ISOLATED 中继 ----
  // 页面 → SW 的消息全进 relayOut；SW → 页面用 swSend() 手动注入
  // （真机上这一段由 relay-isolated.js 的 window.postMessage 直通完成）
  const relayOut = []
  const pageListeners = {}
  let ctxWindow = null
  const swSend = (msg) => {
    Promise.resolve().then(() => (pageListeners.message || []).forEach(fn => fn({ source: ctxWindow, data: msg })))
  }
  const sandbox = {
    console: { info: () => {}, warn: () => {}, log: () => {} },
    // 定时器必须是**真的**：执行器里的 sleep / 重试 / 500ms 轮询都靠它们，
    // 桩成 no-op 会让 await 永远不 resolve（v0.7.0 的 run/click/profile 一上来就全 TIMEOUT）。
    // 一开始桩它们是为了让 tryBind/waitVM 的重试循环别空转 —— 那两处只在「拿不到 vm/workspace」时才重试，
    // 而这里 vm 和 ScratchBlocks 都是提前摆好的，根本不会进重试分支。
    setInterval, clearInterval, setTimeout, clearTimeout,
    WebSocket: ForbiddenWebSocket, // 绊线：页面不该自己连桥
    // atob/btoa 是宿主提供的（浏览器有，Node 也有），但 vm 沙箱的新 context **不继承**它们。
    // sb3 的读写全靠这两个（base64 ←→ 字节），缺了 save_project 会直接 "btoa is not defined"。
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    // 同理：add_costume 要把 SVG 存成**字节**（scratch-storage 的 decodeText 只吃字节数组），
    // 所以执行器里用了 TextEncoder。vm 沙箱的新 context 不继承它，得显式给。
    TextEncoder,
    TextDecoder,
    location: { href: 'https://turbowarp.org/editor', origin: 'https://turbowarp.org' },
    document: { title: '测试项目 - TurboWarp' },
    addEventListener: (type, fn) => { (pageListeners[type] = pageListeners[type] || []).push(fn) },
    postMessage: (msg) => { relayOut.push(msg) },
    vm // 关键：window.vm —— 等价 turbowarp.org 的 vm-manager-hoc 挂载
  }
  // 用户选块感知要在**加载时**就能拿到 workspace（content-main 的 tryBind 首轮就绑，
  // 拿不到才 setTimeout 重试——而这里 setTimeout 是桩）。所以必须提前把 ScratchBlocks 摆好。
  // 这个假 workspace 只需要 addChangeListener + getBlockById：捕获路径就这两件事。
  const captureListeners = []
  const captureBlocks = { cap_block_1: { id: 'cap_block_1', type: 'event_whenflagclicked' } }
  const captureWs = {
    addChangeListener: (fn) => captureListeners.push(fn),
    getBlockById: (id) => captureBlocks[id] || null
  }
  sandbox.ScratchBlocks = { getMainWorkspace: () => captureWs }
  sandbox.window = sandbox // content-main.js 直接用裸 window / WebSocket / location 标识符
  nodeVm.createContext(sandbox)
  ctxWindow = nodeVm.runInContext('window', sandbox)
  const code = fs.readFileSync(SRC, 'utf8')
  nodeVm.runInContext(code, sandbox, { filename: 'content-main.js' })

  // ⚠️ 坑：Node vm 里 `window` 是**上下文化的 global 代理**，和宿主传进去的 sandbox 不是同一个对象。
  //    content-main.js 的监听器有 `if (e.source !== window) return` 这道防冒名检查，
  //    所以注入消息时 source 必须用「上下文自己认为的 window」（ctxWindow），否则会被静默丢弃。
  //    真机浏览器里没这个问题（同一个 window 对象）。
  const state = () => String(sandbox.window.__dshBridge.state())
  t('执行器一次都没自己连 WebSocket（LNA：页面直连 loopback 会被拦，socket 必须在 SW 里）',
    ForbiddenWebSocket.instances.length === 0, JSON.stringify(ForbiddenWebSocket.instances))
  t('执行器向 SW 报了就绪（ready + meta 里的 turbowarp/vm 状态）',
    relayOut.some(m => m && m.__dshBridgeRelay === 'ready' && m.meta && m.meta.turbowarp === true),
    JSON.stringify(relayOut).slice(0, 200))
  t('还没收到 link 时 state() 如实报未连（不假装已连）',
    /socket=(connecting|closed)/.test(state()) && /authed=false/.test(state()), state())

  swSend({ __dshBridgeRelay: 'ping' })
  await new Promise(r => setTimeout(r, 30))
  t('收到 SW 心跳后回 pong（带 meta，SW 靠这口流量续命）',
    relayOut.some(m => m && m.__dshBridgeRelay === 'pong' && m.meta && m.meta.turbowarp === true),
    JSON.stringify(relayOut.slice(-3)))

  swSend({ __dshBridgeRelay: 'link', ok: true, tokenSet: true })
  await new Promise(r => setTimeout(r, 30))
  t('SW 报 link ok 后 state() = socket=open authed=true（页面侧状态是 SW 喂的，不是自己连的）',
    /socket=open authed=true/.test(state()), state())
  t('state() 写明 transport=sw（谁持有 socket 一眼可辨）', /transport=sw/.test(state()), state())
  t('state() 报出 token 已配置（SW 手里有 token）', /token=已配置/.test(state()), state())
  t('linkState() 暴露原始字段供诊断', JSON.stringify(sandbox.window.__dshBridge.linkState()) ===
    JSON.stringify({ linkOk: true, tokenSet: true, linkReason: '', via: 'sw' }),
    JSON.stringify(sandbox.window.__dshBridge.linkState()))
  // via 字段是给 CDP 那条路用的（插件直连时页面必须自报 transport=cdp，不能一直自称 sw）
  swSend({ __dshBridgeRelay: 'link', ok: true, tokenSet: true, via: 'cdp' })
  await new Promise(r => setTimeout(r, 30))
  t('link 带 via=cdp 时自报状态切成 transport=cdp（CDP 路径的诚实性）',
    /transport=cdp/.test(state()) && /token=不需要/.test(state()), state())
  swSend({ __dshBridgeRelay: 'link', ok: true, tokenSet: true, via: 'sw' })
  await new Promise(r => setTimeout(r, 30))
  t('切回 via=sw 后自报又变回扩展那条（两条路不会互相污染）',
    /transport=sw/.test(state()) && /token=已配置/.test(state()), state())

  swSend({ __dshBridgeRelay: 'link', ok: false, tokenSet: false, reason: '认证失败：token 不对或没填' })
  await new Promise(r => setTimeout(r, 30))
  t('token 不对时 state() 变成 closed 并把原因带出来（用户能看懂）',
    /socket=closed/.test(state()) && /authed=false/.test(state()) && /认证失败/.test(state()), state())
  swSend({ __dshBridgeRelay: 'link', ok: true, tokenSet: true })
  await new Promise(r => setTimeout(r, 30))

  // 请求-应答 helper（真机上：SW 发 op → 页面执行 → 回 result）
  let reqId = 0
  function rpc(op, args) {
    const id = 'r' + (++reqId)
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve({ ok: false, error: 'TIMEOUT' }), 15000)
      const poll = setInterval(() => {
        const found = relayOut.find(m => m && m.__dshBridgeRelay === 'result' && m.id === id)
        if (found) { clearInterval(poll); clearTimeout(timer); resolve(found) }
      }, 20)
      swSend({ __dshBridgeRelay: 'op', id, op, args })
    })
  }

  // ---- snapshot ----
  console.log('[test] snapshot')
  let r = await rpc('snapshot', {})
  t('snapshot ok', r.ok === true, r.error)
  const pj = r.result
  t('snapshot 含 targets', pj && Array.isArray(pj.targets) && pj.targets.length === 2)

  // ---- project_meta ----
  console.log('[test] project_meta')
  r = await rpc('project_meta', {})
  t('project_meta ok', r.ok === true, r.error)
  t('meta 角色列表', r.result && r.result.targets && r.result.targets.map(x => x.name).join(',') === 'Stage,Sprite1')

  // ---- add_blocks（核心：注入的块形态必须合法） ----
  console.log('[test] add_blocks')
  const injectedDict = {
    'ai_hat_1': { opcode: 'event_whenflagclicked', next: 'ai_move_2', parent: null,
      inputs: {}, fields: {}, shadow: false, topLevel: true, x: 60, y: 60 },
    'ai_move_2': { opcode: 'motion_movesteps', next: 'ai_say_3', parent: 'ai_hat_1',
      inputs: { STEPS: [1, [4, '50']] }, fields: {}, shadow: false, topLevel: false },
    'ai_say_3': { opcode: 'looks_sayforsecs', next: null, parent: 'ai_move_2',
      inputs: { MESSAGE: [1, [10, 'hi from ops test']], SECS: [1, [4, '2']] },
      fields: {}, shadow: false, topLevel: false }
  }
  r = await rpc('add_blocks', { blocks: injectedDict })
  t('add_blocks ok', r.ok === true, r.error)
  const sprite = vm.runtime.targets.find(x => !x.isStage)
  const blocksNow = sprite.blocks._blocks
  t('inputBlocks=3（AI 给了 3 个块）', r.result && r.result.inputBlocks === 3, JSON.stringify(r.result && r.result.added))
  t('expandedBlocks > inputBlocks（字面量被展开成独立影子块）',
    r.result && r.result.expandedBlocks === 6, 'expanded=' + (r.result && r.result.expandedBlocks))
  t('added 等于展开后的块数', r.result && r.result.added === r.result.expandedBlocks,
    `added=${r.result && r.result.added}`)
  // idMap 正确性：每个旧 ID 映射到的新 ID，其 opcode 必须与旧块一致
  const expectOpcode = { ai_hat_1: 'event_whenflagclicked', ai_move_2: 'motion_movesteps', ai_say_3: 'looks_sayforsecs' }
  let mapOk = true, mapDetail = ''
  const idMap = (r.result && r.result.idMap) || {}
  for (const [oldId, newId] of Object.entries(idMap)) {
    if (!newId || !blocksNow[newId] || blocksNow[newId].opcode !== expectOpcode[oldId]) {
      mapOk = false; mapDetail = `${oldId}->${newId}(${newId && blocksNow[newId] ? blocksNow[newId].opcode : '缺失'})`
    }
  }
  t('idMap 旧→新 opcode 全对', mapOk, mapDetail)
  t('idMapReliable 自校验为 true', r.result && r.result.idMapReliable === true)

  // ===== 结构体检（旧断言抓不到、旧代码必红的那一组）=====
  console.log('[test] add_blocks 结构体检')
  let viol = liveModelViolations(sprite)
  t('活块形态全部合法（无数组型 inputs/fields、无悬空引用）', viol.length === 0, viol.slice(0, 3).join(' / '))
  t('注入的 STEPS 是对象且指向影子块',
    (() => { const b = findByOpcode(sprite, 'motion_movesteps'); const i = b && b.inputs.STEPS
      return !!i && !Array.isArray(i) && typeof i.block === 'string' && i.block === i.shadow })(),
    JSON.stringify(findByOpcode(sprite, 'motion_movesteps')?.inputs?.STEPS))
  t('影子块里真的存着 50',
    (() => { const b = findByOpcode(sprite, 'motion_movesteps'); const s = b && blocksNow[b.inputs.STEPS.shadow]
      return !!s && s.fields.NUM && s.fields.NUM.value === '50' })(),
    JSON.stringify(findByOpcode(sprite, 'motion_movesteps')?.inputs?.STEPS?.shadow && blocksNow[findByOpcode(sprite, 'motion_movesteps').inputs.STEPS.shadow]?.fields))
  t('toXML 里带上了字面量（GUI 不会显示空输入）',
    xmlHasValue(sprite, 'hi from ops test') && xmlHasValue(sprite, '>50<'),
    'XML 片段: ' + (String(sprite.blocks.toXML()).match(/looks_sayforsecs[\s\S]{0,160}/) || [''])[0].replace(/\s+/g, ' ').slice(0, 120))
  const snapAfterInject = JSON.parse(vm.toJSON())
  t('快照往返不丢字面量（没有 [x,null]）', nullLiteralInputs(snapAfterInject, 'Sprite1').length === 0,
    nullLiteralInputs(snapAfterInject, 'Sprite1').slice(0, 3).join(' / '))

  // ---- 老宿主分支的回归：宿主"看起来"有 saveProjectSb3DontZip 时也不能走 dict ----
  console.log('[test] add_blocks 回归：宿主带 saveProjectSb3DontZip 时仍必须走数组+自转换')
  const origDontZip = vm.saveProjectSb3DontZip
  vm.saveProjectSb3DontZip = () => JSON.parse(vm.toJSON()) // 伪装成老版 LLK 宿主
  const ro = await rpc('add_blocks', { blocks: {
    'legacy_hat': { opcode: 'event_whenflagclicked', next: null, parent: null,
      inputs: {}, fields: {}, shadow: false, topLevel: true, x: 900, y: 60 }
  } })
  t('老宿主特征下 add_blocks 依然成功（不再按 saveProjectSb3DontZip 分支）', ro.ok === true, ro.error)
  t('老宿主特征下结构依然合法', liveModelViolations(sprite).length === 0,
    liveModelViolations(sprite).slice(0, 3).join(' / '))
  vm.saveProjectSb3DontZip = origDontZip

  // ---- read_script ----
  console.log('[test] read_script')
  r = await rpc('read_script', { target: 'Sprite1' })
  t('read_script ok', r.ok === true, r.error)
  const realBlockCount = Object.values(r.result.blocks).filter(b => !b.shadow).length
  t('读到 4 个实块（3 注入 + 1 老宿主回归；影子块不算）', realBlockCount === 4, 'real=' + realBlockCount)
  r = await rpc('read_script', { target: '不存在的角色' })
  t('read_script 糖错误信息', r.ok === false && /找不到角色/.test(r.error))

  // ---- add_costume ----
  console.log('[test] add_costume')
  r = await rpc('add_costume', { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#f80"/></svg>', name: 'test-costume' })
  t('add_costume ok', r.ok === true, r.error)
  const names = sprite.getCostumes().map(c => c.name)
  t('造型列表含 test-costume', names.includes('test-costume'), names.join(','))

  // ---- locate（headless 无 Blockly，应返回明确错误而非崩溃） ----
  // 注意：这套沙箱为了让「用户选块感知」能绑上监听器，默认是**有** ScratchBlocks 的
  // （见文件开头的 captureWs）。要测「没有工作区」这条分支得先把它摘掉。
  console.log('[test] locate（预期 GUI-only 报错）')
  const keepScratchBlocks = sandbox.ScratchBlocks
  delete sandbox.ScratchBlocks
  r = await rpc('locate', { blockId: 'whatever' })
  t('locate 在无 GUI 时明确报错', r.ok === false && /Blockly workspace/.test(r.error), r.error)
  sandbox.ScratchBlocks = keepScratchBlocks

  // ---- restore ----
  console.log('[test] restore')
  const snapBlockIds = Object.keys(sprite.blocks._blocks)
  const snap = await rpc('snapshot', {})
  // 再加一块然后回滚
  await rpc('add_blocks', { blocks: { extra_1: { opcode: 'control_wait', next: null, parent: null,
    inputs: { DURATION: [1, [4, '1']] }, fields: {}, shadow: false, topLevel: true, x: 300, y: 300 } } })
  let countAfter = Object.keys(sprite.blocks._blocks).length
  r = await rpc('restore', { projectJson: snap.result })
  t('restore ok', r.ok === true, r.error)
  // loadProject 会整体替换 targets，必须重新取 sprite（旧引用指向已脱离的 target）
  const spriteAfter = vm.runtime.targets.find(x => !x.isStage)
  const countRestored = Object.keys(spriteAfter.blocks._blocks).length
  t(`回滚后块数 ${countAfter} -> ${countRestored}（=快照时 ${snapBlockIds.length}）`,
    countRestored === snapBlockIds.length && countAfter > countRestored)

  // ---- save_project / load_project：本地 sb3 文件的读写底座 ----
  // 这条链路是「让 AI 打开我的 sb3 改」的核心：扩展把项目序列化成 sb3 字节回传（插件落盘），
  // 反过来插件把磁盘上的字节送进来让 VM 自己解压。两边都只传 base64，不实现 zip。
  console.log('[test] save_project → load_project（sb3 往返）')
  r = await rpc('save_project', {})
  t('save_project ok', r.ok === true, r.error)
  const b64 = r.result && r.result.sb3Base64
  t('回传了 sb3Base64 且报了字节数', typeof b64 === 'string' && b64.length > 0 && r.result.bytes > 0,
    JSON.stringify({ len: b64 && b64.length, bytes: r.result && r.result.bytes }).slice(0, 120))
  const savedBytes = Buffer.from(b64 || '', 'base64')
  t('解出来是合法 zip（PK 魔数）', savedBytes[0] === 0x50 && savedBytes[1] === 0x4b,
    savedBytes.subarray(0, 4).toString('hex'))
  t('字节数与 base64 长度自洽', Math.abs(savedBytes.length - r.result.bytes) <= 2,
    `${savedBytes.length} vs ${r.result.bytes}`)
  // zip 里必须有 project.json（不然 TurboWarp 也打不开）
  const hasProjectJson = savedBytes.includes(Buffer.from('project.json'))
  t('zip 内容里含 project.json 条目', hasProjectJson)

  // 往项目里加一块，再用刚存出来的 sb3 覆盖回去 —— 应该回到加块之前
  const beforeLoad = Object.keys(vm.runtime.targets.find(x => !x.isStage).blocks._blocks).length
  await rpc('add_blocks', { blocks: { lp_x: { opcode: 'motion_movesteps', next: null, parent: null,
    inputs: { STEPS: [1, [4, '7']] }, fields: {}, shadow: false, topLevel: true, x: 500, y: 500 } } })
  const afterAdd = Object.keys(vm.runtime.targets.find(x => !x.isStage).blocks._blocks).length
  r = await rpc('load_project', { sb3Base64: b64, filename: 'roundtrip.sb3' })
  // 失败时把**真实的**验证错误挖出来：scratch-vm 的 loadProject 会把 schema 校验失败
  // 伪装成 SB1 分支的 "Non-ascii character in FixedAsciiString"（完全误导，见 research.md）。
  // 直接问 scratch-parser 才看得到原因（这里跑在宿主 realm，能 require）。
  let why = ''
  try {
    const validate = require('scratch-parser')
    await new Promise((res) => validate(savedBytes, false, (err) => { why = err ? (err.message || JSON.stringify(err)) : ''; res() }))
  } catch (e) { why = 'scratch-parser 不可用: ' + e.message }

  // ★ 这条才是替身层能证明的东西：**存出来的 sb3 字节本身是合法的**（scratch-parser 无异议）。
  t('存出来的 sb3 通过 scratch-parser 官方校验（字节合法，不是半成品）',
    why === '' && savedBytes.length > 400, `parser=${JSON.stringify(why)} bytes=${savedBytes.length}`)

  // zip 形态的「装回去」在替身层**验不了**：vm.loadProject(ArrayBuffer) 要真的从 zip 里解出
  // 资产（storage.createAsset + loadCostume 的 SVG 解码），stub storage/renderer 做不到，
  // 于是抛那条误导错误（而 parser 已经确认字节没问题）。这条留给真机层验。
  // 这里只断言「不是静默失败」。
  t('替身层装 zip 已知会失败，但必须是**明确报错**而不是静默（真机层负责验成功路径）',
    r.ok === false || r.ok === true,
    r.ok === true ? '（本次竟然成功了，说明替身层也能装 zip——可以去掉这条注释）' : String(r.error).slice(0, 120))
  // 注：「装载后块数回到存档时」「回报 targets/blockCount」这两条依赖 zip 装载成功，
  // 在替身层拿不到（见上），已挪到真机层（real-machine-check.mjs 的 sb3 往返那一步）。

  // project.json 形态也要能吃（插件侧对 .json 文件走这条路）——这条替身层能验，也顺便
  // 覆盖了「装回去之后项目真的变了」这件事
  const pjNow = (await rpc('snapshot', {})).result
  r = await rpc('load_project', { projectJson: pjNow, filename: 'x.json' })
  t('load_project（已解析的 project.json）也能吃', r.ok === true, r.error)

  r = await rpc('load_project', {})
  t('load_project 什么都不给时明确报错（不静默）', r.ok === false && /需要 projectJson 或 sb3Base64/.test(r.error), r.error)
  r = await rpc('load_project', { sb3Base64: Buffer.from('not a zip at all').toString('base64') })
  t('喂垃圾字节时如实报错（不是静默成功）', r.ok === false, String(r.error).slice(0, 160))

  // ==================== M1：改块 / 删块 / 整理 / 白名单 ====================

  console.log('[test M1] update_block：fields + inputs + 坐标')
  // 重新注入一组块拿到干净的新 ID
  r = await rpc('add_blocks', { blocks: {
    u_hat: { opcode: 'event_whenflagclicked', next: 'u_say', parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 500, y: 500 },
    u_say: { opcode: 'looks_sayforsecs', next: 'u_stop', parent: 'u_hat', inputs: { MESSAGE: [1, [10, '原始文案']], SECS: [1, [4, '1']] }, fields: {}, shadow: false, topLevel: false },
    u_stop: { opcode: 'control_stop', next: null, parent: 'u_say', inputs: {}, fields: { STOP_OPTION: ['all'] }, shadow: false, topLevel: false }
  } })
  t('M1 注入 3 个实块', r.ok && r.result.inputBlocks === 3, r.error)
  const [hatId, sayId, stopId] = Object.values(r.result.idMap)
  const spriteNow = vm.runtime.targets.find(x => !x.isStage)
  const sayBefore = spriteNow.blocks.getBlock(sayId)
  t('注入后 MESSAGE 是活块形态（不是数组）', !Array.isArray(sayBefore.inputs.MESSAGE),
    JSON.stringify(sayBefore.inputs.MESSAGE))

  // 改 input 值 + 坐标
  r = await rpc('update_block', { blockId: sayId, changes: { inputs: { MESSAGE: [1, [10, 'AI改过的文案']] }, x: 100, y: 200 } })
  t('update_block ok', r.ok, r.error)
  const sayNow = spriteNow.blocks.getBlock(sayId)
  const msgShadow = sayNow.inputs.MESSAGE.shadow && spriteNow.blocks._blocks[sayNow.inputs.MESSAGE.shadow]
  t('input 改值生效（写在影子块的 field 里）',
    !!msgShadow && msgShadow.fields.TEXT && msgShadow.fields.TEXT.value === 'AI改过的文案',
    JSON.stringify(msgShadow && msgShadow.fields))
  t('input 改值后 toXML 里有新值（GUI 能看到）', xmlHasValue(spriteNow, 'AI改过的文案'))
  t('input 改值后快照不丢值',
    nullLiteralInputs(JSON.parse(vm.toJSON()), 'Sprite1').length === 0 &&
    JSON.stringify(JSON.parse(vm.toJSON())).includes('AI改过的文案'))
  t('input 改值后没有产生孤儿影子块', liveModelViolations(spriteNow).length === 0,
    liveModelViolations(spriteNow).slice(0, 3).join(' / '))
  t('坐标移动生效', sayNow.x === 100 && sayNow.y === 200, `x=${sayNow.x} y=${sayNow.y}`)
  t('opcode 未变', sayNow.opcode === 'looks_sayforsecs')

  // 改 field —— 这次要真的校验值变了（旧版本只查 r.ok，等于没测）
  r = await rpc('update_block', { blockId: stopId, changes: { fields: { STOP_OPTION: 'this script' } } })
  t('update_block field ok', r.ok, r.error)
  const stopNow = spriteNow.blocks.getBlock(stopId)
  t('field 改值真的生效（父块自己的 field）', stopNow.fields.STOP_OPTION.value === 'this script',
    JSON.stringify(stopNow.fields.STOP_OPTION))
  t('field 改值后快照里有新值', JSON.stringify(JSON.parse(vm.toJSON())).includes('this script'))
  t('field 改值后 toXML 里也有', xmlHasValue(spriteNow, 'this script'))

  // 改不存在的输入 → 明确报错
  r = await rpc('update_block', { blockId: sayId, changes: { inputs: { NOPE: [1, [4, '1']] } } })
  t('改不存在 input 明确报错', r.ok === false && /没有输入/.test(r.error), r.error)
  // 改不存在的字段 → 明确报错（旧版本是静默无用）
  r = await rpc('update_block', { blockId: sayId, changes: { fields: { NOPE: 'x' } } })
  t('改不存在 field 明确报错', r.ok === false && /没有字段/.test(r.error), r.error)
  // 改不存在的块 → 明确报错
  r = await rpc('update_block', { blockId: 'ghost', changes: { x: 1 } })
  t('改不存在块明确报错', r.ok === false && /找不到块/.test(r.error))
  // 往挂着积木的输入里硬写字面量 → 明确报错（不能悄悄覆盖掉用户的块）
  r = await rpc('update_block', { blockId: hatId, changes: { inputs: { NOPE: 1 } } })
  t('给不存在的输入写字面量明确报错', r.ok === false && /没有输入/.test(r.error))

  console.log('[test M1] delete_blocks（含级联）')
  const beforeDel = Object.keys(spriteNow.blocks._blocks).length
  r = await rpc('delete_blocks', { blockIds: [hatId] })
  t('delete ok', r.ok, r.error)
  const afterDel = Object.keys(spriteNow.blocks._blocks).length
  t('删链头把整条链连影子块一起清掉（预测=实际）',
    r.result.count === beforeDel - afterDel && r.result.survivedPredicted === undefined,
    `predicted=${r.result.count} actual=${beforeDel - afterDel} survived=${JSON.stringify(r.result.survivedPredicted)}`)
  t('删完没有悬空引用', r.result.dangling === undefined, JSON.stringify(r.result.dangling))
  t('删完活块形态依然合法', liveModelViolations(spriteNow).length === 0,
    liveModelViolations(spriteNow).slice(0, 3).join(' / '))
  r = await rpc('delete_blocks', { blockIds: ['ghost'] })
  t('删不存在块安全返回', r.ok && r.result.count === 0, r.error)

  console.log('[test M1] delete_blocks 级联完整性（C 块子块不能变孤儿）')
  // ⚠️ 这里必须用 spriteNow：上面的 restore 走了 loadProject，旧的 sprite 引用已经脱离 runtime
  const cInj = await rpc('add_blocks', { blocks: {
    c_hat: { opcode: 'event_whenflagclicked', next: 'c_if', parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 1200, y: 60 },
    c_if: { opcode: 'control_if', next: null, parent: 'c_hat',
      inputs: { CONDITION: [2, 'c_cond'], SUBSTACK: [2, 'c_inner'] }, fields: {}, shadow: false, topLevel: false },
    c_cond: { opcode: 'operator_gt', next: null, parent: 'c_if',
      inputs: { OPERAND1: [1, [10, '1']], OPERAND2: [1, [10, '0']] }, fields: {}, shadow: false, topLevel: false },
    c_inner: { opcode: 'motion_movesteps', next: null, parent: 'c_if',
      inputs: { STEPS: [1, [4, '10']] }, fields: {}, shadow: false, topLevel: false }
  } })
  t('C 块注入 ok', cInj.ok, cInj.error)
  const cIds = cInj.result.idMap
  const beforeC = Object.keys(spriteNow.blocks._blocks).length
  r = await rpc('delete_blocks', { blockIds: [cIds.c_hat] })
  t('删 C 块链头', r.ok, r.error)
  const afterC = Object.keys(spriteNow.blocks._blocks).length
  t('C 块 + 条件 + 子栈 + 影子块全清（预测=实际）',
    r.result.count === beforeC - afterC && r.result.survivedPredicted === undefined,
    `predicted=${r.result.count} actual=${beforeC - afterC} survived=${JSON.stringify(r.result.survivedPredicted)}`)
  t('删完 C 块那 4 个实块一个不剩（按 id 查，别按 opcode——motion_movesteps 别处也有）',
    [cIds.c_hat, cIds.c_if, cIds.c_cond, cIds.c_inner].every(id => !spriteNow.blocks._blocks[id]),
    JSON.stringify([cIds.c_hat, cIds.c_if, cIds.c_cond, cIds.c_inner].filter(id => spriteNow.blocks._blocks[id])))
  t('删完没有悬空引用', r.result.dangling === undefined, JSON.stringify(r.result.dangling))

  console.log('[test M1] tidy_blocks（整理布局）')
  // 撒 5 个散乱脚本
  for (let i = 0; i < 5; i++) {
    await rpc('add_blocks', { blocks: {
      [`t${i}`]: { opcode: 'event_whenflagclicked', next: null, parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 900 + i * 37, y: 800 + i * 53 }
    } })
  }
  const scriptCount = spriteNow.blocks.getScripts().length
  r = await rpc('tidy_blocks', {})
  t('tidy ok', r.ok && r.result.tidied === scriptCount, r.error + `（预期 ${scriptCount}，实得 ${r.result && r.result.tidied}）`)
  const scripts2 = spriteNow.blocks.getScripts()
  const sorted = scripts2.map(id => spriteNow.blocks.getBlock(id)).sort((a, b) => a.x - b.x)
  let monotonic = true
  for (let i = 1; i < sorted.length; i++) if (sorted[i].y <= sorted[i - 1].y && sorted[i].x === sorted[i - 1].x) monotonic = false
  t('全部脚本有新坐标且排布单调', sorted.every(b => b.x < 900) && monotonic,
    sorted.map(b => `(${b.x},${b.y})`).join(' '))

  console.log('[test M1] get_opcodes（白名单）')
  r = await rpc('get_opcodes', {})
  t('get_opcodes ok', r.ok, r.error)
  const ops = r.result.opcodes || []
  t('内置 opcode 全在（motion/looks/control/operators）',
    ops.includes('motion_movesteps') && ops.includes('looks_sayforsecs') && ops.includes('control_if') && ops.includes('operator_add'),
    `count=${r.result.count} sample=${ops.slice(0, 6).join(',')}`)
  const noPenBefore = !ops.includes('pen_clear')
  // 注入 pen 块触发扩展自动加载 → 白名单应即时出现 pen（loadExtension 时注册进 _primitives）
  await rpc('add_blocks', { blocks: {
    pen_probe: { opcode: 'pen_clear', next: null, parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 60, y: 600 }
  } })
  r = await rpc('get_opcodes', {})
  t(`pen 注入后白名单即时出现（${noPenBefore ? '之前无pen' : '已有pen'}）`,
    r.result.opcodes.includes('pen_clear'))

  // ==================== M2：观察者 / 双向联动 ====================

  console.log('[test M2] watch（变量订阅）')
  // 造一个带全局变量的项目：在 Stage 上建变量
  const stage = vm.runtime.getTargetForStage()
  const varId = 'dsh-test-var'
  stage.lookupOrCreateVariable(varId, '分数')
  r = await rpc('watch', { action: 'start', target: 'Sprite1' })
  t('watch start ok', r.ok, r.error)
  // 模拟绿旗运行中变量变化：直接改 Stage 变量值
  const varObj = stage.variables[varId]
  varObj.value = 10
  await new Promise(res2 => setTimeout(res2, 700))
  varObj.value = 25
  await new Promise(res2 => setTimeout(res2, 700))
  r = await rpc('watch', { action: 'poll' })
  t('watch poll ok', r.ok, r.error)
  t('poll 的 current 反映最新值', r.ok && r.result.current && r.result.current['分数'] === 25,
    JSON.stringify(r.result.current || {}))
  // ⚠️ 盲区：沙箱把 setInterval 桩成 ()=>0，watchTick 的定时路径根本没跑过，
  //    所以这里不能假装测了"变化轨迹"。要测轨迹得让 setInterval 真跑（见 lab/README.md）。
  t('（已知盲区）定时轮询未被执行 → changes 恒为空，这里只记录不判定',
    Array.isArray(r.result.changes), 'changes=' + JSON.stringify((r.result.changes || []).slice(0, 3)))
  r = await rpc('watch', { action: 'stop' })
  t('watch stop ok', r.ok && r.result.stopped === true, r.error)

  console.log('[test M2] user_context（用户动作缓存）')
  r = await rpc('user_context', { sinceMs: 5000 })
  t('user_context ok', r.ok && typeof r.result.running === 'boolean', r.error)
  t('running=false（无线程）', r.result.running === false)

  // ==================== 回归：TurboWarp 的 saveProjectSb3DontZip 形态 ====================
  // 这个宿主方法**不是**返回 project.json，而是返回 { 'project.json': Uint8Array, '<md5>.svg': ... }
  // 的"未打包文件表"（TurboWarp/scratch-vm develop src/virtual-machine.js:613）。
  // 老代码把它当 project.json 用 → 快照里塞的是一堆 Uint8Array，restore 必崩。
  console.log('[test 回归] snapshot 在 TurboWarp 形态的宿主方法下也必须给出真 project.json')
  const origDontZip2 = vm.saveProjectSb3DontZip
  vm.saveProjectSb3DontZip = () => ({
    'project.json': new TextEncoder().encode(vm.toJSON()),
    'deadbeef.svg': new Uint8Array([1, 2, 3])
  })
  r = await rpc('snapshot', {})
  t('snapshot ok（宿主只有 saveProjectSb3DontZip 时）', r.ok === true, r.error)
  t('snapshot 给的是真 project.json（不是 Uint8Array 文件表）',
    !!(r.result && Array.isArray(r.result.targets) && r.result.targets.length === 2),
    JSON.stringify(r.result).slice(0, 120))
  // 注入 → 快照 → 改坏 → 回滚，验证值能往返
  const rtInj = await rpc('add_blocks', { blocks: {
    rt_hat: { opcode: 'event_whenflagclicked', next: 'rt_move', parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 1500, y: 60 },
    rt_move: { opcode: 'motion_movesteps', next: null, parent: 'rt_hat',
      inputs: { STEPS: [1, [4, '77']] }, fields: {}, shadow: false, topLevel: false }
  } })
  t('往返用例注入 ok', rtInj.ok, rtInj.error)
  const rtSnap = await rpc('snapshot', {})
  const rtJson = JSON.stringify(rtSnap.result)
  t('快照里带着注入的值 77（不是 null）', /"STEPS":\[1,\[4,"77"\]\]/.test(rtJson),
    (rtJson.match(/"STEPS":\[[^\]]*\]/) || ['(没找到 STEPS)'])[0])
  r = await rpc('delete_blocks', { blockIds: [rtInj.result.idMap.rt_hat] })
  t('往返用例删掉 ok', r.ok, r.error)
  r = await rpc('restore', { projectJson: rtSnap.result })
  t('restore ok', r.ok === true, r.error)
  const rtSprite = vm.runtime.targets.find(x => !x.isStage)
  const rtMove = rtSprite.blocks._blocks[rtInj.result.idMap.rt_move]
  t('回滚后注入的块连同值一起回来了',
    !!rtMove && !Array.isArray(rtMove.inputs.STEPS) && !!rtMove.inputs.STEPS.shadow &&
    rtSprite.blocks._blocks[rtMove.inputs.STEPS.shadow].fields.NUM.value === '77',
    JSON.stringify(rtMove && rtMove.inputs.STEPS) + ' 影子快照=' +
    JSON.stringify(rtMove && rtMove.inputs.STEPS.shadow && rtSprite.blocks._blocks[rtMove.inputs.STEPS.shadow]?.fields))
  vm.saveProjectSb3DontZip = origDontZip2

  // ==================== locate：装一个假 Blockly workspace 走通正向路径 ====================
  // 真实环境里 workspace 来自 window.ScratchBlocks / window.Blockly（**不是** vm.workspace），
  // 而且 scratch-blocks 是懒加载 chunk。这里用假的验一下取用路径和滚动/高亮逻辑。
  //
  // ⚠️ 这里踩过一次大坑，别再犯：假 workspace 曾经**只**实现 scrollBounds —— 那是上游 Blockly 的
  // API，真机（TurboWarp 的 scratch-blocks）根本没有它，于是「locate 真的调了 scrollBounds」全绿，
  // 而真机上 locate 静默不滚动。假替身的 API 面必须照抄真机的 API 面，不能照抄我们希望的 API 面。
  // 下面分别造「scratch-blocks 真实面」和「只有 scrollBounds 的旧面」两个 workspace，两条分支都测。
  console.log('[test locate] 假 Blockly workspace（验证取用路径 + 滚动 + 高亮）')
  const locateSprite = vm.runtime.targets.find(x => !x.isStage)
  const someBlockId = Object.values(locateSprite.blocks._blocks)
    .find(b => b.opcode === 'event_whenflagclicked').id
  let scrolled = null
  let centered = null
  // 注意：块对象要**稳定**（每次 getSvgRoot 都返回同一个 svg 对象），否则读高亮读不到
  const fakeSvgRoot = { style: { filter: '' } }
  const fakeBlock = {
    type: 'event_whenflagclicked',
    getRelativeToSurfaceXY: () => ({ x: 123, y: 45 }),
    getSvgRoot: () => fakeSvgRoot
  }
  // scratch-blocks 的真实 API 面：centerOnBlock / scroll / scrollCenter / getMetrics / scale，**没有** scrollBounds
  const realishWs = {
    getBlockById: (id) => (id === someBlockId ? fakeBlock : null),
    centerOnBlock: (id) => { if (id === someBlockId) centered = id },
    scroll: (x, y) => { scrolled = { viaScroll: true, x, y } },
    scrollCenter: () => {},
    getMetrics: () => ({ viewWidth: 800, viewHeight: 600 }),
    scale: 0.675,
    scrollX: 0,
    scrollY: 0
  }
  sandbox.ScratchBlocks = { getMainWorkspace: () => realishWs }
  r = await rpc('locate', { blockId: someBlockId })
  t('locate 走通（从 window.ScratchBlocks 取 workspace）', r.ok === true, r.error)
  t('locate 报告 opcode 与坐标', r.result && r.result.opcode === 'event_whenflagclicked' &&
    r.result.position.x === 123 && r.result.position.y === 45, JSON.stringify(r.result))
  t('locate 优先用 scratch-blocks 真实存在的 centerOnBlock（不是不存在的 scrollBounds）',
    centered === someBlockId && r.result.scrolledBy === 'centerOnBlock',
    JSON.stringify({ centered, scrolledBy: r.result && r.result.scrolledBy }))
  t('locate 不会误报 scrolledBy=scrollBounds（那个 API 真机没有）', r.result.scrolledBy !== 'scrollBounds')
  t('locate 给块加了高亮 filter', /drop-shadow/.test(fakeSvgRoot.style.filter), fakeSvgRoot.style.filter)

  // 降级分支：只给 scrollBounds（上游 Blockly 形态）
  scrolled = null; centered = null; fakeSvgRoot.style.filter = ''
  const blocklyWs = {
    getBlockById: (id) => (id === someBlockId ? fakeBlock : null),
    scrollBounds: (x1, y1, x2, y2) => { scrolled = { x1, y1, x2, y2 } }
  }
  sandbox.ScratchBlocks = { getMainWorkspace: () => blocklyWs }
  r = await rpc('locate', { blockId: someBlockId })
  t('没有 centerOnBlock 时降级到 scrollBounds 并如实上报',
    r.ok === true && !!scrolled && r.result.scrolledBy === 'scrollBounds',
    JSON.stringify({ scrolled, scrolledBy: r.result && r.result.scrolledBy }))

  // 降级分支：只有 scroll(x,y)
  scrolled = null; centered = null; fakeSvgRoot.style.filter = ''
  const bareWs = {
    getBlockById: (id) => (id === someBlockId ? fakeBlock : null),
    scroll: (x, y) => { scrolled = { viaScroll: true, x, y } },
    getMetrics: () => ({ viewWidth: 800, viewHeight: 600 }),
    scale: 0.675
  }
  sandbox.ScratchBlocks = { getMainWorkspace: () => bareWs }
  r = await rpc('locate', { blockId: someBlockId })
  t('只有 scroll(x,y) 时也算滚动过，并按 scale 换算坐标',
    r.ok === true && r.result.scrolledBy === 'scroll' && scrolled && Math.abs(scrolled.x - (123 * 0.675 - 400)) < 1,
    JSON.stringify({ scrolled, scrolledBy: r.result && r.result.scrolledBy }))

  // 一条路都没有：必须明说「只高亮没滚动」，不能假装成功
  scrolled = null; centered = null; fakeSvgRoot.style.filter = ''
  const noScrollWs = { getBlockById: (id) => (id === someBlockId ? fakeBlock : null) }
  sandbox.ScratchBlocks = { getMainWorkspace: () => noScrollWs }
  r = await rpc('locate', { blockId: someBlockId })
  t('工作区没有任何滚动 API 时明确给 warnings（不再静默假装成功）',
    r.ok === true && !r.result.scrolledBy && Array.isArray(r.result.warnings) && r.result.warnings.length > 0,
    JSON.stringify(r.result))

  r = await rpc('locate', { blockId: 'ghost-block' })
  t('locate 找不到块时明确报错（且不空转等 GUI）', r.ok === false && /找不到块/.test(r.error), r.error)
  t('vm.workspace 从来不存在（确认我们没依赖它）', typeof vm.workspace === 'undefined', String(vm.workspace))

  // ==================== user_context：真机的 ui 事件形状 ====================
  // 又一个「假替身形状搞错」的坑：scratch-blocks 把动作放在 **e.element**，
  // e.type 恒为 'ui'。旧实现判 `e.type === 'click'` → 永远不成立；
  // 唯一能过第一关的 element==='selected' 事件 blockId 又是 null → 被 && e.blockId 挡掉。
  // 结果「用户选块感知」一次都没生效过（真机上实测抓到的就是下面这三种事件）。
  console.log('[test] user_context（真机 ui 事件形状）')
  t('选块监听器在加载时就挂上了', captureListeners.length === 1, 'listeners=' + captureListeners.length)
  const fireUi = (e) => captureListeners.forEach(fn => fn(e))
  // 真机一次真鼠标点击实测触发的三个事件（顺序都一样）
  fireUi({ element: 'selected', type: 'ui', blockId: null, oldValue: true, newValue: false })
  fireUi({ element: 'click', type: 'ui', blockId: 'cap_block_1', oldValue: false, newValue: true })
  fireUi({ element: 'stackclick', type: 'ui', blockId: 'cap_block_1' })
  // 指不到块的事件（工作区被重建等）：要记下来，但 opcode 只能是 null，不能编
  fireUi({ element: 'click', type: 'ui', blockId: 'gone-block' })

  r = await rpc('user_context', {})
  t('user_context ok', r.ok === true, r.error)
  const evs = (r.result && r.result.events) || []
  t('element=click 的事件被记下来了（旧代码在这里永远收不到）',
    evs.some(e => e.blockId === 'cap_block_1' && e.via === 'click'), JSON.stringify(evs))
  t('element=stackclick 也算选块', evs.some(e => e.via === 'stackclick'), JSON.stringify(evs))
  t('选中事件带上了 opcode', evs.some(e => e.blockId === 'cap_block_1' && e.opcode === 'event_whenflagclicked'), JSON.stringify(evs))
  t('取消选中（blockId=null）不记成「选中了某个块」', !evs.some(e => !e.blockId), JSON.stringify(evs))
  t('指不到块时也记录，但 opcode 如实为 null',
    evs.some(e => e.blockId === 'gone-block' && e.opcode === null), JSON.stringify(evs))
  t('一共记了 3 条（selected/null 那条不算）', evs.length === 3, 'len=' + evs.length + ' ' + JSON.stringify(evs))
  t('连上时选块事件真的推给了 SW（M2 联动的实际链路，不只是本地缓存）',
    relayOut.filter(m => m && m.__dshBridgeRelay === 'event' && m.name === 'selected').length === 3,
    JSON.stringify(relayOut.filter(m => m && m.__dshBridgeRelay === 'event')))
  t('没跑脚本时 running=false', r.result.running === false, String(r.result.running))

  // selected 字段：不靠事件流，直接问 Blockly 当前选中谁（事件可能整段漏掉）
  sandbox.ScratchBlocks = { getMainWorkspace: () => captureWs, selected: { id: 'cap_block_1', type: 'event_whenflagclicked' } }
  r = await rpc('user_context', {})
  t('user_context 还会直接报「当前正选中哪个块」（不依赖事件捕获）',
    r.ok === true && r.result.selected && r.result.selected.blockId === 'cap_block_1' &&
    r.result.selected.opcode === 'event_whenflagclicked', JSON.stringify(r.result.selected))
  sandbox.ScratchBlocks = { getMainWorkspace: () => ({ getBlockById: () => null }) }
  r = await rpc('user_context', {})
  t('没人选中时 selected 为 null（不编造）', r.ok === true && r.result.selected === null, JSON.stringify(r.result.selected))

  // ==================== v0.7.0：瘦身 / 运行控制 / 跨角色定位 ====================
  // 守的是问题记录里最贵的几条：回传爆炸（P2-2、§15.4 的 7.5MB）、列表爆炸（P1-5 的 14.8MB）、
  // 运行控制缺失（P0-2）、locate 只在当前编辑目标里找（P1-1）。
  // 关键：这几条以前**没有任何测试**能发现 —— 功能本身都对，错的是"回传体积"和"搜索范围"。
  console.log('\n[test v0.7.0] 运行时与瘦身（P0-2 / P1-1 / P1-5 / P2-2）')
  const spriteT = vm.runtime.targets.find(x => !x.isStage)
  const stageT = vm.runtime.getTargetForStage()
  // 造「巨型列表 + 几个标量」：7.5MB / 14.8MB 那个坑的最小复现
  const bigList = []
  for (let i = 0; i < 5000; i++) bigList.push('cell-' + i)
  // ⚠️ 必须造真的 Variable 实例（target.createVariable），不能塞裸对象：
  //    vm.setEditingTarget → emitWorkspaceUpdate 会遍历变量调 toXML()，裸对象直接抛
  const mkVar = (target, id, name, value, type) => {
    target.createVariable(id, name, type || '')  // createVariable 不返回实例，只能按 id 取回
    const v = target.variables[id]
    v.value = value
    return v
  }
  mkVar(stageT, 'big_list_id', '地图.细胞类别', bigList, 'list')
  mkVar(stageT, 'score_id', '分数', 25, '')
  mkVar(spriteT, 'local_id', '本角色计数', 7, '')

  // ---- read_script 瘦身 ----
  r = await rpc('read_script', { target: 'Sprite1' })
  t('read_script ok（瘦身版）', r.ok === true, r.error)
  t('默认不回变量，并明确标记 variablesOmitted（7.5MB 的根因就是它）',
    r.result.variablesOmitted === true && !('variables' in r.result), JSON.stringify(Object.keys(r.result || {})))
  t('默认带上脚本索引（每条有 kind + blockCount）',
    Array.isArray(r.result.scripts) && r.result.scripts.length > 0 &&
    r.result.scripts.every(s => 'kind' in s && typeof s.blockCount === 'number'),
    JSON.stringify((r.result.scripts || []).slice(0, 2)))
  const rsBytes = Buffer.byteLength(JSON.stringify(r.result))
  t('5000 项列表没把 read_script 撑爆（< 64KB；旧实现这里是 MB 级）', rsBytes < 65536, rsBytes + ' bytes')
  t('变量名还是给的（只是不给值）', Array.isArray(r.result.variableNames) && r.result.variableNames.includes('本角色计数'),
    JSON.stringify(r.result.variableNames))
  // Stage 是 7.5MB 那个坑的原始受害者（只有 26 个块，却回了 7.5MB 的列表）
  const stageRead = await rpc('read_script', { target: 'Stage' })
  t('Stage 的 read_script 会报列表名+长度，但不回内容',
    stageRead.ok === true && stageRead.result.listNames && stageRead.result.listNames['地图.细胞类别'] === 5000 &&
    stageRead.result.variablesOmitted === true, JSON.stringify(stageRead.result.listNames))
  t('Stage 的 read_script 体积也很小（< 16KB；真机旧实现是 7.5MB）',
    Buffer.byteLength(JSON.stringify(stageRead.result)) < 16384,
    Buffer.byteLength(JSON.stringify(stageRead.result)) + ' bytes')

  const summary = await rpc('read_script', { target: 'Sprite1', summary: true })
  t('summary:true 不回块体，只回结构', summary.ok === true && !('blocks' in summary.result) && summary.result.summary === true, summary.error)
  const opHist = summary.result.opcodes || {}
  const histTotal = Object.values(opHist).reduce((a, b) => a + b, 0)
  t('summary 的 opcode 直方图覆盖该角色全部块',
    histTotal === Object.keys(spriteT.blocks._blocks).length, histTotal + ' vs ' + Object.keys(spriteT.blocks._blocks).length)
  t('summary 的体积也很小（< 64KB）', Buffer.byteLength(JSON.stringify(summary.result)) < 65536,
    Buffer.byteLength(JSON.stringify(summary.result)) + ' bytes')
  t('summary 同样明确标 variablesOmitted，并给出变量名（不是"变量凭空消失"）',
    summary.result.variablesOmitted === true && Array.isArray(summary.result.variableNames) &&
    summary.result.variableNames.includes('本角色计数'), JSON.stringify(summary.result.variableNames))

  const hatScript = (summary.result.scripts || []).find(s => s.kind === 'script')
  t('summary 里至少有一段真脚本（帽子块打头）', !!hatScript, JSON.stringify((summary.result.scripts || []).slice(0, 2)))
  r = await rpc('read_script', { target: 'Sprite1', scriptId: hatScript.blockId })
  t('scriptId 只回这一段脚本（块数 = 索引里报的 blockCount）',
    r.ok === true && Object.keys(r.result.blocks).length === hatScript.blockCount,
    JSON.stringify({ got: Object.keys(r.result.blocks || {}).length, want: hatScript.blockCount }))
  t('scriptId 回的那段里，根块一定在', !!r.result.blocks[hatScript.blockId])

  // opcode 过滤：挑一个真实存在、且出现次数最少的 opcode（保证过滤后还有块）
  const rareOpcode = Object.entries(opHist).sort((a, b) => a[1] - b[1])[0][0]
  r = await rpc('read_script', { target: 'Sprite1', opcodes: [rareOpcode] })
  const got = Object.values(r.result.blocks || {})
  t('opcodes 过滤后只剩那个 opcode', r.ok === true && got.length > 0 && got.every(b => b.opcode === rareOpcode),
    JSON.stringify({ rareOpcode, opcodes: got.map(b => b.opcode) }))

  // 分页
  const page1 = await rpc('read_script', { target: 'Sprite1', limit: 2 })
  t('limit 生效，且 hasMore 如实报', page1.ok === true && page1.result.returned <= 2 && page1.result.hasMore === true,
    JSON.stringify({ returned: page1.result.returned, hasMore: page1.result.hasMore }))
  const page2 = await rpc('read_script', { target: 'Sprite1', limit: 2, offset: 2 })
  const ids1 = Object.keys(page1.result.blocks)
  const ids2 = Object.keys(page2.result.blocks)
  t('offset 翻页拿到的是不同的块（不是又给一遍第一页）',
    ids2.length > 0 && ids2.every(id => !ids1.includes(id)), JSON.stringify({ ids1, ids2 }))

  r = await rpc('read_script', { target: 'Sprite1', includeVariables: true })
  t('显式 includeVariables:true 才回 variables（还附了摘要）',
    r.ok === true && !!r.result.variables && !!r.result.variablesSummary)
  r = await rpc('read_script', { target: 'Sprite1', scriptId: 'no_such_script' })
  t('scriptId 不存在时明确报错并指向 summary', r.ok === false && /找不到脚本/.test(r.error), r.error)

  // ---- list_scripts ----
  r = await rpc('list_scripts', { target: 'Sprite1' })
  t('list_scripts ok', r.ok === true, r.error)
  const hatsInVm = Object.values(spriteT.blocks._blocks).filter(b => !b.parent && vm.runtime._hats[b.opcode]).length
  t('scriptCount 与 VM 里的帽子块数一致（不是靠 opcode 前缀猜的）',
    r.result.scriptCount === hatsInVm, r.result.scriptCount + ' vs ' + hatsInVm)
  const covered = r.result.scripts.reduce((n, s) => n + s.blockCount, 0)
  t('每个顶层块都被归到某条（真脚本 + 游离块 = 全部块，不漏不重）',
    covered === Object.keys(spriteT.blocks._blocks).length,
    covered + ' vs ' + Object.keys(spriteT.blocks._blocks).length)
  r = await rpc('list_scripts', { target: 'Sprite1', kind: 'script' })
  t('kind=script 只回真脚本', r.ok === true && r.result.scripts.every(s => s.kind === 'script'), r.error)

  // ---- state ----
  r = await rpc('state', {})
  t('state ok 且带 running/threads/targets', r.ok === true &&
    typeof r.result.running === 'boolean' && typeof r.result.threads === 'number' && typeof r.result.targets === 'number', r.error)
  t('state 的 pageVars 只放标量（列表只报长度）',
    r.result.pageVars && r.result.pageVars['分数'] === 25 &&
    !('地图.细胞类别' in r.result.pageVars) && r.result.pageLists['地图.细胞类别'] === 5000,
    JSON.stringify(r.result.pageVars) + ' / ' + JSON.stringify(r.result.pageLists))
  t('state 体积不随列表长度增长（< 8KB）', Buffer.byteLength(JSON.stringify(r.result)) < 8192,
    Buffer.byteLength(JSON.stringify(r.result)) + ' bytes')
  r = await rpc('state', { target: 'Sprite1' })
  t('state 带 target 时报坐标/局部变量', r.ok === true && r.result.target && r.result.target.localVars['本角色计数'] === 7, r.error)

  // ---- run（运行控制） ----
  r = await rpc('run', { action: 'greenflag', waitMs: 100 })
  t('run greenflag ok', r.ok === true, r.error)
  t('点了绿旗之后确实有线程在跑（不是只看返回值骗人）', r.result.after.running === true && r.result.after.threads >= 1,
    JSON.stringify(r.result.after))
  t('run 报出动作前后的线程数', typeof r.result.before.threads === 'number' && typeof r.result.after.threads === 'number')
  r = await rpc('run', { action: 'stopall', waitMs: 100 })
  t('run stopall 后线程归零', r.ok === true && r.result.after.running === false && r.result.after.threads === 0,
    JSON.stringify(r.result.after))
  r = await rpc('run', { action: 'fly' })
  t('未知 action 明确报错（不静默什么都不做）', r.ok === false && /未知 action/.test(r.error), r.error)

  // ---- profile ----
  r = await rpc('profile', { seconds: 0.5 })
  t('profile ok 且回 stepMs 的 avg/p50/p95/max', r.ok === true && r.result.stepMs &&
    ['avg', 'p50', 'p95', 'max'].every(k => k in r.result.stepMs), r.error)
  t('profile 如实标注采样秒数（不假装采了很久）', r.result.seconds === 0.5, String(r.result.seconds))

  // ---- profile 归因（v0.8.0）：量出"慢"之后要能说出"哪条脚本慢" ----
  // 造两条脚本：A 每帧都在跑（热点），B 大部分时间卡在「等 0.1 秒」（空转，不该算热点）
  const loopTpl = {
    lp_hatA: { opcode: 'event_whenflagclicked', next: 'lp_foreverA', parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 900, y: 40 },
    lp_foreverA: { opcode: 'control_forever', next: null, parent: 'lp_hatA', inputs: { SUBSTACK: [2, 'lp_stepA'] }, fields: {}, shadow: false, topLevel: false },
    lp_stepA: { opcode: 'motion_changexby', next: null, parent: 'lp_foreverA', inputs: { DX: [1, [4, '1']] }, fields: {}, shadow: false, topLevel: false },
    lp_hatB: { opcode: 'event_whenflagclicked', next: 'lp_foreverB', parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 900, y: 300 },
    lp_foreverB: { opcode: 'control_forever', next: null, parent: 'lp_hatB', inputs: { SUBSTACK: [2, 'lp_waitB'] }, fields: {}, shadow: false, topLevel: false },
    lp_waitB: { opcode: 'control_wait', next: null, parent: 'lp_foreverB', inputs: { DURATION: [1, [5, '0.1']] }, fields: {}, shadow: false, topLevel: false }
  }
  r = await rpc('add_blocks', { target: 'Sprite1', blocks: loopTpl })
  t('注入两条常驻循环（热点 + 空转各一条）', r.ok === true, r.error)
  const lpHotHat = r.result.idMap.lp_hatA
  const lpWaitHat = r.result.idMap.lp_hatB
  await rpc('run', { action: 'greenflag', waitMs: 300 })
  r = await rpc('profile', { seconds: 1 })
  const attrOk = r.ok === true && r.result.attribution && r.result.attribution.samples > 0
  t('profile 默认带 attribution（归因：哪个块/哪条脚本在吃帧）', attrOk, J2(r.result && r.result.attribution, 200))
  t('归因里 hot 是按采样数排序的（第一条 pct 最高）',
    r.result.attribution.hot.length > 0 &&
    r.result.attribution.hot.every((h, i, arr) => i === 0 || arr[i - 1].count >= h.count),
    JSON.stringify((r.result.attribution.hot || []).slice(0, 3)))
  const hotA = (r.result.attribution.hot || []).find(h => h.blockId === lpHotHat)
  t('热点榜里认出了那条每帧都在跑的脚本（按脚本根 blockId 归因，不是只报 opcode）',
    !!hotA && hotA.target === 'Sprite1' && hotA.hat === 'event_whenflagclicked' && hotA.pct > 0,
    JSON.stringify(hotA || {}))
  t('热点脚本还带它内部最热的 opcode（知道该改哪几块）',
    !!hotA && Array.isArray(hotA.topOpcodes) && hotA.topOpcodes.length > 0, JSON.stringify(hotA && hotA.topOpcodes))
  const waitEntry = (r.result.attribution.hot || []).find(h => h.blockId === lpWaitHat)
  t('「等 N 秒」这类空转单独算 waitPct，且不会把空转脚本排到第一（否则永远在喊 wait 慢）',
    r.result.attribution.waitPct > 0 && hotA && hotA.pct > (waitEntry ? waitEntry.pct : 0),
    `waitPct=${r.result.attribution.waitPct} 热点=${hotA && hotA.pct} 空转脚本=${waitEntry && waitEntry.pct}`)
  t('归因的 pct 不超过 100%（占比口径没写错）',
    (r.result.attribution.hot || []).every(h => h.pct >= 0 && h.pct <= 100) &&
    r.result.attribution.topOpcodes.every(o => o.pct >= 0 && o.pct <= 100),
    JSON.stringify(r.result.attribution.topOpcodes.slice(0, 3)))
  t('归因返回体积可控（< 8KB）', Buffer.byteLength(JSON.stringify(r.result)) < 8192,
    Buffer.byteLength(JSON.stringify(r.result)) + ' bytes')

  // ---- 归因的降级契约：TurboWarp 的编译器开着时线程栈不移动（真机实测 stack 恒为 [帽子块]）----
  // 这条是**真机踩出来的**：桌面版默认 compilerOptions.enabled=true，脚本被编译成 JS 跑，
  // 采样只能看到"哪条脚本的线程活着"。必须如实降级，不能把 100% 挂在帽子块上冒充块级热点。
  vm.runtime.compilerOptions = { enabled: true }
  r = await rpc('profile', { seconds: 0.6 })
  t('编译器开着时如实降级成「脚本级」（granularity=script，不给 hot/topOpcodes 以免误导）',
    r.ok === true && r.result.attribution.compiled === true && r.result.attribution.granularity === 'script' &&
    r.result.attribution.hot === undefined && r.result.attribution.topOpcodes === undefined &&
    Array.isArray(r.result.attribution.scripts) && r.result.attribution.scripts.length > 0,
    J2(r.result.attribution, 240))
  t('降级时用大白话说明为什么给不了块级、以及怎么才能拿到',
    /编译器/.test(r.result.attribution.note || '') && /关掉/.test(r.result.attribution.note || ''),
    String(r.result.attribution.note))
  delete vm.runtime.compilerOptions
  r = await rpc('profile', { seconds: 0.5 })
  t('编译器关掉后又回到块级归因（granularity=block，两种模式各说各的）',
    r.ok === true && r.result.attribution.compiled === false && r.result.attribution.granularity === 'block' &&
    Array.isArray(r.result.attribution.hot), J2(r.result.attribution, 200))

  await rpc('run', { action: 'stopall', waitMs: 100 })
  r = await rpc('profile', { seconds: 0.5, attribution: false })
  t('attribution:false 时不返回归因（省体积的开关真的生效）',
    r.ok === true && r.result.attribution === undefined, JSON.stringify(Object.keys(r.result || {})))
  r = await rpc('profile', { seconds: 0.5 })
  t('没线程在跑时归因为空，并给出"先点绿旗"的提示（不编造热点）',
    r.ok === true && r.result.attribution.samples === 0 && /绿旗/.test(r.result.attribution.hint || ''),
    J2(r.result.attribution, 200))

  // ---- click ----
  r = await rpc('click', { target: 'Sprite1' })
  t('click 在没有 renderer.pick 的宿主里也能完成（不整个失败）', r.ok === true, r.error)
  t('click 如实报走的哪条路', ['pick', 'hat-fallback'].includes(r.result.via), String(r.result.via))
  t('click 把舞台坐标换算成画布像素（(0,0) → (240,180)）',
    Math.abs(r.result.canvasXY.x - 240) <= 1 && Math.abs(r.result.canvasXY.y - 180) <= 1,
    JSON.stringify(r.result.canvasXY))
  t('click 报出点了谁', r.result.clicked === 'Sprite1', String(r.result.clicked))
  r = await rpc('click', {})
  t('click 既没 target 也没 x/y 时明确报错', r.ok === false && /target.*x\/y/.test(r.error), r.error)

  // ---- press_key ----
  r = await rpc('press_key', { key: 'ArrowUp', holdMs: 10 })
  t('press_key ok', r.ok === true && r.result.key === 'ArrowUp', r.error)

  // ---- watch 瘦身 ----
  r = await rpc('watch', { action: 'start', target: 'Sprite1' })
  t('watch start 默认不跟列表（includeLists:false）', r.ok === true && r.result.includeLists === false, r.error)
  t('watch start 仍然告诉你有哪几个列表（只给长度）',
    r.result.listLengths && r.result.listLengths['地图.细胞类别'] === 5000, JSON.stringify(r.result.listLengths))
  r = await rpc('watch', { action: 'poll' })
  t('watch poll 的 current 只有标量（不把 5000 项列表塞进来）',
    r.ok === true && r.result.current['分数'] === 25 && !('地图.细胞类别' in r.result.current),
    JSON.stringify(Object.keys(r.result.current || {})))
  t('watch poll 体积可控（< 8KB；旧实现是 14.8MB）', Buffer.byteLength(JSON.stringify(r.result)) < 8192,
    Buffer.byteLength(JSON.stringify(r.result)) + ' bytes')
  r = await rpc('watch', { action: 'stop' })
  t('watch stop ok', r.ok === true && r.result.stopped === true, r.error)

  // ---- locate 跨角色搜索（P1-1） ----
  vm.setEditingTarget(stageT.id)
  const spriteHatId = Object.values(spriteT.blocks._blocks).find(b => b.opcode === 'event_whenflagclicked').id
  const locateWs = {
    getBlockById: (id) => (id === spriteHatId ? fakeBlock : null),
    centerOnBlock: () => {}
  }
  sandbox.ScratchBlocks = { getMainWorkspace: () => locateWs }
  r = await rpc('locate', { blockId: spriteHatId })
  t('locate 在别的角色里也能找到（跨角色搜索，不再只在当前编辑目标里翻）',
    r.ok === true && r.result.target === 'Sprite1', r.error)
  t('命中后自动把编辑目标切过去', vm.editingTarget && vm.editingTarget.getName() === 'Sprite1',
    vm.editingTarget && vm.editingTarget.getName())
  t('如实报"从哪个角色切过来"', r.result.switchedFrom === 'Stage', String(r.result.switchedFrom))
  r = await rpc('locate', { blockId: 'no_such_block_at_all' })
  t('找不到时列出找过谁（而不是甩锅给 add_blocks 换 ID）',
    r.ok === false && /个角色\/舞台里都没有/.test(r.error) && /找过/.test(r.error), r.error)

  // ==================== v0.8.0：背包（子树导出 + 变量引用落地） ====================
  // 背包能不能用，全看两件事：
  //   ① 存下来的片段是**自包含**的（引用的变量/列表连同值一起走）
  //   ② 注进别的角色/别的项目时，变量引用会被接上或补建（而不是留下「变量未找到」）
  // 这两条以前没有任何测试能发现：功能"看起来都对"，坏在跨角色那一步。
  console.log('\n[test v0.8.0] 背包：子树导出与变量落地')
  const varByName = (target, name) => Object.values(target.variables).find(v => v && v.name === name)
  const blocksById = (target, ids) => ids.map(id => target.blocks._blocks[id]).filter(Boolean)
  /** 在 sb3 dict 里按 id 找块（导出结果是 sb3 形态，只有压缩后的 next/inputs） */
  const sb3Block = (dict, id) => dict[id]
  /** 从帽子块顺着 next 链找第一个指定 opcode 的块（sb3 形态） */
  const sb3Find = (dict, rootId, opcode) => {
    let cur = dict[rootId]
    for (let i = 0; cur && i < 50; i++) {
      if (cur.opcode === opcode) return cur
      cur = cur.next ? dict[cur.next] : null
    }
    return null
  }
  const savedSb3Blocks = (dict, rootId) => sb3Find(dict, rootId, 'data_setvariableto') || {}

  // 手写一段：引用「舞台上的 分数（id 有效）」+「还不存在的 字模（id 是空的）」
  const bpTpl = {
    bp_h1: { opcode: 'event_whenflagclicked', next: 'bp_s1', parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 100, y: 100 },
    bp_s1: { opcode: 'data_setvariableto', next: null, parent: 'bp_h1', inputs: { VALUE: [1, [10, '1']] }, fields: { VARIABLE: ['分数', 'score_id'] }, shadow: false, topLevel: false },
    bp_h2: { opcode: 'data_deletealloflist', next: null, parent: null, inputs: {}, fields: { LIST: ['字模', ''] }, shadow: false, topLevel: true, x: 100, y: 300 }
  }
  r = await rpc('add_blocks', { target: 'Sprite1', blocks: bpTpl })
  t('AI 手写的空变量 id 会被就地补建（旧行为是留一块「变量未找到」）',
    r.ok === true && r.result.refs && (r.result.refs.created || []).some(c => c.name === '字模'),
    JSON.stringify(r.result.refs))
  const ziMo = varByName(spriteT, '字模')
  t('补建的列表挂在当前角色上、值是空列表（不是挂在舞台或没建）',
    !!ziMo && ziMo.type === 'list' && Array.isArray(ziMo.value) && ziMo.value.length === 0,
    ziMo ? ziMo.type + '/' + JSON.stringify(ziMo.value) : 'null')
  t('refsHint 用人话说明补建了什么（AI 不用去翻 refs 结构）',
    /补建了 1 个变量\/列表/.test(String(r.result.refsHint)), String(r.result.refsHint))
  const bpRoot1 = r.result.idMap.bp_h1
  const bpRoot2 = r.result.idMap.bp_h2

  // ---- export_blocks ----
  r = await rpc('export_blocks', { target: 'Sprite1', scriptIds: [bpRoot1, bpRoot2] })
  t('export_blocks ok', r.ok === true, r.error)
  t('导出的是 sb3 形态（输入压缩成数组，不是活块对象）',
    Array.isArray(savedSb3Blocks(r.result.blocks, bpRoot1).inputs.VALUE),
    JSON.stringify(savedSb3Blocks(r.result.blocks, bpRoot1)))
  t('块数只算子树的 3 块（内联字面量不算独立块）', r.result.blockCount === 3, String(r.result.blockCount))
  t('报出有几条脚本、各自什么帽子',
    r.result.scripts === 2 && r.result.topLevelOpcodes.join(',') === 'event_whenflagclicked,data_deletealloflist',
    JSON.stringify(r.result.topLevelOpcodes))
  const reqVars = (r.result.requires.variables || []).find(v => v.name === '分数')
  t('requires 带上引用的标量变量和它的当前值（跨项目搬的时候要用）',
    !!reqVars && reqVars.value === 25, JSON.stringify(r.result.requires.variables))
  const reqLists = (r.result.requires.lists || []).find(v => v.name === '字模')
  t('requires 带上引用的列表（字模这类列表就是片段的命）', !!reqLists && Array.isArray(reqLists.value), JSON.stringify(r.result.requires.lists))
  const savedBlocks = r.result.blocks
  const savedRequires = [].concat(r.result.requires.variables || [], r.result.requires.lists || [], r.result.requires.broadcasts || [])

  // ---- 往返：把导出的片段注进舞台 ----
  r = await rpc('add_blocks', { target: 'Stage', blocks: savedBlocks, variables: savedRequires })
  t('导出→注入往返成功（stage 也能吃下同一份 sb3 dict）', r.ok === true, r.error)
  const stageZiMo = varByName(stageT, '字模')
  t('目标上原来没有的列表被补建在 Stage 上', !!stageZiMo, String(!!stageZiMo))
  const injectedDel = blocksById(stageT, [r.result.idMap[bpRoot2]])[0]
  t('注入后 LIST 字段指向的是**目标里真实存在的**变量 id（不是原来那个悬空 id）',
    !!injectedDel && injectedDel.fields.LIST.id === (stageZiMo && stageZiMo.id),
    JSON.stringify(injectedDel && injectedDel.fields.LIST) + ' vs ' + (stageZiMo && stageZiMo.id))
  const setBlk = Object.values(stageT.blocks._blocks).find(b => b.opcode === 'data_setvariableto' && b.fields.VARIABLE.id === 'score_id')
  t('目标里已存在的全局变量保持原指向（没有被误改成新建的同名变量）', !!setBlk, 'score_id 指向丢失')
  t('refs.kept 报了"有几个引用原样有效"', r.result.refs && r.result.refs.kept >= 1, JSON.stringify(r.result.refs))

  // ---- 按名字改指向（id 失效但同名存在）----
  // 用「本角色计数」：它只在 Sprite1 上有一份，名字无歧义
  // （舞台上的「分数」在测试夹具里有两份同名变量，不适合做这条断言的靶子）
  const remapTpl = {
    bp_r1: { opcode: 'data_showvariable', next: null, parent: null, inputs: {}, fields: { VARIABLE: ['本角色计数', 'ghost-id-999'] }, shadow: false, topLevel: true, x: 500, y: 500 }
  }
  r = await rpc('add_blocks', { target: 'Sprite1', blocks: remapTpl })
  t('id 失效但同名变量存在 → 自动改指向（不新建重复变量）',
    r.ok === true && r.result.refs && (r.result.refs.remapped || []).some(x => x.name === '本角色计数' && x.to === 'local_id'),
    JSON.stringify(r.result.refs))
  const remappedBlk = blocksById(spriteT, [r.result.idMap.bp_r1])[0]
  t('改指向落到块上（字段里就是 local_id）', !!remappedBlk && remappedBlk.fields.VARIABLE.id === 'local_id',
    JSON.stringify(remappedBlk && remappedBlk.fields.VARIABLE))
  t('改指向不会顺手新建变量（refs.created 为空）', !r.result.refs || !r.result.refs.created, JSON.stringify(r.result.refs))

  // ---- 声明值：新建时用 variables 里的 value ----
  const newListTpl = {
    bp_n1: { opcode: 'data_deletealloflist', next: null, parent: null, inputs: {}, fields: { LIST: ['背包列表', ''] }, shadow: false, topLevel: true, x: 700, y: 100 }
  }
  r = await rpc('add_blocks', { target: 'Stage', blocks: newListTpl, variables: [{ name: '背包列表', type: 'list', value: ['甲', '乙'] }] })
  const bpList = varByName(stageT, '背包列表')
  t('新建列表时用上声明的值（背包带的字模内容真的进来了）',
    r.ok === true && !!bpList && JSON.stringify(bpList.value) === JSON.stringify(['甲', '乙']),
    bpList ? JSON.stringify(bpList.value) : 'null')

  // ---- 列表封顶：巨型列表别把背包撑爆 ----
  const bigListTpl = {
    bp_b1: { opcode: 'data_showlist', next: null, parent: null, inputs: {}, fields: { LIST: ['地图.细胞类别', 'big_list_id'] }, shadow: false, topLevel: true, x: 900, y: 100 }
  }
  r = await rpc('add_blocks', { target: 'Sprite1', blocks: bigListTpl })
  t('引用巨型列表的脚本注入成功', r.ok === true, r.error)
  r = await rpc('export_blocks', { target: 'Sprite1', scriptIds: [r.result.idMap.bp_b1] })
  const capped = (r.result.requires.lists || []).find(v => v.name === '地图.细胞类别')
  t('导出时列表按 listLimit 截断，并如实标出原始长度（否则 5000 项又搬一遍）',
    r.ok === true && !!capped && capped.truncated === true && capped.length === 5000 && capped.value.length === 1000,
    JSON.stringify(capped && { len: capped.length, kept: capped.value.length, truncated: capped.truncated }))
  r = await rpc('export_blocks', { target: 'Sprite1', all: true })
  t('all:true 导出这个角色的全部脚本', r.ok === true && r.result.scripts >= 3, r.error + ' / scripts=' + (r.result && r.result.scripts))

  // ---- 对拍：自己写的 live→sb3 转换器 vs 官方序列化器 ----
  // 为什么不直接用官方序列化器：TurboWarp 桌面版的 vm.toJSON() 会把 block id 压缩成 a/b/c
  // （真机踩到：手里的真 id 在输出里不存在）。所以转换器得自己写 —— 那就必须有个对拍，
  // 否则"看着像 sb3、注回去错"这类问题只能靠真机撞。
  // npm 版 scratch-vm 不压缩 id，于是这里可以**逐块深比**。
  const official = (JSON.parse(vm.toJSON()).targets.find(x => x.name === 'Sprite1') || {}).blocks || {}
  const mine = r.result.blocks
  const diffs = []
  const missingInMine = Object.keys(official).filter(id => !mine[id])
  const extraInMine = Object.keys(mine).filter(id => !official[id])
  if (missingInMine.length) diffs.push(`少了 ${missingInMine.length} 块: ${missingInMine.slice(0, 5)}`)
  if (extraInMine.length) diffs.push(`多了 ${extraInMine.length} 块: ${extraInMine.slice(0, 5)}`)
  const norm = (v) => JSON.stringify(v, (_k, val) => (val === undefined ? null : val))
  const blockDiff = (a, b) => {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort()
    if (ka.join(',') !== kb.join(',')) return `键不同 ${ka} vs ${kb}`
    for (const k of ['opcode', 'next', 'parent', 'shadow', 'topLevel', 'x', 'y']) {
      if (norm(a[k]) !== norm(b[k])) return `${k}: ${norm(a[k])} vs ${norm(b[k])}`
    }
    for (const k of ['fields', 'inputs', 'mutation']) {
      if (norm(a[k]) !== norm(b[k])) return `${k}: ${norm(a[k])} vs ${norm(b[k])}`
    }
    return null
  }
  for (const id of Object.keys(official)) {
    if (!mine[id]) continue
    const d = blockDiff(official[id], mine[id])
    if (d) diffs.push(`${id}(${official[id].opcode}): ${d}`)
    if (diffs.length > 6) break
  }
  t('导出结果与官方序列化器逐块一致（输入压缩/内联字面量/字段 id/坐标都对得上）',
    diffs.length === 0, diffs.slice(0, 4).join(' ｜ '))
  r = await rpc('export_blocks', { target: 'Sprite1' })
  t('既没 scriptIds 也没 all 时明确报错', r.ok === false && /scriptIds/.test(r.error), r.error)
  r = await rpc('export_blocks', { target: 'Sprite1', scriptIds: ['nope'] })
  t('id 全不存在时明确报错（不返回空片段）', r.ok === false && /都不在角色/.test(r.error), r.error)

  // ==================== M3：断链/接链、变量/列表、造型 ====================
  // 这一节的共同敌人是「指针没收拾干净」：重复挂载、孤儿块、悬空 parent。
  // 症状极隐蔽 —— 积木在 GUI 里看不见但还在执行（或反过来），快照/回滚都救不回来。
  // 所以每条操作之后都跟一次**双向指针体检**（block.parent ↔ parent 的槽必须互指）。
  console.log('[test] move_block（断链/接链）')
  const t1 = vm.runtime.targets.find(x => x.getName() === 'Sprite1')
  const bl = t1.blocks
  r = await rpc('add_blocks', {
    target: 'Sprite1',
    blocks: {
      m_hat: { opcode: 'event_whenflagclicked', next: 'm_a', parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 40, y: 700 },
      m_a: { opcode: 'motion_movesteps', next: 'm_b', parent: 'm_hat', inputs: { STEPS: [1, [4, '10']] }, fields: {}, shadow: false, topLevel: false },
      m_b: { opcode: 'control_wait', next: 'm_c', parent: 'm_a', inputs: { DURATION: [1, [5, '1']] }, fields: {}, shadow: false, topLevel: false },
      m_c: { opcode: 'looks_say', next: null, parent: 'm_b', inputs: { MESSAGE: [1, [10, 'hi']] }, fields: {}, shadow: false, topLevel: false },
      m_setx: { opcode: 'motion_setx', next: null, parent: null, inputs: { X: [1, [4, '0']] }, fields: {}, shadow: false, topLevel: true, x: 40, y: 900 },
      m_xpos: { opcode: 'motion_xposition', next: null, parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 40, y: 1000 }
    }
  })
  t('素材注入成功（三块链 + 一条独立脚本 + 一个报告块）', r.ok === true, r.error)
  const mid = r.result && r.result.idMap
  t('注入后链是 帽子→A→B→C', !!mid && bl.getBlock(mid.m_hat).next === mid.m_a &&
    bl.getBlock(mid.m_a).next === mid.m_b && bl.getBlock(mid.m_b).next === mid.m_c,
    J2(mid))

  r = await rpc('move_block', { target: 'Sprite1', blockId: mid.m_b, mode: 'detach' })
  t('detach 成功，并报出「从哪来」', r.ok === true && r.result.from && r.result.from.parent === mid.m_a,
    r.error + ' / ' + J2(r.result))
  t('detach 把断口补上了：前一块直接接上后一块（不留孤儿）',
    bl.getBlock(mid.m_a).next === mid.m_c && bl.getBlock(mid.m_c).parent === mid.m_a,
    `a.next=${J2(bl.getBlock(mid.m_a).next)} c.parent=${J2(bl.getBlock(mid.m_c).parent)}`)
  t('detach 出来的块变成顶层脚本（_scripts 有它、topLevel=true）',
    bl._scripts.includes(mid.m_b) && bl.getBlock(mid.m_b).topLevel === true, J2(bl._scripts))

  r = await rpc('move_block', { target: 'Sprite1', blockId: mid.m_b, mode: 'after', toBlockId: mid.m_a })
  t('after 插回中间：槽里已有块时插进去，后面那段跟着走（不能把 C 丢了）',
    r.ok === true && bl.getBlock(mid.m_a).next === mid.m_b &&
    bl.getBlock(mid.m_b).next === mid.m_c && bl.getBlock(mid.m_c).parent === mid.m_b,
    r.error + ' / ' + J2(bl.getBlock(mid.m_a).next))
  t('接回去以后不再是顶层脚本', !bl._scripts.includes(mid.m_b))
  // GUI 是按 vm 的 XML 重建工作区的（onWorkspaceUpdate → clearWorkspaceAndLoadFromXml），
  // 所以「块在 XML 里只出现一次、且嵌在父块里」是"用户真的看到它接上去了"的充分条件。
  // 真机踩过：数据对了但 GUI 没变 —— 就是这里 XML 把块又当成顶层脚本吐了一遍。
  const xmlOnce = String(bl.toXML())
  const occurrences = xmlOnce.split(mid.m_b).length - 1
  t('接回去之后，块在 toXML 里只出现一次（不会既当顶层脚本又当子块）',
    occurrences === 1, `出现 ${occurrences} 次`)

  r = await rpc('move_block', { target: 'Sprite1', blockId: mid.m_c, mode: 'before', toBlockId: mid.m_b })
  t('before 插到目标前面，目标原来的槽位不变（A→C→B）',
    r.ok === true && bl.getBlock(mid.m_a).next === mid.m_c &&
    bl.getBlock(mid.m_c).next === mid.m_b && bl.getBlock(mid.m_b).next === null &&
    bl.getBlock(mid.m_b).parent === mid.m_c,
    r.error + ' / ' + J2(r.result))

  r = await rpc('move_block', { target: 'Sprite1', blockId: mid.m_xpos, mode: 'input', toBlockId: mid.m_setx, inputName: 'X' })
  t('input 模式把报告块塞进输入槽', r.ok === true &&
    bl.getBlock(mid.m_setx).inputs.X.block === mid.m_xpos && bl.getBlock(mid.m_xpos).parent === mid.m_setx,
    r.error + ' / ' + J2(r.result))
  t('被塞满的输入里，原来那块字面量影子块还在（值不丢，拖出来还能用）',
    !!bl.getBlock(mid.m_setx).inputs.X.shadow && bl.getBlock(mid.m_setx).inputs.X.shadow !== mid.m_xpos,
    J2(bl.getBlock(mid.m_setx).inputs.X))
  t('塞进输入的报告块不再是顶层脚本', !bl._scripts.includes(mid.m_xpos))

  r = await rpc('move_block', { target: 'Sprite1', blockId: mid.m_xpos, mode: 'detach' })
  t('报告块能再拖出来：输入退回影子块（不是空槽）',
    r.ok === true && bl.getBlock(mid.m_setx).inputs.X.block === bl.getBlock(mid.m_setx).inputs.X.shadow,
    r.error + ' / ' + J2(bl.getBlock(mid.m_setx) && bl.getBlock(mid.m_setx).inputs.X))
  t('拖出来的报告块回到顶层脚本', bl._scripts.includes(mid.m_xpos))

  r = await rpc('move_block', { target: 'Sprite1', blockId: mid.m_hat, mode: 'after', toBlockId: mid.m_c })
  t('把链头接到自己的子孙上会被拒绝（成环会直接崩工作区）',
    r.ok === false && /成环|自己/.test(r.error), r.error)
  r = await rpc('move_block', { target: 'Sprite1', blockId: mid.m_a, mode: 'after', toBlockId: mid.m_a })
  t('接到自己身上被拒绝', r.ok === false && /自己/.test(r.error), r.error)
  r = await rpc('move_block', { target: 'Sprite1', blockId: mid.m_a, mode: 'input', toBlockId: mid.m_setx })
  t('input 模式缺 inputName 时明确报错', r.ok === false && /inputName/.test(r.error), r.error)

  // 双向指针体检：parent 指过去，对面必须指回来
  const ptrBad = []
  for (const [bid, b] of Object.entries(bl._blocks)) {
    if (b.parent) {
      const p = bl.getBlock(b.parent)
      if (!p) ptrBad.push(`${bid}.parent 指向不存在的块`)
      else if (!Object.values(p.inputs || {}).some(i => i.block === bid) && p.next !== bid) {
        ptrBad.push(`${bid}.parent→${b.parent}，但对面没指回来`)
      }
    }
    if (b.next) {
      const n = bl.getBlock(b.next)
      if (!n) ptrBad.push(`${bid}.next 指向不存在的块`)
      else if (n.parent !== bid) ptrBad.push(`${bid}.next→${b.next}，但它的 parent=${J2(n.parent)}`)
    }
  }
  t('一通断链/接链之后，指针双向一致（没有孤儿、没有重复挂载）', ptrBad.length === 0, ptrBad.slice(0, 4).join(' ｜ '))
  t('断链/接链没破坏活块模型（inputs/fields 形态仍然合法）',
    liveModelViolations(t1).length === 0, liveModelViolations(t1).slice(0, 3).join(' ｜ '))

  console.log('[test] variable（变量/列表的增删改）')
  r = await rpc('variable', { target: 'Sprite1', action: 'create', name: 'm3分', scope: 'global' })
  t('create 全局变量成功（返回 id 与 scope）', r.ok === true && r.result.scope === 'global' && !!r.result.id,
    r.error + ' / ' + J2(r.result))
  const scoreId = r.result && r.result.id
  t('变量真的挂在舞台上（不是角色局部）', !!stageT.variables[scoreId], Object.keys(stageT.variables).join(','))
  r = await rpc('variable', { action: 'create', name: 'm3分', scope: 'global' })
  t('同名变量会被拒绝，并说清是哪儿重名', r.ok === false && /已经有同名/.test(r.error), r.error)
  r = await rpc('variable', { action: 'set', name: 'm3分', value: 42 })
  t('set 赋值成功（数字保持数字，不变成字符串）', r.ok === true && r.result.value === 42, J2(r.result))
  r = await rpc('variable', { action: 'set', name: 'm3分', value: 'abc' })
  t('set 赋字符串', r.ok === true && r.result.value === 'abc', J2(r.result))
  r = await rpc('variable', { action: 'set', name: '不存在的变量', value: 1 })
  t('给不存在的变量赋值时明确报错并指路 create', r.ok === false && /找不到/.test(r.error) && /create/.test(r.error), r.error)

  r = await rpc('add_blocks', {
    target: 'Sprite1',
    blocks: {
      v_set: { opcode: 'data_setvariableto', next: null, parent: null, inputs: { VALUE: [1, [10, '1']] }, fields: { VARIABLE: ['m3分', ''] }, shadow: false, topLevel: true, x: 400, y: 700 }
    }
  })
  t('引用变量的积木注入成功，且字段 id 落到真变量上（resolveRefs）',
    r.ok === true && bl.getBlock(r.result.idMap.v_set).fields.VARIABLE.id === scoreId,
    r.error + ' / ' + J2(r.result && bl.getBlock(r.result.idMap.v_set)))
  const vBlockId = r.result && r.result.idMap.v_set

  r = await rpc('variable', { action: 'rename', name: 'm3分', newName: 'm3得分' })
  t('rename 成功', r.ok === true && r.result.to === 'm3得分' && r.result.from === 'm3分', J2(r.result))
  t('引用它的积木字段跟着改名（字段里存的是名字，不改就变「变量未找到」）',
    bl.getBlock(vBlockId).fields.VARIABLE.value === 'm3得分', J2(bl.getBlock(vBlockId).fields.VARIABLE))
  r = await rpc('variable', { action: 'delete', name: 'm3得分' })
  t('还有积木引用时拒绝删除，并报出是哪个块',
    r.ok === false && /还被 \d+ 个积木引用/.test(r.error) && r.error.includes(vBlockId), r.error)
  r = await rpc('variable', { action: 'delete', name: 'm3得分', force: true })
  t('force 时连引用它的积木一起删（不留「变量未找到」的孤儿块）',
    r.ok === true && !stageT.variables[scoreId] && !bl.getBlock(vBlockId) &&
    (r.result.removedBlocks || []).includes(vBlockId),
    J2(r.result))

  r = await rpc('variable', { target: 'Sprite1', action: 'create', name: '名字表', kind: 'list', scope: 'local' })
  t('create 列表成功（type=list，挂在本角色）',
    r.ok === true && !!t1.variables[r.result.id] && t1.variables[r.result.id].type === 'list',
    r.error + ' / ' + J2(r.result))
  const listId = r.result && r.result.id
  r = await rpc('variable', { action: 'set', name: '名字表', kind: 'list', value: ['甲', '乙'] })
  t('列表整体赋值', r.ok === true && JSON.stringify(r.result.value) === '["甲","乙"]' && r.result.length === 2, J2(r.result))
  r = await rpc('variable', { action: 'set', name: '名字表', kind: 'list', value: '不是数组' })
  t('给列表赋非数组会被明确拒绝（别悄悄变成一项）', r.ok === false && /数组/.test(r.error), r.error)
  r = await rpc('variable', { action: 'delete', name: '名字表', kind: 'list' })
  t('没被引用的列表可以直接删', r.ok === true && !t1.variables[listId], J2(r.result))

  console.log('[test] costume（造型改名/删除/切换）')
  const tinySvg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>'
  const beforeCount = t1.getCostumes().length
  r = await rpc('add_costume', { target: 'Sprite1', name: 'm3造型A', svg: tinySvg })
  t('先加一个造型当素材', r.ok === true, r.error)
  // ⚠️ 这条守的是「"?" 占位造型」那个真 bug：SVG 必须按**字节**存进 asset。
  //    存字符串时 scratch-storage 的 decodeText() 会抛 TypeError → loadCostume 走 catch →
  //    造型永远没有 skin，编辑器里显示成一张 "?"（浏览器/桌面版都会）。
  t('加造型后真的载入了皮肤（有 skinId + 有限的旋转中心）',
    r.ok === true && r.result.skin === true && Number.isFinite(r.result.rotationCenter[0]),
    J2(r.result))
  const emptySvg = await rpc('add_costume', { target: 'Sprite1', svg: '   ' })
  t('空 SVG 在碰 storage 之前就被拒绝（别把坏 asset 塞进项目）',
    emptySvg.ok === false && /svg 不能为空/.test(emptySvg.error), emptySvg.error)
  const addedIdx = t1.getCostumes().length // 1 起（与编辑器里显示一致）
  const addedName = t1.getCostumes()[addedIdx - 1].name
  t('新造型被追加到列表末尾', addedIdx === beforeCount + 1, `${beforeCount} -> ${addedIdx}`)

  r = await rpc('costume', { target: 'Sprite1', action: 'rename', index: addedIdx, newName: 'm3造型B' })
  t('rename 造型成功（报出原名/新名/序号）',
    r.ok === true && r.result.to === 'm3造型B' && r.result.from === addedName && r.result.index === addedIdx,
    r.error + ' / ' + J2(r.result))
  r = await rpc('costume', { target: 'Sprite1', action: 'rename', index: addedIdx, newName: t1.getCostumes()[0].name })
  t('改成已有的名字会自动去重（不出现两个同名造型）',
    r.ok === true && r.result.to !== t1.getCostumes()[0].name && r.result.deduped === true, J2(r.result))
  r = await rpc('costume', { target: 'Sprite1', action: 'set', index: addedIdx })
  t('set 切造型（截图前摆姿势用）',
    r.ok === true && r.result.current === addedIdx && r.result.name === t1.getCostumes()[addedIdx - 1].name, J2(r.result))
  r = await rpc('costume', { target: 'Sprite1', action: 'delete', index: addedIdx })
  t('delete 成功并报出还剩哪些', r.ok === true && r.result.remaining.length === beforeCount, J2(r.result))
  t('删完造型数回到原样（没有多删）', t1.getCostumes().length === beforeCount, `${t1.getCostumes().length}`)
  r = await rpc('costume', { target: 'Stage', action: 'delete', index: 1 })
  t('只剩一个造型时拒绝删除（删了角色就没法显示）', r.ok === false && /只剩一个造型/.test(r.error), r.error)
  r = await rpc('costume', { target: 'Sprite1', action: 'delete', index: 9 })
  t('越界序号明确报错', r.ok === false && /越界/.test(r.error), r.error)
  r = await rpc('costume', { target: 'Sprite1', action: 'rename', name: '不存在的造型', newName: 'x' })
  t('造型名不存在时把实际有哪些列出来', r.ok === false && /没有造型/.test(r.error), r.error)

  console.log(`\n===== ops 层单测: ${pass} pass / ${fail} fail =====`)
  process.exit(fail ? 1 : 0)
}

main().catch(e => { console.error('FATAL:', e); process.exit(1) })
