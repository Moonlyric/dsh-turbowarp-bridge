# dsh-turbowarp-bridge

让 **DeepSeek Harness（dsh）里的 AI 直接读写你的 Scratch / TurboWarp 项目** ——
不是生成一个 sb3 丢给你，而是**在你正开着的编辑器里**加积木、改参数、删脚本、整理排版、定位高亮，
你实时看着它动手，不满意一句"回滚"就回到上一步。
v0.7.0 起它还能**替你点绿旗、点角色、按键、读运行期状态、量性能、截图**，
所以"改完到底行不行"不用你自己去点。

```
dsh 插件（Node，33 个 scratch_* 工具 + WebSocket 桥 :31820）

  路径一 · 扩展桥（你自己浏览器里的编辑器）
      ↕ JSON-RPC over ws（握手 token）
  浏览器扩展 MV3：service worker 持 socket + 内容脚本（MAIN world 操作 window.vm）
      ↕
  TurboWarp 编辑器（你在屏幕上看到的一切）

  路径二 · CDP 直连（TurboWarp Desktop，零安装、零 token）
      ↕ Chrome DevTools Protocol（插件启动时给进程带 --remote-debugging-port）
  TurboWarp Desktop（Electron）：编辑器页面 + 插件注进去的同一份执行器
```

两条路读写的是**同一份**页面执行器，区别只在"消息怎么送到编辑器页面"：

| 路径 | 定位 | 要求 | 页面自报 | 会话 id | 工具返回值里的 `transport` |
|---|---|---|---|---|---|
| CDP 直连 | **主力**（装了 TurboWarp Desktop 就用它） | 只要 TurboWarp Desktop（**零安装、零 token**） | `transport=cdp` | `cd-1` | `cdp-desktop` |
| 扩展桥 | 备用 | 装 MV3 扩展 + 选项页填 token | `transport=sw` | `tw-1` | `extension-bridge` |

**怎么选**：有 TurboWarp Desktop 就一律走桌面版 —— 零安装零 token、离线可用、33 个工具全通，
而且**只有它能截图**（`scratch_screenshot`）。扩展桥留着应付三种它做不到的情况：
① 这台机器没装桌面版；② 你已经在浏览器标签里编辑某个**在线作品**，不想存盘重开；
③ 要同时开好几个作品（多标签，`scratch_list_sessions` 里按 `session` 选）。
**能力上是桌面版 ⊃ 扩展桥**，反过来只有"在线作品 / 不装桌面版 / 多标签"这三项。

为什么桌面版必须走 CDP：TurboWarp Desktop 是 Electron 应用，**装不了 Chrome 扩展**
（它只有自己的 userscript addon 系统），扩展那条路对它无解。

## 它能干什么

| 能力 | 工具 |
|---|---|
| 读项目 | `scratch_snapshot`（整份 project.json）、`scratch_read_script`（按角色/按脚本读，**默认不回变量**，`summary` 只给结构） |
| 写积木 | `scratch_add_blocks`（走官方 `shareBlocksToTarget` 管线，字面量自动展开成影子块） |
| 改 / 删 | `scratch_update_block`、`scratch_delete_blocks`（级联）、`scratch_tidy_blocks`（排版） |
| 找得到 | `scratch_locate`（**跨全部角色搜**、滚到那块并高亮）、`scratch_get_opcodes`（白名单，防 AI 编造积木）、`scratch_list_scripts`（脚本清单，区分真脚本与游离块） |
| 造型 | `scratch_add_costume`（SVG → 角色造型） |
| 文件 | `scratch_load_project`（打开本机 .sb3）、`scratch_save_project`（存回磁盘，默认不覆盖） |
| 跑起来 | `scratch_run`（绿旗/停止）、`scratch_click`（点角色，按造型包围盒算中心）、`scratch_press_key`（按键） |
| 看得到 | `scratch_state`（线程/克隆/坐标/页变量/fps）、`scratch_profile`（每步耗时 p50/p95 + **热点归因**：哪条脚本在吃帧）、`scratch_screenshot`（截编辑器，桌面版） |
| 省往返 | `scratch_batch`（一次做多件事，只读/运行期白名单）、`scratch_selftest`（全链路自检） |
| 观察 | `scratch_watch`（变量轨迹，列表默认只报长度）、`scratch_user_context`（你选中了哪块、有没有按绿旗） |
| 唤起 | `scratch_open_editor`（AI 自己把编辑器打开，不用你点；浏览器 / 桌面版两条路，`port` 可接管你手动开的实例，`show:false` 只接管不弹窗） |
| 经验库 | `scratch_skills` / `scratch_skill_edit`（可读可写的 Scratch 实践经验，AI 自己积累） |
| 背包 | `scratch_backpack`（把做好的积木存进背包：存/列/读/删，删进 `_trash` 不真删）、`scratch_backpack_load`（取出来注入，变量/列表按名字接上或补建） |

