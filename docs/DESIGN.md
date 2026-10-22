# 希沃屏保修改工具 — 架构设计文档（DESIGN）

> 版本：v1.0 · 目标应用：`SeewoServiceAssistant`（希沃管家）v1.2.7 · 平台：Windows x64 / Electron
> 依据：`.work/FINDINGS.md`、`.work/RENDERER_CONTRACT.md`、`.work/app/main.js`（330 KB 主进程）、
> `.work/app/public/screensaver.js`、`.work/app/public/preLoad.js`、`.work/app/public/screensaver.html`、
> `.work/src/SeewoServiceAssistant/Verify.json`、`resources/assets/customMade/*/config.json`
> 参考实现：[HugoAura-Enhanced](https://github.com/blingbling-bow/HugoAura-Enhanced)（分支 `dev`，v0.3.1，GPL-3.0-or-later）

---

## 0. 阅读指引与证据分级

本文所有函数名、模块 id、通道名、字段名均**逐字来自真实解包产物**，不做推测性命名。
凡不确定之处显式标注 **【待验证】**。证据分级如下：

| 标记 | 含义 | 示例 |
|---|---|---|
| **[实证]** | 已在解包源码中定位到字面量，本文直接引用原文片段 | `c="/displayScreenSaver"` @ main.js:159265 |
| **[推演]** | 由实证事实经逻辑推导得出，推导链完整可复核 | 「禁用屏保必须同时处理三处 forceCloseTaskList」 |
| **[待验证]** | 需要真机实验或更完整反编译才能确认 | 模块 296 处理器内部行为 |

### 0.1 已确证的核心事实速览（全部 [实证]）

| # | 事实 | 证据位置 |
|---|---|---|
| 1 | 任务类型常量 `SCREENLOCK / SCHOOLANNOUNCEMENT / LIVE / SCREENSAVER / POPUP_NOTIFICATION` | `main.js` @ 40640，webpack 模块 38 |
| 2 | 屏保控制器单例，`onMessage(e)` 以 `e.url === "/displayScreenSaver"` 为唯一入口 | `main.js` @ 159265 |
| 3 | 控制器 `enQueue({taskName:"SCREENSAVER", taskDependencies:["LIVE","SCHOOLANNOUNCEMENT"], ...})` | `main.js` @ 159703 |
| 4 | `startScreensaver() → i.newWindow("screensaver", !1)`（`!1` = 不注册键盘钩子） | `main.js` @ 160074 |
| 5 | `newWindow` 对 `screen.getAllDisplays()` 每块屏建一窗，窗口名 `screensaver_<i>` | `main.js` @ 76173 |
| 6 | 窗口 `on("close")` → `setTimeout(() => { this.closeWindow(), this.startLock() }, 0)` | `main.js` @ 76550 附近 |
| 7 | `stopScreensaver()` → `closeWindow()` + `share("screensaverTransitionList", null)` + `a()` + `outQueue(SCREENSAVER)` | `main.js` @ 160074 |
| 8 | 状态通道 `screensaverMessage` / `screensaverTransitionList`，经 `share()` → `SHARE_DATA` → 渲染器 | `main.js` @ 1821（模块 2）、159504 |
| 9 | 转场数组：长度 = `imageList.length`，值域 `0..6`（`Math.random()*7`） | `main.js` @ 159504 |
| 10 | `SCREENLOCK` 的 `taskDependencies` 含 `SCREENSAVER`，且 `forceCloseTaskList:[SCREENSAVER]` | `main.js` @ 43831 |
| 11 | **`SCHOOLANNOUNCEMENT`（@172806）与 `LIVE`（@322972）同样带 `forceCloseTaskList:[SCREENSAVER]`** | `main.js` 全局 5 处字面量 |
| 12 | 渲染器订阅契约：`materialSource` / `switchInterval`（**秒**，默认 15）/ `pictureSizeType`（0=contain,1=cover）/ `imageList` / `textList[]` | `screensaver.js` 模块 820 |
| 13 | 渲染器点击容器 → `W.a.send("closeScreenSaver")`（第二条关闭路径） | `screensaver.js` 模块 820 |
| 14 | `Verify.json` 仅 43 条，**全部是 `.dll`(41) / `.exe`(2)，不含 `app.asar`** | 统计自 `Verify.json` |
| 15 | 官方预留环境开关 `process.env.runmode`（`dev` → 模块 89，`test` → 模块 173，其余 → 模块 174） | `main.js` @ 1380、251597 |
| 16 | `CUSTOM_CONFIG` 由 `resources/autoConfiguration.json` 注入（当前内容 `{}`），支持 `windowRedirect` / `htmlRedirect` | `main.js` @ 2599、76000 附近 |

---

## 1. 现状分析：目标软件形态与屏保机理

### 1.1 目标软件形态

`SeewoServiceAssistant`（希沃管家）v1.2.7 是一个 **Electron 桌面应用 + 原生 FFI 桥** 的组合体，
发布形态为「Electron 运行时 exe + asar 单包 + 若干原生 DLL」：

```
SeewoServiceAssistant/
├── SeewoServiceAssistant.exe        95 MB   Electron 主程序（官方签名）
├── BootConfig.json                          启动/守护模式（needGuard=true, launcher, --desktop）
├── Verify.json                       5.6 KB ★ 43 条 CRC32 清单（仅 .dll/.exe）
├── ShortCut.json / Firewall.json
├── active.bat / install.bat / uninstall.bat / ota_install.bat / delete_pin.bat
├── resources/
│   ├── app.asar                   11.3 MB ★ 应用主体（未列入 Verify.json）
│   ├── autoConfiguration.json             ★ 内容为 {}，运行时作为 CUSTOM_CONFIG 叠加层
│   ├── addons/  ffi_bindings.node, binding.node
│   └── assets/
│       ├── dlls/ windowsApiFfi.dll ★  KeyBoardHookFfi.dll ★  RpcDiscoverFfi.dll ★
│       └── customMade/<系列>/config.json  8 套 ODM 定制（default/ODM/pure/jiangxi/...）
└── LICENSE (MIT, GitHub Inc.)  +  LICENSES.chromium.html (4.8 MB)
```

**关键结构性观察：**

1. **`Verify.json` 的覆盖范围是本次设计中最有价值的发现之一 [实证]**。43 条记录按扩展名分布为
   `.dll` × 41、`.exe` × 2，**没有任何一条指向 `resources/app.asar` 或其中的文件**。
   这意味着应用自身的完整性自检在**外层目录层面并不校验 asar 字节**。
   → 这是路线 A（asar 重打包）在**当前版本**下理论可行的直接依据。
   **但**：Electron 自身可能启用 asar integrity（fuses 中的 `EnableEmbeddedAsarIntegrityValidation`）；
   对 `main.js` 的全文检索**未找到** `integrity` / `onlyLoadAppFromAsar` 字样 [实证]，
   但这只说明 **asar 内部 JS 未做校验**，不代表 exe 内嵌 fuses 未开启。
   → **标注【待验证】**，必须在真机阶段 0 验证（见 §7）。

2. **`autoConfiguration.json` 是官方预留的配置叠加入口 [实证]**。模块 1 的加载逻辑为：

```js
// main.js 模块 1（配置聚合），位置 1380 附近，逐字引用
if (r.isPackaged) try {
  u = JSON.parse(o.readFileSync(i.resolve(r.getAppPath(), "..", "autoConfiguration.json"), "utf8"))
} catch (e) { u = {} }
// 且：非纯对象时降级为 {}
"object" == typeof u && "[object Object]" === Object.prototype.toString.call(u) || (u = {})
// 打包态分支：
e = process.env.runmode && "dev"  === process.env.runmode ? n(89)
  : process.env.runmode && "test" === process.env.runmode ? n(173)
  : n(174);
c = Object.assign({}, s, e, u)     // ★ autoConfiguration.json 优先级最高
```

   即 **`resources/autoConfiguration.json` 的内容会被合并进全局配置对象，且覆盖内置默认值**。
   `CUSTOM_CONFIG` 正是从该对象读取（`o.getData("CUSTOM_CONFIG")`，模块 3 @ 76000 附近）。
   → 这是路线 C 中**唯一有官方语义支撑**的配置层，也是本方案必须复用的机制。
   **【待验证】**：`autoConfiguration.json` 是否会随 OTA 更新被覆盖？
   逐字比对 8 套 `customMade/*/config.json` 可确认它们只含品牌/UI 字段，**无屏保字段** [实证]，
   故官方未提供任何屏保配置面。

3. **`process.env.runmode` 是官方预留的运行模式开关 [实证]**，取值 `dev` / `test` / 其它（`pro`）。
   多进程通过环境变量向 Electron 子进程传递模式是官方行为。
   → 我方注入器可利用同一条通道传递自身开关（**不覆盖 `runmode` 本身**，避免改变官方行为）。
   **注意**：全文检索 `process.env.*` 仅得到 8 个键（`runmode`×8、`NODE_DEBUG`、
   `TEST_GRACEFUL_FS_GLOBAL_PATCH`、`ProgramData`×4、`DEBUG`×25、`easiassistant_debugport`、
   `LOG4JS_CONFIG`、`READABLE_STREAM`、`GRACEFUL_FS_PLATFORM`）。
   ⚠️ **HugoAura 使用的 `process.env.DISABLE_LOG_ENCRYPTION` 在本版本 main.js 中检索不到**
   —— 说明它是**更高版本**（4010+）才引入的开关，v1.2.7 上无效。本方案不得依赖它。

### 1.2 屏保完整生命周期（含真实代码）

**阶段 1 — 触发（唯一入口）**

```js
// main.js @ 159150–159260 逐字引用
const s = n(38),   // 任务类型常量
      r = n(2),    // share()：跨窗口共享状态广播
      o = n(39),   // 任务队列 enQueue / outQueue
      i = n(69),   // 窗口管理 newWindow / closeWindow / startLock
      a = n(297),  // 依赖刷新回调
      c = "/displayScreenSaver";
```

屏保**没有本地按钮入口**，也没有独立 IPC 入口；它**只能**由云端/集控经 `SeewoProxyHTTP` 下发
`/displayScreenSaver` 消息触发，由模块级控制器单例的 `onMessage(e)` 消费 [实证]。
`e.data` 即渲染器契约中的 `screensaverMessage` 载荷。

**阶段 2 — 入队与互斥**

```js
onMessage(e) {
  e.url === c && (
    r.share("screensaverTransitionList",
      ((e, t = 7) => { let n = []; for (let s = 0; s < e; s++) n.push(Math.floor(Math.random() * t)); return n })(e.data.imageList.length)),
    r.share("screensaverMessage", e.data),
    o.enQueue({
      taskName: s.SCREENSAVER,
      taskDependencies: [s.LIVE, s.SCHOOLANNOUNCEMENT],
      startTask:    this.startScreensaver,
      pauseTask:    this.closeWindow,
      coutinueTask: this.startScreensaver,   // ★ 官方拼写错误 "coutinue"，非笔误
      closedTask:   this.stopScreensaver,
      error: () => { o.outQueue(s.SCREENSAVER) }
    })
  )
}
```

`taskDependencies` 语义（模块 39 任务队列，@ 40900）[实证]：
```js
enQueue(e) {
  this.tasksMaps.set(e.taskName, Object.assign({}, e, { state: r }));   // r = "waiting"
  this.setDependedMaps(e.taskName, e.taskDependencies, !0);
  this.checkTaskCanRun(e.taskName) ? (this.sortQueue(e.taskName), this.runTask(e.taskName))
                                   : this.addToWaiting(e.taskName)
}
```
即 **屏保必须等 `LIVE` 与 `SCHOOLANNOUNCEMENT` 都空闲才能启动**；
这也是为何「上课/直播/校宣期间屏保不弹」。

**阶段 3 — 建窗（多显示器）**

```js
// main.js @ 76173 起，模块 69 逐字引用
newWindow(e, t = !0) {
  const { screen: c } = n(0);
  let u = c.getAllDisplays();           // ★ 每块屏一个窗口
  t && r.SetKeyboardHook();             // 屏保传 false → 不挂钩键盘
  for (let t = 0; t < u.length; t++) {
    if (this.windowsList[e] && this.windowsList[e].includes(e + "_" + t)) continue;
    let n = a(u[t].bounds.width);       // a = w => w / 1920  (缩放因子)
    i.share("setZoomFactor", n, e + "_" + t);
    let r = s.addOne(e, e + "_" + t);   // 窗口名 "screensaver_0" / "screensaver_1" ...
    this.windowsList[e] || (this.windowsList[e] = []);
    this.windowsList[e].push(e + "_" + t);
    r.setBounds({ width, height, x, y });   // 全屏覆盖该显示器
    r.show();
    r.on("close", () => { setTimeout(() => { this.closeWindow(), this.startLock() }, 0) });
    //                    ★★★★★ 关闭屏保窗口 → 级联进入屏幕锁（SCREENLOCK）
  }
  o.addListener(() => { setTimeout(() => { this.resetWindow(e) }, 1e3) }, e)
}
```

**阶段 4 — 渲染**：`screensaver.html` 从 URL query 取 `windowName`，加载 `preLoad.js`；
`preLoad.js` 实例化 `window._ACCEPT_DATA` 总线并通过 `ipcRenderer` 收 `SHARE_DATA`；
`screensaver.js`（webpack chunk `[820,0]`）的 module 820 用
`F.getAndRegister("screensaverMessage", e)` 与 `F.getAndRegister("screensaverTransitionList", n)` 订阅。

**阶段 5 — 关闭（两条独立路径）**

| 路径 | 触发 | 代码 | 后果 |
|---|---|---|---|
| **P1 渲染器点击** | 用户点击 `.screensaver__box__1OePhc5d` | `W.a.send("closeScreenSaver")` → 主进程路由表 `./closeScreenSaver.js`（模块映射 id=296） | 走官方关闭例程，通常 → `stopScreensaver()` |
| **P2 窗口 close 事件** | 窗口被任何方式销毁（含 P1 触发的 destroy） | `r.on("close", () => setTimeout(() => { this.closeWindow(), this.startLock() }, 0))` | **无条件 `startLock()` → 锁屏** |

⚠️ **P2 是「关闭屏保后自动锁屏」的唯一根因 [实证]**。注意 `startLock()` 是模块 69 的方法，
它**不等于**模块 33 的 `startLockTask()`；后者走任务队列与云端回执。二者关系
**【待验证】**（`main.js` @ 43500 起可见模块 69 的 `startLock()` 直接
`s.addOne("screenLock", "screenLock_" + e)` 建窗，并 `share("setZoomFactor", …, "screenLock_" + e)` [实证]）。
→ **工程含义：拦截 P2 的 `startLock()` 比拦截 SCREENLOCK 任务更贴近根因、副作用更小。**

**阶段 6 — 与屏幕锁的互斥**

```js
// main.js @ 43831，模块 33 逐字引用
startLockTask(e, t) {
  this.message || l.enQueue({
    taskName: f.SCREENLOCK,
    taskDependencies: [f.LIVE, f.SCHOOLANNOUNCEMENT, f.SCREENSAVER],   // ★ 屏保是锁的前置
    startTask: this.startLock, pauseTask: this.closeWindow,
    coutinueTask: this.startLock,
    forceCloseTaskList: [f.SCREENSAVER],   // ★ 启动锁时强制关闭屏保
    error: () => { l.outQueue(f.SCREENLOCK) }
  });
  ...
}
```

`forceCloseTaskList` 的运行时语义（@ 42500）[实证]：`outQueue` 在出队时执行
`t.forceCloseTaskList.map(e => this.forceCloseTask(e))`，而
`forceCloseTask(e)` 取出 `tasksMaps.get(e)` 并调用其 **`closedTask()`**。

### 1.3 ★ 屏保的三个「强制关闭」来源（本次分析新增的关键结论）

全文检索 `forceCloseTaskList` 共 5 处字面量，其中 3 处指向 `SCREENSAVER` [实证]：

| 来源任务 | 位置 | 语义 | 对屏保的影响 |
|---|---|---|---|
| `SCREENLOCK` | @ 43831 | 进入锁屏 | 强制关闭屏保 |
| `SCHOOLANNOUNCEMENT` | @ 172806 | 校宣播放（依赖 `[LIVE]`） | **强制关闭屏保** |
| `LIVE` | @ 322972 | 直播开始 | **强制关闭屏保** |

**工程含义（[推演]，推导链完整）**：一个「只想看自定义屏保」的用户，即使成功改写了图集，
屏保仍会在**任何一次校宣或直播下发时被强行关闭**；而强制关闭走 `closedTask()` = `stopScreensaver()`
= `closeWindow()`，**但不走 P2 的 `startLock()`**（`forceCloseTask` 与窗口 `on("close")` 是两条不同调用路径）。
→ 因此「防级联锁屏」与「防强制打断」是**两个独立需求**，必须分别处理，不能混为一谈。

### 1.4 用户真实痛点归纳

结合上文，可归纳出配置工具必须解决的 6 个需求，并标注其**真实技术落点**：

| # | 用户诉求 | 真实落点（实证标识符） |
|---|---|---|
| N1 | 彻底禁用屏保 | 吞掉 `e.url === "/displayScreenSaver"` 分支 |
| N2 | 自定义图集/文案 | 改写 `screensaverMessage` 载荷的 `imageList` / `textList` |
| N3 | 调整停留时长与适配 | 改写 `switchInterval`（秒）/ `pictureSizeType`（0\|1） |
| N4 | 控制转场 | 改写 `screensaverTransitionList`（**长度必须 = imageList.length，clamp 0..6**） |
| N5 | 关闭后不要锁屏 | 拦截 P2 的 `startLock()` 调用（**不是**拦 SCREENLOCK） |
| N6 | 别被校宣/直播打断 | 拦截 3 处 `forceCloseTaskList` 的 `forceCloseTask("SCREENSAVER")` |

---
## 2. 三种技术路线对比与选型

### 2.1 路线 A — asar 重打包（Repack）

**原理**：用 `@electron/asar` 把 `resources/app.asar` 解包 → 修改 `main.js` / `public/screensaver.js` 源文本 →
重新打包回 `app.asar` → 写回安装目录。

```bash
# 环境约束（本机实测）：/tmp 是 noexec，npm 需指定 cache
npm --cache /tmp/npmcache i -D @electron/asar
npx asar extract  resources/app.asar  .repack/
# 在 .repack/main.js 的屏保控制器 onMessage 中插入拦截逻辑
npx asar pack     .repack  resources/app.asar.new
# 备份原 asar 后替换；保留 asar 头部偏移特性需用 --ordering 或全量重打包
```

**技术要点**：
- asar 是**只读归档**，运行时由 Electron 的 `fs` 补丁层按偏移直接读取；重打包会改变内部文件顺序与偏移，
  但 **Electron 不校验偏移**，只要头部目录结构与文件字节自洽即可加载。
- 修改点可以是字符串级（最小 diff）也可以是结构级。**推荐字符串级 patch**：
  定位 `,c="/displayScreenSaver";const u=new class{` 这一唯一锚点，在其后注入包装代码，
  这样即使官方升级导致整体偏移变化，只要锚点仍在就能定位。

**优点**：
1. **零运行时开销**：补丁是静态代码，无 monkey-patch 的间接调用成本。
2. **可完全掌控**：能改任何逻辑，包括 `newWindow` 的 `on("close")` 回调本身（P2 根因）。
3. **不依赖模块 id 稳定性**：直接改源码，不必猜 `n(69)` 背后是哪个 id。
4. **可离线分发**：产出一个成品 asar，用户替换即用，无需常驻进程。

**缺点**：
1. **升级即失效 [高]**：OTA 更新（`ota_install.bat`）会覆盖整个安装目录，补丁全丢。
2. **asar 完整性校验风险 [中]**：`Verify.json` 目前不含 asar [实证]，但 exe 内嵌 fuses 是否开启
   `EnableEmbeddedAsarIntegrityValidation` **【待验证】**；一旦开启，改 asar 会导致应用**直接拒绝启动**。
3. **发行体积大 [高]**：每个目标版本需各产一份 asar（11 MB），多版本分发体积线性增长；
   且分发他人版权代码有法律问题（见 §6）。
4. **回滚粒度粗 [中]**：只能整体换回原 asar，无法按功能开关。
5. **不可热更新 [高]**：改一次要重启应用。
6. **签名破坏 [中]**：asar 变更不影响 exe 签名，但若用户环境有第三方完整性监控（如企业 EDR）可能告警。

**适用场景**：一次性、固定版本的设备固化改造；离线机房批量刷机；对性能极致敏感的场景。

### 2.2 路线 B — 注入式 Hook（Injection，HugoAura 同构）

**原理**：**不修改任何官方文件**。启动时以 Electron 的官方注入点加载我方代码，
在**运行时**劫持 webpack 模块表，包装目标单例的方法。

**HugoAura 的具体做法（逐字来自 dev 分支，v0.3.1）**：

| 环节 | 文件 | 关键代码 |
|---|---|---|
| 主进程入口 | `src/core/hook.js` | 顶部即 `process.env.DISABLE_LOG_ENCRYPTION = "1"`；创建 `global.__HUGO_AURA__` 命名空间 |
| 全局命名空间 | `src/core/hook.js` | `{ hookedWindows: Map, configInit, central, ipcInit, auraDir, uiHooks: Map, windowHooks: Map, version }` |
| 模块解析器 | 参数 `central` | `central(id)` 直取 webpack 模块导出（如 `central(1)` = electron、`central(0)` = 全局配置） |
| 主进程钩子装载 | `src/core/hook.js` | `installHook(name, path)` 逐个 `try/catch` 隔离安装，**任一失败只跳过它自己** |
| 屏保钩子 | `src/aura/mainProcess/hooks/disableScreensaver.js` | 模块 121 + 特征自检 + 包装 `onMessage` / `startScreensaver` |
| 渲染器 preload | `src/core/preload.js` | `require.main` 守卫；`ipcRenderer.sendSync("$aura.base.getAuraDirSync")` 取目录 |
| 渲染器 webpack 劫持 | `src/aura/init/preload/webpackHook.js` | `Object.defineProperty(window, "webpackJsonp", { set })` + 包装 `value.push` |
| 配置管理 | `src/aura/init/shared/configManager.js` | `ConfigManager`，主/渲染双端同构（`side = "main" \| "renderer"`） |
| 注册表 | `src/aura/init/shared/registryManager.js` | `HKEY_USERS\.DEFAULT\SOFTWARE\HugoAura`，用 `reg add/query` 子进程 |
| 事件总线 | `src/aura/utils/eventBus.js` | `Map<eventName, Set<cb>>`，`emit` 内 `try/catch` 隔离回调异常 |

**`disableScreensaver.js` 的教科书式防御设计（强烈建议我方照抄）**：

```js
// 1) 结构特征自检，而不是硬信任模块 id
const isScreensaverManager = (value) => {
  const onMessage = getPrototypeMethod(value, "onMessage");
  return Boolean(value
    && typeof value.onMessage === "function"
    && typeof value.startScreensaver === "function"
    && typeof value.stopScreensaver === "function"
    && typeof onMessage === "function"
    && String(onMessage).includes("screensaverTransitionList"));  // ★ 用唯一字符串指纹
};

// 2) 首选 id 121，失败则遍历 webpack 模块表按指纹扫描（抗版本漂移）
const resolveScreensaverManager = (central) => {
  const preferred = resolveModule(central, 121);
  if (isScreensaverManager(preferred)) return preferred;
  const table = central && central.m;
  if (table && typeof table === "object") {
    for (const [id, factory] of Object.entries(table)) {
      if (id === "121" || typeof factory !== "function") continue;
      if (!String(factory).includes("screensaverTransitionList")) continue;
      const candidate = resolveModule(central, Number(id));
      if (isScreensaverManager(candidate)) return candidate;
    }
  }
  return null;
};
```

⚠️ **对我方的直接启示（重要）**：
- HugoAura 硬编码 `module 121`，而**本机 v1.2.7 的屏保控制器位于 `main.js` 偏移 159270 附近**，
  **其模块 id 与 121 是否一致【待验证】**。→ 我方**必须**采用上文的「id 优先 + 指纹兜底」双策略，
  且指纹字符串应选用 §0.1 中已确证的 `screensaverTransitionList`（唯一性强）。
- HugoAura 明确记录了一个失败教训：**模块未就绪时需要延迟重试**（`withRetry`）。
  因为 `app.once("browser-window-created")` 触发时目标模块可能尚未 `require` 执行。
  → 我方必须实现带退避的重试，而非一次性 `central(id)`。

**优点**：
1. **不动官方文件 [极高]**：不改 asar、不改 exe，官方完整性校验（无论是否启用）全部无感。
2. **升级鲁棒性最好 [高]**：官方 OTA 后只需重新注入，只要**指纹字符串**还在就能重新定位。
3. **可热更新 [高]**：所有逻辑在我方文件里，重启应用即可生效；配置可实时读取。
4. **回滚极简 [极高]**：删除注入即 100% 还原，无残留（只需清理配置文件目录与注册表项）。
5. **可开关粒度细 [高]**：每个功能一个 hook，可独立启停（HugoAura 即如此）。
6. **可灰度/自检 [高]**：可在安装时做自检并打印诊断（HugoAura 的 `diagLogged` 模式）。

**缺点**：
1. **依赖注入点 [中]**：需要 Electron 的 `--inspect`/`NODE_OPTIONS`/`ELECTRON_RUN_AS_NODE` 等通道，
   或修改启动参数（`BootConfig.json` 的 `cmdline`）。→ 见 §3.2 注入方案。
2. **模块 id 漂移 [中]**：官方改打包结构会失效；用指纹扫描缓解，但指纹本身也可能被改。
3. **时序竞态 [中]**：必须在目标模块**被 require 之后、被首次调用之前**完成包装。
4. **调试成本高 [中]**：minified 栈难读，需要自建诊断日志。
5. **有性能开销 [低]**：每层包装一次间接调用，对屏保这种低频路径可忽略。
6. **合规风险仍在 [高]**：绕过官方设备管控（见 §6），法律风险与路线 A 同级，**不因「不改文件」而降低**。

**适用场景**：**通用工具形态**、需要跟随官方升级、需要按需开关与热更新。

### 2.3 路线 C — 外部层（注册表 / 官方配置 / 独立进程监视）

**原理**：完全不进入官方进程，仅通过**官方公开或预留的配置面**与**操作系统级手段**施加影响。

**C1. 官方配置叠加层 `resources/autoConfiguration.json` [实证可行]**
```json
{
  "CUSTOM_CONFIG": {
    "customName": "default",
    "windowRedirect": {},
    "htmlRedirect": {}
  }
  // ★ 但经比对 8 套 customMade/*/config.json：仅含品牌/UI 字段，无任何屏保字段
}
```
→ **结论：该层只能改品牌与窗口重定向，无法配置屏保 [实证]。**
  唯一可用的技巧是 `htmlRedirect`：例如 `{"screensaver": "myScreenSaver"}` 可把屏保窗口的 HTML 重定向到
  我方页面（`main.js` 模块 3：`c.htmlRedirect && c.htmlRedirect[e] && (u.htmlName = c.htmlRedirect[e])` [实证]）。
  这是**官方语义内**唯一能替换屏保渲染层的入口 —— 但仍需我方页面文件能被打包进 asar，
  故它**不是独立路线，而是路线 A/B 的一个低风险切入点**。

**C2. 注册表 / 组策略 [部分可行，需验证]**
- 官方 `CUSTOM_CONFIG` 中含 `customName`，且 `GetRegistryString` 在模块 3 附近出现（模块 `n(21)`）[实证]，
  说明官方**会从注册表读配置**。但**具体键路径与是否含屏保开关【待验证】**。
- Windows 侧可管控的通用项：屏保由集控下发，非 Windows 系统屏保，故 `HKCU\Control Panel\Desktop` 的
  `ScreenSaveActive` **对本应用无效 [推演]**（本应用是自绘全屏窗口，不走系统屏保）。

**C3. 独立进程监视/干预 [可行但脆弱]**
1. **窗口级**：Win32 轮询/`SetWinEventHook` 监听 `screensaver_*` 窗口出现 → 立即 `PostMessage(WM_CLOSE)`。
   问题：关窗又会触发 P2 的 `startLock()`，**反而把屏保变成锁屏**，需配合发送 `closeScreenSaver`。
2. **网络级**：集控经 `SeewoProxyHTTP` 下发，可在本机代理/防火墙层丢弃 `/displayScreenSaver` 报文。
   问题：需知道端口与协议；`ports` 通过 `share("ports", ...)` 与 `RpcDiscoverFfi.dll` 动态发现，**不稳定**。
3. **进程级**：监视 `SeewoServiceAssistant.exe` 并长期挂起/注入 —— 已超出「外部层」范畴。

**优点**：
1. **零侵入 [极高]**：不改任何官方文件、不进入官方进程。
2. **合规性最好 [高]**：若仅使用官方预留配置面，可主张未规避技术措施。
3. **绝对安全 [极高]**：不可能导致应用崩溃或变砖。

**缺点**：
1. **能力极弱 [致命]**：**无法实现 N1/N2/N3/N5 中的任何一项**（官方无屏保配置面 [实证]）。
2. **`autoConfiguration.json` 会被 OTA 覆盖【待验证】**。
3. **独立进程方案脆弱**：窗口标题/类名依赖 Chromium 实现细节，且轮询有延迟与功耗。
4. **网络拦截需破解动态端口发现**，稳定性差。

**适用场景**：仅需「品牌/窗口重定向」级别的定制；或作为路线 B 的**配置存储层**复用。

### 2.4 三路线对比总表

| 维度 | A) asar 重打包 | B) 注入式 Hook | C) 外部层 |
|---|---|---|---|
| **原理** | 静态改写 asar 内 JS | 运行时劫持 webpack 模块表 | 官方配置面 / 注册表 / 外部进程 |
| **改动点** | `resources/app.asar` 内 `main.js`、`public/*.js` | 不改编官方文件；注入 `hook.js`/`preload.js` | `autoConfiguration.json`、注册表、Win32 |
| **改动官方文件** | ✅ 是（asar 被替换） | ❌ 否 | ❌ 否 |
| **能否实现 N1 禁用屏保** | ✅ | ✅ | ❌ |
| **能否实现 N2 自定义图集** | ✅ | ✅ | ⚠️ 仅靠 `htmlRedirect` 换整个页面 |
| **能否实现 N3 时长/适配** | ✅ | ✅ | ❌ |
| **能否实现 N4 转场** | ✅ | ✅ | ❌ |
| **能否实现 N5 防级联锁屏** | ✅ 最彻底（直接改 `on("close")`） | ✅ 包装 `startLock` | ⚠️ 仅窗口级抢关，易误伤 |
| **能否实现 N6 防校宣打断** | ✅ | ✅ | ❌ |
| **可维护性** | 低（每版重打包、diff 易失） | **高**（指纹定位 + 独立 hook 模块） | 中（能力太少，谈不上维护） |
| **升级鲁棒性** | ❌ 低（OTA 全丢） | ✅ **高**（重新注入即可） | ⚠️ 中（配置可能被覆盖） |
| **asar 完整性校验风险** | ⚠️ 中（fuses 待验证） | ✅ **无** | ✅ 无 |
| **Verify.json 影响** | ✅ 无（不含 asar [实证]） | ✅ 无 | ✅ 无 |
| **回滚成本** | 中（需备份原 asar，约 11 MB） | ✅ **极低**（删目录） | ✅ 极低 |
| **热更新** | ❌ 需重启且要重新打包 | ✅ **改配置即生效** | ⚠️ 部分 |
| **开关粒度** | 粗（全有全无） | ✅ **细（每功能一 hook）** | 粗 |
| **运行时性能开销** | ✅ 无 | 低（一层间接调用） | 低（但有轮询） |
| **发行体积** | 高（每版本一份 11 MB asar） | ✅ **低（几百 KB 注入器）** | 低 |
| **调试难度** | 中（可读源码？否，仍 minified） | 高（需自建诊断） | 低 |
| **变砖风险** | ⚠️ 中高（asar 损坏 → 应用拒启） | ✅ 低（删除即还原） | ✅ 无 |
| **法律/合规风险** | 高（再分发版权代码） | 高（规避技术措施） | 低-中 |
| **适用场景** | 固定版本批量固化 | **通用工具 / 跟随升级 / 按需开关** | 品牌定制 / 配置存储层 |

