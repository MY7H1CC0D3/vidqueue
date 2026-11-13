# Starts VidQueue automatically at Windows login (quietly, no dashboard tab).
$startup = [Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'VidQueue.lnk'
$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut($lnk)
$s.TargetPath = Join-Path $PSScriptRoot 'run.bat'
$s.Arguments = '/quiet'
$s.WorkingDirectory = $PSScriptRoot
$s.WindowStyle = 7
$s.Save()
"Created $lnk"
