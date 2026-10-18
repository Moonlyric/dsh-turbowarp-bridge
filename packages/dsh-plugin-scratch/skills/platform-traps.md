# Scratch 平台陷阱速查（写积木前必读）

> 适用场景：准备从零写积木 / 拼表达式 / 用列表做网格 / 写重循环 / 做自动化验证之前。
> 这一篇里的每一条都**不会报错**，只会让程序"在跑但没效果"。实测代价：H1 + H2 叠加时查了 4 轮、写了 4 个探针脚本。

## 0. 三条铁律

1. **Scratch 不抛异常**。下标越界、类型不对、变量不存在，全部静默变成 `""` 或 `0`。所以"没反应"永远先怀疑值不对，不要先怀疑引擎。
2. **每个 value 输入都必须有东西**。空槽参与运算按 0/空串算；少写一个输入不会报错，只会让整个表达式退化成 0。
3. **写完必须自己验**：用 `scratch_inspect` 看结构、用 `scratch_state({ listSlice })` 看值、用 `scratch_run` + 再读一次看有没有动。别靠"应该对吧"。

## 1. 列表下标从 1 开始（最容易翻车）

- `第 1 项` 才是第一个元素；`第 0 项`、负数、超长 → 返回 `""`，**不报错**；`替换第 0 项` 是 no-op。
- 跨语言比对时最险：Python/JS 里 `board[327]` 对应 Scratch 的**第 328 项**。
- 插件这边已经按 1-based 给值：`scratch_variable({ action:"get", kind:"list", index })`、`scratch_state({ listSlice:{ from } })` 都是 1 起，越界会**直接报错**（帮你把静默变成显式）。
- 写循环时的常用安全写法：`如果 <(i) > (0) 且 (i) <= (长度)>` 再取项，或者先 `如果 <(i) < 1>` 就 `设 i 为 1`。

## 2. 空串和 undefined 都算 0

- `"" + 1` → `1`；`undefined + 1` → `NaN` → `Cast.toNumber` → **`0`**。
- 所以"变量永远是 0"通常意味着**变量根本没读到**（变量 id 不对 / 拼错名字 / 引用了别的角色的局部变量），而不是算术写错。
- 反之 `"" = 0` 在 Scratch 里**成立**（字符串比数字会尝试转数字）。变量初值是 `""`，所以"如果 变量 = 0"在未初始化时也成立 —— 不能拿它判断"脚本跑过了"。

## 3. 不同 opcode 的输入名完全不一样（写错静默丢）

| 积木 | 输入名 |
|---|---|
| `operator_add/subtract/multiply/divide/mod` | `NUM1` / `NUM2` |
| `operator_random` | `FROM` / `TO` |
| `operator_gt/lt/equals` | `OPERAND1` / `OPERAND2` |
| `operator_and/or` | `OPERAND1` / `OPERAND2` |
| `operator_not` | `OPERAND` |
| `operator_join/contains` | `STRING1` / `STRING2` |
| `operator_letter_of` | `LETTER` / `STRING` |
| `operator_length` | `STRING` |
| `operator_round` / `operator_mathop` | `NUM`（mathop 另有字段 `OPERATOR`） |
| `control_if` / `control_if_else` | `CONDITION` + `SUBSTACK`（else 多一个 `SUBSTACK2`） |
| `control_repeat` | `TIMES` + `SUBSTACK` |
| `control_repeat_until` / `control_while` | `CONDITION` + `SUBSTACK` |
| `control_for_each` | `VALUE` + `SUBSTACK`，字段 `VARIABLE` |
| `data_setvariableto` / `data_changevariableby` | `VALUE`，字段 `VARIABLE` |
| `data_addtolist` / `data_insertatlist` / `data_replaceitemoflist` | `ITEM`（+ `INDEX`），字段 `LIST` |
| `looks_say` / `looks_think` | `MESSAGE` |

记不住就查：`scratch_get_opcodes({ opcode:"operator_add" })` → 直接给 `inputs` / `fields`。
`scratch_add_blocks` 现在会**替你校验**：输入名/字段名不对会当场报错，并列出正确的名字（不再静默丢弃）。

