@echo off
rem Double-click to remove the StreamSnag helper (or remove it from Settings, Apps, Installed apps).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0files\setup.ps1" -Uninstall
echo.
pause
