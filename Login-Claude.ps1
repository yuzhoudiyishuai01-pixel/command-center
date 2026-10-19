# Launch Claude Code with the proxy pre-configured.
#
# Why this script exists: Claude Code does NOT read the Windows system proxy
# settings -- it only honours proxy environment variables. Anthropic answers
# requests from unsupported regions with `403 forbidden`, so without a proxy the
# CLI cannot even reach the login screen.
#
# Usage: open PowerShell in this folder and run
#     .\Login-Claude.ps1
# (or whatever this file is named -- running it by name is all that matters)
# Then, inside Claude Code, type:
#     /login
#
# Once logged in, the Claude member in the Command Center picks up this login
# automatically -- no restart needed.
#
# NOTE: ASCII-only on purpose. Windows PowerShell 5.1 reads a BOM-less file as
# ANSI, so non-ASCII text inside string literals comes out as mojibake and can
# even break parsing. Keep it ASCII if you edit it.

$ErrorActionPreference = "Continue"

# Change this if your Clash Verge port differs.
$proxy = "http://127.0.0.1:7897"

$env:HTTPS_PROXY = $proxy
$env:HTTP_PROXY = $proxy
$env:https_proxy = $proxy
$env:http_proxy = $proxy

Write-Host ""
Write-Host "  Proxy set:  $proxy"
Write-Host "  Verifying connectivity to Anthropic..."
try {
  $code = & curl.exe -s -o NUL -w "%{http_code}" --max-time 20 -x $proxy https://api.anthropic.com/v1/models 2>&1
  if ($code -eq "401" -or $code -eq "200") {
    Write-Host "  [ok] Anthropic reachable (HTTP $code). Region block cleared." -ForegroundColor Green
  } elseif ($code -eq "403") {
    Write-Host "  [x] Still blocked by region (HTTP 403). Switch to a supported-country node." -ForegroundColor Red
  } else {
    Write-Host "  [!] Unexpected response: HTTP $code. The proxy node may be unstable." -ForegroundColor Yellow
  }
} catch {
  Write-Host "  [!] Could not verify connectivity." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "  Starting Claude Code. Inside it, type:  /login"
Write-Host ""

# Prefer the native exe so we never spawn a .cmd wrapper.
$native = Join-Path $env:APPDATA "npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe"
if (Test-Path $native) {
  & $native
} else {
  claude
}
