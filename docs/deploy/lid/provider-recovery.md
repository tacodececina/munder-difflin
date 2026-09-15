# Recuperar agentes cuando un proveedor alcanza su límite

Este procedimiento usa los controles actuales de Munder. El cambio automático de proveedor y la recuperación transaccional de LID siguen siendo trabajo del [plan por fases](../../superpowers/plans/2026-09-15-lid-workspace-terminal.md). Xeon es laboratorio; KVM4 conserva la producción de Licencia Digital.

## Contener y conservar

1. Confirmar el error en la sesión afectada. Un aviso en el cliente del operador no prueba un fallo en el servidor. Distinguir cuota, capacidad temporal del modelo, autenticación y red; no inventar una hora de reset.
2. Activar **En pausa / Hold** en Command Center para retener entregas automáticas. Verificar `autoDeliveryPausedAgents` y el estado del control. Hold persiste; el bloqueo de herramientas y Halt son controles en memoria y deben comprobarse de nuevo tras reiniciar.
3. Guardar `roster.json`, colas, `hive/registry.json`, `hive/tasks.json`, memoria, historiales y cambios sin commit en las carpetas reales. Hacer backup consistente de SQLite mediante su API y comprobarlo. Conservar estas copias en almacenamiento privado, fuera del repo y del vault. Una copia de archivos en vivo no equivale a una instantánea atómica del conjunto.
4. Identificar los procesos del piso antes de detenerlos. El número de procesos Claude del host puede incluir sesiones ajenas a la oficina. Preservar los trabajos antes de sustituir el PTY afectado.

## Comprobar GPT y cambiar el motor

1. En la cuenta Windows que ejecuta la oficina, consultar `codex --version` y `codex login status`. No mostrar ni copiar credenciales al chat. El perfil aislado de cada agente también debe autenticar correctamente; comprobar sólo la cuenta global no prueba todos los perfiles.
2. Ejecutar un smoke sintético acotado, sin herramientas ni datos operativos, usando el modelo elegido. Solicitar autenticación ChatGPT explícita si se quiere usar la suscripción. La API tiene facturación separada. Ver [autenticación oficial de Codex](https://learn.chatgpt.com/docs/auth).
3. En **Command Center → Monitor**, elegir **Codex · GPT → GPT-5.6 Sol** para un worker piloto. En el gerente, usar el selector de motor y aplicar. Una selección guardada sólo acredita configuración: verificar también proceso, nueva sesión y modelo observado.
4. Resolver el diálogo inicial de confianza sólo para la carpeta de trabajo identificada. Un terminal esperando esta confirmación todavía no está operativo. Comprobar de nuevo el arranque tras reiniciar: la configuración del home aislado se regenera y no debe suponerse que toda preferencia local sobrevivió.
5. Cambiar los demás workers secuencialmente, comprobando cada resultado. Mantener Hold y detener la ejecución en el siguiente límite de hook mientras se revisan los encargos pendientes.

El selector del monitor sustituye el proceso y persiste el modelo tras un spawn exitoso. **Edit Agent**, `roster.json` o `registry.json` por sí solos no cambian un proceso vivo. Un cambio Claude → Codex abre una conversación nueva; conserva identidad y archivos, pero no transfiere automáticamente la conversación de Claude.

## Reanudar trabajo

- Comparar los IDs del ledger y de las colas con la captura anterior. Revisar también los mensajes que ya salieron de la cola pero carecen de resultado confirmado.
- Preparar un checkpoint mínimo: objetivo, carpeta, archivos modificados, último paso comprobado, siguiente paso y operaciones de resultado desconocido. Evitar cuerpos de correo, datos de clientes y secretos.
- Ante un pago, envío, pedido o cambio remoto sin acuse, reconciliar con su sistema autoritativo antes de repetir. Cambiar de modelo no resuelve la incertidumbre sobre un efecto externo.
- Reanudar primero un trabajo acotado y comprobar su resultado. Liberar herramientas y entregas conscientemente; un terminal abierto o un estado `idle` no acredita éxito.

## Comprobación visual

En Monitor deben coincidir agente, proveedor y modelo; el control de pausa debe reflejar la retención. Al abrir el terminal, comprobar que no quedó un diálogo de confianza/login ni un error de cuota. Las tareas interrumpidas conservan sus IDs y estado pendiente/bloqueado hasta disponer de evidencia de cierre.

## Límites actuales

El drenaje puede interpretar silencio como disponibilidad y no clasifica específicamente la cuota del proveedor. Hold corta la entrega automática, pero no sustituye un mecanismo durable de detección de cuota, límite de intentos y reconciliación. El plan incorpora esas capacidades antes de promover automatizaciones de LID. No existe garantía de disponibilidad permanente por cambiar una suscripción por otra.