### 2.5 ★ 推荐方案与理由

> **推荐：路线 B 为主干，融合 C 的配置存储与 A 的 `htmlRedirect` 低风险切入点，构成「B+A′+C′」混合架构。**

**理由一：可维护性差距是数量级的。**
HugoAura 已用 `disableScreensaver.js` 证明：用 `String(onMessage).includes("screensaverTransitionList")`
这类**语义指纹**定位目标，可以在**完全不知道模块 id** 的前提下稳健命中。而路线 A 每次官方升级都要
重新解包、重新定位、重新打包、重新分发 11 MB —— 对一个「改配置」的工具而言，成本与收益严重不匹配。

**理由二：路线 C 在能力上被证伪，只能降级为组件。**
逐字比对 8 套 `customMade/*/config.json` 已确认官方配置面**不含任何屏保字段 [实证]**，
所以 C 无法独立实现 6 项需求中的任何一项。但它提供的 `autoConfiguration.json` 叠加语义
（`Object.assign({}, s, e, u)`，`u` 优先级最高）是**唯一官方语义内**的配置入口，
应当被吸收为我方配置的**分发与持久化载体**（C′）。

**理由三：路线 A 的风险分布最不利。**
A 的核心赌注是「asar 完整性校验没开」。`Verify.json` 不含 asar 只是**弱证据**（它只证明外层清单如此），
exe 内嵌 fuses 是**黑盒**【待验证】。这个赌注失败的后果是**应用完全无法启动**（变砖级），
而取得的收益（性能）对屏保这种低频路径**毫无意义**。风险收益比最差。

