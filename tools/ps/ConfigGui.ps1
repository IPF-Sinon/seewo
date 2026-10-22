<#
  希沃屏保配置界面（纯 PowerShell + WinForms，无需 Node.js）
  ============================================================================
  直接读写 %APPDATA%\seewo\AuraScreensaver\config.json，并通过 command.json
  命令桥让注入在管家主进程里的加载器执行「立即预览」。

  启动方式：双击 scripts\配置屏保.bat
#>

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$ErrorActionPreference = 'Stop'

$script:ConfigDir   = Join-Path $env:APPDATA (Join-Path 'seewo' 'AuraScreensaver')
$script:ConfigPath  = Join-Path $script:ConfigDir 'config.json'
$script:CommandPath = Join-Path $script:ConfigDir 'command.json'
$script:ResultPath  = Join-Path $script:ConfigDir 'command-result.json'
$script:LogPath     = Join-Path $script:ConfigDir 'aura-screensaver.log'

$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$script:NL = [Environment]::NewLine

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
    } catch {
        return Get-DefaultConfig
    }
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

function Invoke-Preview {
    if (-not (Test-Path -LiteralPath $script:ConfigDir)) {
        New-Item -ItemType Directory -Path $script:ConfigDir -Force | Out-Null
    }

    $seq = [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
    $cmd = [pscustomobject]@{
        seq  = $seq
        cmd  = 'preview'
        args = [pscustomobject]@{}
        at   = (Get-Date).ToString('o')
    } | ConvertTo-Json -Depth 5

    [System.IO.File]::WriteAllText($script:CommandPath, $cmd, $script:Utf8NoBom)

    $deadline = (Get-Date).AddSeconds(4)
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

$form = New-Object System.Windows.Forms.Form
$form.Text = '希沃屏保配置'
$form.Size = New-Object System.Drawing.Size(660, 680)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)

$chkEnabled = New-Object System.Windows.Forms.CheckBox
$chkEnabled.Text = '启用屏保（关闭后，集控再下发也不会弹出）'
$chkEnabled.Location = New-Object System.Drawing.Point(16, 14)
$chkEnabled.Size = New-Object System.Drawing.Size(460, 22)
$form.Controls.Add($chkEnabled)

$chkLock = New-Object System.Windows.Forms.CheckBox
$chkLock.Text = '关闭屏保后自动锁屏（建议不勾：避免关屏保就锁屏）'
$chkLock.Location = New-Object System.Drawing.Point(16, 40)
$chkLock.Size = New-Object System.Drawing.Size(520, 22)
$form.Controls.Add($chkLock)

$group = New-Object System.Windows.Forms.GroupBox
$group.Text = '自定义图集'
$group.Location = New-Object System.Drawing.Point(16, 70)
$group.Size = New-Object System.Drawing.Size(610, 430)
$form.Controls.Add($group)

$chkOverride = New-Object System.Windows.Forms.CheckBox
$chkOverride.Text = '使用自定义图集（不勾选 = 沿用学校集控下发的图片与文案）'
$chkOverride.Location = New-Object System.Drawing.Point(14, 24)
$chkOverride.Size = New-Object System.Drawing.Size(540, 22)
$group.Controls.Add($chkOverride)

$lblSource = New-Object System.Windows.Forms.Label
$lblSource.Text = '素材来源'
$lblSource.Location = New-Object System.Drawing.Point(14, 58)
$lblSource.Size = New-Object System.Drawing.Size(70, 20)
$group.Controls.Add($lblSource)

$txtSource = New-Object System.Windows.Forms.TextBox
$txtSource.Location = New-Object System.Drawing.Point(90, 55)
$txtSource.Size = New-Object System.Drawing.Size(500, 24)
$group.Controls.Add($txtSource)

$lblInterval = New-Object System.Windows.Forms.Label
$lblInterval.Text = '切换间隔（秒）'
$lblInterval.Location = New-Object System.Drawing.Point(14, 92)
$lblInterval.Size = New-Object System.Drawing.Size(90, 20)
$group.Controls.Add($lblInterval)

$numInterval = New-Object System.Windows.Forms.NumericUpDown
$numInterval.Location = New-Object System.Drawing.Point(108, 89)
$numInterval.Size = New-Object System.Drawing.Size(80, 24)
$numInterval.Minimum = 1
$numInterval.Maximum = 3600
$numInterval.Value = 15
$group.Controls.Add($numInterval)

$lblFit = New-Object System.Windows.Forms.Label
$lblFit.Text = '图片适配'
$lblFit.Location = New-Object System.Drawing.Point(220, 92)
$lblFit.Size = New-Object System.Drawing.Size(60, 20)
$group.Controls.Add($lblFit)

$rbContain = New-Object System.Windows.Forms.RadioButton
$rbContain.Text = '留边完整显示'
$rbContain.Location = New-Object System.Drawing.Point(290, 90)
$rbContain.Size = New-Object System.Drawing.Size(120, 22)
$group.Controls.Add($rbContain)

$rbCover = New-Object System.Windows.Forms.RadioButton
$rbCover.Text = '裁剪铺满'
$rbCover.Location = New-Object System.Drawing.Point(420, 90)
$rbCover.Size = New-Object System.Drawing.Size(100, 22)
$group.Controls.Add($rbCover)

$lblImages = New-Object System.Windows.Forms.Label
$lblImages.Text = '图片列表（每行一个完整路径）'
$lblImages.Location = New-Object System.Drawing.Point(14, 126)
$lblImages.Size = New-Object System.Drawing.Size(300, 20)
$group.Controls.Add($lblImages)

$txtImages = New-Object System.Windows.Forms.TextBox
$txtImages.Location = New-Object System.Drawing.Point(14, 148)
$txtImages.Size = New-Object System.Drawing.Size(580, 110)
$txtImages.Multiline = $true
$txtImages.ScrollBars = 'Vertical'
$txtImages.AcceptsReturn = $true
$group.Controls.Add($txtImages)

$lblTexts = New-Object System.Windows.Forms.Label
$lblTexts.Text = '图文条目（每行：内容|出处，出处可省略）'
$lblTexts.Location = New-Object System.Drawing.Point(14, 266)
$lblTexts.Size = New-Object System.Drawing.Size(340, 20)
$group.Controls.Add($lblTexts)

$txtTexts = New-Object System.Windows.Forms.TextBox
$txtTexts.Location = New-Object System.Drawing.Point(14, 288)
$txtTexts.Size = New-Object System.Drawing.Size(580, 70)
$txtTexts.Multiline = $true
$txtTexts.ScrollBars = 'Vertical'
$txtTexts.AcceptsReturn = $true
$group.Controls.Add($txtTexts)

$lblTrans = New-Object System.Windows.Forms.Label
$lblTrans.Text = '转场效果（可选，每行一个 0-6；留空自动随机）'
$lblTrans.Location = New-Object System.Drawing.Point(14, 366)
$lblTrans.Size = New-Object System.Drawing.Size(400, 20)
$group.Controls.Add($lblTrans)

$txtTrans = New-Object System.Windows.Forms.TextBox
$txtTrans.Location = New-Object System.Drawing.Point(14, 388)
$txtTrans.Size = New-Object System.Drawing.Size(140, 24)
$group.Controls.Add($txtTrans)

$btnSave = New-Object System.Windows.Forms.Button
$btnSave.Text = '保存配置'
$btnSave.Location = New-Object System.Drawing.Point(16, 512)
$btnSave.Size = New-Object System.Drawing.Size(110, 32)
$form.Controls.Add($btnSave)

$btnPreview = New-Object System.Windows.Forms.Button
$btnPreview.Text = '立即预览屏保'
$btnPreview.Location = New-Object System.Drawing.Point(136, 512)
$btnPreview.Size = New-Object System.Drawing.Size(130, 32)
$form.Controls.Add($btnPreview)

$btnInstall = New-Object System.Windows.Forms.Button
$btnInstall.Text = '安装注入'
$btnInstall.Location = New-Object System.Drawing.Point(286, 512)
$btnInstall.Size = New-Object System.Drawing.Size(100, 32)
$form.Controls.Add($btnInstall)

$btnUninstall = New-Object System.Windows.Forms.Button
$btnUninstall.Text = '卸载还原'
$btnUninstall.Location = New-Object System.Drawing.Point(396, 512)
$btnUninstall.Size = New-Object System.Drawing.Size(100, 32)
$form.Controls.Add($btnUninstall)

$btnLog = New-Object System.Windows.Forms.Button
$btnLog.Text = '查看日志'
$btnLog.Location = New-Object System.Drawing.Point(506, 512)
$btnLog.Size = New-Object System.Drawing.Size(100, 32)
$form.Controls.Add($btnLog)

$lblStatus = New-Object System.Windows.Forms.Label
$lblStatus.Location = New-Object System.Drawing.Point(16, 560)
$lblStatus.Size = New-Object System.Drawing.Size(610, 60)
$lblStatus.ForeColor = [System.Drawing.Color]::DimGray
$lblStatus.Text = ''
$form.Controls.Add($lblStatus)

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

        $ps = 0
        if ($null -ne $ov.pictureSizeType -and [string]$ov.pictureSizeType -eq '1') { $ps = 1 }
        $rbContain.Checked = ($ps -eq 0)
        $rbCover.Checked = ($ps -eq 1)

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
            } else {
                throw ('转场值必须是整数，发现：' + $p)
            }
        }
        if ($trans.Count -ne $images.Count) {
            throw ('转场数量（' + $trans.Count + '）必须等于图片数量（' + $images.Count + '）。留空则自动随机。')
        }
    }

    $psType = 0
    if ($rbCover.Checked) { $psType = 1 }

    $ov = [pscustomobject]@{
        materialSource  = $txtSource.Text.Trim()
        switchInterval  = [int]$numInterval.Value
        pictureSizeType = $psType
        imageList       = $images
        textList        = $texts
        transitionList  = $null
    }
    if ($trans.Count -gt 0) {
        $ov.transitionList = $trans
    }
    return $ov
}

