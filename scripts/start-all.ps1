# DigitalPulse - Stage 2 One-Click Startup Script for Windows 11
# Launches Fastify Backend, React Dashboard, and native Rust Desktop Agent

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$lanIp = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" -and $_.PrefixOrigin -ne "WellKnown" } |
    Select-Object -First 1 -ExpandProperty IPAddress)
if (-not $lanIp) {
    $lanIp = "127.0.0.1"
}
$dashboardUrl = "http://$lanIp:5173"

function Get-LocalHttpResponse {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [Parameter(Mandatory = $true)][string]$Method
    )

    try {
        if ($Method -eq "POST") {
            $response = Invoke-WebRequest -Uri $Uri -Method $Method -ContentType "application/json" -Body "{}" -UseBasicParsing -TimeoutSec 3
        } else {
            $response = Invoke-WebRequest -Uri $Uri -Method $Method -UseBasicParsing -TimeoutSec 3
        }
        return [PSCustomObject]@{ StatusCode = [int]$response.StatusCode; Content = $response.Content }
    } catch {
        $response = $_.Exception.Response
        if (-not $response) {
            return [PSCustomObject]@{ StatusCode = 0; Content = "" }
        }
        $body = ""
        try {
            $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
            $body = $reader.ReadToEnd()
        } catch { }
        return [PSCustomObject]@{ StatusCode = [int]$response.StatusCode; Content = $body }
    }
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "    DigitalPulse - Stage 2 Production-Hardened MVP        " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Start Backend Server
Write-Host "`n[1/4] Launching Fastify Backend on http://127.0.0.1:3001..." -ForegroundColor Yellow
$healthResponse = Get-LocalHttpResponse -Uri "http://127.0.0.1:3001/api/v1/health" -Method "GET"
$healthBody = $null
if ($healthResponse.Content) {
    try { $healthBody = $healthResponse.Content | ConvertFrom-Json } catch { }
}
$startBackend = $true
if ($healthBody.service -eq "digitalpulse-backend") {
    $routeProbe = Get-LocalHttpResponse -Uri "http://127.0.0.1:3001/api/v1/employees/route-registration-probe/setup-reminder" -Method "POST"
    if ($routeProbe.StatusCode -eq 401) {
        Write-Host "A DigitalPulse backend with the setup-reminder route is already running; reusing it." -ForegroundColor Green
        $startBackend = $false
    } elseif ($routeProbe.StatusCode -eq 404) {
        throw "An older DigitalPulse backend is still serving port 3001 without POST /api/v1/employees/:employeeId/setup-reminder. Stop that backend process and rerun this script."
    } else {
        throw "The existing DigitalPulse backend returned unexpected route-probe status $($routeProbe.StatusCode). Stop it and rerun this script."
    }
} elseif ($healthResponse.StatusCode -ne 0) {
    throw "Port 3001 is responding, but it is not the expected DigitalPulse backend. Stop the process using port 3001 before starting DigitalPulse."
}
if ($startBackend) {
    Start-Process powershell -ArgumentList "-ExecutionPolicy", "Bypass", "-NoExit", "-Command", "`$env:HOST='0.0.0.0'; `$env:CORS_ORIGINS='$dashboardUrl,http://localhost:5173,http://127.0.0.1:5173'; `$env:INVITATION_ACCEPT_URL='$dashboardUrl/accept-invitation'; Set-Location '$root'; npm run dev:backend"
}

# 2. Start Dashboard
Write-Host "[2/4] Launching Dashboard on http://localhost:5173..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-ExecutionPolicy", "Bypass", "-NoExit", "-Command", "`$env:DP_DASHBOARD_HOST='0.0.0.0'; Set-Location '$root'; npm run dev"

# 3. Start Desktop Agent
Write-Host "[3/4] Launching Rust Windows Desktop Agent..." -ForegroundColor Yellow
$agentPath = Join-Path $root "desktop-agent\target\release\dp-user-agent.exe"

if (Test-Path $agentPath) {
    Start-Process -FilePath $agentPath
} else {
    $cargoCmd = "`$env:PATH = 'D:\Program Files\msys64\ucrt64\bin;' + `$env:USERPROFILE + '\.cargo\bin;' + `$env:PATH; Set-Location '$root\desktop-agent'; cargo run --release --bin dp-user-agent"
    Start-Process powershell -ArgumentList "-NoExit", "-Command", $cargoCmd
}

# 4. Start Enterprise Control Center
Write-Host "[4/4] Launching DigitalPulse Control Center GUI..." -ForegroundColor Yellow
$controlCenterPath = Join-Path $root "dist\DigitalPulse-v0.1.0-win-x64\DigitalPulse-ControlCenter.exe"
if (Test-Path $controlCenterPath) {
    Start-Process -FilePath $controlCenterPath
}

Write-Host "`nAll DigitalPulse subsystems are launching!" -ForegroundColor Green
Write-Host "Laptop URL: http://localhost:5173" -ForegroundColor Cyan
Write-Host "Phone/LAN URL: $dashboardUrl" -ForegroundColor Cyan
