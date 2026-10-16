# TurboWarp × DSH 桥 — 项目路线图

> 把 TurboWarp 编辑器接入 DeepSeek Harness（dsh）。
> AI 能力：读项目 → 增/改/删积木 → 整理布局 → 定位高亮 → SVG 造型 → 变量观察 → 用户动作感知。
> 核心原则：**全程 JSON** · 三档安全（默认 preview）· 快照先行（每次写操作前自动快照，可回滚）。

## 架构（一句话）

```
dsh 插件（Node，19 个 scratch_* 工具 + WebSocket 桥 :31820）
        ↕ JSON-RPC over ws（握手 token 认证）
浏览器扩展 MV3：**service worker 持有 WebSocket** + 内容脚本（MAIN world 执行 vm 操作）
        ↕ window.postMessage ↔ chrome.runtime 端口
TurboWarp 编辑器（用户实时看到一切变化）
```

⚠️ socket 为什么在 SW 里而不在页面里：Chrome 155 起，**公网页面**连 `ws://127.0.0.1`
会被 Local Network Access 检查直接拒（`net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`，
页面里 `permissions.query('local-network-access')` = `denied`，没得授权），
只有扩展的 service worker 豁免。详见下面「LNA 事故」一节。

AI 侧的入口是 `scratch_open_editor`：用户说「打开 TurboWarp」时，AI 直接开浏览器/桌面版，
不用让用户自己去点书签。

## 里程碑状态

| 里程碑 | 内容 | 状态 |
|---|---|---|
| **M0** | 核心管线：读（snapshot/read_script）+ 写（add_blocks）+ 回滚 + SVG 造型 + 定位 | ✅ |
| **M1** | 全编辑能力：update_block + delete_blocks（级联）+ tidy_blocks + opcode 白名单 + 快照持久化 | ✅ |
| **M2** | 观察者 + 双向联动：watch（变量订阅/轮询）+ user_context（选块/绿旗感知） | ✅ |
| **Skill 区** | Scratch 实践经验库（8 篇）+ scratch_skills / scratch_skill_edit + 三层开关 | ✅ 23/23 |
| **审计 + 修** | 全项目审查：修掉「核心注入在真机上根本不工作」等 7 个真 bug，补断言防回归 | ✅ 2026-10-16 |
| **LNA 改造** | socket 从页面搬进扩展 service worker + 心跳保活 + `lab` 加 LNA/保活断言 | ✅ 2026-10-17（这次绿才算数） |
| **M0.5 真机** | 真 Chrome + 真 turbowarp.org 全链路自动验收（19 工具 + 存/读 sb3） | 🔄 重跑中（旧的 98/98 是假绿） |
| **主动唤起** | `scratch_open_editor`：AI 自己开浏览器/桌面版并等会话连上 | ✅ 2026-10-16 |
| **文件往返** | `scratch_load_project` / `scratch_save_project`（打开本机 .sb3、存回磁盘、默认不覆盖） | ✅ |
| **M3** | 断链/接链（moveBlock 的 parent 系）、变量/列表增删、造型删除改名、**Desktop userscript 版桥** | 未开始 |
| **背包** | **AI 自维护的代码块背包**：把做好的可复用积木（pen 文字引擎、弹幕骨架、ECS 骨架…）预存下来，下次直接取用 | 未开始（见下） |
| **M4** | 多标签页路由（SW 已按 tab 记账，还差 UI）、快照 diff 预览 UI、性能（大项目分页读） | 部分（路由已做） |
| **M5** | 发布：npm 组合包 + `dsh plugin add`（版本锁定） | 未开始 |

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

## 测试资产（2026-10-16 本机复跑，可回归）

