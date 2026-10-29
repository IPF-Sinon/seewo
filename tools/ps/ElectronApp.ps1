# ---------------------------------------------------------------------------
# 可选「新内核」：下载一份由我们自己控制的 Electron 运行时
#
#   为什么需要它：系统浏览器（Edge/Chrome）是独立进程，全屏时我们够不着它，
#   用户退不出来（实测 ESC/Alt+F4 之外没有可靠出口）。
#   下载的这份 Electron 里跑的是 **我们自己的 main.js**，窗口属于我们，
#   所以注入退出按钮、接管 ESC 全都有效。
#
#   体积：electron-v<ver>-win32-x64.zip 约 151MB，解压后约 250MB。
#   下载源：GitHub 直连失败时走 https://gh-proxy.com/ 代理。
# ---------------------------------------------------------------------------

$script:AuraKernelFallbackVersion = '45.1.0'
$script:AuraKernelProxy = 'https://gh-proxy.com/'
$script:KernelJobId = $null

function Get-AuraKernelDir {
    return (Join-Path $env:ProgramData 'seewo\AuraScreensaver\kernel')
}

function Get-AuraKernelInfo {
    $dir  = Get-AuraKernelDir
    $exe  = Join-Path $dir 'electron.exe'
    $main = Join-Path $dir 'resources\app\main.js'
    $verFile = Join-Path $dir 'version.txt'
    $ready = (Test-Path -LiteralPath $exe) -and (Test-Path -LiteralPath $main)
    $ver = ''
    if (Test-Path -LiteralPath $verFile) {
        try { $ver = ([System.IO.File]::ReadAllText($verFile)).Trim() } catch { }
    }
    $sizeMB = 0
    if (Test-Path -LiteralPath $dir) {
        try {
            $sum = (Get-ChildItem -LiteralPath $dir -Recurse -File -ErrorAction SilentlyContinue |
                    Measure-Object -Property Length -Sum).Sum
            if ($sum) { $sizeMB = [math]::Round($sum / 1MB, 1) }
        } catch { }
    }
    return @{ Ready = [bool]$ready; Version = $ver; Exe = $exe; Dir = $dir; SizeMB = $sizeMB }
}

function Get-AuraKernelLatestVersion {
    $api = 'https://api.github.com/repos/electron/electron/releases/latest'
    foreach ($u in @($api, ($script:AuraKernelProxy + $api))) {
        try {
            $r = Invoke-RestMethod -Uri $u -TimeoutSec 15 -Headers @{ 'User-Agent' = 'AuraScreensaver' }
            if ($r -and $r.tag_name) { return ([string]$r.tag_name).TrimStart('v') }
        } catch { }
    }
    return $script:AuraKernelFallbackVersion
}

function Get-AuraKernelDownloadUrls {
    param([string]$Version)
    $name = 'electron-v' + $Version + '-win32-x64.zip'
    $direct = 'https://github.com/electron/electron/releases/download/v' + $Version + '/' + $name
    return @($direct, ($script:AuraKernelProxy + $direct))
}

# 把包装程序（main.js / package.json）写进内核目录
function Write-AuraKernelApp {
    param([string]$Dir)

    $appDir = Join-Path $Dir 'resources\app'
    if (-not (Test-Path -LiteralPath $appDir)) {
        New-Item -ItemType Directory -Path $appDir -Force | Out-Null
    }

    $mainJs = $null; $pkgJson = $null
    if ($script:KernelMainJsB64) {
        $mainJs = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($script:KernelMainJsB64))
    }
    if ($script:KernelPkgB64) {
        $pkgJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($script:KernelPkgB64))
    }
    if (-not $mainJs -or -not $pkgJson) {
        # 开发环境（直接跑 .ps1）走源码目录
        $srcDir = Join-Path $PSScriptRoot '..\electron-app'
        if (-not $mainJs) {
            $p = Join-Path $srcDir 'main.js'
            if (Test-Path -LiteralPath $p) { $mainJs = [System.IO.File]::ReadAllText($p) }
        }
        if (-not $pkgJson) {
            $p = Join-Path $srcDir 'package.json'
            if (Test-Path -LiteralPath $p) { $pkgJson = [System.IO.File]::ReadAllText($p) }
        }
    }
    if (-not $mainJs) { throw '找不到打包程序 main.js（既无嵌入 base64，也无源码目录）' }

    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText((Join-Path $appDir 'main.js'), $mainJs, $enc)
    [System.IO.File]::WriteAllText((Join-Path $appDir 'package.json'), $pkgJson, $enc)
    Add-Log ('已写入内核包装程序: ' + $appDir)
}

# 后台任务：下载 + 解压（不阻塞界面）
function Start-AuraKernelDownload {
    param([string]$Version = '')

    if ($script:KernelJobId) {
        $old = Get-Job -Id $script:KernelJobId -ErrorAction SilentlyContinue
        if ($old -and $old.State -eq 'Running') { throw '已有下载任务在进行中' }
        try { Remove-Job -Id $script:KernelJobId -Force -ErrorAction SilentlyContinue } catch { }
        $script:KernelJobId = $null
    }

    if (-not $Version) { $Version = Get-AuraKernelLatestVersion }
    $dir  = Get-AuraKernelDir
    $urls = Get-AuraKernelDownloadUrls -Version $Version

    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    Write-AuraKernelApp -Dir $dir

    Add-Log ('开始下载内核 v' + $Version + '，共 ' + $urls.Count + ' 个源')
    $script:KernelJobId = (Start-Job -ScriptBlock {
        param($Dir, $Urls, $Version)
        try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('aura-kernel-' + [guid]::NewGuid().ToString('N') + '.zip')
        $err = ''
        foreach ($u in $Urls) {
            try {
                $wc = New-Object System.Net.WebClient
                $wc.Headers.Add('User-Agent', 'AuraScreensaver')
                Write-Output ('正在下载: ' + $u)
                $wc.DownloadFile($u, $tmp)
                $len = 0
                if (Test-Path -LiteralPath $tmp) { $len = (Get-Item -LiteralPath $tmp).Length }
                if ($len -lt 50MB) { $err = '下载文件过小（' + [math]::Round($len/1MB,1) + 'MB），可能是失败页'; continue }
                Write-Output ('下载完成 ' + [math]::Round($len/1MB,1) + 'MB，开始解压...')
                Expand-Archive -LiteralPath $tmp -DestinationPath $Dir -Force
                $enc = New-Object System.Text.UTF8Encoding($false)
                [System.IO.File]::WriteAllText((Join-Path $Dir 'version.txt'), $Version, $enc)
                Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
                return @{ Ok = $true; Err = ''; Version = $Version }
            } catch { $err = $_.Exception.Message }
        }
        try { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue } catch { }
        return @{ Ok = $false; Err = $err; Version = $Version }
    } -ArgumentList $dir, $urls, $Version).Id
}
