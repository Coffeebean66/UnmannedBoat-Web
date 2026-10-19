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
New-Item -ItemType Directory -Path $target -Force | Out-Null
foreach ($name in @('public','server.js','package.json','start-local.ps1','start-local.cmd')) {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $target -Recurse -Force
}
@{ app='unmanned-boat-web'; schema=1; target=$target } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $target '.boat-web-deployment.json') -Encoding UTF8
Write-Host "Deployed: $target"
if (-not $NoStart) {
  Write-Host 'Running in this terminal. Press Ctrl+C to stop before removing or upgrading.'
  & (Join-Path $target 'start-local.ps1') -Port $Port -ListenAddress $ListenAddress
}
