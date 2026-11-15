<#
Builds the VidQueue Windows release (same approach as JAVScout's build).

  powershell -NoProfile -ExecutionPolicy Bypass -File build_release.ps1

Output (in dist\):
  VidQueue-<version>-windows\          unpacked package (Install VidQueue.bat, setup\, app\ with VidQueue.exe + ffmpeg)
  VidQueue-<version>-windows.zip       the package to share
  VidQueue-<version>-windows.zip.sha256
  vidqueue-extension-<version>.zip     upload to addons.mozilla.org (unlisted) for signing
  updates.json                         upload to the GitHub release (extension auto-update)

If the signed extension is already at dist\vidqueue-<version>.xpi, it is
copied into the package. Otherwise build, sign the extension zip on AMO, save
the .xpi there and build again (or copy it into the package folder by hand).

Steps:
  1. the version in app\vidqueue.py, extension\manifest.json and
     version_info.txt must agree
  2. the working tree must be committed (-AllowDirty to override)
  3. a fresh build venv gets the exact versions in requirements-build.txt,
     with PyInstaller built from its source release so its bootloader is
     compiled here (needs Visual Studio's C++ tools; -StockBootloader skips)
  4. PyInstaller builds VidQueue.exe; ffmpeg is copied next to it
  5. VidQueue.exe --smoke-test checks the frozen build against a throwaway
     data folder, and Microsoft Defender scans it (a detection fails the build)
  6. the extension zip, updates.json and the package are assembled and hashed
#>
param(
    [switch]$AllowDirty,
    [switch]$StockBootloader,
    [string]$FfmpegDir = ''
)

$PyInstallerSdistSha256 = @{
    '6.22.3' = '05eb2f5615503e72939a7224d68b4aff572c6b0438ee4a17d0a4b481f399362d'
}
$GitHubRepo = 'MY7H1CC0D3/vidqueue'
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }
# Zip with forward-slash entry names (AMO rejects "icons\icon.png"). Windows
# PowerShell 5.1 runs ZipFile.CreateFromDirectory in a legacy mode that writes
# backslashes, so entries are added one by one.
function New-Zip([string]$sourceDir, [string]$zipPath, [string]$prefix = '') {
    if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
    $base = (Resolve-Path -LiteralPath $sourceDir).Path.TrimEnd('\') + '\'
    $archive = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in Get-ChildItem -LiteralPath $sourceDir -Recurse -File) {
            $name = $prefix + $file.FullName.Substring($base.Length).Replace('\', '/')
            [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, $name, [System.IO.Compression.CompressionLevel]::Optimal)
        }
    } finally { $archive.Dispose() }
    $check = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
    try { $bad = @($check.Entries | Where-Object { $_.FullName.Contains('\') }) } finally { $check.Dispose() }
    if ($bad) { throw "Zip $zipPath has backslash entry names: $($bad[0].FullName)" }
}
function Invoke-Checked([string]$exe, [string[]]$arguments) {
    & $exe @arguments
    if ($LASTEXITCODE -ne 0) { throw "Command failed with exit code ${LASTEXITCODE}: $exe $($arguments -join ' ')" }
}
function Import-MsvcEnvironment {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path $vswhere)) { throw 'Visual Studio is not installed. Install its C++ build tools, or pass -StockBootloader.' }
    $vs = @(& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)[0]
    if (-not $vs) { throw "Visual Studio's C++ x64 build tools are not installed. Add them, or pass -StockBootloader." }
    $vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'
    $env:PATH = (Split-Path $vswhere) + ';' + $env:PATH
    $lines = cmd /c "`"$vcvars`" >nul 2>&1 && set"
    if ($LASTEXITCODE -ne 0) { throw "vcvars64.bat failed (exit code $LASTEXITCODE)." }
    foreach ($line in $lines) { if ($line -match '^([^=]+)=(.*)$') { Set-Item -Path "Env:$($Matches[1])" -Value $Matches[2] } }
}

# 1. One version number
$appText = [System.IO.File]::ReadAllText((Join-Path $root 'app\vidqueue.py'))
if ($appText -notmatch '(?m)^VERSION\s*=\s*"(\d+)\.(\d+)\.(\d+)"') { throw 'app\vidqueue.py has no x.y.z VERSION.' }
$version = "$($Matches[1]).$($Matches[2]).$($Matches[3])"
$fixed = "($($Matches[1]),$($Matches[2]),$($Matches[3]),0)"
$manifest = [System.IO.File]::ReadAllText((Join-Path $root 'extension\manifest.json')) | ConvertFrom-Json
if ($manifest.version -ne $version) { throw "extension\manifest.json is version $($manifest.version), app is $version." }
$info = [System.IO.File]::ReadAllText((Join-Path $root 'version_info.txt'))
foreach ($needle in @("filevers=$fixed", "prodvers=$fixed", "'FileVersion','$version'", "'ProductVersion','$version'")) {
    if (-not $info.Contains($needle)) { throw "version_info.txt does not match version ${version}: missing $needle" }
}
$extId = $manifest.browser_specific_settings.gecko.id
Step "Building VidQueue $version"

# 2. Committed source
$commit = (git rev-parse HEAD).Trim()
$dirty = [bool](git status --porcelain)
if ($dirty -and -not $AllowDirty) { throw 'The working tree has uncommitted changes. Commit them, or pass -AllowDirty for a test build.' }

# ffmpeg to bundle
if (-not $FfmpegDir) {
    $found = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages') -Directory -Filter 'Gyan.FFmpeg*' -ErrorAction SilentlyContinue |
        ForEach-Object { Get-ChildItem $_.FullName -Directory } | Where-Object { Test-Path (Join-Path $_.FullName 'bin\ffmpeg.exe') } | Select-Object -First 1
    if (-not $found) { throw 'ffmpeg not found. Install it (winget install Gyan.FFmpeg) or pass -FfmpegDir <folder with bin\ffmpeg.exe>.' }
    $FfmpegDir = $found.FullName
}
$ffmpegExe = Join-Path $FfmpegDir 'bin\ffmpeg.exe'
$ffmpegLicense = Join-Path $FfmpegDir 'LICENSE'
if (-not (Test-Path $ffmpegExe)) { throw "No bin\ffmpeg.exe in $FfmpegDir" }

# 3. Clean build environment with pinned versions
$devPython = Join-Path $root '.venv\Scripts\python.exe'
if (-not (Test-Path $devPython)) { throw '.venv is missing. Create it first (see README).' }
$buildRoot = Join-Path $root 'build\release'
if (Test-Path $buildRoot) { Remove-Item -LiteralPath $buildRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path $buildRoot | Out-Null
$basePython = (& $devPython -c "import sys, os; print(os.path.join(sys.base_prefix, 'python.exe'))").Trim()
Step "Creating the build environment from $basePython"
$venv = Join-Path $buildRoot 'venv'
Invoke-Checked $basePython @('-m', 'venv', $venv)
$buildPython = Join-Path $venv 'Scripts\python.exe'
$requirements = Join-Path $root 'requirements-build.txt'
# PyInstaller's prebuilt bootloader is shared with a lot of malware and gets
# flagged by Defender's ML model (JAVScout 5.5.2 was); one compiled here from
# the same source release is unique to these builds.
if ([System.IO.File]::ReadAllText($requirements) -notmatch '(?m)^pyinstaller==([0-9.]+)\s*$') { throw 'requirements-build.txt does not pin pyinstaller.' }
$pyiVersion = $Matches[1]
if ($StockBootloader) {
    $bootloader = 'stock (prebuilt by PyInstaller)'
} else {
    $expected = $PyInstallerSdistSha256[$pyiVersion]
    if (-not $expected) { throw "No SHA-256 recorded for the PyInstaller $pyiVersion source release; add it to `$PyInstallerSdistSha256." }
    Step "Compiling the PyInstaller $pyiVersion bootloader"
    Import-MsvcEnvironment
    $sdistDir = Join-Path $buildRoot 'pyinstaller-sdist'
    Invoke-Checked $buildPython @('-m', 'pip', 'download', '--quiet', '--disable-pip-version-check', '--no-deps', '--no-binary', ':all:', "pyinstaller==$pyiVersion", '-d', $sdistDir)
    $sdist = Join-Path $sdistDir "pyinstaller-$pyiVersion.tar.gz"
    $actual = (Get-FileHash -LiteralPath $sdist -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $expected) { throw "The PyInstaller $pyiVersion source download has SHA-256 $actual, expected $expected." }
    $env:PYINSTALLER_COMPILE_BOOTLOADER = '1'
    try {
        Invoke-Checked $buildPython @('-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', $sdist)
    } finally { Remove-Item Env:PYINSTALLER_COMPILE_BOOTLOADER }
    $bootloader = "compiled here with MSVC $env:VCToolsVersion from pyinstaller-$pyiVersion.tar.gz (SHA-256 $expected)"
}
Invoke-Checked $buildPython @('-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '-r', $requirements)
$runw = (& $buildPython -c "import os, PyInstaller; print(os.path.join(os.path.dirname(PyInstaller.__file__), 'bootloader', 'Windows-64bit-intel', 'runw.exe'))").Trim()
$bootloader += "; runw.exe SHA-256 $((Get-FileHash -LiteralPath $runw -Algorithm SHA256).Hash.ToLower())"

# 4. PyInstaller
Step 'Running PyInstaller'
$dist = Join-Path $buildRoot 'dist'
Invoke-Checked $buildPython @('-m', 'PyInstaller', '--noconfirm', '--clean', '--windowed', '--log-level', 'WARN',
    '--name', 'VidQueue', '--icon', (Join-Path $root 'assets\vidqueue.ico'),
    '--version-file', (Join-Path $root 'version_info.txt'),
    '--add-data', ((Join-Path $root 'app\dashboard.html') + ';.'),
    '--add-data', ((Join-Path $root 'EULA.txt') + ';.'),
    '--add-data', ((Join-Path $root 'assets\vidqueue.png') + ';assets'),
    '--hidden-import', 'pystray._win32', '--collect-submodules', 'yt_dlp',
    '--copy-metadata', 'pystray', '--copy-metadata', 'Pillow', '--copy-metadata', 'yt-dlp',
    '--distpath', $dist, '--workpath', (Join-Path $buildRoot 'work'), '--specpath', (Join-Path $buildRoot 'spec'),
    (Join-Path $root 'app\vidqueue.py'))
$app = Join-Path $dist 'VidQueue'
$exe = Join-Path $app 'VidQueue.exe'
if (-not (Test-Path $exe)) { throw 'PyInstaller did not produce VidQueue.exe.' }
New-Item -ItemType Directory -Force -Path (Join-Path $app 'ffmpeg') | Out-Null
Copy-Item -LiteralPath $ffmpegExe -Destination (Join-Path $app 'ffmpeg\ffmpeg.exe')
if (Test-Path $ffmpegLicense) { Copy-Item -LiteralPath $ffmpegLicense -Destination (Join-Path $app 'ffmpeg\LICENSE.txt') }

# 5. Smoke test the frozen exe against a throwaway data folder
Step 'Smoke-testing VidQueue.exe'
$sandbox = Join-Path $buildRoot 'smoke-data'
New-Item -ItemType Directory -Force -Path $sandbox | Out-Null
$report = Join-Path $buildRoot 'smoke-test.json'
$env:VIDQUEUE_DATA = $sandbox
try {
    $p = Start-Process -FilePath $exe -ArgumentList @('--smoke-test', "`"$report`"") -PassThru -Wait -WindowStyle Hidden
} finally { Remove-Item Env:VIDQUEUE_DATA }
if (-not (Test-Path $report)) { throw "The smoke test wrote no report (exit code $($p.ExitCode))." }
$reportText = [System.IO.File]::ReadAllText($report)
Write-Host $reportText
$smoke = $reportText | ConvertFrom-Json
if ($p.ExitCode -ne 0 -or -not $smoke.ok -or $smoke.version -ne $version -or -not $smoke.frozen) { throw 'The smoke test failed.' }

Step 'Scanning the build with Microsoft Defender'
$mpcmd = Join-Path $env:ProgramFiles 'Windows Defender\MpCmdRun.exe'
if (Test-Path $mpcmd) {
    $scan = & $mpcmd -Scan -ScanType 3 -File $app -DisableRemediation
    $scanCode = $LASTEXITCODE
    if ($scanCode -eq 2) { throw "Microsoft Defender flags the build:`n$($scan -join "`n")" }
    if ($scanCode -ne 0) { throw "The Defender scan failed (exit code $scanCode):`n$($scan -join "`n")" }
    $defender = "no threats found (signatures $((Get-MpComputerStatus).AntivirusSignatureVersion))"
} else {
    Write-Warning 'Microsoft Defender is not available; the build was not scanned.'
    $defender = 'not scanned (Defender not available)'
}
Write-Host "Defender: $defender"

# 6. Extension zip + updates.json + package
$outRoot = Join-Path $root 'dist'
New-Item -ItemType Directory -Force -Path $outRoot | Out-Null

Step 'Packing the extension for addons.mozilla.org'
$extZip = Join-Path $outRoot "vidqueue-extension-$version.zip"
New-Zip (Join-Path $root 'extension') $extZip

$xpiName = "vidqueue-$version.xpi"
$updates = [ordered]@{ addons = [ordered]@{ $extId = [ordered]@{ updates = @([ordered]@{
    version = $version
    update_link = "https://github.com/$GitHubRepo/releases/download/v$version/$xpiName"
}) } } }
[System.IO.File]::WriteAllText((Join-Path $outRoot 'updates.json'), ($updates | ConvertTo-Json -Depth 8), $utf8)

$name = "VidQueue-$version-windows"
$pkg = Join-Path $outRoot $name
$zip = Join-Path $outRoot "$name.zip"
Step "Assembling $name"
foreach ($old in @($pkg, $zip, "$zip.sha256")) { if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Recurse -Force } }
New-Item -ItemType Directory -Force -Path $pkg, (Join-Path $pkg 'setup') | Out-Null
Copy-Item -LiteralPath $app -Destination (Join-Path $pkg 'app') -Recurse
foreach ($f in @('EULA.txt', 'START_HERE.txt')) { Copy-Item -LiteralPath (Join-Path $root $f) -Destination (Join-Path $pkg $f) }
Copy-Item -LiteralPath (Join-Path $root 'setup\Install VidQueue.bat') -Destination (Join-Path $pkg 'Install VidQueue.bat')
foreach ($f in @('install_windows.ps1', 'install_windows.vbs', 'uninstall_windows.ps1')) {
    Copy-Item -LiteralPath (Join-Path $root "setup\$f") -Destination (Join-Path $pkg "setup\$f")
}
foreach ($f in @('vidqueue.ico', 'vidqueue.png')) { Copy-Item -LiteralPath (Join-Path $root "assets\$f") -Destination (Join-Path $pkg "setup\$f") }
$signedXpi = Join-Path $outRoot $xpiName
if (Test-Path $signedXpi) {
    Copy-Item -LiteralPath $signedXpi -Destination (Join-Path $pkg $xpiName)
    $xpiNote = "included ($xpiName)"
} else {
    Write-Warning "No signed $xpiName in dist\ yet: the package has no extension. Sign $([IO.Path]::GetFileName($extZip)) on AMO, save the .xpi as dist\$xpiName and rebuild."
    $xpiNote = 'NOT included (not signed yet)'
}

$exeHash = (Get-FileHash -LiteralPath (Join-Path $pkg 'app\VidQueue.exe') -Algorithm SHA256).Hash.ToLower()
$freeze = (& $buildPython -m pip freeze --disable-pip-version-check) -join "`r`n"
$pyVersion = (& $buildPython -c "import sys; print(sys.version)").Trim()
# The package is public: no build-PC paths, user name or computer name in it
function Hide-LocalPaths([string]$text) {
    foreach ($p in @($root, $env:USERPROFILE, $env:LOCALAPPDATA)) {
        if (-not $p) { continue }
        foreach ($form in @($p, $p.Replace('\', '\\'), $p.Replace('\', '/'))) {
            $text = [regex]::Replace($text, [regex]::Escape($form), '<build>', 'IgnoreCase')
        }
    }
    return $text
}
$buildManifest = @(
    "VidQueue $version",
    "Built      $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz'))",
    "Commit     $commit$(if ($dirty) { ' (with uncommitted changes)' })",
    "Python     $pyVersion",
    "VidQueue.exe SHA-256 $exeHash",
    "Bootloader $bootloader",
    "FFmpeg     $($smoke.checks.ffmpeg.detail)",
    "Extension  $xpiNote",
    "Defender   $defender",
    '',
    'Build packages (pip freeze):',
    $freeze,
    '',
    'Smoke test:',
    $reportText
) -join "`r`n"
[System.IO.File]::WriteAllText((Join-Path $pkg 'BUILD-MANIFEST.txt'), (Hide-LocalPaths $buildManifest), $utf8)

Step 'Checking the package for build-PC paths and names'
$leakWords = @($root, $env:USERPROFILE, $env:USERNAME, $env:COMPUTERNAME) | Where-Object { $_ -and $_.Length -ge 3 }
$leakForms = foreach ($w in $leakWords) { $w; $w.Replace('\', '\\'); $w.Replace('\', '/') }
$leakRx = [regex]((($leakForms | Select-Object -Unique) | ForEach-Object { [regex]::Escape($_) }) -join '|')
$leakRx = [regex]::new($leakRx.ToString(), 'IgnoreCase')
$latin1 = [Text.Encoding]::GetEncoding(28591)
$leaks = Get-ChildItem -LiteralPath $pkg -Recurse -File | Where-Object { $_.FullName -notlike "*\app\ffmpeg\*" } | Where-Object {
    $b = [IO.File]::ReadAllBytes($_.FullName)
    $leakRx.IsMatch($latin1.GetString($b)) -or $leakRx.IsMatch([Text.Encoding]::Unicode.GetString($b))
}
if ($leaks) { throw "These package files contain build-PC paths or names:`n$(($leaks.FullName) -join "`n")" }

Step "Zipping $name.zip"
New-Zip $pkg $zip   # files at the zip root: Extract All already makes the VidQueue-<v>-windows folder
$zipHash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower()
[System.IO.File]::WriteAllText("$zip.sha256", "$zipHash  $name.zip`n", $utf8)

Step 'Done'
Write-Host "Package:   $zip"
Write-Host "SHA-256:   $zipHash"
Write-Host ("Size:      {0:N1} MB" -f ((Get-Item $zip).Length / 1MB))
Write-Host "Extension: $extZip  (sign on AMO as unlisted)"
Write-Host "Updates:   $(Join-Path $outRoot 'updates.json')"
Write-Host "Signed .xpi in package: $xpiNote"
