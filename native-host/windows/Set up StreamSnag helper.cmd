@echo off
rem Double-click to set up the StreamSnag helper (no admin rights needed).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0files\setup.ps1" %*
echo.
pause
