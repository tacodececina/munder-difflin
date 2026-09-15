param(
  [string]$SshAlias = 'servidor-windows',
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
$remoteProbe = @'
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$runtimeRoot = 'C:\Users\Administrador\godinc'
$hive = Join-Path $runtimeRoot 'hive'
$profile = 'C:\Users\Administrador\AppData\Roaming\munder-difflin\config.json'
$source = 'C:\Users\Administrador\orca\workspaces\munder-difflin\Munder-Difflin-Harnes'
$release = 'C:\Users\Administrador\munder-releases\2026-09-15-phase56\app'

function Get-RequiredProperty($object, [string]$name, [string]$context) {
  if ($null -eq $object -or $object.PSObject.Properties.Name -notcontains $name) {
    throw "$context is missing required property '$name'"
  }
  return $object.$name
}
function Assert-RequiredArray($object, [string]$name, [string]$context) {
  if ($null -eq $object -or $object.PSObject.Properties.Name -notcontains $name) {
    throw "$context is missing required property '$name'"
  }
  $value = $object.$name
  if ($null -eq $value -or $value -isnot [System.Array]) {
    throw "$context.$name must be an array; null is not an empty array"
  }
}
function Get-QueueCount([string]$path) {
  try {
    if (-not (Test-Path -LiteralPath $path -PathType Container -ErrorAction Stop)) {
      return [ordered]@{ exists = $false; count = $null }
    }
    $files = @(Get-ChildItem -LiteralPath $path -File -Filter '*.json' -ErrorAction Stop)
    return [ordered]@{ exists = $true; count = $files.Count }
  } catch [System.Management.Automation.ItemNotFoundException] {
    return [ordered]@{ exists = $false; count = $null }
  }
}
function Invoke-GitRead([string[]]$arguments) {
  $output = @(& git @arguments)
  if ($LASTEXITCODE -ne 0) { throw "git read failed: $($arguments[0]) (exit $LASTEXITCODE)" }
  return $output
}
function Get-GitSummary([string]$path) {
  Push-Location $path
  try {
    return [ordered]@{
      branch = (Invoke-GitRead @('branch', '--show-current') | Select-Object -First 1)
      commit = (Invoke-GitRead @('rev-parse', 'HEAD') | Select-Object -First 1)
      remoteNames = @(Invoke-GitRead @('remote'))
      dirtyCount = @(Invoke-GitRead @('status', '--porcelain')).Count
    }
  } finally { Pop-Location }
}
function Test-GitWorktree([string]$path) {
  $priorErrorAction = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $inside = @(& git -C $path rev-parse --is-inside-work-tree 2>&1)
    $gitExit = $LASTEXITCODE
  } finally { $ErrorActionPreference = $priorErrorAction }
  if ($gitExit -eq 0) { return ($inside | Select-Object -First 1) -eq 'true' }
  if ($gitExit -eq 128 -and (Test-Path -LiteralPath $path -PathType Container -ErrorAction Stop) -and
      (($inside | ForEach-Object { $_.ToString() }) -join "`n") -match 'not a git repository') { return $false }
  throw "git worktree probe failed (exit $gitExit)"
}
# END_SHARED_HELPERS

