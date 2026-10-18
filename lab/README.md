# lab — TurboWarp × DSH 桥的验靶

这个目录里的东西**不参与运行**，只用来验证桥的逻辑。分两层：

| 层 | 需要什么 | 覆盖 |
|---|---|---|
| **替身 VM 层**（`test-content-ops.js` / `test-vm-pipeline.js`） | 只要 Node + `npm install`（约 140MB） | 快，可离线，但 VM 不是宿主那一个 |
| **真机层**（`real-machine-check.mjs`） | Node + 真 Chrome/Edge + 能访问 turbowarp.org | 慢（1~3 分钟），但验的就是真实运行环境 |
## 一次性准备

```sh
cd lab
npm install          # scratch-vm + scratch-storage，约 140MB
```

## 回归

```sh
# 替身 VM 层（秒级）
node test-content-ops.js     # 主套件：280 条断言（读/写/改/删/整理/定位/白名单/观察者/运行控制/回传瘦身/背包导出与对拍/输入名校验/自动布局/子树读）
node test-blank-project.mjs   # 空白作品生成器：13 条（zip/md5 + 真 scratch-vm 装载 + 两个 skin）
node test-vm-pipeline.js     # scratch-vm 管线冒烟：只打日志，没有断言（退出码恒为 0）

# 真机层（分钟级，需要浏览器 + 网络）
node real-machine-check.mjs
```

插件自身的单测在插件包里：

```sh
cd ../packages/dsh-plugin-scratch
npm install
node test-skills.mjs         # 23 条断言（skill 区）
node test-tools.mjs          # 103 条断言（唤起编辑器 / 打包契约 / 运行控制 / 背包契约）
node test-backpack.mjs       # 36 条断言（背包：假页面连真桥，存→读→注入→删）
node test-bridge-auth.mjs    # 21 条断言（握手认证 + 跨会话伪造防护）
```

## real-machine-check.mjs（真机验收，全自动）

它做的是完整真链路，不是模拟：

1. 用真配置 `apply()` 插件（起真的 31820 桥服务端），token 从临时 `$DSH_HOME` 里读
2. 拉起真浏览器（临时 profile），用 CDP 的 `Extensions.loadUnpacked` 装真扩展
3. 打开扩展选项页，用 `chrome.storage.local` 写 token（等价于用户手填）
4. 打开真 `https://turbowarp.org/editor`，等 MAIN world 执行器自报 `socket=open authed=true`
5. **用真工具跑一遍全流程，28 个工具全覆盖**：
   open_editor（唤起 + 没有会话时给 token 步骤）→ list_sessions → snapshot →
   add_blocks（preview→apply）→ update_block → locate（滚动+高亮）→ delete_blocks →
   snapshot 查孤儿 → rollback → get_opcodes → tidy_blocks → add_costume →
   watch（真定时器轮询）→ user_context（**真鼠标点块** + 绿旗运行态）→ 已有会话时不重复开标签页

**关键点：校验不拿插件自己的返回值当证据。** 积木到底有没有真的进 VM，是在页面里
直接读 `vm.runtime.targets[].blocks._blocks`（活块模型）和 Blockly 的 `workspaceToDom` XML
得出的——两个独立信源。`locate` 是否真的滚动，是用块的 `getBoundingClientRect()`
和画布矩形比出来的（不碰 `scrollX` 的正负号约定，猜错就会误判）。选块是否被感知，
是用 CDP `Input.dispatchMouseEvent` 发**真鼠标事件**点的，而不是程序化 `select()`
——后者不一定发 ui 事件，拿它当断言会误判。

### 不会在你桌面上乱开东西（这条是硬要求）

回归套件**只用桩脚本**验证「唤起浏览器 / 唤起桌面版」：桩是一个 `.cmd`，把收到的参数写进
日志文件供断言，不会真的拉起 Chrome 或 TurboWarp Desktop。要真体验唤起效果，请自己跟
AI 说「打开 TurboWarp」，或用 `HEADFUL=1` 手动跑。

> 这条是踩过才写下来的：`test-tools.mjs` 曾经为了测"自动定位桌面版"而不传 `desktopPath`，
> 结果在装了 TurboWarp 的机器上**每次跑测试都会真开一个桌面版窗口**。
> 现在它改成用「指向正在运行的进程（node.exe）」验"已在运行不重复开"，
> 并用假 `reg.exe` 隔离注册表探测来验"找不到"分支——两条都没有副作用。
>
> 顺带把产品也修了：`scratch_open_editor({app:'desktop'})` 现在会先数进程，
> **已经在运行就不再拉一个**（桌面版没有单实例锁，重复调会满屏窗口）。

