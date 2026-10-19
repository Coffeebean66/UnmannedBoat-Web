$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $project 'deploy-common.ps1')
$targets=@([IO.Path]::GetPathRoot($project),(Split-Path $project -Parent),$project,(Join-Path $project 'public\nested'))
foreach ($candidate in $targets) {
  $rejected=$false
  try { Resolve-BoatTarget $candidate | Out-Null } catch { $rejected=$true }
  if (-not $rejected) { throw "Unsafe target accepted: $candidate" }
}
$rejected=$false
try { Assert-BoatDeployment $PSScriptRoot } catch { $rejected=$true }
if (-not $rejected) { throw 'Unmarked test directory was accepted.' }
$valid=Resolve-BoatTarget (Join-Path $project 'deployments\UnmannedBoat_Web')
if (-not $valid.EndsWith('\deployments\UnmannedBoat_Web')) { throw 'Default path resolution failed.' }
Write-Host 'Deployment guards passed: root, ancestor, source, recursive-copy target, unmarked directory.'
