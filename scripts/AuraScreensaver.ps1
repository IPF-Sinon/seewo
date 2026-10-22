<#
.SYNOPSIS
    希沃管家屏保深度配置工具 —— 一键安装 / 卸载（注入式方案）

.DESCRIPTION
    本脚本是「注入器」的 Windows 侧启动器 + 安装器。它做三件事：
      1. 定位希沃管家（SeewoServiceAssistant）安装目录；
      2. 备份官方 resources\app.asar -> app.asar.bak（已存在则绝不覆盖）；
      3. 调用本仓库的 PowerShell 注入器 tools\ps\Patch-Asar.ps1 把屏保模块注入 asar 副本，
         并写入默认配置 %APPDATA%\seewo\AuraScreensaver\config.json。

    ★ 为什么必须是 .ps1 而不是 .bat：
    历史故障：在 .bat 里用 ^ 续行内联 PowerShell 时，CMD 会**先**做自己的解析，
    把 % 当成环境变量起始符、把引号按 CMD 规则配对，导致传给 PowerShell 的源码残缺，
    报出 "Missing ']' after array index expression" / "Unexpected token '$(...'" 
    / "The string is missing the terminator" 等错误。
    因此本方案的纪律是：**.bat 里绝不出现任何 PowerShell 代码**，
    只允许一行 powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0AuraScreensaver.ps1"。

.PARAMETER Uninstall
    从 app.asar.bak 还原官方 app.asar（不删除 .bak，便于再次安装）。

.PARAMETER ConfigPath
    自定义配置文件路径。缺省 %APPDATA%\seewo\AuraScreensaver\config.json

.PARAMETER SeewoDir
    手动指定希沃管家安装目录（即包含 resources\app.asar 的那一层）。

.PARAMETER WhatIf
    预演模式：只打印将要执行的动作，不做任何写盘（含备份与还原）。

.PARAMETER Force
    跳过「危险操作前」的交互确认（用于无人值守）。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\AuraScreensaver.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\AuraScreensaver.ps1 -Uninstall

.NOTES
    所有技术结论依据本仓库的一手逆向材料：
      .work/FINDINGS.md          —— 控制器路由 "/displayScreenSaver"
      .work/RENDERER_CONTRACT.md —— 渲染器字段契约
      .work/CASCADE_ANALYSIS.md  —— 锁屏级联
      docs/对话勘误与结论.md      —— 已实证结论
    本脚本**不会**结束或重启希沃管家进程，也不会修改 Verify.json 覆盖的官方文件。
#>

#Requires -Version 5.1

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$Uninstall,

    [string]$ConfigPath = "",

    [string]$SeewoDir = "",

    [switch]$Force
)

# =====================================================================================
# 0. 全局设置
# =====================================================================================

Set-StrictMode -Version 2.0

