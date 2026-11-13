@echo off
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='pythonw.exe' OR Name='python.exe'\" | Where-Object { $_.CommandLine -like '*vidqueue.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; 'Stopped VidQueue (pid ' + $_.ProcessId + ')' }"
