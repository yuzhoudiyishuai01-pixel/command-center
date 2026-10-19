param(
  [switch]$DeviceCode
)

# Log in to the Codex CLI with the proxy pre-configured.
#
# Why this script exists:
#   1. `codex` is not on PATH -- it lives under a randomly-named version folder
#      (%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe), which is impossible to
#      type by hand.
#   2. Codex does not read the Windows system proxy settings; it only honours
#      proxy environment variables.
#
# Usage: open PowerShell in this folder and run this script by name:
#     .\Login-Codex.ps1                 # browser login
#     .\Login-Codex.ps1 -DeviceCode     # device-code login (do it on your phone)
#
# Once logged in, the ChatGPT member in the Command Center uses this login
# automatically -- no restart needed.
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads a BOM-less file as ANSI,
# so non-ASCII inside string literals becomes mojibake. Keep it ASCII.

$ErrorActionPreference = "Continue"

$proxy = "http://127.0.0.1:7897"

# --- locate codex.exe (the version folder name is a random hash) -------------
$codex = $null
$base = Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin"
if (Test-Path $base) {
  $candidate = Get-ChildItem -Path $base -Filter "codex.exe" -Recurse -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($candidate) { $codex = $candidate.FullName }
}
if (-not $codex) {
  $onPath = Get-Command codex -ErrorAction SilentlyContinue
  if ($onPath) { $codex = $onPath.Source }
}
if (-not $codex) {
  Write-Host "  [x] Could not find codex.exe under $base" -ForegroundColor Red
  Write-Host "      Is the Codex desktop app installed?" -ForegroundColor Yellow
  exit 1
}

Write-Host ""
Write-Host "  codex:  $codex"
Write-Host "  proxy:  $proxy"
Write-Host ""

# --- proxy: Codex only honours environment variables -------------------------
$env:HTTPS_PROXY = $proxy
$env:HTTP_PROXY = $proxy
$env:https_proxy = $proxy
$env:http_proxy = $proxy

if ($DeviceCode) {
  Write-Host "  Device-code login: a short code and a URL will be printed."
  Write-Host "  Open the URL on your phone and enter the code."
  Write-Host ""
  & $codex login --device-auth
} else {
  Write-Host "  Starting login. A browser window should open (or a URL is printed)."
  Write-Host "  Sign in with your ChatGPT account."
  Write-Host ""
  Write-Host "  If the browser cannot reach the proxy, press Ctrl+C and instead run:"
  Write-Host "      .\Login-Codex.ps1 -DeviceCode"
  Write-Host ""
  & $codex login
}

Write-Host ""
if (Test-Path (Join-Path $env:USERPROFILE ".codex\auth.json")) {
  Write-Host "  [ok] Login looks successful (auth.json created)." -ForegroundColor Green
} else {
  Write-Host "  [!] auth.json not found yet -- the login may not have completed." -ForegroundColor Yellow
  Write-Host "      If it failed, try the device-code flow:  .\Login-Codex.ps1 -DeviceCode" -ForegroundColor Yellow
}
