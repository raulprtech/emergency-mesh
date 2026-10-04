# Contrato y persistencia del check-in de Coluvi

Decisión del 4 de octubre de 2026. El ciclo operativo de Coluvi reutiliza reportes y envelopes v0.1, pero mantiene una autoridad y una persistencia privadas. Una firma de un dispositivo, un ACK de transporte o el certificado HTTPS no habilitan por sí mismos a emitir solicitudes de estado.

## Compatibilidad y autoridad

CHECKIN_REQUEST, CHECKIN_RESPONSE y los recibos se transportan como `x-coluvi-checkin-request`, `x-coluvi-checkin-response` y `x-coluvi-checkin-receipt`. El esquema `extensions.coluvi.version` es 1. El vector publicado v0.1 no cambia.

Cada reporte incluye la firma Ed25519 habitual y otra firma sobre CBOR determinista de `{ domain: "COLUVI/<kind>/v1", payload }`. El payload excluye `domainSignature`. El dominio separa una solicitud de una respuesta o recibo; la firma externa vincula ese payload con identidad, tiempos y referencia del reporte. Los validadores Node y navegador comparten código y rechazan campos ajenos al contrato mínimo.

Una autoridad configurada contiene `issuerId`, clave pública SPKI en base64url, zonas y tipos permitidos, y revocación opcional. Su huella SHA-256 se calcula sobre SPKI. El teléfono debe obtener y verificar esta confianza fuera de la bandeja: recibir una clave junto con un comando no la vuelve confiable. El vector de ejemplo tiene una semilla pública ficticia y nunca debe usarse como autoridad del piloto.

## Solicitud y destinatarios

El comando contiene `commandId`, `incidentRef`, `issuerId`, `zoneId`, `issuedAt`, `promptUntil`, `responseUntil` y `nonce`. `eventId`, identidad, incidente, creación, observación, ubicación de zona y nonce del reporte deben coincidir. No lleva coordenadas, sujetos, cantidad de personas, necesidades ni contenido protegido.

La ventana de presentación no puede superar 24 horas. El plazo adicional de recepción tardía no puede superar otras 24 horas. `validUntil` del reporte y la expiración del envelope se refieren al límite de transporte `responseUntil`; `promptUntil` controla la interacción visible. Al vencer este último se deja de solicitar una respuesta nueva, aunque una respuesta ya firmada y en cola aún puede llegar.

Al emitir se fija la lista de dispositivos inscritos activos de esa zona, incluida su clave pública. Inscribirse después no incorpora a un dispositivo a solicitudes anteriores. Repetir la emisión no modifica destinatarios ni plazos. Reutilizar un ID con distinto contenido o un nonce del emisor con otro comando se rechaza.

## Respuesta y evidencias

La respuesta mínima declara SAFE o NEEDS_HELP y vincula comando, incidente, zona, seudónimo e instante observado. Se firma antes de añadirse a la cola. NEEDS_HELP usa prioridad HIGH, no SOS; SAFE no implica disponibilidad para ayudar. No incluye GPS, texto libre ni cantidad de personas.

Solo se aceptan firmas del destinatario inscrito, con observación dentro de la ventana de presentación y llegada antes de `responseUntil`. La observación determina el estado más reciente; creación e ID resuelven empates de forma determinista. Una observación antigua que llegue después no hace retroceder el estado. La llegada desde `promptUntil` se conserva como tardía. Historial y recepción se mantienen por separado.

Los recibos declaran RECEIVED o SHOWN, no atención humana. Cada recibo está firmado y vinculado al comando y al participante autenticado. La proyección no inventa un recibo a partir de una respuesta: puede haber respuesta sin recibos sincronizados todavía. Los recibos duplicados no incrementan cantidades.

UNKNOWN se deriva al vencer `promptUntil` si no existe respuesta válida. Significa falta de respuesta, no víctima, peligro, inconsciencia ni ayuda despachada. Se conserva por separado si existe evidencia de recepción o presentación. Los contadores usan dispositivos, no personas.

## Persistencia y privacidad

`ColuviStore` añade tablas SQLite de participantes, comandos, destinatarios, respuestas, recibos y auditoría sin alterar `reports` ni `arrivals`. Las escrituras relacionadas son transaccionales, con WAL, `synchronous=FULL` y claves foráneas. Las pruebas comprueban recuperación tras cierre y apertura; no equivalen a una prueba de corte eléctrico real.

