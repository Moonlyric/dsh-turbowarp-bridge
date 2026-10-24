// assets.js — 本机资源文件（图片/音频/积木 JSON）→ 桥能传的东西
//
// 为什么单独一个文件：这一层是**纯函数**（读盘 → 归一化），不碰桥、不碰 vm，
// 于是能在 node 里直接测（test-tools.mjs 的「资源导入」一节）。真机反馈（A1/A6）说得很清楚：
// 桥以前只收 SVG 源码，PNG 头像 + WAV 音效只能靠"自己写 sb3 打包器"绕过 —— 那一步现在归这里。
//
// 分工：
//   · 插件侧（Node）：读盘、算 md5/尺寸、拼 .sprite3 zip → base64
//   · 页面侧（执行器）：base64 → Uint8Array → storage.createAsset → addCostume/addSound/addSprite
// 为什么不在页面里读文件：页面是编辑器，没有 fs（也不需要给它 fs）。
import { readFileSync, existsSync, statSync } from 'node:fs'
import { resolve, basename } from 'node:path'

/** 扩展名别名（.jpeg 在 sb3 里统一按 jpg 处理；其他原样） */
export const ASSET_EXT_ALIAS = { jpeg: 'jpg', jfif: 'jpg' }
/** 单文件上限：base64 后 ≈32MB，WebSocket / CDP 都扛得住，再大就该先压 */
export const MAX_ASSET_BYTES = 24 * 1024 * 1024

/**
 * 读一个本机资源文件 → { abs, bytes, format, base64, name }
 * @param {string} filePath 绝对路径，或相对当前工作目录
 */
export function readAssetFile(filePath) {
  const abs = resolve(String(filePath))
  if (!existsSync(abs)) throw new Error(`文件不存在：${abs}`)
  const st = statSync(abs)
  if (!st.isFile()) throw new Error(`不是文件：${abs}`)
  if (st.size > MAX_ASSET_BYTES) {
    throw new Error(`文件太大（${(st.size / 1024 / 1024).toFixed(1)}MB > ${MAX_ASSET_BYTES / 1024 / 1024}MB）：${abs}。先压缩再来。`)
  }
  const bytes = readFileSync(abs)
  const ext = (basename(abs).split('.').pop() || '').toLowerCase()
  return {
    abs,
    bytes,
    format: ASSET_EXT_ALIAS[ext] || ext,
    base64: bytes.toString('base64'),
    name: basename(abs).replace(/\.[^.]+$/, '')
  }
}

/** 读一个 JSON 文件（blocksFile 用）；解析失败时说清是哪个文件 */
export function readJsonFile(filePath) {
  const abs = resolve(String(filePath))
  if (!existsSync(abs)) throw new Error(`文件不存在：${abs}`)
  const text = readFileSync(abs, 'utf8')
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new Error(`不是合法 JSON（${abs}）：${e.message}`)
  }
}

/**
 * blocksFile 的三种形状都收（尽量少让调用方猜）：
 *   ① 纯 blocks dict                                  → 必须再给 target
 *   ② { target, blocks, variables? }                   → 单目标
 *   ③ { targets: { 名字: blocks | {blocks,variables} } } → 多目标，一次调用搞定
 * @param {any} json 解析好的 JSON
 * @param {string} [fallbackTarget] 参数里给的 target
 * @returns {Array<{target?:string, blocks:object, variables?:Array}>}
 */
export function normalizeBlocksFile(json, fallbackTarget) {
  const isBlockDict = (o) => o && typeof o === 'object'
    && Object.values(o).some(v => v && typeof v === 'object' && typeof v.opcode === 'string')
  const one = (v) => (isBlockDict(v) ? { blocks: v } : v)
  if (json && typeof json === 'object' && json.targets && typeof json.targets === 'object' && !Array.isArray(json.targets)) {
    const out = []
    for (const [name, v] of Object.entries(json.targets)) {
      const item = one(v)
      if (!item || !item.blocks) throw new Error(`targets["${name}"] 里没有 blocks`)
      out.push({ target: name, blocks: item.blocks, variables: item.variables })
    }
    if (!out.length) throw new Error('targets 是空的')
    return out
  }
  if (json && typeof json === 'object' && json.blocks && typeof json.blocks === 'object') {
    return [{ target: json.target || fallbackTarget, blocks: json.blocks, variables: json.variables }]
  }
  if (isBlockDict(json)) return [{ target: fallbackTarget, blocks: json }]
  throw new Error('blocksFile 里没找到积木：要么是 blocks dict，要么是 {target,blocks}，要么是 {targets:{名字:blocks}}')
}
