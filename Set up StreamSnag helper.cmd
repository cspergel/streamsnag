@echo off
rem Double-click this file to set up the optional StreamSnag helper on Windows.
rem It runs setup-windows.ps1 from this folder (no admin rights needed).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-windows.ps1"
echo.
pause
