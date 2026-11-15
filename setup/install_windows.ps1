<#
VidQueue setup (per-user, no admin), modelled on JAVScout's installer.

Installs the packaged app from ..\app into %LOCALAPPDATA%\Programs\VidQueue,
registers it with Firefox (native messaging, like Video DownloadHelper's
companion app) so the extension can start it, and offers:
  - Start with Windows (forces the tray icon on)
  - Show tray icon
  - Install the Firefox extension (opens the signed .xpi in Firefox)

Silent use (tests / scripted installs):
  install_windows.ps1 -AutoInstall [-StartWithWindows] [-Tray] [-NoExtension]

One-click update (started by VidQueue itself from the dashboard):
  install_windows.ps1 -Update
  runs without asking, keeps the current choices, leaves the Firefox extension
  alone (Firefox updates it) and starts VidQueue again afterwards.
#>
param(
    [switch]$AutoInstall,
    [switch]$StartWithWindows,
    [switch]$Tray,
    [switch]$NoExtension,
    [switch]$Update,
    [string]$Screenshot = ''   # test aid: render the window to a PNG and exit
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$setupDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$pkg        = Split-Path -Parent $setupDir
$appSrc     = Join-Path $pkg 'app'
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\VidQueue'
$dataDir    = Join-Path $env:LOCALAPPDATA 'VidQueue'
$exeName    = 'VidQueue.exe'
$nativeName = 'com.cannontech.vidqueue'
$extId      = 'vidqueue@local.ext'
$runKey     = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$uninstKey  = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\VidQueue'
$utf8       = New-Object System.Text.UTF8Encoding($false)

function Fail($msg) {
    if ($AutoInstall) { Write-Error $msg } else {
        [System.Windows.Forms.MessageBox]::Show($msg, 'VidQueue Setup', 'OK', 'Error') | Out-Null
    }
    exit 1
}

$srcExe = Join-Path $appSrc $exeName
if (-not (Test-Path -LiteralPath $srcExe)) { Fail "This setup package is incomplete: app\$exeName is missing.`r`n`r`nFolder: $pkg" }
$version = (Get-Item -LiteralPath $srcExe).VersionInfo.ProductVersion
$xpi = Get-ChildItem -LiteralPath $pkg -Filter 'vidqueue-*.xpi' -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -Last 1

# previous choices (re-install / update keeps them)
$prevAuto = $false
try { $null = Get-ItemPropertyValue -Path $runKey -Name 'VidQueue'; $prevAuto = $true } catch {}
$prevTray = $false
$settingsFile = Join-Path $dataDir 'settings.json'
if (Test-Path -LiteralPath $settingsFile) {
    try { $prevTray = [bool](([System.IO.File]::ReadAllText($settingsFile) | ConvertFrom-Json).tray) } catch {}
}
$installed = Test-Path -LiteralPath (Join-Path $installDir $exeName)

# ------------------------------------------------------------------ UI
$form = New-Object System.Windows.Forms.Form
$form.Text = $(if ($Update) { 'Updating VidQueue' } else { 'VidQueue Setup' })
$form.StartPosition = 'CenterScreen'
$form.ClientSize = New-Object System.Drawing.Size(620, 430)
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.Font = New-Object System.Drawing.Font('Segoe UI', 9.5)
try { $form.Icon = New-Object System.Drawing.Icon((Join-Path $setupDir 'vidqueue.ico')) } catch {}

try {
    $pic = New-Object System.Windows.Forms.PictureBox
    $pic.Image = [System.Drawing.Image]::FromFile((Join-Path $setupDir 'vidqueue.png'))
    $pic.SizeMode = 'Zoom'; $pic.Size = New-Object System.Drawing.Size(64, 64); $pic.Location = New-Object System.Drawing.Point(24, 20)
    $form.Controls.Add($pic)
} catch {}

function Add-Label($text, $x, $y, $size, $bold) {
    $l = New-Object System.Windows.Forms.Label
    $l.Text = $text; $l.AutoSize = $true; $l.Location = New-Object System.Drawing.Point($x, $y)
    $style = if ($bold) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }
    $l.Font = New-Object System.Drawing.Font('Segoe UI', $size, $style)
    $form.Controls.Add($l); return $l
}
$null = Add-Label "VidQueue $version" 100 22 17 $true
$null = Add-Label 'Queue videos from Firefox, with a per-site download limit' 102 58 10 $false
$null = Add-Label ("Install location:  $installDir" + $(if ($installed) { '   (will be updated)' } else { '' })) 26 104 9 $false

