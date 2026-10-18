// dissect.mjs — 把一个 .sb3 拆成架构报告
//
// 起因：内置 skill 之前是照规范写的，缺"东西大了以后该怎么组织"这一类判断。
// 这个工具把 project.json 摊成能读的形式：模块分工、事件拓扑、每帧节拍（附主循环伪代码）、
// 数据布局、识别到的机制、结构风险。对着报告看，比在积木区里翻几百个脚本快得多。
//
// 用法：
//   node dissect.mjs <文件.sb3|project.json> [--out 目录] [--json] [--stdout]
//
// 产物：
//   <out>/<名字>.md            人看的报告
//   <out>/<名字>.analysis.json 机器看的分析对象（批量对比用）
//
// 报告只输出统计和结构描述，不含积木 JSON。

import { writeFileSync, mkdirSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  readProject, blockMap, isReal, inputRef, inputValue, fieldValue,
  walkFrom, ancestorOpcodes, topLevelBlocks, isHat, listsOf, variablesOf, classifyList
} from './sb3-read.mjs'

const LOOP_OPS = new Set(['control_forever', 'control_repeat', 'control_repeat_until', 'control_while', 'control_for_each'])

const inAnyLoop = (m, id) => ancestorOpcodes(m, id).some(o => LOOP_OPS.has(o))
const inForever = (m, id) => ancestorOpcodes(m, id).includes('control_forever')

/** 往上找一个 control_repeat 的次数字面量；在 forever 里返回 Infinity */
function repeatLiteral (m, id) {
  const seen = new Set()
  let cur = m.get(id)
  while (cur && cur.parent && !seen.has(cur.parent)) {
    seen.add(cur.parent)
    cur = m.get(cur.parent)
    if (!cur) break
    if (cur.opcode === 'control_forever') return Infinity
    if (cur.opcode === 'control_repeat') {
      const n = Number(inputValue(cur.inputs && cur.inputs.TIMES))
      return Number.isFinite(n) ? n : undefined
    }
  }
  return undefined
}

/** 一条脚本里"每帧要跑多少块"：forever 自己不算，里面的（含嵌套子栈）都算 */
function perFrameCount (m, rootId) {
  let n = 0
  const seen = new Set()
  const stack = [[rootId, false]]
  while (stack.length) {
    const [id, inF] = stack.pop()
    if (!id || seen.has(id)) continue
    seen.add(id)
    const b = m.get(id)
    if (!b) continue
    const nowIn = inF || b.opcode === 'control_forever'
    if (nowIn && b.opcode !== 'control_forever') n++
    if (b.next) stack.push([b.next, nowIn])
    for (const inp of Object.values(b.inputs || {})) {
      const r = inputRef(inp, m)
      if (r) stack.push([r, nowIn])
    }
  }
  return n
}

/** 一次遍历：这个 target 里有哪些 opcode、哪些变量出现在比较里、等 */
function scanTarget (t, m) {
  const real = [...m.values()].filter(isReal)
  const tops = topLevelBlocks(m)
  const hats = tops.filter(({ block: b }) => isHat(b.opcode))
  const loose = tops.length - hats.length

  // 注意:forever 极少是顶层块,通常是帽子脚本里的第二块。所以必须从**每条脚本**往下扫,
  // 而不是只数 topLevel 的 forever（第一版就这么写错了,玩家明明塞满了块却报 0）。
  let perFrame = 0
  for (const { id } of tops) perFrame += perFrameCount(m, id)

  let maxDepth = 0
  for (const { id } of tops) {
    for (const s of walkFrom(m, id)) if (s.depth > maxDepth) maxDepth = s.depth
  }

  const createSites = []
  let deletes = 0
  let startAsClone = 0
  let waits = 0
  const comparedVars = new Map()

  for (const [id, b] of m) {
    if (b.opcode === 'control_create_clone_of') {
      const menuId = inputRef(b.inputs && b.inputs.CLONE_OPTION, m)
      const menu = menuId ? m.get(menuId) : null
      createSites.push({
        what: menu ? (fieldValue(menu, 'CLONE_OPTION') || '?') : (inputValue(b.inputs && b.inputs.CLONE_OPTION) || '?'),
        inLoop: inAnyLoop(m, id),
        inForever: inForever(m, id),
        cap: repeatLiteral(m, id)
      })
    } else if (b.opcode === 'control_delete_this_clone') deletes++
    else if (b.opcode === 'control_start_as_clone') startAsClone++
    else if (b.opcode === 'control_wait') {
      const n = Number(inputValue(b.inputs && b.inputs.DURATION))
      if (Number.isFinite(n) && n >= 0.3) waits++
    }

    // 变量被拿来比较 —— 状态机的指纹
    if (b.opcode === 'data_variable') {
      const name = fieldValue(b, 'VARIABLE')
      if (name && ancestorOpcodes(m, id).some(o => o === 'operator_equals' || o === 'operator_lt' || o === 'operator_gt')) {
        comparedVars.set(name, (comparedVars.get(name) || 0) + 1)
      }
    }
  }

  const hatCounts = {}
  for (const { block: b } of hats) hatCounts[b.opcode] = (hatCounts[b.opcode] || 0) + 1

  return {
    id: t.id,
    name: t.name || '(无名)',
    isStage: !!t.isStage,
    blocks: real.length,
    blocksAll: m.size,
    scripts: hats.length,
    loose,
    perFrame,
    maxDepth,
    costumes: (t.costumes || []).length,
    sounds: (t.sounds || []).length,
    variables: Object.keys(t.variables || {}).length,
    lists: Object.keys(t.lists || {}).length,
    broadcasts: Object.keys(t.broadcasts || {}).length,
    comments: Object.keys(t.comments || {}).length,
    hatCounts,
    createSites,
    deletes,
    startAsClone,
    waits,
    comparedVars: [...comparedVars.entries()].sort((a, b) => b[1] - a[1])
  }
}

