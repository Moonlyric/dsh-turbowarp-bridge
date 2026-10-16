# tw-bridge-extension — MV3 浏览器扩展（v0.4.0）

连接 dsh-plugin-scratch 的 WebSocket 桥（默认 `ws://127.0.0.1:31820`），
在 turbowarp.org / scratch.mit.edu 的**页面主世界（MAIN world）**里调用 `window.vm`。

```
插件 (Node) ──ws://127.0.0.1:31820──> background.js (SW)   ← Chrome 的 LNA 只豁免 SW
                                         ↕ chrome.runtime 端口（relay-isolated.js，自动重连）
                                       content-main.js (MAIN world)  ← window.vm 在这儿
```

> ⚠️ **socket 必须在 service worker 里，不能放回页面。** Chrome 155 起，公网页面连
> `ws://127.0.0.1` 会被 Local Network Access 检查直接拒
> （`net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`；页面里查 `local-network-access`
> 权限是 `denied`，连"允许"的入口都没有），而扩展的 service worker 豁免。
> 代价：MV3 SW 空闲约 30s 会被回收、socket 跟着死 → 靠 SW 每 20s 心跳（桥回 pong）、
> 页面端口心跳、`chrome.alarms` 兜底、内容脚本 `port.onDisconnect` 自动重连这四层解决，
> 真机层第 22 步专门验它（空闲 45s 不许重连）。回归防线：`lab/test-content-ops.js`
> 里的 `ForbiddenWebSocket` 绊线（页面一旦自己 new WebSocket 就炸）。

## 结构

| 文件 | 作用 |
|---|---|
| `manifest.json` | MV3；`permissions: storage, scripting, alarms`；host 只匹配 turbowarp.org / scratch.mit.edu |
| `content-main.js` | 核心执行器（MAIN world，`document_idle`）：15 个 op + 宿主兼容层 + 观察者 + 用户事件。**不碰网络** |
| `relay-isolated.js` | ISOLATED world（`document_start`）：MAIN world ⇄ SW 的双向中继（`chrome.runtime.connect` 端口 + `window.postMessage`），断线自动重连 |
| `background.js` | service worker：**持有 WebSocket**、握手、心跳保活、多标签页路由（指令只发给当前目标页）、图标徽标 |
| `options.html` / `options.js` | 选项页：粘贴桥 token；高级项里可改桥地址（`bridgeUrl`，验收脚本用它避开你正在跑的 dsh） |

### 为什么要 relay 这一层

`window.vm` 只存在于页面主世界，所以执行器必须在 MAIN world；
但 **MAIN world 的脚本拿不到任何 `chrome.*` API**，而 socket 又只能在 SW 里。
两个世界之间唯一的通道是 `window.postMessage`，于是拆成两个 content script 加一个 SW。
选项页保存 token / 桥地址后 `chrome.storage.onChanged` 会触发 SW 立刻重连，**不用刷新页面**。

## 安装（开发者模式，2 分钟）

1. `chrome://extensions` → 右上角开「开发者模式」
2. 「加载已解压的扩展程序」→ 选**本文件夹**
3. 点扩展卡片上的「详细信息 → 扩展程序选项」，把桥 token 粘进去保存
   （token 从哪来：让 dsh 里的 AI 调一次 `scratch_list_sessions`，它会连 token 带步骤一起念给你；
   或者直接看 `$DSH_HOME/scratch-bridge-token.txt`）
4. 打开 https://turbowarp.org/editor
5. F12 看到 `[dsh-bridge] 桥已连上（socket 在扩展 SW 里）` 即成功
   （页面侧看不到 "socket open" 了——socket 在扩展后台，页面只是被告知状态）

没填 token 时会看到 `认证失败：token 不对或没填`（连接会被桥以 4003 关掉）——这是设计如此：
WebSocket 不受同源策略约束，**本机的任意进程/网页都能连 `ws://127.0.0.1:31820`**，
没有握手认证的话那个页面可以冒充编辑器、伪造工具返回值、往 `watch`/`user_context`
的返回里塞文本（等于一条写进 agent 上下文的注入通道）。

