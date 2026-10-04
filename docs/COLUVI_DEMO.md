# Demostración bidireccional de Coluvi

El prototipo ya permite emitir «¿Estás bien?» desde un panel autorizado, recibir la solicitud en la PWA y guardar «Estoy bien» o «Necesito ayuda» sin conexión. Al volver una ruta al centro, la respuesta se sincroniza con evidencia de almacenamiento. Esta guía reproduce el recorrido de software y distingue sus resultados de las pruebas físicas todavía pendientes.

Todo se desarrolla y ejecuta en Ubuntu de WSL2, nunca UbuntuPreview. Usa datos ficticios: no es un servicio de emergencia ni garantiza entrega, atención o ayuda despachada.

## Preparación local

Requiere Node 22.18 o posterior; se verificó con Node 24.18.0. No necesita instalar paquetes. Este ejemplo solo admite acceso desde la computadora mediante loopback. Si el directorio ya existe, elige otro nombre: el generador se niega a sobrescribir claves o contraseñas.

```bash
cd /home/raulprtech/emergency-mesh
mkdir -p .data
node scripts/create-coluvi-pilot.mjs http://127.0.0.1:8797 .data/coluvi-dev-20261004 refugio-norte refugio-sur
PORT=8797 EMERGENCY_MESH_HOST=127.0.0.1 \
EMERGENCY_MESH_DATABASE_PATH=.data/coluvi-dev-20261004/pilot.sqlite \
EMERGENCY_MESH_COLUVI_CONFIG_PATH=.data/coluvi-dev-20261004/operator-config.json \
node src/server.ts
```

El generador informa rutas y huella pública, nunca secretos. Consulta localmente `operator-secrets.txt`: la contraseña es exclusiva del operador; el código de inscripción se comparte por separado con participantes que consientan. No copies ese archivo completo ni `operator-config.json` al teléfono, a GitHub o a esta conversación.

El material nuevo incluye capacidades explícitas de check-in y avisos de simulacro. La configuración anterior de solo check-in sigue funcionando sin ampliar sus permisos. No sobrescribas el material del piloto para actualizarlo; los participantes necesitan un archivo público de confianza que autorice los tipos que van a recibir.

## Recorrido manual

1. Abre `http://127.0.0.1:8797/mobile/`. Expande «Inscribirme en el piloto Coluvi».
2. Importa únicamente `mobile-trust.json`, introduce la huella SHA-256 verificada por otro canal, una zona autorizada y el código de inscripción. Marca el consentimiento. El cliente demuestra posesión de su clave; no guarda el código.
3. Abre `http://127.0.0.1:8797/command-center/`. Inicia sesión con la contraseña del operador. Selecciona la misma zona, confirma que es un simulacro y emite la solicitud. Solo incluye dispositivos ya inscritos en ese instante.
4. Vuelve al cliente y consulta solicitudes mientras esté abierto y conectado. Tras recibir una solicitud válida, deja que su tarjeta entre en pantalla. RECEIVED y SHOWN se guardan como evidencias separadas y se sincronizan en consultas posteriores.
5. Detén el servidor con Ctrl+C. En el cliente, responde a la solicitud ya recibida. Debe conservarse en cola. Cierra la ventana y vuelve a abrirla dentro del plazo; no debe generar otra respuesta por repetir el clic.
6. Arranca el servidor con el mismo comando, configuración y base. Usa «Intentar sincronizar». SYNCED requiere un acuse BACKEND correlacionado, no solo HTTP exitoso.
7. El reinicio invalida la sesión del operador: vuelve a entrar y abre el detalle. Debe aparecer una única respuesta y su historial. Las credenciales móviles sobreviven al reinicio, salvo expiración, rotación o revocación.

Después de guardar «Necesito ayuda», abre «Añadir o actualizar necesidades»: selecciona categorías y, si quieres, indica de 1 a 999 personas declaradas. El detalle se guarda y entrega por separado; un error del formulario no elimina ni retrasa la respuesta mínima. Puedes cambiar a «Estoy bien» y volver a «Necesito ayuda» mediante «Actualizar estado». Cada cambio conserva el historial, incluso sin red. SAFE no inscribe voluntarios y NEEDS_HELP no convierte automáticamente la respuesta en SOS. Las respuestas mínimas no contienen GPS, contactos ni texto libre.

En «Emitir aviso de simulacro», el operador también puede enviar un mensaje firmado a su zona con fuente declarada y caducidad. La tarjeta móvil muestra SIMULACRO y la identidad firmante; una copia vencida se marca CADUCADO. Tanto su almacenamiento offline como sus recibos se conservan tras reabrir y reiniciar. El texto no se ejecuta como HTML y los avisos no se publican en el mapa. El [contrato de avisos](COLUVI_NOTICES.md) detalla permisos y límites.

## Plazos y falta de respuesta

