# Auditoría de código LID-0 — GPT-6 Astra

2026-09-15. Constructores: GPT-5.6. Revisor: GPT-6 Astra, comprobado contra el modelo de la sesión, no contra el modelo predeterminado del equipo.

**Dictamen: aprobadas las herramientas de inventario y el informe estático tras las correcciones siguientes.** El registro privado del dictamen conserva los SHA256 de los archivos revisados. Esta aprobación no acredita el resto del repositorio, compatibilidad del piloto, efectos de negocio ni producción desplegada.

## Hallazgos corregidos leyendo el código

- Se eliminó la conversión de colas ausentes o inaccesibles en conteos cero. Ausencia es `exists:false, count:null`; los errores de lectura fallan.
- La sonda Windows rechazaba listas válidas vacías y de un elemento por desempaquetado de PowerShell. La primera prueba copiaba la proyección y pasaba sin probar el helper real. Se reprodujo el fallo con la función extraída del código y se corrigió; el self-test ahora ejecuta esas funciones reales.
- Se proyectan campos de agenda y nombres de remotos; no URLs con credenciales, argumentos de procesos ni cuerpos operativos. Las macros cron y URLs con userinfo tienen regresiones sobre el saneador compartido real.
- Se corrigieron fechas/esquema inconsistentes, números JSON no finitos y tipos de estado inválidos. El informe conserva `null`, fecha y procedencia por registro; ningún éxito de lectura refresca datos viejos.
- La aprobación de Astra dejó de ser un texto fijo. Se deriva de un registro reservado con estado, autor, dictamen y hashes explícitos. Su atribución no es una firma criptográfica.
- Los inventarios privados distinguen hash de script frente a hash de estado, pertenencia a otra aplicación, agenda configurada frente a ejecución y fin técnico frente a efecto externo.
- Se añadió CI para las pruebas nuevas. Las observaciones reales quedan privadas; CI sólo usa datos sintéticos y no se conecta a servidores.

## Comprobaciones y límites

El informe pasa 19 regresiones y alcanza 86% de cobertura combinada de líneas/ramas. El saneador compartido alcanza 82%. El self-test Windows distingue arrays de 0/1/2 elementos, rechaza missing/null/escalar y distingue cola ausente de vacía. También se verificaron sintaxis Python, PowerShell y Bash.

La comprobación de Munder pasó build, tipos, lint sintáctico y 1,507 pruebas; dos pruebas preexistentes requieren shell POSIX y se omiten en Windows. Estos resultados describen el working tree revisado con su overlay preservado, no un despliegue de un commit limpio.

Chrome/Playwright comprobó escritorio y móvil: filtro, contador, teclado, detalles, ausencia de desbordamiento horizontal y cero solicitudes externas, WebSockets, intervalos y llamadas a `requestAnimationFrame` del informe. El producto no importa las herramientas nuevas; no se añadieron recursos al bucle de la oficina ni se alteraron inspector o controles de escritura.

No se interpretó `healthy`, `active`, un heartbeat ni una ejecución `completed` como efecto de negocio. Los reinicios de un launcher de montaje se investigaron como ese componente; no se modificó otro motor basándose en el nombre del servicio.

La auditoría npm sigue registrando alertas heredadas, detalladas en el informe privado. Su resolución requiere una actualización aislada del conjunto Electron/tooling/túneles y pruebas de ABI, permisos y rutas alcanzables. Esta fase no cambia dependencias del producto ni concede una aprobación de seguridad global. Las versiones del futuro paquete LID sólo son candidatas hasta pasar smoke, lock y auditoría propios.
