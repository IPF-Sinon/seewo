# ---------------------------------------------------------------------------
# ConvertTo-TransitionList 单元测试
#   直接从业余提取函数定义（不加载整个界面脚本，否则会去建窗口）。
#
#   覆盖用户实测的两个自相矛盾提示：
#     · 填「6」→ 旧逻辑报「转场数量（1）必须等于图片数量（6）」
#     · 填「29」→ 旧逻辑报「转场值必须是 0-6 的整数，发现：29」
#   新规则下：单个值合法（应用到全部），越界值给出「怎么写」的说明。
# ---------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'
$script:NL = [Environment]::NewLine

$gui = [System.IO.File]::ReadAllText(
    (Join-Path $PSScriptRoot 'ConfigGui.ps1'), [System.Text.Encoding]::UTF8)
$a = $gui.IndexOf('function ConvertTo-TransitionList {')
if ($a -lt 0) { Write-Host '[FAIL] 找不到 ConvertTo-TransitionList'; exit 1 }
$b = $gui.IndexOf('# ------------', $a)
if ($b -lt 0) { $b = $gui.IndexOf('function Build-Config {', $a) }
Invoke-Expression $gui.Substring($a, $b - $a)

$script:fail = 0
function Check {
    param([string]$Name, [scriptblock]$Body)
    try {
        & $Body
        Write-Host ('  [ OK ] ' + $Name)
    } catch {
        $script:fail++
        Write-Host ('  [FAIL] ' + $Name + ' -> ' + $_.Exception.Message)
    }
}

Write-Host 'ConvertTo-TransitionList'

Check '留空 -> 空数组（渲染器随机）' {
    $r = ConvertTo-TransitionList -Raw '' -ImageCount 6
    if (@($r).Count -ne 0) { throw ('期望 0 个，实际 ' + @($r).Count) }
}

Check '空白字符 -> 空数组' {
    $r = ConvertTo-TransitionList -Raw '   ' -ImageCount 3
    if (@($r).Count -ne 0) { throw ('期望 0 个，实际 ' + @($r).Count) }
}

Check '★ 单个值 6 -> 应用到全部 6 张（旧逻辑会报错）' {
    $r = ConvertTo-TransitionList -Raw '6' -ImageCount 6
    if ($r.Count -ne 6) { throw ('期望 6 个，实际 ' + $r.Count) }
    foreach ($v in $r) { if ($v -ne 6) { throw ('期望全是 6，实际 ' + $v) } }
}

Check '单个值 0 -> 应用到全部' {
    $r = ConvertTo-TransitionList -Raw '0' -ImageCount 4
    if ($r.Count -ne 4) { throw ('期望 4 个，实际 ' + $r.Count) }
}

Check '逐图对应 0,3,6,1,2,4' {
    $r = ConvertTo-TransitionList -Raw '0,3,6,1,2,4' -ImageCount 6
    if ($r.Count -ne 6) { throw ('期望 6 个，实际 ' + $r.Count) }
    $want = @(0, 3, 6, 1, 2, 4)
    for ($i = 0; $i -lt 6; $i++) { if ($r[$i] -ne $want[$i]) { throw ('第 ' + $i + ' 个不符') } }
}

Check '分隔符兼容：逗号/分号/空格中文顿号' {
    $r = ConvertTo-TransitionList -Raw '1; 2，3 4' -ImageCount 4
    if ($r.Count -ne 4) { throw ('期望 4 个，实际 ' + $r.Count) }
}

Check '★ 越界值 29 -> 报错并说明取值范围（旧提示只说必须 0-6）' {
    $threw = $false
    try { ConvertTo-TransitionList -Raw '29' -ImageCount 6 | Out-Null } catch { $threw = $true; $m = $_.Exception.Message }
    if (-not $threw) { throw '应当抛错' }
    if ($m -notmatch '超出范围') { throw ('错误信息没说明原因: ' + $m) }
    if ($m -notmatch '0、1、2、3、4、5、6') { throw ('错误信息没给出取值: ' + $m) }
}

Check '★ 数量不匹配 -> 报错并给出三种填法' {
    $threw = $false
    try { ConvertTo-TransitionList -Raw '0,3' -ImageCount 6 | Out-Null } catch { $threw = $true; $m = $_.Exception.Message }
    if (-not $threw) { throw '应当抛错' }
    if ($m -notmatch '三选一') { throw ('错误信息没给出填法: ' + $m) }
    if ($m -notmatch '只填 1 个值') { throw '缺少「只填 1 个值」选项' }
    if ($m -notmatch '填满 6 个值') { throw '缺少「填满 N 个值」选项' }
    if ($m -notmatch '留空') { throw '缺少「留空」选项' }
}

Check '非整数 -> 报错说明是整数' {
    $threw = $false
    try { ConvertTo-TransitionList -Raw 'abc' -ImageCount 3 | Out-Null } catch { $threw = $true; $m = $_.Exception.Message }
    if (-not $threw) { throw '应当抛错' }
    if ($m -notmatch '不是整数') { throw ('错误信息不对: ' + $m) }
}

Check '负值 -> 报错' {
    $threw = $false
    try { ConvertTo-TransitionList -Raw '-1' -ImageCount 3 | Out-Null } catch { $threw = $true }
    if (-not $threw) { throw '应当抛错' }
}

Check '单张图片 + 单值 -> 1 个元素' {
    $r = ConvertTo-TransitionList -Raw '5' -ImageCount 1
    if ($r.Count -ne 1) { throw ('期望 1 个，实际 ' + $r.Count) }
}

Write-Host ''
if ($script:fail -gt 0) {
    Write-Host ('转场规则测试失败 ' + $script:fail + ' 项')
    exit 1
} else {
    Write-Host '转场规则测试全部通过'
    exit 0
}
