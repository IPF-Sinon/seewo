param(
    [string]$Title = '选择文件',
    [string]$Filter = '所有文件|*.*'
)
Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -AssemblyName System.Drawing | Out-Null
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = $Title
$d.Filter = $Filter
$d.Multiselect = $false
$d.CheckFileExists = $true
$d.RestoreDirectory = $true
if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    Write-Output $d.FileName
}
