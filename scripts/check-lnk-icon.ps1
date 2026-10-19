# Ask the shell "what icon would you draw for this file?" and save it as PNG.
# This goes through the same path Explorer uses (including its icon cache),
# so it is a real check that the shortcut icon refreshed.
# Keep this file pure ASCII (PowerShell 5.1 reads BOM-less files as ANSI).
param([string]$Lnk, [string]$Out)

Add-Type -AssemblyName System.Drawing
Add-Type -Namespace Shell32 -Name Icons -MemberDefinition @'
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct SHFILEINFO {
    public IntPtr hIcon;
    public int iIcon;
    public uint dwAttributes;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szDisplayName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)] public string szTypeName;
}
[DllImport("shell32.dll", CharSet = CharSet.Unicode)]
public static extern IntPtr SHGetFileInfo(string pszPath, uint dwFileAttributes, ref SHFILEINFO psfi, uint cbFileInfo, uint uFlags);
[DllImport("user32.dll")]
public static extern bool DestroyIcon(IntPtr hIcon);

public const uint SHGFI_ICON = 0x100;
public const uint SHGFI_LARGEICON = 0x0;
public const uint SHGFI_SMALLICON = 0x1;
'@

if (-not $Lnk) { throw "usage: -Lnk <path-to-lnk> -Out <png>" }
if (-not (Test-Path $Lnk)) { throw "not found: $Lnk" }

$info = New-Object Shell32.Icons+SHFILEINFO
$res = [Shell32.Icons]::SHGetFileInfo($Lnk, 0, [ref]$info, [uint32][System.Runtime.InteropServices.Marshal]::SizeOf($info), [Shell32.Icons]::SHGFI_ICON -bor [Shell32.Icons]::SHGFI_LARGEICON)
if ($res -eq [IntPtr]::Zero) { throw "SHGetFileInfo failed" }

$icon = [System.Drawing.Icon]::FromHandle($info.hIcon)
$bmp = $icon.ToBitmap()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output ("icon {0}x{1} -> {2}" -f $bmp.Width, $bmp.Height, $Out)
$bmp.Dispose()
$icon.Dispose()
[void][Shell32.Icons]::DestroyIcon($info.hIcon)
