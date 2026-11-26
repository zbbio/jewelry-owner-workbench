@echo off
chcp 65001 >nul
cd /d "%~dp0"
"%~dp0runtime\python\python.exe" -I -B -X utf8 "%~dp0launcher.py" --stop
exit /b %errorlevel%
