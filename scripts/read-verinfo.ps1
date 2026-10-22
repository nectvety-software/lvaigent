# Read PE version metadata out of the setup exe and the release binary.
# The PowerShell tool can return exit code 0 with empty stdout here, so the
# output is written to a file and read back. Usage:
#   powershell -File scripts/read-verinfo.ps1 0.1.0
param([string]$ver = "0.1.0")
$root = Split-Path -Parent $PSScriptRoot
$setup = Get-Item (Join-Path $root "src-tauri\target\release\bundle\nsis\lvaigent_${ver}_x64-setup.exe")
$app = Get-Item (Join-Path $root "src-tauri\target\release\lvaigent.exe")
$out = @(
  "SETUP ProductVersion = " + $setup.VersionInfo.ProductVersion,
  "SETUP FileVersion    = " + $setup.VersionInfo.FileVersion,
  "SETUP ProductName    = " + $setup.VersionInfo.ProductName,
  "APP   ProductVersion = " + $app.VersionInfo.ProductVersion,
  "APP   FileVersion    = " + $app.VersionInfo.FileVersion,
  "APP   ProductName    = " + $app.VersionInfo.ProductName
)
$out | Set-Content -Path (Join-Path $root ".tmp-verinfo.txt") -Encoding UTF8
