# Footage helper: put the capture window on top without activating it (no focus, so the game never grabs the
# mouse), or report its rectangle. Windows can throttle presentation of windows hidden behind others.
param([string]$Title = '^Minecraft 1\.16\.1', [switch]$Topmost, [switch]$Release)
Add-Type @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class Win {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
}
'@
$found = [IntPtr]::Zero
[Win]::EnumWindows({ param($h, $p) $s = New-Object Text.StringBuilder 256; [void][Win]::GetWindowText($h, $s, 256)
  if ([Win]::IsWindowVisible($h) -and $s.ToString() -match $Title) { $script:found = $h; return $false }; return $true }, [IntPtr]::Zero) | Out-Null
if ($found -eq [IntPtr]::Zero) { Write-Output 'not found'; exit 1 }
# SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE
$after = if ($Release) { [IntPtr](-2) } else { [IntPtr](-1) }
[void][Win]::SetWindowPos($found, $after, 0, 0, 0, 0, 0x0013)
if ($Focus) { [Win]::keybd_event(0x12,0,0,[UIntPtr]::Zero); [Win]::keybd_event(0x12,0,2,[UIntPtr]::Zero); [void][Win]::SetForegroundWindow($found) }
if ($Key) { Start-Sleep -Milliseconds 300; [Win]::keybd_event([byte]$Key,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 80; [Win]::keybd_event([byte]$Key,0,2,[UIntPtr]::Zero) }
Write-Output "ok $found"
