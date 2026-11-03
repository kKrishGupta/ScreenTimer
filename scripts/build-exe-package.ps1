# DigitalPulse - Native Windows Package & Executable Builder
# Compiles release binaries, builds Windows Launcher GUI, and packages distribution.

$ErrorActionPreference = "Stop"
$rootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$distDir = Join-Path $rootDir "dist\DigitalPulse-v0.1.0-win-x64"
$cargoPath = "$env:USERPROFILE\.cargo\bin\cargo.exe"
$cscPath = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "       DigitalPulse Executable & Package Builder          " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# Stop any running launcher or agent before file updates so file locks are released
Stop-Process -Name "dp-user-agent" -Force -ErrorAction SilentlyContinue
Stop-Process -Name "DigitalPulse-Launcher" -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 800

# 1. Build Rust Release Executables
Write-Host "`n[1/5] Checking Rust desktop agent release binaries..." -ForegroundColor Yellow
$releaseDir = Join-Path $rootDir "desktop-agent\target\release"
$agentBin = Join-Path $releaseDir "dp-user-agent.exe"

if (-not (Test-Path $agentBin)) {
    Write-Host "Compiling Rust desktop agent in release mode..." -ForegroundColor Yellow
    if (Test-Path $cargoPath) {
        & $cargoPath build --release --manifest-path (Join-Path $rootDir "desktop-agent\Cargo.toml")
    } else {
        cargo build --release --manifest-path (Join-Path $rootDir "desktop-agent\Cargo.toml")
    }
} else {
    Write-Host "Using latest release binaries from $releaseDir" -ForegroundColor Green
}

# 2. Prepare Dist Directory
Write-Host "[2/5] Creating distribution directory structure..." -ForegroundColor Yellow
if (-not (Test-Path $distDir)) {
    New-Item -ItemType Directory -Path $distDir -Force | Out-Null
}
New-Item -ItemType Directory -Path (Join-Path $distDir "extension") -Force | Out-Null

# 3. Copy Native Binaries (with lock protection)
Write-Host "[3/5] Bundling native executables and extension..." -ForegroundColor Yellow
try {
    Copy-Item (Join-Path $releaseDir "dp-user-agent.exe") -Destination $distDir -Force -ErrorAction Stop
} catch {
    Write-Host "dp-user-agent.exe is currently running; existing binary preserved." -ForegroundColor Yellow
}

try {
    Copy-Item (Join-Path $releaseDir "dp-service.exe") -Destination $distDir -Force -ErrorAction Stop
} catch {
    Write-Host "dp-service.exe is currently running; existing binary preserved." -ForegroundColor Yellow
}

# Copy browser extension
$extSrc = Join-Path $rootDir "apps\browser-extension"
Get-ChildItem -Path $extSrc -Exclude "node_modules", "tests" | Copy-Item -Destination (Join-Path $distDir "extension") -Recurse -Force

# 4. Compile Modern Windows Enterprise Control Center (DigitalPulse-ControlCenter.exe)
Write-Host "[4/5] Compiling native Windows Enterprise Control Center GUI..." -ForegroundColor Yellow
Stop-Process -Name "DigitalPulse-ControlCenter", "DigitalPulse-Launcher" -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 300
$controlCenterSrc = Join-Path $rootDir "apps\control-center\src\ControlCenter.cs"
$controlCenterExe = Join-Path $distDir "DigitalPulse-ControlCenter.exe"
$launcherExe = Join-Path $distDir "DigitalPulse-Launcher.exe"

& $cscPath /target:winexe /optimize+ /codepage:65001 /out:$controlCenterExe /reference:System.Windows.Forms.dll,System.Drawing.dll,System.dll $controlCenterSrc

try {
    Copy-Item $controlCenterExe $launcherExe -Force -ErrorAction Stop
} catch {
    Write-Host "Note: DigitalPulse-Launcher.exe was running; updated as DigitalPulse-ControlCenter.exe" -ForegroundColor Yellow
}

# 5. Create Helper Batch Scripts
Write-Host "[5/5] Creating helper scripts and documentation..." -ForegroundColor Yellow

