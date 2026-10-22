@echo off
chcp 65001 >nul 2>nul
setlocal
title 希沃屏保配置

rem ============================================================================
rem  配置屏保.bat  --  双击打开图形配置界面
rem
rem  ★ 不需要 Node.js：界面是 PowerShell + WinForms 实现的。
rem  ★ 不内联 PowerShell（历史故障：% 被 CMD 吃掉导致语法错误）。
rem ============================================================================

set "GUI=%~dp0..\tools\ps\ConfigGui.ps1"

if not exist "%GUI%" (
    echo.
    echo   [错误] 找不到配置界面脚本
    echo   期望路径: %GUI%
    echo   请确认 tools\ps 目录完整，不要只把 scripts 目录拷走。
    echo.
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%GUI%"

set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
    echo.
    echo   界面以退出码 %RC% 结束，请查看上方输出。
    pause
)

endlocal & exit /b %RC%