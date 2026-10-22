@echo off
chcp 65001 >nul
title 希沃屏保 - 图片替换工具（PowerShell 可靠版）

rem ============================================================
rem  备用方案：把 PowerShell 写进临时 .ps1 再执行。
rem
rem  为什么这样能行：
rem    之前失败的写法是在 .bat 里用 ^ 续行内联 PowerShell，
rem    CMD 会提前解析 % / 引号 / 括号，破坏传给 PS 的代码
rem    （典型报错：Missing ']' after array index expression）。
rem    改为「先写出 .ps1，再用 -File 执行」后，代码由 PS 自己解析，
rem    CMD 完全不参与，彻底避免转义问题。
rem
rem  ★ 关键约束（本文件严格遵守）：
rem    写入 .ps1 的每一行**都不含管道符 | 和百分号 %**。
rem    因为这两个字符在 .bat 的 echo 里需要转义（^| 和 %%），
rem    而 ^| 写进 .ps1 是无效语法、%% 又容易写错。
rem    因此下面用 Where-Object 的等价写法替代管道。
rem ============================================================

set "psFile=%~dp0_temp_replace.ps1"

echo 正在生成 PowerShell 脚本...

> "%psFile%" echo $ErrorActionPreference = 'Stop'
>>"%psFile%" echo $targetDir = Join-Path $env:APPDATA 'seewo\SeewoAbility\screen_saver'
>>"%psFile%" echo $sourceDir = Join-Path $PSScriptRoot 'my_screensavers'
>>"%psFile%" echo Write-Host '=== 希沃屏保 - 图片替换工具 ===' -ForegroundColor Cyan
>>"%psFile%" echo if (-not (Test-Path $targetDir)) { Write-Host '[错误] 找不到屏保目录:' $targetDir -ForegroundColor Red; Read-Host '按回车退出'; exit 1 }
>>"%psFile%" echo if (-not (Test-Path $sourceDir)) { New-Item -ItemType Directory -Path $sourceDir > $null }
>>"%psFile%" echo $exts = @('.jpg', '.jpeg', '.png')
>>"%psFile%" echo while ($true) {
>>"%psFile%" echo   $srcs = @(Get-ChildItem -Path $sourceDir -File -Include $exts -Recurse)
>>"%psFile%" echo   if ($srcs.Count -gt 0) { break }
>>"%psFile%" echo   Write-Host '[提示] 未检测到图片，请放入:' $sourceDir -ForegroundColor Yellow
>>"%psFile%" echo   Read-Host '放好后按回车继续'
>>"%psFile%" echo }
>>"%psFile%" echo $tgts = @(Get-ChildItem -Path $targetDir -File)
>>"%psFile%" echo $stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
>>"%psFile%" echo $backup = Join-Path (Split-Path $targetDir -Parent) ('screen_saver_backup_' + $stamp)
>>"%psFile%" echo Copy-Item -Path $targetDir -Destination $backup -Recurse -Force
>>"%psFile%" echo Write-Host ('[备份完成] ' + $backup) -ForegroundColor Green
>>"%psFile%" echo $i = 0
>>"%psFile%" echo foreach ($t in $tgts) {
>>"%psFile%" echo   $s = $srcs[$i - $srcs.Count * [math]::Floor($i / $srcs.Count)]
>>"%psFile%" echo   Copy-Item -Path $s.FullName -Destination $t.FullName -Force
>>"%psFile%" echo   Write-Host ('  - ' + $t.Name + '  <=  ' + $s.Name)
>>"%psFile%" echo   $i = $i + 1
>>"%psFile%" echo }
>>"%psFile%" echo Write-Host ('[完成] 共 ' + $srcs.Count + ' 张图，替换 ' + $tgts.Count + ' 个坑位') -ForegroundColor Green
>>"%psFile%" echo Read-Host '按回车退出'

echo 正在执行...
powershell -NoProfile -ExecutionPolicy Bypass -File "%psFile%"
del "%psFile%" >nul 2>&1
