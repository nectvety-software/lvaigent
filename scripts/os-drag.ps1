# Dev helper: drive a real OS-level mouse drag (user32) so the pointer path
# crosses native child-HWND boundaries, unlike CDP synthetic input.
param(
  [int]$Sx, [int]$Sy, [int]$Ex, [int]$Ey,
  [int]$Steps = 15,
  [int]$StepMs = 60
)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class OsMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, int e);
  public const uint DOWN = 0x0002, UP = 0x0004;
}
"@
$move = [System.Windows.Forms.MouseButtons]
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($Sx, $Sy)
Start-Sleep -Milliseconds 250
[OsMouse]::SetCursorPos($Sx, $Sy)
Start-Sleep -Milliseconds 150
[OsMouse]::mouse_event([OsMouse]::DOWN, 0, 0, 0, 0)
Start-Sleep -Milliseconds 200
for ($i = 1; $i -le $Steps; $i++) {
  $x = [int]($Sx + (($Ex - $Sx) * $i / $Steps))
  $y = [int]($Sy + (($Ey - $Sy) * $i / $Steps))
  [OsMouse]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds $StepMs
}
[OsMouse]::SetCursorPos($Ex, $Ey)
Start-Sleep -Milliseconds 200
[OsMouse]::mouse_event([OsMouse]::UP, 0, 0, 0, 0)
Write-Output "dragged $Sx,$Sy -> $Ex,$Ey"
