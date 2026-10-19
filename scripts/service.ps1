<#
  Command Center - start (or confirm) the background service.

  Contract, relied on by 启动指挥室.cmd and by restart-service.ps1:
    - confirms the service on the configured port, starting it hidden if needed
    - exits 0 once /api/state answers, non-zero when it never becomes ready
    - -Console keeps the old troubleshooting behaviour: a visible window

  Note on logging: the service tees its own stdout/stderr into data/server.log
  (see server/logging.mjs), so this script deliberately does NOT redirect output.
  Starting through WScript.Shell with a hidden window and no wait is what makes
  the service process detach from the launcher completely.

  ASCII-only on purpose: Windows PowerShell 5.1 reads a BOM-less file as ANSI, so
  non-ASCII inside string literals corrupts parsing (symptom: "Unexpected token
  '}'"). Keep it ASCII if you edit it.

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File service.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File service.ps1 -Console
#>
[CmdletBinding()]
param(
  [switch]$Console,
  [int]$Port = 8787,
  [string]$BindHost = "127.0.0.1"
)

$ErrorActionPreference = "Stop"

# This script lives in <project>/scripts, so the project root is one level up.
$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$url = "http://${BindHost}:${Port}/api/state"

# Shared-token auth is on by default. Read data\.token so the readiness probe
# can authenticate; without it every probe gets 401 and the launcher wrongly
# concludes "service did not start" (this is exactly what broke double-click).
$authHeaders = @{}
$tokenPath = Join-Path $projectRoot "data\.token"
if (Test-Path -LiteralPath $tokenPath) {
  $token = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
  if ($token) { $authHeaders["Authorization"] = "Bearer $token" }
}

function Test-Service {
  try {
    $response = Invoke-WebRequest -Uri $url -TimeoutSec 2 -UseBasicParsing -Headers $authHeaders -ErrorAction Stop
    return $response.StatusCode -eq 200
  } catch {
    # A 401 still proves something is listening and answering on this port:
    # treat it as "already running" instead of trying to start a second copy.
    try {
      $code = $_.Exception.Response.StatusCode.value__
      if ($code -eq 401) { return $true }
    } catch {
      # no HTTP response at all
    }
    return $false
  }
}

# Prefer the Node runtime bundled with DeepSeek Harness.
$node = Join-Path $env:USERPROFILE ".dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if (-not (Test-Path $node)) {
  $found = Get-Command node -ErrorAction SilentlyContinue
  if (-not $found) {
    Write-Host "  [x] No Node.js runtime found." -ForegroundColor Red
    exit 1
  }
  $node = $found.Source
}

$entry = Join-Path $projectRoot "server\index.mjs"
if (-not (Test-Path $entry)) {
  Write-Host "  [x] Missing entry script: $entry" -ForegroundColor Red
  exit 1
}

if (Test-Service) {
  Write-Host "  [ok] Service already running." -ForegroundColor DarkGray
  exit 0
}

Write-Host "  [..] Starting service in the background..." -ForegroundColor DarkGray

if ($Console) {
  # Troubleshooting: a visible window, so console output is readable directly.
  Start-Process -FilePath $node -ArgumentList "`"$entry`"" -WorkingDirectory $projectRoot | Out-Null
} else {
  # Hidden and non-waiting: detaches the service from this launcher, so it keeps
  # running after the launcher (or its console window) goes away.
  $shell = New-Object -ComObject WScript.Shell
  $shell.Run("`"$node`" `"$entry`"", 0, $false) | Out-Null
}

# Poll until ready: up to 20 seconds.
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 500
  if (Test-Service) {
    Write-Host "  [ok] Service ready." -ForegroundColor Green
    exit 0
  }
}

Write-Host "  [x] Service did not become ready in 20s." -ForegroundColor Red
Write-Host "      Re-run the launcher with --console to see the server log." -ForegroundColor Yellow
exit 1
