param([switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
$release = $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $release 'release-manifest.json') -Raw | ConvertFrom-Json
if ($manifest.files -isnot [array] -or $manifest.files.Count -eq 0) { throw 'Missing release file inventory' }
foreach ($file in $manifest.files) {
  $path = [IO.Path]::GetFullPath((Join-Path $release $file.path))
  if (!$path.StartsWith($release.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Manifest path escapes release' }
  if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $file.sha256) { throw ('Hash mismatch: ' + $file.path) }
}
if ($ValidateOnly) { Write-Output 'RELEASE_HASHES_OK'; exit 0 }
$profile = Join-Path $release 'visual-test-only/profile'
$testHome = Join-Path $release 'visual-test-only/home'
$configPath = Join-Path $profile 'config.json'
New-Item -ItemType Directory -Path $profile,$testHome -Force | Out-Null
if (Test-Path -LiteralPath $configPath) {
  $existing = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
  if (!$existing.harnessHome -or [IO.Path]::GetFullPath($existing.harnessHome) -ne [IO.Path]::GetFullPath($testHome)) {
    throw 'Test profile points outside the isolated test home. Refusing launch.'
  }
} else {
  $config = [ordered]@{
    onboardingComplete = $false; harnessHome = $testHome; registeredRepos = @(); recentHives = @()
    alwaysOpenLastHive = $false; autoMode = $false; orchestratorMaySpawn = $false
    missions = @(); opsStandupSeeded = $true; heartbeatSeeded = $true
    autoUpdate = $false; telemetryEnabled = $false; slackEnabled = $false; slackProactivePosting = $false
    webhookEnabled = $false; webhookTriggers = @(); remoteEnvironments = @()
    reflectEnabled = $false; semanticMemory = $false; knowledgeGraph = @{enabled = $false}
    officeTheme = 'office'; officeChatterEnabled = $false; officeVoicesEnabled = $false
    realtimeVoiceEnabled = $false; floorInspectionEnabled = $false; softwareEconomyEnabled = $false
    movementCoordinationEnabled = $false; stationActivityEnabled = $false; language = 'es'
  }
  [IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
}
$executable = Join-Path $release 'The Hive.exe'
Start-Process -FilePath $executable -ArgumentList ('--user-data-dir="' + $profile + '"') -WorkingDirectory $release -WindowStyle Hidden
Write-Output ('ISOLATED_PROFILE=' + $profile)
Write-Output ('TEST_HOME=' + $testHome)
