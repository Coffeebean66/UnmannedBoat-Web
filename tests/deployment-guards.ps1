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

# Exercise the real staging/rollback installer with an offline, dependency-free
# fixture. No production deployment and no npm registry access are needed.
$fixture=Join-Path $project ('.test-output\deploy-guards-'+[Guid]::NewGuid().ToString('N'))
$source=Join-Path $fixture 'source'
$target=Join-Path $fixture 'installed'
try {
  New-Item -ItemType Directory -Path (Join-Path $source 'public') -Force | Out-Null
  foreach ($name in @('deploy.ps1','deploy-common.ps1','remove.ps1')) { Copy-Item -LiteralPath (Join-Path $project $name) -Destination $source }
  Set-Content -LiteralPath (Join-Path $source 'server.js') -Value 'console.log("deployment fixture");' -Encoding UTF8
  Set-Content -LiteralPath (Join-Path $source 'package.json') -Value '{"name":"boat-deploy-fixture","version":"1.0.0"}' -Encoding UTF8
  Set-Content -LiteralPath (Join-Path $source 'public\index.html') -Value 'fixture' -Encoding UTF8
  & (Join-Path $source 'deploy.ps1') -TargetPath $target -NoStart
  Assert-BoatDeployment $target
  Set-Content -LiteralPath (Join-Path $target 'preserved.txt') -Value 'old deployment' -Encoding UTF8
  Set-Content -LiteralPath (Join-Path $source 'server.js') -Value 'function invalid syntax(' -Encoding UTF8
  $failed=$false
  try { & (Join-Path $source 'deploy.ps1') -TargetPath $target -NoStart 2>$null } catch { $failed=$true }
  if (-not $failed -or -not (Test-Path -LiteralPath (Join-Path $target 'preserved.txt'))) { throw 'Staging failure did not preserve the existing deployment.' }
  if (@(Get-ChildItem -LiteralPath $fixture -Directory -Force | Where-Object Name -Like '.boat-web-stage-*').Count) { throw 'Failed staging directory was not cleaned up.' }
  Set-Content -LiteralPath (Join-Path $source 'server.js') -Value 'console.log("replacement fixture");' -Encoding UTF8
  & (Join-Path $source 'deploy.ps1') -TargetPath $target -NoStart
  $backups=@(Get-ChildItem -LiteralPath $fixture -Directory | Where-Object Name -Like 'installed.backup-*')
  if ($backups.Count -ne 1 -or -not (Test-Path -LiteralPath (Join-Path $backups[0].FullName 'preserved.txt'))) { throw 'Successful upgrade did not keep a recovery copy.' }
  & (Join-Path $source 'remove.ps1') -TargetPath $target
  if ((Test-Path -LiteralPath $target) -or @(Get-ChildItem -LiteralPath $fixture -Directory | Where-Object Name -Like 'installed.removed-*').Count -ne 1) { throw 'Default removal did not preserve a recovery copy.' }
  Write-Host 'Deployment transaction checks passed: install, failed-stage preservation, upgrade backup, recoverable removal.'
} finally {
  if (Test-Path -LiteralPath $fixture) {
    $resolved=[IO.Path]::GetFullPath($fixture)
    $allowed=[IO.Path]::GetFullPath((Join-Path $project '.test-output'))+'\'
    if (-not $resolved.StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing invalid test cleanup path.' }
    Assert-NoLinks $fixture
    Remove-Item -LiteralPath $fixture -Recurse -Force
  }
}
