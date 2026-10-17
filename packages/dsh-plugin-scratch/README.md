# dsh-plugin-scratch — TurboWarp 桥插件（v0.8.0 · 组合包安装 + 插件页配置 + CDP 直连 + 运行控制闭环 + 积木背包）

DSH（DeepSeek Harness）插件：把 TurboWarp 编辑器接入 agent。
AI 通过 `scratch_*` 工具读取/修改 Scratch 项目，用户在 TurboWarp 界面里**实时**看到变化。

架构（两条传输路径，读写的是**同一份**页面执行器）：

```
本插件（Node）= WebSocket 服务端（桥 :31820） + CDP 直连客户端 + 30 个 scratch_* 工具 + Skill 经验库 + 积木背包

  路一 · 扩展桥
        ↕ JSON-RPC over ws（握手 token）
  浏览器扩展 tw-bridge-extension = 桥客户端 + turbowarp.org 页面 MAIN world 里的 window.vm 执行器
        ↕ window.vm
  TurboWarp 编辑器（用户实时看到一切）

  路二 · CDP 直连（TurboWarp Desktop，零安装、零 token）
        ↕ Chrome DevTools Protocol（启动时给进程带 --remote-debugging-port）
  TurboWarp Desktop 的编辑器页面：同一份执行器注进**默认执行上下文**
        ↕ window.vm
```

| 路径 | 要求 | 页面自报 | 会话 id | 工具返回值里的 `transport` |
|---|---|---|---|---|
| 扩展桥 | 装 MV3 扩展 + 选项页填 token | `transport=sw` | `tw-1` | `extension-bridge` |
| CDP 直连 | 只要 TurboWarp Desktop，**零安装、零 token** | `transport=cdp` | `cd-1` | `cdp-desktop` |

> 为什么桌面版必须走 CDP：TurboWarp Desktop 是 Electron 应用，**装不了 Chrome 扩展**
> （它只有自己的 userscript addon 系统），扩展那条路对它根本无解。

## 装到 dsh（DSH Desktop）

**走插件页的官方安装，别手改 YAML。**

1. dsh 侧栏 → **插件** → **添加插件**（可以点主按钮右边的箭头选「安装第三方插件」）
2. 把本包的**绝对路径**粘进去（dsh 会 `pnpm add file:<路径>`，把包装进
   `profiles\<profile>\node_modules` 并加进 `dsh.profile.bundles`）：
   ```
   G:\09 Eutopia\demo\DSH Turbowarp插件\packages\dsh-plugin-scratch
   ```
3. 装完插件页里会出现 `dsh-plugin-scratch` 卡片：里面对应一个 `scratch` 行，
   可以**分别开关**（组合包开关 = 停用/启用整个包；行开关 = 只停插件）。

不想用本地路径也可以从 GitHub 装（dsh 自带的 pnpm 支持 `#path:` 子目录）：

```
github:Moonlyric/dsh-turbowarp-bridge#path:packages/dsh-plugin-scratch
```

⚠️ 但在本机大概率会「连接 GitHub 超时」，开 VPN 也没用：
- 安装源里的「中国大陆镜像源」只代理 **npm registry**，本包没发布到 npm，git 安装走 github.com；
- dsh 的安装子进程不继承本地 HTTP 代理，`git ls-remote`（5s 预算）直接超时 —— 实测不带
  `HTTPS_PROXY` 时 21 秒失败。要用它必须给 dsh 进程配代理。

本机推荐直接用上面的**本地目录**（零网络）。两种写法：

| 粘贴 | 记录成 | 特点 |
|---|---|---|
| `G:\...\packages\dsh-plugin-scratch` | `link:` | 改代码立即生效；依赖仓库里的 node_modules |
| `file:G:\...\packages\dsh-plugin-scratch` | `file:` | 自包含；改代码要重装 |

装好之后**不要**再去 `cordis.patch.yml` 里手写 `insert:`。手写 insert 能跑，但插件页里看不到它
——没有启用/禁用开关、没有配置页（这是真机上踩过的坑）。profile patch 只用来**覆盖配置**：