$ErrorActionPreference = "Stop"
try {
    # 让中文在 PowerShell 5.1 的控制台里不乱码（失败不影响逻辑）
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch {
    # 忽略：某些宿主（如 ISE / 重定向）不允许改控制台编码
}

$script:AppName = "希沃屏保深度配置工具"
$script:Version = "1.0.0"

# 本脚本所在目录 = 仓库 scripts\ 目录；仓库根目录 = 其上一级
$script:ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:RepoRoot  = Split-Path -Parent $script:ScriptDir

$script:PatchScript = Join-Path $script:RepoRoot (Join-Path "tools" (Join-Path "ps" "Patch-Asar.ps1"))

# 默认配置目录：%APPDATA%\seewo\AuraScreensaver\
# 说明：src\config\configManager.js 内部默认目录是 %APPDATA%\seewo-aura-screensaver\，
#       两者不同；本脚本按产品交付要求写 %APPDATA%\seewo\AuraScreensaver\config.json。
#       若用户要接注入器，请用 -ConfigPath 指向注入器实际读取的那个文件。
$script:DefaultConfigPath = ""
if ($env:APPDATA) {
    $script:DefaultConfigPath = Join-Path $env:APPDATA (Join-Path "seewo" (Join-Path "AuraScreensaver" "config.json"))
}

# 希沃管家常见安装位置（含通配符），按「先具体后宽泛」排序
$script:SearchPatterns = @(
    "C:\Program Files (x86)\Seewo\SeewoService\SeewoService_*\SeewoServiceAssistant",
    "C:\Program Files\Seewo\SeewoService\SeewoService_*\SeewoServiceAssistant",
    "C:\Program Files (x86)\Seewo\SeewoServiceAssistant",
    "C:\Program Files\Seewo\SeewoServiceAssistant",
    "C:\Program Files (x86)\Seewo\SeewoService\SeewoServiceAssistant",
    "C:\Program Files\Seewo\SeewoService\SeewoServiceAssistant",
    "D:\Program Files (x86)\Seewo\SeewoService\SeewoService_*\SeewoServiceAssistant",
    "D:\Program Files\Seewo\SeewoService\SeewoService_*\SeewoServiceAssistant",
    "D:\Program Files (x86)\Seewo\SeewoServiceAssistant",
    "D:\Program Files\Seewo\SeewoServiceAssistant"
)

# =====================================================================================
# 1. 输出助手（中文 + 颜色）
# =====================================================================================

function Write-Head {
    param([string]$Text)
    Write-Host ""
    Write-Host ("=" * 66) -ForegroundColor DarkCyan
    Write-Host ("  " + $Text) -ForegroundColor Cyan
    Write-Host ("=" * 66) -ForegroundColor DarkCyan
}

function Write-Ok {
    param([string]$Text)
    Write-Host ("  [OK]   " + $Text) -ForegroundColor Green
}

function Write-Info {
    param([string]$Text)
    Write-Host ("  [信息] " + $Text) -ForegroundColor Gray
}

function Write-Note {
    param([string]$Text)
    Write-Host ("  [注意] " + $Text) -ForegroundColor Yellow
}

function Write-Err {
    param([string]$Text)
    Write-Host ("  [错误] " + $Text) -ForegroundColor Red
}

function Write-Banner {
    Write-Host ""
    Write-Host ("  " + $script:AppName + "  v" + $script:Version) -ForegroundColor White
    Write-Host "  注入式方案（不修改官方签名文件清单，仅替换 resources\app.asar）" -ForegroundColor DarkGray
}

# 危险操作确认；-Force 或 -WhatIf 时自动通过
function Confirm-Action {
    param(
        [string]$Question,
        [string]$Detail = ""
    )
    if ($Force) { return $true }
    if ($WhatIfPreference) { return $true }
    if ($Detail) { Write-Note $Detail }
    Write-Host ""
    Write-Host ("  " + $Question + " [Y/N] ") -ForegroundColor Yellow -NoNewline
    $ans = Read-Host
    if ($ans -eq "Y" -or $ans -eq "y") { return $true }
    Write-Info "用户取消，未做任何修改。"
    return $false
}

# 结束前暂停，让双击启动的用户能看到结果
function Stop-WithPause {
    param([int]$Code = 0)
    Write-Host ""
    Write-Host "  按回车键退出..." -ForegroundColor DarkGray -NoNewline
    try { [void](Read-Host) } catch { }
    exit $Code
}

# =====================================================================================
# 2. 前置检查
# =====================================================================================

function Test-PatcherAvailable {
    Write-Head "第 1 步 / 6：检查注入器"

    if (-not (Test-Path -LiteralPath $script:PatchScript -PathType Leaf)) {
        Write-Err ("找不到注入器：" + $script:PatchScript)
        Write-Host ""
        Write-Note "请确认 tools\ps\Patch-Asar.ps1 存在；不要只把 scripts 目录单独拷走。"
        return $false
    }

    $loader = Join-Path $script:RepoRoot (Join-Path "tools" (Join-Path "payload" "aura-screensaver-loader.js"))
    if (-not (Test-Path -LiteralPath $loader -PathType Leaf)) {
        Write-Err ("找不到加载器：" + $loader)
        return $false
    }

    Write-Ok "注入器就绪（纯 PowerShell 实现，无需安装 Node.js）"
    return $true
}

function Test-RepoLayout {
    Write-Head "第 2 步 / 6：检查本工具仓库完整性"
    Write-Info ("脚本目录：" + $script:ScriptDir)
    Write-Info ("仓库根目录：" + $script:RepoRoot)

    if (-not (Test-Path -LiteralPath $script:RepoRoot -PathType Container)) {
        Write-Err ("仓库根目录不存在：" + $script:RepoRoot)
        return $false
    }

    $hasPatch = Test-Path -LiteralPath $script:PatchScript -PathType Leaf
    if (-not $hasPatch) {
        Write-Err ("缺少注入器脚本：" + $script:PatchScript)
        Write-Host ""
        Write-Host "  请确认解压出来的目录结构是这样（scripts 与 tools 是同级目录）：" -ForegroundColor Yellow
        Write-Host "    seewo-screensaver-tool\" -ForegroundColor Gray
        Write-Host "      scripts\AuraScreensaver.ps1" -ForegroundColor Gray
        Write-Host "      scripts\安装.bat" -ForegroundColor Gray
        Write-Host "      scripts\卸载.bat" -ForegroundColor Gray
        Write-Host "      tools\ps\Patch-Asar.ps1      <-- 必须存在" -ForegroundColor Gray
        Write-Host "      src\ ..." -ForegroundColor Gray
        Write-Host ""
        Write-Note "不要只把 scripts 目录单独拷出去，那样 tools\ps\Patch-Asar.ps1 会找不到。"
        return $false
    }
    Write-Ok ("已找到注入器：" + $script:PatchScript)

    $srcIndex = Join-Path $script:RepoRoot (Join-Path "src" "index.js")
    if (Test-Path -LiteralPath $srcIndex -PathType Leaf) {
        Write-Ok ("已找到注入模块入口：" + $srcIndex)
    } else {
        Write-Note ("未找到 " + $srcIndex + "（若注入器自包含则不影响）")
    }
    return $true
}

# =====================================================================================
# 3. 定位希沃管家
# =====================================================================================

# 判断一个目录是否「像」希沃管家安装目录：必须含有 resources\app.asar
function Test-SeewoDir {
    param([string]$Dir)
    if (-not $Dir) { return $false }
    if (-not (Test-Path -LiteralPath $Dir -PathType Container)) { return $false }
    $asar = Join-Path $Dir (Join-Path "resources" "app.asar")
    return (Test-Path -LiteralPath $asar -PathType Leaf)
}

function Get-SeewoDirCandidates {
    $found = New-Object System.Collections.ArrayList
    $seen = @{}

    foreach ($pattern in $script:SearchPatterns) {
        # 通配符目录搜索：只展开「目录」层级，不做全盘遍历
        try {
            $dirs = Get-ChildItem -Path $pattern -Directory -ErrorAction SilentlyContinue |
                    Sort-Object -Property FullName -Descending
        } catch {
            $dirs = @()
        }
        foreach ($d in $dirs) {
            $p = $d.FullName
            if (-not $seen.ContainsKey($p) -and (Test-SeewoDir -Dir $p)) {
                $seen[$p] = $true
                [void]$found.Add($p)
            }
        }
    }

    # 兜底：注册表卸载项里记录的安装位置
    $regRoots = @(
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*"
    )
    foreach ($r in $regRoots) {
        try {
            $items = Get-ItemProperty -Path $r -ErrorAction SilentlyContinue |
                     Where-Object { $_.DisplayName -like "*希沃*" -or $_.DisplayName -like "*Seewo*" }
            foreach ($it in $items) {
                if ($it.InstallLocation -and (Test-SeewoDir -Dir $it.InstallLocation) -and -not $seen.ContainsKey($it.InstallLocation)) {
                    $seen[$it.InstallLocation] = $true
                    [void]$found.Add($it.InstallLocation)
                }
            }
        } catch {
            # 注册表不可读不是致命错误
        }
    }

    return $found
}

function Resolve-SeewoDir {
    Write-Head "第 3 步 / 6：定位希沃管家安装目录"

    if ($SeewoDir -ne "") {
        Write-Info ("使用 -SeewoDir 指定的目录：" + $SeewoDir)
        if (Test-SeewoDir -Dir $SeewoDir) {
            Write-Ok "校验通过：resources\app.asar 存在。"
            return $SeewoDir
        }
        Write-Err ("指定目录校验失败，没有找到 " + (Join-Path $SeewoDir (Join-Path "resources" "app.asar")))
        Write-Note "请传入「包含 resources 子目录」的那一层目录。"
        return $null
    }

    Write-Info "正在自动搜索常见安装位置..."
    $candidates = Get-SeewoDirCandidates

    if ($candidates.Count -eq 1) {
        Write-Ok ("自动定位成功：" + $candidates[0])
        return $candidates[0]
    }

    if ($candidates.Count -gt 1) {
        Write-Note ("找到 " + $candidates.Count + " 个候选安装目录，请选择：")
        for ($i = 0; $i -lt $candidates.Count; $i++) {
            Write-Host ("    [" + ($i + 1) + "] " + $candidates[$i]) -ForegroundColor Gray
        }
        Write-Host ""
        Write-Host "  请输入序号（直接回车取消）： " -ForegroundColor Yellow -NoNewline
        $sel = Read-Host
        if ($sel -match '^\d+$') {
            $idx = [int]$sel - 1
            if ($idx -ge 0 -and $idx -lt $candidates.Count) {
                return $candidates[$idx]
            }
        }
        Write-Info "未选择有效序号。"
        return $null
    }

    # 一个都没找到 -> 让用户手输
    Write-Note "未能自动定位希沃管家安装目录。"
    Write-Host ""
    Write-Host "  已尝试的路径模板：" -ForegroundColor Gray
    foreach ($p in $script:SearchPatterns) {
        Write-Host ("    " + $p) -ForegroundColor DarkGray
    }
    Write-Host ""
    Write-Host "  手动确认方法（推荐）：" -ForegroundColor Yellow
    Write-Host "    1) 右键桌面「希沃管家」快捷方式 -> 属性 -> 打开文件所在位置" -ForegroundColor Gray
    Write-Host "    2) 在该目录下应能看到 resources 文件夹，里面有 app.asar" -ForegroundColor Gray
    Write-Host "    3) 把【该目录的完整路径】粘贴到下面" -ForegroundColor Gray
    Write-Host ""

    for ($try = 1; $try -le 3; $try++) {
        Write-Host ("  请输入希沃管家目录（第 " + $try + "/3 次，直接回车放弃）： ") -ForegroundColor Yellow -NoNewline
        $manual = Read-Host
        if ([string]::IsNullOrWhiteSpace($manual)) { return $null }
        $manual = $manual.Trim().Trim('"')
        if (Test-SeewoDir -Dir $manual) {
            Write-Ok ("校验通过：" + $manual)
            return $manual
        }
        Write-Err ("该目录下没有 resources\app.asar：" + $manual)
    }
    Write-Err "三次均未通过校验，退出。"
    return $null
}

# =====================================================================================
# 4. 备份与还原
# =====================================================================================

function Backup-Asar {
    param([string]$AsarPath)

    Write-Head "第 4 步 / 6：备份官方 app.asar"

    $bakPath = $AsarPath + ".bak"

    if (Test-Path -LiteralPath $bakPath -PathType Leaf) {
        # ★ 关键纪律：已存在的 .bak 是「原始官方文件的唯一保险」，绝不覆盖
        $bakSize = (Get-Item -LiteralPath $bakPath).Length
        Write-Ok ("已存在备份，保持不动（保护原始备份）：" + $bakPath)
        Write-Info ("备份大小：" + $bakSize + " 字节")
        return $bakPath
    }

    Write-Note ("即将把官方文件复制一份作为备份：" )
    Write-Host ("    源： " + $AsarPath) -ForegroundColor Gray
    Write-Host ("    目标：" + $bakPath) -ForegroundColor Gray

    if ($WhatIfPreference) {
        Write-Info "[WhatIf] 跳过实际复制。"
        return $bakPath
    }

    try {
        Copy-Item -LiteralPath $AsarPath -Destination $bakPath -Force:$false -ErrorAction Stop
    } catch {
        Write-Err ("备份失败：" + $_.Exception.Message)
        Write-Note "可能原因：文件被希沃管家占用 / 需要管理员权限。"
        Write-Note "请先【完全退出希沃管家】（托盘图标 -> 退出），再重试。"
        return $null
    }

    if (-not (Test-Path -LiteralPath $bakPath -PathType Leaf)) {
        Write-Err "备份后未找到备份文件，中止以防误改。"
        return $null
    }
    $srcLen = (Get-Item -LiteralPath $AsarPath).Length
    $bakLen = (Get-Item -LiteralPath $bakPath).Length
    if ($srcLen -ne $bakLen) {
        Write-Err ("备份大小不一致（源 " + $srcLen + " / 备份 " + $bakLen + "），中止。")
        return $null
    }
    Write-Ok ("备份完成并校验一致（" + $bakLen + " 字节）：" + $bakPath)
    return $bakPath
}

function Restore-Asar {
    param([string]$AsarPath)

    Write-Head "第 4 步 / 6：从备份还原官方 app.asar"

    $bakPath = $AsarPath + ".bak"
    if (-not (Test-Path -LiteralPath $bakPath -PathType Leaf)) {
        Write-Err ("找不到备份文件：" + $bakPath)
        Write-Note "无法还原。若你从未运行过安装，说明官方文件未被改动，无需还原。"
        return $false
    }

    Write-Note "即将用备份覆盖当前 app.asar（这是危险操作，会丢弃注入后的改动）："
    Write-Host ("    备份源：" + $bakPath) -ForegroundColor Gray
    Write-Host ("    还原到：" + $AsarPath) -ForegroundColor Gray

    if (-not $WhatIfPreference) {
        if (-not (Confirm-Action -Question "确认还原官方 app.asar 吗？")) { return $false }
    }

    if ($WhatIfPreference) {
        Write-Info "[WhatIf] 跳过实际还原。"
        return $true
    }

    # 还原前把当前（已注入）的 asar 另存一份，便于后悔
    $injectedPath = $AsarPath + ".injected"
    try {
        Copy-Item -LiteralPath $AsarPath -Destination $injectedPath -Force -ErrorAction Stop
        Write-Info ("已把注入版另存为：" + $injectedPath)
    } catch {
        Write-Note ("无法另存注入版（不影响还原）：" + $_.Exception.Message)
    }

    try {
        Copy-Item -LiteralPath $bakPath -Destination $AsarPath -Force -ErrorAction Stop
    } catch {
        Write-Err ("还原失败：" + $_.Exception.Message)
        Write-Note "可能原因：文件被希沃管家占用 / 需要管理员权限。请先完全退出希沃管家。"
        return $false
    }
    Write-Ok "已从备份还原官方 app.asar。"
    return $true
}

# =====================================================================================
# 5. 配置文件
# =====================================================================================

function Get-ConfigTemplate {
    # 字段严格对齐本仓库 src\config\schema.js 的 DEFAULT_CONFIG / DEFAULT_OVERRIDE，
    # 也即 .work\RENDERER_CONTRACT.md 里渲染器真实读取的字段名。
    return @'
{
  "screensaverEnabled": false,
  "lockCascadeOnClose": false,
  "allowManualClose": true,
  "override": null,
  "logLevel": "info",
  "backupCount": 3
}
'@
}

function Ensure-ConfigFile {
    param([string]$Path)

    Write-Head "第 5 步 / 6：写入默认配置"

    if ([string]::IsNullOrWhiteSpace($Path)) {
        Write-Note "未解析到配置文件路径（可能没有 APPDATA 环境变量），跳过。"
        Write-Info "可用 -ConfigPath 显式指定。"
        return $false
    }

    Write-Info ("配置文件路径：" + $Path)

    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        Write-Ok "配置文件已存在，保持不动（不覆盖用户已有配置）。"
        return $true
    }

    if ($WhatIfPreference) {
        Write-Info "[WhatIf] 将创建配置文件及所在目录，跳过。"
        return $true
    }

    $dir = Split-Path -Parent $Path
    try {
        if (-not (Test-Path -LiteralPath $dir -PathType Container)) {
            New-Item -Path $dir -ItemType Directory -Force -ErrorAction Stop | Out-Null
            Write-Ok ("已创建配置目录：" + $dir)
        }
        Set-Content -LiteralPath $Path -Value (Get-ConfigTemplate) -Encoding UTF8 -ErrorAction Stop
        Write-Ok "已写入默认配置。"
        Write-Info "默认值说明（依据 .work\RENDERER_CONTRACT.md）："
        Write-Host "    screensaverEnabled : false  -> 禁用屏保（吞掉 /displayScreenSaver 指令）" -ForegroundColor Gray
        Write-Host "    lockCascadeOnClose : false  -> 关屏保后不再级联进入屏幕锁" -ForegroundColor Gray
        Write-Host "    switchInterval     : 单位=秒（渲染器内部 x1000）" -ForegroundColor Gray
        Write-Host "    pictureSizeType    : 0=contain 留边完整显示 / 1=cover 裁剪铺满" -ForegroundColor Gray
        return $true
    } catch {
        Write-Err ("写配置失败：" + $_.Exception.Message)
        Write-Note "可改用 -ConfigPath 指向一个可写位置。"
        return $false
    }
}

