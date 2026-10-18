// sb3-read.mjs — 读 sb3 / project.json 的公共小工具
//
// 为什么单独抽出来：inspect-sb3.mjs（看事实）和 dissect.mjs（出经验）必须看到
// **同一份事实**。两边各写一套读法，早晚会出现"同一个作品两个工具报不同块数"，
// 然后 AI 拿错数字编结论。所以读盘和遍历只在这里实现一次。
//
// 这里刻意不做任何"解读"——只把 sb3 的结构摊平成可以直接数、直接走的形式。

import { readFileSync } from 'node:fs'
import JSZip from 'jszip'

/** 读 .sb3（zip）或裸 project.json。返回 { project, assets, source } */
export async function readProject (p) {
  const buf = readFileSync(p)
  if (buf[0] === 0x7b) { // '{' —— 裸 project.json
    return { project: JSON.parse(buf.toString('utf8')), assets: [], source: 'json' }
  }
  const zip = await JSZip.loadAsync(buf)
  const pj = zip.file('project.json')
  if (!pj) throw new Error('这个 zip 里没有 project.json，不是 sb3')
  const project = JSON.parse(await pj.async('string'))
  const assets = Object.keys(zip.files)
    .filter(n => n !== 'project.json' && !zip.files[n].dir)
    .map(n => ({ name: n, bytes: zip.files[n]._data ? zip.files[n]._data.uncompressedSize : 0 }))
  return { project, assets, source: 'sb3' }
}

/** 一个 target 的块表（只留真有 opcode 的条目；sb3 里偶尔有条目没 opcode，别让分析器自己崩） */
export function blockMap (target) {
  const m = new Map()
  for (const [id, b] of Object.entries(target.blocks || {})) {
    if (b && b.opcode) m.set(id, b)
  }
  return m
}

/** 真块 = 不是影子块的块。报"块数"时必须说清是哪种数法。 */
export function isReal (b) { return !!(b && b.opcode && !b.shadow) }

/**
 * 输入槽里指到的**块 id**（不是字面量）。
 * sb3 的输入有四种形态： [1,[4,"10"]] 字面量 / [2,"id"] 块 / [3,"id",[4,"1"]] 块+影子 / [1,id] 旧式
 * 只靠"是字符串"判不出来 —— [1,[4,"10"]] 的 v[1] 也是字符串。唯一可靠的判据是
 * **这个 id 在块表里存在**。所以必须传 map。
 */
export function inputRef (inp, map) {
  if (!Array.isArray(inp)) return null
  const v = inp[1]
  if (typeof v === 'string' && map.has(v)) return v
  return null
}

/** 输入槽里的字面量值（下拉/文本/数字/广播名）；指到块上时返回 undefined */
export function inputValue (inp) {
  if (!Array.isArray(inp)) return undefined
  const v = inp[1]
  if (Array.isArray(v)) return v[1]
  if (Array.isArray(inp[2])) return inp[2][1]
  return undefined
}

// sb3 的内联原始值编号：4-10 是常量（数字/角度/颜色/文本…），11-13 是**报告器**
// （11 广播名、12 变量、13 列表）。project.json 里这三类会被压成 `[12,"名字","id"]`
// 这样的三元组直接放进输入槽，不产生独立的块条目 —— 所以"在块表里查不到 id"并不等于
// "这里是个常量"。早年就栽在这上面：把 `变量 = 10` 全数成了"两边都写死的比较"。
const PRIM_LITERAL = new Set([4, 5, 6, 7, 8, 9, 10])
const PRIM_REPORTER = new Set([11, 12, 13])

/**
 * 输入槽里到底是什么：'block'（指到块表里的块）/ 'reporter'（内联变量、列表、广播名）/
 * 'literal'（内联常量）/ 'none'（空槽）。
 */
export function inputKind (inp, map) {
  if (!Array.isArray(inp)) return 'none'
  const v = inp[1]
  if (typeof v === 'string') return map && map.has(v) ? 'block' : 'literal'
  if (Array.isArray(v)) {
    if (PRIM_REPORTER.has(v[0])) return 'reporter'
    if (PRIM_LITERAL.has(v[0])) return 'literal'
    return 'literal'
  }
  return 'none'
}

/** 这个输入槽是不是"写死的常量"（不含变量/列表/广播名这类报告器） */
export function isConstant (inp, map) {
  const k = inputKind(inp, map)
  return k === 'literal' || k === 'none'
}

/** 字段值（下拉菜单真的落成的值，如 BROADCAST_OPTION / CLONE_OPTION / KEY_OPTION） */
export function fieldValue (block, name) {
  const f = block && block.fields && block.fields[name]
  return Array.isArray(f) ? f[0] : undefined
}

/**
 * 从 rootId 往下走：next 链保持同一层，输入槽里的块 +1 层。
 * 返回 [{ id, block, depth }]。带 visited 防御（坏 sb3 里可能有环）。
 */
export function walkFrom (map, rootId) {
  const out = []
  const seen = new Set()
  const stack = [[rootId, 0]]
  while (stack.length) {
    const [id, depth] = stack.pop()
    if (!id || seen.has(id)) continue
    seen.add(id)
    const b = map.get(id)
    if (!b) continue
    out.push({ id, block: b, depth })
    if (b.next) stack.push([b.next, depth])
    for (const inp of Object.values(b.inputs || {})) {
      const ref = inputRef(inp, map)
      if (ref) stack.push([ref, depth + 1])
    }
  }
  return out
}

/** 从某个块往上走到顶，返回祖先 opcode 列表（近 → 远）。sb3 自带 parent，但坏文件可能缺。 */
export function ancestorOpcodes (map, blockId) {
  const out = []
  const seen = new Set()
  let cur = map.get(blockId)
  while (cur && cur.parent && !seen.has(cur.parent)) {
    seen.add(cur.parent)
    cur = map.get(cur.parent)
    if (!cur) break
    out.push(cur.opcode)
  }
  return out
}

/** 顶层块（脚本起点 + 游离块）。脚本 = 有帽子块；游离块 = 作者调试拖出来的孤儿。 */
export function topLevelBlocks (map) {
  return [...map.entries()].filter(([, b]) => isReal(b) && b.topLevel).map(([id, b]) => ({ id, block: b }))
}

/** 是不是帽子块（脚本起点） */
export function isHat (opcode) {
  return /^(event_when|control_start_as_clone|procedures_definition)/.test(opcode || '')
}

/** 列表长度表：name -> { len, values }（sb3 的 lists 是 [name, values[]]） */
export function listsOf (target) {
  const out = []
  for (const [id, v] of Object.entries(target.lists || {})) {
    const values = Array.isArray(v[1]) ? v[1] : []
    out.push({ id, name: String(v[0]), values, len: values.length })
  }
  return out
}

export function variablesOf (target) {
  return Object.entries(target.variables || {}).map(([id, v]) => ({ id, name: String(v[0]), value: v[1] }))
}

/** 把列表内容判个"用途类型"——这是客观可测的，不靠名字猜。 */
export function classifyList (values) {
  if (!values.length) return '空'
  const strs = values.map(v => String(v))
  const allNum = strs.every(s => s !== '' && Number.isFinite(Number(s)))
  if (allNum) return '数字表'
  if (strs.every(s => [...s].length === 1)) return '单字符表（字模/地图行）'
  const avg = strs.reduce((n, s) => n + s.length, 0) / strs.length
  if (avg > 40) return '长文本块'
  if (strs.some(s => s.includes('|') || s.includes('，') || s.includes(','))) return '分隔串表'
  return '混合短串'
}