```yaml
- id: scratch
  name: dsh-plugin-scratch
  config:
    bridgePort: 31820
    snapshotsDir: 'G:\某个不占系统盘的地方\scratch-snapshots'
```

（patch 是按 id **整段替换**，覆盖时要把想保留的字段写全。行本身由本包的
`cordis.patch.yml` 提供 —— 那是 `dsh.bundle.patch` 声明的组合包层。）

### 插件页里的配置（10 项，改完立即生效）

| 字段 | 默认 | 说明 |
|---|---|---|
| `safety` | `preview` | `preview` 先给 planId 等确认 / `auto` 直接落盘 / `suggest` 只给建议 |
| `bridgePort` | `31820` | 桥监听端口（扩展那条路用）。改完约 2 秒**自动重绑**，不用重启 |
| `desktopDebugPort` | `31821` | 「可接管」固定调试端口，与 `启动TurboWarp(AI可接管).cmd` 保持一致 |
| `desktopPath` | 空 | TurboWarp Desktop 的 exe，留空自动找 |
| `browserPath` | 空 | 网页版用哪个浏览器，留空 = 系统默认 |
| `snapshotsDir` | 空 | 快照目录，留空 = 系统临时目录 |
| `maxSnapshots` | `30` | 内存里最多留几份快照 |
| `maxSnapshotMemMb` | `64` | 快照内存上限（MB） |
| `maxSnapshotDiskMb` | `256` | 快照落盘上限（MB） |
| `skillsEnabled` | `true` | Skill 经验库总开关 |

这些字段在 `index.js` 的 `Config` 里都声明了 `.volatile()`：dsh 的 settings 服务**只**为
volatile 字段生成表单，而且 volatile 值在运行时是 `{ get() }` 引用 —— 所以插件每次读配置都取
最新值，UI 保存后不用重启。浏览器半侧在 `lib/client.js`（手写的 `__ModuleLoader__` bundle，
注册 `plugins.row.config`，key = `dsh-plugin-scratch#scratch`）。

⚠️ **不要**把 `@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery` 写进 `dependencies`：
宿主会提供它们；写进 deps 会装一份旧版进 profile 并把宿主的 `tools` 行顶掉（版本不兼容 → 整个
插件加载不起来，报错还完全不指向这里）。

## 桥的握手 token（必配一次）

桥监听 `127.0.0.1:31820`，而 **WebSocket 不受同源策略约束**：你访问的任意网页都能连上它。
没有认证的话，那个页面可以抢占会话、伪造 `{id, ok:true}` 应答、还能往 `watch` / `event`
帧里塞文本——而后者会进 `scratch_watch` / `scratch_user_context` 的返回值，
等于一条写进 agent 上下文的注入通道。

所以桥要 token：

1. 插件首次启动生成 32 位 hex，存到 `$DSH_HOME/scratch-bridge-token.txt` 并写日志
2. 用户把 token 填进扩展的选项页（存 `chrome.storage.local`），**只需一次**
3. 扩展连上后先发 `hello{token}`，桥验过才回 `hello-ack`；不带/带错 token 的连接会被
   以 4001/4003 关掉

不方便翻文件时的正经拿法：让 AI 调一次 `scratch_list_sessions`——**没有会话时它会返回
`setup.token` 和三步连接指引**，AI 会直接念给你。

> **只有浏览器（扩展桥）那条路要 token。** 桌面版走 CDP 直连：不用扩展、不用 token，
> 因为它连的是"我们自己拉起来、自己注执行器"的进程，没有"本机任意页面都能连进来"这个问题。

## 工具清单（30 个）

