param(
  [Parameter(Mandatory = $true)][ValidateSet('add', 'remove')][string]$Action,
  [string]$HostName = '',
  [string]$Alias = '',
  [int]$Port = 0,
  [string]$PhysicalPath = '',
  [string]$ResultPath = ''
)

$ErrorActionPreference = 'Stop'

function Write-Result([bool]$Ok, [string]$Message, [string]$Site) {
  $payload = @{ ok = $Ok; message = $Message; site = $Site } | ConvertTo-Json -Compress
  if ($ResultPath) {
    $directory = Split-Path -Parent $ResultPath
    if ($directory -and -not (Test-Path $directory)) {
      New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    Set-Content -Path $ResultPath -Value $payload -Encoding UTF8
  }
  Write-Output $payload
}

function Find-Site([string]$Name) {
  $wanted = $Name.ToLowerInvariant()
  $exact = @()
  $blank = @()
  foreach ($site in Get-Website) {
    foreach ($binding in $site.Bindings.Collection) {
      if ($binding.protocol -ne 'https' -and $binding.protocol -ne 'http') { continue }
      $parts = $binding.bindingInformation.Split(':', 3)
      $bindingHost = ''
      if ($parts.Length -ge 3) { $bindingHost = $parts[2].ToLowerInvariant() }
      if ($bindingHost -eq $wanted) { $exact += $site.Name }
      elseif (-not $bindingHost) { $blank += $site.Name }
    }
  }
  $exact = @($exact | Select-Object -Unique)
  if ($exact.Count -eq 1) { return $exact[0] }
  if ($exact.Count -gt 1) { throw "More than one IIS site has $Name." }
  $blank = @($blank | Select-Object -Unique)
  if ($blank.Count -eq 1) { return $blank[0] }
  if ($blank.Count -gt 1) { throw "More than one IIS site could receive $Name." }
  throw "No IIS site is bound to $Name."
}

try {
  Import-Module WebAdministration
  if ($Action -eq 'remove') {
    $removed = 0
    foreach ($site in @(Get-Website)) {
      $app = Get-WebApplication -Site $site.Name -Name $Alias -ErrorAction SilentlyContinue
      if (-not $app) { continue }
      $appPhysical = [string]$app.PhysicalPath
      $sameFolder = $PhysicalPath -and ($appPhysical.TrimEnd('\') -eq $PhysicalPath.TrimEnd('\'))
      if (-not $sameFolder) { continue }
      Remove-WebApplication -Name $Alias -Site $site.Name
      $removed += 1
    }
    Write-Result $true $(if ($removed -gt 0) { 'Removed the IIS path.' } else { 'The IIS path was not present.' }) ''
    exit 0
  }

  if (-not (Get-WebGlobalModule -Name 'RewriteModule' -ErrorAction SilentlyContinue)) {
    throw 'URL Rewrite is not installed.'
  }
  if (-not (Get-WebGlobalModule -Name 'ApplicationRequestRouting' -ErrorAction SilentlyContinue)) {
    throw 'Application Request Routing is not installed.'
  }
  Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/proxy' -Name 'enabled' -Value 'True'
  try {
    Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/proxy' -Name 'timeout' -Value '00:03:20'
  } catch {
    # Some ARR builds store the timeout differently. Proxying still works.
  }

  $siteName = Find-Site $HostName
  $pool = 'FAM-mobile-proxy'
  if (-not (Test-Path "IIS:\AppPools\$pool")) {
    New-WebAppPool -Name $pool | Out-Null
    Set-ItemProperty "IIS:\AppPools\$pool" -Name managedRuntimeVersion -Value ''
  }
  $existing = Get-WebApplication -Site $siteName -Name $Alias -ErrorAction SilentlyContinue
  if ($existing) {
    Set-ItemProperty "IIS:\Sites\$siteName\$Alias" -Name physicalPath -Value $PhysicalPath
    Set-ItemProperty "IIS:\Sites\$siteName\$Alias" -Name applicationPool -Value $pool
  } else {
    New-WebApplication -Name $Alias -Site $siteName -PhysicalPath $PhysicalPath -ApplicationPool $pool | Out-Null
  }
  Write-Result $true "IIS site $siteName now forwards /$Alias." $siteName
  exit 0
} catch {
  Write-Result $false $_.Exception.Message ''
  exit 1
}
