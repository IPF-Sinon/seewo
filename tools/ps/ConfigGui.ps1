<#
  希沃屏保配置界面（纯 PowerShell + WinForms，无需 Node.js）
  ============================================================================
  设计原则（按用户要求）：
    - 界面简洁：未注入时**只有一个**「一键安装」按钮，其余全部隐藏
    - 注入成功后**才**显示配置菜单
    - 安装/卸载时**自动结束并重启**希沃管家，不需要用户手动去托盘退出
    - 安装后**验证加载器确实运行了**（看日志出现「命令桥已启动」）才算成功

  启动方式：双击 scripts\配置屏保.bat，或直接运行打包好的 exe
#>

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$ErrorActionPreference = 'Stop'

$script:NL = [Environment]::NewLine
$script:ConfigDir   = Join-Path $env:APPDATA (Join-Path 'seewo' 'AuraScreensaver')
$script:ConfigPath  = Join-Path $script:ConfigDir 'config.json'
$script:CommandPath = Join-Path $script:ConfigDir 'command.json'
$script:ResultPath  = Join-Path $script:ConfigDir 'command-result.json'
$script:LogPath     = Join-Path $script:ConfigDir 'aura-screensaver.log'
$script:Utf8NoBom   = New-Object System.Text.UTF8Encoding($false)
$script:HostNames   = @('SeewoServiceAssistant')

# ---------------------------------------------------------------------------
# 管理员权限（写入 Program Files 必需）
# ---------------------------------------------------------------------------

function Test-IsAdmin {
    try {
        $id = [Security.Principal.WindowsIdentity]::GetCurrent()
        $pr = New-Object Security.Principal.WindowsPrincipal($id)
        return $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch { return $true }
}

if ($env:OS -eq 'Windows_NT' -and -not (Test-IsAdmin)) {
    $relaunched = $false
    try {
        if ($PSCommandPath -and ($PSCommandPath -like '*.ps1')) {
            $argLine = '-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '"'
            Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argLine
            $relaunched = $true
        } else {
            $exePath = $null
            try { $exePath = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName } catch { }
            if ($exePath) { Start-Process -FilePath $exePath -Verb RunAs; $relaunched = $true }
        }
    } catch { $relaunched = $false }
    if ($relaunched) { exit 0 }
}

# 脚本模式下按需加载 asar 函数库（exe 模式已内联，文件不存在就跳过）
# 脚本模式下按需加载函数库；exe 模式这些文件不存在（已内联），全部跳过。
# 整段 try/catch：$PSScriptRoot 在编译后的 exe 里可能为空，不能让加载失败。
try {
    if ($PSScriptRoot) {
        $script:AsarLib = Join-Path $PSScriptRoot 'AsarLib.ps1'
        if (Test-Path -LiteralPath $script:AsarLib) { . $script:AsarLib }

        $script:LocateLib = Join-Path $PSScriptRoot 'SeewoLocate.ps1'
        if (Test-Path -LiteralPath $script:LocateLib) { . $script:LocateLib }

        if (-not $script:LoaderText) {
            $loaderCand = Join-Path $PSScriptRoot (Join-Path '..' (Join-Path 'payload' 'aura-screensaver-loader.js'))
            if (Test-Path -LiteralPath $loaderCand) {
                $script:LoaderText = [System.IO.File]::ReadAllText($loaderCand, [System.Text.Encoding]::UTF8)
            }
        }
    }
} catch { }

if (-not $script:NL) { $script:NL = [Environment]::NewLine }
if (-not $script:DefaultConfigJson) {
    $script:DefaultConfigJson = '{"screensaverEnabled":false,"lockCascadeOnClose":false,"override":null,"logLevel":"info"}'
}

# ---------------------------------------------------------------------------
# 配置读写
# ---------------------------------------------------------------------------

function Get-DefaultConfig {
    return [pscustomobject]@{
        screensaverEnabled = $true
        lockCascadeOnClose = $false
        allowManualClose   = $true
        override           = $null
        logLevel           = 'info'
        backupCount        = 3
    }
}

function Read-Config {
    if (-not (Test-Path -LiteralPath $script:ConfigPath)) { return Get-DefaultConfig }
    try {
        $raw = [System.IO.File]::ReadAllText($script:ConfigPath, [System.Text.Encoding]::UTF8)
        $o = $raw | ConvertFrom-Json
        if ($null -eq $o) { return Get-DefaultConfig }
        return $o
    } catch { return Get-DefaultConfig }
}

function Save-ConfigFile {
    param($Config)
    if (-not (Test-Path -LiteralPath $script:ConfigDir)) {
        New-Item -ItemType Directory -Path $script:ConfigDir -Force | Out-Null
    }
    $json = $Config | ConvertTo-Json -Depth 20
    $tmp = $script:ConfigPath + '.tmp'
    [System.IO.File]::WriteAllText($tmp, $json, $script:Utf8NoBom)
    if (Test-Path -LiteralPath $script:ConfigPath) {
        Copy-Item -LiteralPath $script:ConfigPath -Destination ($script:ConfigPath + '.bak') -Force
    }
    Move-Item -LiteralPath $tmp -Destination $script:ConfigPath -Force
}

# ---------------------------------------------------------------------------
# 管家进程控制
# ---------------------------------------------------------------------------

function Get-HostProcs {
    $all = @()
    foreach ($n in $script:HostNames) {
        $all += @(Get-Process -Name $n -ErrorAction SilentlyContinue)
    }
    return $all
}

function Stop-Host {
    $procs = Get-HostProcs
    if ($procs.Count -eq 0) { return }
    foreach ($p in $procs) {
        try {
            $p.Kill()
            [void]$p.WaitForExit(8000)
        } catch { }
    }
    for ($i = 0; $i -lt 20; $i++) {
        if ((Get-HostProcs).Count -eq 0) { break }
        Start-Sleep -Milliseconds 300
    }
}

function Start-Host {
    param([string]$Dir)
    $exe = Join-Path $Dir 'SeewoServiceAssistant.exe'
    if (-not (Test-Path -LiteralPath $exe)) { throw ('找不到 ' + $exe) }
    Start-Process -FilePath $exe -WorkingDirectory $Dir
    for ($i = 0; $i -lt 30; $i++) {
        if ((Get-HostProcs).Count -gt 0) { return $true }
        Start-Sleep -Milliseconds 400
    }
    return $false
}

# ---------------------------------------------------------------------------
# 注入状态检测
# ---------------------------------------------------------------------------

function Get-InjectionState {
    $st = [pscustomobject]@{
        Dir = $null; Asar = $null; AsarExists = $false; BakExists = $false
        Injected = $false; ProcessRunning = $false; CanCheck = $false; Error = $null
    }
    $st.ProcessRunning = ((Get-HostProcs).Count -gt 0)

    if (-not (Get-Command Resolve-SeewoDirEmbedded -ErrorAction SilentlyContinue)) { return $st }
    if (-not (Get-Command Read-AsarHeader -ErrorAction SilentlyContinue)) { return $st }

    try {
        $dir = Resolve-SeewoDirEmbedded
        if (-not $dir) { return $st }
        $st.Dir = $dir
        $asar = Join-Path $dir 'resources\app.asar'
        $st.Asar = $asar
        $st.AsarExists = Test-Path -LiteralPath $asar
        $st.BakExists = Test-Path -LiteralPath ($asar + '.bak')

        if ($st.AsarExists) {
            $info = Read-AsarHeader $asar
            $leaves = Get-AsarLeaves $info.Header
            $mainLeaf = $null
            foreach ($l in $leaves) { if ($l.Rel -eq 'main.js') { $mainLeaf = $l } }
            if ($null -ne $mainLeaf) {
                $txt = [System.Text.Encoding]::UTF8.GetString((Get-EntryBytes $info $mainLeaf))
                $st.Injected = $txt.Contains($script:MarkBegin)
            }
            $st.CanCheck = $true
        }
    } catch {
        $st.Error = $_.Exception.Message
    }
    return $st
}

# ---------------------------------------------------------------------------
# 预览（命令桥）
# ---------------------------------------------------------------------------

function Invoke-Preview {
    if (-not (Test-Path -LiteralPath $script:ConfigDir)) {
        New-Item -ItemType Directory -Path $script:ConfigDir -Force | Out-Null
    }
    $seq = [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
    $cmd = [pscustomobject]@{
        seq = $seq; cmd = 'preview'; args = [pscustomobject]@{}; at = (Get-Date).ToString('o')
    } | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText($script:CommandPath, $cmd, $script:Utf8NoBom)

    $deadline = (Get-Date).AddSeconds(5)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 250
        if (Test-Path -LiteralPath $script:ResultPath) {
            try {
                $r = [System.IO.File]::ReadAllText($script:ResultPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
                if ($null -ne $r -and [long]$r.seq -eq $seq) { return $r }
            } catch { }
        }
    }
    return $null
}

# ---------------------------------------------------------------------------
# 界面
# ---------------------------------------------------------------------------

$form = New-Object System.Windows.Forms.Form
$form.Text = '希沃屏保配置'
$form.Size = New-Object System.Drawing.Size(660, 730)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)

$lblStatus = New-Object System.Windows.Forms.Label
$lblStatus.Location = New-Object System.Drawing.Point(16, 12)
$lblStatus.Size = New-Object System.Drawing.Size(610, 86)
$lblStatus.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10)
$form.Controls.Add($lblStatus)

