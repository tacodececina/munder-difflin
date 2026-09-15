# LID-0 — compatibilidad y versiones candidatas

**Observado:** 2026-09-15 (UTC). **Alcance:** fuentes públicas primarias y metadatos locales de Python; no se instaló ni arrancó Hermes, Workspace o el paquete LID. Esta nota fija candidatos reproducibles, no declara compatibilidad operativa del host.

## Identidad y revisión de upstream

| Componente | Fuente identificada | Revisión candidata | Qué quedó comprobado |
|---|---|---|---|
| Hermes Workspace | [`outsourc-e/hermes-workspace`](https://github.com/outsourc-e/hermes-workspace) | [`c631425d8baa933f8c61d8447040f4ec8b5f571c`](https://github.com/outsourc-e/hermes-workspace/tree/c631425d8baa933f8c61d8447040f4ec8b5f571c), commit fechado 2026-08-22 | `git ls-remote`, clon superficial del commit y lectura de código/README. Es el repositorio público que se describe como Workspace nativo para Hermes Agent. No se comprobó que una copia retirada anteriormente de KVM4 tuviera este origen o commit. |
| Hermes Agent | [`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent) | [`f13a87e610611ce6d9fd82bff8c2d2a642312183`](https://github.com/NousResearch/hermes-agent/tree/f13a87e610611ce6d9fd82bff8c2d2a642312183), versión declarada `0.21.3`, commit fechado 2026-09-15 | `git ls-remote`, clon superficial y lectura del código y `pyproject.toml`. Upstream exige Python `>=3.11,<3.14`; por ello el Python predeterminado 3.14.6 de este GPD no es candidato para ejecutar Agent. |

El README de Workspace fija Node.js 22+ y presenta tres piezas separadas: Workspace, gateway de Agent y dashboard de Agent. Declara `HERMES_API_URL` hacia el gateway, normalmente `:8642`, y `HERMES_DASHBOARD_URL` hacia dashboard, normalmente `:9119`; sesiones, skills, configuración, MCP y jobs ampliados dependen de que el dashboard esté disponible. Véanse el [README fijado](https://github.com/outsourc-e/hermes-workspace/blob/c631425d8baa933f8c61d8447040f4ec8b5f571c/README.md#already-running-hermes-agent-attach-the-workspace-to-it) y la [configuración de servicios](https://github.com/outsourc-e/hermes-workspace/blob/c631425d8baa933f8c61d8447040f4ec8b5f571c/README.md#pair-an-agent-with-the-workspace).

Workspace contiene rutas propias de Swarm y una alternativa `native-swarm` cuando la API Conductor del dashboard no existe. Esto demuestra código disponible, no que sus workers estén activos ni que su persistencia cumpla recuperación LID. La ruta se observa en [`conductor-spawn.ts`](https://github.com/outsourc-e/hermes-workspace/blob/c631425d8baa933f8c61d8447040f4ec8b5f571c/src/routes/api/conductor-spawn.ts).

## Fuentes de estado observadas en Agent

| Área | Fuente primaria observada | Lectura para LID | Pendiente en host real |
|---|---|---|---|
| API | La tabla de rutas del gateway incluye `GET /health`, modelos/capacidades, sesiones persistidas y CRUD de jobs; el código exacto está en [`gateway/platforms/api_server.py`](https://github.com/NousResearch/hermes-agent/blob/f13a87e610611ce6d9fd82bff8c2d2a642312183/gateway/platforms/api_server.py#L1547-L1571). | En LID-1, preferir endpoints `GET` autenticados y devolver cobertura explícita. No usar la UI de Workspace como ledger. | Smoke autenticado de capacidades y forma real de cada respuesta en el host piloto; comprobar que el principal read no puede escribir. |
| Agenda | El gateway carga `~/.hermes/cron/jobs.json`, revisa vencimientos cada 60 s y actualiza metadatos. La documentación primaria describe el ciclo y la configuración de paralelismo; véase [cron](https://github.com/NousResearch/hermes-agent/blob/f13a87e610611ce6d9fd82bff8c2d2a642312183/website/docs/user-guide/features/cron.md). | `jobs.json` es estado de agenda, no prueba por sí solo de un efecto externo. `HERMES_CRON_MAX_PARALLEL` tiene default público 4; el piloto LID propone 2 ejecuciones de modelo totales y debe configurarlo/verificarlo aparte. | Listar jobs, propietario, perfil y último run real; confirmar que no existe un segundo scheduler sobre el mismo archivo. |
| Persistencia de ejecuciones | [`cron/executions.py`](https://github.com/NousResearch/hermes-agent/blob/f13a87e610611ce6d9fd82bff8c2d2a642312183/cron/executions.py#L42-L44) abre `~/.hermes/cron/executions.db` con sincronización completa. La documentación indica estados `claimed`, `running`, `completed`, `failed`, `unknown`; intentos abandonados pasan a `unknown` sólo tras comprobar PID/fingerprint y no se reintentan automáticamente. | Usar el ledger para evidencia de ejecución; conservar `unknown` como incertidumbre. No derivar entrega, pago o correo enviado desde `completed`. | Reinicios controlados y restauración aislada; comprobar WAL/backup/ownership/permisos y que el ledger local corresponde al perfil esperado. |
| Exclusión | [`cron/scheduler.py`](https://github.com/NousResearch/hermes-agent/blob/f13a87e610611ce6d9fd82bff8c2d2a642312183/cron/scheduler.py#L1-L2) declara `~/.hermes/cron/.tick.lock` para impedir ticks solapados entre procesos del mismo filesystem. | Útil contra dos tickers locales; no es fencing entre hosts ni garantiza exactly-once en sistemas externos. | Ensayar proceso duplicado y caída; no promover entre hosts usando sólo este lock. |
| Workers y reinicio | La documentación de [cron](https://github.com/NousResearch/hermes-agent/blob/f13a87e610611ce6d9fd82bff8c2d2a642312183/website/docs/user-guide/features/cron.md#restart-safe-workers-under-systemd) indica workers externos bajo `systemd-run --user --scope`. Sin sesión systemd de usuario, degrada y un reinicio del gateway puede matar el job; `cron.require_restart_safe_scope: true` permite fallar cerrado. Kanban exige scope. | El host piloto debe tener user systemd/linger funcional y usar fail-closed antes de atribuir supervivencia a reinicios. | Prueba real de gateway restart durante cron y worker Kanban; registrar resultado, no inferirlo de `active`. |
| Backup | El código de [`hermes_cli/backup.py`](https://github.com/NousResearch/hermes-agent/blob/f13a87e610611ce6d9fd82bff8c2d2a642312183/hermes_cli/backup.py#L1097) enumera `state.db`, config, referencias de credenciales, `cron/jobs.json` y `cron/executions.db`. | Es inventario de archivos que upstream considera parte del respaldo; no demuestra consistencia de una copia tomada en ejecución. | Snapshot consistente y restore de muestra en aislamiento, exigidos por LID-0. |

## Python local y lock propuesto para LID-1

Metadatos leídos en el GPD antes de la resolución aislada:

- Predeterminado: CPython 3.14.6, pip 26.1.2. Instalados en ese intérprete: FastAPI 0.139.2, HTTPX 0.28.1, Pydantic 2.13.4 y Uvicorn 0.51.0; Textual no está instalado.
- `uv python list --only-installed` encontró además CPython 3.13.15 y 3.11.15/3.11.9. No se ejecutaron imports del paquete LID porque aún no existe.
- Hermes Agent 0.21.3 excluye Python 3.14 en su [`pyproject.toml`](https://github.com/NousResearch/hermes-agent/blob/f13a87e610611ce6d9fd82bff8c2d2a642312183/pyproject.toml#L5-L12) y fija HTTPX 0.28.1, mientras permite FastAPI y Uvicorn `<1` ([dependencias](https://github.com/NousResearch/hermes-agent/blob/f13a87e610611ce6d9fd82bff8c2d2a642312183/pyproject.toml#L37-L42)). El adaptador LID seguirá en un entorno independiente para que su lock no altere Agent.

Propuesta a convertir en `pyproject.toml` + `uv.lock` únicamente al comenzar LID-1:

```toml
requires-python = ">=3.12,<3.13"
dependencies = [
  "fastapi==0.141.1",
  "httpx==0.28.1",
  "pydantic==2.13.5",
  "textual==8.2.8",
  "uvicorn==0.53.0",
]
```

Las versiones se observaron en la API primaria de PyPI el 2026-09-15: [FastAPI](https://pypi.org/pypi/fastapi/json), [HTTPX](https://pypi.org/pypi/httpx/json), [Textual](https://pypi.org/pypi/textual/json), [Uvicorn](https://pypi.org/pypi/uvicorn/json). Sus metadatos admiten Python 3.12. `uv 0.12.10` resolvió esas cinco restricciones para Python 3.12 sin instalar el paquete, produciendo 24 paquetes totales; esto comprueba resolución de metadatos, no import, build, compatibilidad de ASGI/TUI ni seguridad completa del lock. `uv` descargó automáticamente CPython 3.12.14 durante la resolución y se retiró después con `uv python uninstall 3.12.14`, restaurando el inventario previo; no se instaló Hermes, un servicio ni las dependencias resueltas.

Antes de aceptar el lock: generarlo para Linux del host elegido, usar `uv sync --frozen`, importar los cinco paquetes, ejecutar un endpoint FastAPI con `httpx` in-process, arrancar/cerrar una app Textual sin terminal interactivo, ejecutar tipos/lint/tests/cobertura y auditar dependencias alcanzables. Si alguna prueba obliga a cambiar una versión, registrar el nuevo conjunto y regenerar el lock; no declarar compatible sólo porque resolvió.

## Presupuestos del piloto

Estos valores son puertas propuestas, todavía no configuradas ni medidas:

| Presupuesto | Propuesta inicial | Interpretación |
|---|---:|---|
| Automatizaciones nuevas de LID-0 | **0 llamadas operativas de modelo iniciadas por esta fase** | El motor nuevo no se instala ni se ejecuta. Esto no mide ni afirma costo cero para los agentes de desarrollo/auditoría de esta sesión o los servicios existentes. |
| Concurrencia de modelo | **2 simultáneas en todo LID**, incluido el gerente | Configurar y comprobar en scheduler/workspace; workers en espera no deben consumir un turno de modelo. El default público de cron no acredita este límite. |
| Adaptador en reposo | **p95 <1% de un núcleo; RSS ≤256 MiB** | Medir por proceso en el host; incumplimiento bloquea promoción, no se corrige ocultando la métrica. |
| Runtime piloto completo | **≤2 vCPU sostenidas; RSS combinado Agent + Workspace + bridge ≤4 GiB** | Límite de capacidad propuesto, sujeto a medición con carga sintética. No está aplicado por esta nota. |
| Inferencia diaria | **tope propuesto USD 5/día** | Falta elegir modelo/proveedor y mecanismo fail-closed. Hasta entonces el costo es desconocido y este número no está enforced. Al alcanzar el tope futuro, dejar nuevos trabajos pendientes en vez de descartarlos. |

## Decisión y pendientes

Los dos repositorios públicos son identificables y los commits anteriores sirven como candidatos de revisión. No hay base para declarar que Workspace, Agent y el adaptador son compatibles como conjunto desplegado. Workspace fue retirado de KVM4 según el inventario de la fase; esta revisión pública no vuelve a instalarlo ni demuestra qué revisión estuvo allí.

Para cerrar compatibilidad operativa quedan pendientes: elegir host piloto con evidencia de recursos/energía; comprobar arquitectura y sistema operativo; verificar Node/pnpm; instalar desde locks en aislamiento; levantar gateway/dashboard/Workspace sólo en piloto; enumerar endpoints autenticados; validar persistencia y permisos del perfil; probar reinicios y restore; medir CPU/RAM; y demostrar que el límite global de dos llamadas de modelo funciona. Hasta completar eso, el resultado es **candidato técnicamente trazable, smoke real pendiente**.
