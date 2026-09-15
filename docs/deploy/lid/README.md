# LID-0 — inventario comprobable

Primera entrega del [plan LID-0…LID-9](../../superpowers/plans/2026-09-15-lid-workspace-terminal.md). Los constructores son agentes GPT-5.6; la revisión de código corresponde a GPT-6 Astra. Cada fase tendrá evidencia visual, pruebas y un dictamen con alcance explícito antes de pasar a la siguiente.

Alex precisó la topología: **Xeon es el laboratorio doméstico; KVM4 es el VPS de producción de Licencia Digital**. Un piloto en Xeon no demuestra continuidad durante un apagón de la casa. La oficina y la terminal serán clientes de lectura/control; el motor remoto tendrá su propio ciclo de vida.

Esta entrega aporta un generador de informes estáticos y sondas de inventario. No instala Hermes Workspace, no añade automatizaciones, no inicia agentes operativos y no cambia la oficina. El inspector, las banderas, el ledger y el bucle gráfico del producto no se modifican en LID-0.

## Revisar visualmente

El informe real se genera en una carpeta privada, con una copia en el respaldo. El fork es público: aquí sólo hay código, documentación técnica y un ejemplo **sintético**. No publicar JSON ni capturas de producción.

```powershell
python tools/deploy/lid/report.py `
  --evidence tools/deploy/lid/fixtures `
  --output "$env:TEMP/lid-0-example.html"
```

Para la captura real, sustituir la entrada por el directorio privado de observaciones. Revisar la franja `CAPTURA / NO MONITOR EN VIVO`, las fechas por registro, los filtros, los detalles, los desconocidos y el alcance del dictamen Astra. La [guía visual](visual-review.md) explica los estados y las pruebas.

## Criterio para avanzar

- Cada disparador tiene una autoridad técnica documentada. Los campos sin comprobante permanecen desconocidos; una ejecución técnica no prueba un efecto de negocio.
- Los respaldos incluyen trabajo sin commit, configuración y colas. Se comparan hashes en otro equipo y se restaura una muestra aislada. La memoria de los procesos y el trabajo posterior a la captura quedan fuera.
- Las [versiones candidatas](compatibility.md) se distinguen de una instalación comprobada. El lock del paquete se crea en LID-1; la compatibilidad operativa se valida en el piloto.
- La aceptación del código del informe no aprueba estabilidad del servidor, continuidad frente a apagones ni nuevas escrituras en producción.

La CI de esta entrega ejecuta regresiones del informe, cobertura mínima del 80%, validación del ejemplo sintético y pruebas de saneamiento de las sondas. No usa SSH, credenciales ni datos operativos. Un push o una CI verde no son un despliegue.
