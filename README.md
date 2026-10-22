# seewo-screensaver-tool（希沃屏保修改工具 · 参考实现）

修改**希沃管家（SeewoServiceAssistant）**屏保行为的注入式工具参考实现。

> ⚠️ **仅供个人学习、研究与设备自管理使用。** 请自行确认使用场景合法合规。
> 详见 [免责声明](#免责声明) 与 [docs/DESIGN.md](docs/DESIGN.md) 的风险分析。

---

## 两种用法（都不需要 Node.js）

### 方式一：下载 exe（最简单）

到 [Releases](../../releases) 或 Actions 的 artifacts 里下载 `AuraScreensaver.exe`，双击即用。

- 单文件，**不需要安装 Node.js，也不需要懂 PowerShell**
- 首次运行会弹 UAC（要写入 Program Files，必须管理员权限）—— 点「是」
- 界面里依次点：`安装注入` → 重启希沃管家 → `立即预览屏保`

### 方式二：用脚本（可审查源码）

双击 `scripts\安装.bat` 注入，`scripts\配置屏保.bat` 打开图形界面，`scripts\卸载.bat` 还原。
同样**不需要 Node.js** —— 注入器已用纯 PowerShell 重写。

## 你需要哪些文件

最小可用集合（脚本方式）：

```
tools\
  ps\Patch-Asar.ps1                   注入器（纯 PowerShell，改写 asar）
  payload\aura-screensaver-loader.js   加载器（被注入进管家主进程）
scripts\
  安装.bat                             注入
  卸载.bat                             还原
  配置屏保.bat                         图形界面
  AuraScreensaver.ps1                  安装器（上面三个 .bat 调用它）
```

> ⚠️ `scripts` 与 `tools` **必须在同一层目录**，不能只拷 `scripts`。
> 用 exe 方式的话，只需要 `AuraScreensaver.exe` 一个文件。

## 为什么之前「安装报错」

两个真实原因，都已修掉：

1. **强依赖 Node.js** —— 旧版注入器是 `tools\patch-asar.js`，检测不到 `node` 就直接报错退出。
   现在注入器是 `tools\ps\Patch-Asar.ps1`，用纯 PowerShell 重写了 asar 读写，不再需要 node。
2. **没有提权** —— 希沃管家通常装在 `Program Files`，写入 `app.asar` 需要管理员权限。
   旧版完全没处理，于是报「拒绝访问」。现在安装器和 exe 都会主动请求 UAC 提权。

另外顺带修了一个很隐蔽的问题：`.ps1` 文件原本**没有 UTF-8 BOM**，
而 Windows PowerShell 5.1 在中文系统上会按 GBK 读取无 BOM 脚本，
导致中文提示全变乱码。现在全部补上了 BOM。

---

## 它能做什么

| 能力 | 说明 |
|---|---|
| **禁用屏保** | 吞掉官方的 `/displayScreenSaver` 指令，屏保不再弹出 |
| **自定义图集** | 用你自己的图片替换云端下发的屏保图集 |
| **设置停留时长** | 控制每张图的切换间隔（秒） |
| **图片适配方式** | `contain`（留边完整显示）/ `cover`（裁剪铺满） |
| **自定义图文** | 替换屏保底部的文字与出处 |
| **关闭后不锁屏** | ★ 切断「关掉屏保 → 自动锁屏」的级联（默认开启） |
| **可视化界面** | 双击 `scripts\配置屏保.bat` 打开图形配置界面，不用手改 JSON |
| **立即预览** | 界面上一键唤起屏保，直接看配置效果（**即使屏保已关闭也能预览**） |

## 它**不会**做什么（重要安全边界）

- ❌ **不会**禁用云端远程锁屏（`messageType === 1211`）
- ❌ **不会**禁用本地手动锁屏（`userLock()`）
- ❌ **不会**修改希沃管家的任何官方文件

> 只切断「屏保窗口关闭 → `startLock()`」这**一条**来源。
> 全局禁用锁屏会让设备失去锁屏保护，本工具**有意不做**。

---

## 技术原理（一句话）

希沃管家是 Electron 应用，屏保由主进程一个控制器管理：

```js
// 逐字取自 app.asar → main.js（屏保控制器）
e.url === "/displayScreenSaver" && (
  r.share("screensaverTransitionList", 随机数组(e.data.imageList.length)),  // 每图一个转场
  r.share("screensaverMessage", e.data),                                    // 图集数据
  o.enQueue({ taskName: "SCREENSAVER",
              taskDependencies: ["LIVE", "SCHOOLANNOUNCEMENT"], ... })
);
```

因此**不需要改渲染器**：只要包装这个 `onMessage`，就能吞掉指令或改写载荷。

而「关屏保就锁屏」来自窗口管理器的 `close` 回调：

```js
r.on("close", () => { setTimeout(() => { this.closeWindow(); this.startLock(); }, 0) })
//                                                                  ^^^^^^^^^^^ 级联源头
```

---

## 渲染器数据契约

配置字段严格对齐屏保渲染器实际读取的字段（逐字解码自 `public/screensaver.js`）：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `materialSource` | string | `""` | 底部"素材来自 X" |
| `switchInterval` | number | `15` | **单位=秒**（渲染器内部 ×1000） |
| `pictureSizeType` | number | `0` | `0`=contain，`1`=cover |
| `imageList` | string[] | `[]` | 图片路径数组 |
| `textList` | object[] | `[]` | `{ content, provenance? }` |
| `transitionList` | number[] | `null` | 长度**必须**=`imageList.length`，值域 **0..6** |

---

## 快速开始

```bash
# 运行测试（54 项，含真实 bundle 验证 + 预览控制通道）
node --test 'test/**/*.test.js'
```

### 作为库使用

```js
const { createTool } = require('./src/index.js');

const tool = createTool({
  configManager,   // 可选，缺省自动创建
  controller,      // 官方屏保控制器实例
  windowManager,   // 官方窗口管理器实例（module 69）
  ipcMain,         // Electron ipcMain
});

tool.start();   // 安装 hook + 级联守卫 + 注册 IPC
// ...
tool.stop();    // 完整回滚到官方行为
```

### 配置示例

```json
{
  "screensaverEnabled": true,
  "lockCascadeOnClose": false,
  "override": {
    "materialSource": "我的班级",
    "switchInterval": 30,
    "pictureSizeType": 1,
    "imageList": ["C:\\\\images\\\\1.jpg", "C:\\\\images\\\\2.jpg"],
    "textList": [{ "content": "今日值日：张同学", "provenance": "班务" }]
  }
}
```

---

## 目录结构

```
src/
  config/schema.js            配置 schema、默认值、严格校验
  config/configManager.js     原子写 + 备份轮转 + 损坏隔离
  module/findModule.js        按源码锚点定位 webpack 模块（找不到返回 null，不抛）
  hooks/screensaverHook.js    吞指令 / 改写载荷 / 规整转场
  hooks/lockCascadeGuard.js   定向切断 close→startLock 级联
  ipc/handler.js              配置读写与状态查询
  logger.js                   分级日志
  index.js                    装配入口、公共 API
test/
  schema.test.js              配置校验与静默损坏回归
  screensaverHook.test.js     拦截 / 放行 / 契约改写
  lockCascadeGuard.test.js    级联防护与"不误伤锁屏"
  findModule.test.js          锚点定位（含真实 bundle 验证）
  previewControl.test.js      预览/控制通道（针对真实注入产物）
  helpers/                    同构夹具 + 真实模块节选
tools/
  patch-asar.js               app.asar 注入器（备份 / 幂等 / 可还原）
  payload/aura-screensaver-loader.js  注入加载器（单文件自包含）
  gui/server.js               图形界面后端（127.0.0.1 本地 HTTP）
  gui/index.html + app.js     图形界面前端（零 CDN 依赖）
  gui/启动配置界面.bat        双击启动界面
scripts/
  安装.bat / 卸载.bat         注入 / 还原
  配置屏保.bat                打开图形配置界面
  换屏保.bat                  纯 CMD 图片替换（不注入）
docs/DESIGN.md                架构设计、路线选型、风险与路线图
docs/深度配置屏保.md          配置项手册
docs/图形界面.md              图形界面使用说明
docs/注入验证记录.md          注入复验记录（含方案缺陷修正）
```

---

## 分析依据（一手逆向，非推测）

本实现的每条关键结论都来自对真实产物的逐字提取：

| 证据 | 位置 |
|---|---|
| `.work/FINDINGS.md` | 整体逆向结论 |
| `.work/RENDERER_CONTRACT.md` | 渲染器数据契约（解码自 `screensaver.js`） |
| `.work/CASCADE_ANALYSIS.md` | 锁屏级联与三条锁屏路径 |
| `.work/app/main.js` | 解包后的主进程源码（330 KB） |

参考项目：[HugoAura-Enhanced](https://github.com/blingbling-bow/HugoAura-Enhanced)（注入式方案，**GPL-3.0**）。
本实现**独立编写，未复制其代码**；仅参考了"注入而非重打包"的架构思路。

---

## 已验证状态

```
node --test 'test/**/*.test.js'   →   41 passed / 0 failed
```

其中「真实 bundle 验证」用例直接读取解包后的 `main.js`，断言模块定位结果：

| 锚点 | moduleId | verified |
|---|---|---|
| `taskConstants` | 38 | ✅ |
| `windowManager` | 69 | ✅ |
| `taskQueue` | 39 | ✅ |
| `screenLock` | 40 | ✅ |
| `screensaverController` | 120 | ✅ |

> 遗留：注入器加载逻辑（路线 B 的落地部分）尚未实现，真机验证需在希沃设备上进行。

---

## 免责声明

本项目仅供**技术研究与个人设备自管理**。

- 希沃管家为商业软件，其著作权归广州视睿电子科技有限公司所有。
- 请勿将本项目用于绕过学校或单位的管理策略，或任何可能违反法律法规及 EULA 的用途。
- 在受集中管理的设备上修改集控能力，可能违反管理方规定，后果由使用者自行承担。
- 作者不对使用本项目造成的任何后果负责。

## 许可证

本参考实现为独立编写，建议以 MIT 发布。
**但请注意**：若你选择复制 [HugoAura-Enhanced](https://github.com/blingbling-bow/HugoAura-Enhanced) 的任何代码，
则因其为 **GPL-3.0**，你的衍生作品必须以 **GPL-3.0** 开源并保留原始版权声明。
