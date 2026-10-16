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

`"INPUT_NAME": [遮挡标志, 值]`

**值是普通字面量**（数字/字符串直填）：
```json
"STEPS": [1, [4, "10"]]          // 第1位=遮挡标志(1/2/3)，第2位=[类型码, 值]
"MESSAGE": [1, [10, "你好"]]
```

第 2 位那个类型码（`[类型码, 值]`）的字典 —— **这是最容易记错的地方**：

| 码 | 含义 | 码 | 含义 |
|---|---|---|---|
| 4 | 数字（math_number） | 9 | 颜色 |
| 5 | 正数 | 10 | 文本（text） |
| 6 | 正整数 | 11 | 广播消息（broadcast） |
| 7 | 整数 | 12 | 变量（variable） |
| 8 | 角度 | 13 | 列表（list） |

第 1 位（遮挡标志）：`1` = 块和影子是同一个（只给了值）、`2` = 只有块没有影子（布尔/C 块子栈）、`3` = 块和影子不同（值和默认值都给了）。

来源：`scratch-vm/src/serialization/sb3.js` 的 `MATH_NUM_PRIMITIVE=4` … `LIST_PRIMITIVE=13`。

**值是块引用**（input 挂了 reporter 块）：`[1, "块id"]`
```json
"STEPS": [1, "abc123"]
```

**值是块+影子**（reporter 下面还有个默认值）：`[1, "块id", [4, "10"]]`

**布尔六边形输入**：`[2, "条件块id"]`（没有影子）

**子栈**（C 块的 SUBSTACK）：`[2, "子链首块id"]`

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
"定义块": { "opcode": "procedures_definition", "customBlock": "proccode字符串", inputs/fields 视 prototype 而定 }
"原型块": { "opcode": "procedures_prototype", inputs: { 每个参数: [1, [传给argument_reporter的默认label]] }, mutation: { proccode, argumentids, argumentnames, warp, tagName: "procedures_prototype", children: [] } }
"调用块": { "opcode": "procedures_call", inputs: { arg名: [1, [4, "传入值"]] }, mutation: { proccode, warp, tagName: "procedures_caller", children: [] } }
"参数块": { "opcode": "argument_reporter_string_number", fields: { VALUE: ["参数名"] } }
```

注：procedures_definition 的 `customBlock` 指向 prototype 块 id；mutation.proccode 是带 %s 占位符的签名串如 `旋转 %s 速率 %s`。

## 坐标与工作区

- 舞台：x ∈ [-240, 240]，y ∈ [-180, 180]，中心 (0,0)
- 工作区放置 top-level 块：x/y 是积木区坐标（左上原点，向右下增），社区脚本普遍放在 x ∈ [40, 400], y ∈ [40, 600]
- **AI 注入的块建议 y 每条脚本 +150 步进**，别全叠一处（用户找不到）
