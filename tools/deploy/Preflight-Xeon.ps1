param([string]$HiveHome = 'C:/Users/Administrador/godinc')
$ErrorActionPreference = 'Stop'
$ledger = Get-Content -LiteralPath (Join-Path $HiveHome 'hive/tasks.json') -Raw | ConvertFrom-Json
if ($ledger.tasks -isnot [array]) { throw 'Ledger missing or invalid; readiness is unknown' }
$counts = @($ledger.tasks | Group-Object status | Select-Object Name,Count)
$doing = @($ledger.tasks | Where-Object status -eq 'doing').Count
$cli = @(Get-Process -ErrorAction SilentlyContinue | Where-Object ProcessName -match '^(claude|codex|opencode|gemini)$')
$queueDirs = @('inbox','outbox','spawn-requests')
$agentsPath = Join-Path $HiveHome 'hive/agents'
$agentDirs = if (Test-Path -LiteralPath $agentsPath) { @(Get-ChildItem -LiteralPath $agentsPath -Directory) } else { @() }
$queues = foreach ($name in $queueDirs) {
  $paths = @((Join-Path $HiveHome ('hive/' + $name)))
  if ($name -ne 'spawn-requests') { $paths += @($agentDirs | ForEach-Object {Join-Path $_.FullName $name}) }
  $present = 0; $files = 0
  foreach ($path in $paths) {
    if (Test-Path -LiteralPath $path) {
      $present++
      $files += @(Get-ChildItem -LiteralPath $path -File -Filter '*.json' -ErrorAction Stop).Count
    }
  }
  [ordered]@{Name=$name; PresentDirectories=$present; PendingJsonFiles=$(if($present -gt 0){$files}else{$null})}
}
[ordered]@{
  CheckedAt=(Get-Date).ToString('o'); TaskCounts=$counts; Doing=$doing; AgentCLIProcesses=$cli.Count
  Queues=@($queues); AutomaticRestartAllowed=$false
  Result= $(if ($doing -gt 0 -or $cli.Count -gt 0) {'SUPERVISED_HANDOFF_REQUIRED'} else {'REVIEW_PENDING_MESSAGES_AND_FRESH_BACKUP'})
  Note='Task states do not prove a process is active. A file backup cannot preserve live PTY memory. This script stops nothing.'
} | ConvertTo-Json -Depth 5