/** 主分析：纯函数，不碰磁盘、不联网 */
export function dissect (project, meta = {}) {
  const targets = (project.targets || []).filter(Boolean)
  // 用位置兜底:真实的 sb3 一定有 id,但手工造的/坏文件可能没有,不能让 Map 收敛成一个
  const keyOf = (t, i) => t.id || `#${i}`
  const maps = new Map()
  targets.forEach((t, i) => maps.set(keyOf(t, i), blockMap(t)))
  const mapOf = (t, i) => maps.get(keyOf(t, i))
  const titleOf = t => t.name || (t.isStage ? '舞台' : '(无名)')

  const opHist = new Map()
  for (const b of [...maps.values()].flatMap(m => [...m.values()])) {
    if (isReal(b)) opHist.set(b.opcode, (opHist.get(b.opcode) || 0) + 1)
  }
  const opSorted = [...opHist.entries()].sort((a, b) => b[1] - a[1])

  // ---------- 广播拓扑 ----------
  const sends = []
  const recvs = []
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]
    const m = mapOf(t, i)
    for (const [id, b] of m) {
      if (b.opcode === 'event_broadcast' || b.opcode === 'event_broadcastandwait') {
        const inp = b.inputs && b.inputs.BROADCAST_INPUT
        const lit = inputValue(inp)
        const dynamic = lit === undefined && !!inputRef(inp, m)
        sends.push({
          target: titleOf(t), name: lit === undefined ? null : String(lit), dynamic,
          wait: b.opcode === 'event_broadcastandwait',
          inLoop: inAnyLoop(m, id), inForever: inForever(m, id)
        })
      } else if (b.opcode === 'event_whenbroadcastreceived') {
        recvs.push({ target: titleOf(t), name: fieldValue(b, 'BROADCAST_OPTION') || null })
      }
    }
  }
  const names = [...new Set([...sends.map(s => s.name), ...recvs.map(r => r.name)].filter(Boolean))]
  // 广播名字的前缀成体系（raise-* / sync-* / on-*）＝ 他在用"事件总线"而不是随手起名
  const famMap = new Map()
  for (const n of names) {
    const mm = /^([A-Za-z\u4e00-\u9fa5]{1,10})[-_.]/.exec(n)
    if (mm) famMap.set(mm[1], (famMap.get(mm[1]) || 0) + 1)
  }
  const families = [...famMap].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([prefix, n]) => ({ prefix, n }))
  const graph = names.map(n => ({
    name: n,
    sends: sends.filter(s => s.name === n).length,
    waits: sends.filter(s => s.name === n && s.wait).length,
    senders: [...new Set(sends.filter(s => s.name === n).map(s => s.target))],
    receivers: [...new Set(recvs.filter(r => r.name === n).map(r => r.target))]
  })).sort((a, b) => b.sends - a.sends)
  const orphans = graph.filter(g => g.sends > 0 && g.receivers.length === 0).map(g => g.name)
  const deadHats = graph.filter(g => g.sends === 0).map(g => g.name)
  const dynamicSends = sends.filter(s => s.dynamic).length

  // ---------- 每个 target ----------
  const perTarget = targets.map((t, i) => scanTarget(t, mapOf(t, i))).sort((a, b) => b.blocks - a.blocks)
  const totalPerFrame = perTarget.reduce((n, s) => n + s.perFrame, 0)

  // ---------- 自定义块 ----------
  const procs = []
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]
    const m = mapOf(t, i)
    for (const [id, b] of m) {
      if (b.opcode !== 'procedures_prototype') continue
      const mu = b.mutation || {}
      procs.push({
        target: titleOf(t), proccode: mu.proccode || '',
        warp: String(mu.warp) === 'true',
        args: Array.isArray(mu.argumentnames) ? mu.argumentnames.length : 0
      })
    }
  }
  const warpCount = procs.filter(p => p.warp).length

  // ---------- 数据 ----------
  const lists = []
  for (const t of targets) {
    for (const l of listsOf(t)) {
      lists.push({
        target: titleOf(t), name: l.name, len: l.len,
        kind: classifyList(l.values),
        sample: l.values.slice(0, 3).map(v => String(v).slice(0, 40))
      })
    }
  }
  lists.sort((a, b) => b.len - a.len)
  const scalars = []
  for (const t of targets) {
    for (const v of variablesOf(t)) {
      if (typeof v.value === 'string' && v.value.length > 60) continue
      scalars.push({ target: titleOf(t), name: v.name, value: v.value })
    }
  }

  // ---------- 套路识别 ----------
  const patterns = []
  const add = (id, title, conf, evidence, lesson) => patterns.push({ id, title, conf, evidence, lesson })

  const allCreate = perTarget.flatMap(s => s.createSites.map(c => ({ ...c, target: s.name })))
  const totalDeletes = perTarget.reduce((n, s) => n + s.deletes, 0)
  const totalCloneScripts = perTarget.reduce((n, s) => n + s.startAsClone, 0)

  const poolSites = allCreate.filter(c => Number.isFinite(c.cap) && c.cap > 1)
  if (poolSites.length && totalDeletes && totalCloneScripts) {
    add('object-pool', '克隆池（预建固定数量、反复复用）', 'high', [
      `${poolSites.length} 处在 repeat N 里建克隆（N=${[...new Set(poolSites.map(c => c.cap))].join('/')}）`,
      `${totalCloneScripts} 条「当作为克隆体启动时」脚本`,
      `${totalDeletes} 处「删除此克隆体」`
    ], '一次性在 repeat 里建好固定数量，克隆体脚本开头等一个「就绪」广播或循环检查，用完 hide 而不是 delete，下次直接用 —— 省掉反复 create 的开销（每次建克隆都要复制造型/变量，是 Scratch 里最贵的事之一）。')
  }

  const unbounded = allCreate.filter(c => c.inForever)
  if (unbounded.length && !totalDeletes) {
    add('unbounded-clone', '无限建克隆（在 forever 里建且没有任何删除）', 'high', [
      `${unbounded.length} 处 control_create_clone_of 直接或间接在 forever 里`,
      '全项目 0 处「删除此克隆体」'
    ], '这是最常见的卡死原因：每帧新建一个，克隆体只增不减，十几秒后帧率掉到底。要么配 delete，要么改成固定池。')
  }

  const perFrameBroadcast = sends.filter(s => s.inForever)
  if (perFrameBroadcast.length) {
    add('per-frame-broadcast', '每帧广播', 'high', [
      `${perFrameBroadcast.length} 个广播块在 forever 里（${[...new Set(perFrameBroadcast.map(s => s.name || '(动态)'))].slice(0, 4).join('、')}）`,
      `接收方共 ${[...new Set(perFrameBroadcast.flatMap(s => graph.find(g => g.name === s.name)?.receivers || []))].length} 个角色`
    ], '广播每帧发一次 = 每帧唤醒所有接收方的帽子脚本并重建线程，开销远大于直接改一个全局变量。只有「必须打断接收方当前脚本」时才用广播；纯传值用变量。')
  }

  const stateVars = perTarget.flatMap(s => s.comparedVars.filter(([, n]) => n >= 4).map(([name, n]) => ({ target: s.name, name, n })))
  if (stateVars.length) {
    add('state-machine', '状态机（同一个变量被反复比较）', 'medium',
      stateVars.slice(0, 4).map(v => `[${v.target}] ${v.name} 参与比较 ${v.n} 次`),
      '用一个变量表示"当前处于哪个阶段"，每帧 if/else 分派。比"靠广播 + wait 串流程"更耐改：加一个状态只改一处，不会出现漏接广播导致卡在半路。')
  }

  const listSearch = (opHist.get('data_listcontainsitem') || 0) + (opHist.get('data_itemnumoflist') || 0)
  if (listSearch >= 3) {
    add('list-search', '列表线性检索', 'medium', [
      `data_listcontainsitem ${opHist.get('data_listcontainsitem') || 0} 个 + data_itemnumoflist ${opHist.get('data_itemnumoflist') || 0} 个`,
      lists.length ? `最大列表 ${lists[0].name} ${lists[0].len} 项` : ''
    ].filter(Boolean), '「列表里包含」和「编号」都是从头扫到尾的 O(n)。在每帧循环里对上千项的列表做这个，是隐藏的性能黑洞。常见解法：加一个"索引表"列表（值 → 下标），或把查询挪到事件触发时做一次。')
  }

  const scrollVars = scalars.filter(v => /相机|camera|scroll|视差|parallax|镜头|偏移/i.test(v.name))
  if (scrollVars.length) {
    add('camera-scroll', '卷轴/相机（用一个坐标量统一平移）', 'medium',
      scrollVars.slice(0, 4).map(v => `变量「${v.name}」`),
      '所有物体的位置都写成 (自身坐标 − 相机坐标)，移动相机就等于整个世界滚动。好处是"世界"可以无限大而不需要真的摆无限多东西。')
  }

  const timelineScripts = perTarget.filter(s => s.waits >= 3)
  if (timelineScripts.length) {
    add('timeline-wait', '时间轴（用 wait 串过场）', 'medium',
      timelineScripts.map(s => `[${s.name}] 单角色 ${s.waits} 个 ≥0.3 秒的等待`),
      '过场/演出用固定 wait 串起来最省事，但改一处节奏就要动整条链。作品一旦要做"可跳过"，通常会被重写成状态机 + 计时器变量。')
  }

  if (warpCount) {
    add('warp-proc', '自定义块开「运行时不刷新屏幕」', 'high', [
      `${warpCount}/${procs.length} 个自定义块开了 warp`
    ], 'warp 里的循环一次跑完，不插帧。适合"生成关卡""算一次路径"这种一次性的重活；不适合动画（画面会直接跳过去）。')
  }

  if (totalPerFrame > 300) {
    add('heavy-forever', '每帧负担偏重', 'high', [
      `全项目 forever 循环体合计 ${totalPerFrame} 块/帧`,
      `最重的角色 ${perTarget.filter(s => s.perFrame > 0).sort((a, b) => b.perFrame - a.perFrame).slice(0, 3).map(s => `${s.name} ${s.perFrame}`).join('、') || '—'}`
    ], '每帧能跑的块数是有上限的（30 帧下每帧 33ms）。把不必要的东西从 forever 里挪出去（比如碰撞检测改成事件驱动，或用列表一次算完），比优化单个块的写法收益大得多。')
  }

  const maxDepth = Math.max(0, ...perTarget.map(s => s.maxDepth))
  if (maxDepth >= 8) {
    add('deep-nest', '深嵌套', 'low', [`最深的块嵌套 ${maxDepth} 层`],
      '嵌套超过七八层基本都是可以抽成自定义块的逻辑。抽出来以后 AI 和你都更容易改 —— 也更容易被切开单独测试。')
  }

  const saveNames = [...scalars.map(v => v.name), ...lists.map(l => l.name)].filter(n => /存档|save|记录|进度|最高分|best|rank/i.test(n))
  if (saveNames.length) {
    add('save-data', '存档/记录', 'medium', [`${[...new Set(saveNames)].slice(0, 5).join('、')}`],
      'Scratch 没有文件系统，存档一般落在"列表 + 一串 join 后的字符串"里。要小心的是：读档时列表项可能是空的（第一次玩），必须默认值兜底，否则整个存档逻辑会静默崩。')
  }

  const penBlocks = [...opHist].filter(([k]) => k.startsWith('pen_')).reduce((n, [, v]) => n + v, 0)
  if (penBlocks >= 50) {
    add('pen-heavy', '画笔密集', 'medium', [`pen_* 块合计 ${penBlocks}`],
      '画笔每帧要真的画线，块数一多就会拖帧。常见做法是"静态的先用 stamp 一次性盖上去，只有动的部分每帧重画"。')
  }

  // ---------- 结论 ----------
  // 两边都写死的比较：标准 TurboWarp 里恒假。真实作品里这种情况常常是"变量名写成了字符串"
  let constCmp = 0
  for (const m of maps.values()) {
    for (const b of m.values()) {
      if (b.opcode !== 'operator_equals' && b.opcode !== 'operator_lt' && b.opcode !== 'operator_gt') continue
      if (!inputRef(b.inputs && b.inputs.OPERAND1, m) && !inputRef(b.inputs && b.inputs.OPERAND2, m)) constCmp++
    }
  }
  const nonStd = opSorted.filter(([op]) => !/^[a-z0-9]+_[a-zA-Z0-9_]+$/.test(op) || /\b(gandi|gandi_|ext_)/i.test(op))
  const risks = []
  if (unbounded.length && !totalDeletes) risks.push({ level: 'high', text: '在 forever 里建克隆且从不删除 —— 跑久了必然掉帧' })
  if (perFrameBroadcast.length) risks.push({ level: 'high', text: `${perFrameBroadcast.length} 个广播每帧发送，接收方的帽子脚本每帧都要重建线程` })
  if (listSearch >= 3 && lists.some(l => l.len > 500)) risks.push({ level: 'mid', text: '对上千项的列表做「包含/编号」查询，O(n)' })
  if (totalPerFrame > 300) risks.push({ level: 'mid', text: `每帧 ${totalPerFrame} 块，离 33ms 的帧预算不远` })
  if (orphans.length) risks.push({ level: 'low', text: `${orphans.length} 个广播发出去没人接（${orphans.slice(0, 3).join('、')}）` })
  if (deadHats.length) risks.push({ level: 'low', text: `${deadHats.length} 个接收帽子没有任何发送方（${deadHats.slice(0, 3).join('、')}）` })
  if (constCmp >= 3) {
    risks.push({
      level: 'mid',
      text: `${constCmp} 处判断是**两边都写死的常量**（例如 "{Window}type" = "本体"）。标准 TurboWarp 里这种比较恒为假；` +
        '可能是把变量名当成字符串写进去了，也可能依赖了平台特有的求值方式 —— 搬到别的编辑器之前必须先弄清是哪一种'
    })
  }
  if (nonStd.length) risks.push({ level: 'info', text: `${nonStd.length} 种非标准 opcode（疑似扩展或平台方言）：${nonStd.slice(0, 6).map(([o]) => o).join('、')}` })

  const totals = {
    targets: targets.length,
    sprites: targets.filter(t => !t.isStage).length,
    blocks: opSorted.reduce((n, [, v]) => n + v, 0),
    blocksWithShadow: [...maps.values()].reduce((n, m) => n + m.size, 0),
    scripts: perTarget.reduce((n, s) => n + s.scripts, 0),
    loose: perTarget.reduce((n, s) => n + s.loose, 0),
    perFrame: totalPerFrame,
    maxDepth,
    procs: procs.length,
    warpProcs: warpCount,
    clonesCreated: allCreate.length,
    clonesDeleted: totalDeletes,
    cloneScripts: totalCloneScripts,
    broadcasts: names.length,
    lists: lists.length,
    variables: scalars.length,
    assets: (meta.assets || 0)
  }

  const rawAgent = (project.meta && project.meta.agent) || null
  // 有的平台把 User-Agent 写进 meta.agent（有的站点就这么干），当标题用会得到一整串 Mozilla/…
  const agent = rawAgent && !/Mozilla\/|AppleWebKit|Chrome\//.test(rawAgent) ? rawAgent : null
  const a = {
    schema: 2,
    generatedAt: new Date().toISOString(),
    file: meta.file || null,
    bytes: meta.bytes || null,
    projectName: meta.projectName || agent || null,
    semver: (project.meta && project.meta.semver) || null,
    totals,
    extensions: project.extensions || [],
    opcodes: opSorted,
    targets: perTarget,
    broadcasts: { graph, orphans, deadHats, dynamicSends, totalSends: sends.length, families },
    procs,
    lists,
    scalars,
    patterns,
    risks
  }
  a.architecture = analyzeArchitecture(targets, maps, perTarget, procs, lists, scalars, project)
  a.mechanics = detectMechanics(a, project)
  return a
}

