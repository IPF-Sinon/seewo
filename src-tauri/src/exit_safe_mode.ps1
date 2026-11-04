# 退出安全模式 —— 由 AuraScreensaver 生成
# 万一卡在安全模式，双击桌面上的批处理跑这个脚本即可恢复。
$NL = [Environment]::NewLine
Write-Host ''
Write-Host '正在关闭安全模式…' -ForegroundColor Cyan
try {
    & bcdedit.exe /deletevalue '{current}' safeboot | Out-Null
    Write-Host '  [OK] 安全模式已关闭' -ForegroundColor Green
} catch {
    Write-Host ('  [!!] 失败: ' + $_.Exception.Message) -ForegroundColor Red
}
# 顺手清掉待办标记，避免下次开机又被误触发
try {
    $p = Join-Path $env:APPDATA 'seewo\AuraScreensaver\pending-safe-action.txt'
    if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force }
} catch { }
Write-Host ''
Write-Host '电脑将在 5 秒后重启。' -ForegroundColor Cyan
Start-Sleep -Seconds 5
& shutdown.exe /r /t 0 /c 'AuraScreensaver: 退出安全模式'
