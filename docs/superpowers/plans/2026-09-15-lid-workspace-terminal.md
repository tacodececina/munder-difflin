# LID: Hermes Workspace, gerente en Lex Laboratory y consola — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task after Alex reviews the complete plan. Use `subagent-driven-development` only when delegated execution is authorized. Steps use checkbox (`- [ ]`) syntax for tracking. This document is a proposed plan, not an execution order or evidence of deployment.

**Goal:** Operar LID mediante un workspace de Hermes con gerente y agentes especializados, supervisable desde la oficina Lex Laboratory y una terminal, conservando trabajo y recuperándose de desconexiones sin duplicar efectos.

**Architecture:** Hermes Workspace organiza el equipo y Hermes Agent ejecuta los trabajos en un servidor independiente del PC del operador. Un adaptador expone estado verificable y, en una fase posterior, recibe encargos durables; la oficina y la TUI son clientes de ese contrato. La aplicación/API de LID conserva la autoridad sobre pagos, pedidos, entregas y soporte.

**Tech Stack:** Reutilizar Hermes Workspace/Agent y su supervisor instalado cuando cumplan las pruebas. Integración de oficina en TypeScript/Electron/React existentes; adaptador y consola aislados en Python 3.12+, Textual para TUI, SQLite local para acuses/checkpoints del adaptador, FastAPI/HTTPX para API y cliente privados. Las versiones exactas se fijan en el lock después de comprobar compatibilidad en LID-0; no actualizar upstream a latest automáticamente. El adaptador no importa Electron ni depende de un proceso del GPD.

**Spec:** [Propuesta del workspace](../../proposals/lid-hermes-workspace.md) y [maqueta](../../proposals/lid-terminal-concept.html). Aclaración de Alex: varios agentes en Hermes Workspace, con su gerente conectado a la oficina visual de Lex Laboratory. Lidia como gerente sigue siendo la propuesta de identidad.

**Estado:** Alex autorizó la ejecución por entregas comprobables visualmente el 2026-09-15: constructores GPT-5.6 y auditorías GPT-6 Astra. LID-0 iniciada; herramientas y evidencia de inventario en revisión. La numeración **LID-0…LID-9** es independiente de las fases Astra/gráficas anteriores. No se ha promovido operación nueva a producción.

## Global Constraints

- Veracidad antes que apariencia: fuente, alcance, última lectura válida y disponibilidad; `null`/desconocido no se sustituye por cero, healthy o fecha actual.
- Una sola autoridad de agenda por automatización; nunca dejar activos dos disparadores durante la migración.
- El inspector conserva lectura solamente. No consulta `visualTasks`, no envía mensajes ni abre indirectamente controles de escritura.
- El gerente remoto no es otro proceso agente local. Mostrarlo no inicia PTY, modelo, workers, cron o proveedor en el equipo de la oficina.
- Cerrar terminal/oficina no detiene el workspace. Un apagón del servidor sí puede detenerlo; recuperación y continuidad son garantías diferentes.
- Roles iniciales: gerente, correo, pedidos y soporte. Reutilizar identidades adecuadas existentes; no duplicar Lidia ni reemplazar su memoria silenciosamente.
- Concurrencia inicial propuesta: máximo dos ejecuciones de modelo en todo el workspace, incluido el gerente. Esperar a un worker no consume un bucle de razonamiento. Colas restantes durables, no descartadas.
- Herramientas por rol y permisos vigentes comprobados contra destino. Sin shell arbitrario ni ampliación de acceso a host como requisito para integrar.
- Secretos, claves de licencia y contenido de clientes no entran en el repositorio/vault ni se envían a proveedores externos por esta integración. Usar identificadores y metadatos mínimos en UI/modelos; resolver datos operativos dentro de las herramientas autorizadas.
- Ningún dato de producción en fixtures, capturas públicas o logs de CI. Logs de operaciones sin cuerpos de correo, tokens o claves.
- Banderas nuevas apagadas por defecto; comprobación antes de resolver dependencias, crear cachés, suscripciones, solicitudes o temporizadores. Apagarlas limpia ese trabajo e invalida respuestas tardías.
- Las banderas de visualización/control del cliente no apagan el motor operativo remoto. Cero recursos de esa integración cuando están apagadas; los servicios remotos tienen ciclo de vida explícito e independiente.
- Nada nuevo en el callback por frame de la oficina: consultas y actualización del gerente por eventos/cambios. Mantener el arreglo GPU existente.
- Interfaz de oficina en en/es/ar/zh-CN, español latinoamericano y RTL. Teclado, lector de pantalla y alternativa sin color; la TUI respeta el locale y no exige iconos especiales.
- Una entrega por fase, con código/manifest/validación/reversión propios. Repos y cambios locales ajenos conservados; no copiar un working tree sin registrar su overlay.
- Build → tipos → lint → tests → cobertura ≥80% de lógica afectada real → seguridad. No acreditar cobertura de fuente con porcentajes del loader. Cualquier skip necesita causa explícita, sin convertir fallos nuevos en exclusiones.
- No declarar producción aceptada con vulnerabilidades críticas/altas explotables en los componentes habilitados. Registrar y tratar las heredadas; no afirmar seguridad global si quedan pendientes.
- El plan se presenta completo antes de comenzar. No se instala infraestructura, migra agenda ni envían mensajes durante la planificación.

## Resultado visible

