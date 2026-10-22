# tools/patch-asar.js —— 屏保 hook 注入器

把「**关闭屏保** + **深度配置屏保**」的 hook 注入希沃管家 `resources/app.asar`。

> 依据：`.work/FINDINGS.md`、`.work/RENDERER_CONTRACT.md`、`.work/CASCADE_ANALYSIS.md`、
> `docs/对话勘误与结论.md`。所有关键结论都在**真实 `app.asar`** 上实测过（见下文「实测记录」）。

---

## 1. 快速开始

```bash
# 只输出计划，不写任何文件
node tools/patch-asar.js --dry-run

# 自动探测安装目录并原地打补丁（自动备份 app.asar.bak）
node tools/patch-asar.js

# 显式指定 asar
node tools/patch-asar.js --target "C:\Program Files\Seewo\SeewoServiceAssistant\resources\app.asar"

# 输出到别处（不碰目标文件，适合先验证）
node tools/patch-asar.js --target <src.asar> --out <new.asar>

# 指定初始配置
node tools/patch-asar.js --config my-config.json

# 还原
node tools/patch-asar.js --target <path> --restore
```

| 选项 | 说明 |
|---|---|
| `--dry-run` | 只输出计划，**不写任何文件** |
| `--target <path>` | 指定 `app.asar`（默认自动探测希沃安装目录） |
| `--out <path>` | 输出到指定路径；**不备份、不修改目标**（自测/预览用） |
| `--config <json>` | 注入的初始配置（JSON 文件） |
| `--restore` | 从 `app.asar.bak` 还原 |
| `--force` | 备份已存在时覆盖备份（默认**保留**旧备份） |
| `-h, --help` | 帮助 |

**默认行为**：备份 → 备份已存在则保留不覆盖 → 写出新的 `app.asar`。
**产物可逆**：`--restore`，或手工把 `app.asar.bak` 覆盖回 `app.asar`。

---

## 2. 它到底改了什么

只改 `app.asar` 内的 `main.js` 两个地方，**不动任何业务代码**：

### 注入点 A：bootstrap 尾部（暴露 webpack require）

```diff
- n.p="",n(n.s=140)}([
+ n.p="",global.__AURA_REQ__=n,(function(){try{return n(n.s=140);}catch(e){...}}())([
```

**为什么必须在这里**：webpack require（变量 `n`）和模块表（`e`/`t`）都是外层 IIFE 的
**局部变量**，外部代码够不着，必须从 IIFE 内部挂到 global。
锚点用正则 `/n\.p="",n\(n\.s=(\d+)\)\}\(\[/` 定位，**不硬编码入口 id**（版本变了也能命中）。

同时把入口调用包进 `try/catch`：这样**即使官方入口抛异常，文件末尾的加载器仍会执行**
（派生的错误用 `setTimeout` 异步重抛，官方「入口异常即终止」的语义不变）。

### 注入点 B：文件末尾追加加载器

```js
... 原 bundle 结尾： ...e.exports=h}]);      ← 注意是以 ");" 收尾
/* ===== aura-screensaver injection BEGIN ===== */
globalThis.__AURA_INLINE_CONFIG__ = {...};
<tools/payload/aura-screensaver-loader.js 全文>
/* ===== aura-screensaver injection END ===== */
```

**为什么末尾合法**：整个 bundle 是一条完整表达式语句，末尾是 `]);`（实测末三字符
`']' ')' ';'`），追加的是独立语句，语法合法；且此时入口已执行完，
所需模块都能从 require 缓存取出**同一个单例**。

---

## 3. 加载器的三项能力

加载器是**单文件自包含**的（`tools/payload/aura-screensaver-loader.js`），
不依赖 `node_modules`、不依赖本仓库其它文件。

| # | 能力 | 实现 | 依据 |
|---|---|---|---|
| **a** | **关闭屏保** | 包装 `req(120).onMessage`，`url === "/displayScreenSaver"` 且配置为禁用时直接 `return`（不入队、不广播） | 主进程控制器原文 |
| **b** | **深度配置** | 改写下发载荷 `materialSource` / `switchInterval`(秒) / `pictureSizeType`(0=contain,1=cover) / `imageList` / `textList`，并预广播长度正确的 `screensaverTransitionList` | `public/screensaver.js` 逐字解码 |
| **c** | **切断 close→startLock 级联** | 在 `req(69)`（窗口管理器）实例上放一个受控 `startLock` 陷阱；**不碰** `req(40)`（屏幕锁控制器） | `.work/CASCADE_ANALYSIS.md` |

### 关于能力 a 为什么选「吞消息」而不是「关窗口」

