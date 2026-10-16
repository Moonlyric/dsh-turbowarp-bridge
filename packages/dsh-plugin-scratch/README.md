# dsh-plugin-scratch — TurboWarp 桥插件（v0.3.0 · M2 + Skill 区）

DSH（DeepSeek Harness）插件：把 TurboWarp 编辑器接入 agent。
AI 通过 `scratch_*` 工具读取/修改 Scratch 项目，用户在 TurboWarp 界面里**实时**看到变化。

架构：

```
本插件（Node）= WebSocket 服务端（桥 :31820） + 16 个 scratch_* 工具 + Skill 经验库
        ↕ JSON-RPC over ws
浏览器扩展 tw-bridge-extension = 桥客户端 + turbowarp.org 页面 MAIN world 里的 window.vm 执行器
        ↕ window.vm
TurboWarp 编辑器（用户实时看到一切）
```

## 装到 dsh（DSH Desktop）

1. 把 `packages/dsh-plugin-scratch` 这个文件夹整个放到 dsh 的 profile 目录下
   （必须位于 `...\harness\profiles\` 之下一层，否则它上溯不到 `profiles\node_modules`，
   `@deepseek-ai/*` 解析会失败）。参考路径：
   `%APPDATA%\dsh-desktop\harness\profiles\local-plugins\dsh-plugin-scratch`
2. 在该目录执行 `npm install`（装 `ws` + `@deepseek-ai/dsh-tools`）
3. 在该目录建 `cordis.patch.yml`（内容见本包自带的那份），确认 `name:` 指向插件入口
4. 重启 DSH Desktop。终端/日志里出现 `TurboWarp bridge plugin loaded` 即加载成功

`name` 的三种写法（dsh 0.1.2-rc.1 实测）：

| 写法 | 例子 | 说明 |
|---|---|---|
| 包名 | `dsh-plugin-scratch` | 从 profile 目录做 ESM 解析（需已装进 profile） |
| 相对路径 | `../local-plugins/dsh-plugin-scratch/index.js` | **相对补丁文件自己所在的目录** |
| file:// URL | `file:///C:/path/to/index.js` | 绝对路径 |

⚠️ 裸 Windows 路径（`G:\...\index.js`）不被支持，会被当成 `g:` 协议。

DSH Desktop 内部固定用自己的单个 `--patch`，所以用户侧没有 `--patch` 这个口子——
走 profile 目录 + `cordis.patch.yml` 是 Desktop 上的正路。

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

## 工具清单（17 个）

| 工具 | 方向 | 说明 |
|---|---|---|
| `scratch_list_sessions` | 读 | 已连接的 TW 编辑器标签页；无会话时返回 token + 配置步骤 |
| `scratch_open_editor` | 启动 | **主动帮用户打开编辑器**（浏览器 / 本地桌面版），并等会话连上 |
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
| `scratch_watch` | 读 | 变量订阅（start/poll/stop，Stage + 角色两层） |
| `scratch_user_context` | 读 | 用户最近动作（选块 / 绿旗 / 运行态）+ 当前选中块 |
| `scratch_skills` | 读 | 经验库 list / read / toggle |
| `scratch_skill_edit` | 写 | 经验库 create / update / append / delete |

### scratch_open_editor：让 AI 自己去开编辑器

用户说「打开 TurboWarp」时，AI 不该只会说"请你自己去开"。这个工具：

- `app=browser`（默认）：用**默认浏览器**打开 `turbowarp.org/editor`（也可传 `url` 打开指定作品），
  然后在 `waitMs`（默认 20s）内等桥连上，返回 `connected` 结论。
  没连上时会把 token + 三步配置指引一起返回——AI 直接念给用户，用户填完**不用刷新**就会自己连上。
- `app=desktop`：启动本地 TurboWarp Desktop。
  **已经在运行就不会重复开**（用 `tasklist`/`pgrep` 数进程，重复调只会返回 `alreadyRunning`；
  桌面版没有单实例锁，以前重复调会满屏窗口）——想强制再开传 `force: true`。
  ⚠️ **桌面版装不了浏览器扩展**（实测它的 app.asar 里没有任何 `session.loadExtension`，
  只有自己的 userscript addon 系统），所以**桥驱动不了它**——返回值里 `bridgeCanDrive: false`
  会明说，不会假装连上。桌面版要接 AI，得等 userscript 版桥（M3）。
- 已经连着会话时直接返回 `alreadyConnected`，不会重复开标签页（想强制再开传 `force: true`）。
- 只接受 `http/https` 地址（防止被诱导去 `file://` 拉起本地程序）。
- 找桌面版：`config.desktopPath` → `$TURBOWARP_DESKTOP` → 常见安装目录 → **注册表卸载项**
  （装到自定义盘符时只有这条路认得出）。

配置（`cordis.patch.yml` 的 `config`）：

| 键 | 作用 |
|---|---|
| `browserPath` | 指定用哪个浏览器打开（不填=系统默认；Windows 下也接受 `.cmd`/`.bat` 包装脚本） |
| `desktopPath` | 指定 TurboWarp Desktop 的 exe 路径（不填=自动找） |

## 安全三档（`cordis.patch.yml` 的 `safety`）

对**所有写工具**生效，不只是 `add_blocks`：

- `auto`：先快照，改动直接落工作区
- `preview`（默认）：不落盘，把 plan + `planId` 返给 AI 给用户看；用户点头后
  AI 调 `scratch_apply({planId})` 才落。plan 有 20 条上限、绑定会话，跨会话用会被拒
- `suggest`：只把改动当建议给用户，连 apply 都不提供

每次 `scratch_apply` 落盘**之前**都会自动快照，所以「改坏了 → 回滚」永远有后悔药。

## Skill 区（Scratch 实践经验库）

基于 10 个社区高完成度作品（15 块 ~ 10164 块）逆向提炼，8 篇经验文档：
`getting-started` / `code-patterns` / `animation-visual` / `architecture` /
`performance` / `sb3-json-reference` / `project-planning` / `recipes`。

- **不强制注入**——工具返回只带一行 skillHint，agent 自主选读
- **三层开关**——`skillsEnabled` 总闸 → `.enabled.json` 单篇开关 → agent 自主
- **agent 可自编辑**——学到新经验就用 `scratch_skill_edit` 沉淀
- 首启复制到 `$DSH_HOME/scratch-skills/`，升级不覆盖用户改过的

## 文件

- `index.js` — 入口：桥 + 握手 + 17 工具 + 快照持久化 + skill 区
- `skills/` — 内置 8 篇经验 + `INDEX.md`
- `cordis.patch.yml` — dsh 插件层（`name` 三种写法见注释）
- `test-skills.mjs` — skill 区单测（23 断言）
- `test-bridge-auth.mjs` — 桥的握手认证与应答来源校验（21 断言，别删）
- `test-tools.mjs` — 插件侧工具行为（唤起编辑器 / token 配置包 / 地址白名单 / 桌面版去重，27 断言）

## 测试状态（2026-10-16）

| 套件 | 结果 |
|---|---|
| `test-skills.mjs` | 23/23 ✅ |
| `test-bridge-auth.mjs` | 21/21 ✅ |
| `test-tools.mjs` | 27/27 ✅ |
| `../lab/test-content-ops.js` | 97/97 ✅ |
| `../lab/real-machine-check.mjs`（真 Chrome + 真 turbowarp.org） | 98/98 ✅ |

真机那一轮跑的是完整闭环，**17 个工具全覆盖**：唤起编辑器（含"没有会话时给 token 步骤"这条路）
→ 装扩展 → 填 token → 打开 turbowarp.org/editor → 握手认证 → list_sessions → snapshot
→ add_blocks（preview→apply）→ 直接读真 VM 的活块模型校验 → update_block → locate（含滚动/高亮）
→ delete_blocks → 再快照查孤儿 → rollback → get_opcodes → tidy_blocks → add_costume
→ watch（真定时器轮询）→ user_context（真鼠标点块 + 绿旗）→ 已有会话时不重复开标签页。

详见 `../ROADMAP.md` 与 `../lab/README.md`（含验靶盲区清单）。