**三档安全**（默认 `preview`）：写操作先返回一个 `planId` + 预览，你说"行"才落盘；
每次写操作前自动快照（内存 + 磁盘），随时 `scratch_rollback`。

## 装

> 需要 dsh（DeepSeek Harness），以及下面**两条路里至少一条**（推荐第一条）：
>
> | 路 | 要什么 | 要装什么 |
> |---|---|---|
> | **TurboWarp Desktop + CDP 直连**（推荐） | 只要 TurboWarp Desktop | **什么都不用装**（零安装、零 token）；想让 AI 接管你自己开的窗口，就用 `启动TurboWarp(AI可接管).cmd` 启动它 |
> | 浏览器 + 扩展桥（备用） | 一个 Chromium 系浏览器（Windows 自带的 Edge 就够）+ 能访问 turbowarp.org 的网络 | MV3 扩展 + 填一次 token |
>
> 换一台机器：装了 TurboWarp Desktop 就零安装直接能用；没有才需要下面第 1 节的浏览器 + 扩展。
> 代价是桌面版**不能**改浏览器里开着的在线作品、也不能多标签并行 —— 那两样只有扩展桥能做，
> 而**截图只有桌面版能做**，这才是两者的取舍点。

### 1. 浏览器扩展（备用路，约 1 分钟）

> **装了 TurboWarp Desktop 就跳过这节**，直接用第 4 节那条（零安装零 token，还能截图）。

1. `chrome://extensions` → 右上角开**开发者模式**
2. 「加载已解压的扩展程序」→ 选 `packages/tw-bridge-extension`
3. 卡片上「详细信息 → 扩展程序选项」，把**桥 token** 粘进去保存

任何 Chromium 系浏览器都能装（MV3）：Chrome、**Edge（Windows 自带）**、Brave、Opera、Vivaldi…，
手动安装路径都是 `chrome://extensions` → 开发者模式 → 加载已解压 → 选 `packages/tw-bridge-extension`。

| 浏览器 | 状态 |
|---|---|
| Chrome | ✅ 真机全链路验过（115/115） |
| Edge | ✅ 已实测 115/115（`lab/real-machine-check.mjs` 把 `$env:CHROME_PATH` 指到 `msedge.exe`） |
| Brave / Opera / Vivaldi 等 Chromium 系 | 同为 MV3、同一个手动安装流程，未逐个真机验 |
| Firefox | ❌ **不计划**：MV3 的后台是事件页而不是 service worker，扩展里"SW 持 socket"这套设计要单独适配。**已经决定不做** —— 桌面版那条路已经覆盖了"Firefox 用户也想要"的全部场景，为此再维护一套 userscript 不划算 |
| Safari | ❌ 不支持 |

> Edge 上唯一那条"失败"是验收脚本自己的断言：`Extensions.loadUnpacked` 是 Chrome 专属的 CDP 域，
> Edge 没有（脚本会自动回退 `--load-extension`，扩展照样装上了）。那条断言现在改成"两条路有一条走通"。