| 工具 | 方向 | 说明 |
|---|---|---|
| `scratch_list_sessions` | 读 | 已连接的 TW 编辑器标签页；无会话时返回 token + 配置步骤 |
| `scratch_open_editor` | 启动 | **主动帮用户打开编辑器**（浏览器 / 本地桌面版两条路），可顺手把 `.sb3` 装进去 |
| `scratch_load_project` | 写 | 打开本机 `.sb3` / `.sb2` / `project.json`（先自动快照） |
| `scratch_save_project` | 写 | 存成 `.sb3`（默认**不覆盖**已有文件，另存 `-ai-时间戳`） |
| `scratch_snapshot` | 读 | 项目全量 sb3 JSON（真 project.json，不是 `saveProjectSb3DontZip` 的文件映射） |
| `scratch_read_script` | 读 | 单精灵块 JSON（省 token） |
| `scratch_add_blocks` | 写 | 注入块：sb3 dict 进 → 自动转活块形态、ID 换新、扩展自动加载、返回 `idMap` |
| `scratch_apply` | 写 | preview 档确认后落盘（传 `planId`） |
| `scratch_locate` | UI | 工作区滚到块并高亮 3 秒（`scrolledBy` 会告诉你实际走的哪条滚动 API） |
| `scratch_add_costume` | 写 | SVG → 造型 |
| `scratch_rollback` | 写 | 回滚快照（内存 + 磁盘双保险，dsh 重启也能滚） |
| `scratch_update_block` | 写 | 改 `fields` 下拉 / `inputs` 输入值 / `x,y` 坐标 |
| `scratch_delete_blocks` | 写 | 删块（级联），返回实删清单 + 悬空引用扫描 |
| `scratch_tidy_blocks` | 写 | 整理布局（列排布） |
| `scratch_get_opcodes` | 读 | opcode 白名单（防 AI 编造） |
| `scratch_watch` | 读 | 变量订阅（start/poll/stop，Stage + 角色两层）；**列表默认只报长度**（`includeLists:true` 才跟，且只回首个变化位 + 样本） |
| `scratch_user_context` | 读 | 用户最近动作（选块 / 绿旗 / 运行态）+ 当前选中块 |
| `scratch_skills` | 读 | 经验库 list / read / toggle |
| `scratch_skill_edit` | 写 | 经验库 create / update / append / delete |
| `scratch_run` | 运行 | 点绿旗 / 停止全部 / 起停 VM 循环，返回动作前后的线程数、克隆数、页面变量 |
| `scratch_state` | 读 | 运行期快照：`running`/`threads`/`targets`/`clones`/`stepMs`/`fps`/标量页变量；带 `target` 时附坐标/大小/可见/局部变量 |
| `scratch_click` | 运行 | 点角色（按可见性→造型名筛克隆体，取包围盒中心）或点舞台坐标；`via` 说明走的是真 `pick` 还是退化的点击帽子 |
| `scratch_press_key` | 运行 | 按键（空格 `" "`、`"ArrowUp"`、字母 `"a"`），可按住 `holdMs` |
| `scratch_profile` | 读 | 采样 VM 每步耗时 → avg/p50/p95/max + 反推 fps（别信项目里的 `fps` 变量）；**默认带热点归因** `attribution.hot`（哪条脚本/哪些 opcode 在吃帧，空转单列 `waitPct`） |
| `scratch_screenshot` | 读 | 截编辑器窗口（CDP；180-208ms 量级）落盘给路径 —— 给用户看效果 / 自己核对画面 |
| `scratch_list_scripts` | 读 | 顶层脚本清单（opcode/块数/调用的自定义积木/名字），**区分真脚本与游离块**（判定用 `runtime._hats`） |
| `scratch_batch` | 读/运行 | 一次往返做多件事（≤12 条，白名单只放只读/运行期 op；写操作不许进来） |
| `scratch_selftest` | 读 | 全链路自检：桥监听 / 会话 / CDP 注入 / 项目就绪 / Blockly / 窗口可见 |
| `scratch_backpack` | 读写 | **积木背包**：list/read/save/delete。把做好的脚本子树（连同它引用的变量/列表的值）存进 `$DSH_HOME/scratch-backpack/`，自动维护 `INDEX.md`；删除进 `_trash/` 不真删 |
| `scratch_backpack_load` | 写 | 把背包里的一条注进项目（坐标整体平移、变量按名字接上或补建、`variableValues` 换内容）；受 `safety` 档位管 |

### scratch_open_editor：让 AI 自己去开编辑器

用户说「打开 TurboWarp」时，AI 不该只会说"请你自己去开"。这个工具：

