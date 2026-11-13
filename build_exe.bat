@echo off
setlocal
cd /d "%~dp0"
rem Builds the Windows release package (dist\VidQueue-<version>-windows.zip),
rem the extension upload zip for addons.mozilla.org and updates.json.
rem See build_release.ps1 for the steps and options.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0build_release.ps1" %*
exit /b %ERRORLEVEL%
