# Preparación y verificación de Coluvi RC2

Este bloque completa el plan autónomo autorizado después de la RC1. La versión de software `coluvi-simulacro-20261005-rc2` queda preparada para el ensayo con el Samsung S26 Ultra y el A54: 231 pruebas, ocho etapas de calificación y una observación real de más de tres horas, con sus límites documentados. La RC1 publicada es `coluvi-simulacro-20261004-rc1`; no se cuentan sus funciones como entregables nuevos. Las pruebas físicas, la aplicación nativa y la postulación siguen pendientes.

## Alcance y criterios de salida

| Bloque | Presupuesto orientativo | Evidencia requerida | Estado |
|---|---|---|---|
| Preparación guiada del piloto | 1 h | Configuración, base, certificado y conexión opcional con resultados separados; sin secretos, cambios de red ni falsas afirmaciones de acceso Android | Preflight implementado; pruebas HTTP, HTTPS y fallos aprobadas |
| Diagnóstico de la PWA | 2 h | Estados de cola, última confirmación, almacenamiento cuando esté disponible, consulta de servidor y exportación sin reportes ni identificadores; comprobación en navegador offline y conectado | Implementado; pruebas unitarias y Chromium integrado aprobados: tres reportes guardados, dos pendientes durante el corte y tres confirmados al reconectar; exportación sin valores privados verificada |
| Simulacros repetibles | 2 h | Escenarios ficticios con cortes intermitentes, llegada tardía, cambios, avisos vencidos y no respuesta; cronología y comparación entre esperado y observado | Seis escenarios implementados y verificados, incluidos cambios fuera de orden; ejecutor con directorio exclusivo, informe, cronología, semilla, procedencia y cancelación |
| Carga mixta | 2 h | Reproducción instrumentada del límite observado con 990 dispositivos; mapa, avisos y respuestas concurrentes; causa y corrección verificadas o límite reproducible documentado | Perfiles aprobados con 30, 300 y 990 dispositivos; corregido el actor ante 429 privado. El timeout de diez segundos se reprodujo dos veces al añadir la calificación concurrente; la misma semilla aprobó sin ella. Causa interna no aislada |
| Continuidad del cliente | 1,5 h | Cierre abrupto del navegador, actualización con cola pendiente y fallos de almacenamiento; no afirmar guardado cuando falla una escritura | Verificada en Chromium con archivos RC1 reales, SIGKILL del navegador, reapertura sin servidor, actualización v10 a v12 y fallos inyectados de IndexedDB |
| Calificación y entrega | 1,5 h | Suite, navegador, reproducción limpia, documentación reconciliada, paquete de ensayo físico y versión identificada en GitHub | Ocho etapas y 231 pruebas aprobadas; evidencia de tres horas y cronología verificadas; guía Samsung y versión `coluvi-simulacro-20261005-rc2` preparadas |

La ejecución sostenida requerida terminó sobre una copia limpia y fija de `c7f6ce9864e84435153e7639d503192256ea82d4`, con datos desechables. El [informe completo](coluvi-soak-3h-20261005.json) registra PASS, 10.855,94 segundos monotónicos y 10.911,95 segundos entre sus fechas UTC. Ambos superan tres horas, pero difieren en 56,01 segundos; la revisión de relojes se documenta más abajo. No se sumaron ejecuciones breves ni se utilizó tiempo virtual. Coincidió parcialmente con mediciones de carga mixta, lo que debe tenerse en cuenta al interpretar los tiempos.

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

Las cuatro pruebas de `tests/coluvi-rehearsal.test.ts` verifican escenarios, repetición, parámetros, cancelación y rechazo de destinos existentes o UbuntuPreview. La primera ejecución CLI aprobó los seis escenarios, con `sourceUnchanged: true`, en `/tmp/coluvi-rc2-rehearsal-20261004-01/rehearsal.json`. Su tiempo virtual no cuenta para las tres horas sostenidas, verificadas por separado.

La [ampliación de semillas](coluvi-rehearsal-seeds-20261005.json) conserva tres ejecuciones adicionales aprobadas, con 0, 4294967295 y 305419896: dieciocho escenarios en total sobre una copia limpia de `0eb4f76`. Las semillas cambian identidades y, según su paridad, el orden de entrega inicial; no crean nuevos tipos de desastre ni convierten el tiempo virtual en evidencia física.