# ---- 未注入：唯一按钮 ----
$btnInstall = New-Object System.Windows.Forms.Button
$btnInstall.Text = '一键安装'
$btnInstall.Location = New-Object System.Drawing.Point(16, 108)
$btnInstall.Size = New-Object System.Drawing.Size(610, 52)
$btnInstall.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 12, [System.Drawing.FontStyle]::Bold)
$form.Controls.Add($btnInstall)

# ---- 已注入：配置面板 ----
$group = New-Object System.Windows.Forms.GroupBox
$group.Text = '屏保配置'
$group.Location = New-Object System.Drawing.Point(16, 104)
$group.Size = New-Object System.Drawing.Size(610, 486)
$group.Visible = $false
$form.Controls.Add($group)

$chkEnabled = New-Object System.Windows.Forms.CheckBox
$chkEnabled.Text = '启用屏保（关闭后，集控再下发也不会弹出）'
$chkEnabled.Location = New-Object System.Drawing.Point(14, 26)
$chkEnabled.Size = New-Object System.Drawing.Size(460, 22)
$group.Controls.Add($chkEnabled)

$chkLock = New-Object System.Windows.Forms.CheckBox
$chkLock.Text = '关闭屏保后自动锁屏（建议不勾）'
$chkLock.Location = New-Object System.Drawing.Point(14, 52)
$chkLock.Size = New-Object System.Drawing.Size(460, 22)
$group.Controls.Add($chkLock)

$chkOverride = New-Object System.Windows.Forms.CheckBox
$chkOverride.Text = '使用自定义图集（不勾选 = 沿用集控下发的图片与文案）'
$chkOverride.Location = New-Object System.Drawing.Point(14, 84)
$chkOverride.Size = New-Object System.Drawing.Size(540, 22)
$group.Controls.Add($chkOverride)

$lblSource = New-Object System.Windows.Forms.Label
$lblSource.Text = '素材来源'
$lblSource.Location = New-Object System.Drawing.Point(14, 116)
$lblSource.Size = New-Object System.Drawing.Size(70, 20)
$group.Controls.Add($lblSource)

$txtSource = New-Object System.Windows.Forms.TextBox
$txtSource.Location = New-Object System.Drawing.Point(90, 113)
$txtSource.Size = New-Object System.Drawing.Size(500, 24)
$group.Controls.Add($txtSource)

$lblInterval = New-Object System.Windows.Forms.Label
$lblInterval.Text = '切换间隔（秒）'
$lblInterval.Location = New-Object System.Drawing.Point(14, 150)
$lblInterval.Size = New-Object System.Drawing.Size(90, 20)
$group.Controls.Add($lblInterval)

