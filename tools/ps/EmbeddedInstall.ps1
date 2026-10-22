# ---------------------------------------------------------------------------
# 内嵌模式（仅在打包成 exe 时被包含进来）
#   exe 里没有外部脚本可调用，所以注入逻辑必须在进程内完成。
#   复用已实测通过的 asar 读写函数（Get-U32 / Read-AsarHeader / Get-AsarLeaves /
#   Get-EntryBytes / Get-PatchedMainJs / Save-Asar）。
#
# ★ 关于安装目录：真实布局是
#     C:\Program Files (x86)\Seewo\SeewoService\SeewoService_<版本号>\SeewoServiceAssistant\
#   其中 <版本号> 每次升级都会变，所以**必须用通配符搜索**，不能写死路径。
#   本解析器按可靠性依次尝试：
#     1) 正在运行的 SeewoServiceAssistant 进程的 exe 路径（最准）
#     2) Program Files / Program Files (x86) 下的通配符搜索
#     3) 其它盘符 + 注册表卸载项
#     4) 都不行就弹文件夹选择框，让用户手动指定
# ---------------------------------------------------------------------------

$script:EmbeddedMode = $true

function Get-SeewoDirCandidates {
    $list = New-Object System.Collections.ArrayList

    # ---- 1) 运行中的进程 ----
    try {
        foreach ($proc in @(Get-Process -Name 'SeewoServiceAssistant' -ErrorAction SilentlyContinue)) {
            $exePath = $null
            try { $exePath = $proc.Path } catch { $exePath = $null }
            if ($exePath) { [void]$list.Add((Split-Path -Parent $exePath)) }
        }
    } catch { }

    # ---- 2) 常见安装位置（通配符，含版本号）----
    $pf = [Environment]::GetEnvironmentVariable('ProgramFiles')
    $pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')

    $patterns = New-Object System.Collections.ArrayList
    foreach ($base in @($pf86, $pf)) {
        if (-not $base) { continue }
        [void]$patterns.Add((Join-Path $base 'Seewo\SeewoService\SeewoService_*\SeewoServiceAssistant'))
        [void]$patterns.Add((Join-Path $base 'Seewo\SeewoServiceAssistant'))
        [void]$patterns.Add((Join-Path $base 'Seewo\SeewoService\SeewoServiceAssistant'))
    }
    foreach ($driveLetter in @('D:', 'E:', 'F:')) {
        [void]$patterns.Add(($driveLetter + '\Program Files (x86)\Seewo\SeewoService\SeewoService_*\SeewoServiceAssistant'))
        [void]$patterns.Add(($driveLetter + '\Program Files\Seewo\SeewoService\SeewoService_*\SeewoServiceAssistant'))
    }

    foreach ($pat in $patterns) {
        try {
            $hits = @(Get-Item -Path $pat -ErrorAction SilentlyContinue)
            foreach ($hit in $hits) {
                if ($hit -and (Test-Path -LiteralPath $hit.FullName -PathType Container)) {
                    [void]$list.Add($hit.FullName)
                }
            }
        } catch { }
    }

    # ---- 3) 注册表卸载项 ----
    $regRoots = @(
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    foreach ($root in $regRoots) {
        try {
            foreach ($it in @(Get-ItemProperty -Path $root -ErrorAction SilentlyContinue)) {
                $name = [string]$it.DisplayName
                if ($name -notlike '*希沃*' -and $name -notlike '*Seewo*') { continue }

                $loc = [string]$it.InstallLocation
                if ($loc -ne '') { [void]$list.Add($loc) }

                $icon = [string]$it.DisplayIcon
                if ($icon -ne '') {
                    $exe = ($icon -split ',')[0]
                    $exe = $exe.Trim('"').Trim()
                    if ($exe -and (Test-Path -LiteralPath $exe -PathType Leaf)) {
                        [void]$list.Add((Split-Path -Parent $exe))
                    }
                }
            }
        } catch { }
    }

    return ,$list
}

# 把一个候选目录「归一化」到真正包含 resources\app.asar 的那一层
function ConvertTo-SeewoDir {
    param([string]$Candidate)

    if ([string]::IsNullOrWhiteSpace($Candidate)) { return $null }

    $probes = @(
        $Candidate,
        (Join-Path $Candidate 'SeewoServiceAssistant'),
        (Join-Path $Candidate 'resources')   # 用户可能直接选到了 resources
    )

    foreach ($p in $probes) {
        $asar = Join-Path $p 'resources\app.asar'
        if (Test-Path -LiteralPath $asar -PathType Leaf) { return $p }
    }

    # ★ 深度探测：用户手动选择时可能选到了上层目录（例如 SeewoService_xxx 或 Seewo），
    #   这里向下找 1~2 层，看哪一层里面有 resourcesapp.asar。
    try {
        $deep = @(Get-ChildItem -LiteralPath $Candidate -Directory -Recurse -Depth 4 -ErrorAction SilentlyContinue)
        foreach ($d in $deep) {
            if (Test-Path -LiteralPath (Join-Path $d.FullName 'resources\app.asar') -PathType Leaf) {
                return $d.FullName
            }
        }
    } catch { }

    return $null
}

function Resolve-SeewoDirEmbedded {
    $candidates = Get-SeewoDirCandidates
    foreach ($c in $candidates) {
        $ok = ConvertTo-SeewoDir -Candidate $c
        if ($ok) { return $ok }
    }
    return $null
}

function Select-SeewoDirManually {
    $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
    $dlg.Description = '请选择希沃管家安装目录（里面有 SeewoServiceAssistant.exe 和 resources 文件夹的那一层）'
    $dlg.ShowNewFolderButton = $false

    if ($dlg.ShowDialog() -ne 'OK') { return $null }

    $picked = $dlg.SelectedPath
    $ok = ConvertTo-SeewoDir -Candidate $picked
    if ($ok) { return $ok }

    [System.Windows.Forms.MessageBox]::Show(
        ('这个目录里没有 resources\app.asar：' + $script:NL + $picked + $script:NL + $script:NL +
         '正确的那一层目录里应该能看到 SeewoServiceAssistant.exe 和 resources 文件夹。'),
        '目录不对', 'OK', 'Warning') | Out-Null
    return $null
}

function Invoke-EmbeddedInstall {
    param([switch]$UninstallNow)

    Set-Status '正在定位希沃管家安装目录…'
    $dir = Resolve-SeewoDirEmbedded

    if (-not $dir) {
        $ans = [System.Windows.Forms.MessageBox]::Show(
            ('没能自动找到希沃管家安装目录。' + $script:NL + $script:NL +
             '通常它在：' + $script:NL +
             'C:\Program Files (x86)\Seewo\SeewoService\SeewoService_<版本号>\SeewoServiceAssistant' + $script:NL + $script:NL +
             '要手动选择目录吗？（取消则放弃本次操作）'),
            '找不到希沃管家', 'OKCancel', 'Warning')

        if ($ans -ne 'OK') { Set-Status '已取消。'; return }

        $dir = Select-SeewoDirManually
        if (-not $dir) { Set-Status '没有选择有效目录，已取消。'; return }
    }

    $asar = Join-Path $dir 'resources\app.asar'
    $bak = $asar + '.bak'
    Set-Status ('安装目录：' + $dir)

    if ($UninstallNow) {
        if (-not (Test-Path -LiteralPath $bak)) {
            [System.Windows.Forms.MessageBox]::Show(
                ('没有找到备份文件，无法还原：' + $script:NL + $bak + $script:NL + $script:NL +
                 '说明这台设备还没用本工具注入过。'),
                '无法还原', 'OK', 'Warning') | Out-Null
            return
        }
        try {
            Copy-Item -LiteralPath $bak -Destination $asar -Force
            Set-Status '已还原官方 app.asar，请重启希沃管家。'
            [System.Windows.Forms.MessageBox]::Show(
                ('已还原官方 app.asar。' + $script:NL + $script:NL + '请重启希沃管家让还原生效。'),
                '还原完成', 'OK', 'Information') | Out-Null
        } catch {
            [System.Windows.Forms.MessageBox]::Show(
                ('还原失败：' + $_.Exception.Message + $script:NL + $script:NL +
                 '如果管家正在运行，请先退出管家再试。'),
                '错误', 'OK', 'Error') | Out-Null
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
            [System.Windows.Forms.MessageBox]::Show(
                ('这个 app.asar 里没有 main.js，不像是希沃管家的包。' + $script:NL + $asar),
                '结构不符', 'OK', 'Warning') | Out-Null
            return
        }

        $mainText = [System.Text.Encoding]::UTF8.GetString((Get-EntryBytes $info $mainLeaf))

        if ($mainText.Contains($script:MarkBegin)) {
            Set-Status '该文件已经注入过了，无需重复注入。'
            [System.Windows.Forms.MessageBox]::Show(
                ('检测到已经注入过，无需重复操作。' + $script:NL + $script:NL +
                 '如需重新注入，请先点「卸载还原」。'),
                '无需重复注入', 'OK', 'Information') | Out-Null
            return
        }

        Set-Status '正在备份 app.asar…'
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
             '目录：' + $dir + $script:NL +
             '备份：' + $bak + $script:NL + $script:NL +
             '下一步：重启希沃管家（托盘图标 -> 右键 -> 退出，再重新打开），' + $script:NL +
             '然后回到本界面点「立即预览屏保」验证。'),
            '注入成功', 'OK', 'Information') | Out-Null
    } catch {
        [System.Windows.Forms.MessageBox]::Show(
            ('注入失败：' + $_.Exception.Message + $script:NL + $script:NL +
             '若管家正在运行，请先退出管家再试（文件被占用会写不进去）。' + $script:NL +
             '之前已创建过备份的话，可用「卸载还原」恢复官方文件。'),
            '注入失败', 'OK', 'Error') | Out-Null
        Set-Status ('注入失败：' + $_.Exception.Message)
    }
}