### 2. dsh 插件（走官方安装，别手改 YAML）

**在 dsh 的「插件」页里装**：侧栏 **插件** → **添加插件** → 把这一行的绝对路径粘进去：

```
G:\09 Eutopia\demo\DSH Turbowarp插件\packages\dsh-plugin-scratch
```

（这就是「从本地目录安装一个组合包」：dsh 会 `pnpm add file:<那个路径>`，把包装进
`profiles\<profile>\node_modules`，并加进 `dsh.profile.bundles`。）

**也可以从 GitHub 装**（换机器、或者不想 clone 仓库时用这个）——同一个对话框里粘：

```
github:Moonlyric/dsh-turbowarp-bridge#path:packages/dsh-plugin-scratch
```

这是 pnpm 的 git 子目录 spec（dsh 自带的 pnpm 11.28 支持 `#path:`），我用官方 CLI 验过：
装完卡片出现、`scratch` 行「运行中」、来源信息显示这一串、配置页正常。

⚠️ **但它在本机大概率会“连接 GitHub 超时”，而且开 VPN 也救不了**：
- 「安装源 = 中国大陆镜像源」只代理 **npm registry**；这个包**没发布到 npm**，git 安装走的是
  `github.com` / `codeload.github.com`，镜像完全不参与（UI 上这点很容易误会）；
- 安装流程会先跑一次 `git ls-remote`（默认 5s 预算），然后 pnpm 再去下载 —— 这两个**子进程不继承
  你的代理环境**。本地 HTTP 代理（127.0.0.1:7890）必须通过 `HTTPS_PROXY` 传进去才生效；
  实测：不带该环境变量时 `git ls-remote https://github.com/...` 21 秒超时失败。
- 想让它真的能装，得给 **DSH 进程**配代理（用户级 `HTTPS_PROXY` + 重启 dsh，或在 git 全局配置里写
  `http.proxy`）。没这个必要的话，直接用上面的本地目录安装。

**本地目录安装的两种写法**（都零网络）：

| 粘贴 | pnpm 记录 | 特点 |
|---|---|---|
| `G:\...\packages\dsh-plugin-scratch` | `link:` 符号链接 | **改仓库代码立即生效**，不用重装；但依赖仓库目录里的 `node_modules` |
| `file:G:\...\packages\dsh-plugin-scratch` | `file:` 复制 | 自包含、用宿主版本依赖；改代码后要重装 |

装完插件页里会出现一张 `dsh-plugin-scratch` 卡片，点进去是：

- **组合包开关** —— 关掉 = 从 `dsh.profile.bundles` 撤掉，插件停止运行；
- **`scratch` 这一行** —— 单独关掉 = 只停插件、保留安装（写进 profile patch 的 `disabled`）；
- **配置**（这一行的配置控件）—— 只放三项：**写操作档位**（preview / auto / suggest）、
  **TurboWarp Desktop 路径**（留空自动找）、**快照目录**。改完点保存即写回 profile 的
  `cordis.patch.yml` 并**立即生效**。端口、快照上限这些工程参数**不在页面上** ——
  要改就编辑 profile 的 `cordis.patch.yml`，然后重挂这一行。

为什么不能像以前那样手改 YAML：插件页只列**组合包**（`package.json` 声明了 `dsh.bundle.patch`
的包）。把手写的 `insert:` 塞进 profile patch 属于「绕过插件管理器的注入」—— 插件能跑，
但插件页里**根本没有它**，于是开关和配置页全都没有（用户实测踩过）。现在
`packages/dsh-plugin-scratch/package.json` 自带 `dsh.bundle.patch` + `dsh.client`，profile 的
patch 里只留一段**配置覆盖**（按 id 整段替换，所以字段要写全）。

