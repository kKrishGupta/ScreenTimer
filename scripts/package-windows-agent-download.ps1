[CmdletBinding()]
param([switch]$Overwrite)
$ErrorActionPreference = 'Stop'
# Compatibility entry point; employee downloads are now independently packaged.
& (Join-Path $PSScriptRoot 'package-employee-downloads.ps1') @PSBoundParameters
