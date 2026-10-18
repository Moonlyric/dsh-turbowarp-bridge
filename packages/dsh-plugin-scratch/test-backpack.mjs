// test-backpack.mjs — 背包（AI 自己维护的可复用积木库）的插件侧集成测试
//
// 为什么要单独一套：背包的价值全在「存下来的东西能原样取出来用」，而这条链路跨了三层
//   执行器 export_blocks（子树 → sb3 dict + 变量值）→ 插件落盘（$DSH_HOME/scratch-backpack）
//   → 注入时 add_blocks（变量引用按名字接上/补建）
// 只测插件侧（不起浏览器）：用一个**假页面**连上桥、按需回包，于是真会话、真 op 往返、
// 真文件落盘都被覆盖到了。变量落地那半在 lab/test-content-ops.js 的 [test v0.8.0] 里。
//
// 用法：node test-backpack.mjs
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'

const HOME = mkdtempSync(join(tmpdir(), 'dsh-backpack-'))
process.env.DSH_HOME = HOME

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer()
  s.once('error', rej)
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) })
})
const PORT = await freePort()
let pass = 0, fail = 0
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' | ' + detail : '')) }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ---- 假页面要回的答案（按 op 分发，可随时改） ----
// export_blocks 的返回形状就是执行器真实的返回形状（tests/content-ops 里验过它）
const SAMPLE_BLOCKS = {
  sbx_h1: { opcode: 'event_whenflagclicked', next: 'sbx_s1', parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 120, y: 260 },
  sbx_s1: { opcode: 'data_setvariableto', next: null, parent: 'sbx_h1', inputs: { VALUE: [1, [10, '42']] }, fields: { VARIABLE: ['分数', 'old-score-id'] }, shadow: false, topLevel: false },
  sbx_h2: { opcode: 'data_deletealloflist', next: null, parent: null, inputs: {}, fields: { LIST: ['字模', 'old-list-id'] }, shadow: false, topLevel: true, x: 120, y: 480 }
}
const exportResult = {
  target: 'Sprite1',
  project: '测试作品',
  roots: ['sbx_h1', 'sbx_h2'],
  blocks: SAMPLE_BLOCKS,
  blockCount: 3,
  scripts: 2,
  topLevelOpcodes: ['event_whenflagclicked', 'data_deletealloflist'],
  requires: {
    // scope 是执行器 collectRefs 的产物（舞台上的 = global）。字模表跟着原角色是 global，
    // 分数是角色局部 —— 背包要能原样搬回去，所以这两个字段都得存、都得透传。
    variables: [{ name: '分数', value: 42, scope: 'local' }],
    lists: [{ name: '字模', value: ['甲', '乙', '丙'], scope: 'global' }],
    broadcasts: [{ name: '开始' }]
  }
}
const opsSeen = []
let addBlocksArgs = null
let snapshotCount = 0
const pageAnswers = {
  export_blocks: () => exportResult,
  add_blocks: (args) => {
    addBlocksArgs = args
    const ids = Object.keys(args.blocks || {})
    const idMap = {}
    ids.forEach((id, i) => { idMap[id] = 'new-' + i })
    return { added: ids.length, inputBlocks: ids.length, expandedBlocks: ids.length, idMap, idMapReliable: true }
  },
  snapshot: () => ({ targets: [{ isStage: true, name: 'Stage', blocks: {}, variables: {}, lists: {}, broadcasts: {} }], monitors: [], extensions: [] })
}

const registered = new Map()
const fakeCtx = {
  logger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  effect: (fn) => { const d = fn(); if (typeof d === 'function') process.on('exit', () => { try { d() } catch {} }) },
  tools: { register: (tool) => registered.set(tool.name, tool) }
}
const mod = await import('./index.js')
const cfg = { safety: 'auto', bridgePort: PORT, maxSnapshots: 2, skillsEnabled: false }
mod.apply(fakeCtx, cfg)
t('插件 apply 未抛错', true)

const { default: WebSocket } = await import('ws')
const tokenFile = join(HOME, 'scratch-bridge-token.txt')
let TOKEN = ''
for (let i = 0; i < 60 && !(TOKEN = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : ''); i++) await sleep(50)

