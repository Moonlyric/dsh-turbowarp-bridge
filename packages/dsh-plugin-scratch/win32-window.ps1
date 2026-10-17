# TurboWarp 窗口可见性探针（Windows only）
#
# 为什么需要它：Electron 应用（TurboWarp Desktop）可以被以「隐藏」状态拉起来 ——
# 窗口对象存在、CDP 连得上、积木也改得了，但用户在屏幕上看不到它。
# `Get-Process ... MainWindowHandle` **查不出来**（隐藏窗口恒返回 0），
# 而 Chromium 的 document.visibilityState 也照样是 visible（Electron 不按它节流）。
# 唯一可靠的判据是 EnumWindows + IsWindowVisible。所以这里老老实实调 Win32。
#
# 用法（插件 index.js 通过 powershell -File 调用）：
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File win32-window.ps1 -ImageName TurboWarp [-Show]
#   powershell ... -File win32-window.ps1 -TargetPid 1234 [-Show]
# 输出：一行 JSON 数组，每项 { pid, hwnd, cls, visible, minimized, rect, title }
param(
  [string]$ImageName = '',
  [int]$TargetPid = 0,
  [switch]$Show
)

$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class DshWin32 {
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  public struct RECT { public int L, T, R, B; }
  public static List<IntPtr> Handles = new List<IntPtr>();
  public static bool Collect(IntPtr h, IntPtr l) { Handles.Add(h); return true; }
}
'@

$targets = New-Object 'System.Collections.Generic.List[int]'
if ($TargetPid -gt 0) {
  $targets.Add($TargetPid)
} elseif ($ImageName -ne '') {
  foreach ($proc in @(Get-Process -Name $ImageName -ErrorAction SilentlyContinue)) { $targets.Add([int]$proc.Id) }
}
if ($targets.Count -eq 0) { Write-Output '[]'; exit 0 }

[void][DshWin32]::Handles.Clear()
[void][DshWin32]::EnumWindows([DshWin32+EnumWindowsProc] { param($wnd, $lp) return [DshWin32]::Collect($wnd, $lp) }, [IntPtr]::Zero)

$found = New-Object 'System.Collections.Generic.List[object]'
foreach ($wnd in [DshWin32]::Handles) {
  $ownerPid = 0
  [void][DshWin32]::GetWindowThreadProcessId($wnd, [ref]$ownerPid)
  if (-not $targets.Contains([int]$ownerPid)) { continue }

  $sbTitle = New-Object System.Text.StringBuilder 512
  [void][DshWin32]::GetWindowTextW($wnd, $sbTitle, 512)
  $titleText = $sbTitle.ToString()
  if ([string]::IsNullOrWhiteSpace($titleText)) { continue }

  $sbClass = New-Object System.Text.StringBuilder 256
  [void][DshWin32]::GetClassNameW($wnd, $sbClass, 256)

  $rect = New-Object DshWin32+RECT
  [void][DshWin32]::GetWindowRect($wnd, [ref]$rect)

  $isVisible = [DshWin32]::IsWindowVisible($wnd)
  if ($Show -and (-not $isVisible -or [DshWin32]::IsIconic($wnd))) {
    [void][DshWin32]::ShowWindow($wnd, 9)          # SW_RESTORE（隐藏和最小化都归它）
    [void][DshWin32]::ShowWindow($wnd, 5)          # SW_SHOW
    [void][DshWin32]::BringWindowToTop($wnd)
    [void][DshWin32]::SetForegroundWindow($wnd)
    $isVisible = [DshWin32]::IsWindowVisible($wnd)
  }

  $item = [pscustomobject]@{
    pid       = [int]$ownerPid
    hwnd      = ('0x{0:X}' -f $wnd.ToInt64())
    cls       = $sbClass.ToString()
    visible   = [bool]$isVisible
    minimized = [bool][DshWin32]::IsIconic($wnd)
    rect      = @([int]$rect.L, [int]$rect.T, [int]($rect.R - $rect.L), [int]($rect.B - $rect.T))
    title     = $titleText
  }
  $found.Add($item)
}

# 手拼 JSON：ConvertTo-Json 在「List[object] + 数组属性」上会抛
# "Argument types do not match"（PS 5.1 的老坑），这里只需要一个小数组，手写更稳。
function Esc([string]$text) {
  return $text.Replace('\', '\\').Replace('"', '\"').Replace("`r", '\r').Replace("`n", '\n')
}

$json = New-Object System.Text.StringBuilder
[void]$json.Append('[')
$first = $true
foreach ($w in $found) {
  if (-not $first) { [void]$json.Append(',') }
  $first = $false
  $r = $w.rect
  [void]$json.Append('{')
  [void]$json.Append('"pid":').Append($w.pid).Append(',')
  [void]$json.Append('"hwnd":"').Append($w.hwnd).Append('",')
  [void]$json.Append('"cls":"').Append((Esc $w.cls)).Append('",')
  [void]$json.Append('"visible":').Append($(if ($w.visible) { 'true' } else { 'false' })).Append(',')
  [void]$json.Append('"minimized":').Append($(if ($w.minimized) { 'true' } else { 'false' })).Append(',')
  [void]$json.Append('"rect":[').Append($r[0]).Append(',').Append($r[1]).Append(',').Append($r[2]).Append(',').Append($r[3]).Append('],')
  [void]$json.Append('"title":"').Append((Esc $w.title)).Append('"')
  [void]$json.Append('}')
}
[void]$json.Append(']')

Write-Output $json.ToString()
exit 0
