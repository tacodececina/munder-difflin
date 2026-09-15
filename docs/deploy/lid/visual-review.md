# LID-0 — revisión visual de evidencia de inventario

Este panel es una captura HTML estática para revisar evidencia de LID-0. No es un monitor, no consulta red, no ejecuta comandos y no acredita que un host esté listo para producción. `verified` significa únicamente que el recolector observó el dato indicado en la fecha de ese registro.

## Generar la captura

Desde la raíz del repositorio:

```powershell
python tools/deploy/lid/report.py `
  --evidence C:/ruta-privada/lid/evidence `
  --output .artifacts/lid/lid-0-inventory.html
```

El directorio puede contener varios archivos `.json`. El generador los ordena por nombre, valida todos antes de escribir y rechaza documentos corruptos, campos inesperados, fechas sin zona UTC e IDs repetidos entre archivos. Si el directorio falta o no contiene JSON, genera una captura marcada `SIN EVIDENCIA CARGADA / PENDIENTE`; no presenta ceros ni un resultado satisfactorio.

El fork es público. Las observaciones y capturas reales se conservan fuera de Git; la carpeta de evidencia local y los informes operativos están excluidos expresamente. Para probar sin datos operativos, use `--evidence tools/deploy/lid/fixtures`: contiene únicamente un ejemplo marcado sintético. La CI ejecuta ese ejemplo y las regresiones; no se conecta a los servidores.

Un error de evidencia termina con código 2 y no crea ni reemplaza el archivo de salida. Un error al escribir termina con código 3. La salida exitosa usa código 0, incluso para el estado vacío explícito, porque describe una generación válida y no una aceptación de inventario.

## Contrato de entrada

Cada archivo usa el entero `schemaVersion: 1`, `collector: "GPT-5.6-sol"` o `collector: "GPT-6-Astra"`, `scope: "LID-0 inventory"`, `collectedAt` ISO UTC y un arreglo `records`. El panel conserva y muestra recolector, archivo y fecha del documento junto con la fecha observada de cada registro. Rechaza observaciones posteriores a la recolección y fechas de recolección adelantadas más de cinco minutos respecto al reloj UTC del generador. Cada registro requiere:

```text
id, title, category, host, status,
observedAt, source, summary, details, limitations, remeasure
```

`status` admite `verified`, `unknown` o `blocked`. `details` es un objeto JSON y conserva `null`; el panel lo muestra como `Desconocido (null)`. No convierta ausencia en `0`, vacío, sano o completado. El recolector debe aplicar listas de campos permitidos antes de crear el JSON. Como defensa adicional y acotada, el generador rechaza recursivamente claves de detalle llamadas `password`, `api_key`, `raw_env`, `body` o `prompt`; esto no es DLP general ni garantiza detectar un secreto con otro nombre. El contenido aceptado se escapa para HTML y nunca se inserta mediante `innerHTML`.

Las fuentes o instrucciones parecidas a comandos se muestran como texto. Revisarlas en el panel no las ejecuta. No incluya tokens, contraseñas, cuerpos de correo ni datos de clientes.

## Lista de revisión

1. Confirme que la franja superior dice `CAPTURA / NO MONITOR EN VIVO`.
2. Compare los archivos enumerados y el número de registros con la entrada esperada.
3. Filtre por host, ID, categoría y estado usando teclado; el contador debe cambiar.
4. Abra `Ver detalle, límites y remedición` y compruebe fecha propia, fuente, limitaciones y forma de volver a medir.
5. Verifique que `verified` no se interpreta como disponibilidad actual ni preparación para producción.
6. Trate estados desconocidos, bloqueados y ausencia de evidencia como pendientes.
7. Mantenga la auditoría de Astra 6 en pendiente hasta que exista su entrega independiente. Sólo el registro `id: "astra6-lid0-code-review"`, `category: "audit"`, recolectado por `GPT-6-Astra`, puede cambiar ese bloque. Requiere `details.verdict` (`approved` o `request_changes`), `details.auditorModel: "gpt-6-astra"` y uno o más `reviewedFiles` con `path` y SHA-256. El resultado acredita únicamente esos hashes, no el resto del repositorio. Un constructor GPT-5.6 no puede suplirlo.

El campo `collector` es una atribución del documento, no autenticación criptográfica. El responsable debe comprobar el modelo real de la sesión revisora y los hashes revisados antes de emitir ese registro. Una captura anterior conserva su dictamen fechado; no certifica modificaciones posteriores del código.

## Pruebas

```powershell
python -m unittest discover -s tools/deploy/lid -p 'test_report.py' -v
python -m coverage run --branch --source tools/deploy/lid -m unittest discover -s tools/deploy/lid -p 'test_report.py'
python -m coverage report --include='*/tools/deploy/lid/report.py' --fail-under=80
```

La segunda y tercera orden requieren `coverage` disponible en el Python usado. No es necesario instalar dependencias del producto para generar ni probar el panel.
