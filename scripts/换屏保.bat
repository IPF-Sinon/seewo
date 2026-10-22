@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title 希沃屏保 - 图片替换工具（纯 CMD 稳定版）

rem ============================================================
rem  希沃屏保图片替换工具 — 纯 CMD 实现
rem
rem  设计说明（针对之前 PowerShell 内联方案的失败原因）：
rem    .bat 里用 ^ 续行内嵌 PowerShell 时，CMD 会先解析 % 和引号，
rem    导致 $sourceFiles[$i % $sourceFiles.Count] 里的 % 被吞掉，
rem    引发 "Missing ']' after array index expression"。
rem    本脚本完全不调用 PowerShell，因此不存在转义问题。
rem
rem  依据：屏保图片目录 %APPDATA%\seewo\SeewoAbility\screen_saver
rem        是集控下发的无后缀图片文件（渲染器按 imageList 顺序读取）。
rem ============================================================

set "targetDir=%APPDATA%seewoSeewoAbilityscreen_saver"
set "sourceDir=%~dp0my_screensavers"

echo ============================================================
echo   希沃屏保 - 图片替换工具
echo ============================================================
echo.

rem ---------- 1. 检查屏保目录 ----------
if not exist "%targetDir%" (
    echo [错误] 找不到希沃屏保目录：
    echo        %targetDir%
    echo.
    echo 请确认本机安装了希沃管家，且屏保功能曾被集控下发过一次。
    goto :end
)

rem ---------- 2. 检查/创建图片源目录，无图则等待 ----------
:check_images
if not exist "%sourceDir%" mkdir "%sourceDir%" >nul 2>&1

set "hasImg="
for %%F in ("%sourceDir%*.jpg" "%sourceDir%*.jpeg" "%sourceDir%*.png") do (
    if exist "%%~fF" set "hasImg=1"
)

if not defined hasImg (
    cls
    echo ============================================================
    echo   [提示] 未检测到图片文件
    echo ------------------------------------------------------------
    echo   请把新图片（仅 jpg / jpeg / png）复制到：
    echo     %sourceDir%
    echo.
    echo   建议尺寸 1920x1080（16:9），否则全屏可能变形或留黑边。
    echo ------------------------------------------------------------
    echo   放好后按任意键继续（无需重开脚本）...
    echo ============================================================
    pause >nul
    goto :check_images
)

echo [1/4] 已检测到图片，准备开始...
echo.

rem ---------- 3. 备份原目录 ----------
rem 时间串去空格（%time% 在个位数小时会带前导空格，会让目录名非法）
set "ts=%date:~0,4%%date:~5,2%%date:~8,2%_%time:~0,2%%time:~3,2%%time:~6,2%"
set "ts=%ts: =0%"
set "backupDir=%targetDir%..screen_saver_backup_%ts%"

echo [2/4] 正在备份原图到：
echo        %backupDir%
xcopy "%targetDir%" "%backupDir%" /E /I /H /Y >nul
if errorlevel 1 (
    echo [警告] 备份可能未完全成功，请检查后再继续。
) else (
    echo        备份完成。
)
echo.

rem ---------- 4. 收集源图片，按序循环覆盖 ----------
echo [3/4] 正在替换图片...

set /a imgCount=0
for /f "delims=" %%A in ('dir /b /a-d "%sourceDir%*.jpg" "%sourceDir%*.jpeg" "%sourceDir%*.png" 2^>nul') do (
    set /a imgCount+=1
    set "img!imgCount!=%%A"
)

if !imgCount! equ 0 (
    echo [错误] 图片收集失败，请重试。
    goto :end
)

set /a idx=0
set /a replaced=0

for /f "delims=" %%B in ('dir /b /a-d "%targetDir%" 2^>nul') do (
    set /a idx+=1
    rem 计算本轮该用第几张图（1..imgCount）
    set /a m=idx %% imgCount
    if !m! equ 0 set /a m=imgCount

    rem 动态取变量：用 for 变量 %%I 承载 !m!，再拼出 !imgN!
    for %%I in (!m!) do set "cur=!img%%I!"

    if defined cur (
        copy /y "%sourceDir%!cur!" "%targetDir%%%B" >nul 2>&1
        if not errorlevel 1 (
            set /a replaced+=1
            echo    - %%B  ^<- !cur!
        ) else (
            echo    - %%B  替换失败
        )
    )
)

echo.
echo [4/4] 完成：共 !imgCount! 张图，替换了 !replaced! 个坑位。
echo.
echo 备份位置（如需还原，把里面的文件拷回原目录）：
echo   %backupDir%
echo.
echo 提示：重启希沃管家或重新触发一次屏保即可看到效果。

:end
echo.
pause
endlocal
