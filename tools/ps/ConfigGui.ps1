<#
  希沃屏保配置界面（纯 PowerShell + WinForms，无需 Node.js）
  ============================================================================
  设计原则（按用户要求）：
    - 界面简洁：未注入时**只有一个**「一键安装」按钮，其余全部隐藏
    - 注入成功后**才**显示配置菜单
    - 安装/卸载时**自动结束并重启**希沃管家，不需要用户手动去托盘退出
    - 安装后**验证加载器确实运行了**（看日志出现「命令桥已启动」）才算成功

  启动方式：双击 scripts\配置屏保.bat，或直接运行打包好的 exe
#>

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

# ---------------------------------------------------------------------------
# 高 DPI 适配
#   不声明 DPI 感知时，Windows 会把整个窗口按缩放比例位图拉伸，
#   在 150%/200% 缩放下窗口会大到超出屏幕 —— 底部按钮就点不到了。
#   声明之后窗口按真实像素绘制，再把布局改成「可滚动 + 底部固定」。
# ---------------------------------------------------------------------------

try {
    if (-not ('AuraDpi' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class AuraDpi {
    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();
}
'@
    }
    [void][AuraDpi]::SetProcessDPIAware()
} catch { }


$ErrorActionPreference = 'Stop'

$script:NL = [Environment]::NewLine
$script:ConfigDir   = Join-Path $env:APPDATA (Join-Path 'seewo' 'AuraScreensaver')
$script:ConfigPath  = Join-Path $script:ConfigDir 'config.json'
$script:CommandPath = Join-Path $script:ConfigDir 'command.json'
$script:ResultPath  = Join-Path $script:ConfigDir 'command-result.json'
$script:LogPath     = Join-Path $script:ConfigDir 'aura-screensaver.log'
$script:Utf8NoBom   = New-Object System.Text.UTF8Encoding($false)
$script:HostNames   = @('SeewoServiceAssistant')

# ---------------------------------------------------------------------------
# 单实例：正常模式重复打开只保留一个窗口。
#   第二次启动会把已有窗口带到前台，然后自己退出。
#   ★ 安全模式自动动作（-SafeInstall / -SafeUninstall）不参与 —— 它没有界面，
#     而且已有独立的防重入锁（safe-action.lock）。
# ---------------------------------------------------------------------------

# 把已有的主窗口带到前台。纯属「锦上添花」，自行吞掉异常，不参与单实例判定。
function Show-AuraExistingWindow {
    param([string]$WindowTitle = '希沃屏保配置')
    try {
        if (-not ('AuraWin' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class AuraWin {
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
'@
        }
        $h = [AuraWin]::FindWindow($null, $WindowTitle)
        if ($h -ne [IntPtr]::Zero) {
            if ([AuraWin]::IsIconic($h)) { [void][AuraWin]::ShowWindow($h, 9) }
            [void][AuraWin]::SetForegroundWindow($h)
        }
    } catch { }
}

# 返回 True = 本进程是唯一实例；False = 已有实例（已尝试把它带到前台）
function Initialize-SingleInstance {
    param([string]$WindowTitle = '希沃屏保配置')

    # ★ 核心判定只用互斥体，不掺任何其它可能失败的操作。
    #   之前整个函数套在一个大 try 里，Add-Type 失败也会走到「放行」分支，
    #   单实例检测就形同虚设（测试里正是这么暴露出来的）。
    $createdNew = $false
    $mutex = $null
    try {
        # initiallyOwned 必须为 False：若为 True，已有实例持有时本行会一直阻塞，
        # 第二个实例既退不出也开不了窗口 —— 比不做单实例还糟。
        # 正确做法是「创建后用 WaitOne(0) 试占」，试不到就是已有实例。
        $mutex = New-Object System.Threading.Mutex($false, 'LocalAuraScreensaver_GUI', [ref]$createdNew)
    } catch {
        return $true   # 连互斥体都建不出来 -> 放行，别卡住用户
    }

    $gotIt = $false
    try { $gotIt = $mutex.WaitOne(0) } catch { $gotIt = $false }

    if ($createdNew -and $gotIt) {
        $script:SingleInstanceMutex = $mutex   # 持有到进程结束
        return $true
    }

    try { $mutex.Dispose() } catch { }
    Show-AuraExistingWindow -WindowTitle $WindowTitle
    return $false
}

$script:SingleInstanceMutex = $null
if (-not (($args -contains '-SafeInstall') -or ($args -contains '-SafeUninstall'))) {
    if (-not (Initialize-SingleInstance)) { exit 0 }
}

# ---------------------------------------------------------------------------
# 未捕获的界面异常：只记日志，绝不弹 .NET 的「未处理的异常」崩溃框。
#   用户实测动图预览抛 GDI+ 一般性错误时，弹出了那个很吓人的对话框。
# ---------------------------------------------------------------------------
try {
    [System.Windows.Forms.Application]::SetUnhandledExceptionMode(
        [System.Windows.Forms.UnhandledExceptionMode]::CatchException)
    [System.Windows.Forms.Application]::add_ThreadException({
        param($sender, $e)
        try {
            $p = Join-Path $script:ConfigDir 'ui-error.log'
            $txt = ('[' + (Get-Date).ToString('s') + '] ' + $e.Exception.ToString() + [Environment]::NewLine)
            [System.IO.File]::AppendAllText($p, $txt, (New-Object System.Text.UTF8Encoding($false)))
        } catch { }
    })
} catch { }
if (-not $script:InjectionVersion) { $script:InjectionVersion = '1.19.0' }

# ---------------------------------------------------------------------------
# 管理员权限（写入 Program Files 必需）
# ---------------------------------------------------------------------------

function Test-IsAdmin {
    try {
        $id = [Security.Principal.WindowsIdentity]::GetCurrent()
        $pr = New-Object Security.Principal.WindowsPrincipal($id)
        return $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch { return $true }
}

if ($env:OS -eq 'Windows_NT' -and -not (Test-IsAdmin)) {
    $relaunched = $false
    try {
        if ($PSCommandPath -and ($PSCommandPath -like '*.ps1')) {
            $argLine = '-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '"'
            Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argLine
            $relaunched = $true
        } else {
            $exePath = $null
            try { $exePath = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName } catch { }
            if ($exePath) { Start-Process -FilePath $exePath -Verb RunAs; $relaunched = $true }
        }
    } catch { $relaunched = $false }
    if ($relaunched) { exit 0 }
}

# 脚本模式下按需加载 asar 函数库（exe 模式已内联，文件不存在就跳过）
# 脚本模式下按需加载函数库；exe 模式这些文件不存在（已内联），全部跳过。
# 整段 try/catch：$PSScriptRoot 在编译后的 exe 里可能为空，不能让加载失败。
try {
    if ($PSScriptRoot) {
        $script:AsarLib = Join-Path $PSScriptRoot 'AsarLib.ps1'
        if (Test-Path -LiteralPath $script:AsarLib) { . $script:AsarLib }

        $script:LocateLib = Join-Path $PSScriptRoot 'SeewoLocate.ps1'
        if (Test-Path -LiteralPath $script:LocateLib) { . $script:LocateLib }

        if (-not $script:LoaderText) {
            $loaderCand = Join-Path $PSScriptRoot (Join-Path '..' (Join-Path 'payload' 'aura-screensaver-loader.js'))
            if (Test-Path -LiteralPath $loaderCand) {
                $script:LoaderText = [System.IO.File]::ReadAllText($loaderCand, [System.Text.Encoding]::UTF8)
            }
        }
    }
} catch { }

if (-not $script:NL) { $script:NL = [Environment]::NewLine }
if (-not $script:DefaultConfigJson) {
    $script:DefaultConfigJson = '{"screensaverEnabled":false,"lockCascadeOnClose":false,"override":null,"logLevel":"info"}'
}

# ---------------------------------------------------------------------------
# 配置读写
# ---------------------------------------------------------------------------

function Get-DefaultConfig {
    return [pscustomobject]@{
        screensaverEnabled = $true
        lockCascadeOnClose = $false
        allowManualClose   = $true
        override           = $null
        web                = [pscustomobject]@{ enabled = $false; url = ''; closeOnClick = $false; useSystemBrowser = $false; browserPath = '' }
        mode               = 'none'
        logLevel           = 'info'
        backupCount        = 3
    }
}

function Read-Config {
    if (-not (Test-Path -LiteralPath $script:ConfigPath)) { return Get-DefaultConfig }
    try {
        $raw = [System.IO.File]::ReadAllText($script:ConfigPath, [System.Text.Encoding]::UTF8)
        $o = $raw | ConvertFrom-Json
        if ($null -eq $o) { return Get-DefaultConfig }
        return $o
    } catch { return Get-DefaultConfig }
}

function Save-ConfigFile {
    param($Config)
    if (-not (Test-Path -LiteralPath $script:ConfigDir)) {
        New-Item -ItemType Directory -Path $script:ConfigDir -Force | Out-Null
    }
    $json = $Config | ConvertTo-Json -Depth 20
    $tmp = $script:ConfigPath + '.tmp'
    [System.IO.File]::WriteAllText($tmp, $json, $script:Utf8NoBom)
    if (Test-Path -LiteralPath $script:ConfigPath) {
        Copy-Item -LiteralPath $script:ConfigPath -Destination ($script:ConfigPath + '.bak') -Force
    }
    Move-Item -LiteralPath $tmp -Destination $script:ConfigPath -Force
}

# ---------------------------------------------------------------------------
# 管家进程控制
# ---------------------------------------------------------------------------

function Get-HostProcs {
    $all = @()
    foreach ($n in $script:HostNames) {
        $all += @(Get-Process -Name $n -ErrorAction SilentlyContinue)
    }
    return $all
}

# 判断注入是否真的生效（不看进程在不在，看日志里加载器是否报 hook:true）
function Test-LoaderActive {
    if (-not (Test-Path -LiteralPath $script:LogPath)) { return $false }
    try {
        $t = [System.IO.File]::ReadAllText($script:LogPath, [System.Text.Encoding]::UTF8)
        if ($t -match '"hook":true') { return $true }
        return $false
    } catch { return $false }
}

# 状态文案：区分「进程在跑」和「注入生效」——安全模式里进程会在但注入无效
function Get-RuntimeText {
    $procs = (Get-HostProcs).Count
    $active = Test-LoaderActive
    if ($active) { return ('运行中（注入已生效，进程 ' + $procs + ' 个）') }
    if ($procs -gt 0) { return ('运行中（注入未生效，进程 ' + $procs + ' 个）') }
    return '未运行'
}

# ---------------------------------------------------------------------------
# 首页诊断：未安装时也能看到各组件状态，方便对比「装之前 / 装之后」
# ---------------------------------------------------------------------------
# 清理：识别本软件产生的、已无用的文件
#   - resources 下残留的探测/临时文件（.aura-probe-* / .aura-diag-* / app.asar.new）
#   - %APPDATA%\seewo\AuraScreensaver 下的临时与历史文件
#   - 桌面上的 app.asar.injected-* 导出文件
#   - 遗留的 install.log / 诊断文件（可选保留最新一个）
#   ★ 只删自己产生的东西；官方文件、.bak 备份一律不碰。
# ---------------------------------------------------------------------------

function Get-CleanupCandidates {
    $items = New-Object System.Collections.ArrayList
    $st = Get-InjectionState

    # 1) 安装目录里的残留
    if ($st.Dir) {
        $res = Join-Path $st.Dir 'resources'
        foreach ($pat in @('.aura-probe-*', '.aura-diag-*', 'app.asar.new', 'app.asar.replbak', 'aura-stage-*', 'aura-safe-*', 'aura-dir-*')) {
            try {
                $found = @(Get-ChildItem -LiteralPath $res -Filter $pat -Force -ErrorAction SilentlyContinue)
                foreach ($f in $found) {
                    [void]$items.Add([pscustomobject]@{ Path = $f.FullName; Kind = '文件'; Why = '安装时残留的探测/临时项' })
                }
            } catch { }
        }
    }

    # 2) %APPDATA% 下的临时文件
    if (Test-Path -LiteralPath $script:ConfigDir) {
        foreach ($pat in @('*.tmp', 'config.json.tmp', '*.probe')) {
            try {
                foreach ($f in @(Get-ChildItem -LiteralPath $script:ConfigDir -Filter $pat -Force -ErrorAction SilentlyContinue)) {
                    [void]$items.Add([pscustomobject]@{ Path = $f.FullName; Kind = '文件'; Why = '配置写入残留' })
                }
            } catch { }
        }
        # 旧日志（保留最新，其余列出）
        try {
            $logs = @(Get-ChildItem -LiteralPath $script:ConfigDir -Filter '*.log' -Force -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending | Select-Object -Skip 1)
            foreach ($f in $logs) {
                [void]$items.Add([pscustomobject]@{ Path = $f.FullName; Kind = '文件'; Why = '历史日志（保留最新一份）' })
            }
        } catch { }
    }

    # 3) 桌面上的导出文件
    try {
        $desk = [Environment]::GetFolderPath('Desktop')
        if ($desk) {
            foreach ($pat in @('app.asar.injected-*', 'AuraScreensaver-诊断-*.txt')) {
                foreach ($f in @(Get-ChildItem -LiteralPath $desk -Filter $pat -Force -ErrorAction SilentlyContinue)) {
                    [void]$items.Add([pscustomobject]@{ Path = $f.FullName; Kind = '文件'; Why = '手动绕过时导出的补丁/诊断' })
                }
            }
        }
    } catch { }

    # 4) 旧的备份目录（screen_saver_backup_*，只保留最新两份）
    try {
        $ss = Get-ScreenSaverDir
        if (Test-Path -LiteralPath $ss) {
            $parent = Split-Path -Parent $ss
            $baks = @(Get-ChildItem -LiteralPath $parent -Directory -Filter 'screen_saver_backup_*' -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending | Select-Object -Skip 2)
            foreach ($d in $baks) {
                [void]$items.Add([pscustomobject]@{ Path = $d.FullName; Kind = '目录'; Why = '旧的屏保图片备份（保留最新两份）' })
            }
        }
    } catch { }

    return $items
}

function Invoke-CleanupDialog {
    $items = @(Get-CleanupCandidates)

    $dlg = New-Object System.Windows.Forms.Form
    $dlg.Text = '清理无用文件'
    $dlg.Size = New-Object System.Drawing.Size(880, 600)
    $dlg.MinimumSize = New-Object System.Drawing.Size(620, 420)
    $dlg.StartPosition = 'CenterParent'

    # 用 TableLayoutPanel 三行（说明 / 列表填充 / 按钮自适应）。
    # 之前按钮是绝对坐标、列表也没开横向滚动条 ——
    # 窗口一窄右侧按钮就被裁掉，长路径也看不全。
    $lay = New-Object System.Windows.Forms.TableLayoutPanel
    $lay.Dock = 'Fill'
    $lay.ColumnCount = 1
    $lay.RowCount = 3
    [void]$lay.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize)))
    [void]$lay.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100)))
    [void]$lay.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize)))

    $top = New-Object System.Windows.Forms.Label
    $top.AutoSize = $true
    $top.Dock = 'Fill'
    $top.Padding = New-Object System.Windows.Forms.Padding(10, 8, 10, 4)
    if ($items.Count -eq 0) {
        $top.Text = '没有发现需要清理的文件。'
    } else {
        $top.Text = ('找到 ' + $items.Count + ' 项本软件产生的无用文件。' + $script:NL +
            '（只清理自己产生的探测/临时/导出文件；官方文件与 .bak 备份一律不动）')
    }
    [void]$lay.Controls.Add($top)

    $list = New-Object System.Windows.Forms.CheckedListBox
    $list.Dock = 'Fill'
    $list.CheckOnClick = $true
    # 路径很长，必须允许横向滚动，否则只能看到开头
    $list.HorizontalScrollbar = $true
    $list.IntegralHeight = $false
    $list.Margin = New-Object System.Windows.Forms.Padding(8, 0, 8, 0)
    $list.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 8)
    foreach ($it in $items) {
        [void]$list.Items.Add(('[' + $it.Kind + '] ' + $it.Path + '   — ' + $it.Why), $true)
    }
    [void]$lay.Controls.Add($list)

    # 按钮统一放一条可换行的流式栏：任何窗口宽度都不会被裁
    $bar = New-Object System.Windows.Forms.FlowLayoutPanel
    $bar.Dock = 'Fill'
    $bar.AutoSize = $true
    $bar.AutoSizeMode = 'GrowAndShrink'
    $bar.WrapContents = $true
    $bar.Padding = New-Object System.Windows.Forms.Padding(8, 6, 8, 6)

    $btnAll = New-Object System.Windows.Forms.Button
    $btnAll.Text = '全选'
    $btnAll.AutoSize = $true
    $btnAll.Margin = New-Object System.Windows.Forms.Padding(0, 0, 6, 0)

    $btnNone = New-Object System.Windows.Forms.Button
    $btnNone.Text = '全不选'
    $btnNone.AutoSize = $true
    $btnNone.Margin = New-Object System.Windows.Forms.Padding(0, 0, 20, 0)

    $btnDel = New-Object System.Windows.Forms.Button
    $btnDel.Text = '删除选中项'
    $btnDel.AutoSize = $true
    $btnDel.Margin = New-Object System.Windows.Forms.Padding(0, 0, 6, 0)

    $btnClose3 = New-Object System.Windows.Forms.Button
    $btnClose3.Text = '关闭'
    $btnClose3.AutoSize = $true
    $btnClose3.Margin = New-Object System.Windows.Forms.Padding(0)
    $btnClose3.add_Click({ $dlg.Close() })

    $btnAll.add_Click({ for ($i = 0; $i -lt $list.Items.Count; $i++) { $list.SetItemChecked($i, $true) } })
    $btnNone.add_Click({ for ($i = 0; $i -lt $list.Items.Count; $i++) { $list.SetItemChecked($i, $false) } })

    $btnDel.add_Click({
        $ok = $false
        $fail = 0
        $failed = @()
        for ($i = 0; $i -lt $list.Items.Count; $i++) {
            if (-not $list.GetItemChecked($i)) { continue }
            $p = $items[$i].Path
            try {
                if ($items[$i].Kind -eq '目录') { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction Stop }
                else { Remove-Item -LiteralPath $p -Force -ErrorAction Stop }
                $ok = $true
            } catch {
                $fail++
                $failed += ($p + '  ==>  ' + $_.Exception.Message)
            }
        }
        if ($fail -gt 0) {
            [System.Windows.Forms.MessageBox]::Show(
                ('有 ' + $fail + ' 项删除失败（可能正在被占用）：' + $script:NL + $script:NL +
                 (@($failed | Select-Object -First 6) -join $script:NL)),
                '部分失败', 'OK', 'Warning') | Out-Null
        } elseif ($ok) {
            [System.Windows.Forms.MessageBox]::Show('清理完成。', '完成', 'OK', 'Information') | Out-Null
        }
        $dlg.Close()
    })

    [void]$bar.Controls.Add($btnAll)
    [void]$bar.Controls.Add($btnNone)
    [void]$bar.Controls.Add($btnDel)
    [void]$bar.Controls.Add($btnClose3)
    [void]$lay.Controls.Add($bar)

    $dlg.Controls.Add($lay)
    [void]$dlg.ShowDialog($form)
}

# ---------------------------------------------------------------------------
# 各配置项说明（「说明」按钮弹出）
# ---------------------------------------------------------------------------