$numInterval = New-Object System.Windows.Forms.NumericUpDown
$numInterval.Location = New-Object System.Drawing.Point(108, 147)
$numInterval.Size = New-Object System.Drawing.Size(80, 24)
$numInterval.Minimum = 1
$numInterval.Maximum = 3600
$numInterval.Value = 15
$group.Controls.Add($numInterval)

$lblFit = New-Object System.Windows.Forms.Label
$lblFit.Text = '图片适配'
$lblFit.Location = New-Object System.Drawing.Point(220, 150)
$lblFit.Size = New-Object System.Drawing.Size(60, 20)
$group.Controls.Add($lblFit)

$rbContain = New-Object System.Windows.Forms.RadioButton
$rbContain.Text = '留边完整显示'
$rbContain.Location = New-Object System.Drawing.Point(290, 148)
$rbContain.Size = New-Object System.Drawing.Size(120, 22)
$group.Controls.Add($rbContain)

$rbCover = New-Object System.Windows.Forms.RadioButton
$rbCover.Text = '裁剪铺满'
$rbCover.Location = New-Object System.Drawing.Point(420, 148)
$rbCover.Size = New-Object System.Drawing.Size(100, 22)
$group.Controls.Add($rbCover)

$lblImages = New-Object System.Windows.Forms.Label
$lblImages.Text = '图片列表（每行一个完整路径）'
$lblImages.Location = New-Object System.Drawing.Point(14, 184)
$lblImages.Size = New-Object System.Drawing.Size(300, 20)
$group.Controls.Add($lblImages)

$txtImages = New-Object System.Windows.Forms.TextBox
$txtImages.Location = New-Object System.Drawing.Point(14, 206)
$txtImages.Size = New-Object System.Drawing.Size(576, 96)
$txtImages.Multiline = $true
$txtImages.ScrollBars = 'Vertical'
$txtImages.AcceptsReturn = $true
$group.Controls.Add($txtImages)

$lblTexts = New-Object System.Windows.Forms.Label
$lblTexts.Text = '图文条目（每行：内容|出处，出处可省略）'
$lblTexts.Location = New-Object System.Drawing.Point(14, 310)
$lblTexts.Size = New-Object System.Drawing.Size(340, 20)
$group.Controls.Add($lblTexts)

$txtTexts = New-Object System.Windows.Forms.TextBox
$txtTexts.Location = New-Object System.Drawing.Point(14, 332)
$txtTexts.Size = New-Object System.Drawing.Size(576, 70)
$txtTexts.Multiline = $true
$txtTexts.ScrollBars = 'Vertical'
$txtTexts.AcceptsReturn = $true
$group.Controls.Add($txtTexts)

$lblTrans = New-Object System.Windows.Forms.Label
$lblTrans.Text = '转场效果（可选，每行一个 0-6；留空自动随机）'
$lblTrans.Location = New-Object System.Drawing.Point(14, 410)
$lblTrans.Size = New-Object System.Drawing.Size(400, 20)
$group.Controls.Add($lblTrans)

$txtTrans = New-Object System.Windows.Forms.TextBox
$txtTrans.Location = New-Object System.Drawing.Point(14, 432)
$txtTrans.Size = New-Object System.Drawing.Size(140, 24)
$group.Controls.Add($txtTrans)

# ---- 已注入：两个操作按钮 ----
$btnSavePreview = New-Object System.Windows.Forms.Button
$btnSavePreview.Text = '保存并预览'
$btnSavePreview.Location = New-Object System.Drawing.Point(16, 604)
$btnSavePreview.Size = New-Object System.Drawing.Size(300, 42)
$btnSavePreview.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10, [System.Drawing.FontStyle]::Bold)
$btnSavePreview.Visible = $false
$form.Controls.Add($btnSavePreview)

$btnUninstall = New-Object System.Windows.Forms.Button
$btnUninstall.Text = '卸载还原'
$btnUninstall.Location = New-Object System.Drawing.Point(330, 604)
$btnUninstall.Size = New-Object System.Drawing.Size(180, 42)
$btnUninstall.Visible = $false
$form.Controls.Add($btnUninstall)

$linkLog = New-Object System.Windows.Forms.LinkLabel
$linkLog.Text = '查看日志'
$linkLog.Location = New-Object System.Drawing.Point(522, 616)
$linkLog.Size = New-Object System.Drawing.Size(100, 20)
$linkLog.Visible = $false
$form.Controls.Add($linkLog)

function Set-Status {
    param([string]$Text)
    $lblStatus.Text = $Text
    [System.Windows.Forms.Application]::DoEvents()
}

function Enable-OverrideFields {
    $on = $chkOverride.Checked
    $txtSource.Enabled = $on
    $numInterval.Enabled = $on
    $rbContain.Enabled = $on
    $rbCover.Enabled = $on
    $txtImages.Enabled = $on
    $txtTexts.Enabled = $on
    $txtTrans.Enabled = $on
}

function Fill-Form {
    param($Cfg)
    $chkEnabled.Checked = ($Cfg.screensaverEnabled -ne $false)
    $chkLock.Checked = ($Cfg.lockCascadeOnClose -eq $true)

    $ov = $null
    if ($null -ne $Cfg.override) { $ov = $Cfg.override }
    $chkOverride.Checked = ($null -ne $ov)

    if ($null -ne $ov) {
        if ($null -ne $ov.materialSource) { $txtSource.Text = [string]$ov.materialSource } else { $txtSource.Text = '' }

        $si = 15
        if ($null -ne $ov.switchInterval) {
            $tmp = 0
            if ([int]::TryParse([string]$ov.switchInterval, [ref]$tmp) -and $tmp -gt 0) { $si = $tmp }
        }
        $numInterval.Value = $si

        $pst = 0
        if ($null -ne $ov.pictureSizeType -and [string]$ov.pictureSizeType -eq '1') { $pst = 1 }
        $rbContain.Checked = ($pst -eq 0)
        $rbCover.Checked = ($pst -eq 1)

        $imgLines = @()
        if ($null -ne $ov.imageList) { $imgLines = @($ov.imageList) }
        $txtImages.Text = ($imgLines -join $script:NL)

        $textLines = @()
        if ($null -ne $ov.textList) {
            foreach ($t in @($ov.textList)) {
                if ($null -eq $t) { continue }
                $line = [string]$t.content
                if ($null -ne $t.provenance -and [string]$t.provenance -ne '') {
                    $line = $line + '|' + [string]$t.provenance
                }
                $textLines += $line
            }
        }
        $txtTexts.Text = ($textLines -join $script:NL)

        $transText = ''
        if ($null -ne $ov.transitionList) { $transText = (@($ov.transitionList) -join ',') }
        $txtTrans.Text = $transText
    } else {
        $txtSource.Text = ''
        $numInterval.Value = 15
        $rbContain.Checked = $true
        $txtImages.Text = ''
        $txtTexts.Text = ''
        $txtTrans.Text = ''
    }
    Enable-OverrideFields
}

