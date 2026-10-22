<#
  AsarLib.ps1 —— app.asar 读写函数库（纯 PowerShell）
  ============================================================================
  被这些地方共用：
    - tools/ps/Patch-Asar.ps1   命令行注入器
    - tools/ps/ConfigGui.ps1    图形界面（脚本模式）
    - 打包成 exe 时由 Build-Exe.ps1 直接内联

  ★ asar 结构（实测）：[16字节头][JSON头][0-3字节对齐填充][数据区]
      头 uint32[0] = 4
      头 uint32[1] = jsonSize + 10
      头 uint32[2] = jsonSize + 6
      头 uint32[3] = jsonSize
      dataOffset   = ceil((16 + jsonSize) / 4) * 4
      每个条目的 offset 是相对 dataOffset 的字符串，size 是数字
#>

$script:MarkBegin = '/* ===== aura-screensaver injection BEGIN ===== */'
$script:MarkEnd   = '/* ===== aura-screensaver injection END ===== */'

if (-not $script:NL) { $script:NL = [System.Environment]::NewLine }

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