## Continuidad y recuperación del cliente

`examples/mobile-continuity-smoke.mjs` sirve los archivos reales de la etiqueta RC1 desde Git, guarda un reporte, detiene el acceso al servidor y termina el grupo de procesos de Chromium mediante SIGKILL. Abre después el mismo perfil sin servidor y comprueba que el paquete firmado permanece idéntico. Tras restaurar el acceso, actualiza el service worker de v10 a v12 y carga los archivos nuevos sin perder la cola. Requiere la etiqueta RC1 disponible localmente; las copias limpias deben incluir las etiquetas. La primera verificación usó v11; se repitió correctamente con v12 después de corregir el diseño con texto ampliado.

La prueba inyecta `QuotaExceededError` y abortos de transacciones IndexedDB. Comprueba que se conserve el borrador, que el reporte anterior permanezca intacto y que no aparezca un reporte falsamente guardado. También inyecta un fallo de lectura después de confirmar el guardado: la interfaz distingue ese caso de un fallo al guardar. Finalmente impide persistir un acuse de backend; el siguiente envío recibe una respuesta de duplicado, guarda su confirmación y mantiene exactamente dos reportes únicos en el servidor. Al recuperarse desaparece el aviso de error obsoleto.

Se corrigió además la sincronización de reportes que podía esperar indefinidamente una respuesta: el límite por petición es de diez segundos e incluye la lectura del cuerpo. Las pruebas con HTTP real que no entrega cabeceras o deja el cuerpo incompleto conservan el paquete sin inventar confirmación. Los fallos inyectados no equivalen a llenar un disco físico, y el cierre del navegador no equivale a cortar energía a la computadora. El actor de continuidad usa sincronización manual y desactiva background sync para controlar los puntos de fallo; su funcionamiento ordinario se verifica por separado.

La suite completa después de estos cambios aprobó 215 pruebas en 78,2 segundos, sin fallos, cancelaciones ni omisiones. El recorrido de continuidad en Chromium aprobó también. En ese hito todavía faltaban la carga grande y la ejecución sostenida, cuyos resultados posteriores se describen a continuación.

## Carga mixta instrumentada

```bash
node examples/coluvi-mixed-load.mjs /tmp/coluvi-carga-mixta-nueva 300 24 20261005
```

Este perfil conserva las firmas, límites de admisión, confirmaciones correlacionadas, entrega fuera de orden, dos cortes SIGKILL y reenvío completo de la carga anterior. Añade seis lectores concurrentes de salud, mapa, panel, avisos y bandejas móviles, con una pausa de 100 ms entre consultas por lector. Emite tres avisos por la API del operador y comprueba que permanezcan disponibles tras reiniciar. No afirma que alguien los haya leído ni mide inscripción HTTP masiva.

El informe separa peticiones y errores por endpoint, latencia hasta cabeceras, tiempos completos de envíos aceptados y esperas por admisión. El proceso de servidor instrumentado envía CPU, memoria y retraso del bucle de eventos solo a su padre por IPC, sin exponer otro endpoint público. El destino es exclusivo y el informe identifica el código mediante commit, estado del árbol y SHA-256. Un fallo conserva un informe fallido con los contadores disponibles; no acredita capacidad. El ensayo inicial de 30 dispositivos aprobó, pero no reemplaza la medición de 990.

El primer perfil mixto de 300 dispositivos, sobre una copia limpia del commit `2623d1b`, terminó como fallo tras 69,2 segundos: había observado 810 confirmaciones únicas, pero una lectura de avisos recibió 429. El máximo de retraso del bucle de eventos observado fue 351,3 ms; ese resultado no reproduce el timeout de diez segundos de la RC1. La API privada tiene límites independientes de la ingestión: 600 solicitudes globales y 120 por dirección de origen por minuto. Los lectores del fixture compartían una dirección y trataban 429 como fallo inmediato. Se corrigió el actor para respetar `Retry-After` compartido entre esas consultas, sin aumentar presupuestos ni timeouts del servidor. El informe fallido permanece en `/tmp/coluvi-rc2-mixed-300-20261005-01/mixed-load-failed.json` y no debe presentarse como una ejecución completa aprobada.

