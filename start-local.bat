@echo off
rem Double-click this file to try the game on this PC.
rem It starts a small web server and opens http://localhost:8000/ in your browser.
rem Close this window (or press Ctrl + C) to stop the server.

cd /d "%~dp0"

rem Use the Python launcher (py) if it exists, otherwise use python.
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 tools\serve.py 8000 --open
) else (
  python tools\serve.py 8000 --open
)

echo.
pause
