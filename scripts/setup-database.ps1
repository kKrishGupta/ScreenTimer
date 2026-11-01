<#
.SYNOPSIS
  Database initialization helper for DigitalPulse (Stage 1).
.DESCRIPTION
  Creates the 'digitalpulse' PostgreSQL user and database on localhost:5433
  using the PostgreSQL 18 psql client.
#>

param(
  [string]$PgBinPath = "D:\Program Files\PostgreSQL\18\bin",
  [int]$Port = 5433,
  [string]$DbName = "digitalpulse",
  [string]$DbUser = "digitalpulse",
  [string]$DbPassword = "dev_password_pulse_2026",
  [string]$Superuser = "postgres"
)

$ErrorActionPreference = "Stop"

Write-Host "=== DigitalPulse Database Setup ===" -ForegroundColor Cyan
Write-Host "Target: 127.0.0.1:$Port (Database: $DbName, User: $DbUser)"

$psqlExe = Join-Path $PgBinPath "psql.exe"
if (-not (Test-Path $psqlExe)) {
  Write-Error "psql.exe not found at $psqlExe. Please check your PostgreSQL installation path."
  exit 1
}

$sqlScript = @"
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '$DbUser') THEN
    CREATE ROLE $DbUser WITH LOGIN PASSWORD '$DbPassword';
  ELSE
    ALTER ROLE $DbUser WITH PASSWORD '$DbPassword';
  END IF;
END
\$\$;

SELECT 'CREATE DATABASE $DbName OWNER $DbUser'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$DbName')\gexec

GRANT ALL PRIVILEGES ON DATABASE $DbName TO $DbUser;
"@

Write-Host "To execute this script, run in PowerShell as Postgres superuser:" -ForegroundColor Yellow
Write-Host @"
`$env:PGPASSWORD = 'YOUR_POSTGRES_PASSWORD'
& "$psqlExe" -h 127.0.0.1 -p $Port -U $Superuser -c @"
$sqlScript
"@
"@