## 4. 不 warp 的循环，一帧只走一次

- 普通脚本里的 `重复 520 次` = 520 帧 ≈ **17 秒**。
- 重循环必须放进**自定义积木**并勾"运行时不刷新屏幕"：
  `procedures_prototype.mutation.warp = "true"`，**调用块的 mutation 也要带 `warp`**。
- 症状：`stepMs` 一直是 33.3（帧率正常），但计数器半天才走一格。
- 现在 `scratch_state` 会给 `stepMs`，`scratch_profile` 会给 `frameCapMs` —— 顶到帧帽时它就明说"看不出余量"，别再拿它当"跑满了"。

## 5. 角色属性 / 画笔的边界

- 隐藏的角色照样能落笔（`pen_*` 与 `visible` 无关），所以"隐形画笔"是正常用法。
- 但 `图章` 对隐藏角色**不生效**。
- `图章`/落笔都在舞台上留下像素，和角色坐标的换算：舞台中心 (0,0)，x ∈ [-240,240]，y ∈ [-180,180]。

## 6. 「按键帽子」的键名 ≠ DOM 键名

| 积木字段 | DOM 事件 |
|---|---|
| `space` | `" "` |
| `left arrow` / `right arrow` / `up arrow` / `down arrow` | `ArrowLeft` / `ArrowRight` / `ArrowUp` / `ArrowDown` |
| `a`…`z` | `a`…`z` |

注入时写 `event_whenkeypressed` 的 `KEY_OPTION: ["space","space"]`；`scratch_press_key` 传的是 **DOM 键名**（`" "`、`"ArrowLeft"`）。两者别混。

## 7. 变量作用域：自动补建的是**角色私有**

- `scratch_add_blocks` 补建变量时挂在**当前角色**上（`refs.created.on === "target"`），不是舞台全局。
- 单角色项目无所谓；多角色共用状态必须显式 `scratch_variable({ action:"create", scope:"global" })`。
- 同名不同作用域会同时在：`data_variable` 的 `field.id` 才是真身，名字只是显示。

## 8. 存档/重开带着上次的值

- `save_project` 会把变量/列表的**当前值**写进 sb3；重开工程时不是空的。
- `绿旗` 也**不会重置任何变量** —— 初始化要自己写（`删除…的全部项` / `设…为 0`）。
- 调试新逻辑时：要么先手动清零，要么认准"刚 reload 的值一律当陈旧值"。`scratch_state` 的 `pageListDelta` 能帮你分辨"是我改的还是残留的"。

## 9. 数字可能是 int 也可能是 float

`[1]` 和 `[1.0]` Scratch 都吃。自己解析 sb3 做比对时两边都 `float()` 再比，顺便把 `""` 归一成 0。

## 10. 手写最小 sb3 的硬性要求（现在不用手写了）

用 `scratch_new_project` 就行。但如果你一定要生成 sb3：

- zip 里必须有 `project.json`；造型/声音是**独立文件**，文件名 `md5(内容).svg`；
- `assetId` / `md5ext` 必须和文件名一致；
- `rotationCenterX/Y` 是**旋转中心**，不是宽高；
- 舞台 `layerOrder = 0`，角色从 1 递增；`meta.semver = "3.0.0"`；
- 变量/列表的 id 必须和块里引用的一致，否则走第 2 条的静默路（读回 `undefined`）。

## 11. 一句话对照表

| 你可能以为 | 实际 |
|---|---|
| 下标从 0 开始 | **从 1 开始**，越界返回 `""` |
| 越界会抛异常 | 静默返回 `""` / 静默不写入 |
| `"" + 1` 会报错 | `"" + 1 = 1`，`undefined + 1 = 0` |
| 变量默认 0 | 默认 `""`，而且 `"" = 0` 为真 |
| 循环很快 | 不 warp 的循环一帧一次 |
| 重开工程是空的 | 变量/列表带着上次的值 |
