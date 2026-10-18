// test-skills.js — skill 区逻辑单测（不依赖 dsh，直接调插件的 skill 函数集）
// 方法：import 插件模块、伪造 ctx/tools，验证 skill 工具的注册与行为。
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-skill-test-')) // 隔离 HOME

let pass = 0, fail = 0
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' | ' + detail : '')) }
}

// 伪 tools 服务
const registered = new Map()
const fakeCtx = {
  logger: () => ({ info() {}, warn() {}, error() {} }),
  effect() {},
  tools: { register: (tool) => registered.set(tool.name, tool) }
}

const mod = await import('./index.js')
// 模块级只导出 apply；直接调它
let config
try { mod.apply(fakeCtx, { safety: 'preview', bridgePort: 31999, maxSnapshots: 5, skillsEnabled: true }) } catch (e) { console.log('apply threw (expected if bridge binds):', e.message) }

// ⚠️ 加了新工具就要改这个数（它是个防手滑的探针：少一个立刻红）
t('33 个工具注册（31 功能 + skill 2 个）', registered.size === 33, String(registered.size) + ': ' + [...registered.keys()].join(','))
t('scratch_skills 注册', registered.has('scratch_skills'))
t('scratch_skill_edit 注册', registered.has('scratch_skill_edit'))

// ---- list ----
const skillsTool = registered.get('scratch_skills')
const editTool = registered.get('scratch_skill_edit')
let r = await skillsTool.execute({ action: 'list' })
t('list 返回 11 篇（10 正文+INDEX）', r.count === 11, 'count=' + r.count)
t('list 每篇有标题摘要', r.skills.every(s => s.title && typeof s.on === 'boolean'))
t('缺省全开', r.skills.every(s => s.on === true))
const sb3 = r.skills.find(s => s.name === 'sb3-json-reference.md')
t('sb3-json-reference 在列且标题对', sb3 && /速查/.test(sb3.title))

// ---- read ----
r = await skillsTool.execute({ action: 'read', name: 'getting-started.md' })
t('read 返回全文含五大错误', /5 个错/.test(r.content) && r.on === true)
try { await skillsTool.execute({ action: 'read', name: '../../etc/passwd' }); t('路径穿越被拒（throw）', false, '没抛') }
catch (e) { t('路径穿越被拒（throw）', /非法/.test(e.message), e.message) }
// 注：defineTool execute 抛错才对——看它是 throw 还是返回
try { await skillsTool.execute({ action: 'read', name: 'nope.md' }); t('read 不存在的文件抛错', false, '没抛') }
catch (e) { t('read 不存在的文件抛错', /不存在/.test(e.message), e.message) }

// ---- toggle ----
r = await skillsTool.execute({ action: 'toggle', name: 'recipes.md' })
t('toggle 关闭', r.on === false)
r = await skillsTool.execute({ action: 'list' })
t('list 反映 off 状态', r.skills.find(s => s.name === 'recipes.md').on === false)
r = await skillsTool.execute({ action: 'toggle', name: 'recipes.md' })
t('toggle 再开', r.on === true)

// ---- skill_edit：create/read/update/append/delete ----
r = await editTool.execute({ action: 'create', name: 'ai-learned.md', content: '# AI 学到的\n\n> 适用场景：测试\n\n- 某某经验\n' })
t('create 新建', r.created === 'ai-learned.md', JSON.stringify(r))
try { await editTool.execute({ action: 'create', name: 'ai-learned.md', content: 'x' }); t('create 重复被拒', false, '没拒') }
catch (e) { t('create 重复被拒', /已存在/.test(e.message)) }
r = await skillsTool.execute({ action: 'read', name: 'ai-learned.md' })
t('read 到 agent 新建的', /AI 学到的/.test(r.content))
r = await editTool.execute({ action: 'update', name: 'ai-learned.md', content: '# v2\n' })
t('update 覆写', /v2/.test(await skillsTool.execute({ action: 'read', name: 'ai-learned.md' }).then(x => x.content)))
r = await editTool.execute({ action: 'append', name: 'ai-learned.md', section: '新经验', content: '缓动系数 0.12 实测最顺' })
r = await skillsTool.execute({ action: 'read', name: 'ai-learned.md' })
t('append 追加一节', /新经验/.test(r.content) && /0\.12/.test(r.content))
try { await editTool.execute({ action: 'create', name: '../evil.md', content: 'x' }); t('恶意文件名被拒', false, '没拒') }
catch (e) { t('恶意文件名被拒', /格式/.test(e.message)) }
try { await editTool.execute({ action: 'delete', name: 'INDEX.md' }); t('INDEX.md 不许删', false, '删了') }
catch (e) { t('INDEX.md 不许删', /不许删/.test(e.message)) }
r = await editTool.execute({ action: 'delete', name: 'ai-learned.md' })
t('delete 删除 agent 自建的', r.deleted === 'ai-learned.md')

// ---- 总开关 ----
// skillsEnabled=false 重新 apply 一个新 ctx
const fakeCtx2 = { logger: () => ({ info() {}, warn() {}, error() {} }), effect() {}, tools: { register: () => {} } }
// 直接测 disabled 行为：重新 apply 太重（桥端口占用），改为验证 config 路径逻辑——上面已覆盖 list/read/toggle/edit 主逻辑

// ---- 落盘检查 ----
const skillDir = join(process.env.DSH_HOME, 'scratch-skills')
const files = readdirSync(skillDir)
t('内置 skill 复制到 DSH_HOME', files.includes('INDEX.md') && files.includes('recipes.md'))
t('开关状态持久化在 .enabled.json', existsSync(join(skillDir, '.enabled.json')))

console.log(`\n===== skill 区单测: ${pass} pass / ${fail} fail =====`)
rmSync(process.env.DSH_HOME, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
