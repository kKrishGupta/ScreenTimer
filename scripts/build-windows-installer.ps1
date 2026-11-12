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
foreach ($extension in @($uiExtension, $balExtension)) { if (-not (Test-Path -LiteralPath $extension)) { throw "Required WiX extension is missing: $extension" } }

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

    $controlProject = Join-Path $repoRoot 'apps\control-center\DigitalPulse.ControlCenter.csproj'
    Invoke-Checked 'Control Center publish' { dotnet publish $controlProject -c Release -r $Runtime --self-contained true -p:PublishSingleFile=false -p:DebugType=None -p:DebugSymbols=false -o $payloadDir }
    $controlSource = Join-Path $payloadDir 'DigitalPulse.exe'
    if (-not (Test-Path -LiteralPath $controlSource)) { throw 'Control Center publish did not produce DigitalPulse.exe.' }
    Copy-Item -LiteralPath $agentSource -Destination (Join-Path $payloadDir 'dp-user-agent.exe')
    Get-ChildItem -LiteralPath $payloadDir -Recurse -File | Where-Object { $_.Extension -in @('.pdb','.xml') } | Remove-Item -Force

    $productSource = Join-Path $repoRoot 'apps\windows-installer\Product.wxs'
    $bundleSource = Join-Path $repoRoot 'apps\windows-installer\Bundle.wxs'
    Invoke-Checked 'WiX MSI build' { & $wix build $productSource -arch x64 -ext $uiExtension -d "PayloadDir=$payloadDir" -o $msiPath }
    Invoke-Checked 'WiX bundle build' { & $wix build $bundleSource -arch x64 -ext $balExtension -d "MsiPath=$msiPath" -o $builtSetup }
    if (-not (Test-Path -LiteralPath $builtSetup) -or (Get-Item $builtSetup).Length -lt 1MB) { throw 'WiX did not produce a valid setup bundle.' }
    $header = [IO.File]::ReadAllBytes($builtSetup)[0..1]
    if ($header[0] -ne 0x4d -or $header[1] -ne 0x5a) { throw 'Setup bundle is not a Windows PE executable.' }

    $testRoot = Join-Path $stageRoot 'install-test'
    # A separate state root models %LOCALAPPDATA%\DigitalPulse. The MSI owns
    # only INSTALLFOLDER and must not reach outside it during install/uninstall.
    $stateRoot = Join-Path $stageRoot 'protected-local-state\DigitalPulse'
    $sentinel = Join-Path $stateRoot 'device-identity-and-queue.test'
    New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
    [IO.File]::WriteAllText($sentinel, 'installer preservation test')
    try {
        $msiLog = Join-Path $stageRoot 'install-test.log'
        $installArgs = @('/i', "`"$msiPath`"", '/qn', '/norestart', '/l*v', "`"$msiLog`"", "INSTALLFOLDER=`"$testRoot`"")
        $installProcess = Start-Process -FilePath msiexec.exe -ArgumentList $installArgs -Wait -PassThru -WindowStyle Hidden
        if ($installProcess.ExitCode -ne 0) {
            $logEvidence = if (Test-Path -LiteralPath $msiLog) {
                $matches = @(Select-String -LiteralPath $msiLog -Pattern 'Return value 3' -Context 12,6)
                if ($matches.Count) { ($matches | ForEach-Object { $_.Context.PreContext + $_.Line + $_.Context.PostContext }) -join "`n" } else { (Get-Content -LiteralPath $msiLog -Tail 50) -join "`n" }
            } else { 'MSI log was not created.' }
            throw "MSI install test failed with exit code $($installProcess.ExitCode).`n$logEvidence"
        }
        foreach ($name in @('DigitalPulse.exe','DigitalPulse.dll','dp-user-agent.exe')) {
            if (-not (Test-Path -LiteralPath (Join-Path $testRoot $name))) { throw "Installed payload is missing $name." }
        }
        $smokeProcess = Start-Process -FilePath (Join-Path $testRoot 'DigitalPulse.exe') -ArgumentList '--smoke-test' -Wait -PassThru -WindowStyle Hidden
        if ($smokeProcess.ExitCode -ne 0) { throw 'Installed Control Center launch smoke test failed.' }
        $uninstallProcess = Start-Process -FilePath msiexec.exe -ArgumentList @('/x', "`"$msiPath`"", '/qn', '/norestart') -Wait -PassThru -WindowStyle Hidden
        if ($uninstallProcess.ExitCode -ne 0) { throw "MSI uninstall test failed with exit code $($uninstallProcess.ExitCode)." }
        if (-not (Test-Path -LiteralPath $sentinel)) { throw 'Uninstall removed protected DigitalPulse local state.' }
    } finally {
        if (Test-Path -LiteralPath $sentinel) { Remove-Item -LiteralPath $sentinel -Force }
    }

    $signature = Get-AuthenticodeSignature -LiteralPath $builtSetup
    if ($RequireSignature -and $signature.Status -ne 'Valid') { throw "Authenticode signature is required; current status is $($signature.Status)." }
    $sourceFiles = @(
        Get-Item -LiteralPath (Join-Path $repoRoot 'apps\control-center\DigitalPulse.ControlCenter.csproj'), (Join-Path $repoRoot 'desktop-agent\Cargo.toml'), (Join-Path $repoRoot 'desktop-agent\Cargo.lock'), $productSource, $bundleSource
        Get-ChildItem -LiteralPath (Join-Path $repoRoot 'apps\control-center\src') -Recurse -File -Filter '*.cs'
        Get-ChildItem -LiteralPath (Join-Path $repoRoot 'desktop-agent\crates') -Recurse -File | Where-Object { $_.Name -eq 'Cargo.toml' -or $_.Extension -eq '.rs' }
    ) | Sort-Object FullName -Unique
    $sourceHashes = [ordered]@{}
    foreach ($file in $sourceFiles) {
        $relative = $file.FullName.Substring($repoRoot.Length + 1).Replace('\','/')
        $sourceHashes[$relative] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    $setupHash = (Get-FileHash -LiteralPath $builtSetup -Algorithm SHA256).Hash.ToLowerInvariant()
    $release = [ordered]@{
        schemaVersion = 1; productVersion = '0.1.0'; fileName = $artifactName
        sha256 = $setupHash; bytes = (Get-Item -LiteralPath $builtSetup).Length
        controlCenterSha256 = (Get-FileHash -LiteralPath $controlSource -Algorithm SHA256).Hash.ToLowerInvariant()
        agentSha256 = (Get-FileHash -LiteralPath (Join-Path $payloadDir 'dp-user-agent.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
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
    [pscustomobject]@{ Installer = $artifactPath; Version = '0.1.0'; Bytes = (Get-Item $artifactPath).Length; SHA256 = $setupHash; Authenticode = [string]$signature.Status; Technology = 'WiX 5 Burn + MSI' }
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
