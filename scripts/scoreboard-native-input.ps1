param([long]$Window, [string]$Action, [double]$X, [double]$Y, [string]$Value, [double]$Dx, [double]$Dy)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class ScoreboardInput {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc p, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h,StringBuilder s,int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out Rect r);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageW")] public static extern IntPtr SendText(IntPtr h,uint m,IntPtr w,string s);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
  public static IntPtr Find(IntPtr parent,string name) {
    IntPtr result=IntPtr.Zero;
    EnumChildWindows(parent,(h,l)=>{var s=new StringBuilder(256);GetClassName(h,s,256);if(s.ToString()==name){result=h;return false;}return true;},IntPtr.Zero);
    return result;
  }
}
'@
$parent = [IntPtr]$Window
$preview = [ScoreboardInput]::Find($parent, 'TTcutPreview')
if ($preview -eq [IntPtr]::Zero) { throw 'Native preview window not found' }
$rect = [ScoreboardInput+Rect]::new()
[ScoreboardInput]::GetWindowRect($preview, [ref]$rect) | Out-Null
$px = $rect.Left + [int](($rect.Right - $rect.Left) * $X)
$py = $rect.Top + [int](($rect.Bottom - $rect.Top) * $Y)
$cx = [int](($rect.Right - $rect.Left) * $X)
$cy = [int](($rect.Bottom - $rect.Top) * $Y)
$point = [IntPtr](($cy -shl 16) -bor ($cx -band 0xffff))
function Click-Preview {
  [ScoreboardInput]::SendMessage($preview,0x201,[IntPtr]1,$point) | Out-Null
  [ScoreboardInput]::SendMessage($preview,0x202,[IntPtr]::Zero,$point) | Out-Null
}
switch ($Action) {
  'click' { Click-Preview }
  'pause' { [ScoreboardInput]::SendMessage($preview,0x100,[IntPtr]32,[IntPtr]::Zero) | Out-Null }
  'wheel' {
    $delta = if ($Value -eq 'down') { -120 } else { 120 }
    [ScoreboardInput]::SendMessage($preview,0x20A,[IntPtr]($delta -shl 16),[IntPtr](($py -shl 16) -bor ($px -band 0xffff))) | Out-Null
  }
  'drag' {
    [ScoreboardInput]::SendMessage($preview,0x201,[IntPtr]1,$point) | Out-Null
    for ($step=1; $step -le 8; $step++) {
      $mx = $cx+[int](($rect.Right-$rect.Left)*$Dx*$step/8)
      $my = $cy+[int](($rect.Bottom-$rect.Top)*$Dy*$step/8)
      $point = [IntPtr](($my -shl 16) -bor ($mx -band 0xffff))
      [ScoreboardInput]::SendMessage($preview,0x200,[IntPtr]1,$point) | Out-Null
      Start-Sleep -Milliseconds 25
    }
    [ScoreboardInput]::SendMessage($preview,0x202,[IntPtr]::Zero,$point) | Out-Null
  }
  'edit' {
    Click-Preview; Start-Sleep -Milliseconds 90; Click-Preview
    Start-Sleep -Milliseconds 200
    $edit = [ScoreboardInput]::Find($preview, 'Edit')
    if ($edit -eq [IntPtr]::Zero) { throw 'Double click did not open the native editor' }
    [ScoreboardInput]::SendText($edit,0xC,[IntPtr]::Zero,$Value) | Out-Null
    [ScoreboardInput]::SendMessage($edit,0x100,[IntPtr]13,[IntPtr]::Zero) | Out-Null
  }
  default { throw "Unknown input action: $Action" }
}
