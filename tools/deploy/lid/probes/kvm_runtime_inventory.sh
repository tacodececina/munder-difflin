#!/usr/bin/env bash
set -euo pipefail

printf 'HOST\t'; hostname
printf 'UTC\t'; date -u +%Y-%m-%dT%H:%M:%SZ
printf 'OS\t'; . /etc/os-release; printf '%s %s\n' "$NAME" "$VERSION_ID"
printf 'UPTIME\t'; uptime -p
printf 'LOAD\t'; cut -d' ' -f1-3 /proc/loadavg
printf 'MEM_KIB\t'; awk '/MemTotal|MemAvailable/ {gsub(":","",$1); printf "%s=%s ",$1,$2} END{print ""}' /proc/meminfo
printf 'ROOT_FS\t'; df -B1 --output=size,used,avail,pcent / | tail -1 | xargs
printf '%s\n' '---CONTAINERS---'
docker ps -a --filter name=hermes-workspace-licenciadigital --filter name=hermes-agent-licenciadigital --format '{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}'
printf '%s\n' '---INSPECT_SELECTED---'
for n in hermes-workspace-licenciadigital hermes-agent-licenciadigital; do
  if docker container inspect "$n" >/dev/null 2>&1; then
    docker container inspect --format '{{.Name}}|image={{.Config.Image}}|imageId={{.Image}}|created={{.Created}}|started={{.State.StartedAt}}|status={{.State.Status}}|health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|restartCount={{.RestartCount}}|restartPolicy={{.HostConfig.RestartPolicy.Name}}|composeProject={{index .Config.Labels "com.docker.compose.project"}}|composeFiles={{index .Config.Labels "com.docker.compose.project.config_files"}}' "$n"
    docker container inspect --format '{{range .Mounts}}{{$.Name}}|mount|type={{.Type}}|source={{.Source}}|destination={{.Destination}}|rw={{.RW}}{{println}}{{end}}' "$n"
  else printf '%s|missing\n' "$n"; fi
done
printf '%s\n' '---IMAGE_SELECTED---'
for n in hermes-workspace-licenciadigital hermes-agent-licenciadigital; do
  iid=$(docker container inspect --format '{{.Image}}' "$n" 2>/dev/null || true)
  if [ -n "$iid" ]; then docker image inspect --format '{{.Id}}|created={{.Created}}|size={{.Size}}|repoDigests={{json .RepoDigests}}' "$iid"; fi
done
printf '%s\n' '---STATS---'
docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.NetIO}}|{{.BlockIO}}|{{.PIDs}}' hermes-workspace-licenciadigital hermes-agent-licenciadigital 2>&1 || true
printf '%s\n' '---SYSTEMD---'
for u in munder-difflin-kepler.service hive-app.service lidia-puente.service; do
  printf '%s|' "$u"; systemctl show "$u" -p LoadState -p ActiveState -p SubState -p UnitFileState -p NRestarts -p MainPID -p ExecMainStartTimestamp -p ExecMainExitTimestamp --value | paste -sd'|' -
done
printf '%s\n' '---SOURCE_PATHS---'
for p in /opt/workspace-licenciadigital /usr/local/lib/hermes-agent; do
  if [ -e "$p" ]; then
    printf '%s|exists|type=' "$p"; stat -c %F "$p"
    if git -C "$p" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      printf '%s|git|head=%s|branch=%s|dirty_count=%s|origin=' "$p" "$(git -C "$p" rev-parse HEAD)" "$(git -C "$p" branch --show-current)" "$(git -C "$p" status --porcelain | wc -l)"
      if git -C "$p" remote get-url origin >/dev/null 2>&1; then printf 'present-redacted\n'; else printf 'none\n'; fi
    else printf '%s|git|no\n' "$p"; fi
    find "$p" -maxdepth 1 -mindepth 1 -printf '%f|%y\n' 2>/dev/null | sort | head -80 | sed "s#^#$p|entry|#"
  else printf '%s|missing\n' "$p"; fi
done
printf '%s\n' '---RUNTIME_COMMANDS---'
for n in hermes-workspace-licenciadigital hermes-agent-licenciadigital; do
  if docker container inspect "$n" >/dev/null 2>&1; then
    docker exec "$n" sh -lc 'printf "container=%s|uid=%s|hermes_path=" "$HOSTNAME" "$(id -u)"; command -v hermes || true; printf "container=%s|hermes_version=" "$HOSTNAME"; hermes --version 2>&1 | head -1 || true; printf "container=%s|tmux=" "$HOSTNAME"; tmux -V 2>&1 | head -1 || true' </dev/null
  fi
done
printf '%s\n' '---TIMERS_NAMES---'
systemctl list-timers --all --no-legend --no-pager | awk '{unit=""; for(i=1;i<=NF;i++) if($i ~ /\.timer$/){unit=$i; break} if(unit!="") print unit}' | sort -u
printf '%s\n' '---CRON_SANITIZED---'
helper="$(dirname "$0")/kvm_probe_sanitize.py"
test -r "$helper"
if cron_text=$(crontab -l 2>/dev/null); then printf '%s\n' "$cron_text" | python3 "$helper" --mode root; else printf '%s\n' 'root-crontab|status=unknown'; fi
printf '%s\n' '---CRON_DIR_FILENAMES---'
for d in /etc/cron.d /www/server/cron; do
  if [ -d "$d" ]; then find "$d" -maxdepth 1 -type f -printf '%f\n' 2>/dev/null | sort | sed "s#^#$d|#"; else printf '%s|missing\n' "$d"; fi
done