```text
OFICINA LEX LABORATORY                    WINDOWS TERMINAL / SSH
   Avatar del gerente                        Consola LID
            \                                   /
             +----- contrato de integración ----+
                               |
                 HERMES WORKSPACE LID [servidor]
                     Gerente propuesto: Lidia
                        /       |       \
                     Correo   Pedidos   Soporte
                        \       |       /
                    Herramientas / API de LID
```

La primera versión muestra sólo al gerente en la oficina. Su panel permite inspeccionar al equipo sin agregar todos los workers al piso ni ocupar los escritorios de agentes locales. Una conversación del gerente puede explicar resultados, pero no cambia por sí sola el estado de una operación.

## Autoridad de los datos

| Dato | Fuente autoritativa | Qué conserva el adaptador |
|---|---|---|
| Identidades, asignaciones y ejecución del equipo | Runtime/registro de Hermes verificado | Vista normalizada con IDs originales y fecha de observación |
| Agenda de cada automatización | Disparador elegido en el inventario; Hermes tras su migración | Referencia al disparador, última observación y cursor de migración |
| Estado de pago, entrega, devolución o ticket | API/herramienta operativa LID y comprobantes del sistema correspondiente | Referencia y resultado mínimo confirmado; nunca inventa el efecto |
| Encargo recibido desde oficina/TUI | Registro durable de recepción del adaptador | Request ID, hash, destinatario, acuse y vínculo a la ejecución nativa |
| Actividad del avatar y resumen en terminal | Proyección del contrato anterior | Captura limitada, no otro ledger operativo |

El registro del adaptador cubre recepción, correlación y recuperación del puente. No reemplaza ni sobrescribe el historial de Hermes o la base de negocio. No escribir copias de las tareas remotas como tareas locales de `HiveManager` para simular integración.

## Mapa de archivos

Las rutas siguientes son **destinos propuestos**, salvo los archivos de Munder señalados como existentes. Crear el paquete `integrations/lid` dentro del repo permite versionarlo junto al contrato; se construye y despliega independientemente de Electron.

