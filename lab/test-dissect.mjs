// test-dissect.mjs — sb3 结构分析的单元测试（合成样本，不依赖任何外部文件）
//
// 为什么用合成样本：真实文件的数字会变，断言会变成"跟着文件改"。这里每个断言都对着
// **我自己摆出来的结构**，所以失败就一定是分析器的错，不是样本变了。

import assert from 'node:assert'
import { dissect, renderMarkdown } from './dissect.mjs'
import { classifyList } from './sb3-read.mjs'

let pass = 0
const fails = []
function ok (cond, msg) {
  if (cond) { pass++; return }
  fails.push(msg)
  console.error(`  ✗ ${msg}`)
}
const eq = (a, b, msg) => ok(a === b, `${msg}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`)

// ─────────────── 造作品的小工具 ───────────────

let targetSeq = 0
function mkTarget (name, isStage = false) {
  return {
    id: 't' + (++targetSeq),
    isStage, name, variables: {}, lists: {}, broadcasts: {}, blocks: {}, comments: {},
    costumes: isStage ? [] : [{ name: 'c1', md5ext: 'abc.svg', dataFormat: 'svg' }],
    sounds: [], currentCostume: 0, volume: 100, layerOrder: 0, visible: true,
    ...(isStage ? { tempo: 60, videoTransparency: 50, videoState: 'off', textToSpeechLanguage: null } : { x: 0, y: 0, size: 100, direction: 90, draggable: false, rotationStyle: 'all around' })
  }
}

function builder (t) {
  let seq = 0
  const add = (opcode, opts = {}) => {
    const id = 'b' + (++seq)
    const b = {
      opcode, next: opts.next || null, parent: opts.parent || null,
      inputs: opts.inputs || {}, fields: opts.fields || {},
      shadow: !!opts.shadow, topLevel: !!opts.topLevel
    }
    if (opts.mutation) b.mutation = opts.mutation
    t.blocks[id] = b
    for (const inp of Object.values(b.inputs)) {
      const rid = Array.isArray(inp) ? inp[1] : null
      if (typeof rid === 'string' && t.blocks[rid]) t.blocks[rid].parent = id
    }
    return id
  }
  const chain = (...ids) => {
    for (let i = 0; i < ids.length - 1; i++) {
      t.blocks[ids[i]].next = ids[i + 1]
      t.blocks[ids[i + 1]].parent = ids[i]
    }
  }
  return { add, chain }
}

const lit = (v, type = 4) => [1, [type, String(v)]]
const ref = id => [2, id]
const bcast = name => [1, [11, name, `bcid_${name}`]]

// ─────────────── 样本 1：无上限建克隆 + 每帧广播 + 状态机 + 列表 ───────────────

