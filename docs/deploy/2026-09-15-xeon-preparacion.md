# Xeon: preparación, continuidad y pruebas de fases

Fecha de preparación: 2026-09-15. Este documento distingue el paquete de prueba, el servicio productivo y la propuesta de terminal. La preparación no activa las banderas en producción ni acredita una migración del motor a un servicio.

## Qué está preparado

- Candidato portable Windows x64, Electron 32.3.3, sin firma, construido desde `1baada1473abd8569a00dbb5d379ec606c19d94e` más el estado local preservado de branding, manifiestos y remote-daemon. No es una compilación exclusivamente del commit: el overlay exacto está en el respaldo y su manifiesto.
- Carpeta de destino: `C:/Users/Administrador/munder-releases/2026-09-15-phase56/app`. La copia productiva permanece en `C:/Users/Administrador/orca/workspaces/munder-difflin/Munder-Difflin-Harnes`.
- `Start-Visual-Test.ps1`: valida SHA256 de los 364 archivos del paquete y abre un perfil/home de prueba separado. Empieza sin misiones, conexiones remotas, automatización, autoactualización ni las cuatro banderas nuevas. No contiene agentes ni datos productivos.
- `Preflight-Xeon.ps1`: inspecciona ledger, procesos CLI y archivos JSON pendientes. Excluye `.done`/`.sent`; directorio ausente significa desconocido, no cero. No cierra nada ni concede automáticamente permiso de reinicio.
- `native-probe.cjs`: carga SQLite y node-pty del ASAR real; consulta una base en memoria y ejecuta un `echo` en un PTY, sin iniciar agentes.

La compilación inicial con Node 24 falló al intentar compilar SQLite antes de reconstruirlo para Electron. Se instalaron dependencias difiriendo scripts y después se ejecutaron explícitamente la descarga de Electron, `postinstall`, rebuild y parche ConPTY. También quedaron reparadas las dependencias del checkout de trabajo. El portable se construyó con `win.signAndEditExecutable=false` por un fallo de permisos al extraer symlinks de las herramientas de firma. Eso no es un instalador firmado ni una publicación de release.

## Copias y trabajo conservado

Raíces: GPD `C:/Users/Alex/munder-safety/2026-09-15`; Xeon `C:/Users/Administrador/munder-safety/2026-09-15`.

| Archivo, presente en ambos equipos | Bytes | SHA256 |
|---|---:|---|
| `gpd-safety.tgz` | 220360568 | `348815DFE8E974C42C2C4CEF290D72AAB2AEC8BF86C7A49064DEA9B2C73D6F5B` |
| `xeon-before.tgz` | 1226343051 | `ABED548E0FF8F1F835983CCC850A370BB2AE63606502BE312C269ED9DAA3EDE1` |

Los hashes se compararon después de transferir, contra el destino. El respaldo GPD incluye bundle Git de todas las referencias, parches de índice/trabajo y snapshot de 2349 archivos con hashes. Conserva trabajo sin commit, ignorados y archivos de branding; excluye `.git` de la copia de archivos porque el historial va en el bundle, y excluye `node_modules`.

El respaldo Xeon se tomó desde VSS a **2026-09-15 10:17:10 -06:00**: 25480 entradas, home `godinc`, perfil `AppData/Roaming/munder-difflin` y árbol desplegado completo, excluyendo `node_modules`. La copia de producción no tiene `.git`; por eso era imprescindible conservarla como archivos. Se extrajeron y parsearon cinco JSON críticos: tareas, registro, roster, configuración y package. Es una prueba parcial de restauración, no un arranque completo del hive restaurado.

Comparación del código del snapshot Xeon con el candidato: 313 archivos de origen, 29 diferentes, ninguno exclusivo del Xeon. Los 29 coinciden con la base anterior a estas fases (`e1191e15`) al normalizar CRLF; no apareció un parche de origen exclusivo que se vaya a omitir. El inventario está en `xeon-source-differences.json`. Esto no sustituye revisar cambios posteriores al snapshot, perfiles, herramientas externas o bases de datos.

