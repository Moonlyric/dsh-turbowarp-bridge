# skill 区使用说明（agent 请先读这个）

> 本目录是「Scratch 实践经验库」：公开作品里常见**做法**的归纳 + 这批工具（scratch_*）的**契约** + 平台**陷阱**。
> 刻意不记"哪个作品多少块"这类数字 —— 对"怎么写"没有帮助。
> **没有强制要求**，全是参考；判断责任在你。但下面第 2 节的 9 条是**真实翻车记录**，读它们比读十篇教程省时间。

## 1. 按任务选读（别整目录乱翻）

| 你现在要做什么 | 先读 | 再查 |
|---|---|---|
| 第一次接手这个项目 / 不知道从哪下手 | **本篇第 3 节「30 秒套路」** | `scratch_project_overview` |
| 要写/改积木 | **injection-semantics.md**（add_blocks 契约） | sb3-json-reference.md |
| 要把表达式、条件、列表拼对 | **platform-traps.md**（输入名/1-based/空串） | code-patterns.md |
| 做游戏循环、克隆、弹幕、网格 | code-patterns.md + performance.md | platform-traps.md §4（warp） |
| 做 UI / 动画 / 转场 | animation-visual.md | architecture.md |
| **要画中文文字 / 界面文字 / 打字机效果** | **pen-text.md**（背包里现成的引擎） | backpack.md |
| **控件很多 / 要做编辑器** | **one-sprite-clones-ui.md**（一个角色 + 克隆体） | architecture.md |
| **要决定建几个角色 / 同一段代码两个角色都要用** | **sprite-split.md**（资产边界 / 复制 vs 广播 vs 不拆） | architecture.md |
| **开场卡 / 想要载入条 / 第一次冒出单位掉帧** | **boot-pipeline.md**（分批初始化 + 造型预热） | performance.md |
| **同屏几十个以上会动的东西** | **render-queue.md**（有序贴图池 + 平行列表实体） | performance.md |
| **伪 3D（走廊 / 赛车 / 俯瞰）** | **pen-3d.md**（相机基 → 投影 → 近平面裁剪） | platform-traps.md §4 |
| 项目 > 3 个角色或要长期改 | architecture.md | project-planning.md |
| 要验证"真的生效了" / 点了没反应 | runtime-control.md | platform-traps.md §0 |
| 用户没说清要什么 | project-planning.md | — |
| 刚啃下一件有难度的事 | backpack.md | — |
| **从零搭一个能跑的东西**（主循环 / 数据表 / 对象池 / UI / 寻路） | **proven-patterns.md** | performance.md |

## 2. 先别犯这 9 个错（都是真机上白干过的）

1. **把 `OPERAND1` 塞进 `operator_add`**。算术是 `NUM1/NUM2`，比较/逻辑才是 `OPERAND1/OPERAND2`。写错**不报错**，整个算式恒为 0 —— 曾把人带偏 8~10 轮。现在 `add_blocks` 会拦，但你自己先查更省事：`scratch_get_opcodes({ opcode })`。
2. **用 0-based 下标读列表**。Scratch 从 1 开始；越界静默返回 `""`。用 `variable get` / `state listSlice`（都按 1 起，越界会报错）。
3. **拿 `snapshot` 里的块 id 去操作**。那是 sb3 短 uid，和活块 id 完全不是一套。操作只用 `read_script` / `list_scripts` / `idMap` 的 id。
4. **以为 `add_blocks` 会帮你清理上次注入的块**。它不会（以前"会"的那版把作者积木一起删了）。游离块会一直留着，要清显式 `discardStale:true`。
5. **把 `procedures_definition` 当"游离垃圾"**。那是自定义积木定义，`calledBy` 是被调用次数；实测 32 个"游离块"其实是 141 处调用的引擎主干。
6. **在普通脚本里写 520 次循环**。一帧一次 ≈ 17 秒。重循环要进自定义积木 + `warp`。
7. **看到 `running:true` 就认为界面正常**。VM 在跑不代表界面没冻结（真机遇到过：绿旗点了没反应、截图两张字节相同，而所有自检全绿）。判断界面用 `scratch_selftest` 的**帧心跳**。
8. **读整段脚本来确认"我改对了"**。用 `scratch_inspect({ blockId })` 看上下文，用 `read_script({ blockId, branch, depth })` 只看一个分支。整段读 354 块 ≈ 100KB，还会被分页。
9. **以为两个角色能共享代码**。自定义积木只在**所属角色**内可见（A 调不到 B 的），局部变量同理。
   跨角色"共享"只有三条路：复制 / 广播并等待（参数走全局变量）/ 合并成一个角色。
   复制件的实测走样率是 **49%** —— 所以能合并就别拆，见 `sprite-split.md`。
   `lab/dissect.mjs` 会把跨角色同名自定义块连同走样数一起列出来。

