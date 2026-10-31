@echo off
title Building Echo Board
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Opening the download page...
  start https://nodejs.org
  echo Install the LTS version, then double-click this file again.
  pause
  exit /b 1
)
echo Installing packages (first time takes a few minutes)...
call npm install
if errorlevel 1 goto fail
echo Building the Windows installer (includes voices + VB-CABLE, about 110 MB to download)...
call npm run dist:win
if errorlevel 1 goto fail
echo.
echo Done! Opening the folder with Echo-Board-Setup.exe ...
start "" "%~dp0dist"
pause
exit /b 0
:fail
echo.
echo Something went wrong. Copy the messages above and send them to Claude.
pause
exit /b 1