function Get-FieldHelpText {
    $L = @()
    $L += '希沃屏保配置 —— 各配置项说明'
    $L += ('=' * 46)
    $L += ''
    $L += '【启用屏保】'
    $L += '  屏保总开关。关闭后，集控再下发也不会弹屏保。'
    $L += '  注意：手动点「保存并预览」不受它限制 —— 这是故意的，'
    $L += '        否则「我关了屏保，但想看看效果」就成了死路。'
    $L += ''
    $L += '【关闭屏保后自动锁屏】'
    $L += '  关闭屏保窗口时，是否顺带进入屏幕锁。'
    $L += '  建议不勾：希沃官方这里调用了自己并不存在的 startLock()（确定性缺陷），'
    $L += '  本工具默认把这条级联切断，避免出现锁屏异常。'
    $L += ''
    $L += '【使用自定义图集】'
    $L += '  勾上之后，下面这些设置才生效；'
    $L += '  不勾就一直沿用集控下发的图片和文案。'
    $L += ''
    $L += '【素材来源（右下角文案）】'
    $L += '  屏保右下角显示的那行小字，比如「素材来自 XX」。'
    $L += '  ★ 这里填的是展示文案，不是图片路径！'
    $L += '     填路径不会去找图，只会把那串路径原样显示在屏保上。'
    $L += ''
    $L += '【切换间隔（秒）】'
    $L += '  每张图片停留多少秒。渲染器内部会 ×1000 转成毫秒。'
    $L += ''
    $L += '【图片适配】'
    $L += '  图片比例和屏幕不一致时怎么办：'
    $L += '    留边完整显示（contain）= 不裁剪，两侧留黑边，能看到完整画面'
    $L += '    裁剪铺满（cover）     = 填满整个屏幕，但会裁掉超出的部分'
    $L += ''
    $L += '【图片列表】'
    $L += '  要轮播的图片，每行一个完整路径。'
    $L += '  支持 jpg / jpeg / png / bmp / gif / webp / apng / avif。'
    $L += ''
    $L += '  ★ 动图（gif / webp / apng）可以直接用 —— 渲染器用 CSS background-image'
    $L += '     显示图片，动图是原生播放的，不需要额外设置。'
    $L += '     注意：动图自己的播放速度由图片本身决定，与「切换间隔」无关；'
    $L += '     「切换间隔」只决定多久换到下一张。'
    $L += '  用「选择文件夹…」可以一次性加入整个文件夹里的所有图片。'
    $L += ''
    $L += '【图文条目】'
    $L += '  屏保上显示的正文文字，每行一条。'
    $L += '  格式：内容|出处     （出处可以省略，省略就不显示来源）'
    $L += '  例：今天也要加油|班主任'
    $L += '  注意：这跟「素材来源」是两处不同的文字。'
    $L += ''
    $L += '【转场效果】'
    $L += '  每张图片切换时的动画编号，一共 7 种（0、1、2、3、4、5、6）。'
    $L += '  填法三选一：'
    $L += '    留空        = 每次切换都随机（官方默认行为）'
    $L += '    只填 1 个   = 所有图片都用这一个，例：3'
    $L += '    填满 N 个   = 逐图对应（N = 图片数量），例：0,3,6'
    $L += '  不想手填可以点「随机生成」。'
    $L += ''
    $L += '【屏保内容（三选一）】'
    $L += '  自定义图集  用你自己配的图片、文案与转场。'
    $L += '  网页屏保    用网页当屏保，动画完全由网页决定。'
    $L += '  不修改图片  图片和文案沿用集控下发的，但「切换间隔 / 图片适配 /'
    $L += '              转场效果」这三项仍然可以调 —— 它们对集控图也生效。'
    $L += ''
    $L += '  ★ 三种模式各自的设置都会保存下来，来回切换不会把另一边弄丢。'
    $L += ''
    $L += '【网页屏保】'
    $L += '  勾选后，屏保不再用官方那 7 种固定转场，而是直接显示一个网页。'
    $L += '  网页里怎么写就怎么动 —— CSS 动画、JS、视频、Canvas 都能用，'
    $L += '  等于动画效果不受官方限制。'
    $L += '  地址可以填网址，也可以填本地 HTML 文件路径'
    $L += '  （点「选择网页文件…」挑一个；或只写 bing.com，会自动补上 https://）。'
    $L += '  （例：D:\anim\show.html，会自动转成 file:///）。'
    $L += '  改完地址点「保存配置」，再点「预览屏保」即可马上看效果；'
    $L += '  用内置内核时：屏保右下角有「退出屏保」按钮，也可以按 ESC。'
    $L += '  用系统浏览器时：按 ESC / Ctrl+Alt+Q，或 Alt+F4；'
    $L += '  注册不上快捷键时，双击桌面「退出网页屏保.bat」一定能退出。'
    $L += '  若网页加载失败，会自动回退到官方图片屏保，不会黑屏卡住。'
    $L += ''
    $L += '【预览】'
    $L += '  点「保存并预览」会立刻用当前配置唤起一次屏保，方便看效果。'
    $L += '  数据优先级：自定义图集 > 集控最后下发 > 本机缓存的集控图。'
    $L += '  也就是说，没配图集、集控也还没下发过时，也能预览到本机已有的内容。'
    return ($L -join $script:NL)
}

function Show-HelpDialog {
    $d = New-Object System.Windows.Forms.Form
    $d.Text = '各配置项说明'
    $d.Size = New-Object System.Drawing.Size(780, 620)
    $d.StartPosition = 'CenterParent'

    $box = New-Object System.Windows.Forms.TextBox
    $box.Multiline = $true
    $box.ReadOnly = $true
    $box.ScrollBars = 'Vertical'
    $box.Dock = 'Fill'
    $box.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
    $box.Text = Get-FieldHelpText

    # 流式按钮栏：不用绝对坐标，窗口再窄也不会把按钮裁掉
    $bar = New-Object System.Windows.Forms.FlowLayoutPanel
    $bar.Dock = 'Bottom'
    $bar.AutoSize = $true
    $bar.AutoSizeMode = 'GrowAndShrink'
    $bar.WrapContents = $true
    $bar.Padding = New-Object System.Windows.Forms.Padding(8, 6, 8, 6)

    $btnOk = New-Object System.Windows.Forms.Button
    $btnOk.Text = '知道了'
    $btnOk.AutoSize = $true
    $btnOk.Margin = New-Object System.Windows.Forms.Padding(0, 0, 6, 0)
    $btnOk.add_Click({ $d.Close() })

    $btnCopyH = New-Object System.Windows.Forms.Button
    $btnCopyH.Text = '复制'
    $btnCopyH.AutoSize = $true
    $btnCopyH.Margin = New-Object System.Windows.Forms.Padding(0)
    $btnCopyH.add_Click({
        try { [System.Windows.Forms.Clipboard]::SetText($box.Text) } catch { }
    })

    $bar.Controls.Add($btnOk)
    $bar.Controls.Add($btnCopyH)
    $d.Controls.Add($box)
    $d.Controls.Add($bar)
    [void]$d.ShowDialog($form)
}

# ---------------------------------------------------------------------------

function Get-DiagnosticReport {
    $lines = @()

    $lines += '【本程序】'
    $lines += '  注入版本：' + $script:InjectionVersion
    $lines += '  系统：' + [Environment]::OSVersion.VersionString
    $lines += '  管理员：' + (Test-IsAdmin)
    $lines += '  安全模式：' + (Test-IsSafeMode)
    $lines += ''

    $lines += '【安装目录】'
    $st = Get-InjectionState
    if ($st.Dir) { $lines += '  ' + $st.Dir } else { $lines += '  未找到' }
    $lines += '  app.asar：' + $(if ($st.AsarExists) { '存在' } else { '不存在' })
    $lines += '  备份 .bak：' + $(if ($st.BakExists) { '存在' } else { '不存在' })
    $lines += '  已注入：' + $(if ($st.Injected) { '是' } else { '否' })
    $lines += ''

    $lines += '【希沃进程】（SeewoServiceAssistant 子进程数量是关键指标）'
    $hostProcs = @(Get-HostProcs)
    $lines += '  SeewoServiceAssistant：' + $hostProcs.Count + ' 个'
    $lines += '  期望：1 个主进程 + 3 个子进程 = 4 个'
    $lines += ''
    foreach ($n in @('SeewoCore', 'SeewoAbility', 'EasiAgent', 'ResidentSideBar', 'SeewoIwbAssistant', 'SeewoFreezeUpdateAssist', 'proxyLayerService')) {
        $c = @(Get-Process -Name $n -ErrorAction SilentlyContinue).Count
        $lines += ('  ' + $n.PadRight(26) + $c + ' 个')
    }
    $lines += ''

    $lines += '【希沃服务】'
    foreach ($n in @('SeewoCoreService', 'SeewoFreezeUpdateAssist', 'SeewoProxyLayerService')) {
        try {
            $svc = Get-Service -Name $n -ErrorAction Stop
            $lines += ('  ' + $n.PadRight(26) + $svc.Status + ' / ' + $svc.StartType)
        } catch {
            $lines += ('  ' + $n.PadRight(26) + '不存在')
        }
    }
    $lines += ''

    $lines += '【加载器】'
    $lines += '  日志：' + $script:LogPath
    $lines += '  日志存在：' + (Test-Path -LiteralPath $script:LogPath)
    $lines += '  注入生效(hook:true)：' + (Test-LoaderActive)
    if (Test-Path -LiteralPath $script:LogPath) {
        try {
            $tail = @(Get-Content -LiteralPath $script:LogPath -Tail 200 -ErrorAction SilentlyContinue)
            $hits = @($tail | Where-Object { $_ -match 'hook|app ready|按特征命中|诊断|已安装' })
            if ($hits.Count -gt 0) {
                $lines += ''
                $lines += '  最近相关日志：'
                foreach ($h in ($hits | Select-Object -Last 8)) { $lines += '    ' + $h }
            }
        } catch { }
    }
    $lines += ''

    # 网页内核：系统里有没有更新的 Edge/Chrome
    $lines += '【网页内核】'
    try {
        $pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
        $pf = $env:ProgramFiles
        $found = $null
        foreach ($p in @((Join-Path $pf86 'Microsoft\Edge\Application\msedge.exe'),
                        (Join-Path $pf 'Microsoft\Edge\Application\msedge.exe'),
                        (Join-Path $pf 'Google\Chrome\Application\chrome.exe'))) {
            if ($p -and -not $found -and (Test-Path -LiteralPath $p)) { $found = $p }
        }
        if ($found) { $lines += ('  找到系统浏览器: ' + $found) }
        else { $lines += '  未找到 Edge/Chrome —— 只能用希沃内置内核（较旧）' }
    } catch { $lines += '  检测失败' }
    $lines += '  勾选「用系统浏览器」后走系统内核，新语法站点才会正常显示'
    $lines += ''
    $lines += '【命令桥】'
    $lines += '  command.json：' + (Test-Path -LiteralPath $script:CommandPath)
    $lines += '  command-result.json：' + (Test-Path -LiteralPath $script:ResultPath)

    return ($lines -join $script:NL)
}

function Show-DiagnosticDialog {
    $txt = New-Object System.Windows.Forms.Form
    $txt.Text = '诊断信息'
    $txt.Size = New-Object System.Drawing.Size(760, 620)
    $txt.StartPosition = 'CenterParent'
    $txt.Font = New-Object System.Drawing.Font('Consolas', 9)

    $box = New-Object System.Windows.Forms.TextBox
    $box.Multiline = $true
    $box.ReadOnly = $true
    $box.ScrollBars = 'Both'
    $box.WordWrap = $false
    $box.Dock = 'Fill'
    $box.Font = New-Object System.Drawing.Font('Consolas', 9)
    $box.Text = Get-DiagnosticReport

    $bar = New-Object System.Windows.Forms.FlowLayoutPanel
    $bar.Dock = 'Bottom'
    $bar.AutoSize = $true
    $bar.AutoSizeMode = 'GrowAndShrink'
    $bar.WrapContents = $true
    $bar.Padding = New-Object System.Windows.Forms.Padding(8, 6, 8, 6)

    $btnCopy = New-Object System.Windows.Forms.Button
    $btnCopy.Text = '复制全部'
    $btnCopy.AutoSize = $true
    $btnCopy.Margin = New-Object System.Windows.Forms.Padding(0, 0, 6, 0)
    $btnCopy.add_Click({
        try { [System.Windows.Forms.Clipboard]::SetText($box.Text) } catch { }
    })

    $btnSave = New-Object System.Windows.Forms.Button
    $btnSave.Text = '保存到桌面'
    $btnSave.AutoSize = $true
    $btnSave.Margin = New-Object System.Windows.Forms.Padding(0, 0, 6, 0)
    $btnSave.add_Click({
        try {
            $d = [Environment]::GetFolderPath('Desktop')
            $p = Join-Path $d ('AuraScreensaver-诊断-' + (Get-Date).ToString('yyyyMMdd-HHmmss') + '.txt')
            [System.IO.File]::WriteAllText($p, $box.Text, [System.Text.Encoding]::UTF8)
            [System.Windows.Forms.MessageBox]::Show('已保存到：' + $script:NL + $p, '完成', 'OK', 'Information') | Out-Null
        } catch {
            [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, '保存失败', 'OK', 'Warning') | Out-Null
        }
    })

    $btnRefresh = New-Object System.Windows.Forms.Button
    $btnRefresh.Text = '刷新'
    $btnRefresh.AutoSize = $true
    $btnRefresh.Margin = New-Object System.Windows.Forms.Padding(0, 0, 6, 0)
    $btnRefresh.add_Click({ $box.Text = Get-DiagnosticReport })

    $btnClose2 = New-Object System.Windows.Forms.Button
    $btnClose2.Text = '关闭'
    $btnClose2.AutoSize = $true
    $btnClose2.Margin = New-Object System.Windows.Forms.Padding(0, 0, 6, 0)
    $btnClose2.add_Click({ $txt.Close() })

    $bar.Controls.Add($btnCopy)
    $bar.Controls.Add($btnSave)
    $bar.Controls.Add($btnRefresh)
    $bar.Controls.Add($btnClose2)

    $txt.Controls.Add($box)
    $txt.Controls.Add($bar)
    [void]$txt.ShowDialog($form)
}

function Stop-Host {
    $procs = Get-HostProcs
    if ($procs.Count -eq 0) { return }
    foreach ($p in $procs) {
        try {
            $p.Kill()
            [void]$p.WaitForExit(8000)
        } catch { }
    }
    for ($i = 0; $i -lt 20; $i++) {
        if ((Get-HostProcs).Count -eq 0) { break }
        Start-Sleep -Milliseconds 300
    }
}

function Start-Host {
    param([string]$Dir)
    $exe = Join-Path $Dir 'SeewoServiceAssistant.exe'
    if (-not (Test-Path -LiteralPath $exe)) { throw ('找不到 ' + $exe) }
    Start-Process -FilePath $exe -WorkingDirectory $Dir
    for ($i = 0; $i -lt 30; $i++) {
        if ((Get-HostProcs).Count -gt 0) { return $true }
        Start-Sleep -Milliseconds 400
    }
    return $false
}

# ---------------------------------------------------------------------------
# 注入状态检测
# ---------------------------------------------------------------------------
# 注入版本检测 / 升级
#   注入块里会写一行「// 注入版本: x.y.z」。
#   本程序自身版本 = $script:InjectionVersion（由 Build-Exe 内联或库文件提供）。
#   两者不一致 -> 需要升级（进安全模式重装）。
# ---------------------------------------------------------------------------

function Get-InjectedVersion {
    param([string]$MainText)
    if (-not $MainText) { return $null }
    $m = [regex]::Match($MainText, '//\s*注入版本:\s*([0-9]+\.[0-9]+\.[0-9]+)')
    if ($m.Success) { return $m.Groups[1].Value }
    return $null
}

# 返回 'none' | 'current' | 'outdated' | 'unknown'
function Get-InjectionVersionState {
    param($State)

    if (-not $State -or -not $State.Injected) { return 'none' }

    # 已经是注入状态，读一下版本号
    try {
        $info = Read-AsarHeader $State.Asar
        $leaves = Get-AsarLeaves $info.Header
        $mainLeaf = $null
        foreach ($l in $leaves) { if ($l.Rel -eq 'main.js') { $mainLeaf = $l } }
        if ($null -eq $mainLeaf) { return 'unknown' }
        $txt = [System.Text.Encoding]::UTF8.GetString((Get-EntryBytes $info $mainLeaf))
        $installed = Get-InjectedVersion -MainText $txt
        if (-not $installed) { return 'outdated' }   # 老版本注入块没有版本行
        if ($installed -eq $script:InjectionVersion) { return 'current' }
        return 'outdated'
    } catch {
        return 'unknown'
    }
}

# ---------------------------------------------------------------------------

function Get-InjectionState {
    $st = [pscustomobject]@{
        Dir = $null; Asar = $null; AsarExists = $false; BakExists = $false
        Injected = $false; ProcessRunning = $false; CanCheck = $false; Error = $null
    }
    $st.ProcessRunning = ((Get-HostProcs).Count -gt 0)

    if (-not (Get-Command Resolve-SeewoDirEmbedded -ErrorAction SilentlyContinue)) { return $st }
    if (-not (Get-Command Read-AsarHeader -ErrorAction SilentlyContinue)) { return $st }

    try {
        $dir = Resolve-SeewoDirEmbedded
        if (-not $dir) { return $st }
        $st.Dir = $dir
        $asar = Join-Path $dir 'resources\app.asar'
        $st.Asar = $asar
        $st.AsarExists = Test-Path -LiteralPath $asar
        $st.BakExists = Test-Path -LiteralPath ($asar + '.bak')

        if ($st.AsarExists) {
            $info = Read-AsarHeader $asar
            $leaves = Get-AsarLeaves $info.Header
            $mainLeaf = $null
            foreach ($l in $leaves) { if ($l.Rel -eq 'main.js') { $mainLeaf = $l } }
            if ($null -ne $mainLeaf) {
                $txt = [System.Text.Encoding]::UTF8.GetString((Get-EntryBytes $info $mainLeaf))
                $st.Injected = $txt.Contains($script:MarkBegin)
            }
            $st.CanCheck = $true
        }
    } catch {
        $st.Error = $_.Exception.Message
    }
    return $st
}

# ---------------------------------------------------------------------------
# 预览（命令桥）
# ---------------------------------------------------------------------------

# 向管家命令桥发一条命令并等待结果（GUI 是独立进程，只能这样通信）
function Invoke-BridgeCommand {
    param([string]$Name, $Args)
    if (-not (Test-Path -LiteralPath $script:ConfigDir)) {
        New-Item -ItemType Directory -Path $script:ConfigDir -Force | Out-Null
    }
    $seq = [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
    $argsObj = [pscustomobject]@{}
    if ($null -ne $Args) { $argsObj = $Args }
    $cmd = [pscustomobject]@{
        seq = $seq; cmd = $Name; args = $argsObj; at = (Get-Date).ToString('o')
    } | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($script:CommandPath, $cmd, $script:Utf8NoBom)

    $deadline = (Get-Date).AddSeconds(5)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 250
        if (Test-Path -LiteralPath $script:ResultPath) {
            try {
                $r = [System.IO.File]::ReadAllText($script:ResultPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
                if ($null -ne $r -and [long]$r.seq -eq $seq) { return $r }
            } catch { }
        }
    }
    return $null
}

function Invoke-Preview {
    param($Payload)
    # 传了 Payload 就用它直接预览（不必先保存到磁盘）
    $a = $null
    if ($null -ne $Payload) { $a = [pscustomobject]@{ payload = $Payload } }
    return Invoke-BridgeCommand -Name 'preview' -Args $a
}

# ---------------------------------------------------------------------------
# 界面
# ---------------------------------------------------------------------------

$form = New-Object System.Windows.Forms.Form
$form.Text = '希沃屏保配置'
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'Sizable'
$form.MaximizeBox = $true
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)

