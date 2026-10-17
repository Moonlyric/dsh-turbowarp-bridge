# TurboWarp × DSH 桥 — 项目路线图

> 把 TurboWarp 编辑器接入 DeepSeek Harness（dsh）。
> AI 能力：读项目 → 增/改/删积木 → 整理布局 → 定位高亮 → SVG 造型 → 变量观察 → 用户动作感知。
> 核心原则：**全程 JSON** · 三档安全（默认 preview）· 快照先行（每次写操作前自动快照，可回滚）。

## 架构（一句话）

```
dsh 插件（Node，19 个 scratch_* 工具 + WebSocket 桥 :31820 + CDP 直连客户端）

  路一 · 扩展桥（用户自己的浏览器）
        ↕ JSON-RPC over ws（握手 token 认证）
  浏览器扩展 MV3：**service worker 持有 WebSocket** + 内容脚本（MAIN world 执行 vm 操作）
        ↕ window.postMessage ↔ chrome.runtime 端口
  TurboWarp 编辑器（用户实时看到一切变化）

  路二 · CDP 直连（TurboWarp Desktop，零安装、零 token）
        ↕ Chrome DevTools Protocol（启动时给进程带 --remote-debugging-port）
  TurboWarp Desktop 的编辑器页面：同一份执行器注进**默认执行上下文**
```

两条路读写的是**同一份**页面执行器，区别只在"消息怎么送到编辑器页面"：

| | 扩展桥（原有） | CDP 直连（新增） |
|---|---|---|
| 谁持有连接 | MV3 扩展 service worker 的 WebSocket | 插件进程的 CDP WebSocket（`cdp.js`） |
| 编辑器在哪 | 用户自己的浏览器 + turbowarp.org | **TurboWarp Desktop**（`tw-editor://./gui/gui.html`） |
| 用户要做什么 | 装扩展 + 填 token | **什么都不用做** |
| 页面自报 | `transport=sw` | `transport=cdp` |
| 会话 id | `tw-1` | `cd-1` |
| 工具返回 | `transport: 'extension-bridge'` | `transport: 'cdp-desktop'` |

⚠️ **扩展那条路**的 socket 为什么在 SW 里而不在页面里：Chrome 155 起，**公网页面**连 `ws://127.0.0.1`
会被 Local Network Access 检查直接拒（`net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`，
页面里 `permissions.query('local-network-access')` = `denied`，没得授权），
只有扩展的 service worker 豁免。详见下面「LNA 事故」一节。

AI 侧的入口是 `scratch_open_editor`：用户说「打开 TurboWarp」时，AI 直接开浏览器/桌面版，
不用让用户自己去点书签；传 `path` 还能顺手把 `.sb3` 装进去。

## 里程碑状态

| 里程碑 | 内容 | 状态 |
|---|---|---|
| **M0** | 核心管线：读（snapshot/read_script）+ 写（add_blocks）+ 回滚 + SVG 造型 + 定位 | ✅ |
| **M1** | 全编辑能力：update_block + delete_blocks（级联）+ tidy_blocks + opcode 白名单 + 快照持久化 | ✅ |
| **M2** | 观察者 + 双向联动：watch（变量订阅/轮询）+ user_context（选块/绿旗感知） | ✅ |
| **Skill 区** | Scratch 实践经验库（8 篇）+ scratch_skills / scratch_skill_edit + 三层开关 | ✅ 23/23 |
| **审计 + 修** | 全项目审查：修掉「核心注入在真机上根本不工作」等 7 个真 bug，补断言防回归 | ✅ 2026-10-16 |
| **LNA 改造** | socket 从页面搬进扩展 service worker + 心跳保活 + `lab` 加 LNA/保活断言 | ✅ 2026-10-17（这次绿才算数） |
| **M0.5 真机** | 真 Chrome/Edge + 真 turbowarp.org 全链路自动验收（19 工具 + 存/读 sb3） | ✅ **115/115**（2026-10-17 关 VPN 实测，Chrome 与 Edge 各一遍；旧的 98/98 是假绿） |
| **CDP 直连** | TurboWarp Desktop 零安装路径：带调试端口启动 + 注默认上下文 + 接管用户自己开的窗口 | ✅ 2026-10-17（61/61，见下） |
| **主动唤起** | `scratch_open_editor`：AI 自己开浏览器/桌面版并等会话连上；新增 `path` 装作品 | ✅ 2026-10-16 / 扩展于 2026-10-17 |
| **文件往返** | `scratch_load_project` / `scratch_save_project`（打开本机 .sb3、存回磁盘、默认不覆盖） | ✅ |
| **M3** | 断链/接链（moveBlock 的 parent 系）、变量/列表增删、造型删除改名、Firefox 支持（userscript 方向） | 未开始 |
| **背包** | **AI 自维护的代码块背包**：把做好的可复用积木（pen 文字引擎、弹幕骨架、ECS 骨架…）预存下来，下次直接取用 | 未开始（见下） |
| **M4** | 多标签页路由（SW 已按 tab 记账，还差 UI）、快照 diff 预览 UI、性能（大项目分页读） | 部分（路由已做） |
| **M5** | 发布：npm 组合包 + `dsh plugin add`（版本锁定） | 未开始 |

