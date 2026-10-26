<#
  Build-Exe.ps1 —— 把「asar 函数库 + 目录定位 + 图形界面 + 加载器」打包成单个 .exe
  ============================================================================
  产物特性：
    - 单文件，双击即用，不需要 Node.js，也不需要用户懂 PowerShell
    - 内嵌加载器（base64），不依赖外部 tools\payload 文件
    - 自带 UAC 提权清单（-RequireAdmin），且程序内部再兜底自提权一次
    - 安装/卸载时自动结束并重启希沃管家

  依赖：PS2EXE 模块（仅构建期需要）
    Install-Module ps2exe -Force -Scope CurrentUser

  用法：
    .\Build-Exe.ps1 -OutputDir dist
#>

param(
    [string]$OutputDir = 'dist',
    [string]$ExeName = 'AuraScreensaver.exe'
)

$ErrorActionPreference = 'Stop'
$NL = [System.Environment]::NewLine

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot  = Split-Path -Parent (Split-Path -Parent $scriptDir)

$asarLibFile   = Join-Path $scriptDir 'AsarLib.ps1'
$locateFile    = Join-Path $scriptDir 'SeewoLocate.ps1'
$guiFile       = Join-Path $scriptDir 'ConfigGui.ps1'
$loaderFile    = Join-Path $repoRoot (Join-Path 'tools' (Join-Path 'payload' 'aura-screensaver-loader.js'))

foreach ($f in @($asarLibFile, $locateFile, $guiFile, $loaderFile)) {
    if (-not (Test-Path -LiteralPath $f)) { throw "缺少打包所需文件：$f" }
}

Write-Host '[*] 读取加载器…' -ForegroundColor Cyan
$loaderText = [System.IO.File]::ReadAllText($loaderFile, [System.Text.Encoding]::UTF8)
$loaderB64 = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($loaderText))
Write-Host ('    [OK] 加载器 ' + [math]::Round($loaderText.Length / 1KB, 1) + ' KB -> base64 ' + [math]::Round($loaderB64.Length / 1KB, 1) + ' KB') -ForegroundColor Green

function Read-Source {
    param([string]$Path, [string]$Label)
    $t = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
    $t = $t.TrimStart([char]0xFEFF)
    Write-Host ('    [OK] ' + $Label + ' ' + [math]::Round($t.Length / 1KB, 1) + ' KB') -ForegroundColor Green
    return $t
}

Write-Host '[*] 读取模块…' -ForegroundColor Cyan
$asarLib = Read-Source -Path $asarLibFile -Label 'AsarLib.ps1 '
$locate  = Read-Source -Path $locateFile  -Label 'SeewoLocate.ps1'
$gui     = Read-Source -Path $guiFile     -Label 'ConfigGui.ps1'

$sb = New-Object System.Text.StringBuilder
[void]$sb.Append('# AuraScreensaver 单文件版 —— 由 tools/ps/Build-Exe.ps1 自动生成，请勿手工编辑' + $NL)
[void]$sb.Append('# 组成：内嵌加载器 + asar 函数库 + 目录定位 + WinForms 界面' + $NL)
[void]$sb.Append('$script:InjectionVersion = ' + [char]39 + '1.7.0' + [char]39 + $NL)
[void]$sb.Append('$script:LoaderB64 = ' + "'" + $loaderB64 + "'" + $NL)
[void]$sb.Append('$script:LoaderText = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($script:LoaderB64))' + $NL)
[void]$sb.Append('$script:DefaultConfigJson = ' + "'{""screensaverEnabled"":false,""lockCascadeOnClose"":false,""override"":null,""logLevel"":""info""}'" + $NL)
[void]$sb.Append($NL + '# ============================ asar 函数库 ============================' + $NL)
[void]$sb.Append($asarLib + $NL)
[void]$sb.Append($NL + '# ============================ 目录定位 ============================' + $NL)
[void]$sb.Append($locate + $NL)
[void]$sb.Append($NL + '# ============================ 图形界面 ============================' + $NL)
[void]$sb.Append($gui + $NL)

$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ('aura-exe-' + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
$tmpPs1 = Join-Path $tmpDir 'AuraScreensaver.ps1'
[System.IO.File]::WriteAllText($tmpPs1, $sb.ToString(), (New-Object System.Text.UTF8Encoding($true)))
Write-Host ('[*] 已生成合并脚本：' + [math]::Round($sb.Length / 1KB, 1) + ' KB') -ForegroundColor Cyan

# 语法自检：拼装错误必须在这里就发现
$errs = $null; $tokens = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($tmpPs1, [ref]$tokens, [ref]$errs)
if ($errs -and $errs.Count -gt 0) {
    foreach ($e in $errs) { Write-Host ('    语法错误 line ' + $e.Extent.StartLineNumber + ': ' + $e.Message) -ForegroundColor Red }
    throw '合并后的脚本有语法错误，已中止打包'
}
Write-Host '    [OK] 合并脚本语法检查通过' -ForegroundColor Green

if (-not (Get-Command Invoke-PS2EXE -ErrorAction SilentlyContinue)) {
    Write-Host '[*] 未检测到 PS2EXE，尝试安装…' -ForegroundColor Yellow
    Install-Module ps2exe -Force -Scope CurrentUser -AllowClobber -ErrorAction Stop
}

if (-not (Test-Path -LiteralPath $OutputDir)) { New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null }
$outFile = Join-Path (Resolve-Path $OutputDir).Path $ExeName

Write-Host '[*] 调用 PS2EXE 打包…' -ForegroundColor Cyan
$ps2exeParams = Get-Command Invoke-PS2EXE | Select-Object -ExpandProperty Parameters
$splat = @{
    InputFile    = $tmpPs1
    OutputFile   = $outFile
    NoConsole    = $true
    RequireAdmin = $true
    Title        = '希沃屏保配置'
    Description  = '关闭/深度配置希沃管家屏保（注入式）'
    Product      = 'AuraScreensaver'
    Version      = '1.7.0.0'
}
if ($ps2exeParams.ContainsKey('STA'))       { $splat['STA'] = $true }
if ($ps2exeParams.ContainsKey('SupportOS')) { $splat['SupportOS'] = $true }
if ($ps2exeParams.ContainsKey('x64'))       { $splat['x64'] = $true }

Invoke-PS2EXE @splat

Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue

if (Test-Path -LiteralPath $outFile) {
    $size = [math]::Round((Get-Item -LiteralPath $outFile).Length / 1KB, 1)
    Write-Host ''
    Write-Host ('打包成功：' + $outFile + '  (' + $size + ' KB)') -ForegroundColor Green
    exit 0
} else {
    throw 'PS2EXE 未生成输出文件'
}
