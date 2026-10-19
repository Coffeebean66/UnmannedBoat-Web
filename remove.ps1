param(
  [string]$TargetPath=(Join-Path $PSScriptRoot 'deployments\UnmannedBoat_Web'),
  [switch]$Purge
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'deploy-common.ps1')
$target=Resolve-BoatTarget $TargetPath
if (-not (Test-Path -LiteralPath $target)) { Write-Host 'Deployment does not exist.'; exit 0 }
Assert-BoatDeployment $target
Assert-NoLinks $target
Assert-BoatStopped $target
if ($Purge) {
  # Only a validated, marked deployment directory can reach this operation.
  Remove-Item -LiteralPath $target -Recurse -Force
  Write-Host "Permanently removed deployment: $target"
} else {
  $backup=$target+'.removed-'+[DateTime]::UtcNow.ToString('yyyyMMddHHmmssfff')
  if (Test-Path -LiteralPath $backup) { throw 'Backup already exists.' }
  Move-Item -LiteralPath $target -Destination $backup
  Write-Host "Deployment removed; recovery copy: $backup"
}
