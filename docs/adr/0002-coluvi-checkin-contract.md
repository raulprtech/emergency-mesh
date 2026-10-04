# Contrato y persistencia del check-in de Coluvi

Decisión del 4 de octubre de 2026. El ciclo operativo de Coluvi reutiliza reportes y envelopes v0.1, pero mantiene una autoridad y una persistencia privadas. Una firma de un dispositivo, un ACK de transporte o el certificado HTTPS no habilitan por sí mismos a emitir solicitudes de estado.

## Compatibilidad y autoridad

CHECKIN_REQUEST, CHECKIN_RESPONSE y los recibos se transportan como `x-coluvi-checkin-request`, `x-coluvi-checkin-response` y `x-coluvi-checkin-receipt`. El contrato original usa `extensions.coluvi.version` 1. La ampliación del mismo día añade respuestas v2 y detalles `x-coluvi-checkin-needs` v1 sin cambiar los vectores anteriores. Solicitudes y recibos siguen siendo v1.

Cada reporte incluye la firma Ed25519 habitual y otra firma sobre CBOR determinista de `{ domain: "COLUVI/<kind>/v<version>", payload }`. El payload excluye `domainSignature`. El dominio separa tipos y versiones; los bytes de v1 no cambian. La firma externa vincula ese payload con identidad, tiempos y referencia del reporte. Los validadores Node y navegador comparten código y rechazan campos ajenos a cada contrato.

Una autoridad configurada contiene `issuerId`, clave pública SPKI en base64url, zonas y tipos permitidos, y revocación opcional. Su huella SHA-256 se calcula sobre SPKI. El teléfono debe obtener y verificar esta confianza fuera de la bandeja: recibir una clave junto con un comando no la vuelve confiable. El vector de ejemplo tiene una semilla pública ficticia y nunca debe usarse como autoridad del piloto.

## Solicitud y destinatarios

El comando contiene `commandId`, `incidentRef`, `issuerId`, `zoneId`, `issuedAt`, `promptUntil`, `responseUntil` y `nonce`. `eventId`, identidad, incidente, creación, observación, ubicación de zona y nonce del reporte deben coincidir. No lleva coordenadas, sujetos, cantidad de personas, necesidades ni contenido protegido.

La ventana inicial no puede superar 24 horas. El plazo adicional de recepción tardía no puede superar otras 24 horas. `validUntil` del reporte y la expiración del envelope se refieren a `responseUntil`; `promptUntil` determina UNKNOWN y el límite de observación de respuestas v1. La ampliación v2 permite declarar un estado nuevo en la ventana tardía, etiquetada explícitamente en la interfaz; no reinterpreta una observación v1 vencida.

Al emitir se fija la lista de dispositivos inscritos activos de esa zona, incluida su clave pública. Inscribirse después no incorpora a un dispositivo a solicitudes anteriores. Repetir la emisión no modifica destinatarios ni plazos. Reutilizar un ID con distinto contenido o un nonce del emisor con otro comando se rechaza.

## Respuesta y evidencias

La respuesta mínima declara SAFE o NEEDS_HELP y vincula comando, incidente, zona, seudónimo e instante observado. Se firma antes de añadirse a la cola. NEEDS_HELP usa prioridad HIGH, no SOS; SAFE no implica disponibilidad para ayudar. No incluye GPS, texto libre ni cantidad de personas.

Solo se aceptan firmas del destinatario inscrito activo y llegada antes de `responseUntil`. V1 exige observación anterior a `promptUntil`; v2 permite observar hasta `responseUntil` e incluye revisión 0–99 y antecedente firmado. La observación determina el estado más reciente; revisión, creación e ID resuelven empates de forma determinista. Una observación antigua que llegue después no hace retroceder el estado. La llegada desde `promptUntil` se conserva como tardía. Historial y recepción se mantienen por separado. Los estados completos pueden aceptarse sin su antecedente, pero la proyección distingue vínculo faltante, verificado o inconsistente.