> Desktop 原来排在 M3（把执行器改写成 TurboWarp userscript）。**CDP 直连先落地了**，
> 那条 userscript 路不再是刚需 —— 现在 M3 里留着它只为 Firefox（那边没有 LNA 限制）。

## LNA 事故（2026-10-17，最重要的一条）

**症状**：用户关掉 VPN 后，真机层 5 条断言全红，报
`net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`。

**根因**：Chrome 137+ 引入、155 上默认强制的 Local Network Access 检查。
公网页面（turbowarp.org 解析到真实公网 IP）里 `new WebSocket('ws://127.0.0.1:…')` 被直接拒，
且**没有授权入口**：`navigator.permissions.query({name:'local-network-access'})` 返回 `denied`；
`--disable-features=LocalNetworkAccessChecks` 只把状态降到 `prompt`（无头浏览器点不了）。

**为什么之前的"98/98 全绿"是假的**：用户开着 VPN（Clash 类）时，turbowarp.org 被解析到
fake-IP（198.18.x.x 之类的私网段），Chrome 据此判定"本页也是本地"，loopback 直连畅通。
**VPN 一关，绿灯全部失效。**

**决定性实验**（三端口隔离，端口即身份）：

| 来源 | 结果 |
|---|---|
| turbowarp.org 页面（原方案所在） | ❌ 被拦 |
| 扩展自己的页面（chrome-extension://） | ❌ 被拦 |
| **扩展 service worker** | ✅ **连上了（LNA 对 SW 豁免）** |

**修法**：socket 搬进 `background.js`（SW），页面只做 vm 操作，中间走
`chrome.runtime.connect` 端口 + `window.postMessage`（`relay-isolated.js` 中继）。

**代价与对策**：MV3 SW 空闲约 30s 被回收 → socket 跟着死。所以：
每 20s `ping`（桥必须回 `pong`，Chrome 116+ 把 WS 收发算作 SW 活动）
+ 页面端口心跳 + `chrome.alarms` 30s 兜底重连 + 内容脚本 `port.onDisconnect` 自动重连。
`lab/real-machine-check.mjs` 第 22 步专门验这个（空闲 45s，sessionId 不许变）。

**回归防线**（防止有人再把 socket 写回页面）：
`lab/test-content-ops.js` 里那个 `ForbiddenWebSocket` 绊线 + 真机层第 4.5 步的 LNA 体检
（`pageSocket !== 'open'` 才算环境可信）+ 第 0 步的 fake-IP 检测。

## CDP 直连（2026-10-17，桌面版那条路）

**为什么要这条路**：TurboWarp Desktop 是 Electron 应用，**装不了 Chrome 扩展**
（只有它自己的 userscript addon 系统），扩展那条路对它根本无解。
但只要编辑器进程是**我们自己拉起来的**，就能给它带 `--remote-debugging-port`，
然后用 CDP 把**同一份执行器**注进去 —— 零安装、零 token。

**真机验证到的事实**（TurboWarp Desktop 1.16.0 / Electron 42 / Chromium 148）：

