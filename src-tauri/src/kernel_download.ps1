$ErrorActionPreference = 'Stop'
$dir = $args[0]
if (-not $dir) { throw '缺少目标目录参数' }
if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$dir = (Resolve-Path -LiteralPath $dir).Path

$ver = '45.1.0'
try {
    $api = 'https://api.github.com/repos/electron/electron/releases/latest'
    foreach ($u in @($api, ('https://gh-proxy.com/' + $api), ('https://gh-proxy.org/' + $api))) {
        try {
            $j = Invoke-RestMethod -Uri $u -Headers @{ 'User-Agent' = 'AuraScreensaver' } -TimeoutSec 20
            if ($j.tag_name) { $ver = ([string]$j.tag_name).TrimStart('v'); break }
        } catch { }
    }
} catch { }
Set-Content -LiteralPath (Join-Path $dir 'download.version') -Value $ver -Encoding UTF8

$name = 'electron-v' + $ver + '-win32-x64.zip'
$direct = 'https://github.com/electron/electron/releases/download/v' + $ver + '/' + $name
$urls = @($direct, ('https://gh-proxy.com/' + $direct), ('https://gh-proxy.org/' + $direct))
$zip = Join-Path $dir 'download.zip'
Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue

$ok = $false
$lastErr = ''
foreach ($u in $urls) {
    try {
        # 先探总大小，供界面画进度条
        $total = 0
        try {
            $h = [System.Net.HttpWebRequest]::Create($u)
            $h.Method = 'HEAD'; $h.Timeout = 20000; $h.UserAgent = 'AuraScreensaver'
            $resp = $h.GetResponse(); $total = [int64]$resp.ContentLength; $resp.Close()
        } catch { }
        Set-Content -LiteralPath (Join-Path $dir 'download.total') -Value ([string]$total) -Encoding UTF8

        Invoke-WebRequest -Uri $u -OutFile $zip -UseBasicParsing -TimeoutSec 3600
        if (-not (Test-Path -LiteralPath $zip)) { $lastErr = '下载后没有文件'; continue }
        $len = (Get-Item -LiteralPath $zip).Length
        if ($len -lt 50MB) { $lastErr = '下载文件过小（' + [math]::Round($len/1MB,1) + 'MB），可能是失败页'; continue }

        Expand-Archive -LiteralPath $zip -DestinationPath $dir -Force
        Set-Content -LiteralPath (Join-Path $dir 'version.txt') -Value $ver -Encoding UTF8
        Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath (Join-Path $dir 'download.total') -Force -ErrorAction SilentlyContinue
        $ok = $true
        break
    } catch { $lastErr = $_.Exception.Message }
}

if (-not $ok) {
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
    throw ('所有下载源都失败了：' + $lastErr)
}
Write-Output ('内核 v' + $ver + ' 下载并解压完成')
