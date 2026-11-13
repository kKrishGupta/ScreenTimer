[CmdletBinding()]
param(
    [string]$OutputDirectory,
    [ValidateSet('win-x64')][string]$Runtime = 'win-x64',
    [switch]$Overwrite,
    [switch]$RequireSignature
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repoRoot 'apps\dashboard\public\downloads' }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$artifactName = 'DigitalPulse-Setup.exe'
$artifactPath = Join-Path $OutputDirectory $artifactName
$sidecarPath = "$artifactPath.sha256"
$releasePath = Join-Path $OutputDirectory 'DigitalPulse-Setup.release.json'
foreach ($path in @($artifactPath, $sidecarPath, $releasePath)) {
    if ((Test-Path -LiteralPath $path) -and -not $Overwrite) { throw "Release artifact exists: $path. Pass -Overwrite only after reviewing it." }
}

$wix = Join-Path $repoRoot '.tools\wix.exe'
if (-not (Test-Path -LiteralPath $wix)) { throw 'WiX 5 is required at .tools\wix.exe. Install version 5.0.2; do not accept an unreviewed WiX 7 OSMF EULA.' }
if ((& $wix --version) -notmatch '^5\.') { throw 'This release pipeline is pinned to the reviewed WiX 5 toolchain.' }
$wixExtensionRoot = Join-Path $env:USERPROFILE '.wix\extensions'
$uiExtension = Join-Path $wixExtensionRoot 'WixToolset.UI.wixext\5.0.2\wixext5\WixToolset.UI.wixext.dll'
$balExtension = Join-Path $wixExtensionRoot 'WixToolset.BootstrapperApplications.wixext\5.0.2\wixext5\WixToolset.BootstrapperApplications.wixext.dll'
$utilExtension = Join-Path $repoRoot '.wix\extensions\WixToolset.Util.wixext\5.0.2\wixext5\WixToolset.Util.wixext.dll'
foreach ($extension in @($uiExtension, $balExtension, $utilExtension)) { if (-not (Test-Path -LiteralPath $extension)) { throw "Required WiX extension is missing: $extension" } }
$webViewBootstrapper = Join-Path $repoRoot '.tools\MicrosoftEdgeWebview2Setup.exe'
if (-not (Test-Path -LiteralPath $webViewBootstrapper) -or (Get-Item $webViewBootstrapper).Length -lt 1MB) { throw 'The reviewed Microsoft WebView2 Evergreen bootstrapper is missing.' }
$expectedWebViewHash = 'cf2f2445fef0c5c14e372045f84998771eeb8bb01d59be4afd00692fa160082e'
if ((Get-FileHash -LiteralPath $webViewBootstrapper -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedWebViewHash) { throw 'The Microsoft WebView2 bootstrapper does not match the reviewed SHA-256.' }

$stageName = 'DigitalPulseInstaller-' + [Guid]::NewGuid().ToString('N')
$stageRoot = Join-Path ([IO.Path]::GetTempPath()) $stageName
$payloadDir = Join-Path $stageRoot 'payload'
$msiPath = Join-Path $stageRoot 'DigitalPulse.msi'
$builtSetup = Join-Path $stageRoot $artifactName
New-Item -ItemType Directory -Path $payloadDir -Force | Out-Null

function Invoke-Checked([string]$label, [scriptblock]$command) {
    & $command
    if ($LASTEXITCODE -ne 0) { throw "$label failed with exit code $LASTEXITCODE." }
}

try {
    $agentManifest = Join-Path $repoRoot 'desktop-agent\Cargo.toml'
    Invoke-Checked 'Rust agent build' { cargo build --manifest-path $agentManifest --release -p dp-user-agent --locked }
    $agentSource = Join-Path $repoRoot 'desktop-agent\target\release\dp-user-agent.exe'
    if (-not (Test-Path -LiteralPath $agentSource)) { throw 'Rust build did not produce dp-user-agent.exe.' }

    $desktopRoot = Join-Path $repoRoot 'apps\control-center-tauri'
    $tauriManifest = Join-Path $desktopRoot 'src-tauri\Cargo.toml'
    # The Tauri CLI sets the production configuration environment before Cargo
    # runs. A direct cargo build would embed build.devUrl and produce an app that
    # incorrectly depends on a localhost Vite server.
    Invoke-Checked 'Tauri production build' { & npm.cmd exec --workspace @digitalpulse/control-center-tauri tauri build -- --no-bundle }
    $tauriSource = Join-Path $desktopRoot 'src-tauri\target\release\DigitalPulse.exe'
    if (-not (Test-Path -LiteralPath $tauriSource)) { throw 'Tauri build did not produce DigitalPulse.exe.' }
    Copy-Item -LiteralPath $tauriSource -Destination (Join-Path $payloadDir 'DigitalPulse.exe')
    $controlSource = Join-Path $payloadDir 'DigitalPulse.exe'
    Copy-Item -LiteralPath $agentSource -Destination (Join-Path $payloadDir 'dp-user-agent.exe')
    Get-ChildItem -LiteralPath $payloadDir -Recurse -File | Where-Object { $_.Extension -in @('.pdb','.xml') } | Remove-Item -Force

    $productSource = Join-Path $repoRoot 'apps\windows-installer\Product.wxs'
    $bundleSource = Join-Path $repoRoot 'apps\windows-installer\Bundle.wxs'
    Invoke-Checked 'WebView2 detection verification' { & (Join-Path $repoRoot 'scripts\verify-webview2-detection.ps1') -BundlePath $bundleSource }
    Invoke-Checked 'WiX MSI build' { & $wix build $productSource -arch x64 -ext $uiExtension -d "PayloadDir=$payloadDir" -o $msiPath }
    Invoke-Checked 'WiX bundle build' { & $wix build $bundleSource -arch x64 -ext $balExtension -ext $utilExtension -d "MsiPath=$msiPath" -d "WebView2Path=$webViewBootstrapper" -o $builtSetup }
    if (-not (Test-Path -LiteralPath $builtSetup) -or (Get-Item $builtSetup).Length -lt 1MB) { throw 'WiX did not produce a valid setup bundle.' }
    $header = [IO.File]::ReadAllBytes($builtSetup)[0..1]
    if ($header[0] -ne 0x4d -or $header[1] -ne 0x5a) { throw 'Setup bundle is not a Windows PE executable.' }

    $testRoot = Join-Path $stageRoot 'msi-extraction'
    # A separate state root models %LOCALAPPDATA%\DigitalPulse. The MSI owns
    # only INSTALLFOLDER and must not reach outside it during install/uninstall.
    $stateRoot = Join-Path $stageRoot 'protected-local-state\DigitalPulse'
    $sentinel = Join-Path $stateRoot 'device-identity-and-queue.test'
    New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
    [IO.File]::WriteAllText($sentinel, 'installer preservation test')
    try {
        # WiX extracts the embedded cabinet without invoking Windows Installer,
        # so verification cannot alter the installed product registration.
        $decompiledSource = Join-Path $testRoot 'decompiled.wxs'
        $extractedFiles = Join-Path $testRoot 'payload'
        New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
        Invoke-Checked 'MSI payload extraction' { & $wix msi decompile $msiPath -x $extractedFiles -o $decompiledSource }
        $controlExtracted = Join-Path $extractedFiles 'File\DigitalPulseExe'
        if (-not (Test-Path -LiteralPath $controlExtracted)) { throw 'Extracted MSI payload is missing DigitalPulse.exe.' }
        $agentHash = (Get-FileHash -LiteralPath $agentSource -Algorithm SHA256).Hash
        $extractedAgent = Get-ChildItem -LiteralPath (Join-Path $extractedFiles 'File') -File | Where-Object {
            $_.FullName -ne $controlExtracted -and (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash -eq $agentHash
        } | Select-Object -First 1
        if (-not $extractedAgent) { throw 'Extracted MSI payload is missing dp-user-agent.exe.' }
        if ((Get-FileHash -LiteralPath $controlExtracted -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $controlSource -Algorithm SHA256).Hash) { throw 'Extracted DigitalPulse.exe does not match the built payload.' }
        $smokeExecutable = Join-Path $testRoot 'DigitalPulse-extracted.exe'
        Copy-Item -LiteralPath $controlExtracted -Destination $smokeExecutable
        $smokeProcess = Start-Process -FilePath $smokeExecutable -ArgumentList '--smoke-test' -Wait -PassThru -WindowStyle Hidden
        if ($smokeProcess.ExitCode -ne 0) { throw 'Extracted Control Center launch smoke test failed.' }
        if (-not (Test-Path -LiteralPath $sentinel)) { throw 'MSI verification modified protected DigitalPulse local state.' }
    } finally {
        if (Test-Path -LiteralPath $sentinel) { Remove-Item -LiteralPath $sentinel -Force }
    }

    $signature = Get-AuthenticodeSignature -LiteralPath $builtSetup
    if ($RequireSignature -and $signature.Status -ne 'Valid') { throw "Authenticode signature is required; current status is $($signature.Status)." }
    $sourceFiles = @(
        Get-Item -LiteralPath (Join-Path $repoRoot 'package.json'), (Join-Path $repoRoot 'package-lock.json'), $PSCommandPath, (Join-Path $repoRoot 'scripts\verify-webview2-detection.ps1'), (Join-Path $desktopRoot 'package.json'), (Join-Path $desktopRoot 'index.html'), (Join-Path $desktopRoot 'tsconfig.json'), (Join-Path $desktopRoot 'vite.config.ts'), $tauriManifest, (Join-Path $desktopRoot 'src-tauri\Cargo.lock'), (Join-Path $desktopRoot 'src-tauri\build.rs'), (Join-Path $desktopRoot 'src-tauri\tauri.conf.json'), (Join-Path $repoRoot 'desktop-agent\Cargo.toml'), (Join-Path $repoRoot 'desktop-agent\Cargo.lock'), $productSource, $bundleSource
        Get-ChildItem -LiteralPath (Join-Path $desktopRoot 'src') -Recurse -File
        Get-ChildItem -LiteralPath (Join-Path $desktopRoot 'src-tauri\src') -Recurse -File
        Get-ChildItem -LiteralPath (Join-Path $desktopRoot 'src-tauri\capabilities') -Recurse -File
        Get-ChildItem -LiteralPath (Join-Path $desktopRoot 'src-tauri\icons') -Recurse -File
        Get-ChildItem -LiteralPath (Join-Path $repoRoot 'desktop-agent\crates') -Recurse -File | Where-Object { $_.Name -eq 'Cargo.toml' -or $_.Extension -eq '.rs' }
    ) | Sort-Object FullName -Unique
    $sourceHashes = [ordered]@{}
    foreach ($file in $sourceFiles) {
        $relative = $file.FullName.Substring($repoRoot.Length + 1).Replace('\','/')
        $sourceHashes[$relative] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    $setupHash = (Get-FileHash -LiteralPath $builtSetup -Algorithm SHA256).Hash.ToLowerInvariant()
    $release = [ordered]@{
        schemaVersion = 1; productVersion = '0.2.0'; fileName = $artifactName
        sha256 = $setupHash; bytes = (Get-Item -LiteralPath $builtSetup).Length
        controlCenterSha256 = (Get-FileHash -LiteralPath $controlSource -Algorithm SHA256).Hash.ToLowerInvariant()
        agentSha256 = (Get-FileHash -LiteralPath (Join-Path $payloadDir 'dp-user-agent.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
        webView2BootstrapperSha256 = (Get-FileHash -LiteralPath $webViewBootstrapper -Algorithm SHA256).Hash.ToLowerInvariant()
        webView2Detection = [ordered]@{
            mechanism = 'Microsoft EdgeUpdate WebView2 Evergreen pv registration'
            clientId = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
            minimumVersionExclusive = '0.0.0.0'
            registryViews = @('HKLM-32', 'HKLM-64', 'HKCU-32', 'HKCU-64')
        }
        authenticodeStatus = [string]$signature.Status; installerTechnology = 'WiX 5 Burn + MSI'
        sourceFiles = $sourceHashes
    }
    $stagedRelease = Join-Path $stageRoot 'DigitalPulse-Setup.release.json'
    [IO.File]::WriteAllText($stagedRelease, ($release | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
    $stagedSidecar = Join-Path $stageRoot 'DigitalPulse-Setup.exe.sha256'
    [IO.File]::WriteAllText($stagedSidecar, "$setupHash  $artifactName`n", [Text.Encoding]::ASCII)

    New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
    Copy-Item -LiteralPath $builtSetup -Destination $artifactPath -Force
    Copy-Item -LiteralPath $stagedSidecar -Destination $sidecarPath -Force
    Copy-Item -LiteralPath $stagedRelease -Destination $releasePath -Force
    [pscustomobject]@{ Installer = $artifactPath; Version = '0.2.0'; Bytes = (Get-Item $artifactPath).Length; SHA256 = $setupHash; Authenticode = [string]$signature.Status; Technology = 'WiX 5 Burn + MSI' }
} finally {
    if (Test-Path -LiteralPath $stageRoot) {
        $resolved = (Resolve-Path -LiteralPath $stageRoot).Path
        if (-not $resolved.StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -ne $stageName) { throw 'Refusing to remove an unsafe installer staging directory.' }
        $removed = $false
        for ($attempt = 1; $attempt -le 10 -and -not $removed; $attempt++) {
            try { Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Stop; $removed = $true }
            catch { if ($attempt -eq 10) { throw }; Start-Sleep -Milliseconds 500 }
        }
    }
}
