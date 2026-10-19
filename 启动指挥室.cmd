@echo off
REM ===========================================================================
REM  Command Center - desktop launcher
REM
REM  Double-click to use. It does three things:
REM    1. starts the control-room service in the background if it is not running
REM    2. waits until the port answers
REM    3. opens a standalone window (no address bar, no tabs) via Chrome/Edge
REM
REM  Pass --console to watch the server log while it boots.
REM
REM  NOTE: keep this file ASCII-only. Chinese text in a .cmd file gets mangled
REM  under the console's ANSI code page, and caret line-continuation is fragile,
REM  so all real logic lives in scripts\service.ps1.
REM ===========================================================================
setlocal EnableExtensions
cd /d "%~dp0"

set "PORT=8787"
set "URL=http://127.0.0.1:%PORT%"

echo.
echo   ============================================
echo    Command Center
echo   ============================================

REM -- start (or confirm) the background service -------------------------------
set "CONSOLE_FLAG="
if /i "%~1"=="--console" set "CONSOLE_FLAG=-Console"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\service.ps1" %CONSOLE_FLAG%
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)

REM -- open the window ----------------------------------------------------------
REM open-window.ps1 reads data\.token and opens an app-mode window with the
REM tokenised URL, so the shared-token auth works without typing anything.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\open-window.ps1" -Port %PORT%
if errorlevel 1 (
  echo.
  echo   Failed to open the window. Open the URL manually.
  pause
  exit /b 1
)

exit /b 0