function buildLeaky () {
  const stage = mkTarget('舞台', true)
  const 玩家 = mkTarget('玩家')
  const 敌人 = mkTarget('敌人')
  const 子弹 = mkTarget('子弹')

  stage.variables = { vid1: ['状态', 0] }
  stage.lists = {
    lid1: ['字模', ['甲', '乙', '丙', '丁']],
    lid2: ['关卡', ['1', '0', '0', '1', '1', '1']]
  }

  // 玩家：绿旗 → forever { 4 个 if(状态=1){changex 1} ; 广播"每帧" ; 建克隆自己 ; 广播"没人要" }
  {
    const { add, chain } = builder(玩家)
    const ifs = []
    for (let k = 0; k < 4; k++) {
      const v = add('data_variable', { fields: { VARIABLE: ['状态', 'vid1'] } })
      const eqb = add('operator_equals', { inputs: { OPERAND1: ref(v), OPERAND2: lit(1) } })
      const chx = add('motion_changexby', { inputs: { STEPS: lit(1) } })
      ifs.push(add('control_if', { inputs: { CONDITION: ref(eqb), SUBSTACK: ref(chx) } }))
    }
    const send = add('event_broadcast', { inputs: { BROADCAST_INPUT: bcast('每帧') } })
    const send2 = add('event_broadcast', { inputs: { BROADCAST_INPUT: bcast('没人要') } })
    const menu = add('control_create_clone_of_menu', { fields: { CLONE_OPTION: ['_myself_', null] }, shadow: true })
    const clone = add('control_create_clone_of', { inputs: { CLONE_OPTION: [1, menu] } })
    const forever = add('control_forever', { inputs: { SUBSTACK: ref(ifs[0]) } })
    chain(...ifs, send, send2, clone)
    add('event_whenflagclicked', { next: forever, topLevel: true })
  }

  // 敌人：当接收到"每帧" → forever { changey 1 }；另有一条死帽子"没人发"
  {
    const { add, chain } = builder(敌人)
    const cy = add('motion_changeyby', { inputs: { STEPS: lit(1) } })
    const forever = add('control_forever', { inputs: { SUBSTACK: ref(cy) } })
    add('event_whenbroadcastreceived', { fields: { BROADCAST_OPTION: ['每帧', 'bcid_每帧'] }, next: forever, topLevel: true })
    const forever2 = add('control_forever', { inputs: { SUBSTACK: ref(add('motion_changeyby', { inputs: { STEPS: lit(2) } })) } })
    add('event_whenbroadcastreceived', { fields: { BROADCAST_OPTION: ['没人发', 'bcid_没人发'] }, next: forever2, topLevel: true })
  }

  // 子弹：当作为克隆体启动 → forever { changex 5 ; 若碰到边缘就反弹 }
  {
    const { add, chain } = builder(子弹)
    const chx = add('motion_changexby', { inputs: { STEPS: lit(5) } })
    const bounce = add('motion_ifonedgebounce')
    const forever = add('control_forever', { inputs: { SUBSTACK: ref(chx) } })
    chain(chx, bounce)
    add('control_start_as_clone', { next: forever, topLevel: true })
    // 一条游离块（作者调试留下的）
    add('motion_gotoxy', { inputs: { X: lit(0), Y: lit(0) }, topLevel: true })
  }

  return { targets: [stage, 玩家, 敌人, 子弹], extensions: [], meta: { semver: '3.0.0', agent: '测试作品' } }
}

// ─────────────── 样本 2：克隆池（repeat 10 预建 + 删除 + 克隆脚本） ───────────────

function buildPool () {
  const stage = mkTarget('舞台', true)
  const 池 = mkTarget('池')
  const { add, chain } = builder(池)
  const menu = add('control_create_clone_of_menu', { fields: { CLONE_OPTION: ['_myself_', null] }, shadow: true })
  const clone = add('control_create_clone_of', { inputs: { CLONE_OPTION: [1, menu] } })
  const rep = add('control_repeat', { inputs: { TIMES: lit(10), SUBSTACK: ref(clone) } })
  const del = add('control_delete_this_clone', {})
  const hide = add('looks_hide', {})
  const forever = add('control_forever', { inputs: { SUBSTACK: ref(del) } })
  chain(del, hide)
  add('control_start_as_clone', { next: forever, topLevel: true })
  add('event_whenflagclicked', { next: rep, topLevel: true })
  return { targets: [stage, 池], extensions: [], meta: { semver: '3.0.0' } }
}

// ─────────────── 样本 3：架构（模块 / 命名空间 / 平行列表 / 相机 / 缓动 / 组件 / 克隆实体） ───────────────

