# Preparación y verificación de Coluvi RC2

Este bloque ejecuta el plan de diez horas autorizado después de la RC1. El objetivo es preparar un ensayo reproducible con el Samsung S26 Ultra y el A54, sin requerir esos dispositivos durante el desarrollo. La RC1 publicada es `coluvi-simulacro-20261004-rc1`; no se cuentan sus funciones como entregables nuevos. RC2 sigue en desarrollo y no está calificada para entrega.

## Alcance y criterios de salida

| Bloque | Presupuesto orientativo | Evidencia requerida | Estado |
|---|---|---|---|
| Preparación guiada del piloto | 1 h | Configuración, base, certificado y conexión opcional con resultados separados; sin secretos, cambios de red ni falsas afirmaciones de acceso Android | Preflight implementado; pruebas HTTP, HTTPS y fallos aprobadas |
| Diagnóstico de la PWA | 2 h | Estados de cola, última confirmación, almacenamiento cuando esté disponible, consulta de servidor y exportación sin reportes ni identificadores; comprobación en navegador offline y conectado | Implementado; pruebas unitarias y Chromium integrado aprobados: tres reportes guardados, dos pendientes durante el corte y tres confirmados al reconectar; exportación sin valores privados verificada |
| Simulacros repetibles | 2 h | Escenarios ficticios con cortes intermitentes, llegada tardía, cambios, avisos vencidos y no respuesta; cronología y comparación entre esperado y observado | Seis escenarios implementados y verificados, incluidos cambios fuera de orden; ejecutor con directorio exclusivo, informe, cronología, semilla, procedencia y cancelación |
| Carga mixta | 2 h | Reproducción instrumentada del límite observado con 990 dispositivos; mapa, avisos y respuestas concurrentes; causa y corrección verificadas o límite reproducible documentado | Perfiles aprobados con 30, 300 y 990 dispositivos; corregido el actor ante 429 privado. El timeout de RC1 no se reprodujo y su causa sigue sin establecerse |
| Continuidad del cliente | 1,5 h | Cierre abrupto del navegador, actualización con cola pendiente y fallos de almacenamiento; no afirmar guardado cuando falla una escritura | Verificada en Chromium con archivos RC1 reales, SIGKILL del navegador, reapertura sin servidor, actualización v10 a v12 y fallos inyectados de IndexedDB |
| Calificación y entrega | 1,5 h | Suite, navegador, reproducción limpia, documentación reconciliada, paquete de ensayo físico y versión identificada en GitHub | Pendiente |

Además se requiere una ejecución sostenida de al menos tres horas de tiempo real sobre una versión fija, con datos desechables y resultados persistidos. Comenzó el 5 de octubre de 2026 aproximadamente a las 03:05 UTC (21:05 del día 4 en Ciudad de México), sobre una copia limpia de `c7f6ce9864e84435153e7639d503192256ea82d4`. Sigue en curso; no tiene resultado aprobado. No se sustituirá por tiempo virtual ni por sumar varias ejecuciones breves. Coincide parcialmente con mediciones de carga mixta, lo que debe tenerse en cuenta al interpretar los tiempos.

Si los bloques terminan antes, el orden adicional es ampliar semillas y ciclos de recuperación, comprobar accesibilidad y pantallas pequeñas y preparar capturas del simulacro. Se reserva siempre la calificación final. El presupuesto es una estimación, no una garantía de resolver cualquier fallo dentro de diez horas.

## Evidencia del primer hito

Las cinco pruebas de operaciones y las doce pruebas seleccionadas de diagnóstico, idiomas y caché aprobaron. Chromium integrado aprobó el diagnóstico offline, la exportación local, la recuperación de conexión y las regresiones de mapa, avisos, necesidades, estados y revocación. La cola del escenario contiene un reporte general histórico confirmado y dos reportes operativos nuevos; el diagnóstico debe contar los tres.

La primera suite completa de este bloque excedió el límite de 120 segundos en la prueba existente de treinta ciclos deterministas repetidos. El proceso del simulador continuó trabajando después de que el ejecutor declarara el timeout. No se modificó ese límite y esa ejecución no se considera aprobada. Las repeticiones y la corrección de cancelación se documentan a continuación. Este hito de diagnóstico no es una RC2 calificada.

