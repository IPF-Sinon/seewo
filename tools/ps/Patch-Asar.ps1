<#
  Patch-Asar.ps1 —— 把「关闭屏保 / 深度配置 / 手动预览」注入希沃管家 app.asar
  ============================================================================
  ★ 纯 PowerShell 实现，不需要 Node.js。
    兼容 Windows PowerShell 5.1（系统自带）与 PowerShell 7+。

  技术依据（全部来自对真实 app.asar 的实测，非推测）：
    asar 结构 = [16 字节头][JSON 头][0-3 字节对齐填充][文件数据区]
      头第 1 个 uint32 = 4（常量）
      头第 2 个 uint32 = jsonSize + 10
      头第 3 个 uint32 = jsonSize + 6
      头第 4 个 uint32 = jsonSize
      dataOffset = ceil((16 + jsonSize) / 4) * 4
      每个文件条目的 offset 是相对 dataOffset 的字符串，size 是数字

  用法：
    .\Patch-Asar.ps1 -AsarPath "C:\...\resources\app.asar"
    .\Patch-Asar.ps1 -AsarPath "..." -DryRun
    .\Patch-Asar.ps1 -AsarPath "..." -Restore
    .\Patch-Asar.ps1 -AsarPath "..." -OutPath "D:\test.asar"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$AsarPath,
    [string]$LoaderPath,
    [string]$ConfigPath,
    [string]$OutPath,
    [switch]$Restore,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$NL = [System.Environment]::NewLine

function Write-Step { param($m) Write-Host "[*] $m" -ForegroundColor Cyan }
function Write-Ok   { param($m) Write-Host "    [OK] $m" -ForegroundColor Green }
function Write-Note { param($m) Write-Host "    $m" -ForegroundColor Gray }
function Write-Warn2{ param($m) Write-Host "    [!] $m" -ForegroundColor Yellow }
function Write-Err2 { param($m) Write-Host "    [错误] $m" -ForegroundColor Red }

$script:ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $LoaderPath) {
    $LoaderPath = Join-Path $script:ScriptDir (Join-Path '..' (Join-Path 'payload' 'aura-screensaver-loader.js'))
}

$script:InjectionVersion = '1.15.0'
$script:MarkBegin = '/* ===== aura-screensaver injection BEGIN ===== */'
$script:MarkEnd   = '/* ===== aura-screensaver injection END ===== */'

function Get-U32 {
    param([byte[]]$Bytes, [int]$Offset)
    return [System.BitConverter]::ToUInt32($Bytes, $Offset)
}

function Read-AsarHeader {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) { throw "文件不存在: $Path" }
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 16) { throw "文件只有 $($bytes.Length) 字节，不是合法 asar" }

    $magic = Get-U32 $bytes 0
    $jsonSize = Get-U32 $bytes 12
    if ($jsonSize -le 0 -or $jsonSize -gt 67108864) { throw "asar 头部长度非法: jsonSize=$jsonSize" }
    if ((16 + $jsonSize) -gt $bytes.Length) { throw "asar 头部越界: jsonSize=$jsonSize，文件 $($bytes.Length) 字节" }

    $json = [System.Text.Encoding]::UTF8.GetString($bytes, 16, $jsonSize)
    try { $header = $json | ConvertFrom-Json }
    catch { throw "asar 头部 JSON 解析失败（不是标准 asar？）: $($_.Exception.Message)" }

    $dataOffset = [int]([math]::Ceiling((16 + $jsonSize) / 4.0) * 4)

    return [pscustomobject]@{
        Path       = $Path
        Bytes      = $bytes
        JsonSize   = $jsonSize
        DataOffset = $dataOffset
        Header     = $header
        Magic      = $magic
    }
}

function Get-AsarLeaves {
    param($Header)

    $list = New-Object System.Collections.ArrayList

    function Walk($node, $prefix) {
        $filesProp = $node.PSObject.Properties['files']
        if ($null -eq $filesProp) { return }
        foreach ($p in $filesProp.Value.PSObject.Properties) {
            $name = $p.Name
            $child = $p.Value
            if ($prefix) { $rel = $prefix + '/' + $name } else { $rel = $name }

            if ($null -ne $child.PSObject.Properties['files']) {
                Walk $child $rel
            } else {
                $isUnpacked = $false
                $up = $child.PSObject.Properties['unpacked']
                if ($null -ne $up -and $up.Value -eq $true) { $isUnpacked = $true }

                [void]$list.Add([pscustomobject]@{
                    Node     = $child
                    Rel      = $rel
                    Offset   = [int64]$child.offset
                    Size     = [int64]$child.size
                    Unpacked = $isUnpacked
                })
            }
        }
    }

    Walk $Header ''
    return ,$list
}

