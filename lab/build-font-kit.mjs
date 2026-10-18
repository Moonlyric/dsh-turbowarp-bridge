// build-font-kit.mjs — 把「画笔文字引擎」从一份含字库的作品里提出来，做成可直接复用的东西
//
// 产出两份：
//   ① 背包条目  $DSH_HOME/scratch-backpack/文字引擎.json
//      —— 4 个自定义块（画文本 / 画字 / 找字 / 定位）+ 两张全局表（PTE-字体、PTE-字库索引）
//      之后用 scratch_backpack_load({ name: '文字引擎', target: '要画字的角色' }) 一句话注进项目。
//   ② 自测作品  lab/works/font-kit-test.sb3
//      —— 引擎 + 一段绿旗演示，拖进 TurboWarp 就能看效果（改引擎后必须重新跑一遍看它到底画没画出来）。
//
// 为什么变量全加 `PTE-` 前缀：引擎要往项目里注，而 `x` `y` `i` `j` 这种名字几乎必然跟宿主项目
// 撞上。撞上不会报错 —— 只是两边的值互相踩，画出来的东西莫名其妙。加前缀就永不撞车。
//
// 用法：
//   node build-font-kit.mjs <含字库的.sb3|project.json> [--out 目录] [--no-backpack]
//
// 数据格式（提取时按这个解，改动前先看这里）：
//   字体[i]  =  第 1 位是字符本身
//               第 2-3 位是宽度（两位 16 进制，单位 1/64 em）
//               第 4 位起是笔画：每 3 位 16 进制 = 一个点（12 bit：高 6 位 y、低 6 位 x，单位 1/64 em）
//               笔画之间用一个 'M' 隔开（抬笔换段）
//   字库索引  = 把「字体」的下标按字符排好序（忽略大小写，和 Scratch 的 < > 一致），供二分查找

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { readProject, blockMap, walkFrom, fieldValue } from './sb3-read.mjs'
import { buildBlankProject, zipStore } from '../packages/dsh-plugin-scratch/sb3.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

const argv = process.argv.slice(2)
const opt = (n, d) => {
  const i = argv.findIndex(a => a === `--${n}` || a.startsWith(`--${n}=`))
  if (i < 0) return d
  return argv[i].includes('=') ? argv[i].split('=').slice(1).join('=') : (argv[i + 1] ?? d)
}
const srcPath = argv.slice(1).find(a => !a.startsWith('--') && !/^\d+$/.test(a)) || argv[0]
if (!srcPath) {
  console.error('用法: node build-font-kit.mjs <含字库的.sb3|project.json> [--out 目录] [--no-backpack]')
  process.exit(1)
}

const PREFIX = 'PTE-'
// 引擎自带的过程。名字留着原样（足够独特），参数名也不动 —— 只给"变量/列表"加前缀
const PROCS = ['画文本 %s %s %s %s', '画字 %s %s %s %s', '找字 %s 大写: %s', '定位 %s %s %s']

const { project } = await readProject(srcPath)

// ---------- 1. 找到引擎所在角色，收集这 4 个过程的整棵子树 ----------
let host = null
let defs = null
for (const t of project.targets) {
  const m = blockMap(t)
  const found = new Map()
  for (const [id, b] of m) {
    if (b.opcode !== 'procedures_definition') continue
    const proto = m.get(b.inputs && b.inputs.custom_block && b.inputs.custom_block[1])
    const code = proto && proto.mutation && proto.mutation.proccode
    if (code && PROCS.includes(code)) found.set(code, { id, proto })
  }
  if (found.size === PROCS.length) { host = t; defs = found; break }
}
if (!host) {
  console.error(`这份作品里找不到完整的引擎（需要这 4 个自定义块：${PROCS.join(' / ')}）`)
  process.exit(1)
}

const hostMap = blockMap(host)
const blocks = {}
for (const code of PROCS) {
  const { id } = defs.get(code)
  for (const { id: bid, block } of walkFrom(hostMap, id)) {
    if (blocks[bid]) continue
    const copy = JSON.parse(JSON.stringify(block))
    // 影子块（math_number / colour 之类）也一起搬；它们没有 x/y，不影响
    blocks[bid] = copy
  }
}