// ─────────────────────── 架构：谁负责什么、怎么跑起来 ───────────────────────
//
// 这一层才是报告的正文。统计数字只能当证据用——"17 个角色 16378 块"本身不构成经验，
// "17 个角色按 [MAIN]/Game/Unit 三层分工，主循环在 [MAIN]//MAIN，UI 全靠 Window 组件化"才是。

/** 角色名前缀即模块名：`[MAIN]//Window` → `[MAIN]`，`Game//Music` → `Game`，`Stage` → `(独立)` */
function moduleOf (name) {
  const m = /^(.*?)(\/\/|__|_)/.exec(String(name))
  return (m && m[1]) || '(独立)'
}

/** 变量/列表名里的命名空间：`{MAIN}Camera.x` → `{MAIN}`、`[EDITOR]Layer` → `[EDITOR]`、
 *  `卡牌-解锁` → `卡牌-`（中文项目里最常见的写法其实是"前缀-字段"） */
function nsOf (name) {
  const s = String(name)
  const m = /^(\{[^}]*\}|\[[^\]]*\])/.exec(s)
  if (m) return m[1]
  const m2 = /^([^-\s（(：:]{1,12})[-–—]/.exec(s)
  return m2 ? `${m2[1]}-` : null
}

/** next 链的顺序遍历（跟 walkFrom 不同：不钻进输入槽，只走同一层的先后） */
function chainOf (m, rootId) {
  const out = []
  let id = rootId
  const seen = new Set()
  while (id && !seen.has(id)) {
    seen.add(id)
    const b = m.get(id)
    if (!b) break
    out.push({ id, block: b })
    id = b.next
  }
  return out
}

/** 把一个表达式块翻译成"它到底在比什么"——条件里到底是哪个变量/哪个函数 */
function valueName (m, id, depth = 0) {
  const b = m.get(id)
  if (!b || depth > 2) return null
  if (b.opcode === 'data_variable') return `「${fieldValue(b, 'VARIABLE')}」`
  if (b.opcode === 'procedures_call') return `「${(b.mutation && b.mutation.proccode) || '?'}」的返回`
  if (b.opcode === 'operator_equals' || b.opcode === 'operator_lt' || b.opcode === 'operator_gt') {
    const l = inputRef(b.inputs && b.inputs.OPERAND1, m)
    const r = inputRef(b.inputs && b.inputs.OPERAND2, m)
    const ln = l ? valueName(m, l, depth + 1) : inputValue(b.inputs && b.inputs.OPERAND1)
    const rn = r ? valueName(m, r, depth + 1) : inputValue(b.inputs && b.inputs.OPERAND2)
    const op = { operator_equals: '=', operator_lt: '<', operator_gt: '>' }[b.opcode]
    return `${ln ?? '?'} ${op} ${rn ?? '?'}`
  }
  if (b.opcode === 'operator_and' || b.opcode === 'operator_or') {
    return `${b.opcode === 'operator_and' ? '与' : '或'} 条件`
  }
  if (b.opcode === 'sensing_keypressed') return '按键'
  if (b.opcode === 'sensing_mousedown') return '鼠标按下'
  return null
}

