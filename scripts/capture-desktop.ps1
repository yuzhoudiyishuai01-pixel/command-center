# Capture the desktop (Win+D, screenshot, Win+D back) so we can verify the
# shortcut icon actually refreshed. Explorer icon cache is not readable from CLI.
# NOTE: keep this file pure ASCII -- Windows PowerShell 5.1 reads BOM-less
# files as ANSI and non-ASCII comments break parsing.
param([string]$Out = ".shots\desktop-icons.png")

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace Win32 -Name Keys -MemberDefinition @'
[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
'@

function Invoke-ShowDesktop {
    [Win32.Keys]::keybd_event(0x5B, 0, 0, [UIntPtr]::Zero)
    [Win32.Keys]::keybd_event(0x44, 0, 0, [UIntPtr]::Zero)
    [Win32.Keys]::keybd_event(0x44, 0, 2, [UIntPtr]::Zero)
    [Win32.Keys]::keybd_event(0x5B, 0, 2, [UIntPtr]::Zero)
}

function Save-Screen([string]$Path) {
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()
}

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if ([System.IO.Path]::IsPathRooted($Out)) { $full = $Out } else { $full = Join-Path $root $Out }
$dir = Split-Path -Parent $full
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
if (Test-Path $full -PathType Leaf) { Remove-Item $full -Force }

Invoke-ShowDesktop
Start-Sleep -Milliseconds 1500
Save-Screen $full
Start-Sleep -Milliseconds 400
Invoke-ShowDesktop
Write-Output "wrote $full"
