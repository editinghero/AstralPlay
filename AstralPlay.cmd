@echo off
setlocal
cd /d "%~dp0"

set "PORT=3333"
set "HOST=0.0.0.0"

echo Starting AstralPlay on localhost and LAN...
echo.
echo Local: http://localhost:%PORT%
echo LAN:   check the server output below and open the LAN URL on your phone
echo.

start "" powershell -NoProfile -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:%env:PORT%'"
node server.js