$tasksJson = Get-Content -LiteralPath (Join-Path $hive 'tasks.json') -Raw | ConvertFrom-Json
Assert-RequiredArray $tasksJson 'tasks' 'tasks.json'
$tasks = @($tasksJson.tasks)
$config = Get-Content -LiteralPath $profile -Raw | ConvertFrom-Json
Assert-RequiredArray $config 'missions' 'config.json'
$missions = @($config.missions)
$registryJson = Get-Content -LiteralPath (Join-Path $hive 'registry.json') -Raw | ConvertFrom-Json
$agentsObject = Get-RequiredProperty $registryJson 'agents' 'registry.json'
if ($null -eq $agentsObject -or $agentsObject -isnot [PSCustomObject]) {
  throw 'registry.json.agents must be an object; null is not an empty registry'
}
$registry = @($agentsObject.PSObject.Properties | ForEach-Object { $_.Value })
$pending = @(Get-ChildItem -LiteralPath (Join-Path $hive 'agents') -Directory | ForEach-Object {
  [ordered]@{
    agent = $_.Name
    inbox = Get-QueueCount (Join-Path $_.FullName 'inbox')
    outbox = Get-QueueCount (Join-Path $_.FullName 'outbox')
  }
})
$authorizedTaskNames = @('Orca_Serve')
$task = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -in $authorizedTaskNames }) | Select-Object -First 1
$taskInfo = if ($task) { Get-ScheduledTaskInfo -TaskName 'Orca_Serve' -ErrorAction Stop } else { $null }
$hiveGit = Get-GitSummary $hive
$sourceHasGit = Test-GitWorktree $source
$sourceGit = if ($sourceHasGit) { Get-GitSummary $source } else { $null }
[ordered]@{
  observedAt = [DateTime]::UtcNow.ToString('o')
  computer = $env:COMPUTERNAME
  roots = @(@($runtimeRoot, $profile, $source, $release) | ForEach-Object { [ordered]@{ path = $_; exists = Test-Path -LiteralPath $_ } })
  sourceHasGit = $sourceHasGit
  releaseHasGit = Test-GitWorktree $release
  sourceGit = $sourceGit
  hiveGit = $hiveGit
  taskStatuses = @($tasks | Group-Object status | ForEach-Object { [ordered]@{ status = $_.Name; count = $_.Count } })
  pendingQueues = $pending
  pendingSpawnRequests = Get-QueueCount (Join-Path $hive 'spawn-requests')
  registry = [ordered]@{
    count = $registry.Count
    status = @($registry | Group-Object status | ForEach-Object { [ordered]@{ value = $_.Name; count = $_.Count } })
    provider = @($registry | Group-Object provider | ForEach-Object { [ordered]@{ value = $_.Name; count = $_.Count } })
  }
  processes = @(Get-Process | Where-Object { $_.ProcessName -match '^(claude|codex|codex-code-mode-host|node|python|python3.11|electron)$' } | Group-Object ProcessName | ForEach-Object { [ordered]@{ name = $_.Name; count = $_.Count } })
  missions = @($missions | ForEach-Object {
    $mission = $_
    $id = Get-RequiredProperty $mission 'id' 'config.json.missions[]'
    $enabled = Get-RequiredProperty $mission 'enabled' "mission '$id'"
    $intervalMs = Get-RequiredProperty $mission 'intervalMs' "mission '$id'"
    $weeklyValue = if ($mission.PSObject.Properties.Name -contains 'weekly') { $mission.weekly } else { $null }
    $lastFired = Get-RequiredProperty $mission 'lastFiredAt' "mission '$id'"
    $weeklyProjection = if ($null -eq $weeklyValue) { $null } else {
      Assert-RequiredArray $weeklyValue 'days' "mission '$id'.weekly"
      $weeklyDays = @($weeklyValue.days)
      [ordered]@{
      days = $weeklyDays
      minute = Get-RequiredProperty $weeklyValue 'minute' "mission '$id'.weekly"
      scheduleType = if ($weeklyValue.PSObject.Properties.Name -contains 'scheduleType') { $weeklyValue.scheduleType } else { $null }
    } }
    [ordered]@{
      id = $id; enabled = $enabled; intervalMs = $intervalMs; weekly = $weeklyProjection
      lastFiredAt = if ($null -ne $lastFired) { [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$lastFired).UtcDateTime.ToString('o') } else { $null }
    }
  })
  profile = [ordered]@{ harnessHome = $config.harnessHome; strongKeepalive = $config.strongKeepalive; alwaysOpenLastHive = $config.alwaysOpenLastHive }
  orcaServe = if ($task) { [ordered]@{
    state = $task.State.ToString(); logonType = $task.Principal.LogonType.ToString()
    triggers = @($task.Triggers | ForEach-Object { $_.CimClass.CimClassName })
    executable = @($task.Actions | ForEach-Object { $_.Execute })
    argumentsCollected = $false
    lastRunTime = $taskInfo.LastRunTime.ToUniversalTime().ToString('o')
    lastTaskResult = $taskInfo.LastTaskResult
  } } else { $null }
  electron = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'electron.exe' } | Group-Object ExecutablePath, SessionId | ForEach-Object {
    [ordered]@{ executablePath = $_.Group[0].ExecutablePath; sessionId = $_.Group[0].SessionId; count = $_.Count }
  })
} | ConvertTo-Json -Depth 9
'@

