#!/usr/bin/env bash
set -eu

printf 'HOST|'; hostname
printf 'UTC|'; date -u +%Y-%m-%dT%H:%M:%SZ
systemctl show lidia-puente.service -p LoadState -p ActiveState -p SubState -p UnitFileState -p NRestarts -p MainPID -p ExecMainStartTimestamp -p FragmentPath -p MemoryCurrent -p CPUUsageNSec --no-pager
for n in lidia-puente carina-waha; do
  docker stats --no-stream --format '{{.Name}}|cpu={{.CPUPerc}}|memory={{.MemUsage}}|memoryPercent={{.MemPerc}}|pids={{.PIDs}}' "$n" 2>/dev/null || true
  docker inspect --format '{{.Name}}|image={{.Config.Image}}|imageId={{.Image}}|created={{.Created}}|started={{.State.StartedAt}}|status={{.State.Status}}|restartCount={{.RestartCount}}|restartPolicy={{.HostConfig.RestartPolicy.Name}}' "$n" 2>/dev/null || true
  docker inspect --format '{{range .Mounts}}{{$.Name}}|mount|type={{.Type}}|source={{.Source}}|destination={{.Destination}}|rw={{.RW}}{{println}}{{end}}' "$n" 2>/dev/null || true
done