# OneClick-StartAll.bat
@"
@echo off
title DigitalPulse Enterprise - Full Stack Startup
echo ========================================================
echo        DigitalPulse Enterprise Platform
echo ========================================================
echo [1/3] Starting Fastify Backend...
cd /d "%~dp0..\.."
start "DigitalPulse Backend" cmd /k "npm run dev:backend"

echo [2/3] Starting React Dashboard...
start "DigitalPulse Dashboard" cmd /k "npm run dev"

echo [3/4] Starting Desktop Activity Agent...
cd /d "%~dp0"
start "DigitalPulse Agent" "%~dp0dp-user-agent.exe"

echo [4/4] Starting Enterprise Control Center GUI...
start "DigitalPulse Control Center" "%~dp0DigitalPulse-ControlCenter.exe"

echo.
echo All subsystems launched! Opening dashboard at http://localhost:5173 ...
ping 127.0.0.1 -n 4 >nul
start http://localhost:5173
"@ | Set-Content -Path (Join-Path $distDir "OneClick-StartAll.bat") -Encoding ASCII

# Start-Agent.bat
@"
@echo off
title DigitalPulse Desktop Agent
echo Starting DigitalPulse Desktop Agent...
"%~dp0dp-user-agent.exe"
pause
"@ | Set-Content -Path (Join-Path $distDir "Start-Agent.bat") -Encoding ASCII

# Sync-Now.bat
@"
@echo off
title DigitalPulse Sync Now
echo Synchronizing buffered SQLite events to backend...
"%~dp0dp-user-agent.exe" --sync-now
pause
"@ | Set-Content -Path (Join-Path $distDir "Sync-Now.bat") -Encoding ASCII

# README-PACKAGE.txt
@"
==============================================================
         DIGITALPULSE ENTERPRISE - WINDOWS PACKAGE
==============================================================

Welcome to the DigitalPulse standalone executable package.

QUICK START:
1. Double-click 'DigitalPulse-Launcher.exe' to open the graphical control center.
2. Click 'Start Desktop Agent' to begin background application and activity tracking.
3. If you used the computer while offline, click 'Flush & Sync Buffer' to push recorded events.
4. Click 'Open Web Dashboard' to view real-time analytics in your browser (http://localhost:5173).
5. Click 'Launch Full Platform' to start the backend, dashboard, and agent all together.

CHROME / EDGE EXTENSION INSTALLATION:
1. Open Chrome or Edge and navigate to: chrome://extensions
2. Enable 'Developer mode' in the top-right corner.
3. Click 'Load unpacked' and select the 'extension' folder inside this package.

EXECUTABLES IN THIS PACKAGE:
- DigitalPulse-Launcher.exe : Graphical Windows Control Center
- dp-user-agent.exe         : Native High-Performance Windows Activity Collector
- dp-service.exe            : Windows Service Daemon
- OneClick-StartAll.bat     : Launches backend, web UI, and agent together
- Start-Agent.bat           : Console-mode runner with live trace logs
- Sync-Now.bat              : Quick sync trigger for offline SQLite buffer
==============================================================
"@ | Set-Content -Path (Join-Path $distDir "README.txt") -Encoding UTF8

# Create ZIP archive cleanly without locking active runtime databases
Add-Type -AssemblyName System.IO.Compression.FileSystem
$stagingDir = Join-Path $rootDir "dist\staging_clean"
if (Test-Path $stagingDir) { Remove-Item $stagingDir -Recurse -Force }
New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null

Get-ChildItem -Path $distDir -Exclude "*.db*", "*.db-journal", "*.db-wal" | Copy-Item -Destination $stagingDir -Recurse -Force

$zipOutput = Join-Path $rootDir "dist\DigitalPulse-v0.1.0-win-x64.zip"
if (Test-Path $zipOutput) {
    Remove-Item $zipOutput -Force
}
[System.IO.Compression.ZipFile]::CreateFromDirectory($stagingDir, $zipOutput)
Remove-Item $stagingDir -Recurse -Force

Write-Host "`nPackage build complete!" -ForegroundColor Green
Write-Host "Distribution Folder: $distDir" -ForegroundColor Cyan
Write-Host "Standalone ZIP:     $zipOutput" -ForegroundColor Cyan
