#!/usr/bin/env bash
set -eu

printf 'UTC|'; date -u +%Y-%m-%dT%H:%M:%SZ
printf '%s\n' '---NESTED_GIT---'
find /opt/workspace-licenciadigital -maxdepth 4 -type d -name .git -printf '%h\n' 2>/dev/null | sort | while read -r repo; do
  printf '%s|head=%s|branch=%s|dirtyCount=%s|origin=' "$repo" "$(git -C "$repo" rev-parse HEAD)" "$(git -C "$repo" branch --show-current)" "$(git -C "$repo" status --porcelain | wc -l)"
  if git -C "$repo" remote get-url origin >/dev/null 2>&1; then printf 'present-redacted\n'; else printf 'none\n'; fi
done
printf '%s\n' '---SOURCE_METADATA---'
for p in /opt/workspace-licenciadigital/agent /opt/workspace-licenciadigital/workspace /opt/workspace-licenciadigital/workspace-runtime; do
  if [ -d "$p" ]; then
    printf '%s|bytes=' "$p"; du -sb "$p" | awk '{print $1}'
    find "$p" -maxdepth 2 -type f \( -name 'package.json' -o -name 'pyproject.toml' -o -name 'uv.lock' -o -name 'requirements*.txt' -o -name 'Dockerfile*' -o -name 'docker-compose*.yml' \) -printf '%p|bytes=%s|mtime=%TY-%Tm-%TdT%TH:%TM:%TSZ\n' 2>/dev/null | sort
  else printf '%s|missing\n' "$p"; fi
done
printf '%s\n' '---COMPOSE_SERVICE_NAMES---'
docker compose -f /opt/workspace-licenciadigital/docker-compose.yml config --services 2>/dev/null | sort || true
printf '%s\n' '---RELATED_CONTAINERS---'
docker ps -a --filter label=com.docker.compose.project=workspace-licenciadigital --format '{{.Names}}|{{.Image}}|{{.Status}}' | sort
printf '%s\n' '---BUSINESS_SQLITE_PATHS---'
find /www/wwwroot/licenciadigital-next/db -maxdepth 1 -type f \( -name '*.db' -o -name '*.db-wal' -o -name '*.db-shm' \) -printf '%p|bytes=%s|mtime=%TY-%Tm-%TdT%TH:%TM:%TSZ\n' 2>/dev/null | sort
printf '%s\n' '---RELATED_UNITS---'
systemctl list-unit-files --no-legend --no-pager | awk '$1 ~ /(hermes|lidia|workspace)/ {print $1"|"$2}' | sort