# 尺寸收敛到屏幕工作区，避免小屏/高缩放下超出屏幕
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$wantW = 680
$wantH = 780
if ($wantW -gt ($wa.Width - 40)) { $wantW = $wa.Width - 40 }
if ($wantH -gt ($wa.Height - 40)) { $wantH = $wa.Height - 40 }
if ($wantW -lt 460) { $wantW = 460 }
if ($wantH -lt 380) { $wantH = 380 }
$form.Size = New-Object System.Drawing.Size($wantW, $wantH)
$form.MinimumSize = New-Object System.Drawing.Size(460, 380)

# ---- 顶部：状态区（自适应高度，长路径自动换行）----
$panelTop = New-Object System.Windows.Forms.Panel
$panelTop.Dock = 'Fill'
# ★ 不用 AutoSize：WinForms 里 AutoSize + Dock 组合算不准高度，
#   会把下面两个开关盖住。改为按文字实际首选高度精确计算。
$panelTop.Height = 96
$panelTop.Padding = New-Object System.Windows.Forms.Padding(10, 8, 10, 6)

$lblStatus = New-Object System.Windows.Forms.Label
$lblStatus.AutoSize = $true
$lblStatus.Dock = 'Top'
$lblStatus.MaximumSize = New-Object System.Drawing.Size(620, 0)
$lblStatus.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10)
$lblStatus.Text = ''
$panelTop.Controls.Add($lblStatus)

function Update-StatusHeight {
    try {
        $w = $form.ClientSize.Width - 44
        if ($w -lt 240) { $w = 240 }
        $lblStatus.MaximumSize = New-Object System.Drawing.Size($w, 0)
        $pref = $lblStatus.GetPreferredSize((New-Object System.Drawing.Size($w, 0)))
        $h = $pref.Height + 20
        if ($h -lt 48) { $h = 48 }
        if ($panelTop.Height -ne $h) { $panelTop.Height = $h }
    } catch { }
}

# ---- 底部：按钮栏（固定，永远可见）----
# ★ 底部栏原本是「固定 66px + 不换行」，而按钮+链接实测需要约 728px，
#   窗口默认 680、最窄 460 —— 右侧的「临时换图」必定被裁掉（只见一个「临」字）。
#   改为：行高自适应 + 允许换行 + 文案缩短。
$panelBottom = New-Object System.Windows.Forms.Panel
$panelBottom.Dock = 'Top'
$panelBottom.AutoSize = $true
$panelBottom.AutoSizeMode = 'GrowAndShrink'
$panelBottom.MinimumSize = New-Object System.Drawing.Size(0, 50)

$flowBottom = New-Object System.Windows.Forms.FlowLayoutPanel
$flowBottom.Dock = 'Top'
$flowBottom.AutoSize = $true
$flowBottom.AutoSizeMode = 'GrowAndShrink'
$flowBottom.MinimumSize = New-Object System.Drawing.Size(0, 46)
$flowBottom.FlowDirection = 'LeftToRight'
$flowBottom.WrapContents = $true
$flowBottom.Padding = New-Object System.Windows.Forms.Padding(10, 8, 10, 6)
$panelBottom.Controls.Add($flowBottom)

$btnSave = New-Object System.Windows.Forms.Button
$btnSave.Text = '保存配置'
$btnSave.Size = New-Object System.Drawing.Size(130, 38)
$btnSave.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10, [System.Drawing.FontStyle]::Bold)
$flowBottom.Controls.Add($btnSave)

$btnPreview = New-Object System.Windows.Forms.Button
$btnPreview.Text = '预览屏保'
$btnPreview.Size = New-Object System.Drawing.Size(130, 38)
$btnPreview.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10, [System.Drawing.FontStyle]::Bold)
$flowBottom.Controls.Add($btnPreview)

$btnUninstall = New-Object System.Windows.Forms.Button
$btnUninstall.Text = '卸载还原'
$btnUninstall.Size = New-Object System.Drawing.Size(140, 38)
$flowBottom.Controls.Add($btnUninstall)

$linkLog = New-Object System.Windows.Forms.LinkLabel
$linkLog.Text = '日志'
$linkLog.AutoSize = $true
$linkLog.Margin = New-Object System.Windows.Forms.Padding(10, 12, 3, 3)
$flowBottom.Controls.Add($linkLog)

$linkDiag = New-Object System.Windows.Forms.LinkLabel
$linkDiag.Text = '诊断'
$linkDiag.AutoSize = $true
$linkDiag.Margin = New-Object System.Windows.Forms.Padding(10, 12, 3, 3)
$flowBottom.Controls.Add($linkDiag)

$linkClean = New-Object System.Windows.Forms.LinkLabel
$linkClean.Text = '清理'
$linkClean.AutoSize = $true
$linkClean.Margin = New-Object System.Windows.Forms.Padding(10, 12, 3, 3)
$flowBottom.Controls.Add($linkClean)

$linkSwap = New-Object System.Windows.Forms.LinkLabel
$linkSwap.Text = '临时换图'
$linkSwap.AutoSize = $true
$linkSwap.Margin = New-Object System.Windows.Forms.Padding(10, 12, 3, 3)
$flowBottom.Controls.Add($linkSwap)

$linkHelp = New-Object System.Windows.Forms.LinkLabel
$linkHelp.Text = '说明'
$linkHelp.AutoSize = $true
$linkHelp.Margin = New-Object System.Windows.Forms.Padding(10, 12, 3, 3)
$flowBottom.Controls.Add($linkHelp)
$script:PanelBottom = $panelBottom

# ---- 中间：可滚动区 ----
$panelMain = New-Object System.Windows.Forms.Panel
$panelMain.Dock = 'Fill'
$panelMain.AutoScroll = $true
$panelMain.Padding = New-Object System.Windows.Forms.Padding(10, 6, 10, 6)

$btnInstall = New-Object System.Windows.Forms.Button
$btnInstall.Text = '一键安装'
$btnInstall.Dock = 'Top'
$btnInstall.Height = 56
$btnInstall.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 12, [System.Drawing.FontStyle]::Bold)
$panelMain.Controls.Add($btnInstall)

$btnImageSwap = New-Object System.Windows.Forms.Button
$btnImageSwap.Text = '临时换图（免安装 · 只改图片，不改程序）'
$btnImageSwap.Dock = 'Top'
$btnImageSwap.Height = 44
$panelMain.Controls.Add($btnImageSwap)

# 配置区：TableLayoutPanel（标签自适应，输入框填满剩余宽度）
#   ★ 用表格布局代替绝对坐标，高 DPI / 不同字号下都不会截断或重叠。
$table = New-Object System.Windows.Forms.TableLayoutPanel
$table.Dock = 'Top'
$table.AutoSize = $true
$table.AutoSizeMode = 'GrowAndShrink'
$table.ColumnCount = 2
$table.Padding = New-Object System.Windows.Forms.Padding(4, 8, 4, 8)
[void]$table.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::AutoSize)))
[void]$table.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100)))
$panelMain.Controls.Add($table)
$group = $table

function New-AuraRowLabel {
    param([string]$Text)
    $l = New-Object System.Windows.Forms.Label
    $l.Text = $Text
    $l.AutoSize = $true
    $l.Anchor = 'Left'
    $l.Margin = New-Object System.Windows.Forms.Padding(3, 7, 10, 3)
    return $l
}

$chkEnabled = New-Object System.Windows.Forms.CheckBox
$chkEnabled.Text = '启用屏保（关闭后，集控再下发也不会弹出）'
$chkEnabled.AutoSize = $true
$chkEnabled.Margin = New-Object System.Windows.Forms.Padding(3, 6, 3, 2)
$table.Controls.Add($chkEnabled)
$table.SetColumnSpan($chkEnabled, 2)

$chkLock = New-Object System.Windows.Forms.CheckBox
$chkLock.Text = '关闭屏保后自动锁屏（建议不勾）'
$chkLock.AutoSize = $true
$chkLock.Margin = New-Object System.Windows.Forms.Padding(3, 2, 3, 8)
$table.Controls.Add($chkLock)
$table.SetColumnSpan($chkLock, 2)

$lblSection = New-AuraRowLabel '屏保内容（三选一）'
$lblSection.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9, [System.Drawing.FontStyle]::Bold)
$lblSection.Margin = New-Object System.Windows.Forms.Padding(3, 10, 3, 4)
$table.Controls.Add($lblSection)
$table.SetColumnSpan($lblSection, 2)

# 三种模式互斥：选了哪种，下面就只显示哪种的选项。
#   自定义图集 -> 用自己配的图片/文案
#   网页屏保   -> 用网页当屏保（动画不受官方 7 种转场限制）
#   不修改     -> 完全沿用集控下发的图片与文案
$modePanel = New-Object System.Windows.Forms.FlowLayoutPanel
$modePanel.AutoSize = $true
$modePanel.WrapContents = $true
$modePanel.Margin = New-Object System.Windows.Forms.Padding(3, 2, 3, 8)

$rbModeImage = New-Object System.Windows.Forms.RadioButton
$rbModeImage.Text = '自定义图集'
$rbModeImage.AutoSize = $true
$rbModeImage.Margin = New-Object System.Windows.Forms.Padding(0, 0, 20, 0)
$modePanel.Controls.Add($rbModeImage)

$rbModeWeb = New-Object System.Windows.Forms.RadioButton
$rbModeWeb.Text = '网页屏保'
$rbModeWeb.AutoSize = $true
$rbModeWeb.Margin = New-Object System.Windows.Forms.Padding(0, 0, 20, 0)
$modePanel.Controls.Add($rbModeWeb)

$rbModeNone = New-Object System.Windows.Forms.RadioButton
$rbModeNone.Text = '不修改图片（沿用集控图，参数仍可调）'
$rbModeNone.AutoSize = $true
$rbModeNone.Margin = New-Object System.Windows.Forms.Padding(0)
$modePanel.Controls.Add($rbModeNone)
$rbModeNone.Checked = $true

$table.Controls.Add($modePanel)
$table.SetColumnSpan($modePanel, 2)

$lblR1 = New-AuraRowLabel '素材来源（右下角文案）'
$table.Controls.Add($lblR1)
$txtSource = New-Object System.Windows.Forms.TextBox
$txtSource.Anchor = 'Left,Right'
$txtSource.Margin = New-Object System.Windows.Forms.Padding(3, 4, 3, 4)
$table.Controls.Add($txtSource)

# ★ 用户实测把文件夹路径填进了「素材来源」。这里就地提醒，别等看到屏保才发现。
$lblSourceWarn = New-Object System.Windows.Forms.Label
$lblSourceWarn.AutoSize = $true
$lblSourceWarn.ForeColor = [System.Drawing.Color]::Firebrick
$lblSourceWarn.Margin = New-Object System.Windows.Forms.Padding(3, 0, 3, 2)
$lblSourceWarn.Visible = $false
$table.Controls.Add($lblSourceWarn)
$table.SetColumnSpan($lblSourceWarn, 2)

$lblR2 = New-AuraRowLabel '切换间隔（秒）'
$table.Controls.Add($lblR2)
$numInterval = New-Object System.Windows.Forms.NumericUpDown
$numInterval.Width = 90
$numInterval.Minimum = 1
$numInterval.Maximum = 3600
$numInterval.Value = 15
$numInterval.Anchor = 'Left'
$numInterval.Margin = New-Object System.Windows.Forms.Padding(3, 4, 3, 4)
$table.Controls.Add($numInterval)

$lblR3 = New-AuraRowLabel '图片适配'
$table.Controls.Add($lblR3)
$flowFit = New-Object System.Windows.Forms.FlowLayoutPanel
$flowFit.AutoSize = $true
$flowFit.WrapContents = $false
$flowFit.Margin = New-Object System.Windows.Forms.Padding(0)
$table.Controls.Add($flowFit)

$rbContain = New-Object System.Windows.Forms.RadioButton
$rbContain.Text = '留边完整显示'
$rbContain.AutoSize = $true
$rbContain.Checked = $true
$rbContain.Margin = New-Object System.Windows.Forms.Padding(3, 4, 12, 4)
$flowFit.Controls.Add($rbContain)

$rbCover = New-Object System.Windows.Forms.RadioButton
$rbCover.Text = '裁剪铺满'
$rbCover.AutoSize = $true
$rbCover.Margin = New-Object System.Windows.Forms.Padding(3, 4, 3, 4)
$flowFit.Controls.Add($rbCover)

$lblR4 = New-AuraRowLabel '图片列表'
$table.Controls.Add($lblR4)
$imgPanel = New-Object System.Windows.Forms.Panel
$imgPanel.Anchor = 'Left,Right'
$imgPanel.Height = 176
$imgPanel.Margin = New-Object System.Windows.Forms.Padding(3, 4, 3, 4)

# ★ 按钮行允许换行：窗口窄/高DPI 时按钮不会互相压住
$imgBar = New-Object System.Windows.Forms.FlowLayoutPanel
$imgBar.Dock = 'Top'
$imgBar.AutoSize = $true
$imgBar.AutoSizeMode = 'GrowAndShrink'
$imgBar.WrapContents = $true
$imgBar.MinimumSize = New-Object System.Drawing.Size(0, 34)

$btnPickFolder = New-Object System.Windows.Forms.Button
$btnPickFolder.Text = '选择文件夹…'
$btnPickFolder.AutoSize = $true
$btnPickFolder.Margin = New-Object System.Windows.Forms.Padding(0, 2, 8, 2)
$imgBar.Controls.Add($btnPickFolder)

$btnPickFiles = New-Object System.Windows.Forms.Button
$btnPickFiles.Text = '选择图片…'
$btnPickFiles.AutoSize = $true
$btnPickFiles.Margin = New-Object System.Windows.Forms.Padding(0, 2, 8, 2)
$imgBar.Controls.Add($btnPickFiles)

$btnPreviewImgs = New-Object System.Windows.Forms.Button
$btnPreviewImgs.Text = '预览图片'
$btnPreviewImgs.AutoSize = $true
$btnPreviewImgs.Margin = New-Object System.Windows.Forms.Padding(0, 2, 8, 2)
$imgBar.Controls.Add($btnPreviewImgs)

$lblImgCount = New-Object System.Windows.Forms.Label
$lblImgCount.AutoSize = $true
$lblImgCount.ForeColor = [System.Drawing.Color]::DimGray
$lblImgCount.Margin = New-Object System.Windows.Forms.Padding(4, 8, 0, 0)
$imgBar.Controls.Add($lblImgCount)
$imgPanel.Controls.Add($imgBar)

$txtImages = New-Object System.Windows.Forms.TextBox
$txtImages.Multiline = $true
$txtImages.ScrollBars = 'Vertical'
$txtImages.AcceptsReturn = $true
$txtImages.Dock = 'Fill'
$txtImages.Font = New-Object System.Drawing.Font('Consolas', 8)

# ★ 顺序很重要：Fill 的控件必须**先**加，Top/Bottom 后加，
#   否则 Dock 计算会把 Fill 挤到 0 高度（上一版就是这样崩的）。
$imgPanel.Controls.Add($txtImages)
$imgPanel.Controls.Add($imgBar)
$txtImages.BringToFront()
$table.Controls.Add($imgPanel)

$lblR5 = New-AuraRowLabel '图文条目'
$table.Controls.Add($lblR5)
$txtTexts = New-Object System.Windows.Forms.TextBox
$txtTexts.Multiline = $true
$txtTexts.ScrollBars = 'Vertical'
$txtTexts.AcceptsReturn = $true
$txtTexts.Height = 70
$txtTexts.Anchor = 'Left,Right'
$txtTexts.Margin = New-Object System.Windows.Forms.Padding(3, 4, 3, 4)
$table.Controls.Add($txtTexts)

$lblR6 = New-AuraRowLabel '转场效果'
$table.Controls.Add($lblR6)
$transPanel = New-Object System.Windows.Forms.FlowLayoutPanel
$transPanel.AutoSize = $true
$transPanel.WrapContents = $false
$transPanel.Margin = New-Object System.Windows.Forms.Padding(0)

$txtTrans = New-Object System.Windows.Forms.TextBox
$txtTrans.Width = 130
$txtTrans.Margin = New-Object System.Windows.Forms.Padding(3, 4, 8, 4)
$transPanel.Controls.Add($txtTrans)

$btnTransRandom = New-Object System.Windows.Forms.Button
$btnTransRandom.Text = '随机生成'
$btnTransRandom.AutoSize = $true
$btnTransRandom.Margin = New-Object System.Windows.Forms.Padding(0, 2, 6, 2)
$transPanel.Controls.Add($btnTransRandom)

$btnTransClear = New-Object System.Windows.Forms.Button
$btnTransClear.Text = '清空'
$btnTransClear.AutoSize = $true
$btnTransClear.Margin = New-Object System.Windows.Forms.Padding(0, 2, 0, 2)
$transPanel.Controls.Add($btnTransClear)
$table.Controls.Add($transPanel)

# ★ 提示文字单独占一整行并跨两列。
#   之前它和输入框挤在第 1 列（宽度 = 100% 减去第一列标签宽），必然溢出被截断。
$lblTransHint = New-Object System.Windows.Forms.Label
$lblTransHint.AutoSize = $true
$lblTransHint.ForeColor = [System.Drawing.Color]::DimGray
$lblTransHint.Margin = New-Object System.Windows.Forms.Padding(3, 0, 3, 4)
$lblTransHint.Text = '切换动画编号 0-6（共 7 种）。留空 = 每次随机；填 1 个 = 全部相同；填满 N 个 = 逐图对应'
$table.Controls.Add($lblTransHint)
$table.SetColumnSpan($lblTransHint, 2)

# ---------------------------------------------------------------------------
# 字段说明：悬停提示 + 「说明」窗
#   界面要保持简洁，所以说明不写在界面上，按需出现。
# ---------------------------------------------------------------------------
$toolTip = New-Object System.Windows.Forms.ToolTip
$toolTip.AutoPopDelay = 30000
$toolTip.InitialDelay = 250
$toolTip.ReshowDelay = 100