La repetición aislada de esa prueba, todavía sin modificarla, aprobó en 55,9 segundos. La ejecución completa anterior terminó con 207 aprobadas y una cancelada, en 189,6 segundos; coincidió parcialmente con pruebas de Chromium. Esto muestra sensibilidad a las condiciones de ejecución, pero no establece por sí solo la causa del timeout. Se añadió respeto a la señal de cancelación para detener el trabajo y cerrar sus almacenes cuando el ejecutor interrumpa la prueba. El límite sigue siendo 120 segundos.

La siguiente suite completa, sin Chromium concurrente, aprobó las 212 pruebas en 72,7 segundos, sin fallos, cancelaciones ni omisiones. La prueba de treinta ciclos repetidos tardó 70,5 segundos. Este resultado valida el hito de diagnóstico y simulacros, no los bloques pendientes de RC2.

## Ejecutar simulacros con cronología

```bash
node scripts/rehearse-coluvi.mjs /tmp/coluvi-ensayo-nuevo 20261004
```

El destino debe ser nuevo. `rehearsal.json` contiene seis escenarios, semilla, commit de base, huella del código, duración real de ejecución y checkpoints con `expected`, `observed` y `status`. `progress.jsonl` conserva inicio y fin de cada escenario. Un resultado `FAIL`, una interrupción o un cambio de código durante la ejecución impide declarar aprobado el ensayo. El informe fallido no se convierte en un resultado completo. No se sobrescriben ejecuciones anteriores.

Los actores usan firmas y almacenes SQLite reales con tiempo virtual. Se comprueban dos cortes con cola persistida, respuesta tardía que cambia UNKNOWN, enriquecimiento de ayuda seguido de SAFE, vencimiento de avisos, destinatarios que no responden y entrega del sucesor antes del antecedente. Cada escenario conserva historial tras reabrir los almacenes y comprueba deduplicación. Los acuses SHOWN los crea el actor simulado: no demuestran que una persona haya leído el aviso. La prueba de presentación real en navegador es independiente.

Las cuatro pruebas de `tests/coluvi-rehearsal.test.ts` verifican escenarios, repetición, parámetros, cancelación y rechazo de destinos existentes o UbuntuPreview. La primera ejecución CLI aprobó los seis escenarios, con `sourceUnchanged: true`, en `/tmp/coluvi-rc2-rehearsal-20261004-01/rehearsal.json`. Su tiempo virtual no cuenta para las tres horas sostenidas que todavía no han terminado.

## Continuidad y recuperación del cliente

`examples/mobile-continuity-smoke.mjs` sirve los archivos reales de la etiqueta RC1 desde Git, guarda un reporte, detiene el acceso al servidor y termina el grupo de procesos de Chromium mediante SIGKILL. Abre después el mismo perfil sin servidor y comprueba que el paquete firmado permanece idéntico. Tras restaurar el acceso, actualiza el service worker de v10 a v12 y carga los archivos nuevos sin perder la cola. Requiere la etiqueta RC1 disponible localmente; las copias limpias deben incluir las etiquetas. La primera verificación usó v11; se repitió correctamente con v12 después de corregir el diseño con texto ampliado.

La prueba inyecta `QuotaExceededError` y abortos de transacciones IndexedDB. Comprueba que se conserve el borrador, que el reporte anterior permanezca intacto y que no aparezca un reporte falsamente guardado. También inyecta un fallo de lectura después de confirmar el guardado: la interfaz distingue ese caso de un fallo al guardar. Finalmente impide persistir un acuse de backend; el siguiente envío recibe una respuesta de duplicado, guarda su confirmación y mantiene exactamente dos reportes únicos en el servidor. Al recuperarse desaparece el aviso de error obsoleto.

Se corrigió además la sincronización de reportes que podía esperar indefinidamente una respuesta: el límite por petición es de diez segundos e incluye la lectura del cuerpo. Las pruebas con HTTP real que no entrega cabeceras o deja el cuerpo incompleto conservan el paquete sin inventar confirmación. Los fallos inyectados no equivalen a llenar un disco físico, y el cierre del navegador no equivale a cortar energía a la computadora. El actor de continuidad usa sincronización manual y desactiva background sync para controlar los puntos de fallo; su funcionamiento ordinario se verifica por separado.