La repetición mixta de 300 dispositivos aprobó sobre `c7f6ce9`, con árbol limpio y código sin cambios. El [informe completo](coluvi-mixed-300-20261005.json) registra 810 paquetes únicos, 810 duplicados del reenvío, dos auditorías de persistencia correctas y 2.523 lecturas exitosas. Se respetaron 48 rechazos de ingestión y cinco de API privada; seis lecturas interrumpidas corresponden al corte deliberado, sin lecturas inesperadamente fallidas. Duró 136,83 segundos; las solicitudes exitosas tuvieron mediana de 60,16 ms, percentil 95 de 415,55 ms y máximo de 2.337,18 ms. El máximo observado de RSS fue 125,3 MiB y el retraso máximo del bucle de eventos, 816,84 ms. Coincidió con el inicio del ensayo sostenido. No reprodujo el timeout previo de diez segundos ni establece su causa.

El [perfil mixto de 990](coluvi-mixed-990-20261005.json), sobre la misma copia limpia, también aprobó: 2.673 paquetes únicos conservados, 2.673 duplicados del reenvío y 9.677 lecturas exitosas. Hubo 384 rechazos de ingestión, 22 de API privada y seis lecturas interrumpidas por el corte planificado; ninguna lectura inesperadamente fallida. Duró 534,82 segundos. Las solicitudes exitosas tuvieron mediana de 111,85 ms, percentil 95 de 664,50 ms y máximo de 4.609,82 ms. El máximo RSS fue 134,6 MiB y el retraso máximo del bucle de eventos, 879,76 ms. Coincidió con la observación sostenida y, hacia el final, con comprobaciones visuales breves. Esto demuestra las invariantes de esa ejecución, no capacidad garantizada bajo cualquier carga del equipo. No hubo timeout de diez segundos: su causa original sigue abierta y no debe atribuirse al 429 del actor.

### Límite reproducido con pruebas concurrentes

Una ampliación sobre `0eb4f76` utilizó 990 dispositivos, concurrencia 48 y semilla 3735928559. Al iniciar también la calificación completa en otra carpeta temporal, [el perfil falló](coluvi-mixed-990-contention-20261005-failed.json): 22 solicitudes a `POST /api/packets` excedieron diez segundos. El informe terminó tras 114,36 segundos con 869 paquetes confirmados, pero sin terminar el recorrido ni su auditoría final. No se clasifica como pérdida de esos paquetes ni como prueba aprobada de conservación del conjunto completo.

La [repetición con la misma semilla sin esa calificación concurrente](coluvi-mixed-990-seed3735928559-20261005.json) aprobó en 537,01 segundos, con 2.673 paquetes únicos y reenvío completo. La mediana fue 112,14 ms, el percentil 95, 408,21 ms, y el máximo, 8.399,78 ms. La observación sostenida continuó activa en ambos casos. La [segunda repetición concurrente](coluvi-mixed-990-contention-20261005-failed-repeat.json) volvió a fallar: catorce timeouts, 877 paquetes confirmados y 103,70 segundos hasta terminar el informe fallido. Ningún intento completó la auditoría final del conjunto. Las dos calificaciones concurrentes sí aprobaron sus 217 pruebas y ocho etapas; se guardan sus [ventanas, resultados y hashes de informes](coluvi-contention-qualification-20261005.json).

Durante la segunda repetición se registró [vmstat cada segundo durante tres minutos](coluvi-contention-vmstat-20261005.txt), con fecha UTC. Se descarta para el análisis la primera fila, que resume desde el arranque del equipo. Hay 104 muestras cuyos timestamps caen dentro de la ventana del perfil fallido: máximo de espera de E/S de 11 %, hasta tres procesos bloqueados y al menos 75 % de CPU agregada ociosa; no se registró intercambio a swap. Son métricas del sistema completo, no latencias de cada petición. El proceso instrumentado del backend observó un retraso máximo del bucle de eventos de 1.679,82 ms. Estos datos no aíslan una causa única del timeout de diez segundos.

El contraste reproduce un límite de esta combinación de ensayos, no una capacidad máxima ni una causa única del fallo histórico de RC1. El muestreo global no permite atribuir cada petición al disco, al planificador o al bloqueo de una conexión. No se aumentaron los diez segundos ni se redujeron los controles de persistencia para obtener un aprobado. Para el ensayo físico, no ejecutes calificaciones, simulaciones masivas ni cargas de cientos de actores en la computadora que actúa como centro de mando. Esta precaución no es una garantía de rendimiento o disponibilidad.

