@echo off
setlocal
cd /d "%~dp0"
rem Packaged layout: this .bat sits next to app\ and setup\.
if exist "%~dp0app\VidQueue.exe" if exist "%~dp0setup\install_windows.vbs" goto run
rem Anything else is the source code (e.g. GitHub's "Source code (zip)"), which has no VidQueue.exe.
echo.
echo  This folder is the VidQueue source code, not the installer package.
echo.
echo  Download VidQueue-^<version^>-windows.zip from
echo    https://github.com/MY7H1CC0D3/vidqueue/releases/latest
echo  (not "Source code"), right-click it, choose Extract All,
echo  then run "Install VidQueue.bat" in the extracted folder.
echo.
start "" "https://github.com/MY7H1CC0D3/vidqueue/releases/latest"
pause
exit /b 1
:run
rem Starts the setup UI through WScript so no console window stays open.
start "" wscript.exe "%~dp0setup\install_windows.vbs"
exit /b 0