function Get-EntryBytes {
    param($Info, $Leaf)

    if ($Leaf.Unpacked) { throw "本版本不支持 unpacked 条目: $($Leaf.Rel)" }
    $start = $Info.DataOffset + $Leaf.Offset
    $end = $start + $Leaf.Size
    if ($end -gt $Info.Bytes.Length) { throw "条目 $($Leaf.Rel) 数据越界（offset=$($Leaf.Offset) size=$($Leaf.Size)）" }

    $buf = New-Object byte[] $Leaf.Size
    [Array]::Copy($Info.Bytes, $start, $buf, 0, $Leaf.Size)
    return $buf
}

function Get-PatchedMainJs {
    param([string]$Source, [string]$LoaderText, [string]$ConfigJson)

    $re = [regex]'n\.p="",n\(n\.s=(\d+)\)\}\(\['
    $m = $re.Match($Source)
    if (-not $m.Success) {
        throw '找不到 bootstrap 锚点（n.p="",n(n.s=N)}([）。可能是新版本结构变化，已安全放弃，未修改任何文件。'
    }
    $entryId = $m.Groups[1].Value

    if (-not [regex]::IsMatch($Source, '\]\);\s*$')) {
        throw 'main.js 末尾不是 "]);" 结构，追加代码可能破坏语法，已安全放弃。'
    }

    $hasModuleTable = $Source.Contains('n.m=e')
    $hasModuleCache = $Source.Contains('n.c=t')

    $guardedEntry = 'global.__AURA_REQ__=n,' +
        '(function(){' +
        'try{return n(n.s=' + $entryId + ');}' +
        'catch(__auraEntryErr){' +
        'try{setTimeout(function(){throw __auraEntryErr;},0);}catch(e){}' +
        'global.__AURA_ENTRY_ERROR__=__auraEntryErr;' +
        'return undefined;' +
        '}' +
        '}())'

    $inset = 'n.p="",' + $guardedEntry + '}(['
    $patched = $Source.Substring(0, $m.Index) + $inset + $Source.Substring($m.Index + $m.Length)

    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append($NL + $script:MarkBegin + $NL)
    [void]$sb.Append('// 由 tools/ps/Patch-Asar.ps1 自动生成 —— 请勿手工编辑（重跑补丁器即可更新）' + $NL)
    [void]$sb.Append('// 注入时间: ' + (Get-Date).ToString('o') + $NL)
    [void]$sb.Append('// 注入版本: ' + $script:InjectionVersion + $NL)
    [void]$sb.Append('// 能力: (a) 关闭屏保  (b) 自定义图集/停留时长/适配模式/图文  (c) 切断 close->startLock 级联  (d) 手动预览' + $NL)
    [void]$sb.Append('try {' + $NL)
    [void]$sb.Append('  globalThis.__AURA_INLINE_CONFIG__ = ' + $ConfigJson + ';' + $NL)
    [void]$sb.Append('} catch (e) { /* 内嵌配置写入失败不影响加载器 */ }' + $NL)
    [void]$sb.Append($LoaderText + $NL)
    [void]$sb.Append('/* 兜底重试：上面 IIFE 若因任何原因没装上，这里在 next tick 再试一次（幂等） */' + $NL)
    [void]$sb.Append('try {' + $NL)
    [void]$sb.Append('  var __auraRetry = function () {' + $NL)
    [void]$sb.Append('    try {' + $NL)
    [void]$sb.Append('      if (!(globalThis.__AURA_SCREENSAVER__ && globalThis.__AURA_SCREENSAVER__.installed)) {' + $NL)
    [void]$sb.Append('        if (typeof globalThis.__AURA_BOOT__ === "function") { globalThis.__AURA_BOOT__(true); }' + $NL)
    [void]$sb.Append('      }' + $NL)
    [void]$sb.Append('    } catch (e) { /* 重试失败也绝不能影响官方进程 */ }' + $NL)
    [void]$sb.Append('  };' + $NL)
    [void]$sb.Append('  if (typeof setImmediate === "function") setImmediate(__auraRetry); else setTimeout(__auraRetry, 0);' + $NL)
    [void]$sb.Append('} catch (e) { /* ignore */ }' + $NL)
    [void]$sb.Append($script:MarkEnd + $NL)

    $patched = $patched + $sb.ToString()

    return [pscustomobject]@{
        Text           = $patched
        EntryId        = $entryId
        AnchorIndex    = $m.Index
        HasModuleTable = $hasModuleTable
        HasModuleCache = $hasModuleCache
        DeltaLength    = $patched.Length - $Source.Length
    }
}