> 宿主提供 `@deepseek-ai/dsh-tools` 和 `@deepseek-ai/schemastery`，插件**不要**把它们写进
> `dependencies`：写进去会装一份旧版进 profile，把宿主的 `tools` 行顶掉（实测被判版本不兼容，
> 然后整个插件加载不起来 —— 报错还完全不指向这里）。

### 3. token 从哪来

对 dsh 里的 AI 说一句「打开 TurboWarp」——它会调 `scratch_open_editor` 帮你开好编辑器，
并把 token 和三步指引一起念给你；也可以直接看 `$DSH_HOME/scratch-bridge-token.txt`。

> 为什么要 token：桥监听 `127.0.0.1:31820`，而 WebSocket 不受同源策略约束 ——
> 本机任意进程/页面都能连它。没有握手认证的话，对面可以冒充编辑器、伪造工具返回值，
> 甚至把文字塞进 AI 的上下文。token 只在本机、只填一次。

### 4. 桌面版这条路：什么都不用装

对 AI 说「打开 TurboWarp 桌面版」→ 它调 `scratch_open_editor({ app: "desktop" })`：
给 TurboWarp Desktop 带上一个空闲的 `--remote-debugging-port` 启动，再用 CDP 把同一份执行器
注进编辑器页面。零安装、零 token，不用扩展也不用联网。

- 想直接开自己的作品：`scratch_open_editor({ app: "desktop", path: "D:\\我的作品.sb3" })`
  （`.sb3` / `.sb2` / `project.json` 都行）。**已经有会话时不重复开窗口**，直接把文件装进现有会话，
  返回值里给 `loaded`。
- 工具会**等编辑器里真有角色了**才回报 `ready: true`：桌面版冷启动是"GUI 先出来、项目后加载"，
  刚接上时 `targets` 可能是空的，直接回报就绪会害 AI 往不存在的角色里塞积木。
- **窗口到底显示没有，工具自己会看**：返回值里带 `window: { hwnd, visible, minimized, rect, title }`
  （`EnumWindows` + `IsWindowVisible` 拿的，`Get-Process ... MainWindowHandle` 对隐藏窗口恒返回 0，
  会得出"没有窗口"的错误结论）。发现窗口是隐藏的会自动 `ShowWindow` 救回来，并回报
  `windowRepair`；救不回来给 `windowHidden: true` + 让用户按 Alt+Tab 的提示。
  `scratch_list_sessions` 也会带这个字段，AI 随时能自检"用户看得见吗"。
- **接管你自己开的那份窗口**：仓库根有个 `启动TurboWarp(AI可接管).cmd`，它和双击 TurboWarp 的
  区别只有一个 —— 多了 `--remote-debugging-port=31821`。以后用它开桌面版，AI 每次
  `app: "desktop"` 都会先探这个固定端口（配置项 `desktopDebugPort` 可改），探到就直接接管
  **你正在用的那个窗口**，不会再新开一个：返回值里 `launched.attached === true`、
  `launched.via === 'existing-debug-port'`、**没有 `pid` 字段**（因为不是它启动的）。
  脚本会自动找常见安装路径，装在别处就把 `TurboWarp.exe` 路径当参数传给它。
- ⚠️ 桌面版**已经在运行、但没带调试端口**时（比如你直接双击原版开的）接不进去：
  工具会如实返回 `alreadyRunning: true`，并给出三个办法 ——
  1) **先存盘**、关掉桌面版，再调一次这个工具（它启动时会带调试端口）；
  2) 以后改用上面那个 `.cmd` 启动（你自己开的窗口它也能接管）；
  3) 传 `force: true` 让它接管 —— **会先关掉现有窗口，未保存的改动会丢**。
  不想动它就改用 `app: "browser"`。

## 几个值得知道的技术坑