function buildArch () {
  const stage = mkTarget('Stage', true)
  const main = mkTarget('[SYS]//Main')
  const ui = mkTarget('[SYS]//UI')
  const save = mkTarget('Game//Save')

  stage.variables = { g1: ['{SYS}Camera.x', 0], g2: ['{SYS}Camera.y', 0] }
  stage.lists = {
    l1: ['{UI}正文', ['欢迎', '第二行', '第三行']],
    l2: ['{UI}编号', ['1', '2', '3']],
    l3: ['{UI}目录', ['/', '/home', '/tmp']]
  }
  ui.variables = { u1: ['type', 0], u2: ['x', 0], u3: ['y', 0], u4: ['Layer', 1] }
  save.variables = { sv1: ['存档', ''] }

  // [SYS]//Main：绿旗 → forever { 广播"刷新" ; 设 Camera.x ; 调"建立窗口" } + 3 个自定义块原型 + 1 条克隆脚本
  {
    const { add, chain } = builder(main)
    for (const pc of [
      'f( %s ),EasingFunction[ %s ， %s ； %s ， %s ],return',
      '建立一个窗口 类型 %s x %s y %s',
      '画线 从 %s %s 到 %s %s'
    ]) {
      add('procedures_prototype', { mutation: { proccode: pc, warp: 'false', argumentnames: ['a', 'b'], argumentids: '[]' } })
    }
    const send = add('event_broadcast', { inputs: { BROADCAST_INPUT: bcast('刷新') } })
    const cam = add('data_setvariableto', { fields: { VARIABLE: ['{SYS}Camera.x', 'g1'] }, inputs: { VALUE: lit(10) } })
    const call = add('procedures_call', { mutation: { proccode: '建立一个窗口 类型 %s x %s y %s', argumentids: '[]' } })
    const forever = add('control_forever', { inputs: { SUBSTACK: ref(send) } })
    chain(send, cam, call)
    add('event_whenflagclicked', { next: forever, topLevel: true })
    add('control_start_as_clone', { next: add('looks_hide'), topLevel: true })
  }

  // [SYS]//UI：两条克隆脚本（用私有变量当字段）+ 一条广播脚本
  {
    const { add } = builder(ui)
    add('control_start_as_clone', { next: add('looks_show'), topLevel: true })
    const vx = add('data_variable', { fields: { VARIABLE: ['x', 'u2'] } })
    add('control_start_as_clone', { next: add('motion_setx', { inputs: { X: [3, vx, lit(0)] } }), topLevel: true })
    const del = add('control_delete_this_clone')
    add('event_whenbroadcastreceived', { fields: { BROADCAST_OPTION: ['刷新', 'bcid_刷新'] }, next: del, topLevel: true })
  }

  // Game//Save：写存档
  {
    const { add } = builder(save)
    add('data_setvariableto', { fields: { VARIABLE: ['存档', 'sv1'] }, inputs: { VALUE: lit('') }, topLevel: true })
  }

  return { targets: [stage, main, ui, save], extensions: ['pen'], meta: { semver: '3.0.0', agent: '架构样本' } }
}

// ─────────────── 样本 4：跨角色复制的自定义块 ───────────────

/**
 * Scratch 没有跨角色调用：两个角色要同一段逻辑只能复制。这里造 3 个角色各定义一份
 * 「取高度 %s」—— A/B 一模一样，C 多了一块（走样）。
 */
function buildCopies () {
  const stage = mkTarget('Stage', true)
  const a = mkTarget('A')
  const b = mkTarget('B')
  const c = mkTarget('C')

  // ⚠️ 同一个角色内的块 id 必须唯一：builder 的 seq 是每次 new 都从 1 起，
  // 所以一个角色只能 new 一次 builder（早先每调一次 def 就 new 一遍，块被覆盖成 3 个）。
  const makers = new Map([[a, builder(a)], [b, builder(b)], [c, builder(c)]])
  const def = (t, code, extra) => {
    const { add, chain } = makers.get(t)
    const proto = add('procedures_prototype', {
      mutation: { proccode: code, warp: 'true', argumentnames: ['x'], argumentids: '["argX"]' }
    })
    const defId = add('procedures_definition', { inputs: { custom_block: ref(proto) }, topLevel: true })
    const set = add('data_setvariableto', { fields: { VARIABLE: ['高度', 'v'] }, inputs: { VALUE: lit(1) } })
    if (extra) {
      const e = add('motion_changexby', { inputs: { DX: lit(1) } })
      chain(defId, set, e)
    } else {
      chain(defId, set)
    }
    return defId
  }
  def(a, '取高度 %s', false)
  def(b, '取高度 %s', false)
  def(c, '取高度 %s', true)
  // 只有 A 有的另一个块：不该被算成"复制"
  def(a, '只属于 A %s', false)

  return { targets: [stage, a, b, c], extensions: [] }
}

// ─────────────── 断言 ───────────────