- **`path`（新参数）**：传 `.sb3` / `.sb2` / `project.json` 的绝对路径，就顺手把作品装进去
  （等于用户手动拖文件进去）。**已经有会话时不重复开窗口**，直接把文件装进现有会话，
  返回值里给 `loaded`。
- `app=browser`（默认）：用**默认浏览器**打开 `turbowarp.org/editor`（也可传 `url` 打开指定作品），
  然后在 `waitMs`（默认 20000，上限 60000）内等会话连上，返回 `connected`。
  **这一条行为不变**——走的就是原来的扩展那条路。
  没连上时会把 token + 三步配置指引一起返回——AI 直接念给用户，用户填完**不用刷新**就会自己连上。
- `app=desktop`（**CDP 直连**，零安装、零 token）：启动本地 TurboWarp Desktop 并给它带一个空闲的
  `--remote-debugging-port`，再用 CDP 把同一份执行器注进编辑器页面的**默认执行上下文**
  （隔离上下文里没有 `window.vm`）。
  - 接上后**等编辑器里真有角色了才回报 `ready: true`**：桌面版冷启动是"GUI 先出来、项目后加载"，
    刚接上时 `targets` 可能是空的，直接回报就绪会害 AI 往不存在的角色里塞积木。
  - 返回值给 `ready` / `targets` / `editingTarget` / `target`（`tw-editor://…`）/ `launched.debugPort`。
  - **会先探固定调试端口**（默认 `31821`，配置项 `desktopDebugPort` 可改）：端口上有 CDP 端点就直接
    **接管那个现成的窗口**，不再新开一个。这就是「我开着作品，AI 帮我改」的正路 ——
    让用户用仓库根的 `启动TurboWarp(AI可接管).cmd` 开桌面版（它和双击原版的唯一区别就是多了
    `--remote-debugging-port=31821`），接管时返回值里 `launched.attached === true`、
    `launched.via === 'existing-debug-port'`、**没有 `pid` 字段**（不是它启动的），
    hint 会说明"没动他的窗口"。
- ⚠️ `app=desktop` 且桌面版**已经在运行、又没带调试端口**时（直接双击原版开的）接不进去
  （运行中的进程没法补启动参数）：如实返回 `alreadyRunning: true` 并说明原因，**三个办法**：
  1) 让用户**先存盘**、关掉桌面版，再调一次这个工具（它启动时会带调试端口）；
  2) 让用户以后改用仓库里的 `启动TurboWarp(AI可接管).cmd` 启动 —— 他自己开的窗口也能被接管；
  3) 传 `force: true` 让我接管 —— **会先关掉现有窗口，未保存的改动会丢**，务必先让用户存盘。
  不想动它就改用 `app: "browser"`。
- 桌面版已经在运行时也不会重复开：**先探固定端口**（能接管就接管），探不到才数进程
  （`tasklist`/`pgrep`）并返回 `alreadyRunning`——桌面版没有单实例锁，以前重复调会满屏窗口。
- 已经连着会话时直接返回 `alreadyConnected`，不会重复开标签页（想强制再开传 `force: true`）。
- 只接受 `http/https` 地址（防止被诱导去 `file://` 拉起本地程序）。
- 找桌面版：`config.desktopPath` → `$TURBOWARP_DESKTOP` → 常见安装目录 → **注册表卸载项**
  （装到自定义盘符时只有这条路认得出）。

> 桌面版是 Electron 应用、**装不了 Chrome 扩展**（它只有自己的 userscript addon 系统），
> 所以 desktop 这条路根本不走扩展 —— 它靠 CDP 把执行器注进页面，用户零安装、零 token。
> `project_meta` 现在也多返回一个 `editingTarget`（AI 写积木前得知道光标在哪个角色上）。

配置（`cordis.patch.yml` 的 `config`）：

| 键 | 作用 |
|---|---|
| `browserPath` | 指定用哪个浏览器打开（不填=系统默认；Windows 下也接受 `.cmd`/`.bat` 包装脚本） |
| `desktopPath` | 指定 TurboWarp Desktop 的 exe 路径（不填=自动找） |
| `desktopDebugPort` | `app=desktop` 时先探的固定调试端口（默认 `31821`）。端口上有 CDP 端点就**接管**那个窗口；改端口时记得同步改 `启动TurboWarp(AI可接管).cmd` |