1. **socket 必须在扩展的 service worker 里。**
   Chrome 137+ 起，公网页面连 `ws://127.0.0.1` 会被 Local Network Access 检查直接拒
   （`net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`，页面里查 `local-network-access`
   权限是 `denied`，连"允许"的入口都没有），只有扩展的 service worker 豁免。
   代价是 MV3 SW 空闲约 30s 会被回收 → 用 20s 心跳 + `chrome.alarms` 兜底 +
   内容脚本端口自动重连解决；`lab/real-machine-check.mjs` 第 22 步专门验它。
   ⚠️ 顺带一个测试陷阱：**开着 VPN/代理时 turbowarp.org 会被解析成 fake-IP（私网段），
   Chrome 会认为"本页也是本地"从而绕过这个检查** —— 那样跑出来的绿灯是假的。
   验收脚本第 0 步会检测并拒绝这种结果。

2. **改 input 要改影子块。** scratch-vm 的 `changeBlock` 只认 `field | mutation | checkbox`，
   传 `'input'` 不报错但**静默无效**；输入框里的字面量是一个独立的影子块。
   详见 `packages/dsh-plugin-scratch/skills/sb3-json-reference.md`。

3. **CDP 注入时，相邻两个 IIFE 之间必须有分号。**
   垫片和执行器都是 `(function(){…})()`，拼在一起时 JS 会把第二个解析成"调用前一个的返回值"，
   报 `TypeError: (intermediate value)(...) is not a function`，注入直接失败。
   现在拼字符串时中间显式加 `;`，注完还会用 `({shim:…, executor: typeof window.__dshBridge})`
   复查一遍——没长出 `window.__dshBridge` 就报错，不假装成功。

4. **CDP 那条路得自己给消息贴协议标签。**
   扩展那条路里"给消息贴 `__dshBridgeRelay:'op'` 标签"这层活是 relay + service worker 干的；
   CDP 路径没有那一层，所以最初发过去的是裸 `{id, op, args}`，页面执行器完全不认识。
   症状极具误导性：`{__dshBridgeRelay:'ping'}` 手写了标签所以 ping/pong 正常、页面自报
   `socket=open authed=true`，但**每个 op 都超时**（project_meta 15s、snapshot 120s）。
   现在由 `tagForPage()`（`cdp.js`）负责贴标签，并且有单测断言守着。

5. **别用 `windowsHide` 启动 GUI 程序。**
   `spawn(..., { windowsHide: true })` 会让子进程带着 `SW_HIDE` 的启动信息创建 —— 对 TurboWarp
   Desktop 这种 Electron 应用，窗口对象**存在、CDP 连得上、积木也能改**，但用户在屏幕上看不到它。
   最坑的是两个"看起来能判断"的办法都失效：`Get-Process ... MainWindowHandle` 对隐藏窗口恒返回 0
   （会误判成"没有窗口"），`document.visibilityState` 在 Electron 里照样是 `visible`。
   只能 `EnumWindows` + `IsWindowVisible`（`packages/dsh-plugin-scratch/win32-window.ps1`）。
   现在 GUI 启动不带这个字段，并且会回报 `window.visible` / 自动 `ShowWindow` 补救。

6. **第三方插件不要依赖 `@deepseek-ai/*`，而且配置字段必须是 `.volatile()`。**
   - 依赖 `@deepseek-ai/dsh-tools` 会在 profile 里装一份旧版本，**遮蔽宿主运行时**，
     宿主的 `tools` 行被判版本不兼容 → 整个插件加载不起来（报错完全不指向这里）。
   - dsh 的 settings 服务只给「Config schema 里至少有一个 volatile 字段」的条目生成配置表单；
     普通字段只能在 YAML 里改，插件页上根本不出现配置控件（用户以为"设置参数坏了"）。
     浏览器半侧还要注册 `plugins.row.config`（key = `<包名>#<行 id>`）才有「配置」入口。

