param([int]$ProcessId,[string]$Action='inspect',[double]$X=.5,[double]$Y=.5,[int]$Delta=120,[string]$Shot,[string]$Value,[double]$Dx=0,[double]$Dy=0,[switch]$KeepFocus,[long]$Window=0)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
Add-Type @'
using System;using System.Text;using System.Runtime.InteropServices;
public class Physical {
public delegate bool EnumProc(IntPtr h,IntPtr l);
[StructLayout(LayoutKind.Sequential)]public struct Rect{public int Left,Top,Right,Bottom;}
[StructLayout(LayoutKind.Sequential)]public struct Point{public int X,Y;}
[DllImport("user32.dll")]public static extern bool SetProcessDpiAwarenessContext(IntPtr c);
[DllImport("user32.dll")]public static extern bool EnumChildWindows(IntPtr h,EnumProc p,IntPtr l);
[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetClassName(IntPtr h,StringBuilder s,int n);
[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out Rect r);
[DllImport("user32.dll")]public static extern bool IsWindowEnabled(IntPtr h);
[DllImport("user32.dll")]public static extern long GetWindowLongPtrW(IntPtr h,int n);
[DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int cmd);
[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
[StructLayout(LayoutKind.Sequential)]public struct Gui { public uint Size,Flags;public IntPtr Active,Focus,Capture,Menu,Move,Caret;public Rect CaretRect; }
[DllImport("user32.dll")]public static extern bool GetGUIThreadInfo(uint id,ref Gui info);
[DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageW")]public static extern IntPtr ReadText(IntPtr h,uint m,IntPtr w,StringBuilder s);
public static string Text(IntPtr h){var s=new StringBuilder(256);ReadText(h,13,(IntPtr)256,s);return s.ToString();}
[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
[DllImport("kernel32.dll")]public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")]public static extern bool AttachThreadInput(uint a,uint b,bool attach);
[DllImport("user32.dll")]public static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int w,int z,uint flags);
[DllImport("user32.dll")]public static extern IntPtr GetAncestor(IntPtr h,uint flags);
[DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);
[DllImport("user32.dll")]public static extern IntPtr WindowFromPoint(Point p);
[DllImport("user32.dll")]public static extern void mouse_event(uint f,int x,int y,int d,UIntPtr e);
[StructLayout(LayoutKind.Explicit,Size=40)]public struct Input{[FieldOffset(0)]public uint Type;[FieldOffset(8)]public ushort Key;[FieldOffset(10)]public ushort Scan;[FieldOffset(12)]public uint Flags;}
[DllImport("user32.dll")]public static extern uint SendInput(uint n,Input[] inputs,int size);
public static void Key(ushort key,bool up=false){SendInput(1,new[]{new Input{Type=1,Key=key,Flags=up?2u:0u}},40);}
public static void Type(string s){foreach(char c in s)SendInput(2,new[]{new Input{Type=1,Scan=c,Flags=4},new Input{Type=1,Scan=c,Flags=6}},40);}
public static string Class(IntPtr h){var s=new StringBuilder(256);GetClassName(h,s,256);return s.ToString();}
}
'@
[Physical]::SetProcessDpiAwarenessContext([IntPtr](-4))|Out-Null
$parent=if($Window){[IntPtr]$Window}else{(Get-Process -Id $ProcessId).MainWindowHandle}
if(!$KeepFocus){
$fgpid=0u;$fgthread=[Physical]::GetWindowThreadProcessId([Physical]::GetForegroundWindow(),[ref]$fgpid)
$thread=[Physical]::GetCurrentThreadId()
[Physical]::AttachThreadInput($thread,$fgthread,$true)|Out-Null
[Physical]::ShowWindow($parent,9)|Out-Null
[Physical]::SetForegroundWindow($parent)|Out-Null
[Physical]::SetWindowPos($parent,[IntPtr](-1),0,0,0,0,0x43)|Out-Null
[Physical]::AttachThreadInput($thread,$fgthread,$false)|Out-Null
Start-Sleep -Milliseconds 400
}
$script:preview=[IntPtr]::Zero
$script:tree=@()
[Physical]::EnumChildWindows($parent,{
 param($h,$l)
 $r=[Physical+Rect]::new();[Physical]::GetWindowRect($h,[ref]$r)|Out-Null
 $class=[Physical]::Class($h)
 $script:tree+=@{handle=$h.ToInt64();class=$class;enabled=[Physical]::IsWindowEnabled($h);style=[Physical]::GetWindowLongPtrW($h,-16);exstyle=[Physical]::GetWindowLongPtrW($h,-20);rect=$r}
 if($class -eq 'TTcutPreview'){$script:preview=$h};return $true
},[IntPtr]::Zero)|Out-Null
if($preview -eq [IntPtr]::Zero){throw 'Missing preview'}
$rect=[Physical+Rect]::new();[Physical]::GetWindowRect($preview,[ref]$rect)|Out-Null
$px=$rect.Left+[int](($rect.Right-$rect.Left)*$X);$py=$rect.Top+[int](($rect.Bottom-$rect.Top)*$Y)
[Physical]::SetCursorPos($px,$py)|Out-Null
$point=[Physical+Point]::new();$point.X=$px;$point.Y=$py
$target=[Physical]::WindowFromPoint($point)
if([Physical]::GetAncestor($target,2) -ne $parent){throw "Pointer is outside the test app: parent=$parent target=$target class=$([Physical]::Class($target)) root=$([Physical]::GetAncestor($target,2)) point=$px,$py"}
function Click { [Physical]::mouse_event(2,0,0,0,[UIntPtr]::Zero);Start-Sleep -Milliseconds 80;[Physical]::mouse_event(4,0,0,0,[UIntPtr]::Zero) }
switch($Action){
 'click'{Click}
 'double'{Click;Start-Sleep -Milliseconds 90;Click}
 'liveEdit'{
  Click;Start-Sleep -Milliseconds 90;Click;Start-Sleep -Milliseconds 300
  $focus=[Physical+Gui]::new();$focus.Size=[System.Runtime.InteropServices.Marshal]::SizeOf($focus);[Physical]::GetGUIThreadInfo(0,[ref]$focus)|Out-Null
  if([Physical]::Class($focus.Focus) -ne 'Edit' -or [Physical]::GetAncestor($focus.Focus,2) -ne $parent){throw 'Inline editor did not receive keyboard focus'}
  [Physical]::Type($Value);Start-Sleep -Milliseconds 180
 }
 'wheel'{[Physical]::mouse_event(0x800,0,0,$Delta,[UIntPtr]::Zero)}
 'type'{[Physical]::Type($Value);Start-Sleep -Milliseconds 180}
 'key'{[Physical]::Key([ushort]$Delta);[Physical]::Key([ushort]$Delta,$true);Start-Sleep -Milliseconds 180}
 'edit'{Click;Start-Sleep -Milliseconds 90;Click;Start-Sleep -Milliseconds 300;[Physical]::Key(17);[Physical]::Key(65);[Physical]::Key(65,$true);[Physical]::Key(17,$true);[Physical]::Type($Value);[Physical]::Key(13);[Physical]::Key(13,$true)}
 'drag'{[Physical]::mouse_event(2,0,0,0,[UIntPtr]::Zero);for($i=1;$i -le 12;$i++){[Physical]::SetCursorPos($px+[int](($rect.Right-$rect.Left)*$Dx*$i/12),$py+[int](($rect.Bottom-$rect.Top)*$Dy*$i/12))|Out-Null;Start-Sleep -Milliseconds 25};[Physical]::mouse_event(4,0,0,0,[UIntPtr]::Zero)}
}
$whitePixels=0;$whiteFraction=0
if($Shot){
 Add-Type -AssemblyName System.Drawing
 $r=[Physical+Rect]::new();[Physical]::GetWindowRect($parent,[ref]$r)|Out-Null
 $bmp=[System.Drawing.Bitmap]::new($r.Right-$r.Left,$r.Bottom-$r.Top);$g=[System.Drawing.Graphics]::FromImage($bmp)
 $g.CopyFromScreen($r.Left,$r.Top,0,0,$bmp.Size);$bmp.Save($Shot)
 $shotGui=[Physical+Gui]::new();$shotGui.Size=[System.Runtime.InteropServices.Marshal]::SizeOf($shotGui);[Physical]::GetGUIThreadInfo(0,[ref]$shotGui)|Out-Null
 if([Physical]::Class($shotGui.Focus) -eq 'Edit'){
  $control=[Physical+Rect]::new();[Physical]::GetWindowRect($shotGui.Focus,[ref]$control)|Out-Null
  for($y=[Math]::Max(0,$control.Top-$r.Top);$y -lt [Math]::Min($bmp.Height,$control.Bottom-$r.Top);$y++){
   for($x=[Math]::Max(0,$control.Left-$r.Left);$x -lt [Math]::Min($bmp.Width,$control.Right-$r.Left);$x++){
    $pixel=$bmp.GetPixel($x,$y);if($pixel.R -gt 240 -and $pixel.G -gt 240 -and $pixel.B -gt 240){$whitePixels++}
   }
  }
  $whiteFraction=$whitePixels/(($control.Right-$control.Left)*($control.Bottom-$control.Top))
 }
 $g.Dispose();$bmp.Dispose()
}
$gui=[Physical+Gui]::new();$gui.Size=[System.Runtime.InteropServices.Marshal]::SizeOf($gui);[Physical]::GetGUIThreadInfo(0,[ref]$gui)|Out-Null
$appRect=[Physical+Rect]::new();[Physical]::GetWindowRect($parent,[ref]$appRect)|Out-Null
$result=@{tree=$tree;appRect=$appRect;whitePixels=$whitePixels;whiteFraction=$whiteFraction;point=@($px,$py);hit=@{handle=$target.ToInt64();class=[Physical]::Class($target)};gui=$gui;focusText=[Physical]::Text($gui.Focus);focusClass=[Physical]::Class($gui.Focus)}
if($Action -eq 'liveEdit' -and [Physical]::GetAncestor($gui.Focus,2) -eq $parent){[Physical]::Key(13);[Physical]::Key(13,$true)}
$result|ConvertTo-Json -Depth 5 -Compress