function Build-Config {
    $ov = $null
    if ($chkOverride.Checked) { $ov = Collect-Override }

    return [pscustomobject]@{
        screensaverEnabled = [bool]$chkEnabled.Checked
        lockCascadeOnClose = [bool]$chkLock.Checked
        allowManualClose   = $true
        override           = $ov
        logLevel           = 'info'
        backupCount        = 3
    }
}

$chkOverride.add_CheckedChanged({ Enable-OverrideFields })

$btnSave.add_Click({
    try {
        $cfg = Build-Config
        Save-ConfigFile -Config $cfg
        if ($chkOverride.Checked -and (@($cfg.override.imageList).Count -eq 0)) {
            Set-Status '已保存。注意：自定义图集已开启但图片列表为空，预览会失败。'
        } else {
            Set-Status ('已保存：' + $script:ConfigPath)
        }
    } catch {
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, '配置有误', 'OK', 'Warning') | Out-Null
        Set-Status ('保存失败：' + $_.Exception.Message)
    }
})

$btnPreview.add_Click({
    try {
        $cfg = Build-Config
        Save-ConfigFile -Config $cfg

        if ($chkOverride.Checked -and (@($cfg.override.imageList).Count -eq 0)) {
            [System.Windows.Forms.MessageBox]::Show('图片列表为空，无法预览。请先添加图片。', '无法预览', 'OK', 'Warning') | Out-Null
            return
        }

        Set-Status '正在请求唤起屏保…'
        $btnPreview.Enabled = $false
        $r = Invoke-Preview
        $btnPreview.Enabled = $true

        if ($null -eq $r) {
            Set-Status '没有响应：请确认希沃管家正在运行，且已执行过「安装注入」。'
            [System.Windows.Forms.MessageBox]::Show(
                ('预览命令已发出，但管家进程没有响应。' + $script:NL + $script:NL +
                 '请确认：' + $script:NL +
                 '1) 已点过「安装注入」并重启了希沃管家' + $script:NL +
                 '2) 希沃管家当前正在运行'),
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
    } catch {
        $btnPreview.Enabled = $true
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, '预览出错', 'OK', 'Warning') | Out-Null
        Set-Status ('预览出错：' + $_.Exception.Message)
    }
})

function Start-Installer {
    param([switch]$UninstallNow)

    # exe 模式：没有外部脚本可调用，直接在进程内注入
    if ($script:EmbeddedMode -eq $true -and (Get-Command Invoke-EmbeddedInstall -ErrorAction SilentlyContinue)) {
        Invoke-EmbeddedInstall -UninstallNow:$UninstallNow
        return
    }

    $repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $installer = Join-Path $repoRoot (Join-Path 'scripts' 'AuraScreensaver.ps1')
    if (-not (Test-Path -LiteralPath $installer)) {
        [System.Windows.Forms.MessageBox]::Show(('找不到安装器：' + $installer), '错误', 'OK', 'Error') | Out-Null
        return
    }

    $argLine = '-NoProfile -ExecutionPolicy Bypass -File "' + $installer + '"'
    if ($UninstallNow) { $argLine += ' -Uninstall' }

    try {
        Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argLine
        Set-Status '已在新的窗口中启动安装器，请按提示操作。'
    } catch {
        [System.Windows.Forms.MessageBox]::Show(('启动失败：' + $_.Exception.Message), '错误', 'OK', 'Error') | Out-Null
    }
}

$btnInstall.add_Click({ Start-Installer })
$btnUninstall.add_Click({ Start-Installer -UninstallNow })

$btnLog.add_Click({
    if (Test-Path -LiteralPath $script:LogPath) {
        Start-Process notepad.exe -ArgumentList ('"' + $script:LogPath + '"')
    } else {
        [System.Windows.Forms.MessageBox]::Show(
            ('还没有日志文件：' + $script:NL + $script:LogPath + $script:NL + $script:NL +
             '日志在注入生效、管家启动后才会产生。'),
            '暂无日志', 'OK', 'Information') | Out-Null
    }
})

try {
    Fill-Form -Cfg (Read-Config)
} catch {
    Set-Status ('读取配置失败，已用默认值：' + $_.Exception.Message)
}

$existsText = '配置文件尚不存在（保存后创建）'
if (Test-Path -LiteralPath $script:ConfigPath) { $existsText = '配置文件：' + $script:ConfigPath }
Set-Status ($existsText + $script:NL + '提示：改完先「保存配置」，再点「立即预览屏保」看效果。')

[void]$form.ShowDialog()