// ---------- 2. 把变量/列表引用改成 PTE- 前缀 ----------
// 只动 data_* 的字段和内联原始值 [12,...]（变量）/ [13,...]（列表）。
// argument_reporter 是过程参数，跟宿主项目无关，**绝不能**碰。
const REPORT_NAMES = new Map() // 原 id → 新名字
const renames = new Map() // 原名字 → 新名字（仅变量/列表）
function renameOf (name) {
  if (!renames.has(name)) renames.set(name, PREFIX + name)
  return renames.get(name)
}
for (const b of Object.values(blocks)) {
  for (const [fname, v] of Object.entries(b.fields || {})) {
    if (!Array.isArray(v)) continue
    if (fname !== 'VARIABLE' && fname !== 'LIST') continue
    const old = v[0]
    v[0] = renameOf(old)
    if (v[1]) REPORT_NAMES.set(v[1], v[0])
  }
  for (const desc of Object.values(b.inputs || {})) {
    if (!Array.isArray(desc)) continue
    for (const v of desc) {
      if (!Array.isArray(v)) continue
      if (v[0] !== 12 && v[0] !== 13) continue
      const old = v[1]
      v[1] = renameOf(old)
      if (v[2]) REPORT_NAMES.set(v[2], v[1])
    }
  }
}

// ---------- 3. 取出两张字体表（必须在舞台上：全局，各角色共用一份） ----------
const stage = project.targets.find(t => t.isStage)
const listValue = (name) => {
  for (const t of [host, stage, ...project.targets]) {
    for (const v of Object.values(t.lists || {})) if (String(v[0]) === name) return Array.isArray(v[1]) ? v[1] : []
  }
  return null
}
const font = listValue('字体')
const index = listValue('字库索引')
if (!font || !font.length) {
  console.error('找不到「字体」列表（或它是空的）')
  process.exit(1)
}
if (!index || index.length !== font.length) {
  console.error(`「字库索引」缺失或长度不对（字体 ${font && font.length} / 索引 ${index && index.length}）`)
  process.exit(1)
}

// 自检：索引必须按"忽略大小写的首字符"升序 —— 二分查找全靠它。乱了就别发出去。
{
  const chars = index.map(i => String(font[Number(i) - 1]).slice(0, 1).toLowerCase())
  let bad = 0
  let firstBad = null
  for (let k = 1; k < chars.length; k++) {
    if (chars[k] < chars[k - 1]) { bad++; if (!firstBad) firstBad = { at: k, prev: chars[k - 1], cur: chars[k] } }
  }
  if (bad) {
    console.error(`「字库索引」有 ${bad} 处没排好（第一处 ${JSON.stringify(firstBad)}）—— 二分查找会查不到字。先修索引再生成。`)
    process.exit(1)
  }
  console.log(`索引自检通过：${index.length} 项，忽略大小写升序`)
}

const outDir = resolve(opt('out', join(HERE, 'works')))
mkdirSync(outDir, { recursive: true })

// ---------- 4. 变量/列表声明（背包按这个建，scope:global 表示挂舞台） ----------
const usedVars = new Set()
const usedLists = new Set()
for (const b of Object.values(blocks)) {
  for (const [fname, v] of Object.entries(b.fields || {})) {
    if (!Array.isArray(v)) continue
    if (fname === 'VARIABLE') usedVars.add(v[0])
    if (fname === 'LIST') usedLists.add(v[0])
  }
  for (const desc of Object.values(b.inputs || {})) {
    if (!Array.isArray(desc)) continue
    for (const v of desc) {
      if (!Array.isArray(v)) continue
      if (v[0] === 12) usedVars.add(v[1])
      if (v[0] === 13) usedLists.add(v[1])
    }
  }
}
const LIST_DATA = { [`${PREFIX}字体`]: font, [`${PREFIX}字库索引`]: index }
const requires = {
  variables: [...usedVars].sort().map(name => ({ name, scope: 'global', value: '' })),
  lists: [...usedLists].sort().map(name => ({
    name,
    scope: 'global',
    value: LIST_DATA[name] || [],
    ...(LIST_DATA[name] ? {} : { note: '缺数据：这个列表没从源作品里取到' })
  })),
  broadcasts: []
}
// 引擎会用到的标量初值（照原作品的初值，让第一次调用就成立）
const INIT = { [`${PREFIX}找字i`]: 0, [`${PREFIX}找字j`]: 1 }
for (const v of requires.variables) if (INIT[v.name] !== undefined) v.value = INIT[v.name]

