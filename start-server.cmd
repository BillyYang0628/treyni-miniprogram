@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0server"

echo ==================================================
echo   Treyni backend  -  http://127.0.0.1:3000
echo ==================================================
echo.
echo   Keep this window OPEN while you use the app.
echo   Press Ctrl+C to stop the backend.
echo.
echo   If port 3000 is already in use, another backend
echo   window is still running - close it first.
echo.

node --env-file=.env src/server.js

echo.
echo [backend exited] The mini program will show
echo "cannot reach backend" until this runs again.
echo Copy the error above if you need help.
pause
