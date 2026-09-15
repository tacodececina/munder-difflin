#!/usr/bin/env bash
set -euo pipefail

app=/www/wwwroot/licenciadigital-next
printf 'UTC|'; date -u +%Y-%m-%dT%H:%M:%SZ
printf '%s\n' '---APP_GIT---'
if git -C "$app" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  printf 'path=%s|head=%s|branch=%s|dirtyCount=%s|origin=' "$app" "$(git -C "$app" rev-parse HEAD)" "$(git -C "$app" branch --show-current)" "$(git -C "$app" status --porcelain | wc -l)"
  if git -C "$app" remote get-url origin >/dev/null 2>&1; then printf 'present-redacted\n'; else printf 'none\n'; fi
  printf 'lastCommitAt='; git -C "$app" show -s --format=%cI HEAD
else printf 'path=%s|git=no\n' "$app"; fi
printf '%s\n' '---APP_SIZE_AND_MANIFESTS---'
du -sb "$app" | awk '{print "path='$app'|bytes="$1}'
find "$app" -maxdepth 2 -type f \( -name package.json -o -name package-lock.json -o -name pnpm-lock.yaml -o -name yarn.lock -o -name schema.prisma \) -printf '%p|bytes=%s|mtime=%TY-%Tm-%TdT%TH:%TM:%TSZ\n' 2>/dev/null | sort
printf '%s\n' '---PROCESS_SUPERVISORS---'
systemctl list-unit-files --no-legend --no-pager | awk '$1 ~ /(licencia|correo|pedido|support|email)/ {print $1"|"$2}' | sort
docker ps -a --format '{{.Names}}|{{.Image}}|{{.Status}}|project={{.Label "com.docker.compose.project"}}' | awk 'tolower($0) ~ /(licencia|correo|pedido|support|email)/' | sort
printf '%s\n' '---ROOT_CRON_SAFE---'
helper="$(dirname "$0")/kvm_probe_sanitize.py"
test -r "$helper"
if cron_text=$(crontab -l 2>/dev/null); then printf '%s\n' "$cron_text" | python3 "$helper" --mode root | sort; else printf '%s\n' 'root-crontab|status=unknown'; fi
printf '%s\n' '---SYSTEM_CRON_SAFE---'
for f in /etc/cron.d/*; do
  [ -f "$f" ] || continue
  if [ -r "$f" ]; then python3 "$helper" --mode system --source "$f" < "$f"; else printf '%s|status=unknown\n' "$f"; fi
done | sort
printf '%s\n' '---APP_AUTOMATION_SOURCE_FILES---'
find "$app" -path '*/node_modules' -prune -o -path '*/.next' -prune -o -path '*/.git' -prune -o -type f \( -iname '*cron*' -o -iname '*email*' -o -iname '*correo*' -o -iname '*pedido*' -o -iname '*order*' -o -iname '*support*' -o -iname '*soporte*' -o -iname '*checkpoint*' -o -iname '*receipt*' -o -iname '*recibo*' \) -printf '%p|bytes=%s|mtime=%TY-%Tm-%TdT%TH:%TM:%SZ\n' 2>/dev/null | sort | head -250
printf '%s\n' '---STATE_PATH_REFERENCES---'
if command -v rg >/dev/null 2>&1; then search=rg; else search='grep -RIl'; fi
for term in checkpoint receipt recibo cursor idempotency idempotencia; do
  if [ "$search" = rg ]; then
    rg -l -i --glob '!node_modules/**' --glob '!.next/**' --glob '!.git/**' --glob '!generated/**' --glob '!*.env*' --glob '*.{ts,js,mjs,cjs,py,sh,json}' "$term" "$app/app/api" "$app/lib" "$app/scripts" 2>/dev/null
  else
    grep -RIl --exclude='*.env*' --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git --exclude-dir=generated "$term" "$app/app/api" "$app/lib" "$app/scripts" 2>/dev/null
  fi | sort -u | head -80 | sed "s#^#$term|#"
done
printf '%s\n' '---DIRTY_PATHS_ONLY---'
git -C "$app" status --porcelain | sed -E 's/^...//' | head -100
printf '%s\n' '---SELECTED_SCRIPT_METADATA---'
for f in \
  /opt/licenciadigital/scripts/ld-checkpoint.sh \
  /opt/licenciadigital/scripts/informe-soporte-semanal.sh \
  /opt/licenciadigital/scripts/db-readonly.sh \
  /opt/licenciadigital/scripts/db-health-check.sh \
  /usr/local/bin/correo-recepcion-centinela.sh; do
  if [ -f "$f" ]; then
    stat -c '%n|bytes=%s|mtime=%y|owner=%U|group=%G|mode=%a' "$f"
    printf '%s|sha256=' "$f"; sha256sum "$f" | awk '{print $1}'
    printf '%s|interpreter=' "$f"; head -1 "$f" | sed -E 's/^#![[:space:]]*//; s/[[:space:]].*$//'
    grep -Eo '/[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)+' "$f" 2>/dev/null | grep -Ei '(checkpoint|receipt|recibo|estado|state|audit|log|report|informe)' | sort -u | head -30 | sed "s#^#$f|statePath=#" || true
  else printf '%s|missing\n' "$f"; fi
done
printf '%s\n' '---AUTOHEAL_SUPERVISOR---'
systemctl show autoheal-licenciadigital.timer -p LoadState -p ActiveState -p SubState -p UnitFileState -p LastTriggerUSec -p NextElapseUSecRealtime -p Triggers --no-pager
systemctl show autoheal-licenciadigital.service -p LoadState -p ActiveState -p SubState -p Result -p ExecMainStatus -p ExecMainStartTimestamp -p ExecMainExitTimestamp -p User -p FragmentPath --no-pager
printf '%s\n' '---FRONTEND_RUNTIME---'
docker inspect --format '{{.Name}}|image={{.Config.Image}}|imageId={{.Image}}|created={{.Created}}|started={{.State.StartedAt}}|status={{.State.Status}}|health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|restartCount={{.RestartCount}}|restartPolicy={{.HostConfig.RestartPolicy.Name}}|composeProject={{index .Config.Labels "com.docker.compose.project"}}|composeFiles={{index .Config.Labels "com.docker.compose.project.config_files"}}|workingDir={{.Config.WorkingDir}}' licenciadigital-frontend-1
printf '%s\n' '---BUSINESS_ROUTE_FUNCTIONS---'
find "$app/app/api" -type f -name 'route.ts' \( -ipath '*cron*' -o -ipath '*pedido*' -o -ipath '*order*' -o -ipath '*support*' -o -ipath '*soporte*' -o -ipath '*correo*' -o -ipath '*email*' \) -print 2>/dev/null | sort | while read -r file; do
  printf '%s|methods=' "$file"
  sed -n -E 's/^[[:space:]]*export[[:space:]]+(async[[:space:]]+)?function[[:space:]]+(GET|POST|PUT|PATCH|DELETE).*/\2/p' "$file" | paste -sd, -
done
