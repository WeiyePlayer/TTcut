param(
  [Parameter(Mandatory = $true)]
  [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$output = [System.IO.Path]::GetFullPath($OutputDirectory)
$sourcePath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\public\ttcut-icon.png'))
[System.IO.Directory]::CreateDirectory($output) | Out-Null

if (-not [System.IO.File]::Exists($sourcePath)) {
  throw "The TTcut brand icon is missing: $sourcePath"
}

function Set-HighQualityRendering([System.Drawing.Graphics]$Graphics) {
  $Graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $Graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $Graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
}

function New-IconBitmap([System.Drawing.Image]$Source, [int]$Width, [int]$Height) {
  $bitmap = [System.Drawing.Bitmap]::new($Width, $Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    Set-HighQualityRendering $graphics
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.DrawImage($Source, [System.Drawing.Rectangle]::new(0, 0, $Width, $Height), 0, 0, $Source.Width, $Source.Height, [System.Drawing.GraphicsUnit]::Pixel)
  } finally {
    $graphics.Dispose()
  }
  return $bitmap
}

function Get-PngBytes([System.Drawing.Image]$Source, [int]$Size) {
  $bitmap = New-IconBitmap $Source $Size $Size
  $stream = [System.IO.MemoryStream]::new()
  try {
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    return ,$stream.ToArray()
  } finally {
    $stream.Dispose()
    $bitmap.Dispose()
  }
}

function Write-MultiSizeIcon([System.Drawing.Image]$Source, [string]$Path) {
  $sizes = @(16, 24, 32, 48, 64, 128, 256)
  $images = @()
  foreach ($size in $sizes) {
    $images += ,(Get-PngBytes $Source $size)
  }

  $stream = [System.IO.File]::Create($Path)
  $writer = [System.IO.BinaryWriter]::new($stream)
  try {
    $writer.Write([uint16]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]$images.Count)
    $offset = 6 + (16 * $images.Count)
    for ($index = 0; $index -lt $images.Count; $index++) {
      $size = $sizes[$index]
      $dimension = if ($size -ge 256) { [byte]0 } else { [byte]$size }
      $writer.Write($dimension)
      $writer.Write($dimension)
      $writer.Write([byte]0)
      $writer.Write([byte]0)
      $writer.Write([uint16]1)
      $writer.Write([uint16]32)
      $writer.Write([uint32]$images[$index].Length)
      $writer.Write([uint32]$offset)
      $offset += $images[$index].Length
    }
    foreach ($image in $images) {
      $writer.Write([byte[]]$image)
    }
  } finally {
    $writer.Dispose()
    $stream.Dispose()
  }
}

$source = [System.Drawing.Image]::FromFile($sourcePath)
try {
  Write-MultiSizeIcon $source (Join-Path $output 'ttcut.ico')

  $header = [System.Drawing.Bitmap]::new(150, 57, [System.Drawing.Imaging.PixelFormat]::Format32bppRgb)
  $headerGraphics = [System.Drawing.Graphics]::FromImage($header)
  try {
    Set-HighQualityRendering $headerGraphics
    $headerGraphics.Clear([System.Drawing.Color]::White)
    $headerIcon = New-IconBitmap $source 41 41
    try { $headerGraphics.DrawImage($headerIcon, 92, 8) } finally { $headerIcon.Dispose() }
    $header.Save((Join-Path $output 'header.bmp'), [System.Drawing.Imaging.ImageFormat]::Bmp)
  } finally {
    $headerGraphics.Dispose()
    $header.Dispose()
  }

  $sidebar = [System.Drawing.Bitmap]::new(164, 314, [System.Drawing.Imaging.PixelFormat]::Format32bppRgb)
  $sidebarGraphics = [System.Drawing.Graphics]::FromImage($sidebar)
  try {
    Set-HighQualityRendering $sidebarGraphics
    $sidebarGraphics.Clear([System.Drawing.ColorTranslator]::FromHtml('#F3F3F3'))
    $sidebarIcon = New-IconBitmap $source 104 104
    try { $sidebarGraphics.DrawImage($sidebarIcon, 30, 42) } finally { $sidebarIcon.Dispose() }
    $titleFont = [System.Drawing.Font]::new('Segoe UI', 22, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $format = [System.Drawing.StringFormat]::new()
    try {
      $format.Alignment = [System.Drawing.StringAlignment]::Center
      $sidebarGraphics.DrawString('TTcut', $titleFont, [System.Drawing.Brushes]::Black, [System.Drawing.RectangleF]::new(0, 166, 164, 40), $format)
    } finally {
      $format.Dispose()
      $titleFont.Dispose()
    }
    $sidebar.Save((Join-Path $output 'sidebar.bmp'), [System.Drawing.Imaging.ImageFormat]::Bmp)
  } finally {
    $sidebarGraphics.Dispose()
    $sidebar.Dispose()
  }
} finally {
  $source.Dispose()
}

Write-Output "Generated TTcut installer assets from $sourcePath in $output"