if ($SelfTest) {
  $helperEnd = $remoteProbe.IndexOf('# END_SHARED_HELPERS')
  if ($helperEnd -lt 0) { throw 'shared helper boundary missing' }
  $helperTokens = $null; $helperErrors = $null
  $helperAst = [System.Management.Automation.Language.Parser]::ParseInput(
    $remoteProbe.Substring(0, $helperEnd), [ref]$helperTokens, [ref]$helperErrors)
  if ($helperErrors.Count) { throw 'shared helper syntax is invalid' }
  $actualHelpers = $helperAst.FindAll({ param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst]
  }, $true)
  foreach ($actualHelper in $actualHelpers) { Invoke-Expression $actualHelper.Extent.Text }

  foreach ($count in @(0, 1, 2)) {
    $items = @()
    for ($index = 0; $index -lt $count; $index++) { $items += [PSCustomObject]@{ id = $index } }
    $fixture = [PSCustomObject]@{ items = [System.Array]$items }
    Assert-RequiredArray $fixture 'items' "valid-$count"
    if (@($fixture.items).Count -ne $count) { throw "valid-$count changed cardinality" }
  }
  foreach ($invalid in @(
    [PSCustomObject]@{},
    [PSCustomObject]@{ items = $null },
    [PSCustomObject]@{ items = 'scalar' }
  )) {
    $rejected = $false
    try { Assert-RequiredArray $invalid 'items' 'invalid' } catch { $rejected = $true }
    if (-not $rejected) { throw 'invalid array shape was accepted' }
  }

  $testRoot = Join-Path ([IO.Path]::GetTempPath()) ('lid-xeon-probe-' + [guid]::NewGuid().ToString('N'))
  $emptyQueue = Join-Path $testRoot 'empty'
  [IO.Directory]::CreateDirectory($emptyQueue) | Out-Null
  try {
    $missing = Get-QueueCount (Join-Path $testRoot 'missing')
    $empty = Get-QueueCount $emptyQueue
    if ($missing.exists -or $null -ne $missing.count) { throw 'missing queue was not false/null' }
    if (-not $empty.exists -or $empty.count -ne 0) { throw 'empty queue was not true/zero' }
  } finally {
    [IO.Directory]::Delete($emptyQueue)
    [IO.Directory]::Delete($testRoot)
  }

  [ordered]@{
    selfTest = 'passed'
    actualHelpers = $true
    validArrayCardinalities = @(0, 1, 2)
    invalidArrayShapesRejected = @('missing', 'null', 'scalar')
    missingQueue = [ordered]@{ exists = $missing.exists; count = $missing.count }
    emptyQueue = [ordered]@{ exists = $empty.exists; count = $empty.count }
  } | ConvertTo-Json -Depth 4 -Compress
  return
}

$sourceBytes = [Text.Encoding]::UTF8.GetBytes($remoteProbe)
$compressedStream = New-Object IO.MemoryStream
$gzip = New-Object IO.Compression.GzipStream($compressedStream, [IO.Compression.CompressionMode]::Compress)
$gzip.Write($sourceBytes, 0, $sourceBytes.Length)
$gzip.Dispose()
$payload = [Convert]::ToBase64String($compressedStream.ToArray())
$wrapper = '$ProgressPreference=''SilentlyContinue'';$p=[regex]::Replace([Console]::In.ReadToEnd(),''[^A-Za-z0-9+/=]'','''');$b=[Convert]::FromBase64String($p);$m=New-Object IO.MemoryStream(,$b);$g=New-Object IO.Compression.GzipStream($m,[IO.Compression.CompressionMode]::Decompress);$r=New-Object IO.StreamReader($g);Invoke-Expression $r.ReadToEnd()'
$encodedWrapper = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($wrapper))
$payload | & ssh $SshAlias "powershell.exe -NoProfile -NonInteractive -EncodedCommand $encodedWrapper"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
