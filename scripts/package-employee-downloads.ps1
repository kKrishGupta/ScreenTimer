[CmdletBinding()]
param(
    [switch]$Overwrite,
    [switch]$ExtensionsOnly,
    [ValidateSet('Local', 'Production')][string]$Deployment = 'Production'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
& node (Join-Path $repoRoot 'scripts/configure-browser-extension.mjs') "--target=$($Deployment.ToLowerInvariant())"
if ($LASTEXITCODE -ne 0) { throw 'Extension backend configuration failed. No downloads published.' }
$downloadDir = Join-Path $repoRoot 'apps\dashboard\public\downloads'
$extensionSource = Join-Path $repoRoot 'apps\browser-extension'
$binary = Join-Path $repoRoot 'desktop-agent\target\release\dp-user-agent.exe'
$manifestPath = Join-Path $extensionSource 'manifest.json'
$packageNames = @('digitalpulse-windows-agent', 'digitalpulse-chrome-extension', 'digitalpulse-edge-extension')
if ($ExtensionsOnly) { $packageNames = @('digitalpulse-chrome-extension', 'digitalpulse-edge-extension') }
$outputs = @($packageNames | ForEach-Object { "${_}.zip"; "${_}.zip.sha256" })
foreach ($name in $outputs) {
    if ((Test-Path -LiteralPath (Join-Path $downloadDir $name)) -and -not $Overwrite) {
        throw "Download already exists: $name. Review it and pass -Overwrite explicitly to replace this package set."
    }
}
foreach ($path in @($manifestPath, (Join-Path $repoRoot 'docs\installation\windows-agent.txt'), (Join-Path $repoRoot 'docs\installation\browser-extension.txt'))) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required package source is missing: $path" }
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.manifest_version -ne 3) { throw 'A Manifest V3 extension is required.' }
foreach ($size in @(16, 48, 128)) {
    $icon = Join-Path $extensionSource $manifest.icons."$size"
    if (-not (Test-Path -LiteralPath $icon -PathType Leaf)) { throw "Missing extension icon: $size" }
    $bytes = [IO.File]::ReadAllBytes($icon)
    if ($bytes.Length -lt 24 -or $bytes[0] -ne 137 -or $bytes[1] -ne 80 -or $bytes[2] -ne 78 -or $bytes[3] -ne 71) { throw "Invalid PNG icon: $size" }
    $width = ($bytes[16] -shl 24) -bor ($bytes[17] -shl 16) -bor ($bytes[18] -shl 8) -bor $bytes[19]
    $height = ($bytes[20] -shl 24) -bor ($bytes[21] -shl 16) -bor ($bytes[22] -shl 8) -bor $bytes[23]
    if ($width -ne $size -or $height -ne $size) { throw "Incorrect icon dimensions: $size" }
}
foreach ($relative in @($manifest.background.service_worker, $manifest.action.default_popup)) {
    if (-not (Test-Path -LiteralPath (Join-Path $extensionSource $relative) -PathType Leaf)) { throw "Manifest runtime file is missing: $relative" }
}

if (-not $ExtensionsOnly) {
Push-Location -LiteralPath (Join-Path $repoRoot 'desktop-agent')
try {
    # rustup selects the checked-in GNU toolchain from this directory. Merely
    # passing --manifest-path from another directory selects the wrong toolchain.
    & cargo build --release --locked -p dp-user-agent
    if ($LASTEXITCODE -ne 0) { throw 'Windows agent release build failed. No downloads were published.' }
} finally { Pop-Location }
if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw 'The Windows release executable is missing.' }
& $binary --version
if ($LASTEXITCODE -ne 0) { throw 'The release executable did not start successfully.' }
}

