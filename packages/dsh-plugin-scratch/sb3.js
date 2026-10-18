// 最小 sb3 生成器 —— 只干一件事：造一个「空白作品」。
//
// 为什么放在插件侧（Node）而不是页面执行器里：
//   1) assetId 必须是**内容的 md5**（sb3 的约定，TurboWarp/scratch-vm 靠它定位资源），
//      页面里没有现成的 md5（crypto.subtle 只有 SHA-*），Node 里一行 createHash 就有；
//   2) 顺便能把这份 sb3 直接落盘给用户（scratch_new_project 返回文件路径）。
// 依赖只到 node:crypto：zip 用「存储模式」手写（sb3 不要求压缩，scratch-parser/JBZip 都吃 store），
// 这样不用引第三方 zip 库。
import { createHash } from 'node:crypto'

// ---------------- CRC32（zip 必需；Node 22.2+ 才有 zlib.crc32，这里自带一份更省事） ----------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

/** 把 [{name, data}] 打成 zip（全部 store，无压缩） */
export function zipStore(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8')
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data)
    const crc = crc32(data)
    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(0, 8) // method: store
    local.writeUInt16LE(0, 10) // mod time
    local.writeUInt16LE(0x21, 12) // mod date = 1980-01-01
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    name.copy(local, 30)
    locals.push(local, data)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0, 8) // flags
    central.writeUInt16LE(0, 10) // method
    central.writeUInt16LE(0, 12) // mod time
    central.writeUInt16LE(0x21, 14) // mod date
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30) // extra len
    central.writeUInt16LE(0, 32) // comment len
    central.writeUInt16LE(0, 34) // disk start
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)
    centrals.push(central)

    offset += local.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, cd, eocd])
}

// ---------------- 两份内置 SVG ----------------
// 舞台：浅灰渐变 + 中间一条淡淡的基准线（一眼能看出"这是空白作品"而不是坏了）
function backdropSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#f7f9fc"/><stop offset="1" stop-color="#dfe7f2"/>
  </linearGradient></defs>
  <rect width="480" height="360" fill="url(#bg)"/>
  <line x1="0" y1="180" x2="480" y2="180" stroke="#c9d4e3" stroke-width="1" stroke-dasharray="6 6"/>
</svg>`
}

// 角色：圆角方块 + 两只眼睛（可爱、无外部字体依赖，任何渲染器都能画）
function spriteSvg(color) {
  const c = color || '#4c97ff'
  return `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80">
  <rect x="4" y="4" width="72" height="72" rx="18" fill="${c}"/>
  <circle cx="28" cy="34" r="7" fill="#fff"/><circle cx="52" cy="34" r="7" fill="#fff"/>
  <circle cx="29" cy="35" r="3" fill="#1f2a37"/><circle cx="53" cy="35" r="3" fill="#1f2a37"/>
  <path d="M28 54 q12 8 24 0" stroke="#fff" stroke-width="4" fill="none" stroke-linecap="round"/>
</svg>`
}

const md5 = (buf) => createHash('md5').update(buf).digest('hex')

function svgAsset(svgText, name) {
  const data = Buffer.from(svgText, 'utf8')
  const assetId = md5(data)
  return {
    data,
    costume: {
      name,
      assetId,
      md5ext: `${assetId}.svg`,
      dataFormat: 'svg',
      rotationCenterX: 0,
      rotationCenterY: 0
    }
  }
}

/**
 * 造一份最小可用的 sb3（舞台 + 一个角色，各带一个造型）。
 * @param {{spriteName?:string, backdropName?:string, costumeName?:string, spriteColor?:string}} o
 * @returns {{buffer: Buffer, projectJson: object, files: string[]}}
 */
export function buildBlankProject(o = {}) {
  const spriteName = String(o.spriteName || '角色1').slice(0, 60)
  const backdropName = String(o.backdropName || '背景1').slice(0, 60)
  const costumeName = String(o.costumeName || '造型1').slice(0, 60)

  const backdrop = svgAsset(backdropSvg(), backdropName)
  const costume = svgAsset(spriteSvg(o.spriteColor), costumeName)
  // 旋转中心 = 图形中心（load-costume 只在缺省时才自己算，给了就得对）
  backdrop.costume.rotationCenterX = 240
  backdrop.costume.rotationCenterY = 180
  costume.costume.rotationCenterX = 40
  costume.costume.rotationCenterY = 40

  const projectJson = {
    targets: [
      {
        isStage: true,
        name: 'Stage',
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {},
        comments: {},
        currentCostume: 0,
        costumes: [backdrop.costume],
        sounds: [],
        volume: 100,
        layerOrder: 0,
        tempo: 60,
        videoTransparency: 50,
        videoState: 'on',
        textToSpeechLanguage: null
      },
      {
        isStage: false,
        name: spriteName,
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {},
        comments: {},
        currentCostume: 0,
        costumes: [costume.costume],
        sounds: [],
        volume: 100,
        layerOrder: 1,
        visible: true,
        x: 0,
        y: 0,
        size: 100,
        direction: 90,
        draggable: false,
        rotationStyle: 'all around'
      }
    ],
    monitors: [],
    extensions: [],
    meta: { semver: '3.0.0', vm: '0.2.0', agent: 'dsh-plugin-scratch' }
  }

  const parts = [
    { name: 'project.json', data: Buffer.from(JSON.stringify(projectJson), 'utf8') },
    { name: backdrop.costume.md5ext, data: backdrop.data },
    { name: costume.costume.md5ext, data: costume.data }
  ]
  const buffer = zipStore(parts)
  return {
    buffer,
    projectJson,
    files: parts.map(p => p.name),
    // 原件（名字 + 内容）：要在这份空白作品上再拼积木/变量自己打包时直接改 parts
    parts
  }
}