# =====================================================================================
# 6. 调用注入器
# =====================================================================================

function Invoke-Patch {
    param(
        [string]$AsarPath
    )

    Write-Head "第 6 步 / 6：调用注入器改写 app.asar"

    if (-not (Confirm-Action -Question "确认对 app.asar 执行注入吗？")) { return $false }

    $psExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    if (-not (Test-Path -LiteralPath $psExe)) { $psExe = "powershell.exe" }

    $argList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $script:PatchScript, "-AsarPath", $AsarPath)
    if ($ConfigPath -ne "") { $argList += @("-ConfigPath", $ConfigPath) }
    if ($WhatIfPreference)  { $argList += "-DryRun" }

    Write-Info ("执行：" + $psExe + " " + ($argList -join " "))
    Write-Host ""

    $code = 1
    try {
        & $psExe @argList
        $code = $LASTEXITCODE
    } catch {
        Write-Err ("注入器执行异常：" + $_.Exception.Message)
        return $false
    }

    Write-Host ""
    if ($code -eq 0) { Write-Ok "注入完成。"; return $true }
    if ($code -eq 3) { Write-Ok "该 app.asar 已经注入过了，无需重复注入。"; return $true }
    Write-Err ("注入器返回非零退出码：" + $code)
    return $false
}

