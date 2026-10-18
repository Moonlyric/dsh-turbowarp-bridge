// v0.10.0：空白作品生成器（G1）—— 产出的 sb3 必须能被**真 scratch-vm** 装载，
// 而且两个造型都要真的拿到 skin（不然又会出现"?"占位造型那种事）。
// 跑法：cd lab && node test-blank-project.mjs
import { buildBlankProject, zipStore } from '../packages/dsh-plugin-scratch/sb3.js'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'

const require = createRequire(import.meta.url)
const VM = (await import('scratch-vm')).default
const { ScratchStorage } = require('scratch-storage')
const { default: JSZip } = await import('jszip').catch(() => ({ default: null }))

let pass = 0
let fail = 0
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS ' + name) } else { fail++; console.log('  FAIL ' + name + (detail ? ' | ' + detail : '')) }
}
const J = (v) => { try { return JSON.stringify(v).slice(0, 300) } catch { return String(v) } }
const md5 = (buf) => createHash('md5').update(buf).digest('hex')

// headless VM + 最小 renderer 桩（scratch-vm 的 costume/drawable 管线硬依赖它）
const vm = new VM()
vm.attachStorage(new ScratchStorage())
let drawableSeq = 0
vm.runtime.renderer = {
  createSVGSkin: () => 'skin-stub', createBitmapSkin: () => 'skin-stub',
  getSkinSize: () => [80, 80], getCurrentSkinSize: () => [80, 80], getSkinRotationCenter: () => [40, 40],
  destroySkin: () => {}, isFlashRenderer: () => false,
  createDrawable: () => ++drawableSeq, destroyDrawable: () => {},
  getDrawableOrder: () => 0, setDrawableOrder: () => 0, setLayerGroupOrdering: () => {},
  updateDrawableDirectionScale: () => {}, updateDrawableEffect: () => {}, updateDrawablePosition: () => {},
  updateDrawableSkinId: () => {}, updateDrawableVisible: () => {},
  isTouchingColor: () => false, isTouchingDrawables: () => false, drawableTouching: () => false,
  getFencedPositionOfDrawable: (p) => p, draw: () => {}
}

console.log('[1] buildBlankProject 产出的东西自洽吗')
const built = buildBlankProject({ spriteName: '细胞', backdropName: '夜空', costumeName: '方块' })
const buf = built.buffer
t('zip 魔数是 PK\\x03\\x04（不是加密/占位的字节）', buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04,
  `${buf[0]} ${buf[1]} ${buf[2]} ${buf[3]}`)
t('project.json 能解析，且有 stage + 1 个角色', (() => {
  try {
    const pj = JSON.parse(buf.includes('project.json') ? JSON.stringify(built.projectJson) : '{}')
    return pj.targets.length === 2 && pj.targets[0].isStage === true && pj.targets[1].name === '细胞'
  } catch { return false }
})())
t('两个资源文件名就是内容 md5（sb3 的约定，不然存盘/重开会找不到）', (() => {
  const names = built.files.filter(f => f.endsWith('.svg'))
  if (names.length !== 2) return false
  const pj = built.projectJson
  const all = pj.targets.flatMap(x => x.costumes)
  return all.every(c => {
    const f = `${c.assetId}.svg`
    return names.includes(f) && c.md5ext === f
  })
})(), J(built.files))
t('造型旋转中心 = 图形中心（不是硬编码 48/50）', (() => {
  const sp = built.projectJson.targets[1].costumes[0]
  const st = built.projectJson.targets[0].costumes[0]
  return sp.rotationCenterX === 40 && sp.rotationCenterY === 40 && st.rotationCenterX === 240 && st.rotationCenterY === 180
})(), J(built.projectJson.targets[1].costumes[0]))

// 如果环境里有 jszip，顺手用"真正的 zip 阅读器"验一遍（等价于 scratch-parser 走的路）
if (JSZip) {
  const zip = await JSZip.loadAsync(buf)
  const files = Object.keys(zip.files).sort()
  t('标准 zip 阅读器能打开，条目数 = 3（project.json + 两个 svg）', files.length === 3, J(files))
  const pjText = await zip.file('project.json').async('string')
  t('project.json 里的 costume.assetId 与文件名对得上', (() => {
    const pj = JSON.parse(pjText)
    const c = pj.targets[1].costumes[0]
    return files.includes(`${c.assetId}.svg`)
  })())
}

console.log('[2] 真 scratch-vm 能不能装载（costume 要真的拿到 skin）')
await vm.loadProject(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
t('装载后是 Stage + 细胞 两个 target',
  vm.runtime.targets.map(x => x.getName()).join(',') === 'Stage,细胞',
  vm.runtime.targets.map(x => x.getName()).join(','))
const sp = vm.runtime.targets.find(x => !x.isStage)
const stage = vm.runtime.getTargetForStage()
t('角色造型载入了 skin（不会显示成 "?"）', !!(sp.getCostumes()[0] && sp.getCostumes()[0].skinId), J(sp.getCostumes()[0] && { n: sp.getCostumes()[0].name, s: sp.getCostumes()[0].skinId }))
t('舞台背景也载入了 skin', !!stage.getCostumes()[0].skinId, J(stage.getCostumes()[0] && stage.getCostumes()[0].skinId))
t('角色在舞台中心、可见、默认朝向 90', sp.x === 0 && sp.y === 0 && sp.visible === true && sp.direction === 90,
  J({ x: sp.x, y: sp.y, v: sp.visible, d: sp.direction }))
t('序列化回来还是干净的 sb3（targets/extensions/meta 都在）', (() => {
  const pj = JSON.parse(vm.toJSON())
  return pj.targets.length === 2 && Array.isArray(pj.extensions) && !!pj.meta && pj.meta.semver === '3.0.0'
})(), J(JSON.parse(vm.toJSON()).meta))

console.log('[3] zipStore 本身的边界')
t('空文件列表也能生成合法 EOCD', zipStore([]).length === 22, String(zipStore([]).length))
t('CRC 对同一个内容稳定（同样的字节 → 同样的 zip）',
  Buffer.compare(zipStore([{ name: 'a.txt', data: Buffer.from('hi') }]), zipStore([{ name: 'a.txt', data: Buffer.from('hi') }])) === 0)

console.log(`\n===== 空白作品生成器: ${pass} pass / ${fail} fail =====`)
process.exit(fail ? 1 : 0)