function Save-Asar {
    param($Info, [byte[]]$MainBytes, [string]$OutPath, [string]$MainRel = 'main.js')

    $leaves = Get-AsarLeaves $Info.Header

    $found = $false
    foreach ($leaf in $leaves) { if ($leaf.Rel -eq $MainRel) { $found = $true } }
    if (-not $found) { throw "asar 里没有 $MainRel，结构异常" }

    $ordered = $leaves | Sort-Object -Property Offset

    $ms = New-Object System.IO.MemoryStream
    $cursor = [int64]0

    foreach ($leaf in $ordered) {
        if ($leaf.Unpacked) {
            Write-Warn2 "跳过 unpacked 条目（保持原样）: $($leaf.Rel)"
            continue
        }

        if ($leaf.Rel -eq $MainRel) {
            $data = $MainBytes
        } else {
            $data = Get-EntryBytes $Info $leaf
        }

        $leaf.Node.size = [int64]$data.Length
        $leaf.Node.offset = ([int64]$cursor).ToString()

        $ms.Write($data, 0, $data.Length)
        $cursor += $data.Length
    }

    $blob = $ms.ToArray()
    $ms.Dispose()

    $json = $Info.Header | ConvertTo-Json -Depth 100 -Compress
    $jsonBytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $jsonSize = $jsonBytes.Length
    $dataOffset = [int]([math]::Ceiling((16 + $jsonSize) / 4.0) * 4)

    $out = New-Object byte[] ($dataOffset + $blob.Length)

    [Array]::Copy([System.BitConverter]::GetBytes([uint32]4), 0, $out, 0, 4)
    [Array]::Copy([System.BitConverter]::GetBytes([uint32]($jsonSize + 10)), 0, $out, 4, 4)
    [Array]::Copy([System.BitConverter]::GetBytes([uint32]($jsonSize + 6)), 0, $out, 8, 4)
    [Array]::Copy([System.BitConverter]::GetBytes([uint32]$jsonSize), 0, $out, 12, 4)
    [Array]::Copy($jsonBytes, 0, $out, 16, $jsonSize)
    [Array]::Copy($blob, 0, $out, $dataOffset, $blob.Length)

    $dir = Split-Path -Parent $OutPath
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [System.IO.File]::WriteAllBytes($OutPath, $out)

    return [pscustomobject]@{
        Bytes      = $out.Length
        JsonSize   = $jsonSize
        DataOffset = $dataOffset
        BlobSize   = $blob.Length
    }
}

