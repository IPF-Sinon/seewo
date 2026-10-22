@echo off
chcp 65001 >nul 2>nul
setlocal
title 希沃屏保深度配置工具 - 安装

rem ============================================================================
rem  安装.bat  --  双击启动器
rem
rem  ★ 纪律：本文件绝对不内联任何 PowerShell 代码。
rem  历史故障根因：在 .bat 里用 ^ 续行内联 PowerShell 时，CMD 会先做自己的解析，
rem  把 % 当环境变量起始符、按 CMD 规则配对引号，导致传给 PS 的源码残缺，
rem  报出 "Missing ']' after array index expression" 等错误。
rem  因此这里只做一件事：用 -File 把参数原样交给同目录的 AuraScreensaver.ps1。
rem ============================================================================

set "PS1=%~dp0AuraScreensaver.ps1"

if not exist "%PS1%" (
    echo.
    echo   [错误] 找不到同目录下的 AuraScreensaver.ps1
    echo   期望路径: %PS1%
    echo   请确认 scripts 目录完整，不要把 安装.bat 单独拷走。
    echo.
    pause
    exit /b 1
)

set "PS_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS_EXE%" set "PS_EXE=powershell"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0AuraScreensaver.ps1"

set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
    echo.
    echo   [注意] 脚本以退出码 %RC% 结束，请查看上方输出。
)

endlocal & exit /b %RC%