/** 连上桥并冒充一个已认证的编辑器；自动应答所有 op */
async function connectFakePage() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`)
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
  ws.send(JSON.stringify({ type: 'hello', token: TOKEN, meta: { turbowarp: true, title: '测试作品' } }))
  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(String(raw)) } catch { return }
    if (msg.type === 'ping') { ws.send('{"type":"pong"}'); return }
    if (!msg.op) return
    opsSeen.push({ op: msg.op, args: msg.args })
    if (msg.op === 'snapshot') snapshotCount++
    const fn = pageAnswers[msg.op]
    if (!fn) { ws.send(JSON.stringify({ id: msg.id, ok: false, error: '假页面没实现 ' + msg.op })); return }
    try { ws.send(JSON.stringify({ id: msg.id, ok: true, result: fn(msg.args) })) }
    catch (e) { ws.send(JSON.stringify({ id: msg.id, ok: false, error: String(e.message) })) }
  })
  await sleep(150)
  return ws
}

const ws = await connectFakePage()
const call = async (name, args) => {
  const tool = registered.get(name)
  if (!tool) throw new Error('没有工具 ' + name)
  const clean = {}
  for (const k of Object.keys(args || {})) if (args[k] !== undefined) clean[k] = args[k]
  return await tool.execute(clean)
}
const thrown = async (fn) => { try { await fn(); return null } catch (e) { return e.message } }
const bpDir = join(HOME, 'scratch-backpack')
const readSnippet = (name) => JSON.parse(readFileSync(join(bpDir, name + '.json'), 'utf8'))

// ==================== 1. 空背包 ====================
console.log('\n[1] 背包是空的')
let r = await call('scratch_backpack', { action: 'list' })
t('list 在空目录下不报错，如实报 count=0', r.count === 0 && Array.isArray(r.items), JSON.stringify(r).slice(0, 200))
t('给出目录位置（用户能找到那些文件）', typeof r.dir === 'string' && r.dir.includes('scratch-backpack'), String(r.dir))
t('空的时候提示"可以问用户要不要存"（不自动攒）', /问用户/.test(r.hint || ''), String(r.hint))

// ==================== 2. 存 ====================
console.log('\n[2] save：把脚本存进背包')
r = await call('scratch_backpack', {
  action: 'save', name: 'pen-text', target: 'Sprite1', scriptIds: ['sbx_h1', 'sbx_h2'],
  title: 'pen 文字引擎', description: '要在舞台上画字的时候用', tags: ['pen', 'text'],
  notes: '把 字模 列表换成要画的字，然后点绿旗'
})
t('save ok', !!r.saved, JSON.stringify(r).slice(0, 300))
t('存进去的是这个角色的脚本数/块数（来自 export_blocks 的真实回包）',
  r.blocks === 3 && r.scripts === 2, JSON.stringify({ blocks: r.blocks, scripts: r.scripts }))
t('文件落到 $DSH_HOME/scratch-backpack/<名字>.json', existsSync(join(bpDir, 'pen-text.json')), '')
t('requires 里如实列出会带上的变量/列表（列表还标了项数）',
  (r.requires.variables || []).includes('分数') &&
  (r.requires.lists || []).some(x => /^字模\(3\)$/.test(x)) &&
  (r.requires.broadcasts || []).includes('开始'),
  JSON.stringify(r.requires))
const snippet = readSnippet('pen-text')
t('快照文件里 blocks 原样保存（能直接喂 add_blocks）',
  Object.keys(snippet.blocks || {}).length === 3 && snippet.blocks.sbx_h1.opcode === 'event_whenflagclicked')
t('元数据齐（title/description/notes/tags/createdAt/source）',
  snippet.title === 'pen 文字引擎' && snippet.description === '要在舞台上画字的时候用' &&
  snippet.notes.includes('字模') && Array.isArray(snippet.tags) && !!snippet.createdAt &&
  snippet.source && snippet.source.target === 'Sprite1', JSON.stringify(snippet).slice(0, 300))
t('INDEX.md 自动生成（AI 能廉价扫目录）', existsSync(join(bpDir, 'INDEX.md')))
const indexText = readFileSync(join(bpDir, 'INDEX.md'), 'utf8')
t('INDEX.md 里有这行（名字 + 块数）', indexText.includes('pen-text') && indexText.includes('| 3 |'), indexText.slice(0, 300))
t('save 没有触发写操作快照（存背包不动项目，不该打扰用户）', snapshotCount === 0, 'snapshot=' + snapshotCount)

// ==================== 3. 重名 ====================
console.log('\n[3] 重名保护')
let err = await thrown(() => call('scratch_backpack', { action: 'save', name: 'pen-text', target: 'Sprite1', scriptIds: ['sbx_h1'] }))
t('同名已存在时报错并给两条出路（覆盖 / 改名）', !!err && /已经有/.test(err) && /overwrite/.test(err), String(err))
r = await call('scratch_backpack', { action: 'save', name: 'pen-text', target: 'Sprite1', scriptIds: ['sbx_h1'], overwrite: true })
t('overwrite:true 才覆盖，且如实说覆盖了', r.saved === 'pen-text' && r.overwritten === true, JSON.stringify(r).slice(0, 200))
t('覆盖保留 createdAt（不是把"存了多久"也重置了）', readSnippet('pen-text').createdAt === snippet.createdAt, '')
// 恢复成完整版本，后面的注入断言要用两条脚本
await call('scratch_backpack', { action: 'save', name: 'pen-text', target: 'Sprite1', scriptIds: ['sbx_h1', 'sbx_h2'], overwrite: true })

// ==================== 4. 列 / 读 / 删 ====================
console.log('\n[4] list / read / delete')
r = await call('scratch_backpack', { action: 'list' })
t('list 里有 1 条，且带标题/块数/标签（扫目录不用读全文）',
  r.count === 1 && r.items[0].name === 'pen-text' && r.items[0].blocks === 3 &&
  r.items[0].tags.join(',') === 'pen,text', JSON.stringify(r.items))
r = await call('scratch_backpack', { action: 'read', name: 'pen-text' })
t('read 回完整 blocks + requires（AI 可以改参数再 add_blocks）',
  r.blocks && r.blocks.sbx_s1 && r.requires && r.requires.lists[0].name === '字模', Object.keys(r).join(','))
err = await thrown(() => call('scratch_backpack', { action: 'read', name: 'no-such' }))
t('读不存在的条目时报错并列出都有什么', !!err && /没有「no-such」/.test(err) && /pen-text/.test(err), String(err))
err = await thrown(() => call('scratch_backpack', { action: 'frobnicate' }))
t('未知 action 明确报错', !!err && /未知 action/.test(err), String(err))

// ==================== 5. 取出来注入（auto 档：直接落盘） ====================
console.log('\n[5] load：注入 + 变量/列表补建声明')
addBlocksArgs = null
r = await call('scratch_backpack_load', { name: 'pen-text', target: 'Sprite2', x: 400, y: 600 })
t('load 真的调了 add_blocks', !!addBlocksArgs, JSON.stringify(r).slice(0, 200))
t('注入前先快照（写操作的基本安全网）', snapshotCount >= 1, 'snapshot=' + snapshotCount)
t('目标角色按参数透传', addBlocksArgs && addBlocksArgs.target === 'Sprite2', String(addBlocksArgs && addBlocksArgs.target))
t('变量/列表/广播都以 declared 形式送下去（目标里没有的会被补建）',
  Array.isArray(addBlocksArgs.variables) &&
  addBlocksArgs.variables.some(v => v.name === '字模' && v.type === 'list' && v.value.length === 3) &&
  addBlocksArgs.variables.some(v => v.name === '分数' && v.type === 'variable' && v.value === 42) &&
  addBlocksArgs.variables.some(v => v.name === '开始' && v.type === 'broadcast'),
  JSON.stringify(addBlocksArgs && addBlocksArgs.variables))
// scope 要透传：字库那种几 MB 的表必须挂舞台（否则注进第二个角色就是第二份副本）
t('背包里 scope:"global" 的列表原样送到 add_blocks（挂舞台，不各角色一份）',
  addBlocksArgs.variables.some(v => v.name === '字模' && v.scope === 'global') &&
  addBlocksArgs.variables.some(v => v.name === '分数' && v.scope !== 'global'),
  JSON.stringify(addBlocksArgs && addBlocksArgs.variables))
// 坐标：片段原来两顶层的 min 是 (120,260) → 整体平移 (+280, +340)
t('x/y 是整体平移（保留片段内部相对排布，不是全部堆到一处）',
  addBlocksArgs.blocks.sbx_h1.x === 400 && addBlocksArgs.blocks.sbx_h1.y === 600 &&
  addBlocksArgs.blocks.sbx_h2.x === 400 && addBlocksArgs.blocks.sbx_h2.y === 820,
  JSON.stringify({ h1: [addBlocksArgs.blocks.sbx_h1.x, addBlocksArgs.blocks.sbx_h1.y], h2: [addBlocksArgs.blocks.sbx_h2.x, addBlocksArgs.blocks.sbx_h2.y] }))
t('回传里说明注的是哪条、落在哪', r.snippet === 'pen-text' && r.at.x === 400 && r.at.y === 600, JSON.stringify(r).slice(0, 200))
t('回传带 changed（P3-2 统一字段）', r.changed && r.changed.added === 3, JSON.stringify(r.changed))

// variableValues：换字模表（用户/自定义内容的常见需求）
addBlocksArgs = null
r = await call('scratch_backpack_load', { name: 'pen-text', variableValues: { 字模: ['一', '二'] } })
t('variableValues 覆盖背包里存的内容（换字模表不用改 blocks）',
  addBlocksArgs.variables.some(v => v.name === '字模' && JSON.stringify(v.value) === JSON.stringify(['一', '二'])),
  JSON.stringify(addBlocksArgs && addBlocksArgs.variables))
t('没给 x/y 时用默认落点（48,48 起）',
  addBlocksArgs.blocks.sbx_h1.x === 48 && addBlocksArgs.blocks.sbx_h1.y === 48,
  JSON.stringify([addBlocksArgs.blocks.sbx_h1.x, addBlocksArgs.blocks.sbx_h1.y]))

// ==================== 6. preview 档：不落盘，等 apply ====================
console.log('\n[6] preview 档：先给计划，等确认')
const previewMod = await import('./index.js')
const previewReg = new Map()
previewMod.apply({
  logger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  effect: () => {},
  tools: { register: (tool) => previewReg.set(tool.name, tool) }
}, { safety: 'preview', bridgePort: PORT + 1, maxSnapshots: 1, skillsEnabled: false })
// preview 档的插件是另一个实例，它连的是另一个端口 → 这里只用它的工具跑「注入前的计划」
// 真要在 preview 档验证，得再连一个假页面到 PORT+1；那属于「安全档位」的通用行为，
// 已有 test-bridge-auth 覆盖。这里只确认背包注入也走 guardedWrite（不是自己写死落盘）。
const previewSrc = readFileSync(join(import.meta.dirname, 'index.js'), 'utf8')
t('backpack_load 走 guardedWrite（受 safety 档位管，不是绕过确认直写）',
  /guardedWrite\(sid, 'add_blocks', \{ target: args\?\.target, blocks, variables: declared \}/.test(previewSrc))
t('save 不做成写操作（存背包不动项目，preview 档不该被拦）',
  /scratch_backpack'[\s\S]{0,3000}?action === 'save'/.test(previewSrc))

// ==================== 7. 删除（进 _trash，不真删） ====================
console.log('\n[7] delete：挪进 _trash')
r = await call('scratch_backpack', { action: 'delete', name: 'pen-text' })
t('delete ok 且说清挪到哪了', !!r.deleted && /_trash/.test(r.movedTo || ''), JSON.stringify(r))
t('原文件没了', !existsSync(join(bpDir, 'pen-text.json')))
t('_trash 里留着（手滑能捞回来）',
  existsSync(join(bpDir, '_trash')) && readdirSync(join(bpDir, '_trash')).some(f => f.startsWith('pen-text-')),
  JSON.stringify(readdirSync(bpDir)))
r = await call('scratch_backpack', { action: 'list' })
t('删完 list 回到 0 条，INDEX.md 也跟着更新',
  r.count === 0 && !readFileSync(join(bpDir, 'INDEX.md'), 'utf8').includes('pen-text'), String(r.count))

// 名字安全：路径分隔符 / 上跳都不能穿出目录
r = await call('scratch_backpack', { action: 'save', name: '../../etc/passwd', target: 'Sprite1', scriptIds: ['sbx_h1'] })
t('名字里的路径分隔符被清洗掉（不许写到目录外面）',
  existsSync(join(bpDir, 'etc-passwd.json')) && r.file.includes('scratch-backpack'),
  String(r.file))

ws.close()
console.log(`\n===== 背包集成测试: ${pass} pass / ${fail} fail =====`)
try { rmSync(HOME, { recursive: true, force: true }) } catch {}
process.exit(fail ? 1 : 0)
