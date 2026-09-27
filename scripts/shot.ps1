# Dev helper: list DuckChat top-level windows and grab a full-screen shot.
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr lp);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
$procs = Get-Process duckchat -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id
$found = @()
$cb = [Win32+EnumWindowsProc]{ param($h, $lp)
  $pid2 = 0
  [Win32]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null
  if ($procs -contains $pid2) {
    $sb = New-Object Text.StringBuilder 256
    [Win32]::GetWindowText($h, $sb, 256) | Out-Null
    $cn = New-Object Text.StringBuilder 256
    [Win32]::GetClassName($h, $cn, 256) | Out-Null
    $r = New-Object Win32+RECT
    [Win32]::GetWindowRect($h, [ref]$r) | Out-Null
    $vis = [Win32]::IsWindowVisible($h)
    $script:found += [pscustomobject]@{ Handle=$h.ToInt64(); PID=$pid2; Title=$sb.ToString(); Class=$cn.ToString(); Visible=$vis; Rect=("$($r.L),$($r.T) $($r.R - $r.L)x$($r.B - $r.T)") }
  }
  return $true
}
[Win32]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
$found | Format-Table -AutoSize | Out-String -Width 220

Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object Drawing.Bitmap $b.Width, $b.Height
$g = [Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [Drawing.Point]::Empty, $b.Size)
$out = Join-Path $env:TEMP "duckshot.png"
$bmp.Save($out, [Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "SHOT_SAVED=$out"