function Collect-Override {
    $images = @()
    foreach ($line in ($txtImages.Text -split '\r?\n')) {
        $v = $line.Trim()
        if ($v -ne '') { $images += $v }
    }

    $texts = @()
    foreach ($line in ($txtTexts.Text -split '\r?\n')) {
        $v = $line.Trim()
        if ($v -eq '') { continue }
        $parts = $v.Split('|')
        $item = [pscustomobject]@{ content = $parts[0].Trim() }
        if ($parts.Length -ge 2 -and $parts[1].Trim() -ne '') {
            $item | Add-Member -NotePropertyName provenance -NotePropertyValue $parts[1].Trim()
        }
        if ($item.content -ne '') { $texts += $item }
    }

    $trans = @()
    $transRaw = $txtTrans.Text.Trim()
    if ($transRaw -ne '') {
        foreach ($p in ($transRaw -split '[,;\s]+')) {
            if ($p -eq '') { continue }
            $n = 0
            if ([int]::TryParse($p, [ref]$n)) {
                if ($n -lt 0 -or $n -gt 6) { throw ('转场值必须是 0-6 的整数，发现：' + $p) }
                $trans += $n
            } else { throw ('转场值必须是整数，发现：' + $p) }
        }
        if ($trans.Count -ne $images.Count) {
            throw ('转场数量（' + $trans.Count + '）必须等于图片数量（' + $images.Count + '）')
        }
    }

    $psType = 0
    if ($rbCover.Checked) { $psType = 1 }

    $ov = [pscustomobject]@{
        materialSource = $txtSource.Text.Trim()
        switchInterval = [int]$numInterval.Value
        pictureSizeType = $psType
        imageList = $images
        textList = $texts
        transitionList = $null
    }
    if ($trans.Count -gt 0) { $ov.transitionList = $trans }
    return $ov
}

function Build-Config {
    $ov = $null
    if ($chkOverride.Checked) { $ov = Collect-Override }
    return [pscustomobject]@{
        screensaverEnabled = [bool]$chkEnabled.Checked
        lockCascadeOnClose = [bool]$chkLock.Checked
        allowManualClose = $true
        override = $ov
        logLevel = 'info'
        backupCount = 3
    }
}

# ---------------------------------------------------------------------------
# 状态切换
# ---------------------------------------------------------------------------

$script:State = $null
$script:FormLoaded = $false

function Refresh-UiState {
    param([switch]$Full)

    if ($Full -or $null -eq $script:State) { $script:State = Get-InjectionState }
    else { $script:State.ProcessRunning = ((Get-HostProcs).Count -gt 0) }

    $st = $script:State
    $procText = '未运行'
    if ($st.ProcessRunning) { $procText = '运行中' }

    if ($st.Injected) {
        $group.Visible = $true
        $btnInstall.Visible = $false
        $btnSavePreview.Visible = $true
        $btnUninstall.Visible = $true
        $linkLog.Visible = $true

        if (-not $script:FormLoaded) {
            try { Fill-Form -Cfg (Read-Config) } catch { }
            $script:FormLoaded = $true
        }

        $msg = '已注入 ✓  屏保行为由本工具控制'
        if ($st.Dir) { $msg += $script:NL + '安装目录：' + $st.Dir }
        $msg += $script:NL + '希沃管家：' + $procText
        Set-Status $msg
    } else {
        $group.Visible = $false
        $btnSavePreview.Visible = $false
        $btnUninstall.Visible = $false
        $linkLog.Visible = $false
        $btnInstall.Visible = $true

        if (-not $st.AsarExists) {
            if ($st.Error) {
                Set-Status ('未就绪：' + $st.Error + $script:NL + '可以点下面的按钮，手动选择安装目录。')
            } else {
                Set-Status ('尚未检测到希沃管家，或未找到 app.asar。' + $script:NL +
                    '点下面的按钮会自动定位并注入；找不到时会让你手动选目录。')
            }
        } else {
            $msg = '尚未安装（未注入）'
            if ($st.Dir) { $msg += $script:NL + '安装目录：' + $st.Dir }
            $msg += $script:NL + '希沃管家：' + $procText + '　点下面按钮一键安装。'
            Set-Status $msg
        }
    }
}

# ---------------------------------------------------------------------------
# 一键安装
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# 诊断日志（安装失败时把详细原因写文件，方便排查）
# ---------------------------------------------------------------------------

$script:LogDir = $script:ConfigDir
$script:InstallLog = $null
$script:ExeLog = $null

