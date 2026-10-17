# 把项目「跑起来」再改：运行控制 + 状态 + 截图闭环

> 适用场景：要验证一个改动到底有没有生效、要复现一个 bug、要量性能、
> 或者用户说「点了没反应 / 我看不到效果」。**光读积木 JSON 判断不了运行期行为。**

## 一句话

`scratch_run` 点绿旗 → `scratch_state` 看有没有真在跑 → `scratch_screenshot` 把画面给用户 →
改 → 再跑一遍对比。这一圈以前要 AI 自己连裸 CDP 写脚本，现在都是现成工具。

## 工具怎么用

| 工具 | 干什么 | 典型调用 |
|---|---|---|
| `scratch_run` | 绿旗 / 停止全部 / 起停 VM 循环 | `{ action: "greenflag", waitMs: 600 }` |
| `scratch_state` | 只读运行时快照：running、线程数、克隆体分布、stepMs/fps、舞台标量变量 | `{ target: "角色名" }`（顺带报坐标/大小/可见） |
| `scratch_click` | 点舞台：给角色名（按造型包围盒中心）或给舞台坐标 | `{ target: "开始按钮" }` |
| `scratch_press_key` | 按键（空格 `" "`、方向键 `"ArrowUp"`、字母 `"a"`） | `{ key: "ArrowRight", holdMs: 120 }` |
| `scratch_profile` | 采样 VM 每步耗时 → avg/p50/p95/max + fps | `{ seconds: 3 }` |
| `scratch_screenshot` | 截编辑器窗口（PNG，落盘给路径） | 桌面版 CDP 会话才可用 |
| `scratch_batch` | 一次往返做多件事（只读/运行期 op） | `{ calls: [{op:"state"},{op:"screenshot"}] }` |
| `scratch_selftest` | 全链路自检：桥/会话/注入/项目/Blockly/窗口 | 用户说"连不上/没反应"时先跑它 |

## 五条实战教训

1. **`running: true` 不代表你改的那段脚本跑了。** 绿旗之后至少读一次**会变的量**
   （坐标、变量、克隆数）。`scratch_run` 会返回动作前后的线程数，但更硬的证据是
   `scratch_state({target})` 里那个角色的 `x/y` 真的动了。
2. **别信项目里的 fps 变量。** 它经常是存档残留值（`!fps=824` 这种）。要性能用
   `scratch_profile` —— 它读的是 VM 自己的步进耗时。
3. **点了没反应时，先分清是"没点到"还是"脚本没接"。** `scratch_click` 的返回里
   `via` 说明走的哪条路（`pick` = 真鼠标命中；`hat-fallback` = 直接启动点击帽子），
   `hatsStarted` 是这次点出来的线程数。两个都是 0 → 这个角色根本没有「当角色被点击」脚本。
4. **克隆体只认造型名分不清。** `scratch_click({target, costume})` 会先按可见性筛、再按造型名筛；
   `scratch_state` 的 `clones` 报的是每个角色有几份克隆。
5. **停止用 `stopall`（红按钮），不是 `stoploop`。** 后者停的是 VM 的帧循环，
   用户那边看起来像"卡住了但灯还亮着"。

## 读积木的姿势（省上下文）

- 先 `scratch_read_script({ summary: true })`：只回结构（每条脚本的 blockId/opcode/块数），
  几百字节就能看清一个 4000 块的角色。
- 要看某段脚本的块体：`scratch_read_script({ scriptId })`，只回那一坨。
- 找某类积木：`read_script({ opcodes: ["event_whenflagclicked"] })`。
- 默认**不回变量**（长列表能把一次调用撑到 7.5MB）。要值用 `scratch_state`（标量）或
  `scratch_watch`（轨迹）。
- `scratch_list_scripts` 会区分**真脚本**（帽子块打头）和**游离块**（作者调试拖出来的孤立块）。
  某角色"185 个顶层块"里通常 150 个是游离块 —— 按块数排名前先过掉它们。

## 什么时候用 `scratch_batch`

同一个判断需要 ≥3 次调用时（典型：切角色 + 定位 + 读状态 + 截图）。它一次往返做完，
总耗时从「N × 工具往返」降到几百毫秒。**写操作不能进批处理**（白名单挡着），
那是有意的：写要走 preview/apply 的确认。
