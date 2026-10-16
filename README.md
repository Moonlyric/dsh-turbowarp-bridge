# dsh-turbowarp-bridge

让 **DeepSeek Harness（dsh）里的 AI 直接读写你的 Scratch / TurboWarp 项目** ——
不是生成一个 sb3 丢给你，而是**在你正开着的编辑器里**加积木、改参数、删脚本、整理排版、定位高亮，
你实时看着它动手，不满意一句"回滚"就回到上一步。

```
dsh 插件（Node，19 个 scratch_* 工具 + WebSocket 桥 :31820）
      ↕ JSON-RPC over ws（握手 token）
浏览器扩展 MV3：service worker 持 socket + 内容脚本（MAIN world 操作 window.vm）
      ↕
TurboWarp 编辑器（你在屏幕上看到的一切）
```

## 它能干什么

| 能力 | 工具 |
|---|---|
| 读项目 | `scratch_snapshot`（整份 project.json）、`scratch_read_script`（按角色读，省 token） |
| 写积木 | `scratch_add_blocks`（走官方 `shareBlocksToTarget` 管线，字面量自动展开成影子块） |
| 改 / 删 | `scratch_update_block`、`scratch_delete_blocks`（级联）、`scratch_tidy_blocks`（排版） |
| 找得到 | `scratch_locate`（滚到那块并高亮）、`scratch_get_opcodes`（白名单，防 AI 编造积木） |
| 造型 | `scratch_add_costume`（SVG → 角色造型） |
| 文件 | `scratch_load_project`（打开本机 .sb3）、`scratch_save_project`（存回磁盘，默认不覆盖） |
| 观察 | `scratch_watch`（变量轨迹）、`scratch_user_context`（你选中了哪块、有没有按绿旗） |
| 唤起 | `scratch_open_editor`（AI 自己把编辑器打开，不用你点） |
| 经验库 | `scratch_skills` / `scratch_skill_edit`（可读可写的 Scratch 实践经验，AI 自己积累） |

**三档安全**（默认 `preview`）：写操作先返回一个 `planId` + 预览，你说"行"才落盘；
每次写操作前自动快照（内存 + 磁盘），随时 `scratch_rollback`。

## 装

> 需要 dsh（DeepSeek Harness）、Chrome / Edge、以及一个能访问 turbowarp.org 的网络。

### 1. 浏览器扩展（约 1 分钟）

1. `chrome://extensions` → 右上角开**开发者模式**
2. 「加载已解压的扩展程序」→ 选 `packages/tw-bridge-extension`
3. 卡片上「详细信息 → 扩展程序选项」，把**桥 token** 粘进去保存

### 2. dsh 插件

把 `packages/dsh-plugin-scratch` 复制到你的 dsh profile 下：

```
%APPDATA%\dsh-desktop\harness\profiles\local-plugins\dsh-plugin-scratch
```

并建一个同名包链接（这样设置页里显示的是插件名，而不是 `index.js`）：

```powershell
New-Item -ItemType Junction `
  -Path "$env:APPDATA\dsh-desktop\harness\profiles\node_modules\dsh-plugin-scratch" `
  -Target "$env:APPDATA\dsh-desktop\harness\profiles\local-plugins\dsh-plugin-scratch"
```

然后在 `profiles\desktop\cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: scratch
      name: dsh-plugin-scratch
      config:
        safety: preview
        bridgePort: 31820
        skillsEnabled: true
```

重启 dsh。`ws` 和 `@deepseek-ai/dsh-tools` 会从 `profiles/node_modules` 向上解析，不用自己 `npm install`。

### 3. token 从哪来

对 dsh 里的 AI 说一句「打开 TurboWarp」——它会调 `scratch_open_editor` 帮你开好编辑器，
并把 token 和三步指引一起念给你；也可以直接看 `$DSH_HOME/scratch-bridge-token.txt`。

> 为什么要 token：桥监听 `127.0.0.1:31820`，而 WebSocket 不受同源策略约束 ——
> 本机任意进程/页面都能连它。没有握手认证的话，对面可以冒充编辑器、伪造工具返回值，
> 甚至把文字塞进 AI 的上下文。token 只在本机、只填一次。

## 两个值得知道的技术坑

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

## 验靶（能自己复跑的自动化）

```powershell
# 替身层：真 content-main.js 进 Node vm + 真 headless scratch-vm（112 条）
cd lab; node test-content-ops.js

# 真机层：真 Chrome + 真 turbowarp.org + 真扩展（122 条，约 4 分钟）
# ⚠️ 跑之前先关 VPN，否则是假绿
$env:SB3_FIXTURE='<某个 .sb3>'      # 可选：顺带验打开真实作品
node real-machine-check.mjs

# 插件侧
cd ..\packages\dsh-plugin-scratch
node test-tools.mjs; node test-skills.mjs; node test-bridge-auth.mjs
```

其它：`node lab/inspect-sb3.mjs <文件.sb3>` 离线看一个作品的结构（角色/块数/扩展/变量/广播/自定义块）。

## 目录

```
packages/dsh-plugin-scratch/   dsh 插件：桥服务端 + 19 个工具 + 经验库 + 单测
packages/tw-bridge-extension/  MV3 扩展：SW 持 socket，内容脚本操作 window.vm
lab/                           验靶：替身 VM 层 + 真机层 + sb3 离线分析
ROADMAP.md                     里程碑、设计决策、修过的真 bug
验收清单.md                     装完之后人眼该验什么（机器验不了的部分）
```

## 授权

MIT（见 [LICENSE](LICENSE)）。TurboWarp / Scratch 是各自所有者的项目，本仓库只是它们的客户端。

> 仓库里的「经验库」（`packages/dsh-plugin-scratch/skills/*.md`）是对社区公开作品**做法**的总结，
> 只有文字经验，不含任何他人作品文件或资源。
