@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0remove.ps1" %*
pause
