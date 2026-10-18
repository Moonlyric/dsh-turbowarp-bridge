# 注入语义：add_blocks 到底会动什么（输入/输出契约）

> 适用场景：第一次用 `scratch_add_blocks` 注入脚本、从别的角色/背包搬脚本、或者"注进去了但跑起来没效果"时。
> 这一篇是**契约**，不是原理课 —— 每条都对应一个真机踩过的坑。

## 1. 它会做什么（不用你操心）

| 行为 | 怎么知道它做了 |
|---|---|
| **ID 全部换新**（旧 id 全部失效） | 返回 `idMap: {旧id: 新id}`；后续引用必须用新 id |
| inline 字面量展开成**影子块** | `expandedBlocks` > 你给的块数，这是正常的 |
| **自动补建**缺的变量/列表/广播 | `refs.created` 里有真实 id；同名已存在则走 `refs.kept`（不重复建） |
| 变量引用按 id/名字**改指向** | `refs.remapped` 列出从哪个 id 改到哪个 id |
| 自动加载块需要的扩展（pen / music…） | 存盘后 `extensions` 里会出现 |
| 自动排布（没给坐标时） | 返回 `layout.mode` + `placed`；不会叠在原点 |
| 改完**把视口滚过去** + 高亮 | 返回 `followed` / `glowed` |

## 2. 它**不会**做的事（以前踩过的坑）

- **不会清理**你上次注入的块。`staleInjected` 只是提醒"这些还游离在顶层"。
  想清就显式 `discardStale:true`，而且它只清"整棵子树都是 AI 注入的"，碰到作者的积木会跳过并在 `discarded.skipped` 里说。
- **不会自动把块拼进已有脚本**。你给的是顶层块，它们就保持顶层（游离）。要接进别人的脚本，用 `scratch_move_block`。
- **不会校验逻辑**，只校验**结构**：输入名/字段名（`shapeCheck`）、变量引用、块数量。表达式写反了它不会知道。

## 3. 三个 id 世界的区别（最容易混）

| 来源 | id 形态 | 能拿来操作吗 | 活得久吗 |
|---|---|---|---|
| `scratch_add_blocks` 的 `idMap` | 长 id（`dshp3-a1b2c3` 之类） | ✅ 能 | **只到下次存盘/重开**（重开后是文件里的短 uid） |
| `scratch_read_script` / `list_scripts` | 真实活块 id | ✅ 能 | 同上 |
| `scratch_snapshot` 的 `blocks` | sb3 短 uid（`a`、`X`、`aa`） | ❌ **不能**（和 idMap 完全不是一套） | 只用于看原始数据 |

结论：**要操作就用 `read_script` / `list_scripts` / `idMap` 里的 id**；`snapshot` 只用来看结构或自己解析。

## 4. `idMap` 什么时候不可靠

返回里有 `idMapReliable`。为 `false` 时说明"新增块数 ≠ 送入块数"或 opcode 对不上（通常是块 id 撞了已有 id）。
这时**别猜**，直接 `scratch_read_script({ scriptId })` 重读一次拿真实 id。

## 5. 输入槽是"可以被拔空"的

- 从 `if` / `repeat_until` 里把条件块搬走后，这个空槽在 sb3 序列化里可能整条消失。
- 现在 `scratch_move_block` / `scratch_update_block` 会**按该 opcode 的合法输入名自动补建**（F2），
  实在补不了才报错，并列出这个块真实的输入名。
- 判断某个块现在有哪些输入：`scratch_inspect({ blockId })`（比读整段便宜得多）。

## 6. preview / apply 档位（默认是 preview）

- 默认 `safety: "preview"`：写操作**不落项目**，只返回 `planId` + `preview`，等用户点头后再 `scratch_apply({ planId })`。
- 想直接落盘：`safety: "auto"`（插件配置里改，立即生效）。
- 不管哪一档，写之前都会**自动快照**（`scratch_rollback` 可回）。
- `variable` 的 `get`、以及所有读操作／运行期操作（run/click/press_key/state/profile/screenshot）**不受档位限制**。

## 7. 变量/列表的引用怎么落地（resolveRefs）

按顺序尝试：① id 在目标角色/舞台里有效 → 不动；② id 无效但**同名**存在 → 改指向；③ 都没有 → 就地新建（值从 `variables` 参数里取，没给就是 `""` / `[]`）。
所以从背包/别的角色搬脚本时，**不需要**手动建变量 —— 但要知道它是建在**当前角色**上的（多角色共用请显式建全局）。

## 8. 一次注入的最小正确样板

```js
// 一个绿旗脚本：设 计数 = 0，重复 10 次「计数 +1」
await scratch_add_blocks({
  target: '细胞',
  blocks: {
    h:  { opcode: 'event_whenflagclicked', next: 'a', parent: null, inputs: {}, fields: {}, topLevel: true },
    a:  { opcode: 'data_setvariableto',  next: 'b', parent: 'h',
          inputs: { VALUE: [1, [4, '0']] },
          fields: { VARIABLE: ['计数', ''] }, topLevel: false },   // ← 字段是 [名字, id]，id 可以留空让它接
    b:  { opcode: 'control_repeat', next: null, parent: 'a',
          inputs: { TIMES: [1, [4, '10']], SUBSTACK: [2, 'c'] }, fields: {}, topLevel: false },
    c:  { opcode: 'data_changevariableby', next: null, parent: 'b',
          inputs: { VALUE: [1, [4, '1']] },
          fields: { VARIABLE: ['计数', ''] }, topLevel: false }
  }
})
```

要点：`next`/`parent` 必须成对；`SUBSTACK: [2, '块id']`；数字用类型码 4；字段给 `[名字, id]`（id 空着也行）。
写完立刻 `scratch_inspect({ blockId: idMap.c })` 确认它真的挂进了循环体。
