# 语法自检：解析仓库内所有 .ps1，报出语法错误位置。不执行任何业务逻辑。
param([string]$Root = "")

if (-not $Root) { $Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }

$files = Get-ChildItem -LiteralPath $Root -Recurse -Filter *.ps1 -File -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch '\\\.work\\' }

$bad = 0
foreach ($f in $files) {
    $errs = $null
    $tokens = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$errs)
    if ($errs -and $errs.Count -gt 0) {
        $bad++
        Write-Host ('[FAIL] ' + $f.FullName) -ForegroundColor Red
        foreach ($e in $errs) {
            Write-Host ('        line ' + $e.Extent.StartLineNumber + ': ' + $e.Message) -ForegroundColor Red
        }
    } else {
        Write-Host ('[ OK ] ' + $f.Name) -ForegroundColor Green
    }
}

Write-Host ''
Write-Host ("共检查 $($files.Count) 个 .ps1，失败 $bad 个")


# ---------------------------------------------------------------------------
# 未定义函数检查（防止删代码时留下悬空调用 —— 这类错误语法检查抓不到）
# ---------------------------------------------------------------------------
$files = Get-ChildItem -LiteralPath $Root -Recurse -Filter *.ps1 -File -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch '\\\.work\\' }

# 内置/外部命令白名单（PowerShell cmdlet 与系统 exe）
$builtin = @('Write-Host','Write-Output','Get-Item','Get-ChildItem','Get-Process','Get-Service','Get-CimInstance',
  'Join-Path','Split-Path','Test-Path','New-Item','Remove-Item','Copy-Item','Move-Item','Get-Content','Set-Content',
  'Add-Type','Add-Member','Start-Process','Stop-Process','Start-Sleep','New-Object','Select-Object','Where-Object',
  'ForEach-Object','Sort-Object','Measure-Object','ConvertTo-Json','ConvertFrom-Json','Out-Null','Out-String',
  'Get-Command','Get-ItemProperty','New-ItemProperty','Remove-ItemProperty','Set-ItemProperty','Get-ItemPropertyValue',
  'Get-ChildItem','Resolve-Path','Get-FileHash','Start-Service','Stop-Service','Get-Date','Get-FolderPath',
  'Invoke-Expression','Invoke-Command','Select-String','Get-EventLog','Get-WmiObject','Set-Location',
  'New-Object','Out-File','Tee-Object','Get-Variable','Set-Variable','Clear-Host','Read-Host','Write-Error',
  'Write-Warning','Write-Verbose','Write-Debug','Get-Help','Format-Table','Format-List','Export-Csv','Import-Csv',
  'Get-AuthenticodeSignature','Get-Acl','Set-Acl','Get-Alias','Set-Alias','Test-Connection','Get-Member',
  'New-ItemProperty','Register-ObjectEvent','Unregister-Event','Get-EventSubscriber','Wait-Event',
  'Get-ComputerInfo','Get-PSDrive','Get-Volume','Get-Disk','Get-Partition','Clear-Content',
  'Add-Content','Set-Item','Remove-Variable','Get-Culture','Get-UICulture','Get-Host','Out-Host',
  'ConvertFrom-StringData','New-TimeSpan','Get-Random','Test-Json','ConvertTo-Csv','ConvertFrom-Csv',
  'Get-TypeData','Update-TypeData','Format-Custom','Format-Wide','Format-Hex','Get-PSCallStack',
  'Install-Module','Invoke-PS2EXE','Set-StrictMode','Set-PSDebug','Get-PackageProvider'
)

$suspicious = 0
foreach ($f in $files) {
    $tokens = $null; $errs = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$errs)
    if (-not $ast) { continue }

    # 收集本文件定义的函数名
    $defined = @($ast.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) |
                 ForEach-Object { $_.Name })

    # 收集所有命令调用（命令名）
    $cmds = @($ast.FindAll({ $args[0] -is [System.Management.Automation.Language.CommandAst] }, $true))
    foreach ($c in $cmds) {
        $name = $c.GetCommandName()
        if (-not $name) { continue }
        # 跳过带 . 或 \ 的（模块限定/exe 路径），跳过变量调用
        if ($name -match "[.\\\\]") { continue }
        if ($builtin -contains $name) { continue }
        if ($defined -contains $name) { continue }
        # 是否在其它文件里定义
        $elsewhere = $false
        foreach ($g in $files) {
            if ($g.FullName -eq $f.FullName) { continue }
            $gt = $null; $ge = $null
            $ga = [System.Management.Automation.Language.Parser]::ParseFile($g.FullName, [ref]$gt, [ref]$ge)
            if (-not $ga) { continue }
            $gd = @($ga.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) |
                     ForEach-Object { $_.Name })
            if ($gd -contains $name) { $elsewhere = $true; break }
        }
        if ($elsewhere) { continue }
        # 也检查是否为已定义变量（如 $fn = {...}）
        $suspicious++
        Write-Host ("  [警告] " + $f.Name + " 第 " + $c.Extent.StartLineNumber + " 行调用了未定义的函数: " + $name) -ForegroundColor Yellow
    }
}

if ($suspicious -gt 0) {
    Write-Host ""
    Write-Host ("发现 " + $suspicious + " 处可疑调用（可能是拼写错误或删代码时留下的悬空调用）") -ForegroundColor Yellow
    Write-Host "注意：这也可能把合法的外部命令误报，请人工确认。" -ForegroundColor Gray
} else {
    Write-Host ""
    Write-Host "未定义函数检查：未发现问题" -ForegroundColor Green
}

if ($bad -gt 0) { exit 1 } else { exit 0 }
