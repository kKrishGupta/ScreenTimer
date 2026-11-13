[CmdletBinding()]
param(
    [string]$BundlePath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $BundlePath) {
    $repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
    $BundlePath = Join-Path $repoRoot 'apps\windows-installer\Bundle.wxs'
}
$BundlePath = (Resolve-Path -LiteralPath $BundlePath).Path

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Test-RegisteredRuntime([hashtable]$Versions) {
    foreach ($value in $Versions.Values) {
        if ([string]::IsNullOrWhiteSpace([string]$value)) { continue }
        $version = $null
        if ([Version]::TryParse([string]$value, [ref]$version) -and $version -gt [Version]'0.0.0.0') {
            return $true
        }
    }
    return $false
}

# Deterministic behavioral fixtures cover every supported scope/view and the
# missing, empty, zero, and malformed values called out by Microsoft.
$locations = @('WebView2Hklm32Version', 'WebView2Hklm64Version', 'WebView2Hkcu32Version', 'WebView2Hkcu64Version')
foreach ($location in $locations) {
    Assert-True (Test-RegisteredRuntime @{ $location = '157.0.4341.46' }) "Present-path fixture failed for $location."
}
Assert-True (-not (Test-RegisteredRuntime @{})) 'Absent-path fixture unexpectedly detected a runtime.'
foreach ($value in @($null, '', '0.0.0.0', 'not-a-version')) {
    Assert-True (-not (Test-RegisteredRuntime @{ WebView2Hklm32Version = $value })) "Invalid runtime value '$value' was accepted."
}

[xml]$document = Get-Content -LiteralPath $BundlePath -Raw
$namespace = [System.Xml.XmlNamespaceManager]::new($document.NameTable)
$namespace.AddNamespace('wix', 'http://wixtoolset.org/schemas/v4/wxs')
$namespace.AddNamespace('util', 'http://wixtoolset.org/schemas/v4/wxs/util')
$searches = @($document.SelectNodes('/wix:Wix/wix:Bundle/util:RegistrySearch', $namespace))
Assert-True ($searches.Count -eq 4) 'Bundle must contain exactly four WebView2 registry searches.'

$expected = @{
    WebView2Hklm32Version = @{ Root = 'HKLM'; Bitness = 'always32' }
    WebView2Hklm64Version = @{ Root = 'HKLM'; Bitness = 'always64' }
    WebView2Hkcu32Version = @{ Root = 'HKCU'; Bitness = 'always32' }
    WebView2Hkcu64Version = @{ Root = 'HKCU'; Bitness = 'always64' }
}
$clientId = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
foreach ($search in $searches) {
    $specification = $expected[$search.Variable]
    Assert-True ($null -ne $specification) "Unexpected WebView2 registry variable: $($search.Variable)."
    Assert-True ($search.Root -eq $specification.Root) "Wrong registry scope for $($search.Variable)."
    Assert-True ($search.Bitness -eq $specification.Bitness) "Wrong registry view for $($search.Variable)."
    Assert-True ($search.Value -eq 'pv' -and $search.Result -eq 'value') "Registry search $($search.Variable) must read pv."
    Assert-True ($search.Key.EndsWith("Microsoft\EdgeUpdate\Clients\$clientId", [StringComparison]::OrdinalIgnoreCase)) "Registry search $($search.Variable) uses the wrong WebView2 client registration."
}

$package = $document.SelectSingleNode('/wix:Wix/wix:Bundle/wix:Chain/wix:ExePackage[@Id="WebView2Runtime"]', $namespace)
Assert-True ($null -ne $package) 'WebView2Runtime ExePackage is missing.'
$condition = [string]$package.DetectCondition
Assert-True ($condition -ne '0') 'WebView2 runtime detection must not be hardcoded false.'
foreach ($location in $locations) {
    Assert-True ($condition.IndexOf("$location > v0.0.0.0", [StringComparison]::Ordinal) -ge 0) "DetectCondition does not validate $location."
}
Assert-True ($package.SourceFile -eq '$(WebView2Path)' -and $package.InstallArguments -eq '/silent /install') 'Missing-runtime path must retain the official Evergreen bootstrapper.'

[pscustomobject]@{
    Bundle = $BundlePath
    PresentFixtures = 4
    AbsentAndInvalidFixtures = 5
    RegistrySearches = $searches.Count
    Detection = 'PASS'
}
