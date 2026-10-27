# ---------------------------------------------------------------------------
# Initialize-SingleInstance 单实例测试
#
#   ★ 关键：必须在**两个独立进程**里验证。
#     同一个进程里对同名互斥体再 WaitOne 会成功（互斥体对同线程可重入），
#     所以「同进程测第二句柄」是无效用例 —— 一开始就写错在这里。
#
#   本机实测（两个独立 pwsh）：
#     HOLDER created=True  got=True     <- 第一个进程拿到
#     CHECK  created=False got=False    <- 第二个进程立刻知道已有实例（未阻塞）
# ---------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'
$script:fail = 0

function Check {
    param([string]$Name, [scriptblock]$Body)
    try { & $Body; Write-Host ('  [ OK ] ' + $Name) }
    catch { $script:fail++; Write-Host ('  [FAIL] ' + $Name + ' -> ' + $_.Exception.Message) }
}

$gui = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'ConfigGui.ps1'), [System.Text.Encoding]::UTF8)
foreach ($fn in @('Show-AuraExistingWindow', 'Initialize-SingleInstance')) {
    $a = $gui.IndexOf('function ' + $fn + ' {')
    if ($a -lt 0) { Write-Host ('[FAIL] 找不到 ' + $fn); exit 1 }
    if ($fn -eq 'Show-AuraExistingWindow') {
        $e = $gui.IndexOf('function Initialize-SingleInstance {', $a)
        Invoke-Expression $gui.Substring($a, $e - $a)
    } else {
        $e = $gui.IndexOf('return $false', $a)
        $e = $gui.IndexOf('}', $e) + 1
        Invoke-Expression $gui.Substring($a, $e - $a)
    }
}

$pwsh = (Get-Process -Id $PID).Path
$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ('aura-si-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null

function Reset-Mutex {
    try { if ($null -ne $script:SingleInstanceMutex) { $script:SingleInstanceMutex.ReleaseMutex() } } catch { }
    try { if ($null -ne $script:SingleInstanceMutex) { $script:SingleInstanceMutex.Dispose() } } catch { }
    $script:SingleInstanceMutex = $null
}

$holder = Join-Path $tmpDir 'hold.ps1'
$holderOut = Join-Path $tmpDir 'hold.out'
@'
$created = $false
$m = New-Object System.Threading.Mutex($false, 'LocalAuraScreensaver_GUI', [ref]$created)
$got = $false
try { $got = $m.WaitOne(0) } catch { }
Write-Host ("HOLDER created=" + $created + " got=" + $got)
Start-Sleep -Seconds 12
'@ | Set-Content -LiteralPath $holder -Encoding UTF8

Write-Host 'Initialize-SingleInstance'

Check '无实例时第一个进程拿得到' {
    Reset-Mutex
    if (-not (Initialize-SingleInstance)) { throw '第一个实例竟然没拿到' }
}

Check '★ 已有实例（另一个进程持有）时，立刻返回 False 且不阻塞' {
    Reset-Mutex
    $p = Start-Process -FilePath $pwsh -ArgumentList @('-NoProfile', '-File', $holder) -PassThru -RedirectStandardOutput $holderOut -NoNewWindow
    try {
        $deadline = (Get-Date).AddSeconds(15)
        $ok = $false
        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 400
            if (Test-Path -LiteralPath $holderOut) {
                $txt = [System.IO.File]::ReadAllText($holderOut)
                if ($txt -match 'got=True') { $ok = $true; break }
            }
        }
        if (-not $ok) { throw '持有者进程没能拿到互斥体，测试无效' }

        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $r = Initialize-SingleInstance
        $sw.Stop()
        if ($r) { throw '第二个实例不该拿到' }
        if ($sw.Elapsed.TotalSeconds -gt 15) { throw ('阻塞了 ' + [math]::Round($sw.Elapsed.TotalSeconds,1) + ' 秒') }
        Write-Host ('        （耗时 ' + [math]::Round($sw.Elapsed.TotalMilliseconds) + ' ms，未阻塞）')
    } finally {
        try { if (-not $p.HasExited) { $p.Kill() } } catch { }
    }
}

Check '持有者退出后又能重新拿到' {
    Reset-Mutex
    Start-Sleep -Seconds 2
    if (-not (Initialize-SingleInstance)) { throw '持有者已退出，却还是拿不到' }
    Reset-Mutex
}

try { Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue } catch { }

Write-Host ''
if ($script:fail -gt 0) { Write-Host ('单实例测试失败 ' + $script:fail + ' 项'); exit 1 }
Write-Host '单实例测试全部通过'
exit 0
