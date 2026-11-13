<#
Removes VidQueue (per-user install). Runs from Installed apps, or with -Quiet.
Downloaded videos are never touched.
#>
param([switch]$Quiet, [switch]$RemoveData)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
Set-Location $env:TEMP   # the install folder is about to be deleted

$installDir = Join-Path $env:LOCALAPPDATA 'Programs\VidQueue'
$dataDir    = Join-Path $env:LOCALAPPDATA 'VidQueue'
$exeName    = 'VidQueue.exe'

if (-not $Quiet) {
    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'Uninstall VidQueue'; $form.StartPosition = 'CenterScreen'
    $form.ClientSize = New-Object System.Drawing.Size(470, 190); $form.FormBorderStyle = 'FixedDialog'; $form.MaximizeBox = $false
    $form.Font = New-Object System.Drawing.Font('Segoe UI', 9.5)
    try { $form.Icon = New-Object System.Drawing.Icon((Join-Path $installDir 'vidqueue.ico')) } catch {}
    $l = New-Object System.Windows.Forms.Label
    $l.Text = "Remove VidQueue from this PC?`r`n`r`nYour downloaded videos are not touched. Remove the Firefox extension`r`nyourself in Firefox (Add-ons and themes)."
    $l.AutoSize = $true; $l.Location = New-Object System.Drawing.Point(20, 18); $form.Controls.Add($l)
    $chk = New-Object System.Windows.Forms.CheckBox
    $chk.Text = 'Also delete my settings, download queue and logs'; $chk.AutoSize = $true
    $chk.Location = New-Object System.Drawing.Point(22, 104); $form.Controls.Add($chk)
    $ok = New-Object System.Windows.Forms.Button; $ok.Text = 'Uninstall'; $ok.Size = New-Object System.Drawing.Size(100, 30)
    $ok.Location = New-Object System.Drawing.Point(244, 144); $ok.DialogResult = 'OK'; $form.Controls.Add($ok); $form.AcceptButton = $ok
    $no = New-Object System.Windows.Forms.Button; $no.Text = 'Cancel'; $no.Size = New-Object System.Drawing.Size(100, 30)
    $no.Location = New-Object System.Drawing.Point(352, 144); $no.DialogResult = 'Cancel'; $form.Controls.Add($no); $form.CancelButton = $no
    if ($form.ShowDialog() -ne 'OK') { exit 0 }
    $RemoveData = $chk.Checked
}

# stop it
try { Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:9666/api/quit' -Headers @{ 'X-VidQueue' = '1' } -ContentType 'application/json' -Body '{}' -TimeoutSec 3 | Out-Null } catch {}
$deadline = (Get-Date).AddSeconds(15)
do {
    $procs = @(Get-CimInstance Win32_Process -Filter "Name='$exeName'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installDir, [System.StringComparison]::OrdinalIgnoreCase) })
    if ($procs) { Start-Sleep -Milliseconds 300 }
} while ($procs -and (Get-Date) -lt $deadline)
$procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# registry, shortcut, files
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'VidQueue' -ErrorAction SilentlyContinue
Remove-Item -Path 'HKCU:\Software\Mozilla\NativeMessagingHosts\com.cannontech.vidqueue' -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\VidQueue' -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('Programs')) 'VidQueue.lnk') -Force -ErrorAction SilentlyContinue
for ($i = 0; $i -lt 10 -and (Test-Path -LiteralPath $installDir); $i++) {
    Remove-Item -LiteralPath $installDir -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $installDir) { Start-Sleep -Milliseconds 500 }
}
if ($RemoveData) { Remove-Item -LiteralPath $dataDir -Recurse -Force -ErrorAction SilentlyContinue }

if (-not $Quiet) {
    $msg = 'VidQueue was removed.'
    if (Test-Path -LiteralPath $installDir) { $msg += "`r`n`r`nSome files could not be deleted:`r`n$installDir" }
    [System.Windows.Forms.MessageBox]::Show($msg, 'Uninstall VidQueue', 'OK', 'Information') | Out-Null
}
exit 0