El enriquecimiento es otro evento firmado, posterior a guardar la señal mínima. `CHECKIN_NEEDS` v1 referencia una respuesta NEEDS_HELP del mismo dispositivo y contiene categorías y cantidad declarada opcional. Solo el último detalle del estado vigente se cuenta; se conserva el historial anterior. SQLite añade una tabla privada sin alterar datos previos, con máximo de 100 detalles por dispositivo y solicitud. Las cantidades declaradas no se suman como personas únicas. El [contrato ampliado](../COLUVI_DEMO.md#estado-y-necesidades-contrato-y-límites) documenta campos, orden, recepción fuera de orden y límites.

Los recibos declaran RECEIVED o SHOWN, no atención humana. Cada recibo está firmado y vinculado al comando y al participante autenticado. La proyección no inventa un recibo a partir de una respuesta: puede haber respuesta sin recibos sincronizados todavía. Los recibos duplicados no incrementan cantidades.

UNKNOWN se deriva al vencer `promptUntil` si no existe respuesta válida. Significa falta de respuesta, no víctima, peligro, inconsciencia ni ayuda despachada. Se conserva por separado si existe evidencia de recepción o presentación. Los contadores usan dispositivos, no personas.

## Persistencia y privacidad

`ColuviStore` añade tablas SQLite de participantes, comandos, destinatarios, respuestas, recibos y auditoría sin alterar `reports` ni `arrivals`. Las escrituras relacionadas son transaccionales, con WAL, `synchronous=FULL` y claves foráneas. Las pruebas comprueban recuperación tras cierre y apertura; no equivalen a una prueba de corte eléctrico real.

La inscripción interna exige una clave Ed25519 canónica y zona habilitada. La API valida el código de participación y un reto firmado de un solo uso antes de invocarla. El límite predeterminado es de 1.000 participantes. La bandeja y el detalle privado están acotados a 100 comandos o destinatarios por página; los contadores incluyen el conjunto completo. Cada destinatario conserva hasta 100 respuestas por solicitud. Se conserva historial durante 30 días después de la ventana tardía, mediante poda explícita; aún no existe programación automática de retención.

La revocación de un participante bloquea futuras entregas y respuestas. Al abrir el almacén con una autoridad revocada también se bloquean sus comandos pendientes. Un cliente desconectado no puede conocer una revocación nueva: su confianza local solo puede actualizarse al recibir configuración verificada. La caducidad limita esa exposición, pero no ofrece revocación instantánea offline.

Los eventos `x-coluvi-*` no participan en los agregados, filtros ni supresión pública. Sin configuración explícita, el servidor rechaza esos paquetes. Con el servicio privado habilitado, acepta respuestas firmadas de destinatarios inscritos sin requerir un token del transporte; bandeja y recibos sí exigen credenciales. Así la respuesta puede usar la cola y adaptadores existentes sin hacer pública la información operativa.

## Evidencia y trabajo pendiente

`ColuviAuth` implementa verificadores de contraseña con scrypt, sesiones de hasta una hora y un máximo de ocho sesiones activas, tokens aleatorios, validación CSRF y cierre de sesión. Los intentos de acceso están limitados por ventana global y origen de red. Los retos de inscripción caducan a los dos minutos, tienen capacidad acotada y se consumen al intentar completar una prueba de posesión. La API comprueba Host, Origin y CSRF, emite cookies Secure/HttpOnly/SameSite y registra accesos. Credenciales móviles persistidas como hashes caducan a los siete días; la sesión operativa y los retos se invalidan al reiniciar. Las rutas e instrucciones están en [Reference API](../REFERENCE_API.md).

El service worker actual v10 solo almacena recursos explícitos del shell móvil; no intercepta las APIs ni el panel. Elimina sus cachés de versiones anteriores sin borrar cachés ajenos. Las solicitudes de recursos con Authorization no se almacenan. Los endpoints privados usan `no-store`; la PWA comprueba por mensaje la versión y la exclusión de caché antes de inscribir o consultar, para no usar un worker antiguo con políticas distintas.

`examples/coluvi-command-vector.json` fija identidad ficticia, huella, campos y firmas. Las pruebas de contrato comparan ese vector y verifican interoperabilidad Node/navegador, falsificación, revocación, ámbito, vigencia y conservación del vector v0.1. Las pruebas del almacén cubren destinatarios fijos, paginación, duplicados, conflictos, nonces repetidos, respuestas tardías y fuera de orden, recibos, reinicio, preservación de reportes, capacidad e integridad SQLite.

La prueba HTTP real recorre acceso del operador, inscripción con firma del navegador, solicitud, bandeja, recibos y respuesta NEEDS_HELP. Verifica persistencia al reiniciar, aislamiento entre zonas, rechazo de dispositivos no inscritos, ausencia de datos privados en APIs públicas y generación sin sobrescritura ni secretos en stdout. Las nuevas pruebas de la cola exigen evidencia BACKEND correlacionada antes de marcar SYNCED. El acuse backend es estructurado, no una firma independiente: el HTTPS confiable autentica la respuesta del servidor.

La migración IndexedDB v2 conserva identidad, ajustes y reportes y añade bandeja y recibos; v3 añade avisos. La respuesta y su referencia en la solicitud se escriben en una transacción, igual que cada evidencia de presentación. El cursor solo avanza después de guardar los comandos, con comprobación de la credencial vigente. Rotar identidad retira la inscripción local sin borrar reportes ya firmados. La interfaz actual admite cambios de estado y detalles mediante campos aditivos en v3; una comparación transaccional del antecedente y de la inscripción impide sobrescrituras concurrentes.

Validación del 4 de octubre en Ubuntu WSL2 con Node 24.18.0: `node --test tests/*.test.ts` aprobó 166 pruebas, sin fallos, cancelaciones ni omisiones. El smoke de Chromium recorre las interfaces de inscripción, emisión y respuesta con el backend completamente detenido durante la etapa offline, cierre y reapertura de la ventana, sincronización correlacionada, recuperación tras reiniciar, duplicados, logout y privacidad de caché. Incluye las regresiones previas de reporte offline y accesibilidad móvil. Treinta ciclos ficticios se reproducen con la misma semilla usando colas SQLite y contratos reales; no prueban radio ni Android. Resultados e instrucciones en la [guía de demostración](../COLUVI_DEMO.md).

El hito inicial dejó pendientes cambios de estado, avisos y mapa geográfico, ahora implementados con evidencias en la guía de demostración. También se integraron la administración de participantes y las herramientas de recuperación. Continúan pendientes pruebas reales en Samsung y los bloques de escala e integración final indicados en el [plan ampliado](../COLUVI_EXPANDED_BLOCK.md). No se garantiza recepción en segundo plano ni ayuda despachada.