| Área | Rutas y responsabilidad |
|---|---|
| Contrato común | `integrations/lid/contracts/v1/{reading,workspace,command}.schema.json`, `fixtures/*.json`; tipos TS generados `src/shared/lidWorkspace.ts`; modelos Python `integrations/lid/lid_ops/contracts.py` |
| Adaptador | `integrations/lid/lid_ops/{settings,hermes_source,readings,api,auth,commands,journal,reconcile}.py` |
| Cliente terminal | `integrations/lid/lid_ops/{client,cli,tui}.py`, `integrations/lid/lid_ops/locales/` |
| Empaquetado independiente | `integrations/lid/pyproject.toml`, `integrations/lid/uv.lock`, `integrations/lid/deploy/{lid-bridge.service,workspace-policy.json}` |
| Pruebas del paquete | `integrations/lid/tests/test_{contracts,readings,api,commands,recovery,cli,tui}.py`, `tests/fixtures/` |
| Puente de oficina | Nuevos `src/main/lidWorkspace.ts`, `src/renderer/src/store/lidWorkspace.ts`, `src/renderer/src/components/LidWorkspaceInspector.tsx`, `src/renderer/src/components/LidCommandComposer.tsx`, `src/renderer/src/scene/office/workspaceManagerView.ts` |
| Cableado existente | `src/main/config.ts`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/src/store/config.ts`, `src/renderer/src/store/store.ts`, `src/renderer/src/AppShell.tsx`, `src/renderer/src/components/SettingsModal.tsx` |
| Piso y comandos existentes | `src/renderer/src/scene/office/{OfficeFloor.tsx,floorInteractions.ts,sceneLifecycle.ts}`, `src/renderer/src/components/{OfficeInspector.tsx,CommandCenterPanel.tsx}`; cambios pequeños, sin trasladar el motor a estos archivos |
| Pruebas Munder | `test/lid-{reading,disabled,manager,commands}.test.cjs`; ampliar pruebas de lifecycle sólo donde cambie comportamiento |
| Migración/evidencia | `docs/deploy/lid/{inventory,compatibility,automation-map,source-ownership,migration,rollback,acceptance}.md`, `tools/deploy/lid/`, `tools/perf/lid/` |

El código de Hermes y de LID se localizará y versionará en LID-0. Las herramientas nuevas se integrarán en su repo fuente real; el inventario debe registrar la ruta y commit exactos antes de editarlas. No inventar rutas de producción ni convertir una copia desplegada sin Git en fuente canónica. Para este plan, la oficina objetivo es el Munder de este repo; LID-0 confirmará que corresponde a la oficina que Alex usa como Lex Laboratory, antes de modificar otro frontend histórico.

## Contrato mínimo propuesto

Endpoints de nuestro adaptador, **no endpoints afirmados de Hermes**:

```text
GET  /v1/workspaces/lid/snapshot       lectura normalizada
GET  /v1/workspaces/lid/commands/{id}  acuse/estado de un encargo autorizado
POST /v1/workspaces/lid/commands       sólo después de LID-5
GET  /health/live                     proceso responde; no afirma negocio sano
GET  /health/ready                    dependencias y permisos necesarios disponibles
```

`value` contendrá `managerId`, `agents`, `tasks`, `jobs`, `capabilities` y `coverage`. `jobs` contiene identificador nativo, propietario de agenda, enabled, próxima ejecución y último resultado confirmado, usando null donde falte evidencia. `capabilities` enumera operaciones observadas y autorizadas, no supuestas por versión. `cursor`/`limit` son parámetros del snapshot paginado; cada página conserva epoch/secuencia, y una colección mezclada entre versiones se descarta y vuelve a pedir.

Acceso privado: bind en loopback y proxy TLS privado/Tailscale existente validado en LID-0; si no existe ruta privada apta, habilitar túnel SSH específico. No abrir puertos públicos por defecto. Credenciales separadas `read` y `dispatch`, almacenadas fuera del repo; comprobación en servidor, no sólo botones ocultos. Main conserva secretos de Electron mediante el patrón de `safeStorage` ya existente; no reutilizar el secreto HMAC del daemon para un protocolo distinto.

```json
{
  "schemaVersion": 1,
  "workspaceId": "lid",
  "epoch": "fixture-runtime-1",
  "sequence": 7,
  "source": "fixture:hermes",
  "lastAccessedAt": "2026-09-15T12:00:05Z",
  "lastValidAt": "2026-09-15T12:00:00Z",
  "availability": "unavailable",
  "freshness": "stale",
  "value": {
    "managerId": "fixture-manager",
    "agents": [],
    "tasks": [],
    "jobs": [],
    "capabilities": ["read"],
    "coverage": "complete"
  }
}
```

Ejemplo sintético: conserva una captura anterior y declara fallo actual. `value:null` significa que nunca hubo lectura válida; arrays vacíos sólo describen cero elementos si `coverage=complete` y la lectura es válida. Una cobertura parcial da conteos parciales explícitos, nunca total cero.

Separar `availability` (lectura técnica), `freshness` (antigüedad de evidencia) y estado de cada trabajo. Un poll exitoso de un archivo viejo no refresca el timestamp del productor. Si el upstream no aporta evidencia de frescura, declararla desconocida; no sustituirla por hora de HTTP/mtime sin contrato probado. Validar fecha futura/desfase de reloj y secuencias fuera de orden; reinicio cambia epoch.

Estados de encargo: `received`, `dispatched`, `running`, `blocked`, `completed`, `failed`, `unknown`, `cancel_requested`, `cancelled`. Cancelado sólo tras acuse; conexión perdida no cancela ni completa. `completed` requiere resultado verificable de la tarea; un efecto de negocio exige su propio comprobante.

## LID-0 — Inventario real, preservación y decisiones de plataforma

**Entrega:** mapa actual, respaldos restaurables, versiones fijadas y destino de piloto elegido por evidencia. Ninguna automatización cambia de dueño.

**Aclaración de topología, Alex 2026-09-15:** Xeon es laboratorio en casa; KVM4 es el VPS de producción de Licencia Digital. El piloto será aislado en laboratorio y no acreditará continuidad ante un apagón doméstico. KVM4 sigue sujeto a evaluación antes de añadir carga. El [índice de la entrega](../../deploy/lid/README.md) separa herramientas públicas de observaciones y capturas privadas; una auditoría del código no completa por sí sola las puertas operativas siguientes.

- [ ] Inventariar GPD, Xeon y servidores candidatos: origen/commit o copia sin Git, modificaciones, artefactos, perfil, memoria, colas, sesiones activas, agenda, supervisor, dependencias, permisos y forma de acceso de cada herramienta. Consultar metadatos, no volcar secretos/correos.
- [ ] Mapear cada chequeo de correo/pedido/soporte a un disparador, frecuencia, propietario, credencial referenciada, cursor, última ejecución confirmada y último efecto confirmado. Identificar qué aún depende de archivos, escritorio o sesión del PC desconectado.
- [x] Hacer snapshot consistente y manifest SHA256, preservar cambios sin commit, copiar a segundo equipo y restaurar una muestra de ledger/config/cola en aislamiento. Comprobado 2026-09-15: VSS en Xeon, backup online de SQLite en KVM4 y fuente/overlay/Git preservados; hashes cotejados en destino y muestras restauradas. Consistencia por base/archivo donde no hubo snapshot global; exclusiones reconstruibles y memoria de procesos fuera del alcance, documentadas en recibos privados.
- [ ] Verificar versiones y endpoints reales de Hermes Workspace/Agent, fuente de estado, persistencia de jobs/workers y limitaciones de reinicio. Medir el servicio con reinicios reportados antes de elegirlo como motor.
- [ ] Medir ubicación eléctrica/red, recursos y carga de candidatos. Preferir servidor con energía/red independientes y aislamiento de LID; si KVM4 no tiene margen estable, no alojar allí más carga. No reactivar Electron/noVNC ni aprovisionar una compra nueva como efecto colateral.
- [ ] Fijar versiones/lock para el piloto, presupuestos máximos explícitos y plan de saneamiento de vulnerabilidades. Registrar si una capacidad upstream necesita actualización aislada antes de ser usable.

**Archivos:** `docs/deploy/lid/{inventory,compatibility,automation-map,source-ownership}.md`; manifiestos y copias privadas fuera de Git. `pyproject.toml`/lock se crean con el primer paquete comprobable de LID-1, usando las versiones elegidas aquí.

**Aceptación:** cada automatización tiene dueño y método de re-medición; backup verificado en destino y restauración de muestra; ninguna instalación se considera apta sólo por mostrar `active`. Decisión de host y límites de consumo registrados. Si no hay host independiente apto, se puede avanzar con fixtures y UI, pero no afirmar cobertura del apagón ni promover operación.

**Reversión:** observaciones/copia sin cambios operativos; eliminar únicamente recursos temporales propios tras comprobar archivos finales, conservando backups.

## LID-1 — Contrato y adaptador de lectura veraz

**Depende de:** LID-0. **Entrega:** API de lectura validada y reproducible, independiente de Electron.

**Archivos:** contrato/esquemas/fixtures, `settings.py`, `hermes_source.py`, `readings.py`, `api.py`, `auth.py`, `test_contracts.py`, `test_readings.py`, `test_api.py`; tipos `src/shared/lidWorkspace.ts`.

- [ ] Escribir fixtures de lectura válida, vacía completa, parcial, ausente, corrupta, vieja, fecha futura y respuesta de otro workspace. Crear validadores TS/Python contra el mismo esquema.
- [ ] Reproducir pruebas rojas: fuente fallida después de lectura buena no cambia `lastValidAt`; recuperar epoch anterior no pisa el estado nuevo; campo sensible no atraviesa el serializador.
- [ ] Implementar mapeo hacia las fuentes de Hermes comprobadas en LID-0. Preferir API publicada; si hay lectura de registros locales, usar acceso consistente y no escribir esos archivos.
- [ ] Exponer snapshot mínimo autorizado. Dejar POST no habilitado; principal de lectura jamás tiene permisos de ejecución. Límites iniciales: página de 200 registros, snapshot ≤1 MiB, paginación/coverage explícitas si hay más datos.
- [ ] Crear build independiente, lint/tipos/tests y cobertura real. Verificar equivalencia TS/Python con todos los fixtures y contratos de error 401/403/timeout/JSON inválido.

**Interfaces:** `GET snapshot` produce el envelope definido arriba; cada lector valida `workspaceId`, `schemaVersion`, epoch/secuencia y frescura. Lectura a demanda, una consulta upstream concurrente por workspace y caché compartida de hasta 5 segundos sólo mientras el servicio de lectura esté habilitado. Deshabilitado: cero consultas/timers/cachés del adaptador de lectura.

**Prueba mínima de comportamiento** (en `test_readings.py`, funciones a implementar en `readings.py`):

```python
def test_failure_preserves_evidence_time():
    prior = initial_reading('lid')
    good = accept_reading(prior, {'agents': [], 'tasks': [], 'coverage': 'complete'},
                          observed_at=1000, attempted_at=1000)
    failed = fail_reading(good, attempted_at=6000)
    assert failed.last_valid_at == 1000
    assert failed.last_accessed_at == 6000
    assert failed.availability == 'unavailable'
    assert failed.value == good.value