En la lectura inicial del ledger había 84 tareas: 24 todo, 21 doing, 14 blocked y 25 done. Son una captura de esa lectura, **no un estado en vivo**. Había procesos Claude/Codex activos. Un respaldo de archivos no conserva la memoria de una sesión PTY/LLM ni lo escrito después de la captura. Antes de promover: re-medir, guardar checkpoints y hacer otro respaldo consistente.

Los archivos de respaldo pueden contener configuración privada: se mantienen en estos dos equipos propios; no deben añadirse al repo ni al vault.

## Cómo abrir la prueba visual

Desde una sesión de escritorio del Xeon, abrir PowerShell:

```powershell
Set-Location 'C:/Users/Administrador/munder-releases/2026-09-15-phase56/app'
powershell -NoProfile -ExecutionPolicy Bypass -File ./Start-Visual-Test.ps1 -ValidateOnly
powershell -NoProfile -ExecutionPolicy Bypass -File ./Start-Visual-Test.ps1
```

El launcher crea `visual-test-only/profile` y `visual-test-only/home` debajo de `app`. Se verificó con Electron que `--user-data-dir` cambia el userData efectivo. La primera apertura muestra onboarding: conservar ese home y crear sólo fixtures claramente llamados TEST. No seleccionar `godinc` productivo. No se incluye ni se autoejecuta una flota de 11 agentes. Probar navegación con los instrumentos sintéticos antes de autorizar tareas reales con consumo de proveedor.

Las banderas se encuentran en ajustes: `softwareEconomyEnabled`, `floorInspectionEnabled`, `movementCoordinationEnabled` y `stationActivityEnabled`. Encender una a la vez, guardar y repetir el caso apagándola durante la actividad. El perfil productivo no se usa para esta prueba. No añadir `MUNDER_DISABLE_GPU=1`: el Xeon tiene antecedentes de pantalla vacía al forzar software.

| Fase del plan Astra | Cambios que se deben comprobar visualmente |
|---|---|
| 0 | No añade interfaz. Comprobar evidencia de tests y Windows; un push a esta rama no implica que Actions se ejecute. |
| 1 | Sin pensamientos/logros inventados. Fuente fallida o caducada no muestra cifras como actuales. Un cierre real puede celebrar una vez; arrancar con tareas ya cerradas no debe volver a celebrarlas. Handoff no equivale a reunión y CI verde no equivale a despliegue. |
| 2 | Modo económico: selección, cambios de tarea, sobres y breaker siguen actualizándose. Probar ventana visible, minimizada y restaurada, cambio de tema y recuperación GPU. Medir CPU/GPU; el objetivo de ahorro de 80% y actualización en 2 s aún no está demostrado. |
| 3 | Clic y teclado en agente/tarea/estación: captura fechada del ledger, Escape y retorno de foco, español/RTL. Sin textarea ni acciones de asignación/envío en el inspector. Los hilos de lectura y conversaciones reales de Descanso siguen pendientes. |
| 5 | Arranque simultáneo, cruces, destinos ocupados, cancelación durante un paso, prioridad de trabajo, retirar/recrear agente y apagar coordinación a mitad del trayecto. Usar 11 y 19 fixtures; distinguir solapamiento del dibujo de ocupar el mismo tile. |
| 6 | Visitas por hooks reales correlacionados de herramientas; éxito, denegación y fallo diferenciados. Operaciones breves no provocan viajes retrospectivos. Desconexión, breaker, cancelación y expiración no se presentan como éxito. Visitante no revela texto. Temas sin estaciones no heredan coordenadas accidentalmente. |

La fase 4 de este plan sigue aparte; la fase 7 está condicionada a una necesidad observada. No confundir esta numeración con fases de planes históricos presentes en el historial Git.

