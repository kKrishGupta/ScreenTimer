param([Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$bounds=[System.Windows.Forms.SystemInformation]::VirtualScreen
if($bounds.Width -lt 1 -or $bounds.Height -lt 1){throw 'No interactive display'}
$bitmap=New-Object System.Drawing.Bitmap $bounds.Width,$bounds.Height
$graphics=[System.Drawing.Graphics]::FromImage($bitmap)
try{
  $graphics.CopyFromScreen($bounds.Left,$bounds.Top,0,0,$bitmap.Size,[System.Drawing.CopyPixelOperation]::SourceCopy)
  $codec=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()|Where-Object{$_.MimeType -eq 'image/jpeg'}|Select-Object -First 1
  $parameters=New-Object System.Drawing.Imaging.EncoderParameters 1
  $parameters.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality),75L
  $bitmap.Save($OutputPath,$codec,$parameters)
  Write-Output ("OK:{0}x{1}" -f $bounds.Width,$bounds.Height)
}finally{$graphics.Dispose();$bitmap.Dispose()}