| 事实 | 说明 |
|---|---|
| 接受 `--remote-debugging-port` | `/json/list` 里的 page target 是 `tw-editor://./gui/gui.html` |
| **默认上下文里才有 `window.vm`** | `auxData.isDefault` 那个上下文里 `window.vm.runtime.targets` 有 Stage/角色、`window.Blockly` 也在；**隔离上下文（Electron Isolated Context）里没有 vm** → 注入必须挑默认上下文 |
| `Runtime.evaluate` 不受页面 CSP 限制 | DevTools 特权，47KB 的执行器能直接灌进去 |
| 两个方向各一条通道 | 页面→插件：`Runtime.addBinding`（页面里出现 `__dshCdpSend`，插件收 `Runtime.bindingCalled`）；插件→页面：`Runtime.evaluate` 调 `window.__dshCdpDeliver()`，它合成一个 `source: window` 的 `MessageEvent`（执行器的监听里有 `if (e.source !== window) return`，必须是 window） |
| **执行器一行没改** | 它只认 `window.postMessage` 上的 `__dshBridgeRelay` 协议；CDP 侧用一个垫片把 `postMessage` 拦下来转成 binding 调用 |

**踩到的两个真 bug**（都已修 + 有断言守着）：

1. **相邻 IIFE 缺分号。** 垫片和执行器都是 `(function(){…})()`，拼在一起时 JS 把第二个当成
   "调用第一个的返回值" → `TypeError: (intermediate value)(...) is not a function`，注入直接失败。
   现在拼字符串时中间显式加 `;`，注入后还会用
   `({shim:…, executor: typeof window.__dshBridge})` 复查 —— 没出 `window.__dshBridge` 就报错。
2. **op 消息缺协议标签。** 扩展那条路里"给消息贴 `__dshBridgeRelay:'op'` 标签"这层活是
   relay + service worker 干的；CDP 路径没有那一层，所以最初发过去的是裸 `{id,op,args}`，
   页面执行器完全不认识。症状极具误导性：`{__dshBridgeRelay:'ping'}` 手写了标签所以 ping/pong 正常、
   页面自报 `socket=open authed=true`，但**每个 op 都超时**（project_meta 15s、snapshot 120s）。
   现在有 `tagForPage()`（`cdp.js`）负责贴标签，并有单测断言。

**执行器副本防漂移**：`packages/dsh-plugin-scratch/vm-executor.js` 是扩展
`content-main.js` 的**逐字节副本**（CDP 注的就是它）。改完扩展执行器必须跑
`node lab/sync-executor.mjs`；`test-tools.mjs` 有一条逐字节一致的断言守着（忘了同步测试会红）。
只检查：`node lab/sync-executor.mjs --check`。

**验收闭环**：`lab/desktop-cdp-check.mjs`（61 条，本轮实测全绿）真开一个 TurboWarp 窗口、
跑完自动关掉；它用**另一条独立的 CDP 连接**直接读 `vm.runtime.targets[].blocks._blocks` 当证据
（不读插件自己的返回值），还会验"存盘 → 从磁盘装回来"的往返、**接管用户自己开的实例**
（第 8 节：接管的是那个实例、没新开窗口、没重复注册会话、收尾关干净）、以及
"关掉桌面版后会话必须自动掉线（不留僵尸会话）"。检测到用户已经开着 TurboWarp 时 SKIP，不打扰。

**桌面版冷启动的坑**：GUI 先出来、项目后加载 —— 刚接上时 `targets` 可能是空的。
所以 `scratch_open_editor({app:'desktop'})` 会**等编辑器里真有角色了**才回报 `ready: true`；
早回报会害 AI 往不存在的角色里塞积木。

**接管用户自己开的那份窗口**（避免"AI 每次都得再开一个窗口"）：
每次 `app:'desktop'` 都会**先探一个固定调试端口 31821**（配置项 `desktopDebugPort`）。
端口上有 CDP 端点就直接接管那个实例，不再新开 —— 返回值里 `launched.attached === true`、
`launched.via === 'existing-debug-port'`、**没有 `pid` 字段**（因为不是它启动的），
hint 里说明"没动他的窗口"。
用户侧对应仓库根的 `启动TurboWarp(AI可接管).cmd`：它和双击 TurboWarp 的**唯一区别**就是多了
`--remote-debugging-port=31821`（自动找常见安装路径，装在别处就把 exe 路径当参数传进去）。