## Ensayo sostenido con tiempo real

```bash
node scripts/soak-coluvi.mjs /tmp/coluvi-observacion-nueva 10800 30
```

El comando crea una observación de al menos 10800 segundos reales, con treinta dispositivos ficticios en tres zonas. Emite solicitudes y avisos por HTTP, recibe acuses firmados de recepción, intercala estados y necesidades, verifica proyecciones y consulta salud y mapa. Alterna entregas ordenadas y fuera de orden. Cada veinte rondas termina el backend temporal con SIGKILL entre rondas, verifica todos los reportes confirmados en SQLite y reenvía la ronda más reciente como duplicados después de arrancar otra vez. No equivale a matar el cliente ni a cortar energía física.

`progress.jsonl` guarda las rondas completadas, tiempo observado, conteos, tamaño de base y métricas del servidor. `soak.json` solo se escribe al completar el periodo y la auditoría final con el código sin cambios; `qualifiesThreeHours` diferencia explícitamente un ensayo corto de la observación requerida. Una interrupción o fallo produce `soak-failed.json`, nunca un aprobado. La duración solicitada es mínima: se completa la ronda en curso y se respetan esperas de admisión antes de cerrar. No se cuentan ventanas virtuales del simulador.

Las pruebas cortas verifican reinicios, conservación byte a byte de reportes firmados, deduplicación, avisos y rechazo de parámetros o cancelación. La inscripción inicial se provisiona directamente en la base de prueba; no mide inscripción masiva. Los acuses son RECEIVED, no SHOWN ni atención humana. Los límites por origen se conservan, por lo que las esperas del cliente forman parte del tiempo observado. La ejecución larga terminó en `/tmp/coluvi-rc2-soak-3h-20261005-01`; su informe y su cronología originales se conservan también en este repositorio.

El ensayo previo del comando, solicitado con mínimo de cinco segundos y treinta dispositivos, completó su primera ronda en aproximadamente 61 segundos al respetar el límite de API privada. Confirmó 81 paquetes y terminó como PASS con `qualifiesThreeHours: false`. Su informe está en `/tmp/coluvi-rc2-soak-preflight-20261005-01/soak.json`. La calificación incluye este ensayo breve, pero exige tratar por separado el informe de tres horas.

### Resultado sostenido y revisión de relojes

El ensayo largo completó 167 rondas de treinta dispositivos simulados: 13.527 reportes únicos confirmados, 648 duplicados comprobados tras reenvío, 501 solicitudes, 501 avisos y 9.018 acuses de recepción. Las ocho auditorías posteriores a SIGKILL y la auditoría final verificaron todos los reportes confirmados, integridad SQLite correcta y cero infracciones de claves foráneas. Hubo 898 respuestas 429 respetadas por el actor y ningún fallo de endpoint. No hubo acuses SHOWN ni prueba de atención humana.

La [cronología original](coluvi-soak-progress-20261005.jsonl) conserva inicio y las 167 rondas, sin reescribir sus fechas ni duraciones. El inicio UTC fue `2026-10-05T03:05:43.475Z` y el final, `2026-10-05T06:07:35.422Z`. El tiempo monotónico fue de tres horas y 55,94 segundos; el intervalo UTC, de tres horas, un minuto y 51,95 segundos. La primera ejecución del verificador sobre estos archivos salió con `SOAK_CLOCK_INCONSISTENT`: exigía menos de cinco segundos de diferencia acumulada durante toda la observación.

La traza muestra divergencia gradual entre ambos relojes, no una ronda omitida. Su causa no está establecida: que el sistema informe NTP sincronizado no explica por sí solo este comportamiento. El verificador actualizado exige ahora ambos mínimos de tres horas y la cronología completa: verifica secuencia, contadores, tiempos monotónicos, orden UTC, duración de cada ronda y concordancia del cierre. Conserva el límite de cinco segundos por intervalo para rechazar saltos grandes y emite la divergencia acumulada explícitamente. No modifica el informe ni permite que un solo reloj compense una duración insuficiente en el otro. La mayor diferencia por intervalo fue 2.436,66 ms. Sus catorce pruebas unitarias y la posterior calificación completa de 231 pruebas aprobaron.

## Pantallas pequeñas y texto ampliado