La inscripción interna exige una clave Ed25519 canónica y zona habilitada. La API valida el código de participación y un reto firmado de un solo uso antes de invocarla. El límite predeterminado es de 1.000 participantes. La bandeja y el detalle privado están acotados a 100 comandos o destinatarios por página; los contadores incluyen el conjunto completo. Cada destinatario conserva hasta 100 respuestas por solicitud. Se conserva historial durante 30 días después de la ventana tardía, mediante poda explícita; aún no existe programación automática de retención.

La revocación de un participante bloquea futuras entregas y respuestas. Al abrir el almacén con una autoridad revocada también se bloquean sus comandos pendientes. Un cliente desconectado no puede conocer una revocación nueva: su confianza local solo puede actualizarse al recibir configuración verificada. La caducidad limita esa exposición, pero no ofrece revocación instantánea offline.

Los eventos `x-coluvi-*` no participan en los agregados, filtros ni supresión pública. Sin configuración explícita, el servidor rechaza esos paquetes. Con el servicio privado habilitado, acepta respuestas firmadas de destinatarios inscritos sin requerir un token del transporte; bandeja y recibos sí exigen credenciales. Así la respuesta puede usar la cola y adaptadores existentes sin hacer pública la información operativa.

## Evidencia y trabajo pendiente

`ColuviAuth` implementa verificadores de contraseña con scrypt, sesiones de hasta una hora y un máximo de ocho sesiones activas, tokens aleatorios, validación CSRF y cierre de sesión. Los intentos de acceso están limitados por ventana global y origen de red. Los retos de inscripción caducan a los dos minutos, tienen capacidad acotada y se consumen al intentar completar una prueba de posesión. La API comprueba Host, Origin y CSRF, emite cookies Secure/HttpOnly/SameSite y registra accesos. Credenciales móviles persistidas como hashes caducan a los siete días; la sesión operativa y los retos se invalidan al reiniciar. Las rutas e instrucciones están en [Reference API](../REFERENCE_API.md).

El service worker v7 solo almacena recursos explícitos del shell móvil; no intercepta las APIs ni el panel. Elimina sus cachés de versiones anteriores sin borrar cachés ajenos. Las solicitudes de recursos con Authorization no se almacenan. Los endpoints privados usan `no-store`; se requiere el cliente actualizado antes de habilitar el piloto operativo.

`examples/coluvi-command-vector.json` fija identidad ficticia, huella, campos y firmas. Las pruebas de contrato comparan ese vector y verifican interoperabilidad Node/navegador, falsificación, revocación, ámbito, vigencia y conservación del vector v0.1. Las pruebas del almacén cubren destinatarios fijos, paginación, duplicados, conflictos, nonces repetidos, respuestas tardías y fuera de orden, recibos, reinicio, preservación de reportes, capacidad e integridad SQLite.

La prueba HTTP real recorre acceso del operador, inscripción con firma del navegador, solicitud, bandeja, recibos y respuesta NEEDS_HELP. Verifica persistencia al reiniciar, aislamiento entre zonas, rechazo de dispositivos no inscritos, ausencia de datos privados en APIs públicas y generación sin sobrescritura ni secretos en stdout. Las nuevas pruebas de la cola exigen evidencia BACKEND correlacionada antes de marcar SYNCED. El acuse backend es estructurado, no una firma independiente: el HTTPS confiable autentica la respuesta del servidor.

Validación del 4 de octubre en Ubuntu WSL2 con Node 24.18.0: `node --test tests/*.test.ts` aprobó 154 pruebas, sin fallos ni omisiones. La prueba HTTP incluye reinicio y persistencia. Un nuevo smoke real en Chromium, con perfil temporal y todo el backend de prueba detenido durante la desconexión, verificó recarga del shell, QUEUED offline y SYNCED después de reconectar con la nueva validación del acuse, sin errores de página. Ese smoke cubre el reporte existente, no una interfaz de check-in todavía pendiente ni Android físico.

Este bloque implementa contratos, persistencia, configuración privada y APIs; aún no permite completar el ciclo desde la interfaz. Continúan pendientes migración IndexedDB, inscripción y bandeja visibles, panel, simulacro bidireccional y pruebas reales en Samsung. Los avisos operativos y el mapa geográfico siguen como ampliaciones posteriores al ciclo principal.
