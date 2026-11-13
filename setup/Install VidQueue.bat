@echo off
setlocal
cd /d "%~dp0"
rem Starts the setup UI through WScript so no console window stays open.
start "" wscript.exe "%~dp0setup\install_windows.vbs"
exit /b 0
