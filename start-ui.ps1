Param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Info($msg) { Write-Host $msg -ForegroundColor Cyan }

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

# Ensure deps
if (-not (Test-Path -Path 'node_modules')) {
  Write-Info '[Setup] Installing dependencies...'
  npm install --no-fund --no-audit --omit=dev | Out-Null
}

# Ping UI
$uiUp = $false
try {
  $resp = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri 'http://localhost:3000'
  $uiUp = $true
} catch { $uiUp = $false }

if (-not $uiUp) {
  Write-Info '[Start] Launching UI server on port 3000...'
  Start-Process -WindowStyle Minimized -FilePath 'cmd.exe' -ArgumentList '/c node runner.js'
  Start-Sleep -Seconds 3
}

Write-Info '[Open] Opening http://localhost:3000'
Start-Process 'http://localhost:3000'


