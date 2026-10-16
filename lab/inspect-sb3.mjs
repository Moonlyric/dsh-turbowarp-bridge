// inspect-sb3.mjs — 离线看一个 .sb3 / project.json 到底是什么东西
//
// 为什么需要它：给 AI 看的「作品样本谱」曾经是**凭印象写的**，把作品类型都写错了。
// 分析别人（或自己的）作品前，先用这个把事实摆出来：角色、块数、变量、广播、
// 扩展、opcode 分布、自定义块、克隆/pen 用量。有数才说话。
//
// 用法：
//   node inspect-sb3.mjs <文件.sb3|project.json> [--top 30] [--json]

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import JSZip from 'jszip'

const file = process.argv[2]
if (!file) { console.error('用法: node inspect-sb3.mjs <文件.sb3|project.json>'); process.exit(1) }
const topN = Number((process.argv.find(a => a.startsWith('--top')) || '--top=25').split('=')[1]) || 25
const asJson = process.argv.includes('--json')

/** 读 .sb3（zip）或裸 project.json */
async function readProject (p) {
  const buf = readFileSync(p)
  if (buf[0] === 0x7b) return { project: JSON.parse(buf.toString('utf8')), assets: [] }
  const zip = await JSZip.loadAsync(buf)
  const pjEntry = zip.file('project.json')
  if (!pjEntry) throw new Error('这个 zip 里没有 project.json，不是 sb3')
  const project = JSON.parse(await pjEntry.async('string'))
  const assets = Object.keys(zip.files).filter(n => n !== 'project.json' && !zip.files[n].dir)
  return { project, assets }
}

const { project, assets } = await readProject(file)
const targets = project.targets || []
const byId = new Map(targets.map(t => [t.id, t]))

// 变量表：id -> 名字（变量/列表/广播混在一起，按 target 归属）
const varName = new Map()
for (const t of targets) {
  for (const [id, v] of Object.entries(t.variables || {})) varName.set(id, `${v[0]}`)
  for (const [id, v] of Object.entries(t.lists || {})) varName.set(id, `${v[0]}(列表)`)
  for (const [id, v] of Object.entries(t.broadcasts || {})) varName.set(id, `${v[0]}(广播)`)
}

const stats = targets.map(t => {
  const blocks = Object.values(t.blocks || {})
  const real = blocks.filter(b => !b.shadow && b.opcode)
  return {
    name: t.name,
    isStage: !!t.isStage,
    blocks: real.length,
    // 含影子块的总数：报「块数」不写清哪种数法最容易出岔子（上一版 skill 的数字就是这么对不上的）
    allBlocks: blocks.length,
    topLevel: real.filter(b => b.topLevel).length,
    costumes: (t.costumes || []).length,
    sounds: (t.sounds || []).length,
    variables: Object.keys(t.variables || {}).length,
    lists: Object.keys(t.lists || {}).length,
    broadcasts: Object.keys(t.broadcasts || {}).length,
    comments: Object.keys(t.comments || {}).length
  }
}).sort((a, b) => b.blocks - a.blocks)

// opcode 直方图（注意：sb3 的 blocks 里偶尔有条目没有 opcode，别让分析器自己崩）
const opHist = new Map()
for (const t of targets) {
  for (const b of Object.values(t.blocks || {})) {
    if (b.shadow || !b.opcode) continue
    opHist.set(b.opcode, (opHist.get(b.opcode) || 0) + 1)
  }
}
const opSorted = [...opHist.entries()].sort((a, b) => b[1] - a[1])

// 自定义块（procedures_definition 的 proccode）
const procs = []
for (const t of targets) {
  const b = t.blocks || {}
  for (const block of Object.values(b)) {
    if (block.opcode === 'procedures_prototype') {
      const pc = (block.mutation && block.mutation.proccode) || ''
      procs.push({ target: t.name, proccode: pc, args: (block.mutation && block.mutation.argumentnames) || [] })
    }
  }
}

// 广播的实际用法（谁广播了什么）
const broadcastSends = new Map()
for (const t of targets) {
  for (const b of Object.values(t.blocks || {})) {
    if (b.opcode === 'event_broadcast' || b.opcode === 'event_broadcastandwait') {
      const inp = b.inputs && b.inputs.BROADCAST_INPUT
      let name = null
      if (Array.isArray(inp) && Array.isArray(inp[1]) && inp[1].length >= 2) name = inp[1][1]
      if (name) broadcastSends.set(name, (broadcastSends.get(name) || 0) + 1)
    }
  }
}

const totalReal = stats.reduce((n, s) => n + s.blocks, 0)
const summary = {
  文件: basename(file),
  项目名: (project.meta && project.meta.agent) || null,
  sb3版本: project.meta && project.meta.semver,
  角色数: targets.length,
  资源文件数: assets.length,
  总块数_真块: totalReal,
  总块数_含影子: targets.reduce((n, t) => n + Object.keys(t.blocks || {}).length, 0),
  扩展: project.extensions || [],
  克隆相关块: (opHist.get('control_create_clone_of') || 0) + (opHist.get('control_start_as_clone') || 0),
  pen块数: [...opHist].filter(([k]) => k.startsWith('pen_')).reduce((n, [, v]) => n + v, 0),
  自定义块数: procs.length,
  广播数: new Set([...broadcastSends.keys()]).size,
  总变量数: stats.reduce((n, s) => n + s.variables, 0),
  总列表数: stats.reduce((n, s) => n + s.lists, 0)
}

if (asJson) {
  console.log(JSON.stringify({ summary, targets: stats, opcodes: opSorted, procs, broadcasts: [...broadcastSends] }, null, 2))
  process.exit(0)
}

console.log('════════ 概况 ════════')
for (const [k, v] of Object.entries(summary)) {
  console.log(`  ${k.padEnd(12, '　')} ${Array.isArray(v) ? (v.length ? v.join(', ') : '（无）') : v}`)
}

console.log('\n════════ 角色（按块数） ════════')
console.log('  ' + '角色名'.padEnd(20) + '真块'.padStart(7) + '含影子'.padStart(8) + '顶层'.padStart(7) + '造型'.padStart(7) + '变量'.padStart(7) + '列表'.padStart(7) + '广播'.padStart(7) + '注释'.padStart(7))
for (const s of stats) {
  console.log('  ' + String(s.name).padEnd(20) + String(s.blocks).padStart(7) + String(s.allBlocks).padStart(8) + String(s.topLevel).padStart(7) +
    String(s.costumes).padStart(7) + String(s.variables).padStart(7) + String(s.lists).padStart(7) +
    String(s.broadcasts).padStart(7) + String(s.comments).padStart(7))
}

console.log(`\n════════ opcode 用量 Top ${topN} ════════`)
for (const [op, n] of opSorted.slice(0, topN)) console.log(`  ${String(n).padStart(6)}  ${op}`)

if (procs.length) {
  console.log(`\n════════ 自定义块（${procs.length}） ════════`)
  for (const p of procs.slice(0, 40)) console.log(`  [${p.target}] ${p.proccode}`)
  if (procs.length > 40) console.log(`  …还有 ${procs.length - 40} 个`)
}

console.log('\n════════ 广播（谁发了什么） ════════')
const bs = [...broadcastSends.entries()].sort((a, b) => b[1] - a[1])
for (const [name, n] of bs.slice(0, 30)) console.log(`  ${String(n).padStart(4)}×  ${name}`)
if (!bs.length) console.log('  （没有任何广播发送块）')