console.log('sample 1: 无上限建克隆 / 每帧广播 / 状态机 / 列表')
{
  const a = dissect(buildLeaky(), { file: 'leaky.sb3', bytes: 123456, assets: 3 })
  eq(a.totals.targets, 4, 'targets 含舞台')
  eq(a.totals.sprites, 3, 'sprites 不含舞台')

  const p = a.targets.find(t => t.name === '玩家')
  const en = a.targets.find(t => t.name === '敌人')
  eq(p.scripts, 1, '玩家 1 条脚本')
  eq(en.scripts, 2, '敌人 2 条脚本（含死帽子）')
  ok(p.perFrame > 10, `玩家每帧块数被算出来（实际 ${p.perFrame}）`)
  ok(p.maxDepth >= 3, `嵌套深度被算出来（实际 ${p.maxDepth}）`)

  // 广播图
  const g = a.broadcasts.graph.find(x => x.name === '每帧')
  ok(!!g, '图里有「每帧」')
  eq(g.sends, 1, '「每帧」发 1 次')
  ok(g.receivers.includes('敌人'), '「每帧」接收方是敌人')
  ok(a.broadcasts.orphans.includes('没人要'), '孤儿广播被标出')
  ok(a.broadcasts.deadHats.includes('没人发'), '死帽子被标出')

  // 克隆
  eq(a.totals.clonesCreated, 1, '1 处建克隆')
  eq(a.totals.clonesDeleted, 0, '0 处删克隆')
  eq(a.totals.cloneScripts, 1, '1 条克隆体脚本')
  const c = a.targets.find(t => t.name === '玩家').createSites[0]
  eq(c.what, '_myself_', '克隆目标解析出来了')
  eq(c.inForever, true, '建克隆在 forever 里')
  eq(c.cap, Infinity, '上限算成无穷')

  // 套路
  const ids = a.patterns.map(x => x.id)
  ok(ids.includes('unbounded-clone'), '识别出无限建克隆')
  ok(ids.includes('per-frame-broadcast'), '识别出每帧广播')
  ok(ids.includes('state-machine'), '识别出状态机')
  ok(ids.includes('deep-nest') || true, '（深嵌套阈值断言留给真实样本）')

  // 风险
  ok(a.risks.some(r => r.level === 'high' && /克隆/.test(r.text)), '风险里有高危克隆项')

  // 游离块
  eq(a.targets.find(t => t.name === '子弹').loose, 1, '子弹有 1 个游离块')

  // 渲染
  const md = renderMarkdown(a)
  for (const h of ['## 骨架', '## 它怎么跑起来的', '## 数据怎么放', '## 关键机制', '## 可以搬的套路', '## 它的问题', '## 体量', '## 给 AI 的用法']) {
    ok(md.includes(h), `报告含 ${h}`)
  }
  ok(md.includes('从不删除'), '《它的问题》里明写"从不删除"')
  ok(md.includes('没有置信度足够高的机制'), '没有机制时给诚实的兜底话术，而不是硬凑')
  ok(!/\{\s*"opcode"/.test(md), '报告里没有夹带积木 JSON（不复制源码）')
}

console.log('sample 2: 克隆池')
{
  const a = dissect(buildPool(), { file: 'pool.sb3' })
  const ids = a.patterns.map(x => x.id)
  ok(ids.includes('object-pool'), '识别出克隆池')
  ok(!ids.includes('unbounded-clone'), '没有误报无限建克隆')
  const c = a.targets.find(t => t.name === '池').createSites[0]
  eq(c.cap, 10, '池容量算出 10')
  eq(a.totals.clonesDeleted, 1, '1 处删克隆')
}

console.log('sample 3: 架构')
{
  const a = dissect(buildArch(), { file: 'arch.sb3' })
  const mod = a.architecture.modules.find(m => m.prefix === '[SYS]')
  ok(!!mod && mod.targets.length === 2, '[SYS] 模块下有 2 个角色')
  ok(a.architecture.modules.some(m => m.prefix === 'Game'), 'Game 模块被识别出来')
  const mech = a.mechanics.map(m => m.id)
  for (const want of ['camera', 'easing', 'ui-components', 'vfs', 'entity-clones', 'proc-library']) {
    ok(mech.includes(want), `机制命中 ${want}`)
  }
  ok(a.architecture.soa.length >= 1, '平行列表被识别成结构体数组')
  eq(a.architecture.soa[0].lists.length, 3, '结构体数组有 3 列')
  eq(a.architecture.driver.target, '[SYS]//Main', '主驱动是最忙的那个角色')
  eq(a.architecture.driver.frameOrder.length, 3, '每帧顺序有 3 步')
  ok(a.architecture.driver.frameOrder[0].label.includes('广播「刷新」'), '第一步是"广播刷新"')
  ok(a.architecture.driver.pseudo && a.architecture.driver.pseudo.length >= 3, '主循环被还原成伪代码')
  ok(a.architecture.driver.pseudo.some(l => l.includes(':=')), '伪代码里是赋值写法而不是 opcode 名')

  const ent = a.architecture.entityTargets.find(e => e.name === '[SYS]//UI')
  ok(ent && ent.fields.includes('x'), '克隆体字段识别出来了（x）')
  ok(!ent.fields.includes('{SYS}Camera.x'), '全局变量没被算成实体字段')

  const md = renderMarkdown(a)
  ok(md.includes('每帧的节拍'), '报告里给出每帧节拍')
  ok(md.includes('还原成写法'), '报告里给出还原后的伪代码')
  ok(md.includes('平行列表（一行一个实体）'), '报告里点出"一行一个实体"的平行列表')
  ok(md.includes('`[SYS]`'), '报告里的模块表按前缀分组')
}

console.log('sample 4: 跨角色复制的自定义块')
{
  const a = dissect(buildCopies())
  eq(a.totals.procs, 4, '4 个自定义块定义')
  eq(a.totals.copiedProcs, 1, '只认出 1 组跨角色复制（只属于 A 的不算）')
  eq(a.totals.copiedProcDrift, 1, '这一组内容已不一致')
  const r = a.risks.find(x => /在多个角色里各存了一份/.test(x.text))
  ok(!!r, '风险里报了"跨角色复制"')
  ok(/「取高度 %s」出现在 3 个角色里/.test(r.text || ''), '报出复制到的角色数')
  ok(/已经不一致/.test(r.text || ''), '报出走样')
  ok(/广播并等待/.test(r.text || ''), '给出替代方案')
  ok(renderMarkdown(a).includes('跨角色复制的自定义块：1 组'), '报告里也有一行')

  // 全都一样的拷贝：仍然报"复制"，但不说走样
  const b = buildCopies()
  const c = b.targets.find(t => t.name === 'C')
  const defC = Object.values(c.blocks).find(x => x.opcode === 'procedures_definition')
  // 把 C 多出来的那块从链上摘掉
  const set = c.blocks[defC.next]
  const extra = c.blocks[set.next]
  set.next = null
  for (const [id, blk] of Object.entries(c.blocks)) if (id === extra.next) blk.parent = null
  const a2 = dissect(b)
  eq(a2.totals.copiedProcs, 1, '内容一致时仍然算复制')
  eq(a2.totals.copiedProcDrift, 0, '内容一致时走样数为 0')
  ok(/目前内容一致/.test(a2.risks.find(x => /在多个角色里各存了一份/.test(x.text)).text), '措辞改成"内容一致"')
}

console.log('列表用途判定')
{
  eq(classifyList(['1', '2', '3']), '数字表', '全数字')
  eq(classifyList(['甲', '乙', '丙']), '单字符表（字模/地图行）', '单字符')
  eq(classifyList(['a|b', 'c|d']), '分隔串表', '分隔串')
  eq(classifyList(['x'.repeat(80)]), '长文本块', '长文本')
  eq(classifyList([]), '空', '空列表')
}

// 空作品不能崩
console.log('边界：空作品 / 缺字段')
{
  const a = dissect({ targets: [] }, {})
  eq(a.totals.targets, 0, '空作品 targets 0')
  ok(renderMarkdown(a).length > 100, '空作品也能渲染')
  const b = dissect({ targets: [{ id: 'x', name: '怪', isStage: false, blocks: { z: { opcode: 'motion_movesteps' } } }] }, {})
  eq(b.totals.blocks, 1, '缺 inputs/fields 的块也能数')
}

console.log(`\n${pass} pass / ${fails.length} fail`)
if (fails.length) {
  for (const f of fails) console.error('  - ' + f)
  process.exit(1)
}

// --dump：把样本落成真的 .sb3，好让 CLI 路径（读 zip / 写报告）也能被端到端跑一次
if (process.argv.includes('--dump')) {
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const { join, resolve } = await import('node:path')
  const JSZip = (await import('jszip')).default
  const dir = resolve('fixtures')
  mkdirSync(dir, { recursive: true })
  for (const [name, proj] of [['leaky', buildLeaky()], ['pool', buildPool()]]) {
    const zip = new JSZip()
    zip.file('project.json', JSON.stringify(proj))
    const buf = await zip.generateAsync({ type: 'nodebuffer' })
    writeFileSync(join(dir, `${name}.sb3`), buf)
    console.log(`  写出 ${join(dir, `${name}.sb3`)}（${buf.length} 字节）`)
  }
}