真机层会启动一个**临时 profile 的 headless 浏览器**（这是它的工作方式），
跑完会 taskkill 并删掉临时目录——包括 Windows 下等文件句柄释放再删。

环境变量：

| 变量 | 作用 |
|---|---|
| `CHROME_PATH` | 指定浏览器（默认按 Chrome → Edge 顺序找） |
| `HEADFUL=1` | 开有窗口模式（默认 `--headless=new`，排障时用） |
| `KEEP_OPEN=1` | 跑完不关浏览器（想手动看看效果时用） |
| `EDITOR_URL` | 换编辑器地址（默认 turbowarp.org/editor） |
| `BRIDGE_PORT` / `CDP_PORT` | 换端口（默认 31820 / 19333） |

### 关于装扩展这件事（踩过）

**Chrome 137 起，品牌版 Chrome 会直接忽略 `--load-extension`**：

```
WARNING:extension_service.cc:423] --load-extension is not allowed in Google Chrome, ignoring.
WARNING:extension_service.cc:445] --disable-extensions-except is not allowed in Google Chrome, ignoring.
```

所以自动化不能用命令行开关（`--disable-features=DisableLoadExtensionCommandLineSwitch`
这个老逃生口在 Chrome 155 上已经无效）。脚本走的是 **CDP `Extensions.loadUnpacked`**
（Chrome 130+ 自带，不需要额外开关），它返回真实扩展 ID。
失败时回退到 `--load-extension` + 从 `/json/list` 里推 ID（Chromium / 旧版可用）。

**用户手动走的是 `chrome://extensions` → 加载已解压的扩展程序，不受这个限制影响。**

## 替身 VM 层的盲区（别把这些绿灯当成「真机没问题」）

1. **验靶的 VM 不是宿主 VM。** 这里装的是 npm `scratch-vm`（scratchfoundation 5.x）；
   turbowarp.org 跑的是 `TurboWarp/scratch-vm`。两者 `shareBlocksToTarget`
   的输入要求不同，`content-main.js` 里的宿主兼容层正是为这个差异写的。
2. **没有 GUI。** `locate` 的滚动/高亮、`emitWorkspaceUpdate` 的真实渲染效果、
   `watch` 的选块事件，替身层只能验「逻辑调用了哪条路」，验不了「用户看见什么」。
3. **`watch` 的定时轮询没有被执行。** 沙箱把 `setInterval` 桩成了 `() => 0`，
   所以 `watchTick` 的定时路径一次都没跑过；相关用例实际只校验了 `current` 值。
4. **`stub renderer` 不是真渲染器。** `getDrawableOrder` 等一堆方法是假的，
   `layerOrder` / 造型尺寸之类的行为与浏览器不一致。
5. **假替身的 API 面 / 事件形状必须照抄真机的**（这条是用血换来的，栽过两次）：
   - 假 workspace 曾经**只**实现 `scrollBounds`——那是上游 Blockly 的 API，
     真机 scratch-blocks 根本没有它。于是「locate 真的调了 scrollBounds」全绿，
     而真机上 `locate` 静默不滚动（`typeof` 挡一下 + `try/catch` 把「方法不存在」吞了）。
     现在同时造了「scratch-blocks 真实面」「只有 scrollBounds」「只有 scroll(x,y)」
     「一个滚动 API 都没有」四种 workspace，四条分支都断言。
   - 选块事件：scratch-blocks 把动作放在 **`e.element`**，`e.type` **恒为 `'ui'`**。
     旧实现判 `e.type === 'click'` → 永远不成立，而唯一能过第一关的 `element:'selected'`
     事件 `blockId` 又是 `null` → 被挡掉。**「用户选块感知」一次都没生效过。**
     现在 `test-content-ops.js` 里喂的是真机实测抓到的三个事件
     （`selected/null`、`click/<id>`、`stackclick/<id>`）。
     **元教训**：写事件过滤器前，先去真机把原始事件打出来看一眼，别照着自己的想象写。

**结论**：改 `content-main.js` 里跟宿主 API 有关的代码，跑完替身层**一定要再跑一次
`real-machine-check.mjs`**。上面第 5 条那种 bug，替身层按定义就抓不到。
