@echo off
chcp 65001 >nul 2>nul
setlocal
title 希沃屏保深度配置工具 - 卸载还原

rem ============================================================================
rem  卸载.bat  --  双击启动器（从 app.asar.bak 还原官方 app.asar）
rem
rem  ★ 纪律：本文件绝对不内联任何 PowerShell 代码，只用 -File 调用外部 .ps1。
rem  原因见 安装.bat 顶部注释（CMD 会抢先解析 % 和引号）。
rem ============================================================================

set "PS1=%~dp0AuraScreensaver.ps1"

if not exist "%PS1%" (
    echo.
    echo   [错误] 找不到同目录下的 AuraScreensaver.ps1
    echo   期望路径: %PS1%
    echo.
    pause
    exit /b 1
)

echo.
echo   即将从 app.asar.bak 还原官方 app.asar（会丢弃注入后的改动）。
echo   脚本内还会再确认一次。
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0AuraScreensaver.ps1" -Uninstall

set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
    echo.
    echo   [注意] 脚本以退出码 %RC% 结束，请查看上方输出。
)

endlocal & exit /b %RC%