官方 `module 69.newWindow` 注册了
`r.on("close", () => setTimeout(() => { this.closeWindow(); this.startLock(); }, 0))`。
**关窗口会触发这条级联**，所以拦截 `/displayScreenSaver` 是更干净的做法 ——
消息根本没进队列，也就不会有窗口可关。

### 关于能力 c 的安全边界（重要）

`.work/CASCADE_ANALYSIS.md` 指出官方 module 69 的 close 回调调用了**它自己不存在的**
`startLock()`（确定性缺陷），所以 v1.2.7 关屏保其实不会锁屏。
但**若官方修好这段代码**，就会变成「关掉即锁屏」。

本工具在窗口管理器实例上放置受控实现：
- 官方本无该方法 → 消除 `TypeError`，且不进入锁屏；
- 官方已有该方法 → **记录在案**（日志会写明「官方存在同名方法，已抑制调用」）。
- `req(40)` 屏幕锁控制器的 `startLock`/`startLockTask`/`userLock` **一概不碰**，
  因此**云端远程锁屏**（`messageType === 1211`）与**本地主动锁屏**不受影响。

想恢复官方级联行为：把配置 `lockCascadeOnClose` 设为 `true`（此时不安装陷阱）。

---

## 4. 配置文件

优先级：**外部配置文件 > 内嵌配置（`--config` 写入） > 内置默认值**。
外部配置优先，是为了让用户**改配置不必重新打补丁**。

外部配置路径：`%APPDATA%\seewo\AuraScreensaver\config.json`
（可用环境变量 `AURA_SCREENSAVER_CONFIG` 覆盖为任意路径）

```json
{
  "screensaverEnabled": false,
  "lockCascadeOnClose": false,
  "logLevel": "info",
  "override": {
    "materialSource": "我的图集",
    "switchInterval": 8,
    "pictureSizeType": 1,
    "imageList": ["C:\\pics\\1.jpg", "C:\\pics\\2.jpg", "C:\\pics\\3.jpg"],
    "textList": [{ "content": "欢迎", "provenance": "校办" }],
    "transitionList": null
  }
}
```

| 字段 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `screensaverEnabled` | bool | `false` | `false` = **关闭屏保**（吞掉 `/displayScreenSaver`） |
| `lockCascadeOnClose` | bool | `false` | `false` = 切断「关屏保→锁屏」级联 |
| `override` | object\|null | `null` | 图集覆盖；`null` = 沿用云端下发数据 |
| `override.switchInterval` | int | 15 | 停留时长，**单位=秒**（渲染器内部 ×1000） |
| `override.pictureSizeType` | 0\|1 | 0 | **0=contain 留边完整显示；1=cover 裁剪铺满** |
| `override.imageList` | string[] | [] | 图片路径数组 |
| `override.textList` | object[] | [] | `{ content, provenance? }` |
| `override.transitionList` | number[]\|null | null | 长度**必须** = 图片数，值域 **0..6**；null = 官方随机算法 |
| `logLevel` | string | info | debug/info/warn/error/silent |

> ⚠️ 契约细节（易错点，来自 `.work/RENDERER_CONTRACT.md`）：
> `pictureSizeType` 是**数字索引**而非字符串（渲染器 `D = ["contain","cover"]`）；
> `switchInterval` 单位是**秒**；`transitionList` 长度必须等于图片数。

日志写到 `%APPDATA%\seewo\AuraScreensaver\aura-screensaver.log`（同时打 stdout）。

---

## 5. 安全性 / 可逆性

- **绝不阻断官方启动**：加载器每一步都在 `try/catch` 里，任何失败只写日志；
  最外层还有兜底 `try { boot(); } catch {}`。找不到锚点时**安全放弃**，不写任何文件。
- **幂等**：产物含 `injection BEGIN` 标记，重复打补丁会被拒绝；加载器内部也有
  `installed` 检查。
- **可逆**：默认备份 `app.asar.bak` 且**不覆盖已有备份**；`--restore` 一键还原。
- **Verify.json**：只校验 43 项（DLL + 2 个 exe + `resources/assets/dlls/*.dll`），
  **`app.asar` 不在校验清单内** → 重打包可行。
  ⚠️ **绝不要改 `.exe`**（`SeewoServiceAssistant.exe`、`ShowTaskBarTool.exe` 在清单内）。

---

## 6. 实测记录

环境：本仓库工作区，Node v24.22.0，真实 `app.asar`（11,306,027 B，
md5 `7461e13adc3167d684cd82fd8ed5e686`）。

### 6.1 锚点定位（`--dry-run`）