**已经在运行、但没带调试端口的那份接不进去**（运行中的进程补不了启动参数）：
工具如实返回 `alreadyRunning: true` + **三个办法**：①存盘后关掉、让它再开（带调试端口）；
②以后改用那个 `.cmd` 启动（用户自己开的也能被接管）；③`force: true` 让它接管 ——
**会关掉现有窗口，未保存的改动会丢**。不想动它就改用 `app:'browser'`。

## 审计修掉的真 bug（2026-10-16）

按严重程度排，每一条都补了回归断言：

1. **核心「AI 注入积木」在真机上根本不工作。** `content-main.js` 按
   `typeof vm.saveProjectSb3DontZip === 'function'` 分支，走 TurboWarp 那条路时把
   **sb3 dict** 传给了 `shareBlocksToTarget`——而它要的是**活块形态数组**。
   真机上直接 `copiedBlocks.map is not a function`；在 npm VM 上「成功」但写出结构畸形的块
   （GUI 输入空白、快照 `[1,null]`、运行时取不到参数、嵌套块删不掉变孤儿）。
   修法：自己实现 sb3 序列化形态 → 活块形态的转换（`toLiveBlocks`，规则照抄 `serialization/sb3.js`），
   一律传数组。
3. **`user_context` 的「用户选块感知」一次都没生效过。** scratch-blocks 把动作放在
   `e.element`，`e.type` **恒为 `'ui'`**；旧代码判 `e.type === 'click'` 永远不成立，
   而唯一能过第一关的 `element:'selected'` 事件 `blockId` 又是 `null`，被 `&& e.blockId` 挡掉。
   修法：改判 `element ∈ {click, stackclick, selected}`，并给 `user_context` 加了
   `selected` 字段——直接问 Blockly 当前选中谁，不依赖事件捕获（事件可能整段漏掉）。
4. **`locate` 静默不滚动。** 它调的 `ws.scrollBounds` 是上游 Blockly 的 API，
   scratch-blocks 没有它；`typeof` 守卫 + `try/catch` 把「方法不存在」吞掉，
   于是「说定位了但工作区没动」。改用 scratch-blocks 真实存在的 `centerOnBlock(id)`，
   并让返回值带 `scrolledBy` 如实上报（一条路都走不通时明确给 warnings，不再假装成功）。
5. **快照/回滚全坏。** `saveProjectSb3DontZip()` 返回的是 `Record<string, Uint8Array>`（文件映射），
   旧代码当成 project.json 用。改成优先 `vm.toJSON()`，回退时从文件映射里取 `project.json` 解码。
6. **`delete_blocks` 少报删除量。** 预测删除集合时漏了影子块（`deleteBlock` 会连影子一起删），
   实测 3 vs 5。改成镜像 `deleteBlock` 的递归 + 删完全项目扫悬空引用。
7. **桥可被任意网页劫持。** WebSocket 不受同源策略约束，`ws://127.0.0.1:31820`
   任何网页都能连：可抢占会话、伪造 `{id,ok:true}` 应答、往 `watch`/`event` 帧塞文本
   （后者进 `scratch_watch`/`scratch_user_context` 返回值 = 写进 agent 上下文的注入通道）。
   加握手 token + 应答来源校验。
8. **`vm.workspace` 从来不存在**（GUI 把 workspace 存在 React 实例上），
   取用路径统一走 `window.ScratchBlocks` / `window.Blockly`。

## 测试资产（2026-10-17 本轮复跑，可回归）