/** 把一个块翻成一句人话（用于"每帧依次做什么"） */
function labelOf (m, b) {
  const val = (n) => inputValue(b.inputs && b.inputs[n])
  switch (b.opcode) {
    case 'event_broadcast':
    case 'event_broadcastandwait': {
      const v = val('BROADCAST_INPUT')
      return `${b.opcode === 'event_broadcastandwait' ? '广播并等待' : '广播'}「${v ?? '(动态)'}」`
    }
    case 'procedures_call': return `调用「${(b.mutation && b.mutation.proccode) || '?'}」`
    case 'data_setvariableto': return `设「${fieldValue(b, 'VARIABLE')}」`
    case 'data_changevariableby': return `改「${fieldValue(b, 'VARIABLE')}」`
    case 'control_wait': return `等 ${val('DURATION')} 秒`
    case 'control_repeat': return `重复 ${val('TIMES')} 次`
    case 'control_repeat_until':
    case 'control_wait_until': {
      const c = inputRef(b.inputs && b.inputs.CONDITION, m)
      const txt = c ? valueName(m, c) : null
      return `${b.opcode === 'control_wait_until' ? '等到' : '重复直到'} ${txt || '条件成立'}`
    }
    case 'control_if':
    case 'control_if_else': {
      const c = inputRef(b.inputs && b.inputs.CONDITION, m)
      const txt = c ? valueName(m, c) : null
      return `若 ${txt || '…'}`
    }
    case 'control_stop': return `停止（${fieldValue(b, 'STOP_OPTION') || '?'}）`
    default: {
      const op = b.opcode
      if (op.startsWith('motion_')) return `移动/坐标（${op.slice(7)}）`
      if (op.startsWith('looks_')) return `外观（${op.slice(6)}）`
      if (op.startsWith('pen_')) return `画笔（${op.slice(4)}）`
      if (op === 'sound_play') return '播放声音'
      if (op.startsWith('sound_')) return `声音（${op.slice(6)}）`
      return op
    }
  }
}

/** 找"每帧最多事"的那个 forever，返回它的循环体起点 + 顺序链 */
function findBestForever (m) {
  let best = null
  for (const { id } of topLevelBlocks(m)) {
    const w = walkFrom(m, id)
    const f = w.find(s => s.block.opcode === 'control_forever')
    if (!f) continue
    const sub = inputRef(f.block.inputs && f.block.inputs.SUBSTACK, m)
    if (!sub) continue
    const chain = chainOf(m, sub)
    if (!best || chain.length > best.chain.length) best = { chain, sub }
  }
  return best
}

function frameOrderOf (m) {
  const best = findBestForever(m)
  if (!best) return null
  return best.chain.map(({ block }) => ({ opcode: block.opcode, label: labelOf(m, block), ...kindOf(m, block) }))
}

/** 步骤的类别 + "在分派谁"（用来把一长串 if 压成"12 个条件分派，主要在比 X"） */
function kindOf (m, b) {
  const op = b.opcode
  if (op === 'control_if' || op === 'control_if_else' || op === 'control_wait_until' || op === 'control_repeat_until') {
    const c = inputRef(b.inputs && b.inputs.CONDITION, m)
    const subj = c ? valueName(m, c) : null
    // 只留被比较的那个变量名，不要具体值 —— 否则"比关卡 2-2/2-4/2-5"会变成三个不同的主语
    const lead = subj ? /^「[^」]+」/.exec(subj) : null
    return { kind: 'if', subject: lead ? lead[0] : subj }
  }
  if (op === 'procedures_call') return { kind: 'call', subject: (b.mutation && b.mutation.proccode) || null }
  if (op === 'event_broadcast' || op === 'event_broadcastandwait') return { kind: 'broadcast', subject: inputValue(b.inputs && b.inputs.BROADCAST_INPUT) }
  if (op.startsWith('data_')) return { kind: 'set', subject: fieldValue(b, 'VARIABLE') }
  if (op === 'control_wait' || op === 'control_repeat' || op === 'control_forever') return { kind: 'wait', subject: null }
  return { kind: 'other', subject: null }
}

// ─────────────────── 伪代码：把积木还原成"他是怎么写出来的" ───────────────────
//
// 读报告的人要的是**写法**，不是"他有几个角色"。所以主循环必须能还原成一段能照着写的
// 伪代码：`frameDt := (计时器 - lastTimer)`、`如果 frameDt > 0.075 { frameDt := 0.075 }`。
// 只还原主循环，且带长度预算——这不是导出源码，是让人看懂节拍。

const EXPR_BIN = {
  operator_add: '+', operator_subtract: '-', operator_multiply: '*', operator_divide: '/',
  operator_mod: 'mod', operator_equals: '=', operator_lt: '<', operator_gt: '>',
  operator_and: '且', operator_or: '或', operator_contains: '包含'
}

function exprOf (m, id, depth = 0) {
  const b = m.get(id)
  if (!b || depth > 3) return '…'
  // 影子块（下拉菜单/按键选择器）本身就是"值"，直接给它的字段，别把 opcode 打出来
  if (b.shadow) {
    const f = Object.values(b.fields || {})[0]
    if (Array.isArray(f) && f.length) return String(f[0])
  }
  const inp = (n) => {
    const r = inputRef(b.inputs && b.inputs[n], m)
    return r ? exprOf(m, r, depth + 1) : (inputValue(b.inputs && b.inputs[n]) ?? '')
  }
  switch (b.opcode) {
    case 'data_variable': return String(fieldValue(b, 'VARIABLE') ?? '?')
    case 'operator_not': return `非(${inp('OPERAND')})`
    case 'operator_join': return `${inp('STRING1')} + ${inp('STRING2')}`
    case 'operator_letter_of': return `第 ${inp('LETTER')} 个字符于 ${inp('STRING')}`
    case 'operator_length': return `长度(${inp('STRING')})`
    case 'operator_round': return `取整(${inp('NUM')})`
    case 'operator_mathop': return `${fieldValue(b, 'OPERATOR') ?? '?'}(${inp('NUM')})`
    case 'operator_random': return `随机(${inp('FROM')}, ${inp('TO')})`
    case 'data_itemoflist': return `${fieldValue(b, 'LIST') ?? '?'}[${inp('INDEX')}]`
    case 'data_itemnumoflist': return `编号于 ${fieldValue(b, 'LIST') ?? '?'}(${inp('ITEM')})`
    case 'data_lengthoflist': return `长度(${fieldValue(b, 'LIST') ?? '?'})`
    case 'sensing_timer': return '计时器'
    case 'sensing_of': return `${inp('PROPERTY')} 于 ${inp('OBJECT')}`
    case 'sensing_keypressed': return `按下(${fieldValue(b, 'KEY_OPTION') ?? inp('KEY_OPTION')})`
    case 'looks_costume': return '造型名'
    case 'looks_size': return '大小'
    case 'motion_xposition': return 'x 坐标'
    case 'motion_yposition': return 'y 坐标'
    case 'motion_direction': return '方向'
    case 'procedures_call': return `${(b.mutation && b.mutation.proccode) || '?'}()`
    case 'argument_reporter_string_number':
    case 'argument_reporter_boolean': return String(fieldValue(b, 'VALUE') ?? '?')
    default: {
      if (EXPR_BIN[b.opcode]) {
        const left = inp('OPERAND1') || inp('NUM1') || inp('STRING1')
        const right = inp('OPERAND2') || inp('NUM2') || inp('STRING2')
        return `(${left} ${EXPR_BIN[b.opcode]} ${right})`
      }
      return b.opcode
    }
  }
}