La suite completa después de estos cambios aprobó 215 pruebas en 78,2 segundos, sin fallos, cancelaciones ni omisiones. El recorrido de continuidad en Chromium aprobó también; todavía faltan la carga grande y la ejecución sostenida para cerrar RC2.

## Carga mixta instrumentada

```bash
node examples/coluvi-mixed-load.mjs /tmp/coluvi-carga-mixta-nueva 300 24 20261005
```

Este perfil conserva las firmas, límites de admisión, confirmaciones correlacionadas, entrega fuera de orden, dos cortes SIGKILL y reenvío completo de la carga anterior. Añade seis lectores concurrentes de salud, mapa, panel, avisos y bandejas móviles, con una pausa de 100 ms entre consultas por lector. Emite tres avisos por la API del operador y comprueba que permanezcan disponibles tras reiniciar. No afirma que alguien los haya leído ni mide inscripción HTTP masiva.

El informe separa peticiones y errores por endpoint, latencia hasta cabeceras, tiempos completos de envíos aceptados y esperas por admisión. El proceso de servidor instrumentado envía CPU, memoria y retraso del bucle de eventos solo a su padre por IPC, sin exponer otro endpoint público. El destino es exclusivo y el informe identifica el código mediante commit, estado del árbol y SHA-256. Un fallo conserva un informe fallido con los contadores disponibles; no acredita capacidad. El ensayo inicial de 30 dispositivos aprobó, pero no reemplaza la medición de 990.

El primer perfil mixto de 300 dispositivos, sobre una copia limpia del commit `2623d1b`, terminó como fallo tras 69,2 segundos: había observado 810 confirmaciones únicas, pero una lectura de avisos recibió 429. El máximo de retraso del bucle de eventos observado fue 351,3 ms; ese resultado no reproduce el timeout de diez segundos de la RC1. La API privada tiene límites independientes de la ingestión: 600 solicitudes globales y 120 por dirección de origen por minuto. Los lectores del fixture compartían una dirección y trataban 429 como fallo inmediato. Se corrigió el actor para respetar `Retry-After` compartido entre esas consultas, sin aumentar presupuestos ni timeouts del servidor. El informe fallido permanece en `/tmp/coluvi-rc2-mixed-300-20261005-01/mixed-load-failed.json` y no debe presentarse como una ejecución completa aprobada.

La repetición mixta de 300 dispositivos aprobó sobre `c7f6ce9`, con árbol limpio y código sin cambios. El [informe completo](coluvi-mixed-300-20261005.json) registra 810 paquetes únicos, 810 duplicados del reenvío, dos auditorías de persistencia correctas y 2.523 lecturas exitosas. Se respetaron 48 rechazos de ingestión y cinco de API privada; seis lecturas interrumpidas corresponden al corte deliberado, sin lecturas inesperadamente fallidas. Duró 136,83 segundos; las solicitudes exitosas tuvieron mediana de 60,16 ms, percentil 95 de 415,55 ms y máximo de 2.337,18 ms. El máximo observado de RSS fue 125,3 MiB y el retraso máximo del bucle de eventos, 816,84 ms. Coincidió con el inicio del ensayo sostenido. No reprodujo el timeout previo de diez segundos ni establece su causa.

El [perfil mixto de 990](coluvi-mixed-990-20261005.json), sobre la misma copia limpia, también aprobó: 2.673 paquetes únicos conservados, 2.673 duplicados del reenvío y 9.677 lecturas exitosas. Hubo 384 rechazos de ingestión, 22 de API privada y seis lecturas interrumpidas por el corte planificado; ninguna lectura inesperadamente fallida. Duró 534,82 segundos. Las solicitudes exitosas tuvieron mediana de 111,85 ms, percentil 95 de 664,50 ms y máximo de 4.609,82 ms. El máximo RSS fue 134,6 MiB y el retraso máximo del bucle de eventos, 879,76 ms. Coincidió con la observación sostenida y, hacia el final, con comprobaciones visuales breves. Esto demuestra las invariantes de esa ejecución, no capacidad garantizada bajo cualquier carga del equipo. No hubo timeout de diez segundos: su causa original sigue abierta y no debe atribuirse al 429 del actor.

## Ensayo sostenido con tiempo real

```bash
node scripts/soak-coluvi.mjs /tmp/coluvi-observacion-nueva 10800 30
```