$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
$stageName = 'digitalpulse-employee-package-' + [guid]::NewGuid().ToString('N')
$stage = [IO.Path]::GetFullPath((Join-Path $tempRoot $stageName))
if (-not $stage.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe temporary staging directory.' }
$published = [Collections.Generic.List[string]]::new()
$backedUp = [Collections.Generic.List[string]]::new()
try {
    New-Item -ItemType Directory -Path $stage | Out-Null
    $bundles = Join-Path $stage 'bundles'
    $archives = Join-Path $stage 'archives'
    $backup = Join-Path $stage 'backup'
    New-Item -ItemType Directory -Path $bundles,$archives,$backup | Out-Null
    foreach ($name in $packageNames) {
        $parent = Join-Path $bundles $name
        $folder = Join-Path $parent $name
        New-Item -ItemType Directory -Path $folder -Force | Out-Null
        if ($name -eq 'digitalpulse-windows-agent') {
            Copy-Item -LiteralPath $binary -Destination (Join-Path $folder 'dp-user-agent.exe')
            Copy-Item -LiteralPath (Join-Path $repoRoot 'docs\installation\windows-agent.txt') -Destination (Join-Path $folder 'README.txt')
        } else {
            Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $folder 'manifest.json')
            foreach ($dir in @('background','popup','shared','icons')) {
                $source = Join-Path $extensionSource $dir
                if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw "Missing extension directory: $dir" }
                $entries = @(Get-ChildItem -LiteralPath $source -Recurse -Force)
                if (@($entries | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw 'Extension runtime source must not contain symlinks or junctions.' }
                Copy-Item -LiteralPath $source -Destination (Join-Path $folder $dir) -Recurse
            }
            $browser = if ($name -like '*chrome*') { 'Chrome' } else { 'Edge' }
            $slug = $browser.ToLowerInvariant()
            $readme = (Get-Content -LiteralPath (Join-Path $repoRoot 'docs\installation\browser-extension.txt') -Raw).Replace('__BROWSER__',$browser).Replace('__SLUG__',$slug).Replace('__EXTENSIONS_PAGE__',"${slug}://extensions")
            [IO.File]::WriteAllText((Join-Path $folder 'README.txt'), $readme, [Text.UTF8Encoding]::new($false))
        }
        foreach ($textFile in Get-ChildItem -LiteralPath $folder -Recurse -File | Where-Object { $_.Extension -in @('.js','.json','.html','.css','.txt') }) {
            $content = [IO.File]::ReadAllText($textFile.FullName)
            if ($content -match '(?i)dp_(sec|enroll|inv)_[a-f0-9]{32,}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|postgres(ql)?://[^\s/:]+:[^\s/@]+@') {
                throw "Credential-like material detected in staged file $($textFile.Name). No packages were published."
            }
        }
        $zipPath = Join-Path $archives "${name}.zip"
        # Windows PowerShell's older .NET uses backslashes in CreateFromDirectory.
        # Write normalized ZIP entry names so browsers can load the extracted tree.
        $writer = [IO.Compression.ZipFile]::Open($zipPath, [IO.Compression.ZipArchiveMode]::Create)
        try {
            foreach ($file in Get-ChildItem -LiteralPath $parent -Recurse -File) {
                $entryName = $file.FullName.Substring($parent.Length + 1).Replace('\','/')
                [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($writer, $file.FullName, $entryName, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
            }
        } finally { $writer.Dispose() }
        $zip = [IO.Compression.ZipFile]::OpenRead($zipPath)
        try {
            $files = @($zip.Entries | Where-Object { -not $_.FullName.EndsWith('/') })
            $required = if ($name -eq 'digitalpulse-windows-agent') { @('dp-user-agent.exe','README.txt') } else { @('manifest.json','README.txt',$manifest.background.service_worker,$manifest.action.default_popup,'icons/icon-16.png','icons/icon-48.png','icons/icon-128.png','shared/constants.js','shared/backend-settings.js') }
            foreach ($relative in $required) {
                $entry = $zip.GetEntry("$name/$relative")
                if ($null -eq $entry -or $entry.Length -eq 0) { throw "Archive $name is missing $relative" }
            }
            if ($name -eq 'digitalpulse-windows-agent' -and $files.Count -ne 2) { throw 'Windows ZIP must contain only the executable and README.' }
            foreach ($entry in $files) {
                if ($entry.FullName -match '(^|/)(\.env[^/]*|node_modules|tests|target|\.git)(/|$)' -or $entry.FullName -match '\.(db|sqlite|pdb|log|map)$') { throw "Forbidden package file: $($entry.FullName)" }
                if ($name -ne 'digitalpulse-windows-agent' -and $entry.FullName -notmatch '^[^/]+/(manifest\.json|README\.txt|(background|popup|shared|icons)/[^.][^/]*\.(js|html|css|png))$') { throw "Unexpected extension package file: $($entry.FullName)" }
                $stream = $entry.Open()
                try { $buffer = New-Object byte[] 65536; while ($stream.Read($buffer,0,$buffer.Length) -gt 0) {} } finally { $stream.Dispose() }
            }
        } finally { $zip.Dispose() }
        $hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
        [IO.File]::WriteAllText("$zipPath.sha256", "$hash  ${name}.zip`n", [Text.Encoding]::ASCII)
        $checkHash = (Get-Content -LiteralPath "$zipPath.sha256" -Raw).Split(' ')[0]
        if ($checkHash -ne (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()) { throw "Checksum verification failed: $name" }
    }
    # Publish only after ALL three archives pass verification. Roll back on any
    # failure, including restoring downloads replaced with explicit -Overwrite.
    New-Item -ItemType Directory -Path $downloadDir -Force | Out-Null
    try {
        foreach ($name in $outputs) {
            $target = Join-Path $downloadDir $name
            if (Test-Path -LiteralPath $target) {
                if (-not $Overwrite) { throw "Download appeared during build: $name" }
                Move-Item -LiteralPath $target -Destination (Join-Path $backup $name)
                $backedUp.Add($name)
            }
            Move-Item -LiteralPath (Join-Path $archives $name) -Destination $target
            $published.Add($name)
        }
    } catch {
        foreach ($name in $published) { Move-Item -LiteralPath (Join-Path $downloadDir $name) -Destination (Join-Path $archives $name) }
        foreach ($name in $backedUp) { Move-Item -LiteralPath (Join-Path $backup $name) -Destination (Join-Path $downloadDir $name) }
        throw
    }
    foreach ($name in $packageNames) {
        $path = Join-Path $downloadDir "${name}.zip"
        [pscustomobject]@{ Package = $path; Bytes = (Get-Item -LiteralPath $path).Length; SHA256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
} finally {
    if (Test-Path -LiteralPath $stage) {
        $resolved = (Resolve-Path -LiteralPath $stage).Path
        if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -ne $stageName) { throw 'Refusing to remove an unsafe staging directory.' }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