function Add-Log {
    param([string]$Message)
    $line = '[' + (Get-Date).ToString('HH:mm:ss') + '] ' + $Message
    foreach ($target in @($script:InstallLog, $script:ExeLog)) {
        if (-not $target) { continue }
        try {
            [System.IO.File]::AppendAllText($target, $line + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
        } catch { }
    }
}

function Initialize-InstallerLog {
    try {
        if (-not (Test-Path -LiteralPath $script:LogDir)) {
            New-Item -ItemType Directory -Path $script:LogDir -Force | Out-Null
        }
        $script:InstallLog = Join-Path $script:LogDir 'install.log'
    } catch { $script:InstallLog = $null }

    # 同时尝试写到程序所在目录（用户最容易找到的地方）
    try {
        $base = $null
        if ($PSCommandPath) { $base = Split-Path -Parent $PSCommandPath }
        if (-not $base) {
            try { $base = Split-Path -Parent ([System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName) } catch { }
        }
        if ($base) {
            $candidate = Join-Path $base 'AuraScreensaver-install.log'
            $probe = $candidate + '.probe'
            [System.IO.File]::WriteAllText($probe, 'x')
            Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
            $script:ExeLog = $candidate
        }
    } catch { }

    Add-Log ('==== 会话开始 ' + (Get-Date).ToString('s') + ' ====')
}

function Add-LogFacts {
    Add-Log ('管理员权限: ' + (Test-IsAdmin))
    try { Add-Log ('当前用户: ' + [System.Security.Principal.WindowsIdentity]::GetCurrent().Name) } catch { }
    try { Add-Log ('进程: ' + [System.Diagnostics.Process]::GetCurrentProcess().ProcessName) } catch { }
    Add-Log ('系统: ' + [Environment]::OSVersion.VersionString)
}

function Test-DirWritable {
    param([string]$Dir)
    try {
        $probe = Join-Path $Dir ('.aura-probe-' + [System.Guid]::NewGuid().ToString('N') + '.tmp')
        [System.IO.File]::WriteAllText($probe, 'x')
        Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
        return $true
    } catch {
        Add-Log ('写权限测试失败: ' + $Dir + ' -> ' + $_.Exception.Message)
        return $false
    }
}

# 目录 ACL 被收紧时，尝试拿回管理员写权限
# 注意：如果目录上有**显式 DENY**（常见于防篡改设计），单纯 /grant 是无效的
#       （Windows 里 deny 优先于 allow），必须 /reset 让它继承父目录权限。
function Try-RepairAcl {
    param([string]$Dir)

    Add-Log ('尝试修复 ACL: ' + $Dir)

    # 先把当前 ACL 记进日志，便于判断到底是不是权限问题
    try {
        $aclText = & icacls.exe $Dir 2>&1 | Out-String
        Add-Log ('当前 ACL:' + [Environment]::NewLine + $aclText.Trim())
    } catch { }

    try {
        & takeown.exe /F $Dir /A 2>&1 | Out-Null
        Add-Log ('takeown 退出码=' + $LASTEXITCODE)
    } catch { Add-Log ('takeown 异常: ' + $_.Exception.Message) }

    # /reset 让目录继承父目录权限 —— 这是清除显式 DENY 的关键一步
    try {
        & icacls.exe $Dir /reset 2>&1 | Out-Null
        Add-Log ('icacls /reset 退出码=' + $LASTEXITCODE)
    } catch { Add-Log ('icacls /reset 异常: ' + $_.Exception.Message) }

    try {
        & icacls.exe $Dir /grant '*S-1-5-32-544:(OI)(CI)F' 2>&1 | Out-Null
        Add-Log ('icacls /grant 退出码=' + $LASTEXITCODE)
    } catch { Add-Log ('icacls /grant 异常: ' + $_.Exception.Message) }

    $ok = Test-DirWritable -Dir $Dir
    Add-Log ('ACL 修复后是否可写: ' + $ok)
    return $ok
}

# 结束管家进程（连带任务栏工具），并检测是否被自动拉起
function Stop-HostForce {
    $names = @('SeewoServiceAssistant', 'ShowTaskBarTool')
    foreach ($n in $names) {
        foreach ($p in @(Get-Process -Name $n -ErrorAction SilentlyContinue)) {
            try {
                Add-Log ('结束进程 ' + $n + ' pid=' + $p.Id)
                $p.Kill()
                [void]$p.WaitForExit(8000)
            } catch { Add-Log ('结束失败 ' + $n + ': ' + $_.Exception.Message) }
        }
    }
    for ($i = 0; $i -lt 25; $i++) {
        if ((Get-HostProcs).Count -eq 0) { break }
        Start-Sleep -Milliseconds 300
    }
    Start-Sleep -Milliseconds 500
    if ((Get-HostProcs).Count -gt 0) {
        Add-Log '注意：检测到管家被自动重新拉起（这会让 app.asar 持续被占用）'
        return $false
    }
    return $true
}
# ---------------------------------------------------------------------------
# 希沃自我保护探测
#   ACL 明明给了 BUILTIN\Administrators (F) 完全控制，却连 takeown 都被拒绝，
#   说明写入是被内核过滤驱动拦掉的（常见于防篡改设计），不是普通权限问题。
# ---------------------------------------------------------------------------

function Add-ProtectionFacts {
    Add-Log '--- 希沃相关服务 ---'
    $found = 0
    try {
        $svcList = @(Get-CimInstance Win32_Service -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '(?i)seewo' -or $_.DisplayName -match '希沃|Seewo' })
        foreach ($s in $svcList) {
            $found++
            Add-Log ('服务: ' + $s.Name + ' | ' + $s.DisplayName + ' | 状态=' + $s.State + ' | 启动=' + $s.StartMode + ' | ' + $s.PathName)
        }
        if ($found -eq 0) { Add-Log '未发现希沃相关服务' }
    } catch { Add-Log ('枚举服务失败: ' + $_.Exception.Message) }

    Add-Log '--- 疑似希沃驱动 ---'
    try {
        $all = & sc.exe query type= driver state= all 2>&1 | Out-String
        $hits = @($all -split '\r?\n' | Where-Object { $_ -match '(?i)seewo' })
        if ($hits.Count -eq 0) {
            Add-Log '驱动列表中未出现 seewo 字样（保护可能由进程自身或其它驱动持有）'
        } else {
            foreach ($line in $hits) { Add-Log ('  ' + $line.Trim()) }
        }
    } catch { Add-Log ('枚举驱动失败: ' + $_.Exception.Message) }
}

function Try-StopProtection {
    $stopped = @()
    try {
        $svcList = @(Get-Service -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '(?i)seewo' -or $_.DisplayName -match '希沃|Seewo' })
        foreach ($s in $svcList) {
            if ([string]$s.Status -eq 'Stopped') { continue }
            try {
                Add-Log ('尝试停止服务: ' + $s.Name)
                Stop-Service -Name $s.Name -Force -ErrorAction Stop
                $stopped += $s.Name
                Add-Log ('已停止: ' + $s.Name)
            } catch { Add-Log ('停止失败 ' + $s.Name + ': ' + $_.Exception.Message) }
        }
    } catch { Add-Log ('停止服务异常: ' + $_.Exception.Message) }
    Start-Sleep -Seconds 1
    return ,$stopped
}