/** 一条语句 → 一到多行伪代码（带缩进） */
function stmtOf (m, b, indent) {
  const pad = '  '.repeat(indent)
  const inp = (n) => {
    const r = inputRef(b.inputs && b.inputs[n], m)
    return r ? exprOf(m, r) : (inputValue(b.inputs && b.inputs[n]) ?? '')
  }
  const sub = (n) => {
    const r = inputRef(b.inputs && b.inputs[n], m)
    return r ? blockOf(m, r, indent + 1) : []
  }
  switch (b.opcode) {
    case 'data_setvariableto': return [`${pad}${fieldValue(b, 'VARIABLE')} := ${inp('VALUE')}`]
    case 'data_changevariableby': return [`${pad}${fieldValue(b, 'VARIABLE')} += ${inp('VALUE')}`]
    case 'data_addtolist': return [`${pad}加入 ${fieldValue(b, 'LIST')} <- ${inp('ITEM')}`]
    case 'data_replaceitemoflist': return [`${pad}${fieldValue(b, 'LIST')}[${inp('INDEX')}] := ${inp('ITEM')}`]
    case 'data_deleteoflist': return [`${pad}删除 ${fieldValue(b, 'LIST')}[${inp('INDEX')}]`]
    case 'control_if': return [`${pad}如果 ${inp('CONDITION')} {`, ...sub('SUBSTACK'), `${pad}}`]
    case 'control_if_else': return [`${pad}如果 ${inp('CONDITION')} {`, ...sub('SUBSTACK'), `${pad}} 否则 {`, ...sub('SUBSTACK2'), `${pad}}`]
    case 'control_repeat': return [`${pad}重复 ${inp('TIMES')} 次 {`, ...sub('SUBSTACK'), `${pad}}`]
    case 'control_repeat_until': return [`${pad}重复直到 ${inp('CONDITION')} {`, ...sub('SUBSTACK'), `${pad}}`]
    case 'control_wait_until': return [`${pad}等到 ${inp('CONDITION')}`]
    case 'control_forever': return [`${pad}永远 {`, ...sub('SUBSTACK'), `${pad}}`]
    case 'control_wait': return [`${pad}等 ${inp('DURATION')} 秒`]
    case 'control_stop': return [`${pad}停止(${fieldValue(b, 'STOP_OPTION') ?? '?'})`]
    case 'control_create_clone_of': {
      const menu = inputRef(b.inputs && b.inputs.CLONE_OPTION, m)
      const what = menu ? fieldValue(m.get(menu), 'CLONE_OPTION') : '?'
      return [`${pad}克隆(${what})`]
    }
    case 'control_delete_this_clone': return [`${pad}删除此克隆体`]
    case 'event_broadcast':
    case 'event_broadcastandwait': return [`${pad}${b.opcode === 'event_broadcastandwait' ? '广播并等待' : '广播'} "${inp('BROADCAST_INPUT')}"`]
    case 'procedures_call': return [`${pad}${(b.mutation && b.mutation.proccode) || '?'}()`]
    case 'motion_gotoxy': return [`${pad}移到(${inp('X')}, ${inp('Y')})`]
    case 'motion_setx': return [`${pad}x := ${inp('X')}`]
    case 'motion_sety': return [`${pad}y := ${inp('Y')}`]
    case 'looks_switchcostumeto': return [`${pad}换成造型 ${inp('COSTUME')}`]
    case 'looks_setsizeto': return [`${pad}大小 := ${inp('SIZE')}`]
    case 'sensing_resettimer': return [`${pad}重置计时器`]
    default: return [`${pad}${b.opcode}(${Object.keys(b.inputs || {}).map(k => inp(k)).filter(v => v !== '').join(', ')})`]
  }
}

/** 从一个块的 next 链展开成伪代码行；带预算，防止几万块的项目把报告撑爆 */
function blockOf (m, rootId, indent = 0, budget = { lines: 18, chars: 1400 }) {
  const out = []
  let id = rootId
  const seen = new Set()
  while (id && !seen.has(id)) {
    seen.add(id)
    const b = m.get(id)
    if (!b) break
    const lines = stmtOf(m, b, indent)
    const cost = lines.join('\n').length
    if (out.length + lines.length > budget.lines || cost > budget.chars) {
      out.push(`${'  '.repeat(indent)}…（后面还有 ${b.opcode} 起的若干块）`)
      break
    }
    budget.chars -= cost
    out.push(...lines)
    id = b.next
  }
  return out
}

function pseudoOf (m, rootId) {
  if (!rootId) return null
  const lines = blockOf(m, rootId, 0)
  return lines.length ? lines : null
}

function analyzeArchitecture (targets, maps, perTarget, procs, lists, scalars, project) {
  const titleOf = t => t.name || (t.isStage ? '舞台' : '(无名)')

  // ---- 模块：角色名前缀
  const mods = new Map()
  for (const s of perTarget) {
    const k = moduleOf(s.name)
    if (!mods.has(k)) mods.set(k, { prefix: k, targets: [], blocks: 0, scripts: 0, perFrame: 0, clones: 0, hats: {} })
    const g = mods.get(k)
    g.targets.push(s.name)
    g.blocks += s.blocks
    g.scripts += s.scripts
    g.perFrame += s.perFrame
    g.clones += s.createSites.length
    for (const [op, n] of Object.entries(s.hatCounts || {})) g.hats[op] = (g.hats[op] || 0) + n
  }
  const modules = [...mods.values()].sort((a, b) => b.blocks - a.blocks)
  // 模块的"干什么"只按帽子构成给标签——这是从结构读出来的，不是猜它的题材
  const totalFrame = perTarget.reduce((n, s) => n + s.perFrame, 0) || 1
  for (const g of modules) {
    const procDefs = g.hats.procedures_definition || 0
    const bcast = g.hats.event_whenbroadcastreceived || 0
    const flags = g.hats.event_whenflagclicked || 0
    if (g.perFrame / totalFrame > 0.4) g.role = '主循环（扛大头）'
    else if (procDefs >= g.scripts * 0.5 && g.scripts > 3) g.role = '函数库（被调用）'
    else if (g.clones && !g.perFrame) g.role = '实体模板（只克隆，自己不跑）'
    else if (bcast > flags && !g.perFrame) g.role = '被动响应（广播唤醒）'
    else if (bcast > flags) g.role = '子系统（广播驱动 + 少量自跑）'
    else g.role = '自跑脚本'
  }

  // ---- 命名空间
  const nsMap = new Map()
  const touch = (ns, kind, name) => {
    if (!ns) return
    if (!nsMap.has(ns)) nsMap.set(ns, { ns, vars: [], lists: [] })
    nsMap.get(ns)[kind].push(name)
  }
  for (const v of scalars) touch(nsOf(v.name), 'vars', v.name)
  for (const l of lists) touch(nsOf(l.name), 'lists', l.name)
  const namespaces = [...nsMap.values()]
    .filter(g => g.vars.length + g.lists.length >= 2)
    .sort((a, b) => (b.vars.length + b.lists.length) - (a.vars.length + a.lists.length))
    .map(g => ({ ns: g.ns, vars: g.vars.length, lists: g.lists.length, samples: [...g.vars, ...g.lists].slice(0, 5) }))

  // ---- 平行列表（一行一个实体）：同一个命名空间下 ≥3 个列表共用同一个长度
  //      允许有个别不等长的（比如"解锁表"101 项而其余 61 项），只要**多数对齐**就算同一张表；
  //      完全不看长度就会把"共用一个前缀"误判成结构体——那是最容易骗过人的一步。
  const soa = []
  for (const g of namespaces.filter(x => x.lists >= 3)) {
    const mine = lists.filter(l => nsOf(l.name) === g.ns)
    const byLen = new Map()
    for (const l of mine) byLen.set(l.len, (byLen.get(l.len) || 0) + 1)
    const [bestLen, cnt] = [...byLen].sort((a, b) => b[1] - a[1])[0]
    // 三条硬条件：多数对齐、真的装了行（bestLen > 0）、占比够高。
    // 少一条就会把"共用一个前缀的一堆无关列表"说成数据表（`H-` 那 29 张表长度各不相同，第一版就误判了）。
    if (cnt < 3 || bestLen <= 0 || cnt / mine.length < 0.6) continue
    soa.push({
      ns: g.ns,
      len: bestLen,
      lists: mine.map(l => ({ name: l.name.replace(g.ns, ''), len: l.len, kind: l.kind })),
      outliers: mine.length - cnt
    })
  }
  soa.sort((a, b) => b.lists.length - a.lists.length)

  // ---- 通信与驱动
  const kinds = { flag: 0, broadcast: 0, key: 0, click: 0, clone: 0, procDef: 0, other: 0 }
  for (const m of maps.values()) {
    for (const b of m.values()) {
      if (b.opcode === 'event_whenflagclicked') kinds.flag++
      else if (b.opcode === 'event_whenbroadcastreceived') kinds.broadcast++
      else if (b.opcode === 'event_whenkeypressed') kinds.key++
      else if (b.opcode === 'event_whenthisspriteclicked' || b.opcode === 'event_whenstageclicked') kinds.click++
      else if (b.opcode === 'control_start_as_clone') kinds.clone++
      else if (b.opcode === 'procedures_definition') kinds.procDef++
    }
  }

  // 主驱动 = 每帧块数最多的角色；顺便把它的循环体顺序翻出来
  const driverStat = [...perTarget].filter(s => s.perFrame > 0).sort((a, b) => b.perFrame - a.perFrame)[0] || null
  let driver = null
  if (driverStat) {
    const t = targets.find(x => (x.name || '') === driverStat.name) || null
    const m = t ? maps.get(t.id) || [...maps.values()][targets.indexOf(t)] : null
    const best = m ? findBestForever(m) : null
    driver = {
      target: driverStat.name,
      perFrame: driverStat.perFrame,
      share: perTarget.reduce((n, s) => n + s.perFrame, 0) ? driverStat.perFrame / perTarget.reduce((n, s) => n + s.perFrame, 0) : 0,
      frameOrder: m ? frameOrderOf(m) : null,
      pseudo: m && best ? pseudoOf(m, best.sub) : null
    }
  }

  // ---- 克隆体当实体：克隆脚本里用到的**角色私有变量**就是它在存的字段
  // （按命名空间猜不可靠 —— 真实作品里 `[MAIN]//Window` 用的却是 `{Window}` 前缀）
  const stage = targets.find(t => t.isStage)
  const globalVarIds = new Set(Object.keys((stage && stage.variables) || {}))
  const entityTargets = []
  for (let i = 0; i < targets.length; i++) {
    const s = perTarget.find(x => x.name === (targets[i].name || ''))
    if (!s || !s.startAsClone) continue
    const m = maps.get(targets[i].id || `#${i}`)
    if (!m) continue
    const fields = new Set()
    for (const [hid, hb] of m) {
      if (hb.opcode !== 'control_start_as_clone') continue
      for (const st of walkFrom(m, hid)) {
        if (st.block.opcode !== 'data_variable') continue
        const f = st.block.fields && st.block.fields.VARIABLE
        if (f && !globalVarIds.has(f[1])) fields.add(String(f[0]))
      }
    }
    entityTargets.push({ name: s.name, clones: s.startAsClone, fields: [...fields].slice(0, 10) })
  }

  return { modules, namespaces, soa, kinds, driver, entityTargets, procs, extensions: project.extensions || [] }
}

