param(
    [string]$PgBinPath = "D:\Program Files\PostgreSQL\18\bin",
    [int]$Port = 5433,
    [string]$DbName = "digitalpulse",
    [string]$DbUser = "digitalpulse",
    [string]$Superuser = "postgres"
)

$ErrorActionPreference = "Stop"

$psqlExe = Join-Path $PgBinPath "psql.exe"
$createdbExe = Join-Path $PgBinPath "createdb.exe"

if (-not (Test-Path $psqlExe)) {
    throw "psql.exe not found: $psqlExe"
}

if (-not (Test-Path $createdbExe)) {
    throw "createdb.exe not found: $createdbExe"
}

Write-Host "DigitalPulse PostgreSQL Setup" -ForegroundColor Cyan

$DbPassword = Read-Host "Enter a strong password for the digitalpulse database user" -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($DbPassword)

try {
    $plainDbPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)

    $SuperPassword = Read-Host "Enter PostgreSQL postgres superuser password" -AsSecureString
    $superPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SuperPassword)

    try {
        $env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($superPtr)

        & $psqlExe -h 127.0.0.1 -p $Port -U $Superuser -d postgres -v ON_ERROR_STOP=1 -c "SELECT 1;"

        if ($LASTEXITCODE -ne 0) {
            throw "PostgreSQL connection failed. Check server, port and superuser password."
        }

        $escapedPassword = $plainDbPassword.Replace("'", "''")

        $roleSql = "DO `$`$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$DbUser') THEN CREATE ROLE $DbUser WITH LOGIN PASSWORD '$escapedPassword'; ELSE ALTER ROLE $DbUser WITH LOGIN PASSWORD '$escapedPassword'; END IF; END `$`$;"

        & $psqlExe -h 127.0.0.1 -p $Port -U $Superuser -d postgres -v ON_ERROR_STOP=1 -c $roleSql

        if ($LASTEXITCODE -ne 0) {
            throw "Failed to configure database role."
        }

        $exists = & $psqlExe -h 127.0.0.1 -p $Port -U $Superuser -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$DbName';"

        if ($LASTEXITCODE -ne 0) {
            throw "Could not check database existence."
        }

        if (($exists -join "").Trim() -ne "1") {
            & $createdbExe -h 127.0.0.1 -p $Port -U $Superuser -O $DbUser $DbName

            if ($LASTEXITCODE -ne 0) {
                throw "Database creation failed."
            }

            Write-Host "Database created." -ForegroundColor Green
        }
        else {
            Write-Host "Database already exists. Existing data will be preserved." -ForegroundColor Yellow
        }

        & $psqlExe -h 127.0.0.1 -p $Port -U $Superuser -d postgres -v ON_ERROR_STOP=1 -c "ALTER DATABASE $DbName OWNER TO $DbUser;"

        if ($LASTEXITCODE -ne 0) {
            throw "Database ownership configuration failed."
        }

        $env:PGPASSWORD = $plainDbPassword

        & $psqlExe -h 127.0.0.1 -p $Port -U $DbUser -d $DbName -v ON_ERROR_STOP=1 -c "SELECT current_database(), current_user;"

        if ($LASTEXITCODE -ne 0) {
            throw "DigitalPulse database login verification failed."
        }

        Write-Host "Database setup completed successfully!" -ForegroundColor Green
        Write-Host "DATABASE_URL=postgresql://${DbUser}:YOUR_URL_ENCODED_PASSWORD@127.0.0.1:${Port}/${DbName}?schema=public"
    }
    finally {
        $env:PGPASSWORD = $null
        if ($superPtr -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($superPtr)
        }
    }
}
finally {
    $env:PGPASSWORD = $null
    if ($ptr -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    }
}