## 3. 30 秒套路（读 → 改 → 验，固定三拍）

```
① 读结构：scratch_project_overview()                     # 每个角色多少块、有哪些自定义积木、谁调谁
② 读细节：scratch_read_script({ summary:true })           # 脚本清单（script/definition/loose 三档）
          scratch_read_script({ scriptId })               # 只读要改的那段
③ 改：    scratch_add_blocks / update_block / move_block # 写完看返回的 idMap / warnings / lost
④ 验结构：scratch_inspect({ blockId })                    # 位置对不对（parent/next/inputs/所属脚本）
⑤ 验运行：scratch_run({ action:"greenflag" }) → scratch_state({ listSlice })
          scratch_screenshot({ region:"stage" })           # 只看舞台
```

**每一步都别跳过 ④⑤**。这批工具最容易骗人的地方不是报错，而是"看起来改好了"。

## 4. 工具速查（38 个里最常用的 16 个）

| 目的 | 工具 |
|---|---|
| 开窗口 + 装作品 / 新建空白作品 | `open_editor({ app:"desktop", path })` / `new_project()` |
| 全项目结构 | `project_overview` |
| 脚本清单 / 读脚本 | `list_scripts` / `read_script` |
| 单块上下文 | `inspect` |
| 写 / 改 / 挪 / 删 | `add_blocks` / `update_block` / `move_block` / `delete_blocks` |
| 变量列表 | `variable`（get/set/create/delete/rename，1-based） |
| 运行 + 观测 | `run` / `state` / `profile` / `watch` |
| 输入 | `click`（带 pick 结果） / `press_key` |
| 画面 | `screenshot({ region })` / `selftest`（帧心跳） |
| 出问题 | `selftest` → `rollback` / `restart_window` |
| 查 opcode 与形状 | `get_opcodes({ opcode })` |

## 5. 十种写法（proven-patterns.md 的目录）

从几个商业级完成度的作品里读出来的同一套骨架，每条都具体到"用哪几个积木、什么顺序、参数放哪"：

| # | 写法 | 一句话 |
|---|---|---|
| 1 | 帧率无关的主循环 | 计时器算 `frameDt` → 夹上限 0.075 → 所有运动乘 dt。**先上这条，它决定别的怎么写** |
| 2 | 广播名「分类-动作」 | `init-` / `sync-` / `raise-` / `warm-`；加功能只加接收方，不改老代码 |
| 3 | `前缀-字段` 平行列表 | 一行一条记录；**删记录会让 id 错位**，要删就改成墓碑或走空闲索引 |
| 4 | 对象池 + 空闲索引 | 开场建一次、之后只设变量；从表尾取、**漏还不会报错**只是池慢慢空 |
| 5 | 逻辑全进 warp 自定义块 | 主循环 8 块，只调 `frame()`；warp 里禁止 forever/wait/broadcast-and-wait |
| 6 | 自己渲染文字 | 别自己写 —— **背包里「文字引擎」就是成品**，见 pen-text.md |
| 7 | 相机 | 实体只存世界坐标，只在渲染那一步减 camX/camY |
| 8 | 图搜索 | 邻接表 + 队列，出队**只挪头指针，绝不 delete 1** |
| 9 | 刷新分阶段 | 前置/本体/后置/渲染 四个广播，把"谁先算"变成显式约定 |
| 10 | 一个关注点一个角色 | `物体管理`/`碰撞箱`/`摄像头`/`触发区` 各管一件事，只通过列表和广播通信 |

补充六篇（都是整套架构，不是单点技巧）：

| 文档 | 一句话 |
|---|---|
| pen-text.md | 中文文字用背包里的「文字引擎」，别自己写（字形数据是几 MB 的工程量） |
| one-sprite-clones-ui.md | 一个角色 + 克隆体做整套界面：造型编号当类型、坐标区间命中、15 块积木的撤销栈 |
| render-queue.md | 各子系统只往一张有序「贴图池」里登记，最后一趟画完（固定 384 槽） |
| pen-3d.md | 相机基 9 项表 → 三次内积 → 一行透视 → **近平面裁剪** → 屏幕裁剪 |
| sprite-split.md | 角色是**资产**边界不是逻辑边界；跨角色共享代码三条路，实测复制件 49% 已经不一致 |
| boot-pipeline.md | 一个角色一个 `init-` 广播逐帧初始化；载入期把造型按档位预热一遍（图章+清空） |

## 6. 维护

- 你可以新建/修改/删除本目录的 md 文件（`scratch_skill_edit`）。学到新经验（尤其"被用户纠正的做法"）就写进来。
- 文件开头保持「# 标题 + > 适用场景」，方便后来的 agent 选读。
- 插件升级时内置文档会**覆盖**同名文件；旧版本会备份到 `.backup-v<旧版本>/`，你自己加的（不同名的）文件不受影响。