## 安全三档（`cordis.patch.yml` 的 `safety`）

对**所有写工具**生效，不只是 `add_blocks`：

- `auto`：先快照，改动直接落工作区
- `preview`（默认）：不落盘，把 plan + `planId` 返给 AI 给用户看；用户点头后
  AI 调 `scratch_apply({planId})` 才落。plan 有 20 条上限、绑定会话，跨会话用会被拒
- `suggest`：只把改动当建议给用户，连 apply 都不提供

每次 `scratch_apply` 落盘**之前**都会自动快照，所以「改坏了 → 回滚」永远有后悔药。

## Skill 区（Scratch 实践经验库）

对社区高完成度作品**做法**的总结，10 篇经验文档：
`getting-started` / `code-patterns` / `animation-visual` / `architecture` /
`performance` / `sb3-json-reference` / `project-planning` / `recipes` /
`runtime-control`（跑起来再改）/ `backpack`（攒积木）。

> 这里**刻意不记**「哪个作品有多少积木」——数字对"怎么写"没有帮助。要量规模自己调
> `scratch_snapshot` 或 `lab/inspect-sb3.mjs`；文档只留能照着做的经验。

- **不强制注入**——工具返回只带一行 skillHint，agent 自主选读
- **三层开关**——`skillsEnabled` 总闸 → `.enabled.json` 单篇开关 → agent 自主
- **agent 可自编辑**——学到新经验就用 `scratch_skill_edit` 沉淀
- 首启复制到 `$DSH_HOME/scratch-skills/`，**升级默认不覆盖**用户改过的版本；
  想强制回到内置版：在 skill 目录里放一个 `.reset` 空文件，下次加载整份覆盖

## 背包（AI 自己维护的可复用积木库）

**skill 区存「怎么做」，背包存「做好的东西」。**

| 面 | 说明 |
|---|---|
| 存哪 | `$DSH_HOME/scratch-backpack/<名字>.json`（一条一个）+ 自动生成的 `INDEX.md` |
| 存什么 | 脚本子树（sb3 dict）+ 它引用的变量/列表**的值**（字模表跟着走；巨型列表按 `listLimit` 截断并标 `truncated`） |
| 怎么存 | `scratch_backpack({ action: "save", name, target, scriptIds, title, notes, tags })`（`all:true` 存整个角色）—— 走执行器 `export_blocks` |
| 怎么取 | `scratch_backpack_load({ name, target, x, y, variableValues })` —— 坐标整体平移（缺省 48,48），变量按名字**接上或补建** |
| 删除 | 挪进 `_trash/`（带时间戳），不真删 |
| 纪律 | **存之前问用户**（不做自动收集）；调了自定义积木却没存定义时导出会 `warnings` 提醒 |

实现上的两个坑（改之前先看这里）：

1. **导出不能用 `vm.toJSON()`**：TurboWarp 桌面版会把 block id 压缩成 `a`/`b`/`c`，
   真机直接报"这些 id 一个都没找到"。所以导出是执行器里自己写的 live→sb3 转换
   （`exportSubtreeLive`），正确性由 `lab/test-content-ops.js` 里**与官方序列化器逐块深比**守着。
2. **注入时必须落地变量引用**（`resolveRefs`）：有效 id 不动 / 同名换指向 / 都没有就补建。
   否则跨角色搬来的积木全是「变量未找到」，跑起来是空值。

## 文件

- `index.js` — 入口：桥 + 握手 + 30 工具 + 快照持久化 + skill 区 + 背包 + 桌面版启动
- `cdp.js` — **CDP 直连**：给桌面版带调试端口启动、注入执行器、`tagForPage()` 贴协议标签
- `vm-executor.js` — 扩展 `content-main.js` 的**逐字节副本**（CDP 注的就是它；
  改完扩展执行器跑 `node ../lab/sync-executor.mjs` 同步，`test-tools.mjs` 有一致性断言守着）
