# Scratch 思维方式：从「写代码」到「搭积木」

> 适用场景：第一次接触 Scratch 项目的 AI。写任何积木之前先读这篇。
> 来源：对社区高完成度作品**做法**的总结（2026-10）。这里不列作品目录、不记谁有多少积木——
> 只写"怎么做"，因为那才是能直接用的东西。

## Scratch 不是 Python，先切换脑回路

你如果在想「定义一个类、循环数组、异步等待」，先停一下。Scratch 的运行模型：

1. **每个脚本是一根独立的线**（thread）。`当绿旗被点击`、`当接收到 [广播]`、`当按下 [键]`、`当角色被点击`、`当作为克隆体启动时`——每个帽子（hat）块都是并发入口，点击绿旗后它们**同时**跑。
2. **广播（broadcast）是事件总线**，不是函数调用。`广播 [x]` 默认不等接收方（`广播并等待` 才等）。社区作品普遍用广播做模块间解耦：大项目里广播几十个很正常，命名如 `Start Game` / `__ PL Inv` / `Blackout End`（转场黑幕的开始与结束）。
3. **变量分全局（Stage）和局部（角色）两层**。全局变量所有角色可见，局部变量只有本角色及其克隆体可见。
4. **没有 return**。自定义积木（procedures）通过「设置变量」传结果，社区惯用 `^return:...` 前缀命名（`^` 开头一眼看出是函数出参）。
5. **等待是让出 CPU**：`等待 0.05 秒` 不只是暂停，它让其它脚本有机会跑。`重复执行` 不带等待会吃满一个核并让 UI 卡死——**裸 forever 循环里必须有 wait 或重复 n 次的退出**，这是新手第一杀手。

## AI 最容易犯的 5 个错（按出现频率）

1. **把传统代码直译成积木**：想 `for i in range(10)` 就搭 10 个串行块。应该用 `重复 10 次 { ... }`（control_repeat）。
2. **编造不存在的积木**：先调 `scratch_get_opcodes` 查白名单（130+ 个 opcode 是全部家当，没有 `try/catch`、没有 `break`、没有字符串 split——但 `字符 x of 字符串` 可以拼出 split）。
3. **忽略坐标系**：舞台中心是 (0,0)，x ∈ [-240,240]，y ∈ [-180,180]。造型旋转中心默认 (48,50) 不是几何中心。
4. **一次性大脚本**：一个绿旗脚本塞 50 块。社区做法是拆成自定义积木（大项目里几十上百个 procedure 很常见），主脚本只留调度。
5. **状态放太散**：同一件事的状态散在 10 个变量里。社区用**列表当结构体**：`graph.point`、`graph.link`、`graph.chosen_point`——同前缀 = 同结构域。

## 什么时候该用哪种入口（hat）

| hat | 用在 | 社区案例 |
|---|---|---|
| `event_whenflagclicked` | 初始化 + 主循环 | 每个角色 1-3 个 |
| `event_whenbroadcastreceived` | 模块间通信 | RPG 用 21-47 个广播 |
| `event_whenkeypressed` | 输入 | 动作游戏 3-10 个键 |
| `control_start_as_clone` | 弹幕/粒子生成体 | 数据驱动生成必用 |
| `event_whenthisspriteclicked` | 按钮 | UI 按钮（配造型切换） |

## 检查清单（写完积木自查）

- [ ] 每个含 `重复执行` 的链里有 `等待` 或明确退出
- [ ] 用到的变量都初始化过（绿旗重开要能复位）
- [ ] 克隆体里有 `删除此克隆体`（control_delete_this_clone）——TW 虽无 300 硬限（原版 sc 有），但泄漏的克隆照样拖死内存和帧率
- [ ] 广播名有语义（`Start Drawing` ✅，`消息1` ❌）
- [ ] 大段逻辑包成了自定义积木，主脚本一眼看懂

## 现在的最短路径（v0.10.0 的工具版）

以前"先 snapshot 摸清项目"是唯一办法，现在有更省的两步：

```
scratch_project_overview()                       // 一次看清：每角色块数/opcode 直方图/自定义积木/脚本一行摘要
scratch_read_script({ summary: true })           // 要看某个角色：脚本清单（script / definition / loose 三档）
scratch_read_script({ scriptId })                // 只读要改的那段
```

写之前查形状：`scratch_get_opcodes({ opcode: "operator_add" })` → 直接给输入名/字段名。
写完验结构：`scratch_inspect({ blockId })`（parent / next / 每个输入接了啥 / 属于哪条脚本），
别整段重读 —— 354 块的脚本 ≈ 100KB，还会分页。

从零开始：`scratch_open_editor({ app: "desktop", blank: true })` 或 `scratch_new_project()`
（插件现造一份标准 sb3：舞台 + 一个角色，各带造型）。改角色名用 `scratch_target({ action:"rename" })`。