```

**Aceptación:** ambas implementaciones rechazan respuestas ajenas y datos inválidos; un fixture corrupto no se convierte en cero tareas; no hay secreto ni cuerpo operativo en respuesta/log. Cobertura ≥80% de validación, normalización y lifecycle.

**Reversión:** apagar el servicio/lector sin tocar Hermes ni su agenda.

## LID-2 — Workspace piloto con gerente y equipo

**Depende de:** LID-0 y contrato LID-1. **Entrega:** gerente y tres roles funcionando sobre datos de prueba, fuera de la oficina.

**Archivos:** `integrations/lid/deploy/{workspace-policy.json,lid-bridge.service}`; configuración/supervisor del Hermes piloto en su repo identificado en LID-0; `docs/deploy/lid/compatibility.md`. Pruebas en `tests/fixtures/` y evidencia de proceso del piloto.

- [ ] Preparar entorno piloto aislado de la agenda, colas y credenciales de escritura productivas. Reutilizar el runtime compatible; no copiar la memoria de Lidia sin registrar origen y estrategia de actualización.
- [ ] Configurar gerente propuesto Lidia y roles correo/pedidos/soporte, con contratos de entrada/salida, herramientas por rol y escalado de bloqueos. Modelos/costos fijados antes de habilitar llamadas; máximo dos ejecuciones simultáneas.
- [ ] Arrancar bajo supervisor independiente de la sesión SSH. Persistir configuración, pendientes, checkpoints y registros en volumen/local filesystem apropiado, no en memoria del terminal ni en share con SQLite activo.
- [ ] Ejecutar tareas sintéticas: gerente asigna al rol correcto, worker devuelve resultado verificable, fallo queda visible y no se etiqueta completado. Probar entrada maliciosa en un correo fixture como datos, sin conceder nuevas herramientas al agente.
- [ ] Cerrar y reconectar clientes; observar que el trabajo y sus comprobantes continúan. En esta fase no se afirma supervivencia al reinicio del host.

**Aceptación:** rol equivocado no puede ejecutar una operación ajena; la tarea se sigue por ID de gerente a worker y vuelta; conectar la oficina no es necesario para ejecutar. No se procesó ningún cliente real durante la prueba.

**Reversión:** detener sólo el piloto y conservar sus evidencias; producción original continúa.

## LID-3 — Gerente visible en Lex Laboratory, en lectura

**Depende de:** LID-1; aceptación final contra piloto LID-2. **Entrega:** avatar de gerente remoto e inspector del workspace.

**Archivos:** puente/store/manager view/inspector nuevos; config/main/preload/AppShell/Settings/OfficeFloor/floorInteractions existentes; cuatro locales; `test/lid-{reading,disabled,manager}.test.cjs`.

- [ ] Añadir `lidWorkspaceViewEnabled=false` en todo el cableado y separar registro de gerentes remotos de `hive.agents()`/PTY locales.
- [ ] Probar bandera apagada con factories espía que fallan si se invocan. Activar crea un único lector compartido; apagar aborta solicitud, vacía datos y elimina listeners. Respuesta vieja tras cambio de workspace/escena no repuebla el store.
- [ ] Introducir `workspace-manager` como objetivo visual de lectura con ID estable. No fingir un proveedor CLI ni escribir tareas espejo al ledger local. Si no hay espacio visual disponible, mostrar el acceso DOM al gerente en vez de desplazar u ocultar agentes existentes.
- [ ] Mostrar equipo, operaciones y bloqueos con fuente/fecha. La actividad del gerente y la del equipo son distintas: worker ocupado no demuestra que el gerente esté pensando. Datos caducados retienen etiqueta visible y no generan celebraciones.
- [ ] Mantener inspector separado de controles de envío. Soportar teclado, Escape, restauración de foco, RTL y visitante sin metadatos operativos sensibles.
- [ ] Medir ciclos con banderas apagadas/encendidas, ventana oculta y cambios de tema. No añadir una consulta, recorrido de tareas o reconstrucción de hitboxes por frame.

**Lectura activa:** por evento validado si existe stream fiable; fallback de una consulta cada 5 s como máximo, timeout 5 s, sin solapar, backoff hasta 60 s con jitter. Al ocultar/desmontar la vista, detener su consumidor; un consumidor explícito diferente puede mantener su propia lectura. TTL visual inicial 15 s y estado desconocido si el productor no aporta tiempo válido. Son parámetros de diseño, no resultados medidos.

**Aceptación:** un gerente remoto, cero PTYs/agentes locales añadidos; inspector contra snapshot del workspace, nunca `visualTasks`; 0 recursos nuevos del conector con bandera apagada; sin regresión GPU ni costos por frame nuevos; source-of-truth concordante entre fixture, API y panel.

**Reversión:** desactivar la bandera y volver a la release previa sin alterar agenda/estado remoto.

## LID-4 — CLI y TUI reales

**Depende de:** LID-1; integración final contra LID-2. Puede construirse en paralelo con LID-3 sobre el contrato congelado.

**Entrega:** consola instalable y usable por SSH, con lectura a demanda y vista interactiva. La maqueta HTML permanece como referencia, no como runtime.

**Archivos:** `client.py`, `cli.py`, `tui.py`, `locales/`, tests CLI/TUI, packaging Python. CLI propuesta:

```text
lid status --workspace lid
lid tasks --workspace lid --json
lid agents --workspace lid
lid schedule --workspace lid
lid tui --workspace lid
lid status --workspace lid --ascii --no-color
```

- [ ] Implementar primero CLI de lectura: stdout de datos, stderr diagnóstico; exit 0 lectura válida completa, 2 sin fuente vigente, 3 autenticación/configuración, 4 respuesta inválida. JSON conserva disponibilidad, fecha y cobertura.
- [ ] Crear TUI Textual con Trabajo/Agentes/Agenda. Conversación/envío todavía no habilitados; la UI explica la capacidad disponible sin un chat ficticio.
- [ ] Implementar selección/detalle, teclado, paginación, copia de ID y lectura de comprobantes mínimos. Soportar Unicode y alternativa ASCII sin depender de Nerd Fonts, imágenes o WebGL.
- [ ] Compartir una lectura por TUI abierta, sin refresh por cada panel. Cerrar cancela suscripción/timers y no manda `stop` al workspace. CLI puntual termina sin watcher.
- [ ] Probar Windows Terminal+PowerShell+SSH en GPD/Xeon y un terminal Linux por SSH. Ventana 120×35, fallback usable 80×24, redimensionado, reconexión y ausencia de color. Mac es prueba adicional sólo si se declara compatible para la entrega.

**Aceptación:** gerencia y terminal muestran el mismo workspace/epoch/secuencia a igualdad de captura; desconexión marca datos antiguos y conserva selección; 30 min con el cliente cerrado no afecta tareas sintéticas del servidor. Meta de rendimiento propuesta: mediana <1% de un núcleo en reposo para cliente y puente cada uno, sin LLM; medir RAM y CPU total del runtime por separado. La meta debe medirse en el host elegido y no extrapolarse de Chrome.

**Reversión:** retirar el cliente/paquete sin tocar registros remotos.

## LID-5 — Conversación y encargos durables al gerente

**Depende de:** LID-1, LID-2 y al menos un cliente aprobado. **Entrega:** un encargo confirmado desde CLI/oficina llega una sola vez al registro de recepción y se sigue hasta su resultado.

**Archivos:** `commands.py`, `journal.py`, `reconcile.py`, `auth.py`, `api.py`, cliente/CLI/TUI; `LidCommandComposer.tsx`, `CommandCenterPanel.tsx`, main/preload; `test_commands.py`, `test_recovery.py`, `test/lid-commands.test.cjs`.

- [ ] Definir permisos `dispatch`, hash de contenido y `requestId` UUID creado una sola vez por envío lógico. Persistir recepción antes del acuse HTTP. Misma clave/mismo hash devuelve mismo recibo; misma clave/otro contenido devuelve 409.
- [ ] Probar pérdida de respuesta después de persistir y reenvío del cliente. Correlacionar el encargo con la ejecución nativa. Si el upstream no permite saber si recibió el envío, clasificar `unknown` y reconciliar; no reenviar a ciegas.
- [ ] Añadir `lidWorkspaceDispatchEnabled=false`, comprobada tanto en cliente como servidor. Apagarla impide nuevos encargos; los ya aceptados no desaparecen ni se matan. UI de lectura no abre este canal.
- [ ] Reutilizar el Command Center como entrada explícita: workspace/destinatario visibles, borrador revisable y confirmar una solicitud. Cancelar no envía; error conserva borrador y requestId. No insertar controles de escritura en el inspector.
- [ ] Incorporar conversación dirigida al gerente con sesión/autoría reales. Separar respuesta textual, encargo aceptado y efecto confirmado. El texto del modelo no tiene autoridad para marcar pagos/entregas/completados.
- [ ] Añadir `lid request`, seguimiento por ID y controles de agenda permitidos. `pause`, `cancel` y `retry` sólo para capacidades realmente disponibles, con acuse y estado; nunca mostrar éxito antes de comprobarlo.

**Fixture de recepción a implementar** (función `receive_command` y repositorio en `commands.py`/`journal.py`):

```python
def test_repeat_receives_same_command(journal):
    payload = {'workspaceId': 'lid', 'requestId': '10000000-0000-4000-8000-000000000001',
               'kind': 'task', 'body': 'Consultar fixture de pedido'}
    first = receive_command(journal, payload, principal='fixture-dispatch')
    second = receive_command(journal, payload, principal='fixture-dispatch')
    assert first.command_id == second.command_id
    assert journal.command_count() == 1