// ─────────────────────── 机制：他到底怎么解决这个问题的 ───────────────────────
//
// 每条机制 = 名字 + 证据（名字/opcode/结构）+ "怎么做"的一句话。证据不足就不报，
// 宁可漏也不要编——上一版 skill 就是编出来的。

function detectMechanics (a, project) {
  const out = []
  const names = [
    ...a.targets.map(t => t.name),
    ...a.scalars.map(v => v.name),
    ...a.lists.map(l => l.name),
    ...a.procs.map(p => p.proccode)
  ]
  const hits = re => [...new Set(names.filter(n => re.test(n)))]
  const ops = new Map(a.opcodes)
  const has = op => (ops.get(op) || 0) > 0
  const ext = (project.extensions || []).map(String)
  const pen = [...ops].filter(([k]) => k.startsWith('pen_')).reduce((n, [, v]) => n + v, 0)

  const add = (id, name, conf, evidence, how) => { if (evidence.length) out.push({ id, name, conf, evidence, how }) }

  const font = hits(/字符宽度表|字模|字体|font|文字|text|glyph/i)
  if (font.length && (pen >= 5 || has('looks_switchcostumeto'))) {
    add('pixel-text', '自己渲染文字（像素/画笔字体）', 'high', [
      ...font.slice(0, 3),
      pen ? `画笔块 ${pen} 个` : '用造型切换逐字显示'
    ], '把每个字符的宽度预先算好塞进一张表（这里就是『字符宽度表』），渲染时按索引取宽、逐字画。这样排版不用每帧量尺寸，才能做到稳定的换行和对齐。')
  }

  const camera = hits(/camera|相机|镜头|视差|parallax/i)
  if (camera.length) {
    add('camera', '相机（把世界坐标换算成屏幕坐标）', camera.length >= 2 ? 'high' : 'medium',
      camera.slice(0, 4),
      '所有实体只存"世界坐标"，真正落到舞台时统一走一次 (世界坐标 − 相机坐标)。相机成了唯一变量，镜头移动就不用逐个改实体。')
  }

  const easing = hits(/easing|缓动|f\(x\)|tween/i)
  if (easing.length) {
    add('easing', '缓动函数库（把动画抽成一个函数）', 'high', easing.slice(0, 3),
      '把贝塞尔/正弦缓动包成一个自定义块，参数是控制点和 t，返回 0~1 的进度。所有动画只要求这个函数，节奏就能统一调，而不是每个动画各写一套插值。')
  }

  const win = hits(/window|窗口|组件|widget/i)
  if (win.length) {
    add('ui-components', 'UI 组件化（克隆体当控件）', win.length >= 3 ? 'high' : 'medium', win.slice(0, 4),
      '一个"建立控件"自定义块，参数是 类型/内容/编号/x/y/size/图层，内部就是建一个克隆体并把参数塞进它的私有变量。于是加一个按钮＝调一次这个块，不用新建角色。')
  }

  // 注意别用裸的 fs / file 当关键词：bfsAt、profile 这种名字会被误判成"文件系统"
  const vfs = hits(/盘区|目录|文件系统|filesystem|fileSystem|storage|虚拟盘|档案/i)
  if (vfs.length) {
    add('vfs', '把数据当"文件系统"管理', 'high', vfs.slice(0, 4),
      '正文/编号/所处目录/文件类型/标签 各存一张平行列表，同一行下标就是一个"文件"。这是结构体数组：比一行塞一个长字符串好按字段查询，也比建一堆变量好遍历。')
  }

  const layer = hits(/layer|图层/i)
  if (layer.length) {
    add('layers', '图层（用变量 + 广播控制遮挡顺序）', layer.length >= 2 ? 'high' : 'medium', layer.slice(0, 4),
      '每个实体带一个图层号，需要重排时发广播让相关角色按图层号重设前后关系。好处是加新元素不用改既有代码，只要给个号。')
  }

  const pipeline = hits(/前置|后置|伊始|刷新|pipeline|阶段/i)
  if (pipeline.length >= 3) {
    add('refresh-pipeline', '刷新分阶段（前置 → 本体 → 后置）', 'high', pipeline.slice(0, 5),
      '同一次刷新拆成几个广播按固定顺序发，每个角色只挂自己关心的那一段。这样"谁先算"变成显式约定，不会因为角色添加顺序变了就出现错帧。')
  }

  const save = hits(/save|存档|进度|记录/i)
  if (save.length) {
    add('save', '存档', 'medium', save.slice(0, 3),
      '把状态序列化成字符串塞进列表（Scratch 没有文件系统）。读档时一定要给默认值——第一次玩的时候那些列表项是空的。')
  }

  const music = hits(/music|音乐|音轨|bgm/i)
  if (music.length) {
    add('music', '多轨音频（克隆体各放各的）', 'medium', music.slice(0, 3),
      '一个角色克隆出 N 个克隆体，每个负责一条声部，用克隆体私有变量记住自己播到哪。这样能同时播多轨，而不用一个角色串行播。')
  }

  if (ext.some(e => /physics|fermi|box2d|matter/i.test(e))) {
    add('physics', '用物理扩展', 'high', ext.filter(e => /physics|fermi|box2d|matter/i.test(e)),
      '碰撞和受力交给扩展算，自己只读结果。代价是扩展的坐标系和 Scratch 不一致时要手动换算。')
  }

  if (a.totals.cloneScripts >= 3) {
    add('entity-clones', '克隆体当实体（私有变量存字段）', a.totals.cloneScripts >= 6 ? 'high' : 'medium',
      [`${a.totals.cloneScripts} 条克隆体脚本`, `${a.totals.clonesCreated} 处建克隆`],
      '每个克隆体用私有变量存自己的 x/y/速度/状态，于是"一个角色 = 一个类，一个克隆体 = 一个实例"。这是 Scratch 里做多实体最省事的办法，注意别在 forever 里无脑新建。')
  }

  if (a.totals.procs >= 3) {
    add('proc-library', '自定义块当函数库', a.totals.procs >= 10 ? 'high' : 'medium',
      [`${a.totals.procs} 个自定义块`, a.totals.warpProcs ? `${a.totals.warpProcs} 个开了 warp` : ''],
      '把"建窗口""画线""缓动"这类反复用的逻辑做成带参数的自定义块。Scratch 里它既能复用也能递归，还能开 warp 一次算完不插帧。')
  }

  // ---- 以下是"写法"级的机制：不看名字，看主循环里到底怎么写的
  const drv = (a.architecture && a.architecture.driver) || null
  const pseudo = (drv && drv.pseudo) || []
  const dtLine = pseudo.find(l => /(frameDt|delta|dt\s*:=|dt =|时间差|帧间隔)/i.test(l))
  if (dtLine) {
    add('fixed-timestep', '帧率无关的推进（先算这一帧过了多久）', 'high',
      [dtLine.trim().slice(0, 90), ...pseudo.filter(l => /计时器|timer/i.test(l)).slice(0, 1).map(l => l.trim())],
      '每帧开头用「计时器」算出这一帧实际过了多少秒（dt），之后所有运动都写成"速度 × dt"，而不是"每帧固定加一个数"。掉帧时速度不会跟着变慢。**关键细节：dt 必须夹上限**（这个作品夹到约 0.075 秒）——否则切走标签页再回来，计时器差值会是一个巨大数，物体直接飞出去。')
  }

  const graphLists = a.lists.filter(l => /adj|邻接|edge|权重|graph/i.test(l.name))
  const searchProcs = a.procs.filter(p => /bfs|dfs|dijkstra|寻路|最短路|路径|a\*|a星/i.test(p.proccode))
  if (graphLists.length || searchProcs.length) {
    add('graph-search', '图算法（邻接表 + 队列搜索）', 'high',
      [...graphLists.slice(0, 3).map(l => `${l.name}（${l.len} 项，${l.kind}）`), ...searchProcs.slice(0, 3).map(p => p.proccode)],
      '图存成邻接表（一行一个节点、每行装它的邻居），再用队列跑 BFS。Scratch 里没有指针，队列就是一张列表 + 一个头指针变量：出队只把指针 +1，**绝不删第 1 项**（删头是 O(n)，几千项时每次删除都在挪整个表）。')
  }

  const freeLists = a.lists.filter(l => /空闲|free|pool|可复用|可用索引/i.test(l.name))
  if (freeLists.length) {
    add('free-list', '空闲索引（对象池的取用队列）', 'high',
      freeLists.map(l => `${l.name}（${l.len} 项，${l.kind}）`),
      '克隆体不真删，而是"归还编号"：一张列表存所有空闲实例号，要用时从表尾弹一个、用完塞回去。建克隆的开销只在开场发生一次，之后全是设变量。坑：表和实体必须同生共死，漏还一次就永久少一个实例，而且不会有任何报错。')
  }

  return out
}