$toolTip.SetToolTip($chkEnabled, '屏保总开关。' + $script:NL + '关闭后集控再下发也不会弹屏保。' + $script:NL + '（手动「预览」不受它限制，方便看效果）')
$toolTip.SetToolTip($chkLock, '关闭屏保窗口时是否顺带锁屏。' + $script:NL + '建议不勾：希沃官方此处调用了自己不存在的 startLock()，本工具默认切断这条级联。')
$toolTip.SetToolTip($modePanel, '三选一，决定屏保显示什么。' + $script:NL + '选中后下面只会显示该模式对应的选项。')
$toolTip.SetToolTip($rbModeImage, '用你自己配的图片、文案与转场。' + $script:NL + '适合把屏保换成自己的图。')
$toolTip.SetToolTip($rbModeWeb, '用网页当屏保，动画完全由网页决定。' + $script:NL + 'CSS 动画 / JS / 视频 / Canvas 都行，不受官方那 7 种转场限制。')
$toolTip.SetToolTip($rbModeNone, '什么都不改，完全沿用集控下发的图片与文案。' + $script:NL + '想恢复官方行为时选这个。')
$toolTip.SetToolTip($txtSource, '屏保右下角显示的那行小字，例如「素材来自 XX」。' + $script:NL + '★ 这里填的是展示文案，不是图片路径。')
$toolTip.SetToolTip($numInterval, '每张图片停留多少秒。' + $script:NL + '渲染器内部会 ×1000 转成毫秒。')
$toolTip.SetToolTip($flowFit, '图片比例与屏幕不一致时怎么办：' + $script:NL + '留边完整显示 = 不裁剪，两侧留黑边；' + $script:NL + '裁剪铺满 = 填满全屏，但会裁掉超出部分。')
$toolTip.SetToolTip($imgPanel, '要轮播的图片，每行一个路径。' + $script:NL + '用「选择文件夹…」可一次加入整个文件夹里的图片。' + $script:NL + '支持静止图与动图：jpg / png / bmp / gif / webp / apng / avif。' + $script:NL + 'gif、webp、apng 会自己动（渲染器用的是 CSS background-image，动图原生播放）。')
$toolTip.SetToolTip($txtTexts, '屏保上显示的正文文字，每行一条。' + $script:NL + '格式：内容|出处（出处可省略）。')
$toolTip.SetToolTip($transPanel, '每张图的切换动画编号（0-6 共 7 种）。' + $script:NL + '留空 = 每次随机；填 1 个 = 全部相同；填满 N 个 = 逐图对应。')

$lblR7 = New-AuraRowLabel '网页屏保'
$table.Controls.Add($lblR7)
$webPanel = New-Object System.Windows.Forms.FlowLayoutPanel
$webPanel.AutoSize = $true
$webPanel.WrapContents = $true
$webPanel.Margin = New-Object System.Windows.Forms.Padding(0)


$chkWebSys = New-Object System.Windows.Forms.CheckBox
$chkWebSys.Text = '用系统浏览器（Edge/Chrome，新内核）'
$chkWebSys.AutoSize = $true
$chkWebSys.Margin = New-Object System.Windows.Forms.Padding(3, 6, 14, 4)
$webPanel.Controls.Add($chkWebSys)

$btnWebBrowser = New-Object System.Windows.Forms.Button
$btnWebBrowser.Text = '手动选择浏览器…'
$btnWebBrowser.AutoSize = $true
$btnWebBrowser.Margin = New-Object System.Windows.Forms.Padding(0, 2, 6, 2)
$webPanel.Controls.Add($btnWebBrowser)
$btnWebPick = New-Object System.Windows.Forms.Button
$btnWebPick.Text = '选择网页文件…'
$btnWebPick.AutoSize = $true
$btnWebPick.Margin = New-Object System.Windows.Forms.Padding(0, 2, 6, 2)
$webPanel.Controls.Add($btnWebPick)

$table.Controls.Add($webPanel)

$lblWebHint = New-Object System.Windows.Forms.Label
$lblWebHint.AutoSize = $true
$lblWebHint.ForeColor = [System.Drawing.Color]::DimGray
$lblWebHint.Margin = New-Object System.Windows.Forms.Padding(3, 0, 3, 4)
$lblWebHint.Text = '勾选后，屏保改由网页显示 —— 网页里怎么写就怎么动（CSS 动画 / JS / 视频 / Canvas 都行），所以动画不受官方那 7 种转场限制。'
$table.Controls.Add($lblWebHint)
$table.SetColumnSpan($lblWebHint, 2)

$lblR8 = New-AuraRowLabel '网页地址'
$table.Controls.Add($lblR8)
$txtWebUrl = New-Object System.Windows.Forms.TextBox
$txtWebUrl.Anchor = 'Left,Right'
$txtWebUrl.Margin = New-Object System.Windows.Forms.Padding(3, 4, 3, 4)
$table.Controls.Add($txtWebUrl)

$lblRBrowser = New-AuraRowLabel '浏览器路径（可选）'
$table.Controls.Add($lblRBrowser)
$txtWebBrowser = New-Object System.Windows.Forms.TextBox
$txtWebBrowser.Anchor = 'Left,Right'
$txtWebBrowser.Margin = New-Object System.Windows.Forms.Padding(3, 4, 3, 4)
$table.Controls.Add($txtWebBrowser)

$lblBrowserHint = New-Object System.Windows.Forms.Label
$lblBrowserHint.AutoSize = $true
$lblBrowserHint.ForeColor = [System.Drawing.Color]::DimGray
$lblBrowserHint.Margin = New-Object System.Windows.Forms.Padding(3, 0, 3, 4)
$lblBrowserHint.Text = '留空 = 自动查找 Edge/Chrome。自动找不到时点上面的按钮手动指定 msedge.exe'
$table.Controls.Add($lblBrowserHint)
$table.SetColumnSpan($lblBrowserHint, 2)

$toolTip.SetToolTip($webPanel, '用网页当屏保：勾选后集控下发的屏保会被替换成这个网页。' + $script:NL + '网页里的 CSS/JS/视频都能用，等于不受官方转场类型限制。' + $script:NL + '按 ESC 可退出全屏。')
$toolTip.SetToolTip($chkWebSys, '勾上后用系统里的 Edge/Chrome 以全屏 kiosk 方式打开网页。' + $script:NL + '好处：内核始终是最新的（Windows 自带 Edge 会自动更新），能正常打开用新语法的站点 —— 希沃自带的内核太旧，那些站点会只显示一半。' + $script:NL + '退出：按 Alt+F4。')
$toolTip.SetToolTip($txtWebBrowser, '自动找不到 Edge/Chrome 时，这里手动指定一个浏览器 exe。' + $script:NL + '点上面的按钮选 msedge.exe 或 chrome.exe 即可；留空则自动查找。')
$toolTip.SetToolTip($txtWebUrl, '网址（https://…）或本地 HTML 文件路径，例如 D:\anim\show.html' + $script:NL + '本地路径会自动转成 file:///')

# 素材来源：值看起来像路径时就地告警
$txtSource.add_TextChanged({
    try {
        $v = $txtSource.Text.Trim()
        if ($v -ne '' -and ($v -match '[\\/]' -or $v -match '^[A-Za-z]:')) {
            $lblSourceWarn.Text = '⚠ 这看起来是路径；此处应填展示文案（屏保右下角显示的那行字）'
            $lblSourceWarn.Visible = $true
        } else {
            $lblSourceWarn.Visible = $false
        }
    } catch { }
})

# 顶部 / 底部 / 填充 的添加顺序（Fill 最后加，避免盖住其它面板）
# ---- 根布局：三行表格（顶部自适应 / 中间填充 / 底部固定）----
#   ★ 用 TableLayoutPanel 而不是 Dock 叠加：行高按行样式确定，
#     不会出现「某个面板高度算不准、盖住下面」的问题。
$root = New-Object System.Windows.Forms.TableLayoutPanel
$root.Dock = 'Fill'
$root.ColumnCount = 1
$root.RowCount = 3
[void]$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize)))
[void]$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100)))
[void]$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize)))
$form.Controls.Add($root)
$root.Controls.Add($panelTop, 0, 0)
$root.Controls.Add($panelMain, 0, 1)
$root.Controls.Add($panelBottom, 0, 2)

# 让状态区在窗口变窄时仍能完整换行显示
$form.add_Resize({
    try { Update-StatusHeight } catch { }
})
# ---------------------------------------------------------------------------
# 图片选择与预览
#   用 Windows 标准对话框（FolderBrowserDialog / OpenFileDialog）取路径，
#   不要把路径手打 —— 手打容易出错，且中文/空格路径难处理。
# ---------------------------------------------------------------------------
# 转场效果解析
#   三种输入都合法：
#     留空      -> 空数组（渲染器每次随机）
#     1 个值    -> 应用到全部图片
#     N 个值    -> 逐图对应（N = 图片数）
#   其它数量或越界值 -> 抛出说明「该怎么填」的错误
#
#   ★ 抽成独立函数是为了可测：这段规则曾出现自相矛盾的提示
#     （填 1 个值报「数量必须等于图片数」，填越界值又报「必须是 0-6」），
#     放在 Build-Config 里读 WinForms 控件就没法单测。
# ---------------------------------------------------------------------------

function ConvertTo-TransitionList {
    param(
        [string]$Raw,
        [int]$ImageCount
    )

    $trans = @()
    $text = ''
    if ($null -ne $Raw) { $text = ([string]$Raw).Trim() }
    if ($text -eq '') { return ,$trans }

    $parts = @()
    # 分隔符兼容半角与全角：, ; 空格  以及 ， ； 、
    foreach ($p in ($text -split '[,;，；、\s]+')) { if ($p -ne '') { $parts += $p } }
    if ($parts.Count -eq 0) { return ,$trans }

    $nums = @()
    for ($ti = 0; $ti -lt $parts.Count; $ti++) {
        $v = 0
        if (-not [int]::TryParse($parts[$ti], [ref]$v)) {
            throw ('转场第 ' + ($ti + 1) + ' 个值「' + $parts[$ti] + '」不是整数。' + [Environment]::NewLine +
                '转场是每张图的切换动画编号，只能填 0-6 的整数。')
        }
        if ($v -lt 0 -or $v -gt 6) {
            throw ('转场第 ' + ($ti + 1) + ' 个值「' + $parts[$ti] + '」超出范围。' + [Environment]::NewLine +
                '转场编号只能是 0、1、2、3、4、5、6（共 7 种切换动画）。')
        }
        $nums += $v
    }

    if ($nums.Count -eq 1) {
        for ($i = 0; $i -lt $ImageCount; $i++) { $trans += $nums[0] }
        return ,$trans
    }
    if ($nums.Count -eq $ImageCount) { return ,$nums }

    throw ('转场填了 ' + $nums.Count + ' 个值，但图片有 ' + $ImageCount + ' 张。' + [Environment]::NewLine +
        '请三选一：' + [Environment]::NewLine +
        '  ① 只填 1 个值 —— 应用到全部图片' + [Environment]::NewLine +
        '  ② 填满 ' + $ImageCount + ' 个值 —— 逐图对应' + [Environment]::NewLine +
        '  ③ 留空 —— 每次切换随机')
}

# ---------------------------------------------------------------------------

function Get-ImageFilesInFolder {
    param([string]$Folder)
    if (-not (Test-Path -LiteralPath $Folder)) { return @() }
    return @(Get-ChildItem -LiteralPath $Folder -File -ErrorAction SilentlyContinue |
        Where-Object { @('.jpg', '.jpeg', '.png', '.bmp', '.gif', '.webp', '.apng', '.avif', '.jfif') -contains $_.Extension.ToLower() } |
        Sort-Object Name)
}

# 把选中的图片填进图片列表，并刷新计数提示
function Set-ImageListFromPaths {
    param($Paths)
    $cur = @()
    if ($txtImages.Text.Trim() -ne '') {
        $cur = @($txtImages.Text -split "\r?\n" | Where-Object { $_.Trim() -ne '' })
    }
    foreach ($p in @($Paths)) {
        if ($p -and ($cur -notcontains $p)) { $cur += $p }
    }
    $txtImages.Text = ($cur -join $script:NL)
    Update-ImageCountHint
}

function Update-ImageCountHint {
    try {
        $n = 0
        if ($txtImages.Text.Trim() -ne '') {
            $n = @($txtImages.Text -split "\r?\n" | Where-Object { $_.Trim() -ne '' }).Count
        }
        $missing = 0
        if ($n -gt 0) {
            foreach ($line in ($txtImages.Text -split "\r?\n")) {
                $v = $line.Trim()
                if ($v -eq '') { continue }
                if (-not (Test-Path -LiteralPath $v)) { $missing++ }
            }
        }
        $txt2 = ('共 ' + $n + ' 张')
        if ($missing -gt 0) { $txt2 += ('，其中 ' + $missing + ' 张路径不存在') }
        $lblImgCount.Text = $txt2
        if ($missing -gt 0) { $lblImgCount.ForeColor = [System.Drawing.Color]::Firebrick }
        else { $lblImgCount.ForeColor = [System.Drawing.Color]::DimGray }
    } catch { }
}

# 图片预览窗（列表 + 缩略图）
# ---------------------------------------------------------------------------
# 图片预览时的 Image / Stream 生命周期管理
#   ★ 动图（GIF/WebP/APNG）由 ImageAnimator 在播放期间**不断回读原始流**。
#     之前用 OpenRead 读完后立刻 Close()，动画取帧时就抛
#     「GDI+ 中发生一般性错误」（用户实测：动图预览直接崩）。
#     这里显式持有 Image 与 Stream，换图/关窗前彻底释放。
# ---------------------------------------------------------------------------

$script:PrevImg = $null
$script:PrevStream = $null

function Clear-PreviewImage {
    try { if ($null -ne $script:PrevImg) { $script:PrevImg.Dispose() } } catch { }
    try { if ($null -ne $script:PrevStream) { $script:PrevStream.Dispose() } } catch { }
    $script:PrevImg = $null
    $script:PrevStream = $null
}

# 把图片装进 PictureBox；成功返回空串，失败返回错误信息
function Set-PreviewImage {
    param($PictureBox, [string]$Path)

    # 换图前先彻底释放上一张（含它的流与动画），否则两个动画会打架
    try { $PictureBox.Image = $null } catch { }
    Clear-PreviewImage

    if (-not (Test-Path -LiteralPath $Path)) { return '文件不存在' }

    try {
        # ★ 先整读成字节再包 MemoryStream —— 动图播放期间这个流必须一直可用
        $bytes = [System.IO.File]::ReadAllBytes($Path)
        $ms = New-Object System.IO.MemoryStream(,$bytes)
        $img = [System.Drawing.Image]::FromStream($ms)
        $script:PrevImg = $img
        $script:PrevStream = $ms
        $PictureBox.Image = $img
        return ''
    } catch {
        Clear-PreviewImage
        return $_.Exception.Message
    }
}

function Show-ImagePreviewDialog {
    $paths = @()
    if ($txtImages.Text.Trim() -ne '') {
        $paths = @($txtImages.Text -split "\r?\n" | Where-Object { $_.Trim() -ne '' } | ForEach-Object { $_.Trim() })
    }
    if ($paths.Count -eq 0) {
        [System.Windows.Forms.MessageBox]::Show('图片列表为空，先选几张图片吧。', '没有图片', 'OK', 'Information') | Out-Null
        return
    }

    $dlg = New-Object System.Windows.Forms.Form
    $dlg.Text = '图片预览（' + $paths.Count + ' 张）'
    $dlg.Size = New-Object System.Drawing.Size(860, 580)
    $dlg.MinimumSize = New-Object System.Drawing.Size(560, 380)
    $dlg.StartPosition = 'CenterParent'

    $list = New-Object System.Windows.Forms.ListBox
    $list.Dock = 'Left'
    $list.Width = 320
    $list.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 8)
    $list.HorizontalScrollbar = $true

    $pic = New-Object System.Windows.Forms.PictureBox
    $pic.Dock = 'Fill'
    $pic.SizeMode = 'Zoom'
    $pic.BackColor = [System.Drawing.Color]::FromArgb(32, 32, 32)

    $info = New-Object System.Windows.Forms.Label
    $info.Dock = 'Bottom'
    $info.Height = 40

    foreach ($p in $paths) {
        $mark = $(if (Test-Path -LiteralPath $p) { '' } else { '  [不存在]' })
        [void]$list.Items.Add((Split-Path -Leaf $p) + $mark)
    }

    $list.add_SelectedIndexChanged({
        try {
            $i = $list.SelectedIndex
            if ($i -lt 0 -or $i -ge $paths.Count) { return }
            $p = $paths[$i]
            $err = Set-PreviewImage -PictureBox $pic -Path $p
            if ($err -ne '') {
                $info.Text = '无法显示：' + $err
            } else {
                $ext = [System.IO.Path]::GetExtension($p).ToLower()
                $tag = ''
                if (@('.gif', '.webp', '.apng', '.avif') -contains $ext) {
                    $tag = '　［动图，这里和屏保上都会播放］'
                }
                $info.Text = $p + $tag
            }
        } catch {
            $info.Text = '无法显示：' + $_.Exception.Message
        }
    })

    # ★ 关窗前必须断开图片：动画定时器若在控件销毁后回调，就会抛 GDI+ 一般性错误
    $dlg.add_FormClosing({
        try { $pic.Image = $null } catch { }
        Clear-PreviewImage
    })

    $right = New-Object System.Windows.Forms.Panel
    $right.Dock = 'Fill'
    $right.Controls.Add($pic)
    $right.Controls.Add($info)

    $dlg.Controls.Add($right)
    $dlg.Controls.Add($list)
    if ($paths.Count -gt 0) { $list.SelectedIndex = 0 }
    [void]$dlg.ShowDialog($form)
}

function Set-Status {
    param([string]$Text)
    $lblStatus.Text = $Text
    Update-StatusHeight
    [System.Windows.Forms.Application]::DoEvents()
}

# 三选一模式对应的两组成员控件
# 三选一模式对应的三组成员控件
#   图片与文案 —— 只有「自定义图集」才替换，所以只在 image 模式显示
$script:ImgOnlyCtrls = @($lblR1, $txtSource, $lblSourceWarn, $lblR4, $imgPanel, $lblR5, $txtTexts)
#   显示参数 —— 对集控图也生效，所以「不修改图片」模式下照样能调
$script:ParamCtrls = @($lblR2, $numInterval, $lblR3, $flowFit, $lblR6, $transPanel, $lblTransHint)
#   网页 —— 只有「网页屏保」显示
$script:WebRowCtrls = @($lblR7, $webPanel, $lblWebHint, $lblR8, $txtWebUrl, $lblRBrowser, $txtWebBrowser, $lblBrowserHint)

# 网页地址归一化：没写协议的自动补 https://
#   已经是 http/https/file 或本地路径（盘符/UNC/POSIX/相对）的一律不动。
function Normalize-WebInput {
    param([string]$Raw)
    $v = ''
    if ($null -ne $Raw) { $v = $Raw.Trim() }
    if ($v -eq '') { return '' }
    if ($v -match '^[a-zA-Z][a-zA-Z0-9+.-]*://') { return $v }
    if ($v -match '^[A-Za-z]:[\\/]') { return $v }
    if ($v -match '^\\\\') { return $v }
    if ($v -match '^/') { return $v }
    if ($v -match '^\.') { return $v }
    return 'https://' + $v
}

# 按当前模式显示/隐藏对应选项，并同步可用状态
function Update-ModeVisibility {
    $img = $rbModeImage.Checked
    $web = $rbModeWeb.Checked

    foreach ($c in $script:ImgOnlyCtrls) { if ($null -ne $c) { $c.Visible = $img } }
    # 显示参数：网页模式下由网页自己决定一切，所以隐藏；其它模式都显示
    foreach ($c in $script:ParamCtrls) { if ($null -ne $c) { $c.Visible = (-not $web) } }
    foreach ($c in $script:WebRowCtrls) { if ($null -ne $c) { $c.Visible = $web } }

    $txtSource.Enabled = $img
    $txtImages.Enabled = $img
    $txtTexts.Enabled = $img

    $numInterval.Enabled = (-not $web)
    $rbContain.Enabled = (-not $web)
    $rbCover.Enabled = (-not $web)
    $txtTrans.Enabled = (-not $web)

    $chkWebSys.Enabled = $web
    $btnWebBrowser.Enabled = $web
    $txtWebBrowser.Enabled = $web
    $btnWebPick.Enabled = $web
    $txtWebUrl.Enabled = $web

}

