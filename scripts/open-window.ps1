# Open the Command Center in a standalone browser window (app mode).
#
# Why a separate script: the shared token lives in data\.token, so the window
# must be opened with ?token=... on the URL. Doing that inside a .cmd file would
# need non-ASCII-safe quoting gymnastics; PowerShell handles it cleanly.
#
# NOTE: keep this file pure ASCII. Windows PowerShell 5.1 reads BOM-less files
# using the ANSI code page, and non-ASCII bytes break the param() block.

param(
  [int]$Port = 8787,
  [string]$Root = ""
)

$ErrorActionPreference = "Stop"

if (-not $Root) {
  $Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
}

$tokenPath = Join-Path $Root "data\.token"
$token = ""
if (Test-Path -LiteralPath $tokenPath) {
  $token = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
}

$url = "http://127.0.0.1:$Port/"
if ($token) {
  $url = "$url`?token=$token"
}

$profileDir = Join-Path $Root "runtime\browser-profile"

$browsers = @(
  (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
  (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
  (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe"),
  (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe"),
  (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe")
)

$browser = $null
foreach ($candidate in $browsers) {
  if ($candidate -and (Test-Path -LiteralPath $candidate)) {
    $browser = $candidate
    break
  }
}

if ($browser) {
  New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
  Start-Process -FilePath $browser -ArgumentList @(
    "--app=$url",
    "--user-data-dir=$profileDir",
    "--window-size=1500,950"
  )
  Write-Host "  Opened app window: $url"
} else {
  Start-Process $url
  Write-Host "  Chrome/Edge not found - opened the default browser: $url"
}
