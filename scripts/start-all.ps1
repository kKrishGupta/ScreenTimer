# DigitalPulse — Stage 2 One-Click Startup Script for Windows 11
# Launches Fastify Backend, React Dashboard, and native Rust Desktop Agent

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "    DigitalPulse — Stage 2 Production-Hardened MVP        " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# Check Node
try {
    $nodeVersion = node --version
    Write-Host "[OK] Node.js: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Error "Node.js not found in PATH."
}

# 1. Start Backend Server
Write-Host "`n[1/3] Launching Fastify Backend on http://127.0.0.1:3001..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root'; npm run dev:backend"

# 2. Start Dashboard
Write-Host "[2/3] Launching Dashboard on http://localhost:5173..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root'; npm run dev"

# 3. Start Desktop Agent
Write-Host "[3/3] Launching Rust Windows Desktop Agent..." -ForegroundColor Yellow
$agentPath = Join-Path $root "desktop-agent\target\release\dp-user-agent.exe"
if (Test-Path $agentPath) {
    Start-Process powershell -ArgumentList "-NoExit", "-Command", "& '$agentPath'"
} else {
    Start-Process powershell -ArgumentList "-NoExit", "-Command", "`$env:PATH = 'D:\Program Files\msys64\ucrt64\bin;' + `$env:USERPROFILE + '\.cargo\bin;' + `$env:PATH; cd '$root\desktop-agent'; cargo run --release --bin dp-user-agent"
}

Write-Host "`nAll DigitalPulse Stage 2 subsystems launched successfully!" -ForegroundColor Green
Write-Host "Open your browser at: http://localhost:5173" -ForegroundColor Cyan
