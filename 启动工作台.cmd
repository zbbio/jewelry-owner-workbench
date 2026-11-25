@echo off
cd /d "%~dp0"
echo Open http://127.0.0.1:4179/ in a local browser. Press Ctrl+C to stop.
node server.mjs
if errorlevel 1 pause
