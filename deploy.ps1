param(
  [string]$TargetPath=(Join-Path $PSScriptRoot 'deployments\UnmannedBoat_Web'),
  [ValidateRange(1,65535)][int]$Port=8080,
  [string]$ListenAddress='127.0.0.1',
  [switch]$NoStart
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'deploy-common.ps1')
$target=Resolve-BoatTarget $TargetPath
if (Test-Path -LiteralPath $target) {
  Assert-NoLinks $target
  if (@(Get-ChildItem -LiteralPath $target -Force).Count -gt 0) {
    Assert-BoatDeployment $target
    Assert-BoatStopped $target
  }
}
$node=(Get-Command node -ErrorAction Stop).Source
if (([version]((& $node --version).TrimStart('v'))).Major -lt 18) { throw 'Node.js 18+ required.' }
$parent=Split-Path $target -Parent
New-Item -ItemType Directory -Path $parent -Force | Out-Null
$stage=Join-Path $parent ('.boat-web-stage-'+[Guid]::NewGuid().ToString('N'))
$backup=$null
$replaced=$false
try {
  New-Item -ItemType Directory -Path $stage | Out-Null
  foreach ($name in @('public','server.js','package.json','start-local.ps1','start-local.cmd','server','package-lock.json')) {
    $source=Join-Path $PSScriptRoot $name
    if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination $stage -Recurse -Force }
  }
  $lock=Join-Path $stage 'package-lock.json'
  if (Test-Path -LiteralPath $lock) {
    $npm=(Get-Command npm.cmd -ErrorAction Stop).Source
    & $npm ci --prefix $stage --omit=dev --ignore-scripts --no-bin-links --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Locked dependency installation failed; existing deployment was preserved.' }
  } else {
    $manifest=Get-Content -LiteralPath (Join-Path $stage 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.dependencies -and @($manifest.dependencies.PSObject.Properties).Count) { throw 'Runtime dependencies require package-lock.json.' }
  }
  & $node --check (Join-Path $stage 'server.js')
  if ($LASTEXITCODE -ne 0) { throw 'Staged server syntax check failed.' }
  Assert-NoLinks $stage
  @{ app='unmanned-boat-web'; schema=1; target=$target } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage '.boat-web-deployment.json') -Encoding UTF8
  if (Test-Path -LiteralPath $target) {
    $backup=$target+'.backup-'+[DateTime]::UtcNow.ToString('yyyyMMddHHmmssfff')
    if (Test-Path -LiteralPath $backup) { throw 'Backup already exists.' }
    Move-Item -LiteralPath $target -Destination $backup
  }
  Move-Item -LiteralPath $stage -Destination $target
  $replaced=$true
} catch {
  if ($backup -and (Test-Path -LiteralPath $backup) -and -not (Test-Path -LiteralPath $target)) { Move-Item -LiteralPath $backup -Destination $target }
  throw
} finally {
  if ((Test-Path -LiteralPath $stage) -and -not $replaced) { Assert-NoLinks $stage; Remove-Item -LiteralPath $stage -Recurse -Force }
}
Write-Host "Deployed: $target"
if ($backup) { Write-Host "Previous deployment recovery copy: $backup" }
if (-not $NoStart) {
  Write-Host 'Running in this terminal. Press Ctrl+C to stop before removing or upgrading.'
  & (Join-Path $target 'start-local.ps1') -Port $Port -ListenAddress $ListenAddress
}