| 套件 | 覆盖 | 结果 |
|---|---|---|
| `lab/test-content-ops.js` | 扩展执行器全协议（真实 `content-main.js` 进 Node vm 沙箱 + 真 headless scratch-vm） | 114/114 ✅ |
| `lab/real-machine-check.mjs` | **真 Chrome/Edge + 真 turbowarp.org 全链路**（装扩展 → token 握手 → 19 工具 + 存/读 sb3 + 45s 保活） | **115/115** ✅（Chrome、Edge 各一遍；不传 `SB3_FIXTURE`，传了真实 sb3 会更多） |
| `lab/desktop-cdp-check.mjs` | **TurboWarp Desktop + CDP 直连**端到端（独立 CDP 连接读真 VM + 存盘往返 + 接管用户实例 + 关掉后会话自动掉线） | 61/61 ✅ |
| `lab/sync-executor.mjs` | 把扩展 `content-main.js` 同步成插件包的 `vm-executor.js`（`--check` 只检查） | 工具 ✅ |
| `lab/test-vm-pipeline.js` | scratch-vm 管线冒烟（无断言，打印型） | 跑通 ✅ |
| `lab/inspect-sb3.mjs` | 离线读 sb3/project.json：同时报**真块数**和**含影子块数**（引用块数必须写清数法） | 工具 ✅ |
| `packages/dsh-plugin-scratch/test-skills.mjs` | skill 区 | 23/23 ✅ |
| `packages/dsh-plugin-scratch/test-tools.mjs` | 插件侧工具行为（唤起编辑器 / token 配置包 / 地址白名单 / 桌面版去重 / CDP 启动参数与诚实报错 / `tagForPage` / 执行器副本一致性 / 打包契约） | 73/73 ✅ |
| `packages/dsh-plugin-scratch/test-bridge-auth.mjs` | 握手认证 + 跨会话伪造防护 + ping/pong 保活 | 21/21 ✅ |

```sh
cd lab && npm install && node test-content-ops.js && node real-machine-check.mjs
node desktop-cdp-check.mjs          # 桌面版那条：会真开一个窗口，跑完自动关
cd ../packages/dsh-plugin-scratch && npm install
node test-skills.mjs && node test-tools.mjs && node test-bridge-auth.mjs
cd ..\.. && node lab/sync-executor.mjs   # 改过扩展执行器就要跑，否则 test-tools 会红
```

⚠️ 验靶盲区见 `lab/README.md`：替身层装的是 npm `scratch-vm`（**不是** turbowarp.org 跑的
`TurboWarp/scratch-vm`），`watch` 的定时轮询、`locate` 的真实渲染、宿主兼容层的另一条分支
都不被那些绿灯覆盖——上面第 2 条 bug 就是这么藏了很久的。
**动宿主 API 相关代码，跑完替身层必须再跑真机层。**
CDP 那条路也有它自己的盲区：`desktop-cdp-check.mjs` 只在装了 TurboWarp Desktop 的 Windows 上能跑，
而且检测到用户已经开着 TurboWarp 时会 SKIP（宁可没结论，也不打扰用户）。

## 背包（用户提的，排队中）

> 用户原话：「文字引擎这种完全可以直接预存到 ai 代码块背包里，后面可以加个类似这种背包的东西让 ai 自己维护」

一句话：**skill 存经验，背包存做好的积木**。

- **放什么**：可复用的整块积木（pen 文字引擎 `画字`/`找字`/`画文本` + 字模列表、弹幕骨架、
  ECS 骨架、存档读写、UI 按钮骨架…），带参数说明和"怎么用"。
- **放哪**：`$DSH_HOME/scratch-backpack/`，一条一个 JSON + 一份 `INDEX.md`（照抄 skill 区的做法，
  让 AI 能廉价扫目录、按需取用，而不是一次性全灌进上下文）。
- **谁来维护**：AI 自己。做完一件有难度的事 → 问用户"要不要存进背包" → 存；下次直接取。
  **不做自动收集**（自动存会攒一堆垃圾，用户就再也不看了）。
- **怎么用**：取出来就是 `scratch_add_blocks` 的入参形态（活块/sb3 形态二选一，工具自己转），
  AI 只需替换参数（坐标、字模列表、颜色）。
- **验收标准**：每个存进去的片段必须能"取出来 → 注入 → 通过积木结构体检 + 真机 GUI 显示正常"，
  这条由 `lab` 里的往返测试守住（存进去的东西不能用 = 背包没用）。
- 和 skill 区的关系：skill 讲"怎么做"，背包给"现成的东西"。两者共用同一套开关/索引习惯。

## 插件页化 + 真实工作反馈（2026-10-17 晚）

### 这一轮做掉的