El comando crea una observación de al menos 10800 segundos reales, con treinta dispositivos ficticios en tres zonas. Emite solicitudes y avisos por HTTP, recibe acuses firmados de recepción, intercala estados y necesidades, verifica proyecciones y consulta salud y mapa. Alterna entregas ordenadas y fuera de orden. Cada veinte rondas termina el backend temporal con SIGKILL entre rondas, verifica todos los reportes confirmados en SQLite y reenvía la ronda más reciente como duplicados después de arrancar otra vez. No equivale a matar el cliente ni a cortar energía física.

`progress.jsonl` guarda las rondas completadas, tiempo observado, conteos, tamaño de base y métricas del servidor. `soak.json` solo se escribe al completar el periodo y la auditoría final con el código sin cambios; `qualifiesThreeHours` diferencia explícitamente un ensayo corto de la observación requerida. Una interrupción o fallo produce `soak-failed.json`, nunca un aprobado. La duración solicitada es mínima: se completa la ronda en curso y se respetan esperas de admisión antes de cerrar. No se cuentan ventanas virtuales del simulador.

Las pruebas cortas verifican reinicios, conservación byte a byte de reportes firmados, deduplicación, avisos y rechazo de parámetros o cancelación. La inscripción inicial se provisiona directamente en la base de prueba; no mide inscripción masiva. Los acuses son RECEIVED, no SHOWN ni atención humana. Los límites por origen se conservan, por lo que las esperas del cliente forman parte del tiempo observado. La ejecución de tres horas está en curso en `/tmp/coluvi-rc2-soak-3h-20261005-01`; los registros parciales no equivalen a su resultado final.

El ensayo previo del comando, solicitado con mínimo de cinco segundos y treinta dispositivos, completó su primera ronda en aproximadamente 61 segundos al respetar el límite de API privada. Confirmó 81 paquetes y terminó como PASS con `qualifiesThreeHours: false`. Su informe está en `/tmp/coluvi-rc2-soak-preflight-20261005-01/soak.json`. La calificación incluye este ensayo breve, pero exige tratar por separado el informe de tres horas.

## Pantallas pequeñas y texto ampliado

```bash
COLUVI_CHROMIUM_PATH=/ruta/al/chromium \
  node examples/mobile-readiness-smoke.mjs /tmp/coluvi-pantallas-nuevas
```

Se verifican doce combinaciones: 320, 360 y 412 píxeles CSS, español e inglés y texto raíz al 100 % y 200 %. Cada caso abre un documento nuevo, despliega inscripción y diagnóstico, abre el formulario de recursos, comprueba nombres accesibles, botones y desplegables de al menos 44 píxeles, foco y retorno con Escape, y ausencia de desbordamiento horizontal. Conserva el informe y dos capturas ficticias; no escribe reportes ni usa el piloto real.

La comprobación aislada inicial confirmó que las seis combinaciones con texto al 200 % desbordaban la pantalla. Se corrigieron títulos flexibles, mínimos de formularios, campos de necesidades y ajuste de textos largos, sin ocultar contenido ni reducir su tamaño. Las doce combinaciones aprobaron después en `/tmp/coluvi-rc2-readiness-20261005-07/readiness.json`; también se inspeccionaron las capturas. La caché pasa a v12 para distribuir esos estilos. La calificación integrada incorpora esta prueba.

La emulación no equivale a TalkBack, a la escala de texto del sistema Android ni a una auditoría completa de WCAG. La observación sostenida sigue en su copia inmutable `c7f6ce9`: estos cambios posteriores afectan la PWA y sus pruebas, no los módulos del backend ni el ejecutor de observación. La entrega debe identificar ambas procedencias y calificar de nuevo la PWA modificada.

## Restricciones operativas

Todo se ejecuta en Ubuntu WSL2, nunca UbuntuPreview. Los ensayos usan directorios y procesos temporales propios. No se reemplazan datos del piloto, claves, certificados ni servicios ajenos. No se modifica el firewall ni se instala confianza TLS global. No se contratan servicios, crean cuentas, publican despliegues ni presentan solicitudes.

La aplicación nativa y Bluetooth, Bitchat o LoRa físicos quedan para otra etapa. Las pruebas automatizadas no demuestran accesibilidad real desde Android, consumo de batería, recepción con la aplicación suspendida ni capacidad de atención humana. El ensayo físico posterior debe registrar esos límites y los fallos observados.