Se conservan también los resultados negativos: [fallo de carga por 429 antes de corregir el actor](coluvi-mixed-300-20261005-failed.json) y [desbordamiento al 200 % antes de ajustar los estilos](coluvi-mobile-reflow-20261005-failed.json). Este último corresponde al comprobador con cada documento aislado; no se usa como evidencia el intento anterior que midió botones después de ocultarlos ni la variante que omitía aislar las transiciones de viewport.

```bash
COLUVI_CHROMIUM_PATH=/ruta/al/chromium \
  node examples/mobile-readiness-smoke.mjs /tmp/coluvi-pantallas-nuevas
```

Se verifican doce combinaciones: 320, 360 y 412 píxeles CSS, español e inglés y texto raíz al 100 % y 200 %. Cada caso abre un documento nuevo, despliega inscripción y diagnóstico, abre el formulario de recursos, comprueba nombres accesibles, botones y desplegables de al menos 44 píxeles, foco y retorno con Escape, y ausencia de desbordamiento horizontal. Conserva el informe y dos capturas ficticias; no escribe reportes ni usa el piloto real.

La comprobación aislada inicial confirmó que las seis combinaciones con texto al 200 % desbordaban la pantalla. Se corrigieron títulos flexibles, mínimos de formularios, campos de necesidades y ajuste de textos largos, sin ocultar contenido ni reducir su tamaño. Las doce combinaciones aprobaron después en `/tmp/coluvi-rc2-readiness-20261005-07/readiness.json`; también se inspeccionaron las capturas. La caché pasa a v12 para distribuir esos estilos. La calificación integrada incorpora esta prueba.

La emulación no equivale a TalkBack, a la escala de texto del sistema Android ni a una auditoría completa de WCAG. La observación sostenida se ejecutó en su copia inmutable `c7f6ce9`: estos cambios posteriores afectan la PWA y sus pruebas, no los módulos del backend ni el ejecutor de observación. La entrega identifica ambas procedencias y califica por separado la PWA modificada.

## Calificación limpia y procedencia