| 问题 | 处理 |
|---|---|
| 插件页里**看不到**本插件 → 开关、配置全用不了 | 包改成标准**组合包**（`dsh.bundle.patch` + `manifestVersion` + `engines.dsh`），改用插件页「添加插件」安装；profile patch 里只留配置覆盖。**手写 `insert:` + junction 那套已删除** |
| 依赖 `@deepseek-ai/dsh-tools@0.2.0-rc.2` 把宿主 `tools` 行顶挂 | 从 `dependencies` 删除（宿主提供 `dsh-tools` / `schemastery`）；`test-tools.mjs` 有断言守着 |
| 「设置参数用不了」 | Config schema 10 个字段全部 `.volatile()` + `index.js` 用活视图读配置；新增手写浏览器半侧 `lib/client.js` 注册 `plugins.row.config`（key `dsh-plugin-scratch#scratch`）。保存写回 profile patch，端口约 2 秒自动重绑 |
| **P0** 桌面版窗口以隐藏态被拉起（用户全程看不到） | 根因是 `spawn(..., windowsHide: true)`；GUI 启动不再带。新增 `win32-window.ps1`（EnumWindows + IsWindowVisible + ShowWindow），`open_editor` / `list_sessions` 回报 `window`，隐藏态自动救 |
| **P1-2** 无会话/会话失效的错误只推扩展那条路 | 错误提示与 `setup` 都改成「① 桌面版零安装（通常最快）② 网页版扩展」，并说明会话可能是被关掉了 |

### 真实工作反馈里排队的（按代价/价值）

| 编号 | 问题 | 状态 |
|---|---|---|
| P1-1 | `scratch_locate` 不接受 `session`/`target`，只在当前编辑目标里搜 → 多角色项目基本不可用 | **待做**（加 target + 跨角色搜索 + 命中后自动切编辑目标） |
| P1-3 | session 缺窗口可观测性 | ✅ 已做（`window` 字段 + `windowRepair`/`windowHidden`） |
| P2-1 | 手动带 `--remote-debugging-port` 的实例不会被发现 | 部分：固定端口 `desktopDebugPort`（31821）会被探测并接管；任意端口仍不行（可加 `port` 参数） |
| P2-2 | `scratch_read_script` 输出爆炸（475KB～7.5MB，连带 variables/lists） | **待做**：`includeVariables:false` / `opcodes` 过滤 / `summary:true` / `limit` |
| P2-3 | 每个写操作都要 preview→apply 两次往返 | **待做**：`confirmPolicy:"auto"`（会话级或 open_editor 参数） |
| P2-4 | `open_editor` 没有窗口选项 | 部分：默认自动显示 + 回报可见性；仍缺显式 `showWindow:false` / 摆位 |
| P3-1 | `sessionId`（`cd-1`）重启即变 | 低优先（可加 `pid:port` 别名） |
| P3-2 | 写操作返回字段不统一（`added`/`updated`/`deleted`/`applied`） | 低优先（统一成 `{before, after, changed}`） |

### 能力缺口（真实工作暴露的最大一条）

19 个工具全是**静态读写**，而完成一件真活需要闭环：**启动 → 点绿旗 → 交互 → 读运行时 → 量性能 →
定位/高亮 → 改 → 截图给用户看 → 再量**。缺的入口/出口/度量/批处理，AI 只能自己在外面写脚本补
（实测补了 36 个文件 / 2334 行，比插件本体还大）。排期：

1. **运行控制**：`scratch_run({greenflag|stop})`、`scratch_click`、`scratch_press_key`、`scratch_state`、
   `scratch_screenshot`、`scratch_reveal_block`（这批在真机上都被验证过可行：`runtime.greenFlag()`、
   `ioDevices.mouse.postData`、`Blockly.getMainWorkspace().centerOnBlock`、`Page.captureScreenshot` 180ms）
2. **批处理**：`scratch_batch({calls:[...]})` —— 一次往返做多件事（实测 7 条命令合并后从
   「N×20s + N×推理」降到 314ms）
3. **脚本结构视图**：`scratch_list_scripts`（顶层脚本清单，区分**真脚本**与**游离积木**）、
   `read_script` 瘦身
4. **性能**：`scratch_profile({seconds})`（包装 `runtime._step` 量每步耗时，比项目自己的 fps 变量可靠）