Comparar primero todas las banderas apagadas y después cada una encendida. Anotar duración, número de agentes, resolución, tema y backend. Incluir al menos 10 minutos visible y 10 minimizada, y después una jornada antes de activar globalmente. Son pruebas pendientes, no resultados medidos. Los eventos nativos de cada proveedor con sus credenciales tampoco están acreditados por los tests con fixtures.

## Verificación realizada

| Puerta del candidato | Resultado local 2026-09-15 |
|---|---|
| `npm run build` | Pasa |
| `npm run typecheck` | Node y web pasan |
| `npm run lint` | Pasa: comprobación sintáctica de 307 archivos |
| `npm test` | 1509 pruebas: 1507 pasan, 0 fallos, 2 omisiones existentes |
| `node docs/audits/phase5-source-coverage.cjs` | 293/308 líneas, 95.13%, seis módulos; no cobertura global |
| `npm audit --json` | 34 vulnerabilidades: 6 moderadas, 27 altas, 1 crítica; puerta de seguridad pendiente |
| Herramientas de preparación | Ledger vacío válido; ledger malformado rechazado; colas distinguen pendiente/archivado/ausente; hash correcto aceptado; alteración, escape de ruta y manifiesto vacío rechazados |

La primera ejecución omitía además tests del daemon por faltar su instalación anidada. Se instaló esa dependencia y se repitió la suite; las 2 omisiones de la tabla son el resultado final, no se ocultaron las 30 iniciales. Logs en la raíz de respaldo GPD. Las pruebas locales y la verificación del paquete no acreditan GitHub Actions ni aceptación visual.

Archivo de distribución `xeon-visual-test.tgz`: 183015586 bytes, SHA256 `69C73C8D0FECA14D16CF9063703F71204CA8E08E1F38CC6A3690B428F96A31F9`. La constancia de extracción y probe nativo del destino se guarda junto al paquete. No promover si falta esa constancia o falla su validación.

**Destino verificado a las 10:45:24 -06:00:** archivo transferido con hash idéntico, inventario de 364 archivos aprobado y probe del ejecutable empaquetado: SQLite=true, PTY=true, ABI=128. Evidencia `verification.json` al lado de `app`, copiada al respaldo GPD como `xeon-release-verification.json`. No se abrió la interfaz gráfica. El preflight de esa misma hora registró 21 tareas doing, 13 procesos CLI y 7 JSON pendientes de inbox; outbox y spawn-requests estaban vacíos. Sigue requiriendo cierre coordinado antes de activar producción.

## Promoción y reversión

1. Completar aceptación visual y decidir el tratamiento de las vulnerabilidades. No declarar todas las puertas aprobadas.
2. Ejecutar `Preflight-Xeon.ps1` inmediatamente antes del cambio. Revisar tareas en curso, mensajes y sesiones con los agentes; `doing=0` por sí solo no acredita que sea seguro cerrar.
3. Dejar checkpoints durables y detener de forma coordinada la creación de trabajo. Hacer copia fresca de home/perfil/código. Sólo entonces efectuar el cierre supervisado del proceso productivo.
4. Conservar el directorio anterior y una única instancia que escriba en el home real. Cambiar el acceso de arranque a la release validada usando el perfil productivo, inicialmente con las banderas nuevas apagadas. El launcher de prueba no sirve como launcher de producción.
5. Comprobar SQLite, PTY, router, ledger, última ejecución de misiones y procesos. Activar banderas gradualmente y observar. No copiar el perfil vacío de prueba sobre el productivo.
6. Si hay regresión, detener coordinadamente la nueva instancia y volver al ejecutable anterior. No restaurar ciegamente un ledger viejo encima de trabajo nuevo: reconciliar los cambios posteriores antes de restaurar estado. La copia anterior y su `launch-hive.bat` permanecen disponibles.

