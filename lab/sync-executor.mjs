// sync-executor.mjs — 把扩展的页面执行器同步一份给插件包
//
// 为什么要有副本：
//   同一个执行器现在有两个宿主：
//     1. 扩展（tw-bridge-extension/content-main.js）—— 由 relay-isolated.js 转发消息
//     2. CDP 直连（dsh-plugin-scratch/vm-executor.js）—— 由 cdp.js 的垫片转发消息
//   插件包必须能**独立**读到执行器源码（用户机器上装了插件不等于装了这个仓库），
//   所以复制一份进插件包，而不是运行时跨包去读文件（那条路在真实安装布局下会断）。
//
// 防漂移：test-tools.mjs 里有一条断言要求两份**逐字节相同**。改完 content-main.js
// 跑一下 `node lab/sync-executor.mjs` 即可（忘了跑，测试会红）。
//
// 用法：node lab/sync-executor.mjs          # 同步
//       node lab/sync-executor.mjs --check  # 只检查（CI 用），不一致就退出码 1

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SRC = join(ROOT, 'packages', 'tw-bridge-extension', 'content-main.js')
const DST = join(ROOT, 'packages', 'dsh-plugin-scratch', 'vm-executor.js')

const src = readFileSync(SRC)
let cur = null
try { cur = readFileSync(DST) } catch { /* 还没有 */ }
const same = cur && cur.equals(src)

if (process.argv.includes('--check')) {
  if (same) {
    console.log(`OK  vm-executor.js 与 content-main.js 一致（${src.length} 字节）`)
    process.exit(0)
  }
  console.error('FAIL vm-executor.js 与 content-main.js 不一致 —— 跑 `node lab/sync-executor.mjs` 同步')
  process.exit(1)
}

if (same) {
  console.log(`OK  已经一致，无需同步（${src.length} 字节）`)
} else {
  writeFileSync(DST, src)
  console.log(`已同步 → ${DST}（${src.length} 字节）`)
}
