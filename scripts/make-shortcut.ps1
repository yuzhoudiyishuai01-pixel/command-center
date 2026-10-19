<#
  Create the desktop shortcut for the Command Center.

  NOTE: ASCII-only on purpose. Windows PowerShell 5.1 reads a BOM-less file as
  ANSI, so non-ASCII characters break parsing. For the same reason this script
  never receives a Chinese name as a parameter -- passing one through -File
  mangles it. Instead it discovers the launcher and the shortcut name itself:
  the launcher is the only .cmd in the project root, and the shortcut is named
  after that file. Everything stays encoding-safe.

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File make-shortcut.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

# This script lives in <project>/scripts.
$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

# The launcher is the single .cmd file in the project root (scripts/ has its own).
$launchers = @(Get-ChildItem -LiteralPath $projectRoot -Filter "*.cmd" -File -ErrorAction SilentlyContinue)
if ($launchers.Count -eq 0) {
  Write-Host "  [x] No launcher (.cmd) found in $projectRoot" -ForegroundColor Red
  exit 1
}
$target = $launchers[0].FullName
# Name the shortcut after the launcher, minus its extension.
$displayName = [System.IO.Path]::GetFileNameWithoutExtension($target)

# The icon must live OUTSIDE the project tree. The project sits under the agent
# sandbox, which labels it low-integrity and adds an Everyone DENY(DC) ACE; the
# shell refuses to resolve IconLocation from there and paints the generic file
# icon instead (verified with SHGetFileInfo). %LOCALAPPDATA% has no such label.
$sourceIcon = Join-Path $projectRoot "public\app-icon.ico"
$icon = $null
if (Test-Path $sourceIcon) {
  $iconDir = Join-Path $env:LOCALAPPDATA "CommandCenter"
  New-Item -ItemType Directory -Force -Path $iconDir | Out-Null
  $icon = Join-Path $iconDir "app-icon.ico"
  Copy-Item -LiteralPath $sourceIcon -Destination $icon -Force
} else {
  Write-Host "  [!] Icon not found: $sourceIcon (a default icon will be used)" -ForegroundColor Yellow
}

$desktop = [Environment]::GetFolderPath("Desktop")
$linkPath = Join-Path $desktop "$displayName.lnk"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($linkPath)
# Run the .cmd through cmd.exe so it behaves exactly like a double-click.
$shortcut.TargetPath = $env:ComSpec
$shortcut.Arguments = "/c `"$target`""
$shortcut.WorkingDirectory = $projectRoot
$shortcut.Description = "Command Center - multi-agent control room"
if ($icon) { $shortcut.IconLocation = "$icon,0" }
$shortcut.WindowStyle = 7  # minimized: the launcher only boots the service and opens the app window
$shortcut.Save()

# Ask Explorer to rebuild its icon cache so the new icon shows up right away.
try {
  Start-Process -FilePath "$env:SystemRoot\System32\ie4uinit.exe" -ArgumentList "-show" -WindowStyle Hidden -Wait -ErrorAction Stop
} catch {
  Write-Host "  [!] Could not refresh the icon cache (the icon may need a moment)" -ForegroundColor Yellow
}

# Verify through the shell itself: SHGetFileInfo is what Explorer uses to paint
# the icon, so if this shows the neon icon the desktop will too.
$check = Join-Path $projectRoot "scripts\check-lnk-icon.ps1"
if (Test-Path $check) {
  $shot = Join-Path $projectRoot ".shots\lnk-verify.png"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $shot) | Out-Null
  & powershell -NoProfile -ExecutionPolicy Bypass -File $check -Lnk $linkPath -Out $shot | Out-Null
  if (Test-Path $shot) { Write-Host "       icon check: $shot" }
}

if (Test-Path -LiteralPath $linkPath) {
  Write-Host "  [ok] Shortcut created:" -ForegroundColor Green
  Write-Host "       $linkPath"
} else {
  Write-Host "  [x] Failed to create the shortcut." -ForegroundColor Red
  exit 1
}
