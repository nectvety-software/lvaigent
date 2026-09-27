# Dev helper: put the DuckChat window back at a given physical rect.
param([int]$X = 192, [int]$Y = 89, [int]$W = 1518, [int]$H = 1009)
Add-Type @"
using System;using System.Runtime.InteropServices;
public class WinPos {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool r);
}
"@
$p = Get-Process | Where-Object { $_.MainWindowTitle -like "*DuckChat*" } | Select-Object -First 1
if (-not $p) { "no DuckChat window"; exit 1 }
# NOTE: PowerShell names are case-insensitive, so the handle must not be `$h`
# when `$H` is a parameter — that silently overwrote the height.
$hwnd = $p.MainWindowHandle
[void][WinPos]::ShowWindow($hwnd, 9)   # SW_RESTORE, clears maximized
[void][WinPos]::MoveWindow($hwnd, $X, $Y, $W, $H, $true)
"moved pid=$($p.Id) rect=$X,$Y ${W}x$H"