El plazo inicial determina cuándo se deriva UNKNOWN si falta una respuesta; no significa peligro, inconsciencia ni víctima. Hasta el cierre total se permite entregar respuestas en cola y declarar un estado nuevo con el contrato v2, incluido el paso de UNKNOWN a SAFE o NEEDS_HELP. La interfaz etiqueta explícitamente ese periodo como tardío. Después del cierre total no se crean ni aceptan respuestas o detalles nuevos para esa solicitud. El recibo SHOWN v1 conserva su significado anterior: presentación dentro del periodo inicial, no evidencia de todas las interacciones tardías.

Los contadores usan dispositivos, no personas. Recibidos, mostrados y respondidos pueden solaparse y no deben sumarse como categorías excluyentes. Las respuestas tardías se conservan sin borrar historial ni hacer retroceder una observación más reciente.

## Estado y necesidades: contrato y límites

Las respuestas v1 conservan sus bytes y reglas: observación antes del plazo inicial. `CHECKIN_RESPONSE` v2 usa el dominio firmado `COLUVI/CHECKIN_RESPONSE/v2`, añade `revision` (0–99) y `previousEventId`, y admite observaciones hasta el cierre total. Una primera respuesta tardía tiene revisión 0 y antecedente nulo. El orden del estado vigente es fecha de observación, revisión, fecha de creación e identificador; una revisión resuelve dos cambios en el mismo milisegundo, sin hacer que una observación antigua prevalezca sobre una nueva.

Cada evento declara un estado completo y puede recibirse antes que su antecedente. El historial distingue inicio, vínculo verificado, antecedente faltante y vínculo inconsistente. Una firma identifica la declaración del dispositivo, no verifica la situación humana. La custodia de un evento no afirma que todos sus antecedentes hayan llegado ni que la cadena esté completa.

`x-coluvi-checkin-needs` usa `CHECKIN_NEEDS` v1: comando, zona, respuesta de ayuda referenciada, revisión, antecedente del detalle, categorías únicas y cantidad declarada opcional. Admite las nueve categorías normalizadas, incluido transporte; no admite texto libre, coordenadas ni datos médicos personales. Un detalle puede llegar primero, pero no se aplica hasta existir la respuesta de ayuda del mismo dispositivo y solicitud, con fechas compatibles. Solo el último detalle vinculado al estado actual contribuye a los conteos. Un detalle vacío retira los detalles anteriores; SAFE o una nueva respuesta dejan los anteriores como historial, sin arrastrarlos al nuevo estado.

El panel cuenta una vez por dispositivo y categoría. Las cantidades de personas son declaraciones por reporte: no se suman entre dispositivos porque no se ha demostrado que se refieran a personas diferentes. Los datos operativos nunca se incorporan al mapa público.

SQLite añade `coluvi_needs` sin reemplazar tablas anteriores. Hay un máximo de 100 estados y 100 detalles por dispositivo y solicitud. IndexedDB sigue en v3 con campos aditivos e historial local: las transacciones comprueban inscripción, antecedente esperado y escritura conjunta de bandeja y outbox. Dos escritores sobre el mismo antecedente producen un único ganador; el otro debe revisar el estado vigente. El worker v10 conserva el aislamiento de caché privada.

## Verificación automatizada

```bash
node --test tests/*.test.ts
COLUVI_CHROMIUM_PATH=/ruta/al/chromium node examples/coluvi-browser-smoke.mjs
node examples/coluvi-drill.ts 30 20261004
```

La prueba de navegador genera configuración, perfil y SQLite temporales propios. No modifica datos del piloto, no instala navegadores y no desactiva validación TLS. Usa HTTP loopback como contexto seguro de desarrollo; no equivale a un origen HTTPS confiable desde Android. Al terminar detiene sus procesos y elimina únicamente sus archivos temporales.

Verificación ampliada del 4 de octubre de 2026 en Ubuntu WSL2: 193 pruebas aprobadas con concurrencia de dos archivos, cero fallos, cancelaciones u omisiones. Chromium 151.0.7922.34 verificó migración real desde IndexedDB v1 y v2 a v3 sin perder los datos previos, inscripción y emisión desde las interfaces, backend completamente detenido durante la respuesta offline, cierre y reapertura de la ventana, QUEUED a SYNCED con evidencia BACKEND y recuperación de los cuatro recibos de check-in y aviso tras reiniciar. Consultar de nuevo una solicitud sin cambios conservó su tarjeta. El aviso mantuvo fuente, firma y caducidad; una prueba de reloj local comprobó su etiqueta histórica al vencer.

