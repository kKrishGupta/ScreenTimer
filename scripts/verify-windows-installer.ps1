[CmdletBinding()]
param([string]$DownloadDirectory)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if (-not $DownloadDirectory) { $DownloadDirectory = Join-Path $repoRoot 'apps\dashboard\public\downloads' }
$installer = Join-Path $DownloadDirectory 'DigitalPulse-Setup.exe'
$releasePath = Join-Path $DownloadDirectory 'DigitalPulse-Setup.release.json'
$sidecar = "$installer.sha256"
foreach ($path in @($installer, $releasePath, $sidecar)) { if (-not (Test-Path -LiteralPath $path)) { throw "Missing Windows release file: $path" } }
$release = Get-Content -LiteralPath $releasePath -Raw | ConvertFrom-Json
$hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
if ($release.fileName -ne 'DigitalPulse-Setup.exe' -or $release.productVersion -ne '0.1.0' -or $release.sha256 -ne $hash) { throw 'Windows installer release metadata does not match the artifact.' }
if ((Get-Content -LiteralPath $sidecar -Raw).Split(' ')[0].Trim() -ne $hash) { throw 'Windows installer checksum sidecar does not match.' }
foreach ($property in $release.sourceFiles.PSObject.Properties) {
    $path = Join-Path $repoRoot $property.Name.Replace('/', '\')
    if (-not (Test-Path -LiteralPath $path)) { throw "Release source is missing: $($property.Name)" }
    if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $property.Value) { throw "Stale installer: source changed after packaging: $($property.Name)" }
}
$header = [IO.File]::ReadAllBytes($installer)[0..1]
if ($header[0] -ne 0x4d -or $header[1] -ne 0x5a) { throw 'Installer is not a Windows PE executable.' }
[pscustomobject]@{ Installer = $installer; Version = $release.productVersion; Bytes = (Get-Item $installer).Length; SHA256 = $hash; Authenticode = $release.authenticodeStatus }
