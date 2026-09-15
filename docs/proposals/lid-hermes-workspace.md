# Propuesta: workspace LID representado por su gerente

2026-09-15. Propuesta visual solicitada por Alex; no integra ni modifica servicios. La aclaración de Alex es **Hermes Workspace con varios agentes y su gerente conectado a la oficina visual de Lex Laboratory**. Esto afina la propuesta anterior de una CLI general para Munder.

## Composición propuesta

```text
OFICINA LEX LABORATORY                 TERMINAL / SSH
      Gerente LID                         Consola LID
           \                                 /
            +-- adaptador de estado/encargos -+
                            |
                 HERMES WORKSPACE / LID
                 Gerente: Lidia (propuesto)
                      /     |     \
                   Correo Pedidos Soporte
                      \     |     /
                  Herramientas y API de LID
```

Workspace organiza el equipo; Hermes Agent ejecuta los trabajos. El gerente recibe objetivos, distribuye tareas y agrega resultados con evidencia. En la oficina aparece un avatar para el gerente; su inspector muestra equipo, bloqueos y origen/fecha de cada lectura. Lidia como gerente es una recomendación, no un cambio aplicado a su identidad ni a su despliegue.

La terminal ofrece cuatro vistas: Trabajo, Agentes, Agenda y Hablar con Lidia. Tres presentaciones: paneles para escritorio, compacta para ventanas estrechas y ASCII simple para conexiones básicas. El prototipo `lid-terminal-concept.html` es un HTML autocontenido para revisar la propuesta en navegador, **no una TUI ejecutable**. No usa modelos, servidores externos ni datos de clientes; todos los ejemplos están identificados como sintéticos. `lid-terminal-concept.png` es una captura de la vista de equipo.

## Qué conviene reutilizar

El [repositorio de Hermes Workspace](https://github.com/outsourc-e/hermes-workspace) documenta Swarm con orquestador, workers persistentes sobre tmux, checkpoints y una vista TUI para acceder a workers. Su vista TUI no acredita que nuestro panel de resumen ASCII ya exista. La [agenda de Hermes Agent](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron) se ejecuta en el gateway y admite servicio. La versión instalada de LID debe verificarse antes de atribuirle esas capacidades actuales.

El vault contiene el antecedente de un workspace LID y de un adaptador de su estado hacia la oficina. Es evidencia histórica de la dirección original, no prueba de que hoy siga conectado. No se hicieron conexiones SSH ni cambios productivos en esta sesión de propuesta.

Para una consola nueva, [Textual](https://textual.textualize.io/getting_started/) es un candidato: corre en Windows, Linux y macOS; su documentación recomienda Windows Terminal. Sugerencia inicial: Windows Terminal en GPD/Xeon y ejecución de la TUI en el servidor por SSH. PowerShell es el shell; Windows Terminal es el emulador. Usar texto/ANSI y bordes sencillos, con alternativa sin color ni caracteres especiales. La compatibilidad de la implementación final debe probarse: la maqueta sólo se verificó en Chrome.

## Contrato de la conexión

- **Estado:** workspace, gerente y worker con identificadores estables; tarea, estado observado, fuente, fecha de captura, última ejecución confirmada y disponibilidad. Ausente/caducado/desconectado no equivale a cero, idle ni healthy.
- **Trabajo:** registro operativo compartido como fuente; las proyecciones gráficas y el resumen del gerente no sustituyen resultados de herramientas/API. Consulta completada no equivale a pedido pagado o licencia entregada.
- **Encargos:** un identificador por solicitud y acuse durable. Aceptado, iniciado, bloqueado y completado son distintos. Reconciliar efectos externos ambiguos antes de reintentar.
- **Interfaz:** el inspector conserva lectura solamente. Para enviar un encargo desde la oficina, abrir el flujo existente de comandos y mostrar exactamente qué solicitud se enviará. La maqueta no implementa ese envío ni activa la fase 7.
- **Agenda:** una autoridad por automatización. Migrar la tarea de la agenda anterior al workspace coordinadamente, conservando pendientes; no dejar dos disparadores para el mismo chequeo.
- **Autonomía:** servicio fuera del PC del operador, almacenamiento persistente, checkpoints y supervisión. tmux conserva contexto al desconectar SSH; no salva memoria ante caída del host. Si el servidor comparte el apagón, el problema sigue.
- **Costo:** agentes especializados, activados por eventos o agenda; limitar concurrencia y usar scripts para comprobaciones deterministas. Ningún bucle de razonamiento permanente por cada bandeja vacía. Eliminar la oficina gráfica reduce la carga del render, no el costo de inferencia de los agentes.

## Orden recomendado

1. Medir el workspace/runtime existente y sus tareas, herramientas, permisos, persistencia y recursos. No crear otra instalación ni actualizar a ciegas.
2. Conectar al gerente en lectura a la oficina; comprobar frescura, error y desconexión. Mantener la operación actual mientras se compara contra su fuente.
3. Adaptar la consola de terminal al mismo origen; validar escritorio, SSH y desconexión del cliente.
4. Migrar primero una automatización de bajo impacto, con prueba de recuperación y sin agenda duplicada; ampliar a los demás roles tras verificar resultados.

## Verificación de la maqueta

Chrome headless local: selección de operaciones y evidencia, cuatro agentes propuestos, navegación por teclado, estado antiguo al desconectar, vista ASCII, conversación de guion, presentación compacta y ancho móvil390px sin desbordamiento. Cero errores JS y cero solicitudes HTTP externas. Cinco capturas y constancia en `audit-results/lid-terminal-concept/verification.json`. Inspección visual de la captura de equipo realizada. Autoevaluación de composición: consola de selección/inspección, sin métricas ornamentales, gráficos animados ni tarjetas de marketing; el indicador lateral marca selección real. No mide consumo de una TUI ni disponibilidad productiva.