function Fill-Form {
    param($Cfg)
    $chkEnabled.Checked = ($Cfg.screensaverEnabled -ne $false)
    $chkLock.Checked = ($Cfg.lockCascadeOnClose -eq $true)

    $ov = $null
    if ($null -ne $Cfg.override) { $ov = $Cfg.override }

    # 模式优先读 mode 字段；旧配置没有时按 web.enabled / override 推断
    $m = [string]$Cfg.mode
    if ($m -ne 'web' -and $m -ne 'image' -and $m -ne 'none') {
        if ($null -ne $Cfg.web -and $Cfg.web.enabled -eq $true) { $m = 'web' }
        elseif ($null -ne $ov) { $m = 'image' }
        else { $m = 'none' }
    }
    $rbModeWeb.Checked = ($m -eq 'web')
    $rbModeImage.Checked = ($m -eq 'image')
    $rbModeNone.Checked = ($m -eq 'none')

    if ($null -ne $Cfg.web -and $null -ne $Cfg.web.url) { $txtWebUrl.Text = [string]$Cfg.web.url } else { $txtWebUrl.Text = '' }
    $chkWebSys.Checked = ($null -ne $Cfg.web -and $Cfg.web.useSystemBrowser -eq $true)
    if ($null -ne $Cfg.web -and $null -ne $Cfg.web.browserPath) { $txtWebBrowser.Text = [string]$Cfg.web.browserPath } else { $txtWebBrowser.Text = '' }

    if ($null -ne $ov) {
        if ($null -ne $ov.materialSource) { $txtSource.Text = [string]$ov.materialSource } else { $txtSource.Text = '' }

        $si = 15
        if ($null -ne $ov.switchInterval) {
            $tmp = 0
            if ([int]::TryParse([string]$ov.switchInterval, [ref]$tmp) -and $tmp -gt 0) { $si = $tmp }
        }
        $numInterval.Value = $si

        $pst = 0
        if ($null -ne $ov.pictureSizeType -and [string]$ov.pictureSizeType -eq '1') { $pst = 1 }
        $rbContain.Checked = ($pst -eq 0)
        $rbCover.Checked = ($pst -eq 1)

        $imgLines = @()
        if ($null -ne $ov.imageList) { $imgLines = @($ov.imageList) }
        $txtImages.Text = ($imgLines -join $script:NL)

        $textLines = @()
        if ($null -ne $ov.textList) {
            foreach ($t in @($ov.textList)) {
                if ($null -eq $t) { continue }
                $line = [string]$t.content
                if ($null -ne $t.provenance -and [string]$t.provenance -ne '') {
                    $line = $line + '|' + [string]$t.provenance
                }
                $textLines += $line
            }
        }
        $txtTexts.Text = ($textLines -join $script:NL)

        $transText = ''
        if ($null -ne $ov.transitionList) { $transText = (@($ov.transitionList) -join ',') }
        $txtTrans.Text = $transText
    } else {
        $txtSource.Text = ''
        $numInterval.Value = 15
        $rbContain.Checked = $true
        $txtImages.Text = ''
        $txtTexts.Text = ''
        $txtTrans.Text = ''
    }
    Update-ModeVisibility
}

function Collect-Override {
    $images = @()
    foreach ($line in ($txtImages.Text -split '\r?\n')) {
        $v = $line.Trim()
        if ($v -ne '') { $images += $v }
    }

    $texts = @()
    foreach ($line in ($txtTexts.Text -split '\r?\n')) {
        $v = $line.Trim()
        if ($v -eq '') { continue }
        $parts = $v.Split('|')
        $item = [pscustomobject]@{ content = $parts[0].Trim() }
        if ($parts.Length -ge 2 -and $parts[1].Trim() -ne '') {
            $item | Add-Member -NotePropertyName provenance -NotePropertyValue $parts[1].Trim()
        }
        if ($item.content -ne '') { $texts += $item }
    }

    # 转场效果解析（规则见 ConvertTo-TransitionList，含单测）
    $trans = ConvertTo-TransitionList -Raw $txtTrans.Text -ImageCount $images.Count
    $psType = 0
    if ($rbCover.Checked) { $psType = 1 }

    $ov = [pscustomobject]@{
        materialSource = $txtSource.Text.Trim()
        switchInterval = [int]$numInterval.Value
        pictureSizeType = $psType
        imageList = $images
        textList = $texts
        transitionList = $null
    }
    if ($trans.Count -gt 0) { $ov.transitionList = $trans }
    return $ov
}

function Build-Config {
    # 当前模式：image / web / none
    $mode = 'none'
    if ($rbModeImage.Checked) { $mode = 'image' }
    elseif ($rbModeWeb.Checked) { $mode = 'web' }

    # ★ 两种模式的设置都完整保存下来，由 mode 决定哪个生效 ——
    #   这样在「自定义图集」和「网页屏保」之间来回切，不会把另一边的设置弄丢。
    #   （用户反馈「网页屏保存配置似乎有点问题」，就是原来的写法会把图片配置清空）
    $ov = Collect-Override
    return [pscustomobject]@{
        screensaverEnabled = [bool]$chkEnabled.Checked
        lockCascadeOnClose = [bool]$chkLock.Checked
        allowManualClose = $true
        mode = $mode
        override = $ov
        web = [pscustomobject]@{ enabled = ($mode -eq 'web'); url = (Normalize-WebInput -Raw $txtWebUrl.Text); closeOnClick = $false; useSystemBrowser = [bool]$chkWebSys.Checked; browserPath = $txtWebBrowser.Text.Trim() }
        logLevel = 'info'
        backupCount = 3
    }
}

# ---------------------------------------------------------------------------
# 状态切换
# ---------------------------------------------------------------------------

$script:State = $null
$script:FormLoaded = $false

function Refresh-UiState {
    param([switch]$Full)

    if ($Full -or $null -eq $script:State) { $script:State = Get-InjectionState }
    else { $script:State.ProcessRunning = ((Get-HostProcs).Count -gt 0) }

    $st = $script:State
    $procText = Get-RuntimeText

    if ($st.Injected) {
        $group.Visible = $true
        $btnInstall.Visible = $false
        $btnImageSwap.Visible = $false
        $btnSave.Visible = $true
        $btnPreview.Visible = $true
        $btnUninstall.Visible = $true
        $linkLog.Visible = $true
        $linkDiag.Visible = $true
        $linkClean.Visible = $true
        $linkSwap.Visible = $true
        $linkHelp.Visible = $true
        if ($script:PanelBottom) { $script:PanelBottom.Visible = $true }

        if (-not $script:FormLoaded) {
            try { Fill-Form -Cfg (Read-Config) } catch { }
            $script:FormLoaded = $true
        }

        # 版本检测：注入的不是当前版本 -> 提示升级
        $vstate = Get-InjectionVersionState -State $st
        if ($vstate -eq 'outdated') {
            $group.Visible = $true
            $btnSave.Visible = $false
        $btnPreview.Visible = $false
            if ($script:PanelBottom) { $script:PanelBottom.Visible = $false }
            $btnInstall.Visible = $true
            $btnInstall.Text = '升级到最新版（一键）'
            $btnImageSwap.Visible = $false
            $btnUninstall.Visible = $true
            $linkLog.Visible = $true
            $msg = '检测到已注入的是旧版本 ⚠'
            if ($st.Dir) { $msg += $script:NL + '安装目录：' + $st.Dir }
            $msg += $script:NL + '点「升级到最新版」自动重装（必要时走安全模式）。'
            Set-Status $msg
            return
        }

        $btnInstall.Text = '一键安装'
        $msg = '已注入 ✓  屏保行为由本工具控制（v' + $script:InjectionVersion + '）'
        if ($vstate -eq 'unknown') { $msg = '已注入 ✓  版本未知（可能被手工改过）' }
        if ($st.Dir) { $msg += $script:NL + '安装目录：' + $st.Dir }
        $msg += $script:NL + '希沃管家：' + $procText
        Set-Status $msg
    } else {
        $group.Visible = $false
        $btnSave.Visible = $false
        $btnPreview.Visible = $false
        $btnUninstall.Visible = $false
        $btnInstall.Visible = $true
        $btnImageSwap.Visible = $true
        # ★ 未安装时也显示底部栏：这样「诊断」随时可点，
        #   方便对比装之前 / 装之后的状态。
        $linkLog.Visible = $true
        $linkDiag.Visible = $true
        $linkHelp.Visible = $true
        if ($script:PanelBottom) { $script:PanelBottom.Visible = $true }

        if (-not $st.AsarExists) {
            if ($st.Error) {
                Set-Status ('未就绪：' + $st.Error + $script:NL + '可以点下面的按钮，手动选择安装目录。')
            } else {
                Set-Status ('尚未检测到希沃管家，或未找到 app.asar。' + $script:NL +
                    '点下面的按钮会自动定位并注入；找不到时会让你手动选目录。')
            }
        } else {
            $msg = '尚未安装（未注入）'
            if ($st.Dir) { $msg += $script:NL + '安装目录：' + $st.Dir }
            $msg += $script:NL + '希沃管家：' + $procText + '　点下面按钮一键安装。'
            Set-Status $msg
        }
    }
}

# ---------------------------------------------------------------------------
# 一键安装
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# 诊断日志（安装失败时把详细原因写文件，方便排查）
# ---------------------------------------------------------------------------

$script:LogDir = $script:ConfigDir
$script:InstallLog = $null
$script:ExeLog = $null