// ---------- 5. 顶层块给个坐标（背包注入时会整体平移） ----------
{
  const tops = Object.values(blocks).filter(b => b.topLevel)
  tops.forEach((b, i) => { b.x = 48; b.y = 48 + i * 460 })
  for (const b of Object.values(blocks)) if (!b.topLevel) { delete b.x; delete b.y }
}

const scriptCount = Object.values(blocks).filter(b => b.topLevel).length

// ---------- 6. 写背包条目 ----------
const snippetName = '文字引擎'
const snippet = {
  name: snippetName,
  title: '画笔文字引擎：4 个自定义块，任意中文/英文/符号用笔画出来',
  description: '要画中文界面、数字面板、霓虹字、或者系统字体撑不住的地方就用它。纯画笔、不需要造型、不需要「说」气泡。'
    + `自带 ${font.length} 个字形（汉字/拉丁/标点/假名/韩文等），字号任意。`,
  notes: '用法：① scratch_backpack_load({ name:"文字引擎", target:"要画字的角色" }) '
    + '② 那个角色里：笔迹全部擦除 → 笔的颜色设为… → 调用 画文本(内容, x, y, 字号)。'
    + 'x/y 是文字的**左上角**，y 往下长。'
    + `全局表 ${PREFIX}字体 / ${PREFIX}字库索引 是字形数据（一张 5MB 级的大表），挂舞台共用一份，别删。`
    + '性能：每个点要 1 次「定位」调用，一行 20 个汉字大约 3000 块 —— 只在文字变化时重画，别每帧画。'
    + '画完的笔迹是画在画笔图层上的，只能用「笔迹全部擦除」清掉。'
    + '要支持的字不在表里：找字查不到就不会画，不会报错。',
  tags: ['笔画', '字体', 'UI', '文字', 'pen'],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  source: {
    session: '(offline)',
    project: srcPath.replace(/\\/g, '/'),
    target: host.name,
    scripts: PROCS.slice(),
    blockCount: Object.keys(blocks).length,
    topLevelOpcodes: ['procedures_definition']
  },
  stats: { blocks: Object.keys(blocks).length, scripts: scriptCount },
  requires,
  warnings: [],
  blocks
}

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const bpDir = join(dshHome, 'scratch-backpack')
if (argv.includes('--no-backpack')) {
  console.log('跳过写背包（--no-backpack）')
} else {
  mkdirSync(bpDir, { recursive: true })
  const file = join(bpDir, `${snippetName}.json`)
  const text = JSON.stringify(snippet)
  writeFileSync(file, text)
  console.log(`背包条目 → ${file}（${(text.length / 1048576).toFixed(2)} MB，${Object.keys(blocks).length} 块）`)
}

// ---------- 7. 生成自测作品 ----------
// 变量/列表用**块里引用的那些 id**建，这样注进去时 byId 直接命中，不依赖名字重映射。
const stageVars = {}
const stageLists = {}
const stageIds = new Map() // 原名字 → id（从块里推回来）
for (const b of Object.values(blocks)) {
  for (const [fname, v] of Object.entries(b.fields || {})) {
    if (!Array.isArray(v) || !v[1]) continue
    if (fname === 'VARIABLE') stageIds.set(v[0], v[1])
    if (fname === 'LIST') stageIds.set(v[0], v[1])
  }
  for (const desc of Object.values(b.inputs || {})) {
    if (!Array.isArray(desc)) continue
    for (const v of desc) {
      if (!Array.isArray(v) || !v[2]) continue
      if (v[0] === 12 || v[0] === 13) stageIds.set(v[1], v[2])
    }
  }
}
for (const v of requires.variables) {
  const id = stageIds.get(v.name) || `fk-var-${v.name}`
  stageVars[id] = [v.name, v.value]
}
for (const v of requires.lists) {
  const id = stageIds.get(v.name) || `fk-list-${v.name}`
  stageLists[id] = [v.name, v.value]
}
const varId = (name) => (requires.variables.find(x => x.name === name) && stageIds.get(name)) || null

