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

// ---------------- .sprite3（单个角色的包，给 vm.addSprite 吃） ----------------
// 为什么走 zip 而不是在页面里拼对象：vm.addSprite 内部就是 sb3.deserialize(输入, isSprite=true)，
// 它拿到的第二返回值是 **zip**，造型字节只能从 zip 里读。少了 zip 里的资源，造型就没有 skin
// （编辑器里显示成 "?"）—— 和 addCostume 那条老坑是同一类。
// 好处：所有资源都按内容 md5 命名，天然和 sb3 的约定一致。

/** 从图片字节里读宽高 —— sprite3 的 rotationCenter 是**必填数字**，给了就得对 */
export function imageSize(buf) {
  if (!buf || buf.length < 16) return null
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  // PNG：IHDR 在偏移 16/20
  if (b.readUInt32BE(0) === 0x89504E47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), format: 'png' }
  // GIF
  const head3 = b.slice(0, 3).toString('latin1')
  if (head3 === 'GIF') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8), format: 'gif' }
  // BMP
  if (b[0] === 0x42 && b[1] === 0x4D) return { w: Math.abs(b.readInt32LE(18)), h: Math.abs(b.readInt32LE(22)), format: 'bmp' }
  // JPEG：扫 SOFn 段（段长是 big-endian，含两字节长度本身）
  if (b[0] === 0xFF && b[1] === 0xD8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xFF) { i++; continue }
      const m = b[i + 1]
      if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue }
      if (m === 0xD9 || m === 0xDA) break
      const len = b.readUInt16BE(i + 2)
      if (len < 8) break
      const isSof = m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC
      if (isSof) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5), format: 'jpg' }
      i += 2 + len
    }
  }
  // WebP（只认 VP8X，够用）
  if (b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP') {
    if (b.slice(12, 16).toString('latin1') === 'VP8X') {
      return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3), format: 'webp' }
    }
  }
  return null
}

/** SVG 文本里抠 width/height（拿不到就 null） */
function svgSize(svgText) {
  const m = /<svg[^>]*>/i.exec(svgText)
  if (!m) return null
  const tag = m[0]
  const w = /\swidth\s*=\s*"([\d.]+)(?:px)?"/i.exec(tag)
  const h = /\sheight\s*=\s*"([\d.]+)(?:px)?"/i.exec(tag)
  if (!w || !h) return null
  const ww = parseFloat(w[1])
  const hh = parseFloat(h[1])
  return Number.isFinite(ww) && Number.isFinite(hh) && ww > 0 && hh > 0 ? { w: ww, h: hh, format: 'svg' } : null
}

/**
 * 造一个单角色的 .sprite3（zip）。
 * @param {{name?:string, color?:string, costumes?:Array<{name:string, data:Buffer|string, format:string, cx?:number, cy?:number}>}} o
 * @returns {{buffer:Buffer, spriteName:string, files:string[], costumeNames:string[]}}
 */
export function buildSprite3(o = {}) {
  const name = String(o.name || '角色').slice(0, 60)
  const raw = (Array.isArray(o.costumes) && o.costumes.length)
    ? o.costumes
    : [{ name: '造型1', data: Buffer.from(spriteSvg(o.color), 'utf8'), format: 'svg' }]
  const parts = []
  const costumes = raw.map((c, i) => {
    const format = String(c.format || 'svg').toLowerCase()
    const data = Buffer.isBuffer(c.data) ? c.data : Buffer.from(c.data)
    const assetId = md5(data)
    parts.push({ name: `${assetId}.${format}`, data })
    // 旋转中心：调用方给了就用，否则按真实尺寸取中心（拿不到尺寸就退回 40×40 的常识值）
    const size = format === 'svg' ? svgSize(String(c.data)) : imageSize(data)
    const cx = typeof c.cx === 'number' ? c.cx : (size ? Math.round(size.w / 2) : 40)
    const cy = typeof c.cy === 'number' ? c.cy : (size ? Math.round(size.h / 2) : 40)
    return {
      name: String(c.name || `造型${i + 1}`).slice(0, 60),
      assetId,
      md5ext: `${assetId}.${format}`,
      dataFormat: format,
      rotationCenterX: cx,
      rotationCenterY: cy
    }
  })
  const sprite = {
    isStage: false,
    name,
    variables: {},
    lists: {},
    broadcasts: {},
    blocks: {},
    comments: {},
    currentCostume: 0,
    costumes,
    sounds: [],
    volume: 100,
    layerOrder: 0,
    visible: true,
    x: 0,
    y: 0,
    size: 100,
    direction: 90,
    draggable: false,
    rotationStyle: 'all around'
  }
  // 带一个空舞台：sprite3 的约定（全局变量/广播从舞台里来），空的就是"什么都不带进来"
  const stage = {
    isStage: true,
    name: 'Stage',
    variables: {},
    lists: {},
    broadcasts: {},
    blocks: {},
    comments: {},
    currentCostume: 0,
    costumes: [],
    sounds: [],
    volume: 100,
    layerOrder: 0,
    tempo: 60,
    videoTransparency: 50,
    videoState: 'on',
    textToSpeechLanguage: null
  }
  const projectJson = {
    projectVersion: 3,
    targets: [stage],
    monitors: [],
    extensions: [],
    meta: { semver: '3.0.0', vm: '0.2.0', agent: 'dsh-plugin-scratch' }
  }
  // ⚠️ sprite3 的包里有**两个** json，真机实测（三种形状逐个试）：
  //   · project.json = 整份项目（这里只放舞台：空舞台 = 什么全局变量/广播都不带进来）
  //   · sprite.json  = **角色对象本身**（不是 {projectVersion, targets}）——
  //     放成项目形状会被校验拒掉：`sprite/required: should have required property 'name'`
  //   · 只放 project.json 会直接报 "missing project or sprite json"（它先找 sprite.json）
  parts.unshift({ name: 'project.json', data: Buffer.from(JSON.stringify(projectJson), 'utf8') })
  parts.push({ name: 'sprite.json', data: Buffer.from(JSON.stringify(sprite), 'utf8') })
  return {
    buffer: zipStore(parts),
    spriteName: name,
    files: parts.map(p => p.name),
    costumeNames: costumes.map(c => c.name),
    // 给测试/调用方看的原件（要改哪一项就自己改再 zipStore）
    projectJson,
    spriteJson: sprite
  }
}