$chkAuto = New-Object System.Windows.Forms.CheckBox
$chkAuto.Text = 'Start with Windows  (VidQueue keeps running in the background)'
$chkAuto.AutoSize = $true; $chkAuto.Location = New-Object System.Drawing.Point(28, 140)
$form.Controls.Add($chkAuto)

$chkTray = New-Object System.Windows.Forms.CheckBox
$chkTray.Text = 'Show tray icon'
$chkTray.AutoSize = $true; $chkTray.Location = New-Object System.Drawing.Point(28, 168)
$form.Controls.Add($chkTray)
$trayHint = Add-Label '' 160 170 8.5 $false
$trayHint.ForeColor = [System.Drawing.Color]::DimGray

$chkExt = New-Object System.Windows.Forms.CheckBox
$chkExt.AutoSize = $true; $chkExt.Location = New-Object System.Drawing.Point(28, 196)
if ($xpi) { $chkExt.Text = "Install the Firefox extension  ($($xpi.Name))"; $chkExt.Checked = $true }
else { $chkExt.Text = 'Install the Firefox extension  (not included in this package)'; $chkExt.Enabled = $false }
$form.Controls.Add($chkExt)

$info = Add-Label ("Firefox starts VidQueue automatically when it's needed (the same way Video`r`n" +
    "DownloadHelper's companion app works). Without 'Start with Windows' it closes itself`r`n" +
    "after Firefox exits, once any videos it was finishing are saved.") 26 232 9 $false
$info.ForeColor = [System.Drawing.Color]::DimGray

$eula = New-Object System.Windows.Forms.LinkLabel
$eula.Text = 'By installing you agree to the license agreement.'
$eula.LinkArea = New-Object System.Windows.Forms.LinkArea(32, 17)
$eula.AutoSize = $true; $eula.Location = New-Object System.Drawing.Point(26, 296)
$eula.Add_LinkClicked({ Start-Process notepad.exe (Join-Path $pkg 'EULA.txt') })
$form.Controls.Add($eula)

$status = Add-Label '' 26 330 9 $false
$progress = New-Object System.Windows.Forms.ProgressBar
$progress.Location = New-Object System.Drawing.Point(26, 352); $progress.Size = New-Object System.Drawing.Size(568, 14)
$form.Controls.Add($progress)

$btnInstall = New-Object System.Windows.Forms.Button
$btnInstall.Text = $(if ($installed) { 'Update' } else { 'Install' })
$btnInstall.Size = New-Object System.Drawing.Size(100, 30); $btnInstall.Location = New-Object System.Drawing.Point(388, 384)
$form.Controls.Add($btnInstall); $form.AcceptButton = $btnInstall
$btnCancel = New-Object System.Windows.Forms.Button
$btnCancel.Text = 'Cancel'
$btnCancel.Size = New-Object System.Drawing.Size(100, 30); $btnCancel.Location = New-Object System.Drawing.Point(494, 384)
$btnCancel.Add_Click({ $form.Close() })
$form.Controls.Add($btnCancel); $form.CancelButton = $btnCancel

# Start with Windows => tray icon on and locked
function Sync-Tray {
    if ($chkAuto.Checked) {
        $chkTray.Checked = $true; $chkTray.Enabled = $false
        $trayHint.Text = '(always on while VidQueue starts with Windows)'
    } else {
        $chkTray.Enabled = $true
        $trayHint.Text = '(optional; without it VidQueue runs hidden)'
    }
}
$chkAuto.Add_CheckedChanged({ Sync-Tray })
if ($AutoInstall) { $chkAuto.Checked = [bool]$StartWithWindows; $chkTray.Checked = [bool]$Tray; if ($NoExtension) { $chkExt.Checked = $false } }
else { $chkAuto.Checked = $prevAuto; $chkTray.Checked = ($prevTray -or $prevAuto) }
if ($Update) { $chkExt.Checked = $false }
Sync-Tray

function Set-Step($text, $value) {
    $status.Text = $text; $progress.Value = [Math]::Min(100, [Math]::Max(0, $value))
    $form.Refresh(); [System.Windows.Forms.Application]::DoEvents()
    if ($AutoInstall) { Write-Host $text }
}

