Add-Type @'
using System;using System.Runtime.InteropServices;using System.Text;using System.Collections.Generic;
public class M2 {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int c);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] static extern uint GetClassName(IntPtr h, StringBuilder s, int c);
  public struct R { public int L,T,Rt,B; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  public static List<string> D(){ var o=new List<string>();
    EnumWindows((h,l)=>{
      var sb=new StringBuilder(512); GetWindowText(h,sb,512);
      if(sb.ToString()=="DuckChat"){
        EnumChildWindows(h,(c,x)=>{
          var cc=new StringBuilder(256); GetClassName(c,cc,256);
          if(cc.ToString()=="WRY_WEBVIEW"){
            R r; GetWindowRect(c,out r);
            o.Add(string.Format("{0},{1} {2}x{3}", r.L, r.T, r.Rt-r.L, r.B-r.T));
          }
          return true;
        },IntPtr.Zero);
      }
      return true;
    }, IntPtr.Zero);
    return o;
  }
}
'@
Write-Output (([M2]::D()) -join "  |  ")
