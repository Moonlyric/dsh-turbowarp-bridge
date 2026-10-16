# skill 区使用说明（agent 请先读这个）

> 本目录是「Scratch 实践经验库」——来自 10 个社区高完成度作品的逆向分析（2026-10）。
> **没有强制要求**，全部是经验参考。你按需选读，判断责任在你。

## skill 文件一览

| 文件 | 什么时候读 | 一句话 |
|---|---|---|
| getting-started.md | 第一次在项目上干活前 | Scratch 思维方式 + AI 五大常见错误 |
| code-patterns.md | 写游戏/交互逻辑时 | 社区惯用法：缓动/列表结构体/数据驱动弹幕/广播总线 |
| animation-visual.md | 做 UI/动画/转场时 | 造型帧纪律 + pen 技法 + 「不幼儿化」自查表 |
| architecture.md | 项目 > 3 角色或要长期改时 | 按规模选架构 + 反面教材清单 |
| performance.md | 有克隆/弹幕/pen 时必读 | 宿主差异（TW 无克隆上限 vs 原版 sc 300 硬限）+ 性能七律 |
| sb3-json-reference.md | 写 add_blocks/update_block 前查 | inputs 数组编码字典 + 高频 opcode 表 |
| project-planning.md | 用户没说清要什么时 | 体裁谱 + 5 问 + 起手模板 |
| recipes.md | 不确定「正确姿势」时 | 8 个可直接抄的完整脚本 |

## 使用纪律（仅有的三条软约束）

1. **写积木前**扫一眼 sb3-json-reference.md 的 inputs 编码（[1,[4,"10"]] 这种格式最容易翻车）
2. **不确定 opcode 存不存在**：调 scratch_get_opcodes 查实时白名单，别猜
3. **这些是社区经验不是真理**：学生作品里也有坏味道（architecture.md 的反面教材节专门标了哪些别学）。你自己的判断优先

## 维护

- 你（agent）可以新建/修改/删除本目录的 md 文件（scratch_skill_edit 工具）
- 学到新经验（比如用户纠正了你的做法）→ 写进对应文件或开新文件
- 文件开头保持「适用场景 + 一句话」的格式，方便后来的 agent 选读
- 用户可以整体开关 skill 功能（不影响 scratch_* 工具本身）
