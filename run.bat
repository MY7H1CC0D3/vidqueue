@echo off
rem VidQueue launcher. "run.bat /quiet" = start without opening the dashboard (used at login).
cd /d "%~dp0"
".venv\Scripts\python.exe" -m pip install -q -U yt-dlp >nul 2>&1
start "" ".venv\Scripts\pythonw.exe" app\vidqueue.py
if /i "%~1"=="/quiet" exit /b 0
timeout /t 2 /nobreak >nul
start "" http://127.0.0.1:9666/