7. **CDP 里"默认执行上下文"不一定是主 frame 的 —— 子 frame 也有一份，而且长得一模一样。**
   编辑器页里只要冒出任何一个 iframe（连 `sandbox` 的 `about:blank` 都算），就会新建一个
   `auxData.isDefault = true` / `type = "default"` 的上下文。按 `isDefault` 选上下文的话会被它抢走：
   此后每条消息都投进那个空 iframe，`Runtime.evaluate` **不报错、只返回 `undefined`**，
   于是每个 op 都"超时"，而编辑器画面完全正常（真机被这条骗了一整轮）。
   现在先 `Page.getFrameTree` 拿主 frame id、`Runtime.enable` 开在它后面，只认这个 frame 的上下文；
   另外 `deliver()` 收不到 `ok` 会自己重注入重投一次（`reinjects`），还不行就报一条人看得懂的错误。
   `scratch_list_sessions` 的 `transport` 一行能看到 `injected / frame / skippedFrames / reinjects`。

## 验靶（能自己复跑的自动化）

```powershell
# 替身层：真 content-main.js 进 Node vm + 真 headless scratch-vm（246 条）
cd lab; node test-content-ops.js

# 真机层 A：真 Chrome / Edge + 真 turbowarp.org + 真扩展（115 条，约 4 分钟）
# ⚠️ 跑之前先关 VPN，否则是假绿
$env:SB3_FIXTURE='<某个 .sb3>'      # 可选：顺带验打开真实作品（断言会更多）
node real-machine-check.mjs

# 真机层 B：TurboWarp Desktop + CDP 直连（134 条，会真开一个窗口、跑完自动关掉）
node desktop-cdp-check.mjs

# 插件侧
cd ..\packages\dsh-plugin-scratch
node test-tools.mjs          # 128 条（含打包契约：组合包 / volatile 配置 / 浏览器半侧）
node test-skills.mjs         # 23 条
node test-bridge-auth.mjs    # 21 条
node test-backpack.mjs       # 36 条（导出/注入/与官方序列化器逐块对拍）

# 改过扩展的执行器之后必须同步，否则 test-tools 里那条"逐字节一致"的断言会红
cd ..\..; node lab/sync-executor.mjs
```

`node lab/sync-executor.mjs --check` 只检查不同步；`lab/desktop-cdp-check.mjs` 检测到你已经开着
TurboWarp 时会 SKIP，不打扰你。

其它：`node lab/inspect-sb3.mjs <文件.sb3>` 离线看一个作品的结构（角色/块数/扩展/变量/广播/自定义块）。

## 目录

```
packages/dsh-plugin-scratch/   dsh 插件：桥服务端 + 33 个工具 + 经验库 + 背包 + CDP 直连 + 单测
                               lib/client.js = 浏览器半侧（插件页里的配置表单，手写不用打包）
                               win32-window.ps1 = 窗口可见性探针（EnumWindows，Windows only）
packages/tw-bridge-extension/  MV3 扩展：SW 持 socket，内容脚本操作 window.vm
                               （CDP 那条路注的就是这份执行器，靠 lab/sync-executor.mjs 同步副本）
lab/                           验靶：替身 VM 层 + 真机层（Chrome/Edge）+ 桌面版 CDP 层 + 执行器同步
启动TurboWarp(AI可接管).cmd    用带调试端口的方式开 TurboWarp Desktop，AI 能接管你正在用的窗口
ROADMAP.md                     里程碑、设计决策、修过的真 bug
验收清单.md                     装完之后人眼该验什么（机器验不了的部分）
问题记录-处理台账.md           问题记录（699 行）里每条的下场：已修/部分修/不做 + 怎么验
```

## 授权

MIT（见 [LICENSE](LICENSE)）。TurboWarp / Scratch 是各自所有者的项目，本仓库只是它们的客户端。

> 仓库里的「经验库」（`packages/dsh-plugin-scratch/skills/*.md`）是对社区公开作品**做法**的总结，
> 只有文字经验，不含任何他人作品文件或资源。