La [calificación vigente](coluvi-qualification-20261005-rc2-chronology.json) aprobó 231 pruebas sin fallos, cancelaciones u omisiones y las ocho etapas, desde una copia limpia de `5bb4ebebce1489c915f6620d2a858fc98ca9d470`. El ejecutor midió 299,36 segundos. La huella completa es `8d8707233e0305818693282e5aba958b7e0abae6bef7f89379d67296e4917f00`; el [CI del código](https://github.com/raulprtech/emergency-mesh/actions/runs/37271404269) también aprobó. Incluye el verificador de cronología actualizado, además de simulacros, navegador, continuidad RC1–v12, doce casos visuales, mapa, ensayo breve y carga base de 300.

La [calificación de software con el primer verificador](coluvi-qualification-20261005-rc2-final.json) aprobó 225 pruebas y las ocho etapas en 280,14 segundos, sobre una copia limpia de `54c4c0398d49439afae713a11c7dff7171c1af1f`. Su huella completa es `366b1eee676fa0d1f189e7adc29d71673a75f837a5168a5002e96cb477a62860`. El [CI de esta revisión](https://github.com/raulprtech/emergency-mesh/actions/runs/37262531998) también aprobó. Se conserva como antecedente previo a la comprobación de cronología, igual que el informe de 217 pruebas siguiente.

El [informe integrado](coluvi-qualification-20261005-rc2.json) registra PASS para `0eb4f761b105c33cbc8d9a49f2da82c5085d6981`, desde una copia limpia, con SHA-256 de fuentes `27b30fd3f4c028e3f5baa451541440355dbc66a2ff301cc5fdae1b79dd99f7e9`. Aprobó 217 pruebas sin fallos, cancelaciones u omisiones, seis simulacros, navegador integrado, continuidad RC1–v12, doce casos visuales, mapa offline, ensayo breve y carga base de 300 dispositivos. Las ocho etapas tardaron 307,59 segundos y coincidieron con la observación sostenida. El [CI de la revisión](https://github.com/raulprtech/emergency-mesh/actions/runs/37260074835) también aprobó.

La carga mixta y la observación de tres horas usan `c7f6ce9`, con SHA-256 `57e66eb28871611f5dfb2c64397713e30567aa8faa612c23319fd9141ee1b185`. Entre ese código y la calificación vigente, los únicos archivos modificados dentro de `src` son `mobile-client/styles.css`, `mobile-client/sw.js` y la comprobación de versión de caché en `mobile-client/app.js`. El backend, la persistencia y los ejecutores de carga y observación no cambiaron. Su huella compartida de código ejercitado es `825b892955f440c96e80978391bf2c8a4a221177261a7fb171d673bfac275dd9`. Las adiciones de pruebas visuales y herramientas de comprobación explican el cambio de huella completa; no se presenta la observación como una prueba de tres horas de la PWA v12.

El informe integrado contiene algún identificador aleatorio del fixture ficticio, no credenciales ni datos del piloto. Los informes de diagnóstico descargables de la PWA tienen un contrato distinto: excluyen también esos identificadores. El ensayo breve integrado tiene `qualifiesThreeHours: false`. RC2 no se etiqueta como terminada hasta comprobar toda la evidencia contra el código calificado.

## Comprobación de evidencia antes de etiquetar

```bash
node scripts/verify-coluvi-rc2.mjs \
  docs/coluvi-qualification-20261005-rc2-chronology.json \
  docs/coluvi-mixed-300-20261005.json \
  docs/coluvi-mixed-990-20261005.json \
  docs/coluvi-soak-3h-20261005.json \
  docs/coluvi-soak-progress-20261005.jsonl
```

El verificador exige Ubuntu WSL y un árbol limpio. Lee cuatro informes locales y la cronología JSONL del ensayo largo, sin modificarlos. Comprueba pruebas y etapas completas, recuperación del cliente, privacidad, casos visuales, auditorías de carga y las tres horas medidas por ambos relojes, con la secuencia completa de rondas. Recalcula las huellas de los commits desde Git y exige que todo el código actual esté cubierto por la calificación. El código de backend y de los actores usados en carga y observación debe coincidir; solo excluye de esa segunda comparación los tres archivos de presentación de PWA documentados anteriormente. No excluye contratos ni lógica móvil de firmas o sincronización.

Una etiqueta PASS escrita en un JSON no basta: los controles rechazan duración insuficiente, auditorías faltantes, una fuente distinta, cronologías incompletas, saltos de reloj grandes y resultados contradictorios. Las catorce pruebas del verificador incluyen datos sintéticos para sus casos positivos; esos fixtures no acreditan que haya ocurrido una observación real. El comando emite hashes de los cinco archivos y un resumen, pero no crea una etiqueta, no publica nada y no autentica informes obtenidos de terceros.

También se ejecutó el CLI real desde la copia limpia, con la calificación y los dos perfiles mixtos aprobados, pero usando deliberadamente el ensayo breve como cuarto argumento. Salió con código 1 y `SOAK_TOO_SHORT`. El CLI actualizado repitió ese rechazo y rechazó además combinar el informe largo con la cronología breve mediante `SOAK_TIMELINE_INCOMPLETE`. Son pruebas negativas, no resultados fallidos del ensayo largo.

La [comprobación final real](coluvi-rc2-release-check-20261005.json) aprobó sobre el código limpio `5bb4ebe`. Verificó las huellas de los cinco archivos, la calificación vigente, ambas cargas mixtas y las 167 rondas originales. Su resultado mantiene `physicalAndroid: PENDING`, `originalTimeoutCause: NOT_ESTABLISHED` y la advertencia `DIVERGENT_BOTH_EXCEED_MINIMUM`. Las revisiones finales de documentación no alteran la huella del código calificado. La versión reproducible es [coluvi-simulacro-20261005-rc2](https://github.com/raulprtech/emergency-mesh/tree/coluvi-simulacro-20261005-rc2).

## Restricciones operativas

Todo se ejecuta en Ubuntu WSL2, nunca UbuntuPreview. Los ensayos usan directorios y procesos temporales propios. No se reemplazan datos del piloto, claves, certificados ni servicios ajenos. No se modifica el firewall ni se instala confianza TLS global. No se contratan servicios, crean cuentas, publican despliegues ni presentan solicitudes.

La aplicación nativa y Bluetooth, Bitchat o LoRa físicos quedan para otra etapa. Las pruebas automatizadas no demuestran accesibilidad real desde Android, consumo de batería, recepción con la aplicación suspendida ni capacidad de atención humana. El ensayo físico posterior debe registrar esos límites y los fallos observados.