## 以后可以做的（评估过，暂时不做）

| 想法 | 结论 |
|---|---|
| 拿 **DSH Desktop 内置的浏览器面板**当编辑器宿主 | ❌ **现在不行**。DSH Desktop 本身就是 Electron（Chromium），也**确实内置了一个浏览器面板**：`@deepseek-ai/dsh-client-ui-sidebar-browser`，包描述是 "Sandboxed Web browser tabs for the right Sidebar"（右侧边栏的沙箱化网页标签页，带地址栏、前进后退、刷新、沙箱开关）。但它是 Electron 的 `<webview>` 标签：**装不了浏览器扩展，也没法从外面注入脚本**，所以当不了编辑器宿主。能用的是那两条路：用户自己的浏览器 + 扩展、TurboWarp Desktop + CDP |
| **Firefox 支持**（userscript 方向） | 排在 M3。MV3 在 Firefox 上后台是事件页而不是 service worker，扩展里"SW 持 socket"那套设计要单独适配 —— **目前没有实现也没有验证**。好处是 Firefox 理论上没有 Local Network Access 那套限制，userscript 直接连 loopback 是可行方向 |
| Safari | ❌ 不支持（不打算做） |

## 关键设计决策（为什么这样设计）

1. **WebSocket 由扩展 service worker 持有**（2026-10-17 改，原为"内容脚本直持"）：
   页面直连 loopback 会被 Chrome 的 Local Network Access 检查拒掉，SW 才豁免。
   代价是 MV3 SW 空闲回收 → 用 20s 心跳 + alarms 兜底 + 内容脚本自动重连解决。
   **别再改回页面直连**，`lab/test-content-ops.js` 有绊线拦着。
   （这条只管**浏览器那条路**；桌面版走 CDP，压根不用 socket，也不用扩展。）
2. **MAIN world 注入**：`window.vm` 在页面主世界，isolated world 拿不到。
   vm 操作在 MAIN world 做，传输由 ISOLATED world 的 `relay-isolated.js` 中转
   （MAIN world 拿不到任何 `chrome.*` API）。
3. **idMap 回传**：`shareBlocksToTarget` 注入时 ID 全部换新，AI 后续引用必须拿新 ID
   ——这是官方行为不是 bug。展开后块数必然多于 AI 给的块数（inline 字面量会变成影子块），
   所以 idMap 用「数组下标 + 逐块 opcode 自校验」算，并对 AI 明说可靠与否。
4. **改 input 走影子块**：`changeBlock` 只认 `element: field | mutation | checkbox`
   （传 `'input'` 不报错但**静默无效**）。所以改输入值 = 找到 `inputs[NAME].shadow`
   再对影子块上它唯一的那个 field 调 `changeBlock`。
5. **watch 用 500ms 轮询**：scratch-vm 没有变量变化事件；两层（Stage 全局 + 角色局部）都要查。
6. **快照双保险**：内存（快，有字节上限）+ 磁盘 `$DSH_HOME/scratch-snapshots/`（dsh 重启后仍可滚，
   同样有上限）。大项目一份 project.json 就 7MB，不能无脑堆。
7. **握手 token**：插件生成一次，用户填进扩展选项页一次。见 `packages/dsh-plugin-scratch/README.md`。
   CDP 那条路**没有 token** —— 它连的是自己拉起来、自己注执行器的进程，不存在"本机任意页面都能连进来"。
8. **多标签页只认一个目标页**：SW 按 tab 记账，指令只发给"最近被激活的那个"，
   meta 里带 `tabId` / `tabsConnected`，免得 AI 以为只有一个编辑器。
9. **CDP 注入挑默认执行上下文**：`auxData.isDefault` 那个上下文里才有 `window.vm` 和 `window.Blockly`，
   **隔离上下文（Electron Isolated Context）里没有 vm**（第一次探针就栽在这）。
   上下文重建（`Runtime.executionContextsCleared` / 主框架导航）后要重新注入。
10. **CDP 侧必须自己贴协议标签**：页面上那套 `__dshBridgeRelay` 协议是扩展链路的约定，
    relay + SW 负责贴；CDP 没有那一层，所以 `tagForPage()` 在投递前补 `__dshBridgeRelay:'op'`
    （漏了这层，症状是 ping/pong 正常但每个 op 都超时）。
