# Diagnose whether Windows itself can load an .ico file (and how many sizes).
# Keep pure ASCII (PowerShell 5.1 reads BOM-less files as ANSI).
param([string]$Ico, [string]$Out)

if (-not $Ico) { throw "usage: -Ico <path>" }
if (-not (Test-Path $Ico)) { throw "not found: $Ico" }

Add-Type -AssemblyName System.Drawing
Add-Type -Namespace Win32Ic -Name Ex -MemberDefinition @'
[DllImport("shell32.dll", CharSet = CharSet.Unicode)]
public static extern uint ExtractIconEx(string lpszFile, int nIconIndex, IntPtr[] phiconLarge, IntPtr[] phiconSmall, uint nIcons);
[DllImport("user32.dll")]
public static extern bool DestroyIcon(IntPtr hIcon);
'@

$large = New-Object IntPtr[] 32
$small = New-Object IntPtr[] 32
$count = [Win32Ic.Ex]::ExtractIconEx($Ico, 0, $large, $small, [uint32]32)
Write-Output ("ExtractIconEx count = {0}" -f $count)

for ($i = 0; $i -lt $count -and $i -lt 32; $i++) {
    if ($large[$i] -ne [IntPtr]::Zero) {
        $icon = [System.Drawing.Icon]::FromHandle($large[$i])
        Write-Output ("  icon[{0}] large = {1}x{2}" -f $i, $icon.Width, $icon.Height)
        if ($i -eq 0 -and $Out) {
            $bmp = $icon.ToBitmap()
            $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
            $bmp.Dispose()
            Write-Output ("saved {0}" -f $Out)
        }
        $icon.Dispose()
        [void][Win32Ic.Ex]::DestroyIcon($large[$i])
    }
    if ($small[$i] -ne [IntPtr]::Zero) { [void][Win32Ic.Ex]::DestroyIcon($small[$i]) }
}