En el nuevo recorrido se guardó primero NEEDS_HELP, luego agua/transporte y tres personas declaradas, todo offline. Los dos paquetes sobrevivieron al cierre y reapertura. Tras sincronizar, el panel contó un dispositivo con cada necesidad, no tres personas verificadas. Una actualización SAFE creada offline sobrevivió a recargar y llegó al backend: un destinatario, una respuesta vigente SAFE, dos eventos de estado y un detalle histórico, sin necesidades activas. El reenvío del mismo paquete no creció el historial. Dos conexiones reales de IndexedDB compitieron sobre el mismo antecedente: un ganador de estado y uno de detalle, tres elementos en outbox y la respuesta inicial intacta. Las pruebas unitarias también verificaron respuesta inicial tardía, vínculos faltantes, orden inverso, misma marca de tiempo, cupos y conteos globales con paginación.

Ninguna API privada apareció en CacheStorage y el agregado público no incluyó estados, necesidades ni avisos. Cerrar sesión vació la vista privada y el borrador de aviso. Ambas interfaces quedaron sin desbordamiento a 360 píxeles; el panel no tuvo controles interactivos sin nombre. Pasaron también las regresiones anteriores de reporte offline y accesibilidad móvil, sin diagnósticos de página. Estas pruebas no sustituyen Android físico ni prueban transporte por radio.

## Operación y recuperación

El hito posterior de operación aprobó 199 pruebas en Ubuntu WSL2, sin fallos, cancelaciones ni omisiones. Chromium añadió listado de participantes, cancelación y confirmación de revocación: la credencial quedó bloqueada, no se emitió un acuse falso y se conservaron el destinatario original y los dos estados históricos. Las herramientas de arranque, diagnóstico, respaldo SQLite con WAL activo y restauración en una carpeta nueva tienen pruebas propias; consulta [Operación y recuperación](COLUVI_OPERATIONS.md). La restauración advierte explícitamente sobre revocaciones realizadas después del inicio del respaldo. Esto no convierte las pruebas virtuales siguientes en mediciones físicas.

## Simulacro virtual de inundación

Treinta ciclos usan los contratos y verificadores compartidos, `SimulatedNode`, colas SQLite, enlaces de pérdida con semilla y el gateway existente. Cada ciclo inscribe cinco dispositivos ficticios: cuatro destinatarios del refugio y uno de otra zona, excluido de la solicitud. Un destinatario alcanzable no responde por decisión del actor de prueba. Hay seis ciclos de cada condición: LAN sin Internet externo, aislamiento total, conectividad intermitente, entrega tardía y entrega después de caducar. Cada ciclo cierra y vuelve a abrir el centro y las colas.

Con semilla 20261004, pérdida simulada del 25 %, pasos virtuales de un segundo, plazo de 20 segundos y ventana total de 60 segundos:

| Métrica | Resultado agregado |
|---|---|
| Pares dispositivo y solicitud | 120 |
| Evidencia de recibido y mostrado | 70 de cada tipo |
| Respuestas recibidas | 54 |
| Estoy bien y necesito ayuda | 36 y 18 |
| Sin respuesta al finalizar | 66 |
| Última respuesta entregada tarde | 21 |
| Reinicios limpios del centro y las colas | 30 |

Dos ejecuciones completas con la misma semilla produjeron exactamente las mismas métricas. El JSON exporta contadores y tiempos virtuales, no claves, tokens, firmas o identificadores de dispositivos. Su p95 de entrega es 36 segundos virtuales; el p95 de demora impuesta por la caída del centro es 24 y el de tiempo restante es 12. Son distribuciones calculadas por separado: sus percentiles no deben sumarse como una identidad. Incluyen solo las 54 respuestas recibidas; las no recibidas se informan aparte, no como latencia cero.

El actor del simulador marca SHOWN después de verificar el comando; la presentación real se comprueba por separado en Chromium. No se midieron rango, batería, radio, rendimiento Android ni corte eléctrico. Cero milisegundos en algunos recorridos significa entrega dentro del mismo paso del simulador, no entrega física instantánea.

## Prueba pendiente en Samsung

Para S26 Ultra y A54 hay que confirmar Wi-Fi, Android y navegador, configurar acceso LAN desde Windows y aceptar el certificado verificado. Sigue [Phone pilot](PHONE_PILOT.md) y el [registro de preparación](PILOT_20261002.md); verifica IP y vigencia antes de reutilizar material TLS. No se abrieron puertos ni se modificó el firewall durante este bloque.

La PWA recibe solicitudes y avisos mientras está abierta y tiene una ruta al centro. Un elemento nunca recibido no aparece durante aislamiento total; no se garantiza recepción con la aplicación cerrada. Background Sync, si existe, intenta entregar respuestas ya firmadas, no recibir nuevas solicitudes. Continúan fuera de esta demostración la app nativa y BLE/Bitchat/LoRa reales. El [mapa geográfico](PUBLIC_MAP.md) ya usa cartografía local y conserva sus agregados y restricciones de privacidad; no mezcla datos privados con su proyección pública.
