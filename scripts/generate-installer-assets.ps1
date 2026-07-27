param(
  [Parameter(Mandatory = $true)]
  [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$output = [System.IO.Path]::GetFullPath($OutputDirectory)
[System.IO.Directory]::CreateDirectory($output) | Out-Null

function New-RoundedRectanglePath([System.Drawing.RectangleF]$Bounds, [single]$Radius) {
  $diameter = $Radius * 2
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $path.AddArc($Bounds.X, $Bounds.Y, $diameter, $diameter, 180, 90)
  $path.AddArc($Bounds.Right - $diameter, $Bounds.Y, $diameter, $diameter, 270, 90)
  $path.AddArc($Bounds.Right - $diameter, $Bounds.Bottom - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($Bounds.X, $Bounds.Bottom - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-TTBadge([System.Drawing.Graphics]$Graphics, [System.Drawing.RectangleF]$Bounds, [single]$FontSize) {
  $start = [System.Drawing.ColorTranslator]::FromHtml('#4C8DF8')
  $end = [System.Drawing.ColorTranslator]::FromHtml('#2567D8')
  $brush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
    $Bounds,
    $start,
    $end,
    [System.Drawing.Drawing2D.LinearGradientMode]::ForwardDiagonal
  )
  $path = New-RoundedRectanglePath $Bounds ([Math]::Max(5, $Bounds.Width * 0.22))
  $Graphics.FillPath($brush, $path)
  $font = [System.Drawing.Font]::new('Segoe UI', $FontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $format = [System.Drawing.StringFormat]::new()
  $format.Alignment = [System.Drawing.StringAlignment]::Center
  $format.LineAlignment = [System.Drawing.StringAlignment]::Center
  $Graphics.DrawString('TT', $font, [System.Drawing.Brushes]::White, $Bounds, $format)
  $format.Dispose()
  $font.Dispose()
  $path.Dispose()
  $brush.Dispose()
}

$iconBitmap = [System.Drawing.Bitmap]::new(256, 256, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$iconGraphics = [System.Drawing.Graphics]::FromImage($iconBitmap)
$iconGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$iconGraphics.Clear([System.Drawing.Color]::Transparent)
New-TTBadge $iconGraphics ([System.Drawing.RectangleF]::new(16, 16, 224, 224)) 100
$icon = [System.Drawing.Icon]::FromHandle($iconBitmap.GetHicon())
$iconStream = [System.IO.File]::Create((Join-Path $output 'ttcut.ico'))
try { $icon.Save($iconStream) } finally { $iconStream.Dispose(); $icon.Dispose(); $iconGraphics.Dispose(); $iconBitmap.Dispose() }

$header = [System.Drawing.Bitmap]::new(150, 57)
$headerGraphics = [System.Drawing.Graphics]::FromImage($header)
$headerGraphics.Clear([System.Drawing.Color]::White)
New-TTBadge $headerGraphics ([System.Drawing.RectangleF]::new(92, 8, 41, 41)) 19
$header.Save((Join-Path $output 'header.bmp'), [System.Drawing.Imaging.ImageFormat]::Bmp)
$headerGraphics.Dispose()
$header.Dispose()

$sidebar = [System.Drawing.Bitmap]::new(164, 314)
$sidebarGraphics = [System.Drawing.Graphics]::FromImage($sidebar)
$sidebarGraphics.Clear([System.Drawing.ColorTranslator]::FromHtml('#F3F3F3'))
New-TTBadge $sidebarGraphics ([System.Drawing.RectangleF]::new(30, 42, 104, 104)) 46
$titleFont = [System.Drawing.Font]::new('Segoe UI', 22, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$format = [System.Drawing.StringFormat]::new()
$format.Alignment = [System.Drawing.StringAlignment]::Center
$sidebarGraphics.DrawString('TTcut', $titleFont, [System.Drawing.Brushes]::Black, [System.Drawing.RectangleF]::new(0, 166, 164, 40), $format)
$sidebar.Save((Join-Path $output 'sidebar.bmp'), [System.Drawing.Imaging.ImageFormat]::Bmp)
$format.Dispose()
$titleFont.Dispose()
$sidebarGraphics.Dispose()
$sidebar.Dispose()

Write-Output "Generated TTcut installer assets in $output"
