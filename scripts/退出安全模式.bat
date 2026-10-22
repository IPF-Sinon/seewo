@echo off
chcp 65001 >nul 2>nul
setlocal
title 退出安全模式

rem ============================================================================
rem  退出安全模式.bat  --  急救：把电脑从「安全模式启动」改回正常启动
rem
rem  什么时候用：如果 AuraScreensaver 安排了「重启进安全模式自动安装」，
rem  但中途出错卡在安全模式，双击本文件即可恢复。
rem ============================================================================

echo 当前启动配置：
bcdedit /enum {current} | findstr /i "safeboot identifier description"
echo.

echo 正在恢复正常启动...
bcdedit /deletevalue {current} safeboot
if errorlevel 1 (
    echo   [提示] 删除失败，可能本来就不在安全模式。
) else (
    echo   已恢复正常启动。
)

echo 清理自动安装任务...
reg delete "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce" /v AuraScreensaver_SafeInstall /f >nul 2>nul
echo   已清理。

echo.
echo   完成。请重启电脑。
echo.
pause
endlocal & exit /b 0