// ─────────────────────────── 渲染 ───────────────────────────

const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—')
const kb = n => (n == null ? '—' : n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`)

export function renderMarkdown (a) {
  const L = []
  const ar = a.architecture || {}
  const t = a.totals
  const name = a.projectName || (a.file ? basename(a.file, extname(a.file)) : '(未命名)')
  const driver = ar.driver || null

  L.push(`# 《${name}》：它是怎么搭的`, '')
  L.push(`> ${a.file ? '`' + basename(a.file) + '`' : ''} · ${t.sprites} 个角色 / ${t.blocks} 块 / 主循环 ${t.perFrame} 块每帧 · **静态结构分析**（读 project.json，不运行）`)
  L.push('')

  // ───────── 骨架 ─────────
  L.push('## 骨架')
  const modNames = (ar.modules || []).map(m => m.prefix).filter(p => p !== '(独立)')
  const style = (ar.kinds?.broadcast || 0) >= 10 && t.broadcasts >= 10
    ? '广播驱动（大量子系统被广播唤醒）'
    : (t.perFrame > 300 ? '每帧轮询为主（一堆 forever 自己跑）' : '事件驱动（帽子脚本为主）')
  L.push(`${style}。` +
    (modNames.length > 1 ? `角色按 ${modNames.map(p => '`' + p + '`').join(' / ')} 分成 ${modNames.length} 个模块；` : '') +
    (driver ? `主驱动在 \`${driver.target}\`，每帧 ${driver.perFrame} 块，占全项目 ${pct(driver.perFrame, t.perFrame)}。` : '没有任何每帧循环。'))
  L.push('')

  if ((ar.modules || []).length) {
    L.push('| 模块 | 角色 | 干什么 | 每帧块 |')
    L.push('|---|---|---|---|')
    for (const m of ar.modules) {
      const list = m.targets.length > 3 ? `${m.targets.slice(0, 3).join('、')} 等 ${m.targets.length} 个` : m.targets.join('、')
      L.push(`| \`${m.prefix}\` | ${list} | ${m.role || '—'} | ${m.perFrame} |`)
    }
    L.push('')
  }

  // ───────── 怎么跑起来的 ─────────
  L.push('## 它怎么跑起来的')
  const k = ar.kinds || {}
  L.push(`- **事件构成**：绿旗 ${k.flag || 0} 条、广播接收 ${k.broadcast || 0} 条、按键 ${k.key || 0} 条、点击 ${k.click || 0} 条、克隆体启动 ${k.clone || 0} 条、自定义块 ${k.procDef || 0} 个`)
  if (t.broadcasts) {
    L.push(`- **广播**：${t.broadcasts} 个名字、${a.broadcasts.totalSends} 处发送` +
      (a.broadcasts.dynamicSends ? `，其中 ${a.broadcasts.dynamicSends} 处是动态广播（名字来自变量）` : '') +
      (a.broadcasts.orphans.length ? `；${a.broadcasts.orphans.length} 个发出去没人接` : ''))
  }
  const fam = a.broadcasts.families || []
  if (fam.length) {
    L.push(`- **广播名成体系**：${fam.map(f => `\`${f.prefix}\` ${f.n} 个`).join('、')} —— 前缀多半是事件分类（raise=一次性事件 / sync=状态同步 / on=监听），新功能就挂在这些前缀下，不用改老代码`)
  }
  L.push('')

  if (driver && driver.frameOrder && driver.frameOrder.length) {
    const steps = driver.frameOrder
    const KIND = { if: '条件分派', call: '函数调用', broadcast: '广播', set: '设值', wait: '等待/循环', other: '其它操作' }
    const head = steps.slice(0, 4).map(s => s.label)
    const rest = steps.slice(4)
    const agg = new Map()
    for (const s of rest) agg.set(s.kind, (agg.get(s.kind) || 0) + 1)
    const subjects = [...new Set(rest.filter(s => s.kind === 'if' && s.subject).map(s => s.subject))].slice(0, 3)
    L.push(`**\`${driver.target}\` 每帧的节拍**：循环体 ${steps.length} 块/帧。`)
    L.push(`- 开头：${head.join(' → ')}`)
    if (agg.size) {
      L.push(`- 之后：${[...agg].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} 个${KIND[k] || k}`).join('、')}` +
        (subjects.length ? ` —— 条件分派主要在比 ${subjects.join('、')}` : ''))
    }
    if (driver.pseudo && driver.pseudo.length) {
      L.push('')
      L.push(`**还原成写法**（\`${driver.target}\` 的循环体，按块序；只翻译这一小段）：`, '')
      L.push('```')
      for (const line of driver.pseudo.slice(0, 22)) L.push(line)
      L.push('```')
    }
    L.push('')
  }

  const pipes = a.broadcasts.graph.filter(g => g.waits > 0).slice(0, 4)
  if (pipes.length) {
    L.push('**顺序管线（广播并等待＝同步点）**：' + pipes.map(g => `\`${g.name}\``).join(' → '), '')
  }
  const topEdges = a.broadcasts.graph.filter(g => g.receivers.length).slice(0, 8)
  if (topEdges.length) {
    L.push('| 广播 | 发 | 接 |')
    L.push('|---|---|---|')
    for (const e of topEdges) L.push(`| \`${e.name}\` | ${e.senders.join('、') || '—'} | ${e.receivers.slice(0, 4).join('、')}${e.receivers.length > 4 ? ` 等 ${e.receivers.length} 个` : ''} |`)
    L.push('')
  }

  // ───────── 数据怎么放 ─────────
  L.push('## 数据怎么放')
  if ((ar.soa || []).length) {
    for (const g of ar.soa.slice(0, 3)) {
      const cols = g.lists.slice(0, 8).map(l => `${l.name}(${l.len})`).join('、')
      const note = `（每行一条记录，共 ${g.len} 行${g.outliers ? `；另有 ${g.outliers} 列长度不同` : ''}）`
      L.push(`- **平行列表（一行一个实体）** \`${g.ns}\`：${cols}${g.lists.length > 8 ? ` 等 ${g.lists.length} 列` : ''}${note}`)
    }
    if (ar.soa.length > 3) L.push(`- 另有 ${ar.soa.length - 3} 组同类结构，略。`)
  }
  if ((ar.namespaces || []).length) {
    L.push('- **命名空间**：' + ar.namespaces.slice(0, 6).map(n => `\`${n.ns}\` ${n.vars} 变量 / ${n.lists} 列表`).join('、'))
  }
  if ((ar.entityTargets || []).length) {
    const ents = [...ar.entityTargets].sort((a, b) => b.clones - a.clones).slice(0, 4)
    L.push('- **克隆体当实体**：' + ents.map(e => `\`${e.name}\`（${e.clones} 条克隆脚本${e.fields.length ? '，字段 ' + e.fields.slice(0, 4).join('/') : ''}）`).join('、'))
  }
  if (a.lists.length) {
    const big = a.lists.filter(l => l.len > 0).slice(0, 6)
    if (big.length) L.push('- **有内容的表**：' + big.map(l => `${l.name}（${l.len} 项，${l.kind}）`).join('、'))
  }
  if (!(ar.soa || []).length && !(ar.namespaces || []).length && !a.lists.length) L.push('没看到成体系的数据层——状态基本散在变量里。')
  L.push('')

  // ───────── 关键机制 ─────────
  L.push('## 关键机制')
  L.push('每个机制都是"他遇到什么问题、用什么办法解的"，可以直接搬。')
  L.push('')
  if (!a.mechanics.length) {
    L.push('没识别出成型的机制——很可能这个作品只是量大，写法仍是最基础的那套。')
    L.push('')
  }
  for (const m of a.mechanics) {
    L.push(`### ${m.name} · 置信 ${m.conf}`)
    L.push(`- 证据：${m.evidence.filter(Boolean).join('；')}`)
    L.push(`- 怎么做：${m.how}`)
    L.push('')
  }

  // ───────── 可以搬的套路 ─────────
  L.push('## 可以搬的套路')
  const teach = a.mechanics.filter(m => m.conf === 'high').slice(0, 5)
  if (!teach.length) L.push('没有置信度足够高的机制可以推荐。别照抄这个作品的结构。')
  teach.forEach((m, i) => {
    L.push(`${i + 1}. **${m.name}** —— ${m.how}`)
  })
  L.push('')

  // ───────── 它的问题 ─────────
  L.push('## 它的问题')
  if (!a.risks.length) L.push('结构上没看到明显的地雷。')
  for (const r of a.risks) {
    const tag = { high: '**高**', mid: '中', low: '低', info: '提示' }[r.level] || r.level
    L.push(`- [${tag}] ${r.text}`)
  }
  L.push('')

  // ───────── 体量（放最后，只当参照） ─────────
  L.push('## 体量')
  L.push(`| 项 | 数 | 项 | 数 |`)
  L.push('|---|---|---|---|')
  const rows = [
    ['对象（含舞台）', t.targets], ['脚本', t.scripts],
    ['积木（真块）', t.blocks], ['每帧块数', t.perFrame],
    ['自定义块', t.procs], ['其中 warp', t.warpProcs],
    ['建/删克隆', `${t.clonesCreated}/${t.clonesDeleted}`], ['列表', t.lists],
    ['变量', t.variables], ['扩展', (a.extensions || []).join('、') || '无']
  ]
  for (let i = 0; i < rows.length; i += 2) {
    L.push(`| ${rows[i][0]} | ${rows[i][1]} | ${rows[i + 1] ? rows[i + 1][0] : ''} | ${rows[i + 1] ? rows[i + 1][1] : ''} |`)
  }
  L.push('')

  // ───────── 给 AI 的用法 ─────────
  L.push('## 给 AI 的用法')
  L.push('照着**结构**做事，不抄积木：')
  if (driver) L.push(`- 要做同类东西，先把主循环定在一个角色里（这里在 \`${driver.target}\`），别让每帧逻辑散在好几个角色各跑各的。`)
  if ((ar.modules || []).length > 1) L.push('- 角色多了就按前缀分模块，变量也带命名空间前缀——这是唯一能让人和 AI 都还看得懂的办法。')
  if ((ar.soa || []).length) L.push('- 多字段的实体用平行列表（一行一个实体），别用一行塞一串分隔符。')
  L.push('- 上面《它的问题》里的每一条，在做同类作品时先避开。')
  L.push('')
  return L.join('\n')
}