## 调试

- 扩展日志：F12 Console 过滤 `[dsh-bridge]`
- 桥状态：F12 输入 `window.__dshBridge.state()` → `socket=open authed=true token=已配置 vm=object`
- 手动跑一个 op：`await window.__dshBridge.ops('snapshot')`
- 观察者：`window.__dshBridge.watchState` / `window.__dshBridge.userEvents`

## 真机实测到的事实（改代码前先看这几条）

1. **`vm.workspace` 不存在。** GUI 把 workspace 存在 React 实例上（`blocks.jsx:167`）。
   能拿到的地方是 `window.ScratchBlocks.getMainWorkspace()`（TurboWarp 在 `blocks.jsx:94` 显式挂的）
   或 `window.Blockly.getMainWorkspace()`（scratch-blocks 是懒加载 chunk，出现得晚；
   新版 scratch.mit.edu 的 `window.Blockly` 里**只有 `Msg`**，没有 workspace）。
2. **scratch-blocks 没有 `scrollBounds`。** 那是上游 Blockly 的 API。真机实测
   `ws.scrollBounds === undefined`，可用的是 `centerOnBlock(id)` / `scroll(x,y)` / `scrollCenter()`。
   用 `typeof` 挡一下看似安全，实际结果是「不滚动也不报错」——功能静默失效（踩过）。
3. **`saveProjectSb3DontZip()` 返回的是 `Record<string, Uint8Array>`（一个文件映射），不是 project.json。**
   要 project.json 得从里面取 `project.json` 那一项再解码。快照/回滚曾经因此全坏。
4. **`shareBlocksToTarget(blocks, targetId)` 要的是「活块形态」数组**，不是 sb3 序列化 dict。
   传 dict 直接 `TypeError: copiedBlocks.map is not a function`。序列化形态 → 活块形态的转换
   在 `content-main.js` 里自己实现（`toLiveBlocks`，规则照抄 `serialization/sb3.js`）。
5. **turbowarp.org / scratch.mit.edu 都不发 CSP 头**（实测），所以 MAIN world 里连
   `ws://127.0.0.1` 不会被 CSP 拦；loopback 也不触发混合内容拦截。
6. `host_permissions` 里**不能写 `ws://`**：Chrome 的 match pattern 只允许
   `http` / `https` / `*`(仅 http+https) / `file`，写 `ws://127.0.0.1:31820/*` 会让 manifest 报错。
   （content script 的出站 WebSocket 本来也不需要 host 权限。）
7. **Chrome 137+ 的品牌版会忽略 `--load-extension`**（日志：`--load-extension is not allowed in
   Google Chrome, ignoring`，`--disable-extensions-except` 同样被拒）。
   这只影响自动化脚本；手动走 `chrome://extensions` → 加载已解压的扩展程序**不受影响**。
   自动化请用 CDP 的 `Extensions.loadUnpacked`（见 `lab/real-machine-check.mjs`）。
8. **TurboWarp Desktop（Electron）装不了本扩展。** 实测它的 `app.asar` 里没有任何
   `session.loadExtension` 调用（只有它自己的 userscript addon 系统，比如那个叫
   `load-extensions` 的 addon 是"自动添加音乐/画笔分类"的意思，跟 Chrome 扩展无关），
   而且桌面版的编辑器页面是本地资源，也不匹配本扩展的 `host_permissions`。
   所以**桥驱动不了桌面版**——桌面版要接 AI，得把执行器改写成 TurboWarp userscript（M3）。

## 宿主兼容层

`content-main.js` 里的 `toLiveBlocks` / `getBlocklyWorkspace` / `snapshotJson` / `safeEmitWorkspaceUpdate`
就是为上面这些差异写的。**别绕过它直接调 `window.vm`**——两条宿主分支的实测差异都记在
`research.md` 和 `lab/README.md` 里。
