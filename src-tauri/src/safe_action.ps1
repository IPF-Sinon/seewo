# 安全模式动作脚本 —— 由 AuraScreensaver 生成
# ★ 这是一个**纯 PowerShell** 脚本：不依赖 WebView2、不依赖 GUI，
#   所以在安全模式下一定能跑（Tauri 界面在安全模式里往往起不来）。
param(
    [string]$Action = '',
    [string]$Root = ''
)
$ErrorActionPreference = 'Continue'
if (-not $Root) { $Root = Split-Path -Parent $MyInvocation.MyCommand.Path }

$NL = [Environment]::NewLine
function Say($m) { Write-Host $m }
function Ok($m)  { Write-Host "  [OK] $m" -ForegroundColor Green }
function Bad($m) { Write-Host "  [!!] $m" -ForegroundColor Red }

Say ''
Say '========================================='
Say '  希沃屏保配置 —— 安全模式动作'
Say '========================================='
Say ''

$patchScript = Join-Path $Root 'Patch-Asar.ps1'
$loaderPath  = Join-Path $Root 'loader.js'
$appDir      = Join-Path $env:APPDATA 'seewo\AuraScreensaver'
$pendingFile = Join-Path $appDir 'pending-safe-action.txt'

if (-not (Test-Path -LiteralPath $patchScript)) { Bad ('缺少 Patch-Asar.ps1: ' + $patchScript); Read-Host '按回车退出'; exit 1 }
if (-not (Test-Path -LiteralPath $loaderPath))  { Bad ('缺少 loader.js: ' + $loaderPath);   Read-Host '按回车退出'; exit 1 }

if (-not $Action) {
    if (Test-Path -LiteralPath $pendingFile) {
        $Action = ([System.IO.File]::ReadAllText($pendingFile)).Trim()
    }
}
if ($Action -ne 'uninstall') { $Action = 'install' }
Say ('动作：' + $Action)

# ---- 找希沃目录 ----
function Find-SeewoDir {
    $roots = @()
    foreach ($k in @('ProgramFiles(x86)', 'ProgramFiles')) {
        $v = [Environment]::GetEnvironmentVariable($k)
        if ($v) { $roots += $v }
    }
    foreach ($r in $roots) {
        $base = Join-Path $r 'Seewo\SeewoService'
        if (-not (Test-Path -LiteralPath $base)) { continue }
        $cands = @(Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue |
                   Where-Object { $_.Name -like 'SeewoService_*' } | Sort-Object Name -Descending)
        foreach ($c in $cands) {
            $a = Join-Path $c.FullName 'SeewoServiceAssistant\resources\app.asar'
            if (Test-Path -LiteralPath $a) { return (Join-Path $c.FullName 'SeewoServiceAssistant') }
        }
    }
    return $null
}

$seewo = Find-SeewoDir
if (-not $seewo) { Bad '没找到希沃安装目录'; Read-Host '按回车退出'; exit 1 }
$asar = Join-Path $seewo 'resources\app.asar'
Ok ('希沃目录: ' + $seewo)
Say ('  app.asar: ' + $asar)
Say ''

# ---- 执行 ----
$code = 0
try {
    if ($Action -eq 'uninstall') {
        Say '正在还原为官方版本…'
        & $patchScript -AsarPath $asar -Restore
        if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { $code = $LASTEXITCODE }
    } else {
        Say '正在注入…'
        & $patchScript -AsarPath $asar -LoaderPath $loaderPath
        if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { $code = $LASTEXITCODE }
    }
} catch {
    Bad ('执行失败: ' + $_.Exception.Message)
    $code = 1
}

if ($code -eq 0) { Ok '动作完成' } else { Bad '动作可能未完全成功，请查看上面的输出' }

# ---- 清理待办标记 ----
try { if (Test-Path -LiteralPath $pendingFile) { Remove-Item -LiteralPath $pendingFile -Force } } catch { }

# ---- 无论成败都关掉安全模式，别让用户卡在里面 ----
Say ''
Say '正在关闭安全模式…'
try { & bcdedit.exe /deletevalue '{current}' safeboot | Out-Null; Ok '安全模式已关闭' }
catch { Bad ('关闭安全模式失败，请手动双击桌面「退出安全模式.bat」: ' + $_.Exception.Message) }

Say ''
Say '电脑将在 8 秒后重启回正常模式。'
Say '（想取消：按 Ctrl+C，然后双击桌面「退出安全模式.bat」）'
Start-Sleep -Seconds 8
& shutdown.exe /r /t 0 /c 'AuraScreensaver: 完成，重启回正常模式'
