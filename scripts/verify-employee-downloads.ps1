[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$downloads = Join-Path $repoRoot 'apps\dashboard\public\downloads'
$names = @('digitalpulse-windows-agent','digitalpulse-chrome-extension','digitalpulse-edge-extension')
$runtimeHashes = @{}
foreach ($name in $names) {
    $path = Join-Path $downloads "$name.zip"
    $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    $expected = (Get-Content -LiteralPath "$path.sha256" -Raw).Split(' ')[0]
    if ($actual -ne $expected) { throw "Checksum mismatch: $name" }
    $archive = [IO.Compression.ZipFile]::OpenRead($path)
    try {
        $files = @($archive.Entries | Where-Object { -not $_.FullName.EndsWith('/') })
        if ($name -eq 'digitalpulse-windows-agent' -and $files.Count -ne 2) { throw 'Windows ZIP contains unexpected files.' }
        foreach ($entry in $files) {
            if ($entry.FullName.Contains('\') -or $entry.FullName.Contains('..') -or -not $entry.FullName.StartsWith("$name/")) { throw 'Unsafe archive entry.' }
            if ($entry.FullName -match '(^|/)(\.env[^/]*|node_modules|tests|target|\.git)(/|$)|\.(db|sqlite|log|pdb|map)$') { throw 'Forbidden package entry.' }
            $stream = $entry.Open()
            try {
                if ($entry.FullName.EndsWith('README.txt')) {
                    $reader = [IO.StreamReader]::new($stream)
                    $text = $reader.ReadToEnd()
                    if ($text -notmatch 'LOCAL DEVELOPMENT / INTERNAL TEST BUILD') { throw 'Local-build notice is missing.' }
                    if ($name -like '*chrome*' -and $text -notmatch 'chrome://extensions') { throw 'Chrome instructions are missing.' }
                    if ($name -like '*edge*' -and $text -notmatch 'edge://extensions') { throw 'Edge instructions are missing.' }
                } else {
                    $sha = [Security.Cryptography.SHA256]::Create()
                    try { $hash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
                    $relative = $entry.FullName.Substring($name.Length + 1)
                    if ($name -eq 'digitalpulse-windows-agent') {
                        if ($relative -ne 'dp-user-agent.exe') { throw 'Unexpected Windows runtime file.' }
                        if ($hash -ne (Get-FileHash -LiteralPath (Join-Path $repoRoot 'desktop-agent\target\release\dp-user-agent.exe') -Algorithm SHA256).Hash.ToLowerInvariant()) { throw 'Packaged executable differs from release build.' }
                    } else {
                        if ($relative -eq 'background/service-worker.js') {
                            $sourceText = [IO.StreamReader]::new($entry.Open())
                            try { $workerSource = $sourceText.ReadToEnd() } finally { $sourceText.Dispose() }
                            if ($workerSource -notmatch "screenshot-capture\.js" -or $workerSource -notmatch "captureAuthorizedActiveTab") { throw "Packaged service worker does not initialize screenshot capture: $name" }
                        }
                        $source = Join-Path (Join-Path $repoRoot 'apps\browser-extension') $relative
                        if ($hash -ne (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()) { throw "Extension runtime source differs: $relative" }
                        if ($runtimeHashes.ContainsKey($relative) -and $runtimeHashes[$relative] -ne $hash) { throw 'Chrome and Edge runtime code diverged.' }
                        $runtimeHashes[$relative] = $hash
                    }
                }
            } finally { $stream.Dispose() }
        }
        Write-Output "Verified $name.zip: $($files.Count) files, $((Get-Item -LiteralPath $path).Length) bytes, SHA256 $actual"
    } finally { $archive.Dispose() }
}

$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
$stageName = 'digitalpulse-package-smoke-' + [guid]::NewGuid().ToString('N')
$stage = [IO.Path]::GetFullPath((Join-Path $tempRoot $stageName))
if (-not $stage.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe smoke-test directory.' }
$savedPath = $env:PATH
$savedDb = $env:DP_DB_PATH
$savedSecret = $env:DP_DEVICE_SECRET
$savedLocalAppData = $env:LOCALAPPDATA
try {
    [IO.Compression.ZipFile]::ExtractToDirectory((Join-Path $downloads 'digitalpulse-windows-agent.zip'), $stage)
    $binary = Join-Path $stage 'digitalpulse-windows-agent\dp-user-agent.exe'
    # Prove the portable binary needs no GNU/MSYS DLL directory on PATH.
    $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot"
    $env:LOCALAPPDATA = Join-Path $stage 'profile'
    Remove-Item Env:DP_DB_PATH -ErrorAction SilentlyContinue
    Remove-Item Env:DP_DEVICE_SECRET -ErrorAction SilentlyContinue
    & $binary --version
    if ($LASTEXITCODE -ne 0) { throw 'Extracted executable could not run with only Windows on PATH.' }
    $ids = @()
    foreach ($cwd in @($stage, (Join-Path $stage 'digitalpulse-windows-agent'))) {
        Push-Location -LiteralPath $cwd
        try {
            $status = & $binary --status
            if ($LASTEXITCODE -ne 0) { throw 'Extracted executable status command failed.' }
            $idLine = @($status | Where-Object { $_ -match '^Device ID:' })
            if ($idLine.Count -ne 1) { throw 'Status omitted the persistent device identity.' }
            $ids += $idLine[0]
            if (($status -join "`n") -notmatch 'NOT ENROLLED') { throw 'Fresh smoke-test storage unexpectedly contains device credentials.' }
            $expectedStorage = Join-Path $env:LOCALAPPDATA 'DigitalPulse\agent_storage.db'
            if (($status -join "`n") -notmatch [regex]::Escape($expectedStorage)) { throw 'The executable did not use its default LOCALAPPDATA storage path.' }
        } finally { Pop-Location }
    }
    if ($ids[0] -ne $ids[1]) { throw 'Device identity changed across process restarts/working directories.' }
    Write-Output 'Extracted executable runs without developer runtime DLLs; the default LOCALAPPDATA database and identity survive two separate status processes and working directories. No backend enrollment or monitoring was performed.'
} finally {
    $env:PATH = $savedPath
    if ($null -eq $savedDb) { Remove-Item Env:DP_DB_PATH -ErrorAction SilentlyContinue } else { $env:DP_DB_PATH = $savedDb }
    if ($null -eq $savedSecret) { Remove-Item Env:DP_DEVICE_SECRET -ErrorAction SilentlyContinue } else { $env:DP_DEVICE_SECRET = $savedSecret }
    if ($null -eq $savedLocalAppData) { Remove-Item Env:LOCALAPPDATA -ErrorAction SilentlyContinue } else { $env:LOCALAPPDATA = $savedLocalAppData }
    if (Test-Path -LiteralPath $stage) {
        $resolved = (Resolve-Path -LiteralPath $stage).Path
        if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -ne $stageName) { throw 'Unsafe smoke-test cleanup path.' }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
