@echo off
setlocal ENABLEEXTENSIONS ENABLEDELAYEDEXPANSION

REM Change to this script's directory
cd /d "%~dp0"

REM Ensure dependencies are installed (only if node_modules is missing)
if not exist "node_modules" (
  echo [Setup] Installing dependencies...
  call npm install --no-fund --no-audit --omit=dev
)

REM Check if UI is already running on http://localhost:3000
powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing http://localhost:3000 -TimeoutSec 2) ^| Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 (
  echo [Start] Launching UI server on port 3000...
  start "Braintree Auto UI" /min cmd /c "node runner.js"
  REM Give the server a moment to bind
  timeout /t 3 >nul
)

echo [Open] Opening http://localhost:3000 in your default browser...
start "" "http://localhost:3000"

endlocal


