param(
    [string]$TabArg = "0",
    [string]$OutName = "control_center_live.png"
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Stop-Process -Name "DigitalPulse-ControlCenter", "DigitalPulse-Launcher" -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 400

# Launch the newly compiled Control Center
$exePath = "D:\desktop\task2\DigitalPulse\dist\DigitalPulse-v0.1.0-win-x64\DigitalPulse-ControlCenter.exe"
$proc = Start-Process -FilePath $exePath -ArgumentList "--tab $TabArg" -PassThru
Start-Sleep -Seconds 3

# Capture primary screen
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)

$destPath = "C:\Users\dell\.gemini\antigravity\brain\0d22f141-db3a-44eb-8cc8-152c6432e90f\$OutName"
$bmp.Save($destPath, [System.Drawing.Imaging.ImageFormat]::Png)
$gfx.Dispose()
$bmp.Dispose()

Write-Host "Screenshot successfully saved to: $destPath"
Write-Host "Process ID: $($proc.Id), Name: $($proc.ProcessName)"
