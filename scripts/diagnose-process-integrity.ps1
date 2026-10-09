# Read-only Windows process token diagnostics. Does not inject input or change privileges.
param([Parameter(Mandatory = $true)][int]$TargetProcessId)
$processTokenSource = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class ProcessTokenDiagnostics {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr buffer, int length, out int needed);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static string Read(int pid) {
    IntPtr process = OpenProcess(0x1000, false, pid);
    if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    IntPtr token = IntPtr.Zero, buffer = IntPtr.Zero;
    try {
      if (!OpenProcessToken(process, 0x0008, out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
      int needed;
      buffer = Marshal.AllocHGlobal(4);
      if (!GetTokenInformation(token, 20, buffer, 4, out needed)) throw new Win32Exception(Marshal.GetLastWin32Error());
      bool elevated = Marshal.ReadInt32(buffer) != 0;
      Marshal.FreeHGlobal(buffer); buffer = IntPtr.Zero;
      GetTokenInformation(token, 25, IntPtr.Zero, 0, out needed);
      buffer = Marshal.AllocHGlobal(needed);
      if (!GetTokenInformation(token, 25, buffer, needed, out needed)) throw new Win32Exception(Marshal.GetLastWin32Error());
      IntPtr sid = Marshal.ReadIntPtr(buffer);
      byte count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
      int rid = Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1)));
      string level = rid >= 16384 ? "System" : rid >= 12288 ? "High" : rid >= 8192 ? "Medium" : "Low";
      return "PID=" + pid + "; Elevated=" + elevated + "; Integrity=" + level + "; RID=" + rid;
    } finally {
      if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer);
      if (token != IntPtr.Zero) CloseHandle(token);
      CloseHandle(process);
    }
  }
}
'@
Add-Type -TypeDefinition $processTokenSource
[ProcessTokenDiagnostics]::Read($TargetProcessId)
[ProcessTokenDiagnostics]::Read($PID)