**理由四：B 的回滚能力是工程上的决定性优势。**
本工具的目标用户是普通教师/运维，不是逆向工程师。**「删掉目录就恢复」与「用备份 asar 覆盖」**
在真实故障场景下的成功率差异巨大 —— 尤其当用户已经忘记备份路径时。

**理由五：混合架构可让 A 的优点以低风险方式保留。**
通过 `CUSTOM_CONFIG.htmlRedirect` 把 `screensaver` 窗口指向我方页面（对方官方语义**支持且已实现** [实证]），
可以在**只改 `autoConfiguration.json`（2 KB JSON）**的前提下替换整个屏保视觉层。
这既保留了 A 的「静态、零运行时开销」，又把改动面从 11 MB asar 缩小到 1 个 JSON 文件。
**唯一前提**：我方页面文件需存在于 asar 内 → 仍需一次轻量重打包。
故本方案将其定位为**可选增强（Phase 3）**，而非主干。

**一句话结论**：**用 B 拿到能力与可维护性，用 C′ 拿到官方语义内的配置持久化，
用 A′（htmlRedirect）作为可选的零开销视觉替换，同时用 A 的完整重打包能力只作为最后的逃生舱。**

---

## 3. 推荐架构：分层设计

### 3.1 总体分层架构

采用与 HugoAura 同构、但针对屏保域收敛的**五层架构**：

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ L4  UI 层  (Electron 独立窗口 / 或纯 Web)                                      │
│     SeewoAuraForScreensaver.exe  —— 配置编辑器，读写 config.json               │
│     不依赖任何官方组件，可独立运行（离线可用）                                  │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │ 写 config.json（原子替换）
                                ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ L3  配置层  ScreensaverConfigManager（主/渲染双端同构，仿 HugoAura）           │