No se ha cambiado el arranque productivo ni reiniciado agentes durante esta preparación.

## Apagones y versión de terminal: propuesta

**Recomendación: motor sin interfaz, con terminal opcional.** Dibujar ASCII dentro de Electron mantendría su proceso, su dependencia del escritorio y parte del consumo. La extracción debe permitir que correo/pedidos/soporte sigan ejecutándose cuando se cierra la terminal o se apaga el ordenador del operador.

```text
PC / Xeon: CLI por SSH (supervisión) o interfaz gráfica opcional
                         |
Servidor independiente: motor + agenda + cola durable + checkpoints
                         |
                   APIs operativas
```

Si Xeon y el equipo de Licencia Digital comparten electricidad o Internet, mover el proceso entre ellos no resuelve ese fallo. Un UPS para equipo, router y ONT, más conexión móvil de respaldo, ayuda con interrupciones cortas; para un día entero hace falta capacidad fuera de ese sitio. No se ha confirmado que ambos equipos estén en ubicaciones independientes.

No reactivar Electron/noVNC en el VPS de producción: existe un incidente documentado de consumo y throttling que afectó sus sitios. En la lectura de hoy `hive-app.service` estaba deshabilitado; el daemon Kepler estaba activo pero reportaba 123 reinicios y el tramo consultado del journal contenía salidas con código 1. No se ha establecido su causa ni que haya dejado de repetirse. Primero diagnosticarlo y medir capacidad; estar `active` no acredita estabilidad.

El daemon remoto existente conserva PTYs al desconectar WebSocket, pero no sobrevive a su propio cierre con esas sesiones intactas. Además, las solicitudes de archivos pueden depender del cliente desconectado. La agenda principal está en `armMissions()` de `src/main/index.ts`, y configuración depende de Electron. `HiveManager` ya recibe un proveedor de home, lo que facilita separar adaptadores; todavía no hay un servicio autónomo que sustituya esas dependencias.

Orden propuesto para una nueva entrega, separado de las fases gráficas:

1. **CLI de lectura**, ejecutable en PowerShell/SSH: resumen del ledger, disponibilidad/antigüedad de la fuente, pendientes y errores. Sin iniciar Electron ni agentes. Salida ASCII y JSON, lectura a demanda; TUI opcional con refresco acotado sólo mientras está abierta. No mostrar `healthy`, cero o éxito como sustituto de datos ausentes. Esta CLI aún no está implementada.
2. **Extraer el motor**: configuración/storage sin Electron, agenda, router y control de procesos bajo un servicio supervisado. El cliente gráfico y la terminal consumen el mismo estado. Reiniciar el cliente no mata el trabajo.
3. **Persistencia y exclusión**: registrar cada operación antes de ejecutarla; un único escritor activo con lease/fencing. Checkpoints de último éxito confirmado, IDs de correo/pedido/ticket, reintentos acotados y revisión de fallos persistentes. Si se corta la conexión después de enviar una acción, reconciliar el resultado externo antes de repetirla. `lastFiredAt` no significa tarea completada.
4. **Pruebas de fallo** con cuentas/fixtures de prueba: cortar cliente, red, proceso y host a mitad de una operación; recuperar sin perder pendientes ni duplicar efectos. Un monitor en otro equipo comprueba el último éxito y alerta ante silencio. No se han configurado ni enviado alertas externas en esta preparación.

La recuperación de tareas perdidas al arrancar Windows puede usar [`StartWhenAvailable`](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-startwhenavailable), pero no ejecuta nada durante el apagón. Los reintentos necesitan [idempotencia y reconciliación](https://temporal.io/blog/idempotency-and-durable-execution); no basta reiniciar el proceso ni prometer ejecución exactamente una vez.

Esta propuesta no selecciona ni instala todavía una plataforma nueva de colas. Primero se define el contrato sobre el motor y los datos existentes; después se elige almacenamiento y supervisor según las operaciones reales.
