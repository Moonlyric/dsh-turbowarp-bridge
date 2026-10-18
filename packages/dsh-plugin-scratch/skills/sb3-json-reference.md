# sb3 积木 JSON 速查（AI 写块时的字典）

> 适用场景：调 scratch_add_blocks / scratch_update_block 前查格式。
> 这是协议层参考，配合 scratch_get_opcodes（实时白名单）用。

## 块对象完整字段

```json
{
  "opcode": "motion_movesteps",
  "next": "下一个块的id或null",
  "parent": "父块id或null",
  "inputs": { "STEPS": [1, [4, "10"]] },
  "fields": {},
  "shadow": false,
  "topLevel": true,
  "x": 60, "y": 60
}
```

- `topLevel: true` 才有坐标；子块（挂在别人输入/next 上的）无坐标
- `shadow: true` 是输入框里的空壳值块，AI 造的实块一律 false
- `next`/`parent` 双向链：串行脚本用 next，嵌套用 parent+input 名

## inputs 数组编码（重点，最容易错）

`"INPUT_NAME": [影子状态, 值]`，挂了块且下面还有影子时是 `[3, 块id, 影子]`。

| 第 1 位 | 含义 | 长什么样 |
|---|---|---|
| `1` | 槽里**只有影子**：一个字面量，或者一个**影子块的 id** | `"STEPS": [1, [4, "10"]]`、`"STEPS": [1, "影子块id"]` |
| `2` | 挂了实块，这个槽**本来就没有影子**（SUBSTACK / 布尔六边形） | `"SUBSTACK": [2, "首块id"]`、`"CONDITION": [2, "条件块id"]` |
| `3` | 挂了实块，块下面还压着一个影子（输入框被报告器占了） | `"STEPS": [3, "块id", [4, "10"]]` |

> **实块用 `2` 或 `3`；`1` 只留给影子**（字面量，或自定义积木原型里那种 argument_reporter 影子）。
> 把实块写成 `[1, "块id"]`，它就被当字面量了 —— 不报错，表达式恒为 0。
> 反过来，`3` 的第 2 位也不一定是块 id：变量/列表报告器会直接写成三元组
> （真实数据：`[3, [12, "*x", "变量id"], [10, ""]]`）。

值是字面量时，第 2 位是 `[类型码, 值]`：

```json
"STEPS": [1, [4, "10"]]          // 数字
"MESSAGE": [1, [10, "你好"]]      // 文本
```

| 码 | 含义 | 码 | 含义 |
|---|---|---|---|
| 4 | 数字（math_number） | 9 | 颜色 |
| 5 | 正数 | 10 | 文本（text） |
| 6 | 正整数 | 11 | 广播消息（broadcast） |
| 7 | 整数 | 12 | 变量（variable） |
| 8 | 角度 | 13 | 列表（list） |

**11 / 12 / 13 不是字面量，是"报告器"**，它们是三元组 `[码, 名字, id]`，而且**不产生独立的块条目**：

```json
"OPERAND1": [1, [12, "分数", "变量id"]]
"ITEM":     [1, [13, "我的列表", "列表id"]]
"BROADCAST_INPUT": [1, [11, "开始", "广播id"]]
```

所以"在块表里查不到这个 id"不等于"这里是常量" —— `lab/dissect.mjs` 早年就把内联变量误判成常量，
一次误报 533 处"两边都写死的比较"。判断"是不是常量"只能用 `isConstant()` 那套（看类型码 4~10）。

来源：`scratch-vm/src/serialization/sb3.js` 的 `MATH_NUM_PRIMITIVE=4` … `LIST_PRIMITIVE=13`。

## fields 编码

`"FIELD_NAME": ["选中值"]` 或带 id：`"VARIABLE": ["变量名", "变量id"]`

```json
"STOP_OPTION": ["all"]            // control_stop 的下拉
"KEY_OPTION": ["space", "space"] // 按键
```

## 常用 opcode 的 input/field 速查（高频）