// ─────────────────────────── CLI ───────────────────────────

// 判"是不是被当脚本直接跑的"：Windows 下 import.meta.url 是百分号编码的，
// 拿 pathname 跟 argv 比永远不相等（第一版就是这样，CLI 静默什么都不做）。
const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  } catch { return false }
})()
if (isMain) {
  const args = process.argv.slice(2)
  const file = args.find(a => !a.startsWith('--'))
  if (!file) {
    console.error('用法: node dissect.mjs <作品.sb3|project.json> [--out 目录] [--json] [--stdout]')
    process.exit(1)
  }
  const outDir = (() => {
    const i = args.findIndex(a => a.startsWith('--out'))
    if (i < 0) return resolve('analysis')
    const inline = args[i].includes('=') ? args[i].split('=')[1] : null
    return resolve(inline || args[i + 1] || 'analysis')
  })()
  const { project, assets, source } = await readProject(resolve(file))
  const a = dissect(project, { file: resolve(file), bytes: null, assets: assets.length, source })
  const md = renderMarkdown(a)
  if (args.includes('--stdout')) console.log(md)
  const base = basename(file, extname(file)).replace(/[\\/:*?"<>|]/g, '_')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, `${base}.md`), md, 'utf8')
  if (args.includes('--json')) writeFileSync(join(outDir, `${base}.analysis.json`), JSON.stringify(a, null, 2), 'utf8')
  if (!args.includes('--stdout')) {
    console.log(`已写出 ${join(outDir, `${base}.md`)}`)
    console.log(`一句话：${a.totals.sprites} 角色 / ${a.totals.scripts} 脚本 / ${a.totals.blocks} 块 / 每帧 ${a.totals.perFrame} 块 / 机制 ${a.mechanics.length} 个 / 风险 ${a.risks.length} 条`)
  }
}