```
锚点A  bootstrap 尾部 @894，入口模块 id=140
锚点B  文件末尾 @329200，以 "]);" 收尾（合法追加位）
✓ webpack 模块表 (n.m=e)
✓ 模块缓存 (n.c=t)
main.js: 321.5 KB -> 342.2 KB (+20.7 KB)
```

### 6.2 打包 + 解包回验

补丁产物重新用 `@electron/asar` 解包后确认：

```
$ grep -c 'injection BEGIN' <extract>/main.js
1
$ grep -o 'n.p="",global.__AURA_REQ__=n,(function(){try{return n(n.s=140);}' <extract>/main.js
n.p="",global.__AURA_REQ__=n,(function(){try{return n(n.s=140);}
```

原始 `app.asar` md5 在补丁前后**不变**（`--out` 模式不修改目标；原地模式有 `.bak`）。

### 6.3 运行期功能验证

把真实补丁产物里的 `main.js` 放进 Node + 模拟 Electron 环境执行
（**仅**桩掉 Linux 下无法加载的原生 DLL 模块 13/19/59/90/193；业务模块 120/69/40 全部是真实代码）：

**默认配置（关闭屏保 + 切断级联）**
```
__AURA_REQ__ type: function
AURA installed: true
AURA hook: true | guard: true
AURA modules: {"controller":true,"windowManager":true,"share":true,"lockController":true}
(a) /displayScreenSaver 被拦截（未广播 screensaverMessage）: true
(a) state.blocked = 1
(c) 窗口管理器 startLock 已被替换为陷阱: true
(c) 调用陷阱后屏幕锁窗口数（应保持不变 = 0 ）: 0
(c) module 40（屏幕锁控制器）未被修改: true
RESULT (a) 关闭屏保 = PASS
RESULT (c) 级联已切断 = PASS
```

**深度配置（`screensaverEnabled: true` + 自定义图集）**
```
screensaverEnabled: true   lockCascadeOnClose: true   guard installed: false
captured payload: {"imageList":["C:\pics\1.jpg","C:\pics\2.jpg","C:\pics\3.jpg"],
                   "switchInterval":8,"pictureSizeType":1,
                   "textList":[{"content":"欢迎","provenance":"校办"}],
                   "materialSource":"我的图集"}
(b) materialSource/switchInterval/pictureSizeType/imageList/textList 覆盖: 全部 true
RESULT (b) 深度配置 = PASS
RESULT (a) enabled 时不拦截 = PASS
```

**配置优先级 + 日志**
```
[INFO] 已加载外部配置: %APPDATA%\seewo\AuraScreensaver\config.json
[INFO] 优先级：外部配置文件 > 内嵌配置
[INFO] 级联守卫已安装（官方本版本不存在 startLock；屏幕锁控制器 module 40 未被修改）
[INFO] 已拦截 /displayScreenSaver（屏保已按配置关闭）
```

**边界行为**
| 场景 | 结果 |
|---|---|
| 对已打补丁的 asar 再打 | 拒绝并安全降级，**不写任何文件** |
| 原地打补丁 | 生成 `app.asar.bak`（= 原始文件 md5） |
| 再次原地打补丁 | 备份**保留不覆盖**（md5 仍是原始值） |
| `--restore` | 目标与备份 md5 一致 |

---

## 7. 已知限制 / 待验证

1. **未能真机验证**：本仓库环境是 Linux，无法运行 Windows Electron 主进程，
   因此 `Verify.json` 实际校验行为、真实多显示器下的全屏覆盖、
   原生 FFI（`windowsApiFfi.dll` 等）返回值语义**均未在真机验证**。
   —— 运行期验证是通过「真实 `main.js` + 模拟 Electron」完成的（见 6.3）。
2. **模块 id 依赖扫描**：加载器直接 `req(120)` / `req(69)` / `req(40)`。
   这三个 id 已在本版本（v1.2.7）实测确认；换版本可能变化。
   补丁器的**锚点**是版本无关的，但**模块 id** 不是 —— 若换版本后注入
   「装上了但 hook 没生效」，应先用 `.work` 里的方法重新 dump 模块 id。
   加载器对每个 `req()` 都单独 `try/catch`，取不到只会降级对应能力。
3. **`textList` 随机选取依赖渲染器**：官方渲染器每次切换图片时随机选取文字条目
   （最多重试 5 次）。本工具只负责下发内容，不改变该随机行为。
4. **README 中的路径**：`%APPDATA%` 在真实 Windows 上可用；
   在其它平台会尝试 `USERPROFILE\AppData\Roaming` 兜底，读不到则回落内嵌配置。