// 演示脚本：当绿旗被点击 → 隐藏本体 → 擦笔 → 设色 → 画几行
const demo = {}
let seq = 0
const nid = () => `demo${++seq}`
const argIdsOf = (code) => JSON.parse(defs.get(code).proto.mutation.argumentids)
const callText = (text, x, y, size, color) => {
  const ids = argIdsOf('画文本 %s %s %s %s')
  const out = []
  if (color) {
    const c = { opcode: 'pen_setPenColorToColor', next: null, parent: null, inputs: { COLOR: [1, [9, color]] }, fields: {}, shadow: false, topLevel: false }
    out.push(c)
  }
  const call = {
    opcode: 'procedures_call',
    next: null,
    parent: null,
    inputs: {
      [ids[0]]: [1, [10, text]],
      [ids[1]]: [1, [4, String(x)]],
      [ids[2]]: [1, [4, String(y)]],
      [ids[3]]: [1, [4, String(size)]]
    },
    fields: {},
    shadow: false,
    topLevel: false,
    mutation: {
      tagName: 'mutation',
      children: [],
      proccode: '画文本 %s %s %s %s',
      argumentids: JSON.stringify(ids),
      warp: 'false'
    }
  }
  out.push(call)
  return out
}

const head = {
  hat: { opcode: 'event_whenflagclicked', next: null, parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 60, y: 60 },
  hide: { opcode: 'looks_hide', next: null, parent: null, inputs: {}, fields: {}, shadow: false, topLevel: false },
  clear: { opcode: 'pen_clear', next: null, parent: null, inputs: {}, fields: {}, shadow: false, topLevel: false }
}
demo.demoHat = head.hat
demo.demoHide = head.hide
demo.demoClear = head.clear
head.hat.next = 'demoHide'
head.hide.parent = 'demoHat'
head.hide.next = 'demoClear'
head.clear.parent = 'demoHide'

const LINES = [
  ['画笔文字引擎', -220, 150, 46, '#111111'],
  ['你好，世界 Hello World 123', -220, 96, 24, '#1b4b8f'],
  ['中文标点：《测试》「引号」…——！？', -220, 56, 24, '#1b4b8f'],
  ['the quick brown fox jumps over a lazy dog.', -220, 18, 18, '#444444'],
  ['0123456789 + - * / = % ( ) [ ] { }', -220, -10, 18, '#444444'],
  ['尺寸 60 的一行大字', -220, -60, 60, '#b4462a'],
  ['字号随便给：80px 也能画，笔画是描出来的', -220, -150, 16, '#666666']
]
let prev = 'demoClear'
for (const [text, x, y, size, color] of LINES) {
  const chain = callText(text, x, y, size, color)
  for (const b of chain) {
    const id = nid()
    demo[id] = b
    b.parent = prev
    demo[prev].next = id
    prev = id
  }
}

const blank = buildBlankProject({ spriteName: '文字', costumeName: '隐形', backdropName: '背景1' })
const pj = blank.projectJson
pj.targets[0].variables = stageVars
pj.targets[0].lists = stageLists
pj.targets[1].blocks = { ...blocks, ...demo }
pj.extensions = ['pen']
pj.meta.agent = 'font-kit-builder'
const parts = blank.parts.map(p => p.name === 'project.json'
  ? { name: 'project.json', data: Buffer.from(JSON.stringify(pj), 'utf8') }
  : p)

const outFile = join(outDir, 'font-kit-test.sb3')
writeFileSync(outFile, zipStore(parts))
console.log(`自测作品 → ${outFile}`)
console.log(`  引擎 ${Object.keys(blocks).length} 块 / ${scriptCount} 段脚本；字形 ${font.length} 个`)