│     • config.json  ←→ 内存对象；默认值来源 default.json                        │
│     • 校验器 validate()：约束 switchInterval/pictureSizeType/转场长度           │
│     • 变更通知：EventBus.emit("$ss.config.changed") → hook 实时生效            │
│     • 存储位置：%USERPROFILE%\Documents\SeewoAuraSS\config.json               │
│       （备用：resources/autoConfiguration.json 叠加层，见 §3.4）                │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │ global.__SEEWO_SS__ / __SEEWO_SS_CONFIG__
                                ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ L2  注入层  （不改官方文件；由启动器加载）                                      │
│  ┌────────────────────────┐   ┌──────────────────────────────────────────┐   │
│  │ 主进程 hook.js          │   │ 渲染器 preload.js                         │   │
│  │ global.__SEEWO_SS__     │   │ global.__SEEWO_SS__ (与主进程同构)         │   │
│  │ central(id) 取模块       │   │ webpackJsonp 劫持（可选，见 §5.4）         │   │
│  │ installHook 隔离装载     │   │ 直接订阅 window._ACCEPT_DATA               │   │
│  └───────────┬────────────┘   └────────────────┬─────────────────────────┘   │
└──────────────┼─────────────────────────────────┼─────────────────────────────┘
               │ 包装单例方法                      │ getAndRegister(通道, cb)
               ▼                                  ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ L1  目标层  希沃管家主进程 / 屏保渲染器（官方代码，只读，绝不修改）              │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │ 屏保控制器单例（main.js @ 159270）                                    │    │
│  │  onMessage(e): e.url === "/displayScreenSaver"                       │    │
│  │  startScreensaver() / stopScreensaver() / closeWindow()               │    │
│  ├──────────────────────────────────────────────────────────────────────┤    │
│  │ 窗口管理（main.js @ 76173, module 69）                                │    │
│  │  newWindow("screensaver", false) → screensaver_0..N                  │    │
│  │  on("close") → closeWindow() + startLock()   ← ★ N5 根因             │    │
│  │  startLock() / closeWindow(e, t) / resetWindow(e)                     │    │
│  ├──────────────────────────────────────────────────────────────────────┤    │
│  │ 状态广播 share()（main.js @ 1821, module 2）                          │    │
│  │  share(name, value) → publishData → webContents.send("SHARE_DATA")    │    │
│  ├──────────────────────────────────────────────────────────────────────┤    │
│  │ 任务队列 enQueue/outQueue（main.js @ 40900, module 39）               │    │
│  │  forceCloseTaskList → forceCloseTask() → closedTask()                │    │
│  ├──────────────────────────────────────────────────────────────────────┤    │
│  │ 渲染器窗口（public/screensaver.js module 820）                        │    │
│  │  _ACCEPT_DATA.getAndRegister("screensaverMessage")                    │    │
│  │  点击 → ipcRenderer.send("closeScreenSaver")  ← ★ P1 路径            │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│ L0  引导层  SeewoAuraSS Launcher（独立 exe，不进官方进程）                      │
│  • 探测安装路径（注册表 Uninstall 键 / 默认 C:\Program Files\Seewo\...）       │
│  • 以官方支持的 Electron 注入方式启动 SeewoServiceAssistant.exe                │
│  • 或改写 BootConfig.json 的 cmdline（★ 有 OTA 覆盖风险，需备份）               │
│  • 安装/卸载/自检/回滚，全流程可逆                                            │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 注入方式选型（L0 层最关键的设计决策）

Electron 应用注入的可用通道，按**侵入性**从低到高：

| 方案 | 机制 | 侵入性 | 可行性 | 评价 |
|---|---|---|---|---|
| **I1 官方 preload 路径复用** | 用 `CUSTOM_CONFIG.htmlRedirect` 指向我方页面，我方 preload 自然加载 | 极低 | ⚠️ 页面须在 asar 内 | 干净但需一次重打包 |
| **I2 `NODE_OPTIONS` 环境变量** | Electron 主进程尊重 `NODE_OPTIONS=--require <hook.js>` | 低（进程级） | ⚠️ **【待验证】** | Electron 对 `--require` 有白名单限制，新版可能禁用 |
| **I3 启动器包装** | 我方 exe 先设置环境变量再 `spawn` 官方 exe | 低 | ✅ 高 | **推荐**：不改官方任何文件 |
| **I4 `--inspect` + Inspector 协议** | 启动时开调试端口，用 CDP `Runtime.evaluate` 注入 | 中 | ✅ 高 | 强大但需开端口；HugoAura 的 `reloadApp` 即追加 `--inspect 5858` |
| **I5 改写 `BootConfig.json` cmdline** | 官方启动器按该文件拼命令行 | 中 | ✅ 高 | 官方支持的配置面，**但 OTA 会覆盖** |
| **I6 替换 `resources/app.asar`** | 即路线 A | 高 | ✅ 高 | 仅作逃生舱 |
| **I7 DLL 注入 / 调试器附加** | `CreateRemoteThread` 等 | 极高 | ✅ 高 | 触发杀软，**不采用** |