# =====================================================================================
# 7. 主流程
# =====================================================================================

function Test-IsAdmin {
    try {
        $id = [Security.Principal.WindowsIdentity]::GetCurrent()
        $pr = New-Object Security.Principal.WindowsPrincipal($id)
        return $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch { return $true }
}

function Invoke-SelfElevate {
    $argLine = '-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '"'
    if ($Uninstall) { $argLine += ' -Uninstall' }
    if ($SeewoDir)  { $argLine += ' -SeewoDir "' + $SeewoDir + '"' }
    if ($Force)     { $argLine += ' -Force' }

    Write-Host ""
    Write-Note "希沃管家通常装在 Program Files，写入 app.asar 需要管理员权限。"
    Write-Note "正在弹出 UAC 提权窗口，请点击「是」继续。"
    Write-Host ""
    try {
        Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList $argLine
    } catch {
        Write-Err ("提权失败：" + $_.Exception.Message)
        Write-Note "请手动右键 安装.bat -> 以管理员身份运行。"
    }
}

function Invoke-Install {
    Write-Banner

    if ($env:OS -eq "Windows_NT" -and -not (Test-IsAdmin)) {
        Invoke-SelfElevate
        return 0
    }

    if (-not $Force -and -not $WhatIfPreference) {
        Write-Host ""
        Write-Note "本工具会替换希沃管家的 resources\app.asar（注入式，不修改签名清单内的 DLL/exe）。"
        Write-Note "原文件会先备份为 app.asar.bak；任何时候都可用 卸载.bat 还原。"
        Write-Note "请自行确认使用场景合法合规，风险自担。"
        if (-not (Confirm-Action -Question "确认继续安装吗？")) { return 1 }
    }

    if (-not (Test-PatcherAvailable)) { return 1 }

    if (-not (Test-RepoLayout)) { return 1 }

    $dir = Resolve-SeewoDir
    if (-not $dir) {
        Write-Err "未能确定希沃管家安装目录，退出。"
        return 1
    }

    $asarPath = Join-Path $dir (Join-Path "resources" "app.asar")
    if (-not (Test-Path -LiteralPath $asarPath -PathType Leaf)) {
        Write-Err ("app.asar 不存在：" + $asarPath)
        return 1
    }
    Write-Ok ("app.asar 校验通过（" + (Get-Item -LiteralPath $asarPath).Length + " 字节）")

    $bak = Backup-Asar -AsarPath $asarPath
    if (-not $bak) { return 1 }

    $cfgTarget = $ConfigPath
    if ([string]::IsNullOrWhiteSpace($cfgTarget)) { $cfgTarget = $script:DefaultConfigPath }
    [void](Ensure-ConfigFile -Path $cfgTarget)

    $ok = Invoke-Patch -AsarPath $asarPath
    if (-not $ok) {
        Write-Note "注入未成功。官方文件仍可从备份还原：" + $bak
        return 1
    }

    Write-Head "完成"
    Write-Ok "注入完成。"
    Write-Host ""
    Write-Note "请【手动重启希沃管家】让改动生效（本脚本不会替你结束或重启进程）："
    Write-Host "    1) 托盘图标 -> 右键 -> 退出" -ForegroundColor Gray
    Write-Host "    2) 重新打开希沃管家" -ForegroundColor Gray
    Write-Host ""
    Write-Info ("备份文件：" + $bak + "  （请勿删除）")
    Write-Info ("配置文件：" + $cfgTarget)
    return 0
}

function Invoke-Uninstall {
    Write-Banner

    if ($env:OS -eq "Windows_NT" -and -not (Test-IsAdmin)) {
        Invoke-SelfElevate
        return 0
    }
    Write-Host ""
    Write-Note "卸载 = 用 app.asar.bak 覆盖回官方 app.asar。"

    $dir = $SeewoDir
    if ([string]::IsNullOrWhiteSpace($dir)) {
        $dir = Resolve-SeewoDir
    }
    if (-not $dir) {
        Write-Err "未能确定希沃管家安装目录，无法卸载。"
        return 1
    }

    $asarPath = Join-Path $dir (Join-Path "resources" "app.asar")
    $ok = Restore-Asar -AsarPath $asarPath
    if (-not $ok) { return 1 }

    Write-Head "完成"
    Write-Ok "已还原官方 app.asar。"
    Write-Note "请【手动重启希沃管家】让还原生效：托盘图标 -> 右键 -> 退出，再重新打开。"
    Write-Info ("备份仍保留：" + ($asarPath + ".bak") + "  可再次安装。")
    return 0
}

# ---- 入口 ----
$exitCode = 1
try {
    if ($Uninstall) {
        $exitCode = Invoke-Uninstall
    } else {
        $exitCode = Invoke-Install
    }
} catch {
    Write-Host ""
    Write-Err ("发生未处理的异常：" + $_.Exception.Message)
    Write-Host ("  位置：" + $_.InvocationInfo.PositionMessage) -ForegroundColor DarkGray
    $exitCode = 1
}

Stop-WithPause -Code $exitCode
