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
if ($bad -gt 0) { exit 1 } else { exit 0 }