| 套件 | 覆盖 | 结果 |
|---|---|---|
| `lab/test-content-ops.js` | 扩展执行器全协议（真实 `content-main.js` 进 Node vm 沙箱 + 真 headless scratch-vm） | 112/112 ✅ |
| `lab/real-machine-check.mjs` | **真 Chrome + 真 turbowarp.org 全链路**（装扩展 → token 握手 → 19 工具 + 存/读 sb3 + 45s 保活） | 见 STATUS.md（重跑中） |
| `lab/test-vm-pipeline.js` | scratch-vm 管线冒烟（无断言，打印型） | 跑通 ✅ |
| `lab/inspect-sb3.mjs` | 离线读 sb3/project.json：同时报**真块数**和**含影子块数**（引用块数必须写清数法） | 工具 ✅ |
| `packages/dsh-plugin-scratch/test-skills.mjs` | skill 区 | 23/23 ✅ |
| `packages/dsh-plugin-scratch/test-tools.mjs` | 插件侧工具行为（唤起编辑器 / token 配置包 / 地址白名单 / 桌面版去重） | 27/27 ✅ |
| `packages/dsh-plugin-scratch/test-bridge-auth.mjs` | 握手认证 + 跨会话伪造防护 + ping/pong 保活 | 21/21 ✅ |

```sh
cd lab && npm install && node test-content-ops.js && node real-machine-check.mjs
cd ../packages/dsh-plugin-scratch && npm install
node test-skills.mjs && node test-tools.mjs && node test-bridge-auth.mjs
```

⚠️ 验靶盲区见 `lab/README.md`：替身层装的是 npm `scratch-vm`（**不是** turbowarp.org 跑的
`TurboWarp/scratch-vm`），`watch` 的定时轮询、`locate` 的真实渲染、宿主兼容层的另一条分支
都不被那些绿灯覆盖——上面第 2 条 bug 就是这么藏了很久的。
**动宿主 API 相关代码，跑完替身层必须再跑真机层。**

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

## 关键设计决策（为什么这样设计）

1. **WebSocket 由扩展 service worker 持有**（2026-10-17 改，原为"内容脚本直持"）：
   页面直连 loopback 会被 Chrome 的 Local Network Access 检查拒掉，SW 才豁免。
   代价是 MV3 SW 空闲回收 → 用 20s 心跳 + alarms 兜底 + 内容脚本自动重连解决。
   **别再改回页面直连**，`lab/test-content-ops.js` 有绊线拦着。
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
8. **多标签页只认一个目标页**：SW 按 tab 记账，指令只发给"最近被激活的那个"，
   meta 里带 `tabId` / `tabsConnected`，免得 AI 以为只有一个编辑器。

## 给接手 AI 的提示

- 你的 19 个工具：`scratch_open_editor`（主动开编辑器）/ `list_sessions` / `snapshot` /
  `read_script` / `add_blocks` / `apply` / `locate` / `add_costume` / `rollback` /
  `update_block` / `delete_blocks` / `tidy_blocks` / `get_opcodes` / `watch` /
  `user_context` / `load_project`（打开本机 .sb3） / `save_project`（存回磁盘） /
  `skills` / `skill_edit`
- **用户说「打开 TurboWarp」时别让他自己去点**：调 `scratch_open_editor`，它会把浏览器打开并等连上
- **发现没有会话**：调 `scratch_list_sessions`，它会把 token 和三步配置指引一起返回，念给用户
- **第一次在这个项目上干活：先 `scratch_skills read INDEX.md`**（8 篇经验按需选读，不强制）
- 生成积木前先 `scratch_get_opcodes` 查白名单，别编造 opcode
- 用户的块 ID 在 `scratch_snapshot` / `scratch_read_script` 的输出里；你自己注入的块用
  `add_blocks` 返回的**新 ID**
- 默认 preview 档：写操作先返回 `planId`，给用户看过再 `scratch_apply({planId})`
- 删块是级联的（删链头 = 删整条链 + 影子块），删中间前想清楚
- 改坏任何东西 → `scratch_rollback`（不带参数 = 最近一次）
- 动手前看一眼 `scratch_user_context`（用户在关注什么）
- 跑绿旗后用 `scratch_watch` poll 读变量轨迹
- **宿主差异**：turbowarp.org（TurboWarp/scratch-vm）和 npm 5.x 的 API 不同，
  `content-main.js` 里有兼容层，别绕过它直接调 `window.vm`
- 用户纠正你 / 你发现新惯用法 → `scratch_skill_edit append` 记进经验库（下次直接用）