# ------------------------------------------------------------- install
function Stop-VidQueue {
    try {
        Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:9666/api/quit' -Headers @{ 'X-VidQueue' = '1' } -ContentType 'application/json' -Body '{}' -TimeoutSec 3 | Out-Null
    } catch {}
    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $deadline) {
        $running = @(Get-CimInstance Win32_Process -Filter "Name='$exeName'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installDir, [System.StringComparison]::OrdinalIgnoreCase) })
        if (-not $running) { return }
        Start-Sleep -Milliseconds 300; [System.Windows.Forms.Application]::DoEvents()
    }
    Get-CimInstance Win32_Process -Filter "Name='$exeName'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installDir, [System.StringComparison]::OrdinalIgnoreCase) } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 500
}

function Find-Firefox {
    foreach ($k in 'HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe') {
        try { $p = (Get-ItemProperty -Path $k).'(default)'; if ($p -and (Test-Path -LiteralPath $p)) { return $p } } catch {}
    }
    foreach ($p in "$env:ProgramFiles\Mozilla Firefox\firefox.exe", "${env:ProgramFiles(x86)}\Mozilla Firefox\firefox.exe") { if (Test-Path -LiteralPath $p) { return $p } }
    return $null
}

$script:done = $false
$btnInstall.Add_Click({
    $btnInstall.Enabled = $false; $btnCancel.Enabled = $false
    foreach ($c in @($chkAuto, $chkTray, $chkExt)) { $c.Enabled = $false }
    try {
        $wantAuto = $chkAuto.Checked; $wantTray = ($chkTray.Checked -or $wantAuto)
        Set-Step 'Closing VidQueue if it is running...' 5
        Stop-VidQueue

        Set-Step 'Copying files...' 20
        New-Item -ItemType Directory -Force -Path $installDir | Out-Null
        # No /XF here: robocopy matches excluded names at every depth, so excluding
        # the root's EULA.txt/vidqueue.png also dropped _internal\EULA.txt and
        # _internal\assets\vidqueue.png (the dashboard/About picture). /MIR purges the
        # root-only files below, and they are all written again straight after.
        & robocopy.exe $appSrc $installDir /MIR /R:3 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
        if ($LASTEXITCODE -ge 8) { throw "Copying the program files failed (robocopy exit code $LASTEXITCODE)." }
        Copy-Item -LiteralPath (Join-Path $setupDir 'uninstall_windows.ps1') -Destination $installDir -Force
        Copy-Item -LiteralPath (Join-Path $setupDir 'vidqueue.ico') -Destination $installDir -Force
        Copy-Item -LiteralPath (Join-Path $pkg 'EULA.txt') -Destination $installDir -Force
        Get-ChildItem -LiteralPath $installDir -Filter 'vidqueue-*.xpi' | Remove-Item -Force
        if ($xpi) { Copy-Item -LiteralPath $xpi.FullName -Destination $installDir -Force }
        # A zip downloaded from the internet marks every extracted file as
        # "from the internet" (Zone.Identifier stream), which can make Windows
        # warn again when Firefox starts VidQueue. The user already chose to
        # install it, so clear the mark on the installed copy.
        Get-ChildItem -LiteralPath $installDir -Recurse -File | Unblock-File -ErrorAction SilentlyContinue
        $exe = Join-Path $installDir $exeName

        Set-Step 'Registering VidQueue with Firefox...' 55
        $manifestPath = Join-Path $installDir 'vidqueue-native.json'
        $manifest = [ordered]@{ name = $nativeName; description = 'VidQueue app launcher'; path = $exe; type = 'stdio'; allowed_extensions = @($extId) }
        [System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 4), $utf8)
        $nk = "HKCU:\Software\Mozilla\NativeMessagingHosts\$nativeName"
        New-Item -Path $nk -Force | Out-Null
        Set-Item -Path $nk -Value $manifestPath

        Set-Step 'Saving your choices...' 65
        New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
        $settings = New-Object PSObject
        if (Test-Path -LiteralPath $settingsFile) { try { $settings = [System.IO.File]::ReadAllText($settingsFile) | ConvertFrom-Json } catch {} }
        $settings | Add-Member -NotePropertyName 'tray' -NotePropertyValue ([bool]$wantTray) -Force
        [System.IO.File]::WriteAllText($settingsFile, ($settings | ConvertTo-Json -Depth 6), $utf8)
        if ($wantAuto) { New-ItemProperty -Path $runKey -Name 'VidQueue' -Value "`"$exe`" --autostart" -PropertyType String -Force | Out-Null }
        else { Remove-ItemProperty -Path $runKey -Name 'VidQueue' -ErrorAction SilentlyContinue }

        Set-Step 'Creating the Start menu shortcut...' 75
        $ws = New-Object -ComObject WScript.Shell
        $lnk = $ws.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Programs')) 'VidQueue.lnk'))
        $lnk.TargetPath = $exe; $lnk.WorkingDirectory = $installDir; $lnk.IconLocation = $exe
        $lnk.Description = 'Open the VidQueue dashboard'; $lnk.Save()

        Set-Step 'Adding VidQueue to Installed apps...' 85
        New-Item -Path $uninstKey -Force | Out-Null
        $sizeKb = [int]((Get-ChildItem -LiteralPath $installDir -Recurse -File | Measure-Object Length -Sum).Sum / 1KB)
        $uninstCmd = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$(Join-Path $installDir 'uninstall_windows.ps1')`""
        $props = @{ DisplayName = 'VidQueue'; DisplayVersion = $version; Publisher = 'Cannon Technologies'; DisplayIcon = $exe
                    InstallLocation = $installDir; UninstallString = $uninstCmd; QuietUninstallString = "$uninstCmd -Quiet"
                    URLInfoAbout = 'https://github.com/MY7H1CC0D3/vidqueue' }
        foreach ($k in $props.Keys) { New-ItemProperty -Path $uninstKey -Name $k -Value $props[$k] -PropertyType String -Force | Out-Null }
        foreach ($k in 'NoModify', 'NoRepair') { New-ItemProperty -Path $uninstKey -Name $k -Value 1 -PropertyType DWord -Force | Out-Null }
        New-ItemProperty -Path $uninstKey -Name 'EstimatedSize' -Value $sizeKb -PropertyType DWord -Force | Out-Null

        if ($wantAuto) {
            Set-Step 'Starting VidQueue...' 92
            Start-Process -FilePath $exe -ArgumentList '--autostart' -WorkingDirectory $installDir
        } elseif ($Update) {
            # the dashboard that asked for the update reconnects by itself, so don't open another
            Set-Step 'Starting VidQueue...' 92
            Start-Process -FilePath $exe -ArgumentList '--no-open' -WorkingDirectory $installDir
        }
        $extNote = ''
        if ($chkExt.Checked -and $xpi) {
            $ff = Find-Firefox
            $installedXpi = Join-Path $installDir $xpi.Name
            if ($ff) {
                Set-Step 'Opening the extension in Firefox...' 96
                Start-Process -FilePath $ff -ArgumentList "`"$installedXpi`""
                $extNote = "`r`n`r`nFirefox is asking to add the VidQueue extension: click Add."
            } else {
                $extNote = "`r`n`r`nFirefox wasn't found. Install the extension by dragging this file into Firefox:`r`n$installedXpi"
            }
        }
        Set-Step 'Done.' 100
        $script:done = $true
        $how = if ($wantAuto) { 'VidQueue is running and will start with Windows.' } else { 'Firefox will start VidQueue automatically when it is needed.' }
        if (-not $AutoInstall -and -not $Update) {
            [System.Windows.Forms.MessageBox]::Show($form, "VidQueue $version is installed.`r`n`r`n$how$extNote", 'VidQueue Setup', 'OK', 'Information') | Out-Null
        }
        $form.Close()
    } catch {
        Set-Step "Setup failed: $($_.Exception.Message)" 0
        if ($AutoInstall) { Write-Error $_.Exception.Message; $form.Close() }
        else { [System.Windows.Forms.MessageBox]::Show($form, $_.Exception.Message, 'VidQueue Setup', 'OK', 'Error') | Out-Null }
        $btnInstall.Enabled = $true; $btnCancel.Enabled = $true; $chkAuto.Enabled = $true; $chkExt.Enabled = [bool]$xpi; Sync-Tray
    }
})

if ($AutoInstall -or $Update) { $form.Add_Shown({ $form.BeginInvoke([System.Windows.Forms.MethodInvoker]{ $btnInstall.PerformClick() }) | Out-Null }) }
if ($Screenshot) {
    $form.Opacity = 0
    $form.Add_Shown({
        $bmp = New-Object System.Drawing.Bitmap($form.Width, $form.Height)
        $form.DrawToBitmap($bmp, (New-Object System.Drawing.Rectangle(0, 0, $form.Width, $form.Height)))
        $bmp.Save($Screenshot, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose(); $form.Close()
    })
}
[void]$form.ShowDialog()
if ($AutoInstall -and -not $script:done) { exit 1 }
exit 0
