@echo off
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -File "%~dp0serve-mobile.ps1"
pause