function Add-Log {
    param([string]$Message)
    $line = '[' + (Get-Date).ToString('HH:mm:ss') + '] ' + $Message
    foreach ($target in @($script:InstallLog, $script:ExeLog)) {
        if (-not $target) { continue }
        try {
            [System.IO.File]::AppendAllText($target, $line + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
        } catch { }
    }
}

function Initialize-InstallerLog {
    try {
        if (-not (Test-Path -LiteralPath $script:LogDir)) {
            New-Item -ItemType Directory -Path $script:LogDir -Force | Out-Null
        }
        $script:InstallLog = Join-Path $script:LogDir 'install.log'
    } catch { $script:InstallLog = $null }

    # 同时尝试写到程序所在目录（用户最容易找到的地方）
    try {
        $base = $null
        if ($PSCommandPath) { $base = Split-Path -Parent $PSCommandPath }
        if (-not $base) {
            try { $base = Split-Path -Parent ([System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName) } catch { }
        }
        if ($base) {
            $candidate = Join-Path $base 'AuraScreensaver-install.log'
            $probe = $candidate + '.probe'
            [System.IO.File]::WriteAllText($probe, 'x')
            Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
            $script:ExeLog = $candidate
        }
    } catch { }

    Add-Log ('==== 会话开始 ' + (Get-Date).ToString('s') + ' ====')
}

function Add-LogFacts {
    Add-Log ('管理员权限: ' + (Test-IsAdmin))
    try { Add-Log ('当前用户: ' + [System.Security.Principal.WindowsIdentity]::GetCurrent().Name) } catch { }
    try { Add-Log ('进程: ' + [System.Diagnostics.Process]::GetCurrentProcess().ProcessName) } catch { }
    Add-Log ('系统: ' + [Environment]::OSVersion.VersionString)
}

function Test-DirWritable {
    param([string]$Dir)
    try {
        $probe = Join-Path $Dir ('.aura-probe-' + [System.Guid]::NewGuid().ToString('N') + '.tmp')
        [System.IO.File]::WriteAllText($probe, 'x')
        Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
        return $true
    } catch {
        Add-Log ('写权限测试失败: ' + $Dir + ' -> ' + $_.Exception.Message)
        return $false
    }
}


# ---------------------------------------------------------------------------
# 希沃自我保护探测
#   ACL 明明给了 BUILTIN\Administrators (F) 完全控制，却连 takeown 都被拒绝，
#   说明写入是被内核过滤驱动拦掉的（常见于防篡改设计），不是普通权限问题。
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# 安全模式相关
#   希沃的 SeewoZoroWall / SeewoKeLiteLady 是内核驱动，正常模式下拦写入。
#   安全模式不加载第三方驱动 → 那时写入一定能成功。
# ---------------------------------------------------------------------------
# 目录模式安装（HugoAura 的做法）
#   把 app.asar 从「文件」变成「目录」，里面的文件和 asar 里的条目一一对应。
#   Electron 读 resources\app.asar 时，目录形式会按普通目录读取。
#
#   ★ 它需要的操作，和我们已实测的能力对照：
#       1. 在 resources 下建目录         → 已实测：允许
#       2. 把原 app.asar 改名/删掉       → 未测（需要文件的 DELETE 权限）
#       3. 把目录改名到 resources\app.asar → 未测（本质是目录改名）
#   所以能不能用，取决于第 2、3 步；本函数会逐步记录，失败在哪步一目了然。
# 在解包目录里补建 asar 中的空目录（保持结构完全一致）
function New-AsarDirTree {
    param($Header, [string]$Root)
    function Walk($node, $prefix) {
        $filesProp = $node.PSObject.Properties['files']
        if ($null -eq $filesProp) { return }
        foreach ($p in $filesProp.Value.PSObject.Properties) {
            $name = $p.Name
            $child = $p.Value
            if ($prefix) { $rel = $prefix + '/' + $name } else { $rel = $name }
            $isDir = ($null -ne $child.PSObject.Properties['files'])
            if (-not $isDir) { continue }
            $path = Join-Path $Root ($rel -replace '/', [System.IO.Path]::DirectorySeparatorChar)
            if (-not (Test-Path -LiteralPath $path)) {
                New-Item -ItemType Directory -Path $path -Force | Out-Null
            }
            Walk $child $rel
        }
    }
    Walk $Header ''
}

# ---------------------------------------------------------------------------

function Install-DirectoryMode {
    param([string]$Dir, [string]$PatchText)

    $resources = Join-Path $Dir 'resources'
    $asar = Join-Path $resources 'app.asar'
    $bak = $asar + '.bak'

    # ---------- 1. 解包到 %TEMP%（不受保护的地方） ----------
    $info = Read-AsarHeader $asar
    $leaves = Get-AsarLeaves $info.Header
    $staging = Join-Path ([System.IO.Path]::GetTempPath()) ('aura-dir-' + [System.Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $staging -Force | Out-Null

    $written = 0
    foreach ($l in $leaves) {
        if ($l.Unpacked) { continue }
        $rel = $l.Rel -replace '/', [System.IO.Path]::DirectorySeparatorChar
        $target = Join-Path $staging $rel
        $parent = Split-Path -Parent $target
        if ($parent -and -not (Test-Path -LiteralPath $parent)) {
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
        }
        if ($l.Rel -eq 'main.js') {
            [System.IO.File]::WriteAllText($target, $PatchText, (New-Object System.Text.UTF8Encoding($false)))
        } else {
            [System.IO.File]::WriteAllBytes($target, (Get-EntryBytes $info $l))
        }
        $written++
    }
    New-AsarDirTree -Header $info.Header -Root $staging
    Add-Log ('目录模式：已解包 ' + $written + ' 个文件到 ' + $staging)

    # ---------- 2. 把原文件改名成备份 ----------
    if (-not (Test-Path -LiteralPath $bak)) {
        try {
            Move-Item -LiteralPath $asar -Destination $bak -ErrorAction Stop
            Add-Log '目录模式：已把 app.asar 重命名为 app.asar.bak'
        } catch {
            Add-Log ('目录模式：改名失败（缺 DELETE 权限）-> ' + $_.Exception.Message)
            Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
            return [pscustomobject]@{ Ok = $false; Step = 'rename-asar'; Message = $_.Exception.Message }
        }
    } else {
        try {
            Remove-Item -LiteralPath $asar -Force -ErrorAction Stop
            Add-Log '目录模式：已删除 app.asar（备份已存在）'
        } catch {
            Add-Log ('目录模式：删除失败 -> ' + $_.Exception.Message)
            Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
            return [pscustomobject]@{ Ok = $false; Step = 'delete-asar'; Message = $_.Exception.Message }
        }
    }

    # ---------- 3. 把暂存目录改名到 resources\app.asar ----------
    try {
        Move-Item -LiteralPath $staging -Destination $asar -ErrorAction Stop
        Add-Log '目录模式：已把目录放到 app.asar 位置'
    } catch {
        Add-Log ('目录模式：移入失败 -> ' + $_.Exception.Message)
        # 尽力回滚：把备份改回 app.asar
        if (Test-Path -LiteralPath $bak) {
            try {
                Move-Item -LiteralPath $bak -Destination $asar -ErrorAction Stop
                Add-Log '目录模式：已从备份改回 app.asar'
            } catch { Add-Log ('目录模式：回滚失败！' + $_.Exception.Message) }
        }
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
        return [pscustomobject]@{ Ok = $false; Step = 'move-dir'; Message = $_.Exception.Message }
    }

    return [pscustomobject]@{ Ok = $true; Step = 'done'; Message = '' }
}

# ---------------------------------------------------------------------------
# 安全模式动作（安装 / 卸载共用）
# ---------------------------------------------------------------------------
# 询问是否重启到安全模式执行操作（安装 / 升级 / 卸载共用）
#   安全模式是唯一能写入 app.asar 的路径（正常模式被希沃内核驱动拦）。
# ---------------------------------------------------------------------------

function Show-SafeModePrompt {
    param([ValidateSet('install', 'uninstall')][string]$Action = 'install')

    $isUn = ($Action -eq 'uninstall')
    $title = '需要安全模式才能继续'
    $what = $(if ($isUn) { '卸载（还原官方 app.asar）' } else { '安装/升级' })

    $ans = [System.Windows.Forms.MessageBox]::Show(
        ('正常模式下无法写入 app.asar。' + $script:NL + $script:NL +
         '原因：希沃的内核驱动（SeewoZoroWall / SeewoKeLiteLady）会拦截写入，' + $script:NL +
         '目录 ACL 里管理员已是完全控制，但连 takeown 都被拒绝。' + $script:NL + $script:NL +
         '安全模式不加载这些驱动，是唯一可行的路径。' + $script:NL + $script:NL +
         '点「是」：立即重启到安全模式。' + $script:NL +
         '（重启后需要你双击一下程序；它会自动完成' + $what + '并自动重启回正常。）' + $script:NL +
         '点「否」：取消（也可以之后手动再点一次）。'),
        $title, 'YesNo', 'Question')

    if ($ans -ne 'Yes') { Add-Log '用户取消安全模式流程'; return }

    if (Test-IsSafeMode) {
        # 已经在安全模式里了：直接执行，不用再重启
        Add-Log ('当前已在安全模式，直接执行 ' + $Action)
        [void](Invoke-SafeModeAutoAction -Action $Action)
        return
    }

    try {
        Set-Status '正在准备重启到安全模式…'
        $recovery = Invoke-EnterSafeModeAction -Action $Action
        Add-Log ('已安排安全模式 ' + $Action + '，准备重启')
        [System.Windows.Forms.MessageBox]::Show(
                        ('已设置好，即将重启进入安全模式。' + $script:NL + $script:NL +
             '★ 实测安全模式下系统不会自动启动任何程序，所以需要你手动双击一下；' + $script:NL +
             '   双击之后程序会自己完成剩下的全部工作，不需要再点任何按钮。' + $script:NL + $script:NL +
             '  1) 电脑重启进入安全模式，正常登录' + $script:NL +
             '  2) 双击 AuraScreensaver.exe（就是你刚才运行的那个程序）' + $script:NL +
             '     ' + (Get-SelfExePath) + $script:NL +
             '     也可以双击 ' + (Get-SafeModeLauncherPath) + $script:NL +
             '  3) 程序自动完成' + $what + '，然后自动关闭安全模式并重启回正常' + $script:NL + $script:NL +
             '急救：万一卡在安全模式，双击桌面「退出安全模式.bat」即可恢复。'),
            '即将重启', 'OK', 'Information') | Out-Null
    } catch {
        Add-Log ('安排安全模式失败: ' + $_.Exception.Message)
        [System.Windows.Forms.MessageBox]::Show(
            ('无法设置安全模式：' + $_.Exception.Message + $script:NL + $script:NL +
             '可手动操作：Win+R 输入 msconfig → 引导 → 勾选「安全引导」「最小」→ 重启，' + $script:NL +
             '然后在安全模式里再次运行本程序。'),
            '设置失败', 'OK', 'Error') | Out-Null
    }
}

# ---------------------------------------------------------------------------

# 待办动作标记：安全模式里「手动打开程序」时靠它自动继续，不需要点任何按钮
$script:PendingActionPath = Join-Path $script:ConfigDir 'pending-safe-action.txt'
$script:SafeTaskName = 'AuraScreensaver_SafeMode'
$script:StableExeDir = Join-Path $env:ProgramData 'seewo\AuraScreensaver'

# 安排「重启进安全模式后自动执行」的触发方式。
#   ★ 原来只写了一条 HKLM RunOnce —— 实测经常不生效：
#     RunOnce 在登录时被读取后**立即删除**，命令一旦没起来就彻底没机会了；
#     而且要求提权的 exe 在登录阶段容易被 UAC 挡住。
#   现在改成三重保障 + 一个稳定路径。
# 返回实际生成的安全模式启动器路径（exe 版是 AuraSafe.exe，脚本版是 AuraSafe.cmd）
function Get-SafeModeLauncherPath {
    $exe = Join-Path $script:StableExeDir 'AuraSafe.exe'
    if (Test-Path -LiteralPath $exe) { return $exe }
    $cmd = Join-Path $script:StableExeDir 'AuraSafe.cmd'
    if (Test-Path -LiteralPath $cmd) { return $cmd }
    return $script:StableExeDir
}

function Register-SafeModeTrigger {
    param([string]$Action, [string]$Flag)

    $self = Get-SelfExePath
    if (-not $self) { throw '无法确定自身路径' }

    $leaf = ''
    try { $leaf = [System.IO.Path]::GetFileName($self).ToLower() } catch { }

    $stable = $self
    $isHost = ($leaf -eq 'powershell.exe' -or $leaf -eq 'pwsh.exe' -or $leaf -eq 'powershell_ise.exe')

    if ($isHost) {
        # 从 .ps1 / .bat 启动的：没有独立 exe 可复制，生成一个启动脚本代替。
        #   否则会把 powershell.exe 复制过去，触发后什么都不会发生。
        try {
            if (-not (Test-Path -LiteralPath $script:StableExeDir)) {
                New-Item -ItemType Directory -Path $script:StableExeDir -Force | Out-Null
            }
            $launcher = Join-Path $script:StableExeDir 'AuraSafe.cmd'
            $runLine = '"' + $self + '" -NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" ' + $Flag
            $lines = @('@echo off', 'chcp 65001 >nul 2>nul', $runLine)
            [System.IO.File]::WriteAllLines($launcher, $lines, $script:Utf8NoBom)
            $stable = $launcher
            Add-Log ('已生成安全模式启动脚本: ' + $stable)
        } catch { Add-Log ('生成启动脚本失败: ' + $_.Exception.Message) }
    } else {
        # 正常情况（打包好的 exe）：复制到机器级稳定路径。
        #   桌面上的文件可能被移走/删掉，或安全模式登录的是别的账户，
        #   而触发项里记的是绝对路径 —— 路径一失效就什么都不会发生。
        try {
            if (-not (Test-Path -LiteralPath $script:StableExeDir)) {
                New-Item -ItemType Directory -Path $script:StableExeDir -Force | Out-Null
            }
            $copy = Join-Path $script:StableExeDir 'AuraSafe.exe'
            Copy-Item -LiteralPath $self -Destination $copy -Force -ErrorAction Stop
            $stable = $copy
            Add-Log ('已复制到稳定路径: ' + $stable)
        } catch {
            Add-Log ('复制到稳定路径失败，退回原路径: ' + $_.Exception.Message)
        }
    }

    $cmdLine = '"' + $stable + '" ' + $Flag

    # 待办标记：即使三重触发都没生效，用户在安全模式里手动打开程序也会自动继续
    try {
        [System.IO.File]::WriteAllText($script:PendingActionPath, $Action, $script:Utf8NoBom)
        Add-Log '已写入待办动作标记'
    } catch { Add-Log ('写待办标记失败: ' + $_.Exception.Message) }

    # 1) 计划任务（登录时、最高权限）—— 比 RunOnce 可靠
    try {
        $o = & schtasks.exe /Create /TN $script:SafeTaskName /SC ONLOGON /RL HIGHEST /F /TR $cmdLine 2>&1 | Out-String
        Add-Log ('schtasks: ' + $o.Trim())
    } catch { Add-Log ('建计划任务失败: ' + $_.Exception.Message) }

    # 2) RunOnce 兜底：HKLM 与 HKCU 各写一份
    foreach ($hive in @('HKLM:SOFTWAREMicrosoftWindowsCurrentVersionRunOnce',
                        'HKCU:SOFTWAREMicrosoftWindowsCurrentVersionRunOnce')) {
        try {
            New-ItemProperty -Path $hive -Name 'AuraScreensaver_SafeInstall' -Value $cmdLine -PropertyType String -Force | Out-Null
            Add-Log ('RunOnce = ' + $cmdLine)
        } catch { Add-Log ('写 RunOnce 失败: ' + $_.Exception.Message) }
    }

    return $stable
}

function Clear-SafeModeTrigger {
    try { & schtasks.exe /Delete /TN $script:SafeTaskName /F 2>&1 | Out-Null } catch { }
    foreach ($hive in @('HKLM:SOFTWAREMicrosoftWindowsCurrentVersionRunOnce',
                        'HKCU:SOFTWAREMicrosoftWindowsCurrentVersionRunOnce')) {
        try { Remove-ItemProperty -Path $hive -Name 'AuraScreensaver_SafeInstall' -ErrorAction SilentlyContinue } catch { }
    }
    try {
        if (Test-Path -LiteralPath $script:PendingActionPath) { Remove-Item -LiteralPath $script:PendingActionPath -Force }
    } catch { }
}

function Invoke-EnterSafeModeAction {
    param([ValidateSet('install', 'uninstall')][string]$Action = 'install')

    $flag = '-SafeInstall'
    if ($Action -eq 'uninstall') { $flag = '-SafeUninstall' }

    $recovery = Write-SafeModeRecoveryBat

    Add-Log ('设置 bcdedit safeboot minimal（动作=' + $Action + '）')
    $o = & bcdedit.exe /set '{current}' safeboot minimal 2>&1 | Out-String
    Add-Log ('bcdedit 输出: ' + $o.Trim())
    if ($LASTEXITCODE -ne 0) { throw ('bcdedit 失败：' + $o) }

    [void](Register-SafeModeTrigger -Action $Action -Flag $flag)

    & shutdown.exe /r /t 10 /c "AuraScreensaver: 即将重启进入安全模式完成操作" 2>&1 | Out-Null
    return $recovery
}

# 安全模式下执行具体动作，然后必定清除 safeboot 并重启回正常
function Invoke-SafeModeAutoAction {
    param([ValidateSet('install', 'uninstall')][string]$Action = 'install')

    if (-not (Test-Path -LiteralPath $script:ConfigDir)) {
        try { New-Item -ItemType Directory -Path $script:ConfigDir -Force | Out-Null } catch { }
    }
    # ★ 防重入：计划任务/RunOnce 与「手动双击」可能同时起两个实例，
    #   同时改写 app.asar 会把文件搞坏。3 分钟内的第二次直接退出。
    $lock = Join-Path $script:ConfigDir 'safe-action.lock'
    try {
        if (Test-Path -LiteralPath $lock) {
            $t = [datetime]::MinValue
            try { $t = [datetime]::Parse(([System.IO.File]::ReadAllText($lock)).Trim()) } catch { }
            if (((Get-Date) - $t).TotalSeconds -lt 180) {
                Write-Host '已有另一个实例正在执行安全模式动作，本次退出。'
                return $false
            }
        }
        [System.IO.File]::WriteAllText($lock, (Get-Date).ToString('o'), $script:Utf8NoBom)
    } catch { }

    $script:InstallLog = Join-Path $script:ConfigDir 'install.log'
    $script:ExeLog = $null
    Add-Log ('==== 安全模式自动' + $Action + ' 开始 ====')

    try {
        $dir = Resolve-SeewoDirEmbedded
        Add-Log ('安装目录: ' + $dir)
        if (-not $dir) { throw '安全模式下没找到安装目录' }

        $asar = Join-Path (Join-Path $dir 'resources') 'app.asar'
        $bak = $asar + '.bak'

        if ($Action -eq 'uninstall') {
            if (-not (Test-Path -LiteralPath $bak)) { throw ('没有备份文件：' + $bak) }
            # 目录模式下 app.asar 可能是个目录，先删掉
            if (Test-Path -LiteralPath $asar -PathType Container) {
                Remove-Item -LiteralPath $asar -Recurse -Force -ErrorAction Stop
                Add-Log '已删除目录形态的 app.asar'
            }
            Copy-Item -LiteralPath $bak -Destination $asar -Force -ErrorAction Stop
            Add-Log '已用备份还原 app.asar'
        } else {
            $info = Read-AsarHeader $asar
            $leaves = Get-AsarLeaves $info.Header
            $mainLeaf = $null
            foreach ($l in $leaves) { if ($l.Rel -eq 'main.js') { $mainLeaf = $l } }
            if ($null -eq $mainLeaf) { throw 'asar 里没有 main.js' }
            $mainText = [System.Text.Encoding]::UTF8.GetString((Get-EntryBytes $info $mainLeaf))

            # ★ 已注入时不能直接跳过：可能装的是旧版本，需要先回滚再注入（升级）
            $needInject = $true
            if ($mainText.Contains($script:MarkBegin)) {
                $cur = Get-InjectedVersion -MainText $mainText
                if ($cur -eq $script:InjectionVersion) {
                    Add-Log ('已是当前版本 v' + $cur + '，跳过注入')
                    $needInject = $false
                } else {
                    Add-Log ('检测到旧版本（已装=' + $cur + '，当前=' + $script:InjectionVersion + '），回滚后重新注入')
                    if (-not (Test-Path -LiteralPath $bak)) { throw ('升级需要备份，但找不到：' + $bak) }
                    if (Test-Path -LiteralPath $asar -PathType Container) {
                        Remove-Item -LiteralPath $asar -Recurse -Force -ErrorAction Stop
                    }
                    Copy-Item -LiteralPath $bak -Destination $asar -Force -ErrorAction Stop
                    Add-Log '已回滚官方 app.asar，准备注入新版本'
                    $info = Read-AsarHeader $asar
                    $leaves = Get-AsarLeaves $info.Header
                    $mainLeaf = $null
                    foreach ($l in $leaves) { if ($l.Rel -eq 'main.js') { $mainLeaf = $l } }
                    if ($null -eq $mainLeaf) { throw '回滚后 asar 里没有 main.js' }
                    $mainText = [System.Text.Encoding]::UTF8.GetString((Get-EntryBytes $info $mainLeaf))
                }
            }

            if ($needInject) {
                $res = Get-PatchedMainJs -Source $mainText -LoaderText $script:LoaderText -ConfigJson $script:DefaultConfigJson
                $mainBytes = [System.Text.Encoding]::UTF8.GetBytes($res.Text)
                $stage = Join-Path ([System.IO.Path]::GetTempPath()) ('aura-safe-' + [System.Guid]::NewGuid().ToString('N'))
                New-Item -ItemType Directory -Path $stage -Force | Out-Null
                $staged = Join-Path $stage 'app.asar'
                [void](Save-Asar -Info $info -MainBytes $mainBytes -OutPath $staged)
                Add-Log ('已组装 asar: ' + (Get-Item $staged).Length + ' 字节')

                if (-not (Test-Path -LiteralPath $bak)) {
                    Copy-Item -LiteralPath $asar -Destination $bak -Force
                    Add-Log '已备份 app.asar.bak'
                }
                Copy-Item -LiteralPath $staged -Destination ($asar + '.new') -Force
                if (Test-Path -LiteralPath $asar -PathType Container) {
                    Remove-Item -LiteralPath $asar -Recurse -Force -ErrorAction Stop
                }
                if (Test-Path -LiteralPath $asar) {
                    if (-not (Set-FileContentFrom -Source ($asar + '.new') -Target $asar)) { throw '替换 app.asar 失败（三种方式都不可用）' }
                } else {
                    Move-Item -LiteralPath ($asar + '.new') -Destination $asar -Force
                }
                Remove-Item -LiteralPath ($asar + '.new') -Force -ErrorAction SilentlyContinue
                Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
                Add-Log '已替换 app.asar'
            }
        }

        Remove-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce' -Name 'AuraScreensaver_SafeInstall' -ErrorAction SilentlyContinue
        $o2 = & bcdedit.exe /deletevalue '{current}' safeboot 2>&1 | Out-String
        Add-Log ('已清除 safeboot: ' + $o2.Trim())
        Add-Log '操作完成，15 秒后重启回正常模式'
        & shutdown.exe /r /t 8 /c "AuraScreensaver: 已完成，即将重启回正常模式" 2>&1 | Out-Null
        return $true
    } catch {
        Add-Log ('安全模式自动操作失败: ' + $_.Exception.Message)
        Add-Log ('调用栈: ' + $_.ScriptStackTrace)
        try { & bcdedit.exe /deletevalue '{current}' safeboot 2>&1 | Out-Null } catch { }
        try { Remove-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce' -Name 'AuraScreensaver_SafeInstall' -ErrorAction SilentlyContinue } catch { }
        Add-Log '已撤除安全模式设置，15 秒后重启回正常模式'
        & shutdown.exe /r /t 8 /c "AuraScreensaver: 操作失败，已恢复正常启动" 2>&1 | Out-Null
        return $false
    }
}

# ---------------------------------------------------------------------------
# 把 $Source 替换到 $Target（多级兜底）
#   ★ 坑：File.Replace(src, dst, $null) 里第 3 个参数不能传 $null ——
#     PowerShell 会绑成空字符串 ""，.NET 直接报「路径的形式不合法」。
#     必须传一个真实的备份路径。这里逐级兜底，并把用了哪种方式写进日志。
# ---------------------------------------------------------------------------

function Set-FileContentFrom {
    param([string]$Source, [string]$Target)

    # 1) 原子替换（带真实备份路径）
    $rb = $Target + '.replbak'
    try {
        [System.IO.File]::Replace($Source, $Target, $rb)
        Remove-Item -LiteralPath $rb -Force -ErrorAction SilentlyContinue
        Add-Log '替换方式：File.Replace（原子）'
        return $true
    } catch {
        Add-Log ('File.Replace 失败: ' + $_.Exception.Message)
        Remove-Item -LiteralPath $rb -Force -ErrorAction SilentlyContinue
    }

    # 2) 直接覆盖写（安全模式/文件未被占用时可用）
    try {
        Copy-Item -LiteralPath $Source -Destination $Target -Force -ErrorAction Stop
        Add-Log '替换方式：直接覆盖'
        return $true
    } catch {
        Add-Log ('直接覆盖失败: ' + $_.Exception.Message)
    }

    # 3) 删除后移入
    try {
        Remove-Item -LiteralPath $Target -Force -ErrorAction Stop
        Move-Item -LiteralPath $Source -Destination $Target -Force -ErrorAction Stop
        Add-Log '替换方式：删除后移入'
        return $true
    } catch {
        Add-Log ('删除后移入失败: ' + $_.Exception.Message)
    }

    return $false
}

# ---------------------------------------------------------------------------
# 如果在安全模式里完成安装/卸载：清除 safeboot 并自动重启回正常模式
#   ★ 之前漏了这步：用户在安全模式里手动点安装也能成功，
#     但之后不会自动恢复，会一直卡在安全模式。
# ---------------------------------------------------------------------------
# 免安装模式：直接替换希沃缓存的屏保图片（思路同「狸猫换太子.bat」）
#   目标目录 %APPDATA%\seewo\SeewoAbility\screen_saver\ 里是哈希命名的图片文件。
#   这里只改这些图片文件，不碰 Program Files、不需要注入、不需要安全模式。
# ---------------------------------------------------------------------------

function Get-ScreenSaverDir {
    $p = Join-Path $env:APPDATA 'seewo\SeewoAbility\screen_saver'
    return $p
}

function Get-ScreenSaverImageFiles {
    param([string]$Dir)
    if (-not (Test-Path -LiteralPath $Dir)) { return @() }
    return @(Get-ChildItem -LiteralPath $Dir -File -ErrorAction SilentlyContinue)
}

function Backup-ScreenSaverDir {
    param([string]$Dir)
    $parent = Split-Path -Parent $Dir
    $name = 'screen_saver_backup_' + (Get-Date).ToString('yyyyMMdd_HHmmss')
    $bak = Join-Path $parent $name
    Copy-Item -LiteralPath $Dir -Destination $bak -Recurse -Force -ErrorAction Stop
    return $bak
}

function Test-ImageFile {
    param([string]$Path)
    $ext = [System.IO.Path]::GetExtension($Path).ToLower()
    return (@('.jpg', '.jpeg', '.png', '.bmp', '.gif', '.webp', '.apng', '.avif', '.jfif') -contains $ext)
}

# 循环把源图片覆盖到目标文件上（保留目标文件名，行为与 bat 一致）
function Apply-ScreenSaverImages {
    param([string]$Dir, [string]$SourceDir)

    if (-not (Test-Path -LiteralPath $Dir)) { throw ('找不到屏保目录：' + $Dir) }
    if (-not (Test-Path -LiteralPath $SourceDir)) { throw ('找不到图片文件夹：' + $SourceDir) }

    $srcs = @(Get-ChildItem -LiteralPath $SourceDir -File -ErrorAction Stop | Where-Object { Test-ImageFile $_.FullName } | Sort-Object Name)
    if ($srcs.Count -eq 0) { throw '你选择的文件夹里没有 jpg/png 图片' }

    $targets = Get-ScreenSaverImageFiles -Dir $Dir
    if ($targets.Count -eq 0) { throw '目标屏保目录里没有文件（希沃还没下载过屏保？）' }

    $bak = Backup-ScreenSaverDir -Dir $Dir
    $i = 0
    foreach ($t in $targets) {
        $src = $srcs[$i % $srcs.Count]
        Copy-Item -LiteralPath $src.FullName -Destination $t.FullName -Force -ErrorAction Stop
        $i++
    }
    return [pscustomobject]@{ Replaced = $targets.Count; Backup = $bak; Source = $srcs.Count }
}

function Get-LatestScreenSaverBackup {
    param([string]$Dir)
    $parent = Split-Path -Parent $Dir
    if (-not (Test-Path -LiteralPath $parent)) { return $null }
    $dirs = @(Get-ChildItem -LiteralPath $parent -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like 'screen_saver_backup_*' } |
        Sort-Object LastWriteTime -Descending)
    if ($dirs.Count -eq 0) { return $null }
    return $dirs[0].FullName
}

function Restore-ScreenSaverBackup {
    param([string]$Dir)
    $bak = Get-LatestScreenSaverBackup -Dir $Dir
    if (-not $bak) { throw '没有找到备份文件夹（形如 screen_saver_backup_...）' }
    $files = @(Get-ChildItem -LiteralPath $bak -File -ErrorAction SilentlyContinue)
    if ($files.Count -eq 0) { throw ('备份文件夹是空的：' + $bak) }
    foreach ($f in $files) {
        Copy-Item -LiteralPath $f.FullName -Destination (Join-Path $Dir $f.Name) -Force -ErrorAction Stop
    }
    return $bak
}

# 免安装模式的界面
function Show-ImageSwapDialog {
    $targetDir = Get-ScreenSaverDir

    $dlg = New-Object System.Windows.Forms.Form
    $dlg.Text = '临时换图（免安装）'
    $dlg.StartPosition = 'CenterParent'
    $dlg.FormBorderStyle = 'Sizable'
    $dlg.MinimumSize = New-Object System.Drawing.Size(480, 280)
    $dlg.Size = New-Object System.Drawing.Size(600, 320)
    $dlg.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)

    $flow = New-Object System.Windows.Forms.FlowLayoutPanel
    $flow.Dock = 'Top'
    $flow.AutoSize = $true
    $flow.FlowDirection = 'TopDown'
    $flow.WrapContents = $false
    $flow.Padding = New-Object System.Windows.Forms.Padding(12, 10, 12, 6)
    $dlg.Controls.Add($flow)

    $lblInfo = New-Object System.Windows.Forms.Label
    $lblInfo.AutoSize = $true
    $lblInfo.MaximumSize = New-Object System.Drawing.Size(560, 0)
    $cnt = (Get-ScreenSaverImageFiles -Dir $targetDir).Count
    $lblInfo.Text = '这种方式只替换希沃已缓存的屏保图片，不改任何程序文件，' + $script:NL +
        '所以不需要注入、不需要安全模式，随时可以改回来。' + $script:NL + $script:NL +
        '图片目录：' + $targetDir + $script:NL +
        '当前图片数量：' + $cnt
    $lblInfo.Margin = New-Object System.Windows.Forms.Padding(3, 3, 3, 10)
    $flow.Controls.Add($lblInfo)

    $btnOpen = New-Object System.Windows.Forms.Button
    $btnOpen.Text = '打开图片文件夹（看看现在的屏保长什么样）'
    $btnOpen.AutoSize = $true
    $btnOpen.Margin = New-Object System.Windows.Forms.Padding(3, 3, 3, 6)
    $flow.Controls.Add($btnOpen)

    $btnApplyFolder = New-Object System.Windows.Forms.Button
$btnApplyFolder.Text = '选择文件夹并替换（自动取全部图片）'
$btnApplyFolder.AutoSize = $true
$btnApplyFolder.Margin = New-Object System.Windows.Forms.Padding(3, 3, 3, 6)
$flow.Controls.Add($btnApplyFolder)

$btnApply = New-Object System.Windows.Forms.Button
    $btnApply.Text = '选择我的图片并替换（自动备份）'
    $btnApply.AutoSize = $true
    $btnApply.Margin = New-Object System.Windows.Forms.Padding(3, 3, 3, 6)
    $flow.Controls.Add($btnApply)

    $btnRestore = New-Object System.Windows.Forms.Button
    $btnRestore.Text = '从最近一次备份恢复'
    $btnRestore.AutoSize = $true
    $btnRestore.Margin = New-Object System.Windows.Forms.Padding(3, 3, 3, 6)
    $flow.Controls.Add($btnRestore)

    $btnClose = New-Object System.Windows.Forms.Button
    $btnClose.Text = '关闭'
    $btnClose.AutoSize = $true
    $btnClose.Margin = New-Object System.Windows.Forms.Padding(3, 3, 3, 6)
    $flow.Controls.Add($btnClose)

    $lblResult = New-Object System.Windows.Forms.Label
    $lblResult.AutoSize = $true
    $lblResult.MaximumSize = New-Object System.Drawing.Size(560, 0)
    $lblResult.ForeColor = [System.Drawing.Color]::DimGray
    $lblResult.Text = ''
    $lblResult.Margin = New-Object System.Windows.Forms.Padding(3, 8, 3, 3)
    $flow.Controls.Add($lblResult)

    $btnOpen.add_Click({
        try {
            if (Test-Path -LiteralPath $targetDir) {
                Start-Process explorer.exe -ArgumentList ('"' + $targetDir + '"')
            } else {
                $lblResult.Text = '目录还不存在：' + $targetDir
            }
        } catch { $lblResult.Text = '打开失败：' + $_.Exception.Message }
    })

    $btnApplyFolder.add_Click({
    try {
        $fb = New-Object System.Windows.Forms.FolderBrowserDialog
        $fb.Description = '选择放有你自己图片的文件夹'
        if ($fb.ShowDialog() -ne 'OK') { return }
        $r = Apply-ScreenSaverImages -Dir $targetDir -SourceDir $fb.SelectedPath
        $lblResult.Text = '完成：' + $r.Replaced + ' 个文件已替换（循环使用 ' + $r.Source + ' 张图）。' + $script:NL +
            '备份在：' + $r.Backup + $script:NL +
            '重启希沃管家（或重启电脑）即可看到新屏保。'
        [System.Windows.Forms.MessageBox]::Show(
            ('替换完成。' + $script:NL + $script:NL + '重启希沃管家后生效。' + $script:NL + $script:NL +
             '备份位置：' + $r.Backup),
            '完成', 'OK', 'Information') | Out-Null
    } catch {
        $lblResult.Text = '替换失败：' + $_.Exception.Message
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, '替换失败', 'OK', 'Warning') | Out-Null
    }
})

$btnApply.add_Click({
        try {
            $fb = New-Object System.Windows.Forms.FolderBrowserDialog
            $fb.Description = '选择放有你自己图片（jpg/png）的文件夹'
            if ($fb.ShowDialog() -ne 'OK') { return }

            $r = Apply-ScreenSaverImages -Dir $targetDir -SourceDir $fb.SelectedPath
            $lblResult.Text = '完成：' + $r.Replaced + ' 个文件已替换（循环使用 ' + $r.Source + ' 张图）。' + $script:NL +
                '备份在：' + $r.Backup + $script:NL +
                '重启希沃管家（或重启电脑）即可看到新屏保。'
            [System.Windows.Forms.MessageBox]::Show(
                ('替换完成。' + $script:NL + $script:NL + '重启希沃管家后生效。' + $script:NL + $script:NL +
                 '备份位置：' + $r.Backup),
                '完成', 'OK', 'Information') | Out-Null
        } catch {
            $lblResult.Text = '替换失败：' + $_.Exception.Message
            [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, '替换失败', 'OK', 'Warning') | Out-Null
        }
    })

    $btnRestore.add_Click({
        try {
            $bak = Restore-ScreenSaverBackup -Dir $targetDir
            $lblResult.Text = '已从备份恢复：' + $bak
        } catch {
            $lblResult.Text = '恢复失败：' + $_.Exception.Message
            [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, '恢复失败', 'OK', 'Warning') | Out-Null
        }
    })

    $btnClose.add_Click({ $dlg.Close() })

    [void]$dlg.ShowDialog($form)
}

# ---------------------------------------------------------------------------

function Complete-SafeModeIfNeeded {
    if (-not (Test-IsSafeMode)) { return $false }

    Add-Log '当前处于安全模式：清理 safeboot 并安排重启回正常模式'
    Clear-SafeModeTrigger

    try { [void](Write-SafeModeRecoveryBat) } catch { }

    try {
        $o = & bcdedit.exe /deletevalue '{current}' safeboot 2>&1 | Out-String
        Add-Log ('bcdedit: ' + $o.Trim())
    } catch { Add-Log ('bcdedit 失败: ' + $_.Exception.Message) }

    try {
        & shutdown.exe /r /t 8 /c "AuraScreensaver: 已完成，即将重启回正常模式" 2>&1 | Out-Null
        Add-Log '已安排 20 秒后重启回正常模式'
    } catch { Add-Log ('安排重启失败: ' + $_.Exception.Message) }

    return $true
}

# ---------------------------------------------------------------------------

function Test-IsSafeMode {
    try {
        $cs = Get-CimInstance Win32_ComputerSystem -ErrorAction Stop
        return ([string]$cs.BootupState -match 'Safe')
    } catch {
        try {
            $bs = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\SafeBoot\Option' -ErrorAction SilentlyContinue)
            return ($null -ne $bs)
        } catch { return $false }
    }
}

function Test-IsAdminNow {
    try {
        $id = [Security.Principal.WindowsIdentity]::GetCurrent()
        $pr = New-Object Security.Principal.WindowsPrincipal($id)
        return $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch { return $false }
}

function Get-SelfExePath {
    try { return [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName } catch { }
    return $PSCommandPath
}

# 在桌面放一个「退出安全模式」急救批处理，防止万一卡在安全模式
function Write-SafeModeRecoveryBat {
    try {
        $desktop = [Environment]::GetFolderPath('Desktop')
        if (-not $desktop) { $desktop = $env:USERPROFILE }
        $bat = Join-Path $desktop '退出安全模式.bat'
        $lines = @(
            '@echo off',
            'chcp 65001 >nul 2>nul',
            'echo 正在恢复正常启动...',
            'bcdedit /deletevalue {current} safeboot',
            'if errorlevel 1 echo 可能本来就不在安全模式。',
            'echo.',
            'echo 完成。请重启电脑。',
            'pause'
        )
        [System.IO.File]::WriteAllText($bat, ($lines -join [Environment]::NewLine), (New-Object System.Text.UTF8Encoding($false)))
        Add-Log ('已生成急救脚本: ' + $bat)
        return $bat
    } catch {
        Add-Log ('生成急救脚本失败: ' + $_.Exception.Message)
        return $null
    }
}







# 把打好补丁的 app.asar 导出到桌面，供保护无法解除时手动替换
function Export-PatchedAsar {
    param([byte[]]$Bytes)
    try {
        $desktop = [Environment]::GetFolderPath('Desktop')
        if (-not $desktop) { $desktop = $env:USERPROFILE }
        $name = 'app.asar.injected-' + (Get-Date).ToString('yyyyMMdd-HHmmss')
        $target = Join-Path $desktop $name
        [System.IO.File]::WriteAllBytes($target, $Bytes)
        Add-Log ('已导出补丁文件: ' + $target)
        return $target
    } catch {
        Add-Log ('导出失败: ' + $_.Exception.Message)
        return $null
    }
}

# ---------------------------------------------------------------------------
# 一键安装（先只读生成并校验，再决定写哪里；原子替换）
# ---------------------------------------------------------------------------


$btnInstall.add_Click({
    Initialize-InstallerLog
    Add-LogFacts

    if (-not (Test-IsAdmin)) {
        Add-Log '不是管理员，拒绝继续'
        [System.Windows.Forms.MessageBox]::Show(
            ('当前不是管理员，无法写入 Program Files。' + $script:NL + $script:NL + '请关掉本窗口，右键 exe / bat 选择「以管理员身份运行」。'),
            '需要管理员权限', 'OK', 'Warning') | Out-Null
        return
    }

    $btnInstall.Enabled = $false
    $stageDir = $null
    try {
        # ---------- 1. 定位 ----------
        Set-Status '正在定位希沃管家…'
        $dir = Resolve-SeewoDirEmbedded
        Add-Log ('安装目录: ' + $dir)
        if (-not $dir) {
            $ans = [System.Windows.Forms.MessageBox]::Show(
                ('没能自动找到安装目录。' + $script:NL + $script:NL + '要手动选择吗？'),
                '找不到希沃管家', 'OKCancel', 'Warning')
            if ($ans -eq 'OK') { $dir = Select-SeewoDirManually }
        }
        if (-not $dir) { Add-Log '用户未提供有效目录，中止'; Refresh-UiState -Full; return }

        $resourcesDir = Join-Path $dir 'resources'
        $asar = Join-Path $resourcesDir 'app.asar'
        $bak = $asar + '.bak'

        # ---------- 2. 读 + 生成（只读，不需要写权限） ----------
        Set-Status '正在生成注入代码…'
        $info = Read-AsarHeader $asar
        $leaves = Get-AsarLeaves $info.Header
        $mainLeaf = $null
        foreach ($l in $leaves) { if ($l.Rel -eq 'main.js') { $mainLeaf = $l } }
        if ($null -eq $mainLeaf) { throw '这个 app.asar 里没有 main.js' }

        $mainText = [System.Text.Encoding]::UTF8.GetString((Get-EntryBytes $info $mainLeaf))
        if ($mainText.Contains($script:MarkBegin)) {
            $installedVer = Get-InjectedVersion -MainText $mainText
            if ($installedVer -eq $script:InjectionVersion) {
                Add-Log ('app.asar 已是最新版本 v' + $installedVer)
                Refresh-UiState -Full
                [System.Windows.Forms.MessageBox]::Show('该 app.asar 已是最新版本，无需重装。', '已是最新', 'OK', 'Information') | Out-Null
                return
            }
            Add-Log ('检测到旧版本注入（已装=' + $installedVer + '，当前=' + $script:InjectionVersion + '），开始升级')
            $bkA = $asar + '.bak'
            if (-not (Test-Path -LiteralPath $bkA)) { throw ('升级需要备份，但找不到：' + $bkA) }
            $rolled = $false
            try {
                Remove-Item -LiteralPath $asar -Force -ErrorAction Stop
                Copy-Item -LiteralPath $bkA -Destination $asar -Force -ErrorAction Stop
                $rolled = $true
                Add-Log '已回滚官方 app.asar，准备重新注入'
            } catch {
                # ★ 正常模式下回滚同样被驱动拦 —— 升级必须走安全模式，而不是报错退出
                Add-Log ('正常模式回滚失败（预期）：' + $_.Exception.Message)
            }

            if (-not $rolled) {
                if (-not (Test-IsSafeMode)) {
                    Add-Log '升级转入安全模式'
                    Show-SafeModePrompt
                    return
                }
                throw ('安全模式下回滚仍失败：' + $script:NL + $script:InstallLog)
            }

            $info = Read-AsarHeader $asar
            $leaves = Get-AsarLeaves $info.Header
            $mainLeaf = $null
            foreach ($l in $leaves) { if ($l.Rel -eq 'main.js') { $mainLeaf = $l } }
            $mainText = [System.Text.Encoding]::UTF8.GetString((Get-EntryBytes $info $mainLeaf))
        }

        $res = Get-PatchedMainJs -Source $mainText -LoaderText $script:LoaderText -ConfigJson $script:DefaultConfigJson
        Add-Log ('注入点 @' + $res.AnchorIndex + ' 入口 id=' + $res.EntryId + ' 增加 ' + $res.DeltaLength + ' 字符')
        # ★ 这里得到的是**打完补丁的 main.js 文本**，不是完整 asar！
        #   必须用 Save-Asar 把「原 asar 的其它文件 + 新 main.js」重新组装成完整 asar。
        $mainBytes = [System.Text.Encoding]::UTF8.GetBytes($res.Text)

        # ---------- 2b. 在 %TEMP% 暂存完整 asar 并校验 ----------
        $stageDir = Join-Path ([System.IO.Path]::GetTempPath()) ('aura-stage-' + [System.Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $stageDir -Force | Out-Null
        $staged = Join-Path $stageDir 'app.asar'
        $savedInfo = Save-Asar -Info $info -MainBytes $mainBytes -OutPath $staged
        Add-Log ('已组装完整 asar: ' + $savedInfo.Bytes + ' 字节')

        $vInfo = Read-AsarHeader $staged
        $vLeaves = Get-AsarLeaves $vInfo.Header
        $vMain = $null
        foreach ($l in $vLeaves) { if ($l.Rel -eq 'main.js') { $vMain = $l } }
        $vText = [System.Text.Encoding]::UTF8.GetString((Get-EntryBytes $vInfo $vMain))
        if (-not $vText.Contains($script:MarkBegin)) { throw '暂存文件校验失败：没有注入标记' }
        Add-Log ('暂存校验通过: 条目数=' + $vLeaves.Count + '，大小=' + (Get-Item -LiteralPath $staged).Length + ' 字节')

        # ---------- 3. 写权限 ----------
        # ★ 已实测：希沃的 SeewoZoroWall/SeewoKeLiteLady 是内核驱动，
        #   正常模式下「新建文件」一律被拒；ACL 明明是 Administrators(F)，
        #   连 takeown / icacls 都被拒绝。
        #   试过并已证明无效的路子：改 ACL、结束保护进程、停希沃服务、
        #   目录模式（新目录内建文件同样被拒）。因此这里不再做无用尝试，
        #   直接走安全模式——那是唯一可行的路径。
        Set-Status '正在检查写权限…'
        $writable = Test-DirWritable -Dir $resourcesDir

        if (-not $writable) {
            Add-Log '正常模式写入被拦（内核驱动），直接转安全模式（不再做无用尝试）'
            if (-not (Test-IsSafeMode)) {
                Add-Log '转入安全模式安装流程'
                Show-SafeModePrompt
                return
            }
            throw ('当前已在安全模式，但目录仍不可写。日志：' + $script:NL + $script:InstallLog)
        }

# ---------- 4. 仍不可写 → 导出保底 ----------
        if (-not $writable) {
            Add-Log '仍不可写，改为导出补丁文件'
            $exported = Export-PatchedAsar -Bytes ([System.IO.File]::ReadAllBytes($staged))
            Refresh-UiState -Full
            if ($exported) {
                [System.Windows.Forms.MessageBox]::Show(
                    ('无法直接写入（希沃自我保护已开启），已把打好补丁的文件导出到桌面：' + $script:NL + $exported + $script:NL + $script:NL +
                     '可选的绕过办法：' + $script:NL +
                     '  1) 托盘退出希沃 + 结束所有希沃进程后重试' + $script:NL +
                     '  2) 重启进「安全模式」，把桌面那个文件覆盖到：' + $script:NL +
                     '     ' + $asar + $script:NL +
                     '     （覆盖前先备份原文件）' + $script:NL +
                     '  3) 请管理员临时关闭希沃自我保护' + $script:NL + $script:NL +
                     '详细诊断见日志：' + $script:NL + $script:InstallLog),
                    '已导出补丁文件', 'OK', 'Warning') | Out-Null
            } else {
                [System.Windows.Forms.MessageBox]::Show(
                    ('无法写入，也无法导出文件。请把日志发我：' + $script:NL + $script:InstallLog),
                    '安装失败', 'OK', 'Error') | Out-Null
            }
            return
        }

        # ---------- 5. 停管家 ----------
        Set-Status '正在结束希沃管家…'
        $stopped = Stop-Host
        if (-not $stopped) { Add-Log '警告：管家仍在运行，继续尝试写入' }

        # ---------- 6. 备份 + 原子替换 ----------
        Set-Status '正在写入（原子替换）…'
        $tmpNew = $asar + '.new'
        Copy-Item -LiteralPath $staged -Destination $tmpNew -Force -ErrorAction Stop
        Add-Log '已写入同目录临时文件 app.asar.new'

        if (-not (Test-Path -LiteralPath $bak)) {
            try {
                Move-Item -LiteralPath $asar -Destination $bak -ErrorAction Stop
                Add-Log '备份：重命名 app.asar -> app.asar.bak'
            } catch {
                Add-Log ('重命名备份失败，改用复制: ' + $_.Exception.Message)
                Copy-Item -LiteralPath $asar -Destination $bak -Force -ErrorAction Stop
                Add-Log '备份：复制'
            }
        } else {
            Add-Log '已存在备份，保留不覆盖'
        }

        try {
            if (Test-Path -LiteralPath $asar) {
                if (-not (Set-FileContentFrom -Source $tmpNew -Target $asar)) { throw '替换 app.asar 失败（三种方式都不可用）' }
                Add-Log '原子替换成功 (File.Replace)'
            } else {
                Move-Item -LiteralPath $tmpNew -Destination $asar -Force -ErrorAction Stop
                Add-Log '移入新文件（原文件已作为备份）'
            }
        } catch {
            Add-Log ('原子替换失败: ' + $_.Exception.Message)
            if (Test-Path -LiteralPath $bak) {
                Copy-Item -LiteralPath $bak -Destination $asar -Force -ErrorAction SilentlyContinue
                Add-Log '已从备份回滚'
            }
            throw
        } finally {
            Remove-Item -LiteralPath $tmpNew -Force -ErrorAction SilentlyContinue
        }

        # ---------- 7. 重启 + 确认 ----------
        Set-Status '正在重启希沃管家…'
        if (Test-Path -LiteralPath $script:LogPath) {
            Remove-Item -LiteralPath $script:LogPath -Force -ErrorAction SilentlyContinue
        }
        $started = Start-Host -Dir $dir
        Add-Log ('重启管家: ' + $started)

        Set-Status '正在确认加载器已运行…'
        $deadline = (Get-Date).AddSeconds(30)
        $ready = $false
        while ((Get-Date) -lt $deadline) {
            if (Test-Path -LiteralPath $script:LogPath) {
                try {
                    $logText = [System.IO.File]::ReadAllText($script:LogPath, [System.Text.Encoding]::UTF8)
                    if ($logText.Contains('命令桥已启动')) { $ready = $true; break }
                } catch { }
            }
            Start-Sleep -Milliseconds 800
        }
        Add-Log ('加载器就绪: ' + $ready)

        Refresh-UiState -Full

        if (Complete-SafeModeIfNeeded) {
            [System.Windows.Forms.MessageBox]::Show(('注入完成（加载器就绪: ' + $ready + '）。' + $script:NL + $script:NL + '当前处于安全模式，20 秒后自动重启回正常模式。'), '安装成功', 'OK', 'Information') | Out-Null
            return
        }

        if ($ready) {
            Add-Log '安装成功'
            [System.Windows.Forms.MessageBox]::Show(
                ('注入成功，加载器已确认运行。' + $script:NL + $script:NL + '希沃管家已自动重启。现在可以配置并预览了。'),
                '安装成功', 'OK', 'Information') | Out-Null
        } else {
            Add-Log '已写入但未确认加载器就绪'
            $extra = ''
            if (-not $started) { $extra = $script:NL + $script:NL + '注意：没能自动启动希沃管家，请手动打开。' }
            [System.Windows.Forms.MessageBox]::Show(
                ('app.asar 已注入成功，但暂时没在日志里看到加载器就绪。' + $extra + $script:NL + $script:NL +
                 '稍后点「查看日志」，看到「命令桥已启动」就说明正常。'),
                '已写入，等待加载器', 'OK', 'Warning') | Out-Null
        }
    } catch {
        Add-Log ('安装失败: ' + $_.Exception.Message)
        Add-Log ('异常类型: ' + $_.Exception.GetType().FullName)
        if ($_.Exception.InnerException) { Add-Log ('内部异常: ' + $_.Exception.InnerException.Message) }
        try { Add-Log ('调用栈: ' + $_.ScriptStackTrace) } catch { }
        Refresh-UiState -Full
        $logHint = $script:InstallLog
        if (-not $logHint) { $logHint = '(日志不可用)' }
        $msg = '安装失败：' + $_.Exception.Message + $script:NL + $script:NL + '详细日志：' + $script:NL + $logHint
        if ($script:ExeLog) { $msg = $msg + $script:NL + $script:ExeLog }
        [System.Windows.Forms.MessageBox]::Show($msg, '安装失败', 'OK', 'Error') | Out-Null
    } finally {
        if ($stageDir) { Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue }
        $btnInstall.Enabled = $true
    }
})

# ---------------------------------------------------------------------------
# 保存并预览
# ---------------------------------------------------------------------------

$btnImageSwap.add_Click({ Show-ImageSwapDialog })

$btnPickFolder.add_Click({
    try {
        $fb = New-Object System.Windows.Forms.FolderBrowserDialog
        $fb.Description = '选择放有屏保图片的文件夹（自动取里面所有图片）'
        if ($fb.ShowDialog() -ne 'OK') { return }
        $files = Get-ImageFilesInFolder -Folder $fb.SelectedPath
        if ($files.Count -eq 0) {
            [System.Windows.Forms.MessageBox]::Show('这个文件夹里没有图片（支持 jpg/png/bmp/gif/webp）。', '没找到图片', 'OK', 'Warning') | Out-Null
            return
        }
        Set-ImageListFromPaths -Paths ($files | ForEach-Object { $_.FullName })
    } catch {
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, '选择失败', 'OK', 'Warning') | Out-Null
    }
})

$btnPickFiles.add_Click({
    try {
        $of = New-Object System.Windows.Forms.OpenFileDialog
        $of.Multiselect = $true
        $of.Filter = '图片/动图|*.jpg;*.jpeg;*.png;*.bmp;*.gif;*.webp;*.apng;*.avif|所有文件|*.*'
        if ($of.ShowDialog() -ne 'OK') { return }
        Set-ImageListFromPaths -Paths $of.FileNames
    } catch {
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, '选择失败', 'OK', 'Warning') | Out-Null
    }
})

$txtImages.add_TextChanged({ Update-ImageCountHint })
$btnPreviewImgs.add_Click({ Show-ImagePreviewDialog })
$linkDiag.add_Click({ Show-DiagnosticDialog })
$linkClean.add_Click({ Invoke-CleanupDialog })
$linkSwap.add_Click({ Show-ImageSwapDialog })

# 转场：按当前图片数随机生成 N 个编号（想固定效果又不想手填时用）
$btnTransRandom.add_Click({
    try {
        $n = 0
        if ($txtImages.Text.Trim() -ne '') {
            $n = @($txtImages.Text -split "\r?\n" | Where-Object { $_.Trim() -ne '' }).Count
        }
        if ($n -le 0) {
            [System.Windows.Forms.MessageBox]::Show('先在「图片列表」里添加图片，再生成转场。', '还没有图片', 'OK', 'Information') | Out-Null
            return
        }
        $vals = @()
        for ($i = 0; $i -lt $n; $i++) { $vals += (Get-Random -Minimum 0 -Maximum 7) }
        $txtTrans.Text = ($vals -join ', ')
    } catch {
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, '生成失败', 'OK', 'Warning') | Out-Null
    }
})
$btnTransClear.add_Click({ $txtTrans.Text = '' })

# 手动指定浏览器 exe（自动找不到 Edge/Chrome 时用）
$btnWebBrowser.add_Click({
    try {
        $of = New-Object System.Windows.Forms.OpenFileDialog
        $of.Multiselect = $false
        $of.Title = '选择浏览器程序（msedge.exe 或 chrome.exe）'
        $of.Filter = '浏览器程序|msedge.exe;chrome.exe|可执行文件|*.exe|所有文件|*.*'
        $cur = $txtWebBrowser.Text.Trim()
        if ($cur -ne '' -and (Test-Path -LiteralPath (Split-Path -Parent $cur))) { $of.InitialDirectory = (Split-Path -Parent $cur) }
        if ($of.ShowDialog() -ne 'OK') { return }
        $txtWebBrowser.Text = $of.FileName
        Set-Status ('已指定浏览器: ' + $of.FileName)
    } catch {
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, '选择失败', 'OK', 'Warning') | Out-Null
    }
})
# 选择本地网页文件
$btnWebPick.add_Click({
    try {
        $of = New-Object System.Windows.Forms.OpenFileDialog
        $of.Multiselect = $false
        $of.Filter = '网页文件|*.html;*.htm;*.xhtml;*.svg;*.mhtml;*.mht|所有文件|*.*'
        if ($of.ShowDialog() -ne 'OK') { return }
        $txtWebUrl.Text = $of.FileName
    } catch {
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, '选择失败', 'OK', 'Warning') | Out-Null
    }
})

# 失焦时自动补 https://（用户要求：只写 bing.com 也能用）
$txtWebUrl.add_Leave({
    try {
        $before = $txtWebUrl.Text
        $after = Normalize-WebInput -Raw $before
        if ($after -ne $before) { $txtWebUrl.Text = $after }
    } catch { }
})

# ---- 保存：只写配置，不弹屏保 ----
$btnSave.add_Click({
    try {
        $cfg = Build-Config
        Save-ConfigFile -Config $cfg
        Set-Status ('配置已保存（' + (Get-Date).ToString("HH:mm:ss") + '）')
    } catch {
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, '配置有误', 'OK', 'Warning') | Out-Null
    }
})