**推荐组合**：`I3（启动器包装）` 为主，`I5（BootConfig cmdline）` 为备选，`I4（--inspect）` 为调试期专用。
理由：I3 完全不触碰官方文件，失败时用户直接用原始快捷方式启动即可恢复；
I4 在开发期提供无与伦比的可见性（可实时 `console`、断点、`Runtime.evaluate`），但不应作为发行方案。

> ⚠️ **【待验证】I2 的可行性**：Electron ≥ 20 对 `NODE_OPTIONS` 中的 `--require` 做了限制
> （仅允许部分选项）。必须在真机阶段 0 实测；若不可用，则 I3 必须依赖 I4 或 I5。

### 3.3 主进程 Hook 层的模块划分

```
src/
├── core/
│   ├── hook.js                 # 主进程入口，创建 global.__SEEWO_SS__，隔离装载各 hook
│   └── preload.js              # 渲染器 preload 入口（与主进程同构的配置读取）
├── init/
│   ├── configManager.js        # ScreensaverConfigManager（双端同构）
│   ├── default.json            # 默认配置（唯一真源）
│   └── moduleResolver.js       # ★ central(id) + 语义指纹兜底 + withRetry 退避重试
├── hooks/
│   ├── screensaverHook.js      # ★ N1/N2/N3/N4：包装 onMessage / 改写 share 载荷
│   ├── lockCascadeGuard.js     # ★ N5：拦截 newWindow 的 on("close") → startLock()
│   ├── forceCloseGuard.js      # ★ N6：拦截 forceCloseTask("SCREENSAVER")
│   └── rendererBridge.js       #   渲染器侧：直接订阅 _ACCEPT_DATA 覆写通道值
├── utils/
│   ├── eventBus.js             # 事件总线（照抄 HugoAura 的 Map<name, Set<cb>> + try/catch）
│   ├── logger.js               # 诊断日志（写入我方目录，不污染官方日志）
│   └── selfCheck.js            # ★ 安装期自检：指纹命中率、包装是否生效
└── ui/                         # L4 配置编辑器
```

**每个 hook 模块必须导出统一的 `hookFunc(central)` 接口**，由 `hook.js` 用
`installHook(name, path)` 逐个 `try/catch` 隔离安装 —— 这是 HugoAura 已验证的关键设计：
**任一 hook 失败只跳过它自己，不会连带中断后续 hook**（否则会出现「某功能静默失效且无迹可寻」）。

### 3.4 配置持久化：三处存储的取舍

| 载体 | 优点 | 缺点 | 用途 |
|---|---|---|---|
| `%USERPROFILE%\Documents\SeewoAuraSS\config.json` | 完全自主，OTA 不影响，用户可见易改 | 无官方语义 | ✅ **主存储**（HugoAura 同款策略） |
| `resources/autoConfiguration.json` | **官方语义内**，会被 `Object.assign` 合并进 `CUSTOM_CONFIG` | OTA 可能覆盖【待验证】；需写安装目录（可能要管理员） | 可选：分发品牌级默认值 |
| `HKEY_USERS\.DEFAULT\SOFTWARE\SeewoAuraSS` | 全局生效（所有用户/服务账户），HugoAura 同款 | 需管理员；`.DEFAULT` hive 语义特殊 | 可选：机器级策略锁 |

**推荐**：主存储用**文件**（可 diff、可备份、可版本控制），注册表仅用于「策略锁定」这种低频场景。
注意 HugoAura 的 `ConfigManager` 在写入时使用 `deepMerge(defaults, loaded)` 做**结构迁移**，
并在启用加密配置时改为异步写入 —— 我方首版**不做加密**（复杂度不值），但应保留 `schemaVersion` 字段以便未来迁移。

### 3.5 关键设计约束（源自真实契约）

这些约束**必须在代码与配置校验器中强制**，否则会出现「配置生效但界面错乱」：

| 约束 | 来源 | 强制方式 |
|---|---|---|
| `transitionList.length === imageList.length` | 主进程生成逻辑 [实证] | 校验器拒绝 + 运行时补齐 |
| 转场值 ∈ `0..6` 整数 | `Math.random()*7` [实证] | 校验器 clamp |
| `pictureSizeType ∈ {0, 1}` | `D = ["contain","cover"]` [实证] | 校验器枚举；**注意 `D[2]` 为 `undefined`** |
| `switchInterval` 单位=**秒** | `f(1000 * (data.switchInterval \|\| 15))` [实证] | 文档 + 校验器范围 1..3600 |
| `switchInterval` 为 0/falsy 时回落 15 | `\|\| 15` [实证] | **不可配 0**，校验器下限设 1 |
| `imageList` 路径中的反斜杠被再转义 | `p.replace(/\\/g, "\\\\")` [实证] | 传参时使用已转义或不含反斜杠的路径格式 |
| `textList[].content` 必填，`provenance` 可选 | 渲染逻辑 [实证] | 校验器 |
| 多显示器：窗口数 = `getAllDisplays().length` | `newWindow` 循环 [实证] | 配置的图集对所有屏**共享**，不做每屏差异化 |

---
## 4. 配置项 Schema（JSON）

### 4.1 设计原则

**配置项命名直接对齐真实字段名，不自创词汇。** 每个配置项必须能回答两个问题：
「映射到哪个真实字段？」「在哪条链路上生效？」。无法回答的配置项一律不设计。

### 4.2 完整配置示例

```json
{
  "schemaVersion": 1,
  "$comment": "SeewoAuraSS 屏保配置。字段名对齐 screensaver.js module 820 与 main.js 真实契约。",

  "enabled": true,
  "$comment_enabled": "总开关。false = 本工具完全不介入，行为与未安装一致（安全默认）。",

  "screenSaver": {
    "$comment": "映射到屏保控制器 onMessage(e) 的 /displayScreenSaver 分支",

    "disable": false,
    "$comment_disable": "N1。true = 吞掉 /displayScreenSaver，不入队、不建窗、不上报状态。",
    "disableMode": "swallow",
    "$comment_disableMode": "swallow(直接吞掉) | passthrough(放行原始逻辑)。仅 disable=true 时有效。",
    "fakeStateToServer": true,
    "$comment_fakeStateToServer": "吞掉后不向集控上报，集控仍认为屏保正常开启，避免集控判定指令未生效而重发、或在集控端留下异常记录。关掉则主动调原始 stopScreensaver() 上报 reset。",

    "payload": {
      "$comment": "映射到 r.share(\"screensaverMessage\", e.data) —— 即渲染器契约的完整载荷",
      "materialSource": "",
      "$comment_materialSource": "底部『素材来自 X』。空字符串则不显示（渲染器 y(data.materialSource || \"\")）。",
      "switchInterval": 15,
      "$comment_switchInterval": "★ 单位=秒。渲染器内部乘 1000。对应 f(1000*(data.switchInterval||15))。合法范围 1..3600；禁止 0（会被 || 15 回落）。",
      "pictureSizeType": 0,
      "$comment_pictureSizeType": "★ 只能是 0 或 1。D=[\"contain\",\"cover\"]，0=留黑边完整显示，1=裁剪铺满。其他值 → D[undefined] → 组件行为未定义。",
      "imageList": [
        "C:\\SeewoAuraSS\\images\\01.jpg",
        "C:\\SeewoAuraSS\\images\\02.jpg"
      ],
      "$comment_imageList": "★ 图片绝对路径数组。渲染前会做 p.replace(/\\\\/g,\"\\\")，传参时保持已转义形态。数组长度决定下列 transitionList 的长度。",
      "textList": [
        { "content": "每一次上课，都是一次相遇", "provenance": "校训" },
        { "content": "保持热爱，奔赴山海" }
      ],
      "$comment_textList": "图文轮播条目。content 必填；provenance 可选，存在时渲染为『- {provenance} -』。切换时随机选取（最多重试 5 次避免连续重复）。"
    },

    "transition": {
      "$comment": "映射到 r.share(\"screensaverTransitionList\", number[])",
      "mode": "random",
      "$comment_mode": "random(官方行为) | fixed(全部固定为一个值) | custom(逐张指定)。",
      "fixedIndex": 3,
      "$comment_fixedIndex": "mode=fixed 时使用。★ 必须 clamp 到 0..6 的整数。",
      "customList": [],
      "$comment_customList": "mode=custom 时使用。★ 运行时强制 length === imageList.length；不足则按 fixedIndex 补齐，超出则截断；每项 clamp 到 0..6。",
      "seed": null
      "$comment_seed": "null=每次真随机（官方行为）。整数=可复现的伪随机序列，便于多屏一致。"
    },

    "materialize": {
      "$comment": "本地图集目录的自动装载（用户放图即用，无需手写 imageList）",
      "directory": "C:\\SeewoAuraSS\\images",
      "extensions": [".jpg", ".jpeg", ".png", ".bmp", ".webp"],
      "sort": "name",
      "$comment_sort": "name | mtime | random",
      "maxCount": 200
    }
  },

  "lockCascade": {
    "$comment": "N5。★ 映射到 module 69 newWindow 的窗口 on(close) 回调 → this.closeWindow(); this.startLock()",
    "preventAfterScreensaverClose": true,
    "$comment_preventAfterScreensaverClose": "true = 屏保窗口关闭后不再级联 startLock()。这是『关屏保后自动锁屏』的唯一根因（main.js @ 76550）。",
    "scope": "screensaverOnly",
    "$comment_scope": "screensaverOnly(仅屏保窗口名匹配 /^screensaver_\\d+$/ 时抑制) | all(抑制所有窗口的级联，危险，不建议)。",
    "fallbackToCloseScreenSaver": true,
    "$comment_fallbackToCloseScreenSaver": "抑制 startLock 后，主动补发官方关闭例程，保证任务队列正常出队（避免 SCREENSAVER 任务卡在 running 态阻塞 SCREENLOCK）。"
  },

  "forceClose": {
    "$comment": "N6。★ 屏保被三处 forceCloseTaskList 强制关闭：SCREENLOCK@43831 / SCHOOLANNOUNCEMENT@172806 / LIVE@322972",
    "ignoreFrom": [],
    "$comment_ignoreFrom": "取值子集 [\"SCREENLOCK\",\"SCHOOLANNOUNCEMENT\",\"LIVE\"]。列入者强制关闭屏保时不生效。空数组=全部遵守官方行为（默认，最安全）。",
    "maxExtensions": 30,
    "$comment_maxExtensions": "忽略强制关闭的次数上限（防无限延长）。到达上限后恢复遵守官方行为。"
  },

  "renderer": {
    "$comment": "渲染器侧的可选增强（Phase 3）",
    "overrideChannels": true,
    "$comment_overrideChannels": "true = preload 直接包装 window._ACCEPT_DATA.getAndRegister，在回调入口处改写载荷。比主进程 hook 更靠后，作为双保险。",
    "enableClickToClose": true,
    "$comment_enableClickToClose": "保留 .screensaver__box__1OePhc5d 的点击关闭（渲染器 send(\"closeScreenSaver\")）。关闭后屏幕将黑屏无内容（因为已抑制锁屏），需用户自行唤醒策略。"
  },

  "diagnostics": {
    "logLevel": "info",
    "logDir": "%USERPROFILE%\\Documents\\SeewoAuraSS\\logs",
    "selfCheckOnStart": true,
    "$comment_selfCheckOnStart": "启动时校验指纹命中率（onMessage 是否含 screensaverTransitionList、screen._accept_data 是否存在），失败则整体降级为 enabled=false。"
  }
}
```

