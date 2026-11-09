param([string]$Inventory = 'inventory-baseline.json', [string]$Output = 'pe-baseline.json')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$evidence = Join-Path $root 'artifacts/windows-exe-audit-20261108'
$inspection = Join-Path $evidence 'pe-inspection'
New-Item -ItemType Directory -Force -Path $inspection | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
$cache = @{}
$rows = foreach ($row in (Get-Content -Raw -LiteralPath (Join-Path $evidence $Inventory) | ConvertFrom-Json)) {
    if (-not $cache.ContainsKey($row.sha256)) {
        $path = Join-Path $root $row.path
        if ($row.path.Contains('!')) {
            $parts = $row.path.Split('!',2)
            $zip = [IO.Compression.ZipFile]::OpenRead((Join-Path $root $parts[0]))
            try {
                $path = Join-Path $inspection ($row.sha256 + '.exe')
                if (-not (Test-Path -LiteralPath $path)) {
                    [IO.Compression.ZipFileExtensions]::ExtractToFile($zip.GetEntry($parts[1]),$path,$false)
                }
            } finally { $zip.Dispose() }
        }
        $signature = Get-AuthenticodeSignature -LiteralPath $path
        $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($path)
        $cache[$row.sha256] = @{
            signatureStatus = [string]$signature.Status
            fileVersion = $version.FileVersion
            productVersion = $version.ProductVersion
            productName = $version.ProductName
            signer = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }
        }
    }
    [PSCustomObject]@{ path=$row.path; sha256=$row.sha256; metadata=$cache[$row.sha256] }
}
$rows | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $evidence $Output) -Encoding UTF8
Write-Output "Inspected $($rows.Count) paths, $($cache.Count) unique executable hashes"