function Test-IsAdmin {
    try {
        $id = [Security.Principal.WindowsIdentity]::GetCurrent()
        $p = New-Object Security.Principal.WindowsPrincipal($id)
        return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch { return $true }
}

function Test-CanWriteTo {
    param([string]$Path)
    try {
        $dir = Split-Path -Parent $Path
        if (-not $dir) { $dir = '.' }
        if (-not (Test-Path -LiteralPath $dir)) { return $false }
        $probe = Join-Path $dir ('.aura-write-probe-' + [System.Guid]::NewGuid().ToString('N') + '.tmp')
        [System.IO.File]::WriteAllText($probe, 'x')
        Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
        return $true
    } catch { return $false }
}

function Invoke-Elevated {
    param([string]$AsarPath, [string]$LoaderPath, [string]$ConfigPath, [string]$OutPath)

    $argLine = '-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -AsarPath "' + $AsarPath + '"'
    if ($LoaderPath) { $argLine = $argLine + ' -LoaderPath "' + $LoaderPath + '"' }
    if ($ConfigPath) { $argLine = $argLine + ' -ConfigPath "' + $ConfigPath + '"' }
    if ($OutPath)    { $argLine = $argLine + ' -OutPath "' + $OutPath + '"' }

    Write-Host ''
    Write-Warn2 '需要管理员权限才能写入 Program Files。'
    Write-Note  '正在弹出 UAC 提权窗口，请在弹窗中点击「是」。'
    Write-Host ''
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argLine
}

function Invoke-Main {
    Write-Host ''
    Write-Host '========================================' -ForegroundColor White
    Write-Host '  希沃屏保注入器（纯 PowerShell 版）' -ForegroundColor White
    Write-Host '  无需安装 Node.js' -ForegroundColor DarkGray
    Write-Host '========================================' -ForegroundColor White
    $modeText = '实际写入'
    if ($DryRun) { $modeText = 'DRY-RUN（不写任何文件）' }
    Write-Host ('  模式: ' + $modeText) -ForegroundColor Gray
    Write-Host ''

    $fullAsar = [System.IO.Path]::GetFullPath($AsarPath)
    $bak = $fullAsar + '.bak'

    if (-not (Test-Path -LiteralPath $fullAsar)) {
        Write-Err2 "找不到 app.asar: $fullAsar"
        return 2
    }

    if ($Restore) {
        Write-Step '从备份还原官方 app.asar'
        if (-not (Test-Path -LiteralPath $bak)) {
            Write-Err2 "找不到备份: $bak"
            Write-Note '只有曾经安装过（注入过）才会有 .bak 文件。'
            return 2
        }
        if ($DryRun) {
            Write-Note "DRY-RUN：将用备份覆盖 $fullAsar"
            return 0
        }
        if (-not (Test-CanWriteTo $fullAsar)) {
            if ($env:OS -eq 'Windows_NT') { Invoke-Elevated -AsarPath $fullAsar; return 0 }
            throw "没有写入权限: $fullAsar"
        }
        Copy-Item -LiteralPath $bak -Destination $fullAsar -Force
        Write-Ok "已还原: $fullAsar"
        Write-Note "备份仍保留: $bak"
        return 0
    }

    Write-Step "读取 asar: $fullAsar"
    $info = Read-AsarHeader $fullAsar
    Write-Ok  ('大小 ' + [math]::Round($info.Bytes.Length / 1MB, 2) + ' MB')
    Write-Note "jsonSize=$($info.JsonSize)  dataOffset=$($info.DataOffset)"

    $leaves = Get-AsarLeaves $info.Header
    Write-Ok "条目数: $($leaves.Count)"

    $mainLeaf = $null
    foreach ($l in $leaves) { if ($l.Rel -eq 'main.js') { $mainLeaf = $l } }
    if ($null -eq $mainLeaf) { throw 'asar 里没有 main.js，这不像希沃管家的包。' }

    $mainBytes = Get-EntryBytes $info $mainLeaf
    $mainText = [System.Text.Encoding]::UTF8.GetString($mainBytes)
    Write-Ok ('main.js: ' + [math]::Round($mainBytes.Length / 1KB, 1) + ' KB')

    if ($mainText.Contains($script:MarkBegin)) {
        Write-Warn2 '检测到已存在的注入标记 —— 这个文件已经打过补丁了。'
        Write-Note  '如需重新注入：先执行 -Restore 还原，再重新运行本脚本。'
        return 3
    }

    Write-Step '读取加载器'
    $loaderFull = [System.IO.Path]::GetFullPath($LoaderPath)
    if (-not (Test-Path -LiteralPath $loaderFull)) {
        throw "找不到加载器文件: $loaderFull"
    }
    $loaderText = [System.IO.File]::ReadAllText($loaderFull, [System.Text.Encoding]::UTF8)
    Write-Ok ('加载器 ' + [math]::Round($loaderText.Length / 1KB, 1) + ' KB')

    if ($ConfigPath -and (Test-Path -LiteralPath $ConfigPath)) {
        $cfgJson = [System.IO.File]::ReadAllText($ConfigPath, [System.Text.Encoding]::UTF8)
        $parsed = $cfgJson | ConvertFrom-Json
        $cfgJson = $parsed | ConvertTo-Json -Depth 20 -Compress
        Write-Ok "内嵌配置来自: $ConfigPath"
    } else {
        $cfgJson = '{"screensaverEnabled":false,"lockCascadeOnClose":false,"override":null,"logLevel":"info"}'
        Write-Note '使用默认内嵌配置（屏保默认关闭，之后可在图形界面里修改）'
    }

    Write-Step '分析锚点并生成注入代码'
    $res = Get-PatchedMainJs -Source $mainText -LoaderText $loaderText -ConfigJson $cfgJson
    Write-Ok "锚点A @$($res.AnchorIndex)，入口模块 id=$($res.EntryId)"
    Write-Ok '锚点B 文件末尾以 "]);" 收尾（合法追加位）'
    if (-not $res.HasModuleTable) { Write-Warn2 '未找到 n.m=e（模块表）—— 结构可能与预期不同' }
    if (-not $res.HasModuleCache) { Write-Warn2 '未找到 n.c=t（模块缓存）—— 结构可能与预期不同' }
    Write-Ok ('main.js: ' + [math]::Round($mainText.Length / 1KB, 1) + ' KB -> ' + [math]::Round($res.Text.Length / 1KB, 1) + ' KB (+' + [math]::Round($res.DeltaLength / 1KB, 1) + ' KB)')

    $targetOut = $fullAsar
    if ($OutPath) { $targetOut = [System.IO.Path]::GetFullPath($OutPath) }

    if ($DryRun) {
        Write-Step 'DRY-RUN 计划摘要'
        Write-Note "输出: $targetOut"
        Write-Note "备份: $bak"
        Write-Host ''
        Write-Host 'DRY-RUN 完成：未修改任何文件。' -ForegroundColor Yellow
        return 0
    }

    if (-not (Test-CanWriteTo $targetOut)) {
        if ($env:OS -eq 'Windows_NT') {
            Invoke-Elevated -AsarPath $fullAsar -LoaderPath $loaderFull -ConfigPath $ConfigPath -OutPath $OutPath
            return 0
        }
        throw "没有写入权限: $targetOut"
    }

    if ($targetOut -eq $fullAsar) {
        Write-Step '备份官方 app.asar'
        if (Test-Path -LiteralPath $bak) {
            Write-Ok "备份已存在，保留不覆盖: $bak"
        } else {
            Copy-Item -LiteralPath $fullAsar -Destination $bak -Force
            Write-Ok "已备份: $bak"
        }
    }

    Write-Step '重建 asar'
    $newMainBytes = [System.Text.Encoding]::UTF8.GetBytes($res.Text)
    $tmpOut = $targetOut + '.tmp'
    $saved = Save-Asar -Info $info -MainBytes $newMainBytes -OutPath $tmpOut

    $verify = Read-AsarHeader $tmpOut
    $vLeaves = Get-AsarLeaves $verify.Header
    $vMain = $null
    foreach ($l in $vLeaves) { if ($l.Rel -eq 'main.js') { $vMain = $l } }
    if ($null -eq $vMain) {
        Remove-Item -LiteralPath $tmpOut -Force -ErrorAction SilentlyContinue
        throw '自检失败：重建后找不到 main.js'
    }
    $vText = [System.Text.Encoding]::UTF8.GetString((Get-EntryBytes $verify $vMain))
    if (-not $vText.Contains($script:MarkBegin)) {
        Remove-Item -LiteralPath $tmpOut -Force -ErrorAction SilentlyContinue
        throw '自检失败：重建后 main.js 里没有注入标记'
    }
    if ($vLeaves.Count -ne $leaves.Count) {
        Remove-Item -LiteralPath $tmpOut -Force -ErrorAction SilentlyContinue
        throw "自检失败：条目数从 $($leaves.Count) 变成 $($vLeaves.Count)"
    }
    Write-Ok "自检通过：$($vLeaves.Count) 个条目，main.js 含注入标记"

    Move-Item -LiteralPath $tmpOut -Destination $targetOut -Force
    Write-Ok ('已写出: ' + $targetOut + ' (' + [math]::Round($saved.Bytes / 1MB, 2) + ' MB)')

    Write-Host ''
    Write-Host '注入完成。' -ForegroundColor Green
    Write-Host ('  还原方式: Patch-Asar.ps1 -AsarPath "' + $fullAsar + '" -Restore') -ForegroundColor Gray
    Write-Host '  下一步: 重启希沃管家让注入生效。' -ForegroundColor Gray
    return 0
}

try {
    exit (Invoke-Main)
} catch {
    Write-Host ''
    Write-Err2 $_.Exception.Message
    Write-Host ''
    Write-Host '已中止。' -ForegroundColor Yellow
    exit 1
}