### 4.3 ★ 配置项 → 真实字段/函数 映射表

这张表是**实现与测试的唯一依据**：任何配置项都必须在此表中可追溯。

| 配置项 | 类型 | 默认 | 映射到的真实字段 / 函数 | 证据 |
|---|---|---|---|---|
| `enabled` | bool | `true` | 我方总开关，不映射官方 | — |
| `screenSaver.disable` | bool | `false` | 屏保控制器 `onMessage(e)` 中 `e.url === "/displayScreenSaver"` 分支 | main.js @ 159265 [实证] |
| `screenSaver.disableMode` | enum | `"swallow"` | 同上：`swallow`=直接 `return`；`passthrough`=调用原始 `onMessage` | [推演] |
| `screenSaver.fakeStateToServer` | bool | `true` | 是否调用原始 `stopScreensaver()`（其内含 `outQueue(SCREENSAVER)`，触发 `agent` 链路） | main.js @ 160074 [实证] |
| `payload.materialSource` | string | `""` | `screensaverMessage.materialSource` → 渲染器 `y(data.materialSource \|\| "")` | screensaver.js module 820 [实证] |
| `payload.switchInterval` | int(秒) | `15` | `screensaverMessage.switchInterval` → `f(1000 * (data.switchInterval \|\| 15))` | 同上 [实证] |
| `payload.pictureSizeType` | `0\|1` | `0` | `screensaverMessage.pictureSizeType` → `x(D[data.pictureSizeType \|\| 0])`，`D=["contain","cover"]` | 同上 [实证] |
| `payload.imageList` | string[] | `[]` | `screensaverMessage.imageList` → `s(data.imageList.map(p => p.replace(/\\/g,"\\")))` | 同上 [实证] |
| `payload.textList[].content` | string | — | `textList[i].content` → `J[j].content` | 同上 [实证] |
| `payload.textList[].provenance` | string? | — | `textList[i].provenance` → `"- " + J[j].provenance + " -"` | 同上 [实证] |
| `transition.mode` | enum | `"random"` | 主进程 `((e,t=7)=>{...Math.random()*t})(imageList.length)` 的替换实现 | main.js @ 159504 [实证] |
| `transition.fixedIndex` / `customList` | int / int[] | `3` / `[]` | `screensaverTransitionList`，经 `share(name, value)` 下发 | 同上 [实证] |
| `materialize.directory` | path | — | 我方扫描后填充 `payload.imageList` | [推演] |
| `lockCascade.preventAfterScreensaverClose` | bool | `true` | module 69 `newWindow` 的 `r.on("close", () => setTimeout(() => { this.closeWindow(), this.startLock() }, 0))` | main.js @ 76550 [实证] |
| `lockCascade.scope` | enum | `"screensaverOnly"` | 窗口名匹配 `screensaver_<n>`（由 `e + "_" + t` 生成） | main.js @ 76173 [实证] |
| `lockCascade.fallbackToCloseScreenSaver` | bool | `true` | 补调 `closeWindow("screensaver", !1)` 保证队列出队 | main.js @ 160074 [实证] |
| `forceClose.ignoreFrom` | string[] | `[]` | 任务队列 `forceCloseTask(e)` → `tasksMaps.get(e).closedTask()` 的调用点 | main.js @ 42500 [实证] |
| `forceClose.maxExtensions` | int | `30` | 我方计数，非官方字段 | [推演] |
| `renderer.overrideChannels` | bool | `true` | `window._ACCEPT_DATA.getAndRegister(name, cb)` | preLoad.js [实证] |
| `renderer.enableClickToClose` | bool | `true` | 渲染器 `onClick: () => W.a.send("closeScreenSaver")` | screensaver.js module 820 [实证] |

### 4.4 校验器规则（必须在写入前与读取后各执行一次）

```js
function validate(cfg, imageCount) {
  const errs = [];
  const p = cfg.screenSaver?.payload ?? {};

  // 1) switchInterval —— 秒；禁止 0（会被 || 15 静默回落，造成『配置了却不生效』的困惑）
  if (p.switchInterval != null) {
    if (!Number.isInteger(p.switchInterval)) errs.push("switchInterval 必须是整数（秒）");
    else if (p.switchInterval < 1)       errs.push("switchInterval 最小为 1 秒（0 会被 || 15 回落）");
    else if (p.switchInterval > 3600)    errs.push("switchInterval 上限 3600 秒");
  }

  // 2) pictureSizeType —— 只接受 0/1（D[其他值] === undefined，组件行为未定义）
  if (p.pictureSizeType != null && ![0, 1].includes(p.pictureSizeType))
    errs.push("pictureSizeType 只能是 0(contain) 或 1(cover)");

  // 3) textList —— content 必填
  (p.textList ?? []).forEach((t, i) => {
    if (typeof t?.content !== "string" || t.content.length === 0)
      errs.push(`textList[${i}].content 必填且非空`);
  });

  // 4) 转场 —— 长度必须等于图数，值必须 clamp 到 0..6
  const n = imageCount ?? (p.imageList ?? []).length;
  const tr = cfg.screenSaver?.transition ?? {};
  if (tr.mode === "custom") {
    const list = tr.customList ?? [];
    if (list.length !== n) errs.push(`customList 长度(${list.length}) 必须等于图片数(${n})`);
    list.forEach((v, i) => {
      if (!Number.isInteger(v) || v < 0 || v > 6) errs.push(`customList[${i}]=${v} 超出 0..6`);
    });
  }
  if (tr.mode === "fixed" && (tr.fixedIndex < 0 || tr.fixedIndex > 6))
    errs.push("fixedIndex 必须在 0..6");

  // 5) forceClose.ignoreFrom 值域
  const allowed = ["SCREENLOCK", "SCHOOLANNOUNCEMENT", "LIVE"];
  (cfg.forceClose?.ignoreFrom ?? []).forEach(v => {
    if (!allowed.includes(v)) errs.push(`forceClose.ignoreFrom 含未知任务名 ${v}`);
  });

  return { ok: errs.length === 0, errs };
}

// ★ 运行时兜底：无论如何都保证长度一致、值域合法（防御用户手改 config.json）
function materializeTransitions(cfg, imageCount) {
  const tr = cfg.screenSaver?.transition ?? {};
  const clamp = v => Math.max(0, Math.min(6, v | 0));
  const out = new Array(imageCount).fill(0);
  if (tr.mode === "fixed")      out.fill(clamp(tr.fixedIndex ?? 0));
  else if (tr.mode === "custom") {
    for (let i = 0; i < imageCount; i++) out[i] = clamp(tr.customList?.[i] ?? tr.fixedIndex ?? 0);
  } else {
    for (let i = 0; i < imageCount; i++)
      out[i] = Math.floor((tr.seed == null ? Math.random() : prng(tr.seed, i)) * 7);
  }
  return out;   // ★ 保证 out.length === imageCount，且每项 ∈ 0..6
}
```

---
## 5. 精确 Hook 点清单

### 5.1 主进程侧 Hook 点（按优先级排序）

**HP-1 ★ N1/N2/N3/N4 — 屏保控制器 `onMessage`（最高优先级）**

| 项 | 值 |
|---|---|
| 目标对象 | 屏保控制器**单例实例**（`const u = new class { ... }`，`main.js` @ 159270） |
| 定位方式 | ① 先按模块 id 尝试（HugoAura 用 `121`，**本版是否一致【待验证】**）；② 失败则遍历 `central.m`，用指纹 `String(factory).includes("screensaverTransitionList")` 定位；③ 再以 `isScreensaverManager()` 结构自检 |
| 拦截点 | `onMessage(e)` 的整体包装 |
| 生效条件 | `e.url === "/displayScreenSaver"` |
| 改什么 | ① `disable=true` → 直接 `return`（并可选伪造状态）；② 否则**在调用原 `onMessage` 前改写 `e.data`**：覆写 `materialSource` / `switchInterval` / `pictureSizeType` / `imageList` / `textList` |
| 为什么在此拦截 | 这是**渲染器契约的唯一入口**——`r.share(\"screensaverMessage\", e.data)` 直接把 `e.data` 原样下发。改 `e.data` 即改渲染器看到的一切，**无需碰渲染器** |
| 风险 | 若官方改变 `e.data` 结构，改写会静默失效 → 必须有自检日志 |

```js
// screensaverHook.js 核心逻辑（示意）
const orig = mgr.onMessage.bind(mgr);
mgr.onMessage = function (e) {
  if (e && e.url === "/displayScreenSaver") {
    const cfg = readConfig();
    if (cfg.enabled && cfg.screenSaver.disable) {
      log.info("[SS] 拦截 /displayScreenSaver");
      if (!cfg.screenSaver.fakeStateToServer) safeCall(mgr.stopScreensaver);  // 可选：上报重置
      return;   // ★ 吞掉，不入队
    }
    e.data = applyPayloadOverrides(e.data, cfg);   // ★ N2/N3 在此生效
  }
  return orig(e);   // 转场数组仍由官方生成，我们在 HP-2 覆写
};
```

