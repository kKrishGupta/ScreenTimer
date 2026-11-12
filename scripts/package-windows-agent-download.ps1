[CmdletBinding()]
param([switch]$Overwrite, [switch]$RequireSignature)
$ErrorActionPreference = 'Stop'
# Compatibility entry point now produces the employee-facing GUI installer,
# never the legacy standalone agent ZIP.
& (Join-Path $PSScriptRoot 'build-windows-installer.ps1') @PSBoundParameters