```

**Aceptación:** cien reintentos del mismo fixture producen un registro de recepción; dos requests distintos siguen siendo distintos. Principal read recibe 403 para POST. Corte de red deja recibido/desconocido según evidencia, no fallido con reintento automático. Esto prueba deduplicación de recepción, no ejecución exactamente una vez en sistemas externos.

**Reversión:** apagar admisión, resolver/reconciliar pendientes y conservar journal; no restaurar un journal antiguo encima de nuevos acuses.

## LID-6 — Correo, pedidos y soporte en observación paralela

**Depende de:** LID-2 y LID-5. **Entrega:** los agentes interpretan operaciones reales con permisos de lectura y producen propuestas comparables, sin duplicar efectos del sistema actual.

**Archivos:** herramientas LID en su repo fuente registrado en LID-0, políticas/skills del workspace, fixtures de dominio, `docs/deploy/lid/{automation-map,acceptance}.md`.

- [ ] Correo: leer IDs/cursor y clasificación permitida. No marcar leído/archivar/enviar por ejecutar la observación; si el proveedor no ofrece lectura sin efectos, usar snapshot autorizado.
- [ ] Pedidos: consultar estado de pago/entrega y detectar discrepancias; jamás actualizar estados o reservar/liberar licencias durante esta fase.
- [ ] Soporte: leer casos, proponer diagnóstico/respuesta y escalado. No abrir casos duplicados ni enviar respuesta real.
- [ ] Comprobar herramientas con pruebas de contrato de negocio: consulta exitosa ≠ pago recibido; estado refunded ≠ transferencia bancaria; borrador ≠ correo enviado; caso asignado ≠ caso resuelto.
- [ ] Probar prompt injection en entradas sintéticas y verificar límites de herramientas, minimización de datos y ausencia de secretos en registros/prompts.
- [ ] Comparar al menos 48 h y al menos 20 casos evaluables por flujo, incluyendo fixtures de error. Si el volumen real no alcanza, registrar el número real y completar variedad con fixtures; no simular volumen productivo ni atribuirlo a la operación.

**Aceptación:** cero efectos externos de la observación, cero omisiones no explicadas en la muestra comparada, todos los bloqueos informados con evidencia. Cualquier propuesta incorrecta relevante genera corrección y repetición del caso antes del piloto de escritura.

**Reversión:** desactivar observadores del piloto; la agenda productiva original sigue siendo el único ejecutor.

## LID-7 — Recuperación, apagones y pérdida de respuesta

**Depende de:** LID-5 y conectores de LID-6. **Entrega:** prueba reproducible de los límites de continuidad y recuperación antes de activar efectos reales.

**Archivos:** `test_recovery.py`, simuladores en `tests/fixtures/`, `tools/deploy/lid/`, `docs/deploy/lid/{rollback,acceptance}.md`; configuración del supervisor y backups del piloto.

- [ ] Cortar sólo SSH/oficina, después red cliente-servidor, después puente, worker y gateway. Hacer reinicio de host únicamente en el piloto aislado. Identificar qué procesos sobreviven realmente y qué trabajos se reanudan desde checkpoint.
- [ ] Inyectar fallo antes de persistir encargo, después de persistir, después de despachar y después de un efecto externo simulado antes de guardar su respuesta. El último caso debe quedar desconocido hasta reconciliar por ID con el simulador.
- [ ] Ensayar caída del proveedor, almacenamiento lleno y volumen no montado: detener admisión cuando no se puede persistir; no confirmar recepción en memoria ni entrar en bucle de reinicios.
- [ ] Desconectar el PC operador durante 24 h mientras el servidor independiente atiende la carga sintética prevista. Comparar conjunto esperado/recibido/resuelto/pending, no sólo número total.
- [ ] Hacer backup consistente de registros/cursores y restaurarlo en una instancia aislada. Para promover otro host: comprobar parada o fencing del escritor anterior; un archivo lock local o perder SSH no prueba exclusión entre máquinas.
- [ ] Medir recuperación propuesta RTO ≤15 min ante fallo simple de proceso y restauración documentada; réplica/backup cada ≤15 min como objetivo RPO para desastre del host. Una transacción persistida soporta reinicio con disco intacto; no implica RPO=0 si desaparece el disco/host. Reportar valores reales obtenidos.

**Aceptación:** ningún efecto duplicado en la batería de fallos, ningún encargo aceptado perdido sin clasificación, toda incertidumbre reconciliada o visible. Prueba de 24 h sin PC aprobada; restauración comprobada. No afirmar alta disponibilidad ante caída del VPS sin un segundo nodo y protocolo de exclusión probados.

**Reversión:** finalizar pruebas y recuperar piloto desde su snapshot; ninguna prueba destructiva sobre host productivo compartido.

## LID-8 — Migración gradual de operación real

**Depende de:** LID-6, LID-7, controles LID-5 y puertas de seguridad. **Entrega:** cada flujo pasa a Hermes con un único disparador y sin perder pendientes.

**Archivos:** `docs/deploy/lid/{migration,rollback,automation-map}.md`, scripts de preflight/handoff, configuración de agenda verificada en sus repos fuente.

- [ ] Hacer preflight fresco de tareas, colas, sesiones y duplicados, confirmar ventana operativa vigente y crear backup nuevo. Desactivar únicamente la admisión del flujo que cambia; conservar o drenar las ejecuciones en curso.
- [ ] Registrar último cursor/efecto confirmado, detener el disparador anterior, verificar que no quedan ejecuciones solapadas y activar el nuevo desde ese punto. Si no se puede excluir al anterior, no activar un segundo escritor.
- [ ] **8A Correo:** comenzar por clasificación y borradores; después envíos dentro de permisos operativos vigentes. Dedupe por cuenta + ID de mensaje + versión de acción; sólo comprobante proveedor habilita estado enviado.
- [ ] **8B Pedidos:** consultas/conciliación primero; entrega o actualización por API después. Clave por pedido + evento/versión + acción. Cobros, devoluciones y liberación de licencias mantienen sus reglas de negocio y evidencia de cada efecto; la migración no amplía autorizaciones.
- [ ] **8C Soporte:** un responsable por ticket, historial/cursor conservado y escalado de bloqueos. No ejecutar el caso simultáneamente por agenda antigua y worker nuevo.
- [ ] Mantener al menos 24 h de observación y casos representativos después de cada corte 8A/8B/8C, ampliando si no hubo volumen suficiente. Verificar desde API/proveedor, no sólo el discurso del gerente.

**Aceptación por flujo:** un disparador activo, solicitudes nuevas procesadas, pendientes preservados, efectos reconciliados y correspondencia entre registros. No avanzar al siguiente flujo si existe una duplicación, pérdida o finalización falsa no resuelta.

**Reversión:** cerrar admisión nueva, reconciliar lo ya aceptado, devolver agenda anterior desde el cursor actualizado y con exclusión verificada. Conservar registros nuevos; no restaurar ciegamente el estado de antes de la migración.

## LID-9 — Supervisión, costo y aceptación operativa

**Depende de:** flujos migrados LID-8. **Entrega:** operación supervisada y manual de continuidad usable por Alex, con límites medidos.

**Archivos:** `tools/perf/lid/`, configuración de monitor independiente en el repo real identificado, `docs/deploy/lid/{acceptance,rollback,migration}.md` y guía de operador.

- [ ] Observar desde otro host: último éxito por flujo, antigüedad de pendientes, fallos repetidos, provider caído, disco y supervisor. Heartbeat del proceso y éxito de negocio son señales distintas.
- [ ] Probar una alerta de monitor en destino de prueba; activar entrega al canal autorizado según configuración existente, sin enviar mensajes a terceros como efecto del despliegue.
- [ ] Medir CPU/RAM/red y consumo real por rol/flujo durante al menos 72 h estables. Desglosar interfaz, puente, runtime e inferencia; costo ausente se marca desconocido. Si se supera el presupuesto de LID-0, limitar nuevas ejecuciones y mantener pendientes, no inventar costos ni descartarlas.
- [ ] Entregar uso de consola, lectura de bloqueos/comprobantes, pausa coordinada, recuperación, backup/restauración y procedimiento de volver al sistema anterior.
- [ ] Conservar las fuentes/releases anteriores y el acceso de reversión por al menos 7 días después de aceptar cada flujo. No borrar memoria, respaldos o sesiones históricas durante el cierre del proyecto.
- [ ] Registrar evidencia y límites: fases efectivamente desplegadas, flags activos, host, commit, hashes, tests/cobertura, mediciones y brechas abiertas. Code push, CI verde, paquete copiado, proceso levantado y operación aceptada son cinco hechos diferentes.

**Aceptación final:** correo/pedidos/soporte operan sin GPD ni oficina abierta; gerente/TUI concuerdan con registros; frescura y desconocidos correctos; prueba de apagón del cliente y restauración aprobadas; sin defectos críticos conocidos en los flujos habilitados; presupuesto y monitor comprobados.

**Reversión:** por flujo usando LID-8, con preservación de estado y diagnóstico. No desinstalar el motor completo como primera respuesta a una regresión de UI.

## Orden y trabajo paralelo

```text
LID-0 -> LID-1 -> LID-2
                   |
                   +--> LID-3 oficina ------+
                   +--> LID-4 terminal -----+--> LID-5 encargos
                                                  |
                                             LID-6 observación
                                                  |
                                             LID-7 fallos
                                                  |
                                             LID-8 migración
                                                  |
                                             LID-9 aceptación