**HP-2 ★ N4 — 转场数组下发通道 `share("screensaverTransitionList", ...)`**

| 项 | 值 |
|---|---|
| 目标对象 | 状态广播单例 `share(e, t, n)`（`main.js` @ 1821，`module 2`） |
| 定位方式 | 结构指纹：实例同时具有 `share` / `publishData` / `setData` / `getData` 四个方法，且 `shareData` / `storeData` 两个字段 |
| 拦截点 | `share(name, value)` 中 `name === "screensaverTransitionList"` |
| 改什么 | 将 `value` 替换为我方 `materializeTransitions(cfg, imageCount)` 的结果 |
| 注意 | 官方生成时用 `e.data.imageList.length` 作为长度 [实证]。我方**必须**用同一个 `imageCount` 计算，否则长度不一致 |
| 为何不选 HP-1 | `share` 调用发生在 `enQueue` **之前**、`onMessage` 内部。包装 `onMessage` 无法直接改 `share` 的入参（除非重复调用 `share` 覆盖）——**两种实现都可行，包装 `share` 更干净** |

**HP-3 ★★ N5 — 级联锁屏根因（本方案最重要的 hook）**

| 项 | 值 |
|---|---|
| 目标对象 | 窗口管理单例（`main.js` @ 76173，`n(69)`；HugoAura 记作 module 69，**本版【待验证】**） |
| 定位方式 | 结构指纹：实例具有 `newWindow` / `closeWindow` / `resetWindow` / `startLock` / `windowsList` 五个成员。**这是最强的指纹组合**——全应用同时具备 `startLock` 与 `newWindow` 的单例极可能唯一 |
| 拦截点 A（推荐） | 包装 `startLock()` 本身：若**当前调用栈来自屏保窗口 close 回调**则跳过 |
| 拦截点 B（更精准） | 替换 `r.on("close", ...)` 回调的安装：在 `newWindow` 包装中，对 `windowName` 匹配 `/^screensaver_\d+$/` 的窗口，重新注册我方回调（先 `removeAllListeners("close")` 再挂我方版本） |
| 改什么 | 跳过 `this.startLock()`，但**必须**保留 `this.closeWindow()` 与任务队列出队，否则 `SCREENSAVER` 任务会卡在 running 态，进而阻塞 `SCREENLOCK`（因其 `taskDependencies` 含 `SCREENSAVER`） |
| 关键鉴别 | 用 `new Error().stack` 判断调用来源会因 minified 而脆弱 → **推荐拦截点 B**：直接不安装官方的 close 回调，从根上消除级联，无栈判断开销 |
| 回退 | 若无法可靠识别窗口名，退化为拦截点 A（包装 `startLock`），并用「短时间内 `screensaver_*` 窗口刚关闭」作为启发式条件 |

```js
// lockCascadeGuard.js 核心逻辑（推荐实现：拦截点 B）
const origNewWindow = winMgr.newWindow.bind(winMgr);
winMgr.newWindow = function (typeName, hookKeyboard) {
  const r = origNewWindow(typeName, hookKeyboard);
  const cfg = readConfig();
  if (typeName === "screensaver" && cfg.enabled && cfg.lockCascade.preventAfterScreensaverClose) {
    const list = winMgr.windowsList[typeName] || [];
    for (const name of list) {
      const w = resolveWindowByName(name);        // 见 §5.3 窗口解析
      if (!w) continue;
      w.removeAllListeners("close");              // ★ 摘掉官方的 close → startLock
      w.on("close", () => {
        setTimeout(() => {
          safeCall(() => winMgr.closeWindow("screensaver", false));   // 保留官方清理
          // ★ 不再调用 winMgr.startLock()
          if (cfg.lockCascade.fallbackToCloseScreenSaver)
            safeCall(() => queueOut("SCREENSAVER"));                  // 保证出队
        }, 0);
      });
    }
  }
  return r;
};
```

**HP-4 — N6 强制关闭拦截 `forceCloseTask`**

| 项 | 值 |
|---|---|
| 目标对象 | 任务队列单例（`main.js` @ 40900，`module 39`） |
| 定位方式 | 结构指纹：实例具有 `enQueue` / `outQueue` / `tasksMaps` / `tasksDependedMaps` / `forceCloseTask` |
| 拦截点 | `forceCloseTask(taskName)` 中 `taskName === "SCREENSAVER"` |
| 改什么 | 若当前正在运行的强制关闭来源任务 ∈ `config.forceClose.ignoreFrom`，则跳过 `closedTask()` 调用 |
| 难点 | `forceCloseTask(e)` **只接收任务名**，拿不到「谁在强制关闭我」 → 需要包装 `outQueue(taskName)` 来记录当前出队的任务名作为上下文（模块 39 的 `outQueue` 在 `forceCloseTaskList.map` **之前**执行 `tasksMaps.delete`，故可用闭包变量传递） |
| 风险 | **中等**。跳过强制关闭会让 `SCREENSAVER` 与 `SCHOOLANNOUNCEMENT`/`LIVE` 的服务端状态不一致。建议默认 `ignoreFrom: []`，仅对明确需求开启，并受 `maxExtensions` 限制 |

**HP-5 — 渲染器数据总线（Phase 3，双保险）**

| 项 | 值 |
|---|---|
| 目标对象 | `window._ACCEPT_DATA`（由 `public/preLoad.js` 实例化并挂到 window） |
| 定位方式 | `preLoad.js` 中 `this.start()` 后 `window._ACCEPT_DATA = c`，且有 `getAndRegister` / `register` / `getData` / `removeOne` |
| 拦截点 | 包装 `_ACCEPT_DATA.register(name, cb)`：当 `name` 为 `screensaverMessage` 或 `screensaverTransitionList` 时，用我方包装函数替换 `cb` |
| 改什么 | 在回调**入口**改写载荷。因为 `getAndRegister(name, cb)` 的实现是 `cb(getData(name)); register(name, cb)`，**必须在注册时包装**，否则首帧数据已按原值渲染 |
| 价值 | 即使主进程侧的 `e.data` 改写因版本变化失效，渲染器侧仍能兜底。**两侧同时失效的概率极低** |
| 注意 | 包装必须在 `screensaver.js` 的 `require` 执行前安装 —— 即 preload 阶段。我方 preload 需保证在 `preLoad.js` **之后**、`screensaver.js` **之前**执行 |

### 5.2 Hook 点汇总表

| ID | 需求 | 目标标识符 | 拦截方法 | 定位指纹 | 优先级 |
|---|---|---|---|---|---|
| HP-1 | N1/N2/N3 | 屏保控制器单例 `.onMessage` | 包装方法 | `String(onMessage).includes("screensaverTransitionList")` | P0 |
| HP-2 | N4 | 状态广播单例 `.share` | 包装方法（按 `name` 分支） | 具备 `share/publishData/setData/getData` | P0 |
| HP-3 | **N5** | 窗口管理单例 `.newWindow` + 窗口 `close` 事件 | 重装 close 监听 | 具备 `newWindow/closeWindow/startLock/windowsList` | **P0** |
| HP-4 | N6 | 任务队列单例 `.forceCloseTask` / `.outQueue` | 包装方法 | 具备 `enQueue/outQueue/tasksMaps` | P1 |
| HP-5 | N2/N3/N4 兜底 | `window._ACCEPT_DATA.register` | 包装方法 | preload 内的 `getAndRegister` | P1 |

### 5.3 关键技术难点：如何从 `windowsList` 拿到 BrowserWindow 实例

`newWindow` 的循环体为 `let r = s.addOne(e, e + "_" + t)` [实证]，返回的是 **BrowserWindow 实例**，
但实例被存入 `this.windowsList[e].push(e + "_" + t)` —— **只存了字符串名，没存实例**。
而 `s` 是窗口注册表单例（`main.js` @ 76000 附近），具备 `getInstance(name)` / `addOne` / `destroy` / `clearInstance` / `getAllWindows()`。

→ **因此 HP-3 的拦截点 B 需要先解析出注册表单例 `s`**，再 `s.getInstance("screensaver_0")` 拿到实例。
这是本方案**最需要真机验证的一环**【待验证】。若无法解析，退回拦截点 A（包装 `startLock`）。

```js
// 窗口注册表单例的定位（模块 3 路径，见 main.js @ 76000 附近）
// 指纹：同时具有 getInstance / addOne / destroy / clearInstance / getAllWindows / windows 字段
const isWindowRegistry = (v) =>
  v && typeof v.getInstance === "function" && typeof v.addOne === "function"
    && typeof v.destroy === "function" && typeof v.getAllWindows === "function"
    && v.windows && typeof v.windows === "object";

// 兜底：直接遍历 Electron 原生窗口，用 URL 中的 windowName 识别（完全不依赖官方模块）
const { BrowserWindow } = require("electron");
function resolveScreensaverWindows() {
  return BrowserWindow.getAllWindows().filter(w => {
    try { return /windowName=screensaver_\d+/.test(w.webContents.getURL()); }
    catch { return false; }
  });
}
// ★ screensaver.html 从 URL query 读取 windowName（逐字实证），故此法可靠且最稳
```

> **重要**：`screensaver.html` 中的 `getUrlParams()` 解析 `window.location.search`，
> 并设 `window.windowName = window.urlParams.windowName` [实证]；
> 而窗口是经 `file://.../screensaver.html?windowName=screensaver_0` 形式加载的。
> 因此**用 `webContents.getURL()` 正则匹配 `windowName=screensaver_\d+`** 是最稳定的识别手段，
> **完全不需要解析官方模块**。建议作为 HP-3 的**首选实现**，模块指纹作为冗余。

### 5.4 渲染器侧 webpack 劫持是否必要？

HugoAura 的 `webpackHook.js` 通过 `Object.defineProperty(window, "webpackJsonp", { set })` 劫持 chunk 装载，
再用 `eval` 把每个模块工厂函数 `toString()` 后做特征匹配，最后替换 `modules[index]`。