- `lib/client.js` — **浏览器半侧**（手写的 __ModuleLoader__ bundle：插件页里的配置表单）
- `win32-window.ps1` — 窗口可见性探针（EnumWindows + ShowWindow，Windows only）
- `skills/` — 内置 10 篇经验 + `INDEX.md`
- `cordis.patch.yml` — **组合包层**（`dsh.bundle.patch` 指向它，安装时自动插入 `scratch` 行）
- `test-skills.mjs` — skill 区单测（23 断言）
- `test-backpack.mjs` — **背包集成**（假页面连真桥：存→落盘→list/read→注入→preview→删除进 `_trash`，36 断言）
- `test-bridge-auth.mjs` — 桥的握手认证与应答来源校验（21 断言，别删）
- `test-tools.mjs` — 插件侧工具行为（唤起编辑器 / token 配置包 / 地址白名单 / 桌面版去重 /
  CDP 桌面分支的启动参数与诚实报错 / `tagForPage` 四连 / 执行器副本一致性 / 桥端口被占自愈 /
  返回值无损 JSON / 打包契约（组合包字段、volatile 配置、浏览器半侧格式、窗口探针）+
  v0.7.0 运行控制契约 + v0.8.0 背包与归因契约，107 断言）

## 测试状态（2026-10-18 本轮实测，VPN 全程关闭）

| 套件 | 结果 |
|---|---|
| `test-skills.mjs` | 23/23 ✅ |
| `test-bridge-auth.mjs` | 21/21 ✅ |
| `test-backpack.mjs` | 36/36 ✅ |
| `test-tools.mjs` | 107/107 ✅（含打包契约：组合包 / volatile 配置 / 浏览器半侧 / 窗口探针 + v0.7.0 运行控制 + v0.8.0 背包与归因契约） |
| `../lab/test-content-ops.js` | 163/163 ✅（含瘦身体积断言：5000 项列表场景 < 64KB） |
| `../lab/real-machine-check.mjs`（真 Chrome / Edge + 真 turbowarp.org；不传 `SB3_FIXTURE`） | 115/115 ✅（Chrome、Edge 各一遍） |
| `../lab/desktop-cdp-check.mjs`（TurboWarp Desktop + CDP；真开一个窗口、跑完自动关） | 99/99 ✅（含窗口可见性交叉验证 + 绿旗后角色真位移） |

真机那一轮跑的是完整闭环，**28 个工具全覆盖**：唤起编辑器（含"没有会话时给 token 步骤"这条路）
→ 装扩展 → 填 token → 打开 turbowarp.org/editor → 握手认证 → list_sessions → snapshot
→ add_blocks（preview→apply）→ 直接读真 VM 的活块模型校验 → update_block → locate（含滚动/高亮）
→ delete_blocks → 再快照查孤儿 → rollback → get_opcodes → tidy_blocks → add_costume
→ watch（真定时器轮询）→ user_context（真鼠标点块 + 绿旗）→ save_project（落盘 .sb3）
→ load_project（打开真实作品，14.6MB）→ 大项目往返 + 回滚 → 空闲 45s 连接不许断。

桌面版那一轮走的是 CDP（`../lab/desktop-cdp-check.mjs`，54 条）：启动桌面版 → 注入执行器 →
用**另一条独立 CDP 连接**直接读 `vm.runtime.targets[].blocks._blocks` 当证据（不读插件自己的返回值）
→ 存盘 → 从磁盘装回来验往返 → **接管用户自己开的实例**（验接管的是那个实例、没新开窗口、
没重复注册会话、收尾关干净）→ 关掉桌面版后会话必须自动掉线（不留僵尸会话）。
检测到用户已经开着 TurboWarp 时会 SKIP，不打扰。

⛔ **跑真机层之前先关 VPN**：开着时 turbowarp.org 会被解析成 fake-IP（私网段），
Chrome 会认为"本页也是本地"从而绕过 Local Network Access 检查 —— 那样跑出来的绿是**假绿**
（上一版的 98/98 就是这么来的）。脚本第 0 步会检测并直接判 FAIL。

详见 `../ROADMAP.md` 与 `../lab/README.md`（含验靶盲区清单）。