function Restore-Protection {
    param($Names)
    if (-not $Names) { return }
    foreach ($n in @($Names)) {
        try {
            Add-Log ('恢复启动服务: ' + $n)
            Start-Service -Name $n -ErrorAction Stop
        } catch { Add-Log ('恢复失败 ' + $n + ': ' + $_.Exception.Message) }
    }
}

# 把打好补丁的 app.asar 导出到桌面，供保护无法解除时手动替换
function Export-PatchedAsar {
    param([byte[]]$Bytes)
    try {
        $desktop = [Environment]::GetFolderPath('Desktop')
        if (-not $desktop) { $desktop = $env:USERPROFILE }
        $name = 'app.asar.injected-' + (Get-Date).ToString('yyyyMMdd-HHmmss')
        $target = Join-Path $desktop $name
        [System.IO.File]::WriteAllBytes($target, $Bytes)
        Add-Log ('已导出补丁文件: ' + $target)
        return $target
    } catch {
        Add-Log ('导出失败: ' + $_.Exception.Message)
        return $null
    }
}

# ---------------------------------------------------------------------------
# 一键安装（先只读生成并校验，再决定写哪里；原子替换）
# ---------------------------------------------------------------------------

$script:PendingRestore = @()

$btnInstall.add_Click({
    Initialize-InstallerLog
    Add-LogFacts

    if (-not (Test-IsAdmin)) {
        Add-Log '不是管理员，拒绝继续'
        [System.Windows.Forms.MessageBox]::Show(
            ('当前不是管理员，无法写入 Program Files。' + $script:NL + $script:NL + '请关掉本窗口，右键 exe / bat 选择「以管理员身份运行」。'),
            '需要管理员权限', 'OK', 'Warning') | Out-Null
        return
    }

    $btnInstall.Enabled = $false
    $stageDir = $null
    try {
        # ---------- 1. 定位 ----------
        Set-Status '正在定位希沃管家…'
        $dir = Resolve-SeewoDirEmbedded
        Add-Log ('安装目录: ' + $dir)
        if (-not $dir) {
            $ans = [System.Windows.Forms.MessageBox]::Show(
                ('没能自动找到安装目录。' + $script:NL + $script:NL + '要手动选择吗？'),
                '找不到希沃管家', 'OKCancel', 'Warning')
            if ($ans -eq 'OK') { $dir = Select-SeewoDirManually }
        }
        if (-not $dir) { Add-Log '用户未提供有效目录，中止'; Refresh-UiState -Full; return }

        $resourcesDir = Join-Path $dir 'resources'
        $asar = Join-Path $resourcesDir 'app.asar'
        $bak = $asar + '.bak'

        # ---------- 2. 读 + 生成（只读，不需要写权限） ----------
        Set-Status '正在生成注入代码…'
        $info = Read-AsarHeader $asar
        $leaves = Get-AsarLeaves $info.Header
        $mainLeaf = $null
        foreach ($l in $leaves) { if ($l.Rel -eq 'main.js') { $mainLeaf = $l } }
        if ($null -eq $mainLeaf) { throw '这个 app.asar 里没有 main.js' }

        $mainText = [System.Text.Encoding]::UTF8.GetString((Get-EntryBytes $info $mainLeaf))
        if ($mainText.Contains($script:MarkBegin)) {
            Add-Log 'app.asar 已经是注入状态'
            Refresh-UiState -Full
            [System.Windows.Forms.MessageBox]::Show('该 app.asar 已经是注入状态，无需重复安装。', '已注入', 'OK', 'Information') | Out-Null
            return
        }

        $res = Get-PatchedMainJs -Source $mainText -LoaderText $script:LoaderText -ConfigJson $script:DefaultConfigJson
        Add-Log ('注入点 @' + $res.AnchorIndex + ' 入口 id=' + $res.EntryId + ' 增加 ' + $res.DeltaLength + ' 字符')
        $newBytes = [System.Text.Encoding]::UTF8.GetBytes($res.Text)

        # ---------- 2b. 在 %TEMP% 暂存并校验 ----------
        $stageDir = Join-Path $env:TEMP ('aura-stage-' + [System.Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $stageDir -Force | Out-Null
        $staged = Join-Path $stageDir 'app.asar'
        [System.IO.File]::WriteAllBytes($staged, $newBytes)

        $vInfo = Read-AsarHeader $staged
        $vLeaves = Get-AsarLeaves $vInfo.Header
        $vMain = $null
        foreach ($l in $vLeaves) { if ($l.Rel -eq 'main.js') { $vMain = $l } }
        $vText = [System.Text.Encoding]::UTF8.GetString((Get-EntryBytes $vInfo $vMain))
        if (-not $vText.Contains($script:MarkBegin)) { throw '暂存文件校验失败：没有注入标记' }
        Add-Log ('暂存校验通过: 条目数=' + $vLeaves.Count + '，大小=' + $newBytes.Length)

        # ---------- 3. 写权限 ----------
        Set-Status '正在检查写权限…'
        $writable = Test-DirWritable -Dir $resourcesDir

        if (-not $writable) {
            Add-Log '目录不可写。注意：ACL 中 Administrators 已有(F)，说明是保护驱动在拦截'
            $writable = Try-RepairAcl -Dir $resourcesDir
        }

        if (-not $writable) {
            Add-ProtectionFacts
            $ans = [System.Windows.Forms.MessageBox]::Show(
                ('写入被希沃的自我保护拦截了。' + $script:NL + $script:NL +
                 '证据：该目录 ACL 里 BUILTIN\Administrators 已是「完全控制」，' + $script:NL +
                 '但连 takeown / icacls 都被拒绝 —— 这是内核级过滤驱动的行为，' + $script:NL +
                 '不是普通权限问题。' + $script:NL + $script:NL +
                 '是否尝试【临时停止希沃相关服务】后再写？' + $script:NL +
                 '（结束后会自动恢复启动；极小概率导致管家暂时不可用）'),
                '检测到自我保护', 'OKCancel', 'Warning')
            if ($ans -eq 'OK') {
                Set-Status '正在尝试停止希沃保护服务…'
                $script:PendingRestore = Try-StopProtection
                $writable = Test-DirWritable -Dir $resourcesDir
                Add-Log ('停止服务后是否可写: ' + $writable)
            }
        }

        # ---------- 4. 仍不可写 → 导出保底 ----------
        if (-not $writable) {
            Add-Log '仍不可写，改为导出补丁文件'
            $exported = Export-PatchedAsar -Bytes $newBytes
            Refresh-UiState -Full
            if ($exported) {
                [System.Windows.Forms.MessageBox]::Show(
                    ('无法直接写入（希沃自我保护已开启），已把打好补丁的文件导出到桌面：' + $script:NL + $exported + $script:NL + $script:NL +
                     '可选的绕过办法：' + $script:NL +
                     '  1) 托盘退出希沃 + 结束所有希沃进程后重试' + $script:NL +
                     '  2) 重启进「安全模式」，把桌面那个文件覆盖到：' + $script:NL +
                     '     ' + $asar + $script:NL +
                     '     （覆盖前先备份原文件）' + $script:NL +
                     '  3) 请管理员临时关闭希沃自我保护' + $script:NL + $script:NL +
                     '详细诊断见日志：' + $script:NL + $script:InstallLog),
                    '已导出补丁文件', 'OK', 'Warning') | Out-Null
            } else {
                [System.Windows.Forms.MessageBox]::Show(
                    ('无法写入，也无法导出文件。请把日志发我：' + $script:NL + $script:InstallLog),
                    '安装失败', 'OK', 'Error') | Out-Null
            }
            return
        }

        # ---------- 5. 停管家 ----------
        Set-Status '正在结束希沃管家…'
        $stopped = Stop-HostForce
        if (-not $stopped) { Add-Log '警告：管家仍在运行，继续尝试写入' }

        # ---------- 6. 备份 + 原子替换 ----------
        Set-Status '正在写入（原子替换）…'
        $tmpNew = $asar + '.new'
        Copy-Item -LiteralPath $staged -Destination $tmpNew -Force -ErrorAction Stop
        Add-Log '已写入同目录临时文件 app.asar.new'

        if (-not (Test-Path -LiteralPath $bak)) {
            try {
                Move-Item -LiteralPath $asar -Destination $bak -ErrorAction Stop
                Add-Log '备份：重命名 app.asar -> app.asar.bak'
            } catch {
                Add-Log ('重命名备份失败，改用复制: ' + $_.Exception.Message)
                Copy-Item -LiteralPath $asar -Destination $bak -Force -ErrorAction Stop
                Add-Log '备份：复制'
            }
        } else {
            Add-Log '已存在备份，保留不覆盖'
        }

        try {
            if (Test-Path -LiteralPath $asar) {
                [System.IO.File]::Replace($tmpNew, $asar, $null)
                Add-Log '原子替换成功 (File.Replace)'
            } else {
                Move-Item -LiteralPath $tmpNew -Destination $asar -Force -ErrorAction Stop
                Add-Log '移入新文件（原文件已作为备份）'
            }
        } catch {
            Add-Log ('原子替换失败: ' + $_.Exception.Message)
            if (Test-Path -LiteralPath $bak) {
                Copy-Item -LiteralPath $bak -Destination $asar -Force -ErrorAction SilentlyContinue
                Add-Log '已从备份回滚'
            }
            throw
        } finally {
            Remove-Item -LiteralPath $tmpNew -Force -ErrorAction SilentlyContinue
        }

        # ---------- 7. 重启 + 确认 ----------
        Set-Status '正在重启希沃管家…'
        if (Test-Path -LiteralPath $script:LogPath) {
            Remove-Item -LiteralPath $script:LogPath -Force -ErrorAction SilentlyContinue
        }
        $started = Start-Host -Dir $dir
        Add-Log ('重启管家: ' + $started)

        Set-Status '正在确认加载器已运行…'
        $deadline = (Get-Date).AddSeconds(30)
        $ready = $false
        while ((Get-Date) -lt $deadline) {
            if (Test-Path -LiteralPath $script:LogPath) {
                try {
                    $logText = [System.IO.File]::ReadAllText($script:LogPath, [System.Text.Encoding]::UTF8)
                    if ($logText.Contains('命令桥已启动')) { $ready = $true; break }
                } catch { }
            }
            Start-Sleep -Milliseconds 800
        }
        Add-Log ('加载器就绪: ' + $ready)

        Refresh-UiState -Full

        if ($ready) {
            Add-Log '安装成功'
            [System.Windows.Forms.MessageBox]::Show(
                ('注入成功，加载器已确认运行。' + $script:NL + $script:NL + '希沃管家已自动重启。现在可以配置并预览了。'),
                '安装成功', 'OK', 'Information') | Out-Null
        } else {
            Add-Log '已写入但未确认加载器就绪'
            $extra = ''
            if (-not $started) { $extra = $script:NL + $script:NL + '注意：没能自动启动希沃管家，请手动打开。' }
            [System.Windows.Forms.MessageBox]::Show(
                ('app.asar 已注入成功，但暂时没在日志里看到加载器就绪。' + $extra + $script:NL + $script:NL +
                 '稍后点「查看日志」，看到「命令桥已启动」就说明正常。'),
                '已写入，等待加载器', 'OK', 'Warning') | Out-Null
        }
    } catch {
        Add-Log ('安装失败: ' + $_.Exception.Message)
        Add-Log ('异常类型: ' + $_.Exception.GetType().FullName)
        if ($_.Exception.InnerException) { Add-Log ('内部异常: ' + $_.Exception.InnerException.Message) }
        try { Add-Log ('调用栈: ' + $_.ScriptStackTrace) } catch { }
        Refresh-UiState -Full
        $logHint = $script:InstallLog
        if (-not $logHint) { $logHint = '(日志不可用)' }
        $msg = '安装失败：' + $_.Exception.Message + $script:NL + $script:NL + '详细日志：' + $script:NL + $logHint
        if ($script:ExeLog) { $msg = $msg + $script:NL + $script:ExeLog }
        [System.Windows.Forms.MessageBox]::Show($msg, '安装失败', 'OK', 'Error') | Out-Null
    } finally {
        if ($stageDir) { Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue }
        if ($script:PendingRestore -and @($script:PendingRestore).Count -gt 0) {
            Add-Log '恢复希沃服务…'
            Restore-Protection -Names $script:PendingRestore
            $script:PendingRestore = @()
        }
        $btnInstall.Enabled = $true
    }
})

# ---------------------------------------------------------------------------
# 保存并预览
# ---------------------------------------------------------------------------

$btnSavePreview.add_Click({
    try {
        $cfg = Build-Config
        Save-ConfigFile -Config $cfg
    } catch {
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, '配置有误', 'OK', 'Warning') | Out-Null
        return
    }

    if ($chkOverride.Checked -and (@($cfg.override.imageList).Count -eq 0)) {
        [System.Windows.Forms.MessageBox]::Show('已保存，但图片列表为空，无法预览。请至少添加一张图片。', '提示', 'OK', 'Warning') | Out-Null
        Set-Status '已保存，但图片列表为空，预览已跳过。'
        return
    }

    if ((Get-HostProcs).Count -eq 0) {
        [System.Windows.Forms.MessageBox]::Show(
            ('希沃管家没有在运行，无法预览。' + $script:NL + $script:NL +
             '请先打开希沃管家（或重新点「一键安装」会自动帮你启动）。'),
            '管家未运行', 'OK', 'Warning') | Out-Null
        Set-Status '已保存，但管家未运行，无法预览。'
        return
    }

    Set-Status '正在唤起屏保…'
    $btnSavePreview.Enabled = $false
    $r = Invoke-Preview
    $btnSavePreview.Enabled = $true

    if ($null -eq $r) {
        Set-Status '预览超时：命令已发出，但管家没有响应。'
        [System.Windows.Forms.MessageBox]::Show(
            ('预览命令已发出，但管家进程没有响应。' + $script:NL + $script:NL +
             '请点「查看日志」，确认有「命令桥已启动」这一行。' + $script:NL +
             '若没有，请重新点「一键安装」（必要时先「卸载还原」再装一次）。'),
            '预览超时', 'OK', 'Warning') | Out-Null
        return
    }

    if ($r.ok) {
        $src = '当前配置'
        if ($null -ne $r.source -and [string]$r.source -eq 'last-payload') { $src = '最近一次集控下发' }
        $n = ''
        if ($null -ne $r.imageCount) { $n = '，图片 ' + $r.imageCount + ' 张' }
        Set-Status ('屏保已唤起（来源：' + $src + $n + '）')
    } else {
        $msg = [string]$r.message
        if ($msg -eq '') { $msg = '原因：' + [string]$r.reason }
        Set-Status ('预览失败：' + $msg)
        [System.Windows.Forms.MessageBox]::Show($msg, '预览失败', 'OK', 'Warning') | Out-Null
    }
})

# ---------------------------------------------------------------------------
# 卸载还原
# ---------------------------------------------------------------------------

$btnUninstall.add_Click({
    $st = $script:State
    $ans = [System.Windows.Forms.MessageBox]::Show(
        ('确定要卸载还原吗？' + $script:NL + $script:NL +
         '会用备份覆盖当前 app.asar，屏保恢复官方行为。' + $script:NL +
         '希沃管家会被自动结束并重启。'),
        '确认卸载', 'OKCancel', 'Question')
    if ($ans -ne 'OK') { return }

    $btnUninstall.Enabled = $false
    try {
        if (-not $st -or -not $st.Dir) { $st = Get-InjectionState }
        $dir = $st.Dir
        if (-not $dir) { throw '找不到安装目录' }

        $asar = Join-Path $dir 'resources\app.asar'
        $bak = $asar + '.bak'
        if (-not (Test-Path -LiteralPath $bak)) { throw ('没有备份文件：' + $bak) }

        Set-Status '正在结束希沃管家…'
        Stop-Host

        Set-Status '正在还原官方 app.asar…'
        Copy-Item -LiteralPath $bak -Destination $asar -Force

        Set-Status '正在重启希沃管家…'
        [void](Start-Host -Dir $dir)

        Refresh-UiState -Full
        [System.Windows.Forms.MessageBox]::Show(
            ('已还原官方 app.asar，希沃管家已重启。' + $script:NL + $script:NL +
             '备份文件仍保留，可再次安装。'),
            '卸载完成', 'OK', 'Information') | Out-Null
    } catch {
        Refresh-UiState -Full
        [System.Windows.Forms.MessageBox]::Show(('卸载失败：' + $_.Exception.Message), '卸载失败', 'OK', 'Error') | Out-Null
    } finally {
        $btnUninstall.Enabled = $true
    }
})

# ---------------------------------------------------------------------------
# 其他
# ---------------------------------------------------------------------------

$chkOverride.add_CheckedChanged({ Enable-OverrideFields })

$linkLog.add_Click({
    if (Test-Path -LiteralPath $script:LogPath) {
        Start-Process notepad.exe -ArgumentList ('"' + $script:LogPath + '"')
    } else {
        [System.Windows.Forms.MessageBox]::Show(
            ('还没有日志文件：' + $script:NL + $script:LogPath + $script:NL + $script:NL +
             '日志在注入生效、管家启动后才会产生。'),
            '暂无日志', 'OK', 'Information') | Out-Null
    }
})

# 轻量刷新：只更新进程状态，避免每次重读 11MB 的 asar
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({ try { Refresh-UiState } catch { } })
$timer.Start()

$form.add_Shown({
    Refresh-UiState -Full
    if ($btnInstall.Visible) {
        $btnInstall.Focus()
    }
})

[void]$form.ShowDialog()