11. **执行器只维护一份源**：`content-main.js` 是唯一源文件，插件的 `vm-executor.js` 是逐字节副本
    （插件包必须能独立读到源码，运行时跨包读文件在真实安装布局下会断）。
    改完跑 `node lab/sync-executor.mjs`，一致性由 `test-tools.mjs` 的断言守着。
12. **固定调试端口 31821 = "可被接管的桌面版"的约定**：`app:'desktop'` 先探这个端口，
    有 CDP 端点就接管现成窗口（`launched.attached`，无 `pid`），没有才自己带端口开一份。
    这样"用户自己开着作品、AI 来改"才不用每次多开一个窗口。
    端口可配（`desktopDebugPort`），但**改了要同步改 `启动TurboWarp(AI可接管).cmd`** ——
    两边是同一个约定，脱钩了就接管不上。

## 给接手 AI 的提示

- 你的 19 个工具：`scratch_open_editor`（主动开编辑器，浏览器/桌面版两条路）/ `list_sessions` /
  `snapshot` / `read_script` / `add_blocks` / `apply` / `locate` / `add_costume` / `rollback` /
  `update_block` / `delete_blocks` / `tidy_blocks` / `get_opcodes` / `watch` /
  `user_context` / `load_project`（打开本机 .sb3） / `save_project`（存回磁盘） /
  `skills` / `skill_edit`
- **用户说「打开 TurboWarp」时别让他自己去点**：调 `scratch_open_editor`。它有两条路：
  `app:'browser'`（默认，要装扩展 + token）和 `app:'desktop'`（TurboWarp Desktop + **CDP 直连，零安装零 token**）。
  用户说「打开我的作品 xxx.sb3」就传 `path` —— 已经有会话时它**不会再开窗口**，直接把文件装进现有会话
- **桌面版已经在运行**：工具会先探固定调试端口 31821 —— 用户是用仓库根的
  `启动TurboWarp(AI可接管).cmd` 开的，就**直接接管他那个窗口**（`launched.attached: true`，没有 `pid`），
  别新开。如果探不到（直接双击原版开的），工具会返回 `alreadyRunning: true`：
  如实告诉用户三个办法（先存盘、关掉、再调一次 / 以后改用那个 `.cmd` 启动 / 传 `force: true` 让我接管），
  `force` 会**关掉现有窗口、未保存的改动会丢**——先说清楚再动
- **发现没有会话**：调 `scratch_list_sessions`，它会把 token 和三步配置指引一起返回，念给用户
  （或者干脆改用 `app:'desktop'`，不需要 token）
- **第一次在这个项目上干活：先 `scratch_skills read INDEX.md`**（8 篇经验按需选读，不强制）
- 生成积木前先 `scratch_get_opcodes` 查白名单，别编造 opcode
- 用户的块 ID 在 `scratch_snapshot` / `scratch_read_script` 的输出里；你自己注入的块用
  `add_blocks` 返回的**新 ID**
- 默认 preview 档：写操作先返回 `planId`，给用户看过再 `scratch_apply({planId})`
- 删块是级联的（删链头 = 删整条链 + 影子块），删中间前想清楚
- 改坏任何东西 → `scratch_rollback`（不带参数 = 最近一次）
- 动手前看一眼 `scratch_user_context`（用户在关注什么）；写积木前看 `project_meta` 的 `editingTarget`
  （光标在哪个角色上）
- 跑绿旗后用 `scratch_watch` poll 读变量轨迹
- **宿主差异**：turbowarp.org（TurboWarp/scratch-vm）和 npm 5.x 的 API 不同，
  `content-main.js` 里有兼容层，别绕过它直接调 `window.vm`
- **动扩展的执行器（`content-main.js`）之后必须跑 `node lab/sync-executor.mjs`**：
  插件的 `vm-executor.js` 是 CDP 那条路注进去的那份，忘了同步 `test-tools.mjs` 会红
- 用户纠正你 / 你发现新惯用法 → `scratch_skill_edit append` 记进经验库（下次直接用）