**结论：屏保场景下不必要。** 理由：
1. 屏保渲染器的全部行为都由 `window._ACCEPT_DATA` 的两个通道驱动，**HP-5 的通道包装已足够**。
2. webpack 劫持需 `eval` 模块源码，**触发杀软启发式规则的风险显著更高**。
3. `patchModules` 会替换整个模块工厂，一旦特征误匹配会破坏无关功能，风险面大。
4. 我方需要的是**数据覆写**（HP-5），不是**组件替换**，通道层是更窄、更可控的切面。

→ **采用 HP-5，不实现 webpack 劫持。** 若未来需要替换屏保**视觉组件本身**，
再考虑 HugoAura 的 `reactComponent` hook 方法（其 `preHook(mod)` 模式），或直接用路线 A′ 的 `htmlRedirect`。

### 5.5 Hook 点与参考实现的对应关系

| Hook 点 | 参考实现文件 | 已由测试覆盖 |
|---|---|---|
| HP-1 吞掉 `/displayScreenSaver` | `src/hooks/screensaverHook.js` → `handleMessage` | ✅ `screensaverHook.test.js` |
| HP-2 包装控制器 `onMessage` | `src/hooks/screensaverHook.js` → `wrap` | ✅ 幂等/回滚用例 |
| HP-5 改写 `screensaverMessage` 载荷 | `src/hooks/screensaverHook.js` → `rewriteMessage` | ✅ 字段契约用例 |
| HP-3 切断 close→`startLock` 级联 | `src/hooks/lockCascadeGuard.js` | ✅ `lockCascadeGuard.test.js` |
| 模块定位（版本漂移时重定位） | `src/module/findModule.js` | ✅ 含真实 bundle 验证用例 |

> 测试状态：`node --test 'test/**/*.test.js'` → **41 passed / 0 failed**（实测）。
> 其中「真实 bundle 验证」用例直接读取 `.work/app/main.js`，断言
> `taskConstants=38 / windowManager=69 / taskQueue=39 / screenLock=40 / screensaverController=120`
> 且 `verified=true`，证明模块定位逻辑在**真实产物**上成立，而非仅通过合成夹具。

---

## 6. 风险、合规与失效分析

### 6.1 技术风险矩阵

| 风险 | 触发条件 | 影响 | 等级 | 缓解措施 |
|---|---|---|---|---|
| **管家升级导致锚点失效** | 官方发版重打包 | 注入点找不到，功能静默失效 | 高 | ①`findModule` 找不到返回 `null` 而非抛错；②启动时全锚点自检并在 UI 显式告警；③提供 `dumpModuleIds` 诊断脚本便于快速重新标定 |
| **误伤其它业务** | hook 范围过宽 | 屏幕锁/直播/校园广播异常 | 高 | ①只匹配 `"/displayScreenSaver"` 单一路由；②只对 `type === "screensaver"` 的窗口生效；③非目标路由原样透传（已由测试锁定） |
| **远程锁屏失效** | 粗暴全局禁用 `startLock` | **设备失去锁屏保护** | **极高** | ⛔ 禁止全局禁用；只切断「屏保 close → startLock」这一条来源。云端锁屏指令（`messageType===1211`）与 `userLock()` 必须保持可用 |
| **锁屏窗口自愈被破坏** | 错误地包装 `screenLock_*` 窗口 | 锁屏窗口崩溃后无法恢复 | 高 | 守卫只作用于屏保窗口类型；`screenLock` 窗口走原逻辑（已由测试锁定） |
| **配置写入损坏** | 断电/并发写 | 配置丢失或半截 JSON | 中 | 原子写（临时文件 + rename）+ 备份轮转 + 损坏隔离（`configManager` 已实现） |
| **静默数据损坏** | 非法输入被"猜测"修正 | 用户配置被篡改且无提示 | 中 | 校验器对非整数 `switchInterval` 直接报错而非 `Math.floor` 截断（本次已修复并加回归测试） |
| **杀软误报** | 进程注入/写他人安装目录 | 被拦截或隔离 | 中 | 优先路线 B（不动官方文件）；不 `eval` 模块源码；如需写盘则显式提示用户加白 |
| **多显示器行为异常** | 每屏一个窗口 | 只在主屏生效/重复窗口 | 低 | 沿用官方 `getAllDisplays()` 逐屏创建语义，不改变窗口数量 |
| **反注入加固** | 官方转向强校验 | 方案整体失效 | 中 | 保留路线 C（外部层）作为兜底；不把全部体验押在单一注入点 |

### 6.2 关键安全边界（必须遵守）

1. **绝不全局禁用 `startLock` / `startLockTask`。**
   云端远程锁屏（`messageType === 1211 && screenLockStatus === 1`）与本地 `userLock()`
   是设备管理的基本保障，禁用会让设备失去锁屏能力，属于**安全降级**且可能违反学校管理要求。
2. **只允许"来源定向"拦截。** 正确做法是在屏保窗口的 `close` 回调层面切断级联，
   而不是在锁屏控制器入口处拦截。
3. **保留手动关闭通道。** 渲染器点击发送 `closeScreenSaver` 是用户主动退出屏保的正常路径，
   不得连带破坏。
4. **所有 hook 必须可完整回滚**（`uninstall()` 还原原始函数引用），便于出问题时立即恢复官方行为。

### 6.3 许可证与合规

| 事项 | 结论 |
|---|---|
| **HugoAura-Enhanced 许可证** | **GNU GPL-3.0**（仓库根 `LICENSE`，35,129 bytes）。⚠️ **具有传染性** |
| 直接复制 HugoAura 代码 | 本项目若复制其代码片段，**整体必须以 GPL-3.0 开源并保留版权声明** |
| 仅参考架构思路 | 思路/方法不受版权保护，但**表达（代码）受保护**。建议：独立实现，不逐行移植 |
| 官方软件许可 | 希沃管家为商业软件，受其 EULA 与著作权法保护 |
| 本项目定位 | **仅供个人学习、研究与设备自管理**；不得用于绕过学校/单位的管理策略、不得再分发官方二进制 |
| 建议做法 | ①本项目自立许可证（如 MIT）**但不得包含 HugoAura 代码**；②若确需复用，整体切 GPL-3.0 并注明来源；③在 README 显著位置写明免责声明 |

> ⚠️ **合规红线**：修改集控类软件的锁屏/上报/远程管理能力，在受管理的教育设备上
> 可能违反校方管理规定乃至相关法规。使用者需自行确认场景合法合规。

### 6.4 官方校验面

| 校验物 | 观察到的内容 | 影响 |
|---|---|---|
| `Verify.json` | 5,616 bytes，位于安装根目录 | 可能含文件完整性/签名校验清单；**修改官方文件（路线 A）有触发风险** |
| `Firewall.json` | 37 bytes | 防火墙规则配置 |
| `BootConfig.json` | 含 `needGuard:true` | **有守护进程**；直接杀进程可能被拉起 |

→ 这进一步支持**路线 B（注入，不改官方文件）**优于**路线 A（重打包）**。

---

## 7. 分阶段实施路线图

### 阶段 0：离线验证（无设备风险）— 建议 1~2 天
- [x] 解包 `.7z` 与 `app.asar`，建立只读分析基线（`.work/`，不修改原文件）
- [x] 定位屏保控制器、窗口管理器、任务队列的真实实现
- [x] 解码渲染器数据契约（`materialSource`/`switchInterval`/`pictureSizeType`/`imageList`/`textList`）
- [x] 建立模块定位器并在**真实 bundle** 上验证（38/69/39/40/120 全部 `verified=true`）
- **产出**：`FINDINGS.md`、`RENDERER_CONTRACT.md`、`CASCADE_ANALYSIS.md`、`docs/DESIGN.md`

### 阶段 1：核心能力（不改官方文件）
- [x] `ScreensaverHook`：禁用屏保 / 自定义图集 / 转场规整
- [x] `LockCascadeGuard`：切断 close→`startLock` 级联（**定向**，不影响远程锁屏）
- [x] `ConfigManager`：原子写 + 校验 + 备份 + 损坏隔离
- [x] `IPC handler`：配置读写与状态查询
- [x] 单元测试 **41 项全绿**（含真实 bundle 验证）
- **验收**：`node --test 'test/**/*.test.js'` 全绿；`require('./src/index.js')` 无 electron 依赖

### 阶段 2：注入器与真机灰度
- [ ] 实现 preload 注入器，加载 `src/index.js` 并注入真实 `controller`/`windowManager`/`ipcMain`
- [ ] 在**测试机**上验证：禁用屏保生效、关闭后不锁屏、远程锁屏仍可用
- [ ] 加入启动自检与降级：任一 hook 安装失败 → 记录日志并保持官方行为
- **验收**：真机三条路径（禁用/自定义/不锁屏）均可用，且**远程锁屏回归通过**

### 阶段 3：配置 UI 与易用性
- [ ] 提供图形配置界面（或 JSON 编辑 + 实时校验提示）
- [ ] 图集选择、按秒设置间隔、contain/cover 切换、图文条目编辑
- [ ] 一键还原出厂行为（`uninstall` 全部 hook）
- **验收**：非技术用户可独立完成配置并安全回滚

### 阶段 4：健壮性与长期维护
- [ ] 管家升级后自动锚点自检 + 告警
- [ ] 配置schema 版本迁移机制
- [ ] 审计日志（谁在何时改了什么）
- **验收**：升级后能在 UI 明确提示"锚点失效，需重新标定"，而非静默失效

---

## 8. 结论

1. **推荐路线 B（注入式 Hook）**，理由是：不改官方文件、可热更新、可完整回滚，
   且能绕过 `Verify.json`/`BootConfig.needGuard` 带来的重打包风险。
2. **屏保的可控面比想象中大**：一旦拿到 `screensaverMessage` 载荷，
   图片集、停留时长、适配模式、图文、署名、转场全部可控，无需触碰渲染器代码。
3. **唯一需要谨慎的是锁屏级联**：必须"定点切断"而非"全局禁用"，
   否则会让云端远程锁屏一并失效 —— 这是本方案最重要的安全边界。
4. **当前交付物已验证**：41 项测试全绿，模块定位在真实 bundle 上 `verified=true`，
   配置校验对静默数据损坏做了回归防护。

> 遗留事项：注入器（阶段 2）尚未实现；真机验证需在希沃设备上进行，本环境无法完成。
> DeepSeek 分享链接内容因 403 不可读，若其中包含额外的功能诉求，需据此调整配置项设计。
