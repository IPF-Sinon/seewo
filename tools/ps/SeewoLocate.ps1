<#
  SeewoLocate.ps1 —— 定位希沃管家安装目录（纯 PowerShell）
  ============================================================================
  真实布局：
    C:\Program Files (x86)\Seewo\SeewoService\SeewoService_<版本号>\SeewoServiceAssistant\
      ├─ SeewoServiceAssistant.exe
      └─ \resources\app.asar

  ★ <版本号> 每次升级都会变，所以必须用通配符搜索，不能写死路径。

  定位顺序：
    1. 正在运行的管家进程的真实 exe 路径（最准）
    2. Program Files / Program Files (x86) 通配符搜索
    3. 其它盘符 D:/E:/F: 通配符搜索
    4. 注册表卸载项的 InstallLocation / DisplayIcon
    5. 以上都不行 → 弹文件夹选择框手动指定（上/下各容忍 4 层）
#>

if (-not $script:NL) { $script:NL = [System.Environment]::NewLine }

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
