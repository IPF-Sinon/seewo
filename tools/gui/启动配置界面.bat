@echo off
chcp 65001 >nul 2>nul
setlocal
title 希沃屏保配置中心

rem ============================================================================
rem  启动配置界面.bat  --  双击启动图形配置界面
rem
rem  ★ 纪律：本文件绝对不内联任何 PowerShell 代码。
rem  历史故障根因：.bat 内联 PS 时 CMD 会先解析，把 % 当环境变量起始符，
rem  导致传给 PS 的源码残缺，报 "Missing ']' after array index expression"。
rem
rem  ★ 浏览器打开方式：由 server.js 的 --open 参数用 rundll32 打开，
rem  不用 cmd /c start（引号在部分区域设置下会错），也不用 PowerShell。
rem ============================================================================

cd /d "%~dp0"
set "SRV=%~dp0server.js"

if not exist "%SRV%" (
    echo.
    echo   [错误] 找不到 server.js
    echo   期望路径: %SRV%
    echo   请确认 tools\gui 目录完整，不要单独拷走本文件。
    echo.
    pause
    exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo   [错误] 未检测到 Node.js
    echo.
    echo   请先安装 Node.js LTS 版本:
    echo     https://nodejs.org/zh-cn/download
    echo   安装时请勾选 Add to PATH，装完重新打开本窗口。
    echo.
    pause
    exit /b 1
)

echo ============================================================
echo   希沃屏保配置中心
echo.
echo   浏览器会自动打开配置界面。
echo   若没有自动打开，请手动访问: http://127.0.0.1:8899
echo.
echo   ★ 关闭本窗口即停止服务（配置已保存，不影响已注入的功能）。
echo ============================================================
echo.

node "%SRV%" --open

echo.
echo   服务已停止。
echo.
pause
endlocal & exit /b 0