# ---- 预览：用界面当前配置直接唤起屏保，不写盘 ----
#    刻意与「保存」分开：想看效果不必先落盘，改错了也不会污染已保存的配置。
$btnPreview.add_Click({
    try {
        $cfg = Build-Config
    } catch {
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, '配置有误', 'OK', 'Warning') | Out-Null
        return
    }

    # 只有自定义图集真有图片时才直传载荷；否则交给加载器按优先级回落
    $payload = $null
    if ($null -ne $cfg.override -and @($cfg.override.imageList).Count -gt 0) { $payload = $cfg.override }

    if ((Get-HostProcs).Count -eq 0) {
        [System.Windows.Forms.MessageBox]::Show(
            ('希沃管家没有在运行，无法预览。' + $script:NL + $script:NL +
             '请先打开希沃管家（或重新点「一键安装」会自动帮你启动）。'),
            '管家未运行', 'OK', 'Warning') | Out-Null
        Set-Status '管家未运行，无法预览。'
        return
    }

    Set-Status '正在唤起屏保…'
    $btnSave.Enabled = $false
    $btnPreview.Enabled = $false
    $r = Invoke-Preview -Payload $payload
    $btnSave.Enabled = $true
    $btnPreview.Enabled = $true

    if ($null -eq $r) {
        Set-Status '预览超时：命令已发出，但管家没有响应。'
        [System.Windows.Forms.MessageBox]::Show(
            ('预览命令已发出，但管家进程没有响应。' + $script:NL + $script:NL +
             '请点「日志」，确认有「命令桥已启动」这一行。' + $script:NL +
             '若没有，请重新点「一键安装」（必要时先「卸载还原」再装一次）。'),
            '预览超时', 'OK', 'Warning') | Out-Null
        return
    }

    if ($r.ok) {
        $src = '界面当前配置'
        switch ([string]$r.source) {
            'provided'          { $src = '界面当前配置（未保存）' }
            'override'          { $src = '已保存的自定义图集' }
            'last-payload'      { $src = '最近一次集控下发' }
            'cloud-picture'     { $src = '集控下发的图片缓存' }
            'screen-saver-json' { $src = '本机缓存的集控屏保' }
        }
        $n = ''
        if ($null -ne $r.imageCount) { $n = '，图片 ' + $r.imageCount + ' 张' }
        if ($null -ne $r.missingCount -and [int]$r.missingCount -gt 0) { $n += ('，其中 ' + $r.missingCount + ' 张路径不存在') }
        Set-Status ('屏保已唤起（来源：' + $src + $n + '）')
    } else {
        $msg = [string]$r.message
        if ($msg -eq '') { $msg = '原因：' + [string]$r.reason }
        if ($null -ne $r.details -and @($r.details).Count -gt 0) {
            $msg += $script:NL + $script:NL + '详情：' + $script:NL + (@($r.details) -join $script:NL)
        }
        Set-Status ('预览失败：' + $msg)
        [System.Windows.Forms.MessageBox]::Show($msg, '预览失败', 'OK', 'Warning') | Out-Null
    }
})

