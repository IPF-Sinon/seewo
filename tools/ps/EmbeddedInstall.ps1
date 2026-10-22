# ---------------------------------------------------------------------------
# 内嵌模式（仅在打包成 exe 时被包含进来）
#   exe 里没有外部文件可调用，所以注入逻辑必须在进程内完成。
#   这里复用 Tools 里已实测通过的 asar 读写函数（Get-U32 / Read-AsarHeader /
#   Get-AsarLeaves / Get-EntryBytes / Get-PatchedMainJs / Save-Asar）。
# ---------------------------------------------------------------------------

$script:EmbeddedMode = $true

function Resolve-SeewoDirEmbedded {
    $candidates = @()

    $pf = [Environment]::GetEnvironmentVariable('ProgramFiles')
    $pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
    $local = [Environment]::GetEnvironmentVariable('LOCALAPPDATA')

    if ($pf)    { $candidates += (Join-Path $pf 'Seewo\SeewoServiceAssistant') }
    if ($pf86)  { $candidates += (Join-Path $pf86 'Seewo\SeewoServiceAssistant') }
    if ($local) { $candidates += (Join-Path $local 'Programs\Seewo\SeewoServiceAssistant') }

    $regRoots = @(
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    foreach ($root in $regRoots) {
        try {
            $items = Get-ItemProperty -Path $root -ErrorAction SilentlyContinue
            foreach ($it in $items) {
                $name = [string]$it.DisplayName
                if ($name -like '*希沃*' -or $name -like '*Seewo*') {
                    $loc = [string]$it.InstallLocation
                    if ($loc -ne '') { $candidates += $loc }
                }
            }
        } catch { }
    }

    foreach ($c in $candidates) {
        if ([string]::IsNullOrWhiteSpace($c)) { continue }
        $asar = Join-Path $c 'resources\app.asar'
        if (Test-Path -LiteralPath $asar -PathType Leaf) { return $c }
    }
    return $null
}

function Invoke-EmbeddedInstall {
    param([switch]$UninstallNow)

    $dir = Resolve-SeewoDirEmbedded
    if (-not $dir) {
        [System.Windows.Forms.MessageBox]::Show(
            ('未能自动定位希沃管家安装目录。' + $script:NL + $script:NL +
             '请确认已安装希沃管家。若装在非标准位置，可改用 scripts 目录下的安装.bat 并手动指定目录。'),
            '找不到希沃管家', 'OK', 'Warning') | Out-Null
        return
    }

    $asar = Join-Path $dir 'resources\app.asar'
    $bak = $asar + '.bak'

    if ($UninstallNow) {
        if (-not (Test-Path -LiteralPath $bak)) {
            [System.Windows.Forms.MessageBox]::Show('没有找到备份文件，无法还原：' + $script:NL + $bak, '无法还原', 'OK', 'Warning') | Out-Null
            return
        }
        try {
            Copy-Item -LiteralPath $bak -Destination $asar -Force
            Set-Status '已还原官方 app.asar，请重启希沃管家。'
            [System.Windows.Forms.MessageBox]::Show('已还原官方 app.asar。' + $script:NL + $script:NL + '请重启希沃管家让还原生效。', '还原完成', 'OK', 'Information') | Out-Null
        } catch {
            [System.Windows.Forms.MessageBox]::Show('还原失败：' + $_.Exception.Message, '错误', 'OK', 'Error') | Out-Null
        }
        return
    }

    try {
        Set-Status '正在读取 app.asar…'
        $info = Read-AsarHeader $asar
        $leaves = Get-AsarLeaves $info.Header

        $mainLeaf = $null
        foreach ($l in $leaves) { if ($l.Rel -eq 'main.js') { $mainLeaf = $l } }
        if ($null -eq $mainLeaf) {
            [System.Windows.Forms.MessageBox]::Show('这个 app.asar 里没有 main.js，不像是希沃管家的包。', '结构不符', 'OK', 'Warning') | Out-Null
            return
        }

        $mainText = [System.Text.Encoding]::UTF8.GetString((Get-EntryBytes $info $mainLeaf))

        if ($mainText.Contains($script:MarkBegin)) {
            Set-Status '该文件已经注入过了，无需重复注入。'
            [System.Windows.Forms.MessageBox]::Show('检测到已经注入过（存在注入标记），无需重复操作。' + $script:NL + $script:NL + '如需重新注入，请先「卸载还原」。', '无需重复注入', 'OK', 'Information') | Out-Null
            return
        }

        Set-Status '正在备份…'
        if (-not (Test-Path -LiteralPath $bak)) {
            Copy-Item -LiteralPath $asar -Destination $bak -Force
        }

        Set-Status '正在生成注入代码…'
        $res = Get-PatchedMainJs -Source $mainText -LoaderText $script:LoaderText -ConfigJson $script:DefaultConfigJson

        Set-Status '正在重建 app.asar…'
        $newBytes = [System.Text.Encoding]::UTF8.GetBytes($res.Text)
        Save-Asar -Info $info -MainBytes $newBytes -OutPath $asar

        Set-Status '注入完成，请重启希沃管家。'
        [System.Windows.Forms.MessageBox]::Show(
            ('注入完成！' + $script:NL + $script:NL +
             '备份：' + $bak + $script:NL +
             '目录：' + $dir + $script:NL + $script:NL +
             '下一步：请手动重启希沃管家（托盘图标 -> 右键 -> 退出，再重新打开），然后点「立即预览屏保」验证。'),
            '注入成功', 'OK', 'Information') | Out-Null
    } catch {
        [System.Windows.Forms.MessageBox]::Show(
            ('注入失败：' + $_.Exception.Message + $script:NL + $script:NL +
             '若之前已创建备份，可用「卸载还原」恢复官方文件。'),
            '注入失败', 'OK', 'Error') | Out-Null
        Set-Status ('注入失败：' + $_.Exception.Message)
    }
}
