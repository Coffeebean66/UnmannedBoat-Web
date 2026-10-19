# Shared path/process validation. No operation targets an unmarked existing directory.
function Resolve-BoatTarget([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { throw 'An explicit deployment path is required.' }
  $target=[IO.Path]::GetFullPath($Value).TrimEnd('\','/')
  $source=[IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\','/')
  $driveRoot=[IO.Path]::GetPathRoot($target).TrimEnd('\','/')
  if ($target -eq $driveRoot -or $target -eq $source -or $source.StartsWith($target+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing a root/source/ancestor directory.' }
  $publicSource=Join-Path $source 'public'
  if ($target -eq $publicSource -or $target.StartsWith($publicSource+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Deployment cannot be inside public; that would copy the source into itself.' }
  foreach ($reserved in @($env:USERPROFILE,$env:SystemRoot)) {
    if ($reserved -and $target -eq $reserved.TrimEnd('\','/')) { throw 'Refusing a system/home directory.' }
  }
  $ancestor=$target
  while ($ancestor) {
    if (Test-Path -LiteralPath $ancestor) {
      $item=Get-Item -LiteralPath $ancestor -Force
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Deployment path contains a link/junction.' }
    }
    $parent=[IO.Directory]::GetParent($ancestor)
    if ($null -eq $parent) { break }
    $ancestor=$parent.FullName
  }
  return $target
}
function Assert-NoLinks([string]$Target) {
  $links=@(Get-ChildItem -LiteralPath $Target -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })
  if ($links.Count -gt 0) { throw 'Deployment contains links/junctions; refusing recursive operation.' }
}
function Assert-BoatDeployment([string]$Target) {
  $file=Join-Path $Target '.boat-web-deployment.json'
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'No deployment ownership marker; refusing operation.' }
  $marker=Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($marker.app -ne 'unmanned-boat-web' -or $marker.schema -ne 1 -or $marker.target -ne $Target) { throw 'Deployment marker does not match this target.' }
}
function Assert-BoatStopped([string]$Target) {
  $expected=[regex]::Escape((Join-Path $Target 'server.js'))
  $processes=Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop
  if (@($processes | Where-Object { $_.CommandLine -match $expected }).Count -gt 0) {
    throw 'Deployment is running. Press Ctrl+C in its terminal before removal or upgrade.'
  }
}