# ---------------------------------------------------------------------------
# 卸载还原
# ---------------------------------------------------------------------------

$btnUninstall.add_Click({
    $st = $script:State
    $ans = [System.Windows.Forms.MessageBox]::Show(
        ('确定要卸载还原吗？' + $script:NL + $script:NL +
         '会用备份覆盖当前 app.asar，屏保恢复官方行为。' + $script:NL +
         '希沃管家会被自动结束并重启。'),
        '确认卸载', 'OKCancel', 'Question')
    if ($ans -ne 'OK') { return }

    Initialize-InstallerLog

    $btnUninstall.Enabled = $false
    try {
        if (-not $st -or -not $st.Dir) { $st = Get-InjectionState }
        $dir = $st.Dir
        if (-not $dir) { throw '找不到安装目录' }
        Add-Log ('卸载：安装目录 ' + $dir)

        $asar = Join-Path (Join-Path $dir 'resources') 'app.asar'
        $bak = $asar + '.bak'
        if (-not (Test-Path -LiteralPath $bak)) { throw ('没有备份文件：' + $bak) }

        Set-Status '正在结束希沃管家…'
        Stop-Host

        Set-Status '正在还原官方 app.asar…'
        $restoreFailed = $null
        try {
            if (Test-Path -LiteralPath $asar -PathType Container) {
                Remove-Item -LiteralPath $asar -Recurse -Force -ErrorAction Stop
                Add-Log '卸载：已删除目录形态的 app.asar'
            }
            Copy-Item -LiteralPath $bak -Destination $asar -Force -ErrorAction Stop
            Add-Log '卸载：已还原 app.asar'
        } catch {
            $restoreFailed = $_
            Add-Log ('卸载失败（写入被拒）: ' + $_.Exception.Message)
        }

        if ($null -ne $restoreFailed) {
            # 写入被驱动拦 → 走安全模式
            if (Test-IsSafeMode) {
                throw ('当前已在安全模式下仍无法还原。' + $script:NL + $restoreFailed.Exception.Message)
            }
            $pick = [System.Windows.Forms.MessageBox]::Show(
                ('还原失败：' + $restoreFailed.Exception.Message + $script:NL + $script:NL +
                 '卸载同样需要写入 app.asar，所以也会被希沃的驱动拦。' + $script:NL + $script:NL +
                 '要重启到安全模式自动卸载吗？' + $script:NL +
                 '（全自动：注入回滚 → 关掉安全模式 → 重启回正常）'),
                '需要安全模式才能卸载', 'YesNo', 'Question')
            if ($pick -eq 'Yes') {
                Set-Status '正在准备重启到安全模式…'
                [void](Invoke-EnterSafeModeAction -Action 'uninstall')
                [System.Windows.Forms.MessageBox]::Show(
                    ('已设置好，10 秒后重启进入安全模式自动卸载。' + $script:NL + $script:NL +
                     '急救：万一卡在安全模式，双击桌面「退出安全模式.bat」。'),
                    '即将重启', 'OK', 'Information') | Out-Null
                return
            }
            return
        }

        Set-Status '正在重启希沃管家…'
        [void](Start-Host -Dir $dir)

        if (Complete-SafeModeIfNeeded) {
            [System.Windows.Forms.MessageBox]::Show(('已还原官方 app.asar。' + $script:NL + $script:NL + '当前处于安全模式，20 秒后自动重启回正常模式。'), '卸载完成', 'OK', 'Information') | Out-Null
            return
        }

        Refresh-UiState -Full
        [System.Windows.Forms.MessageBox]::Show(
            ('已还原官方 app.asar，希沃管家已重启。' + $script:NL + $script:NL +
             '备份文件仍保留，可再次安装。'),
            '卸载完成', 'OK', 'Information') | Out-Null
    } catch {
        Add-Log ('卸载异常: ' + $_.Exception.Message)
        Refresh-UiState -Full
        [System.Windows.Forms.MessageBox]::Show(
            ('卸载失败：' + $_.Exception.Message + $script:NL + $script:NL +
             '详细日志：' + $script:NL + $script:InstallLog),
            '卸载失败', 'OK', 'Error') | Out-Null
    } finally {
        $btnUninstall.Enabled = $true
    }
})

# ---------------------------------------------------------------------------
# 其他
# ---------------------------------------------------------------------------

# 三选一：切换时立即显示/隐藏对应选项
foreach ($rb in @($rbModeImage, $rbModeWeb, $rbModeNone)) {
    $rb.add_CheckedChanged({ Update-ModeVisibility })
}
Update-ModeVisibility

$linkLog.add_Click({
    if (Test-Path -LiteralPath $script:LogPath) {
        Start-Process notepad.exe -ArgumentList ('"' + $script:LogPath + '"')
    } else {
        [System.Windows.Forms.MessageBox]::Show(
            ('还没有日志文件：' + $script:NL + $script:LogPath + $script:NL + $script:NL +
             '日志在注入生效、管家启动后才会产生。'),
            '暂无日志', 'OK', 'Information') | Out-Null
    }
})

# 轻量刷新：只更新进程状态，避免每次重读 11MB 的 asar
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({ try { Refresh-UiState } catch { } })
$timer.Start()

$form.add_Shown({
    Refresh-UiState -Full
    if ($btnInstall.Visible) {
        $btnInstall.Focus()
    }
})

# 安全模式下「手动打开」：只要有待办动作就直接继续，不需要用户点任何按钮。
#   （用户反馈：自动触发没生效时还得手动打开再点一下，而提示写的是「全自动」，误导）
if (-not ($args -contains '-SafeInstall') -and -not ($args -contains '-SafeUninstall')) {
    try {
        if ((Test-IsSafeMode) -and (Test-Path -LiteralPath $script:PendingActionPath)) {
            $pend = ([System.IO.File]::ReadAllText($script:PendingActionPath)).Trim()
            if ($pend -eq 'install' -or $pend -eq 'uninstall') {
                try {
                    Initialize-InstallerLog
                    Add-Log '检测到安全模式待办动作，自动继续（无需点击）'
                } catch { }
                [void](Invoke-SafeModeAutoAction -Action $pend)
                exit 0
            }
        }
    } catch { }
}

# 安全模式自动动作：由 RunOnce 在安全模式登录时带 -SafeInstall / -SafeUninstall 调起
if (($args -contains '-SafeInstall') -or ($args -contains '-SafeUninstall')) {
    try {
        Initialize-InstallerLog
        Add-LogFacts
        Add-Log ('安全模式: ' + (Test-IsSafeMode))
    } catch { }

    if (-not (Test-IsSafeMode)) {
        # 已经回到正常模式：说明安全模式里跑过了，这里只清理，绝不重启
        try { Add-Log '不在安全模式，跳过自动动作（仅清理 RunOnce）' } catch { }
        try { Remove-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce' -Name 'AuraScreensaver_SafeInstall' -ErrorAction SilentlyContinue } catch { }
        exit 0
    }

    $act = 'install'
    if ($args -contains '-SafeUninstall') { $act = 'uninstall' }
    [void](Invoke-SafeModeAutoAction -Action $act)
    exit 0
}



[void]$form.ShowDialog()