| opcode | inputs | fields |
|---|---|---|
| motion_movesteps | STEPS | |
| motion_gotoxy | X, Y | |
| motion_pointindirection | DIRECTION | |
| motion_turnright/left | DEGREES | |
| motion_setx/sety | X / Y | |
| looks_sayforsecs | MESSAGE, SECS | |
| looks_say | MESSAGE | |
| looks_switchcostumeto | COSTUME | |
| looks_setsizeto | SIZE | |
| looks_seteffectto | EFFECT, VALUE | |
| looks_show / looks_hide | （无） | |
| control_wait | DURATION | |
| control_repeat | TIMES, SUBSTACK | |
| control_forever | SUBSTACK | |
| control_if | CONDITION, SUBSTACK | |
| control_if_else | CONDITION, SUBSTACK, SUBSTACK2 | |
| control_create_clone_of | CLONE_OPTION | |
| event_broadcast | BROADCAST_INPUT | |
| sensing_touchingobject | TOUCHINGOBJECTMENU | |
| operator_add 等 | NUM1, NUM2 | |
| operator_gt/lt/equals | OPERAND1, OPERAND2 | |
| data_setvariableto | VALUE | VARIABLE（带id） |
| data_changevariableby | VALUE | VARIABLE |
| pen_clear | （无） | pen 扩展，自动加载 |
| music_playnote | NOTE, BEATS | music 扩展 |

完整白名单以 `scratch_get_opcodes` 实时返回为准（不同宿主/已加载扩展会不同）。

## 自定义积木三件套（社区作品大量使用）

```json
"定义块": { "opcode": "procedures_definition", "inputs": { "custom_block": [1, "原型块id"] }, "next": "正文首块" }
"原型块": { "opcode": "procedures_prototype",
           "inputs": { "j*q]7W...": [1, "参数影子块id"] },   // ← 键是 argumentids 里的随机串；值指向 argument_reporter 影子
           "mutation": { "proccode": "旋转 %s 速率 %s", "argumentids": "[\"j*q]7W...\"]",
                         "argumentnames": "[\"方向\"]", "argumentdefaults": "[\"\"]",
                         "warp": "true", "tagName": "procedures_prototype" } }
"调用块": { "opcode": "procedures_call",
           "inputs": { "j*q]7W...": [1, [4, "90"]] },        // ← 同样的随机串
           "mutation": { "proccode": "旋转 %s 速率 %s", "warp": "true", "tagName": "procedures_caller" } }
"参数块": { "opcode": "argument_reporter_string_number", "fields": { "VALUE": ["方向", null] }, "shadow": true }
```

- **参数键没有固定形状**：它是 `argumentids` 里的随机串，每个块都不一样。所以自定义积木**不要手写** ——
  抄一份现成的，或者从背包加载（`scratch_backpack_load` 会自动换成新 id）。
  `add_blocks` 对 `procedures_call` / `procedures_prototype` 也**跳过输入名校验**（它们本来就没有固定名字）。
- `proccode` 在定义、原型、调用三处必须**逐字节一致**（空格、`%s`/`%n`/`%b` 都要一样），否则挂不上。
- `warp` 在原型和调用块两处都要是 `"true"`，只改一处不生效。
- 布尔参数用 `argument_reporter_boolean`，数字/文本用 `argument_reporter_string_number`。
- 定义块的 `custom_block` 指向原型块；正文挂在**定义块的 `next`** 上（不是原型的 next）。

## 坐标与工作区

- 舞台：x ∈ [-240, 240]，y ∈ [-180, 180]，中心 (0,0)
- 工作区放置 top-level 块：x/y 是积木区坐标（左上原点，向右下增），社区脚本普遍放在 x ∈ [40, 400], y ∈ [40, 600]
- **AI 注入的块建议 y 每条脚本 +150 步进**，别全叠一处（用户找不到）

## 输入名对照（拼错会被静默丢弃，v0.10.0 起会当场报错）

| 积木族 | 输入名 |
|---|---|
| `operator_add/subtract/multiply/divide/mod` | `NUM1` / `NUM2` |
| `operator_gt/lt/equals`、`operator_and/or` | `OPERAND1` / `OPERAND2` |
| `operator_not` | `OPERAND` |
| `operator_join/contains` | `STRING1` / `STRING2` |
| `operator_letter_of` | `LETTER` / `STRING` |
| `operator_length` | `STRING` |
| `operator_round` / `operator_mathop` | `NUM`（mathop 另带字段 `OPERATOR`） |
| `operator_random` | `FROM` / `TO` |
| `control_if` / `if_else` | `CONDITION` + `SUBSTACK`（+ `SUBSTACK2`） |
| `control_repeat` | `TIMES` + `SUBSTACK` |
| `control_repeat_until` / `while` | `CONDITION` + `SUBSTACK` |

完整的按 opcode 查更快：`scratch_get_opcodes({ opcode })`。
`add_blocks` 注入前会用这张表校验（`shapeCheck`），写错直接报错并列出正确名字；确需强行注入传 `lenient:true`。

**字段 vs 输入别搞混**：`data_setvariableto` 的 `VARIABLE` 是**字段**（`fields: { VARIABLE: ["名字", "id"] }`），
它的值才在 `inputs.VALUE`。写成 `inputs.VARIABLE` 同样静默无效。