```

LID-3/LID-4 pueden comenzar sobre fixtures después de LID-1; su aceptación requiere LID-2. LID-5 servidor puede adelantarse sobre el contrato, pero se habilita sólo después de revisión integrada. Una fase no obtiene permiso de escritura por haberse desarrollado en paralelo.

Si Alex elige ejecución con agentes: un responsable de runtime/adaptador, otro de oficina y otro de terminal; coordinador integra y revisa. Contrato firmado/versionado antes de repartir; archivos o worktrees independientes. No asignar simultáneamente cambios compartidos a config/main/preload ni permitir que dos agentes migren agenda. Cada entrega pasa revisión de requisitos y luego calidad/evidencia.

## Puertas de verificación y revisión

Para cada tarea de código: crear primero la prueba del comportamiento, comprobar que falla por la causa esperada, implementar mínimo, repetir prueba y ejecutar la suite relevante. Las tablas de aceptación de cada fase son los casos exigidos; no bastan tests que buscan strings en el código. No ejecutar una orden de producción desde tests.

Comandos previstos para paquetes reales una vez creados y fijado el lock:

```powershell
# Munder: ejecutar cuando cambien sus archivos
npm run build
npm run typecheck
npm run lint
npm test

# Paquete independiente: desde integrations/lid
uv sync --frozen
uv build
uv run mypy lid_ops
uv run ruff check lid_ops tests
uv run pytest --cov=lid_ops --cov-branch --cov-fail-under=80
uv run pip-audit
```

La cobertura de Munder necesita incluir los nuevos módulos con source maps verificados, siguiendo la metodología de `docs/audits/phase5-source-coverage.cjs`; no basta ejecutar el script actual de coverage que sólo cubre tres módulos ajenos. CI debe activar los jobs para PR/branch de trabajo y hacer obligatorias las pruebas Windows y del paquete Linux; comprobar la ejecución real, no sólo editar YAML. Fijar versiones de las herramientas Python en el grupo de desarrollo antes de usar los comandos anteriores.

Revisión de seguridad por fase: acceso privado y autorización servidor, datos mínimos, logs sin secretos, dependencias alcanzables y resistencia de conectores a instrucciones dentro de datos. Los hallazgos heredados se remiden y documentan; no se silencian para conseguir una puerta verde.

La revisión de Alex recibe, por fase, qué cambió, demostración reproducible, resultados de tests/cobertura, mediciones aplicables, riesgos pendientes y reversión. La aprobación de este plan no convierte los resultados propuestos en resultados obtenidos.

## Estimación y alcance

Estimación inicial orientativa, antes de LID-0: **15–25 jornadas de ingeniería**, con solapamiento entre oficina/terminal y tiempos de observación reales de 48 h, 24 h de fallo del cliente, al menos 24 h por corte de flujo y 72 h finales. No es una fecha comprometida; recursos de servidor, deriva de versiones, saneamiento de dependencias y APIs de negocio pueden cambiarla. Reestimar con evidencia después de LID-0.

El primer hito utilizable es LID-0…LID-4: workspace piloto y supervisión visual/terminal. La operación autónoma productiva requiere LID-5…LID-9. No incluye reconstruir toda la oficina, migrar todos los proyectos, meter todos los agentes como avatares, cambiar modelos sin evaluación ni failover automático entre VPS sin fencing validado.

## Referencias y revisión interna del plan

- [Hermes Workspace](https://github.com/outsourc-e/hermes-workspace): capacidades upstream de Swarm/orquestador/workers, no censo del sistema instalado.
- [Hermes cron](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron): agenda de gateway e historial; no garantía de efectos externos exactamente una vez.
- [Textual](https://textual.textualize.io/getting_started/): plataformas y Windows Terminal; no prueba de rendimiento de nuestra implementación.
- [FastAPI: despliegue](https://fastapi.tiangolo.com/deployment/concepts/) y [HTTPX: cliente asíncrono](https://www.python-httpx.org/async/): base propuesta para el adaptador privado y su cliente, con supervisor y conexiones acotadas.
- [Preparación anterior de Xeon](../../deploy/2026-09-15-xeon-preparacion.md): antecedentes de backups, paquete visual y tareas activas. Re-medir antes de intervenir.

Revisión interna documental: todos los objetivos de la propuesta tienen fase y aceptación; lectura/escritura tienen entregas y permisos distintos; ninguna ruta nueva se presenta como archivo desplegado; observación y migración tienen autoridad de agenda explícita; pruebas de recuperación preceden escrituras reales. Los umbrales/estimaciones son objetivos propuestos, no evidencia de ejecución. Rutas de origen remoto, host y versiones instaladas se determinan mediante la tarea explícita LID-0; no se dan por existentes a partir del vault histórico.
