#!/usr/bin/env bash
set -eu

printf 'UTC\t'; date -u +%Y-%m-%dT%H:%M:%SZ
printf '%s\n' '---AGENT_STATS---'
docker stats --no-stream --format '{{.Name}}|cpu={{.CPUPerc}}|memory={{.MemUsage}}|memoryPercent={{.MemPerc}}|netIO={{.NetIO}}|blockIO={{.BlockIO}}|pids={{.PIDs}}' hermes-agent-licenciadigital 2>&1 || true
printf '%s\n' '---SYSTEMD_EXACT---'
for u in munder-difflin-kepler.service hive-app.service lidia-puente.service; do
  printf 'unit=%s\n' "$u"
  systemctl show "$u" -p LoadState -p ActiveState -p SubState -p UnitFileState -p NRestarts -p MainPID -p ExecMainStartTimestamp -p ExecMainExitTimestamp --no-pager || true
done
printf '%s\n' '---HERMES_STATE_FILES---'
docker exec hermes-agent-licenciadigital sh -lc '
  find /root/.hermes/cron -maxdepth 1 -type f -printf "%p|bytes=%s|mtime=%TY-%Tm-%TdT%TH:%TM:%TSZ\n" 2>/dev/null | sort
  stat -c "%n|bytes=%s|mtime=%y" /root/.hermes/state.db 2>/dev/null || true
' </dev/null
printf '%s\n' '---SQLITE_SCHEMA_ONLY---'
docker exec hermes-agent-licenciadigital sh -lc '
  for db in $(find /root/.hermes -maxdepth 3 -type f \( -name "*.db" -o -name "*.sqlite" \) 2>/dev/null); do
    printf "db=%s|tables=" "$db"
    if command -v sqlite3 >/dev/null 2>&1; then sqlite3 -readonly "$db" ".tables" | tr "\n" " "; else printf "sqlite3-unavailable"; fi
    printf "\n"
  done
' </dev/null
printf '%s\n' '---PACKAGE_METADATA---'
docker exec hermes-agent-licenciadigital sh -lc '
  python3 - <<"PY"
import importlib.metadata as m
for name in ("hermes-agent", "hermes_agent"):
    try:
        d=m.metadata(name)
        print("package=%s|version=%s|home=%s" % (name, m.version(name), d.get("Home-page") or d.get("Project-URL") or "unknown"))
    except m.PackageNotFoundError:
        pass
PY
' </dev/null
printf '%s\n' '---HERMES_COMMANDS---'
docker exec hermes-agent-licenciadigital sh -lc 'hermes --help 2>&1 | sed -n "/Commands:/,/^$/p" | sed -E "s/[[:space:]]+/ /g" | head -80' </dev/null
