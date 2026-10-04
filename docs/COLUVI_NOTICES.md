# Avisos operativos de simulacro

Estado del hito: contrato firmado, almacenamiento privado, API, panel y bandeja de la PWA integrados y verificados en Chromium. El bloque ampliado sigue abierto: actualización de estado, enriquecimiento, operación del piloto y pruebas de escala siguen siendo entregables independientes.

## Contrato

El evento `x-coluvi-operational-notice` conserva el sobre v0.1 y añade una carga Coluvi v1 de tipo `OPERATIONAL_NOTICE`. La firma Ed25519 del reporte y la firma de dominio `COLUVI/OPERATIONAL_NOTICE/v1` cubren sus campos. El aviso incluye identificador, incidente, emisor, zona, emisión, caducidad, etiqueta de fuente, título, mensaje, nivel `INFORMATION` o `WARNING`, nonce y `simulation: true`. Una carga con `simulation: false` no se acepta, incluso con firmas válidas.

La vigencia dura entre un segundo y 24 horas. Fuente, título y mensaje tienen límites de 120, 160 y 1.200 bytes UTF-8 respectivamente. No se admiten campos adicionales, coordenadas personales, datos de afectados ni necesidades. La fuente es una etiqueta firmada del emisor del piloto, no una certificación de pertenencia a una autoridad pública ni una garantía de veracidad. La futura interfaz debe mostrar por separado esa etiqueta, la identidad verificable del emisor, la caducidad y el carácter de simulacro.

La capacidad `CHECKIN_REQUEST` no autoriza avisos por sí sola. Se necesita `OPERATIONAL_NOTICE` provisionada explícitamente para la misma clave y zona. `authorityFor` continúa creando una autoridad solo de check-in por defecto; no se amplían permisos anteriores de manera implícita. Los verificadores de Node y navegador rechazan zonas distintas, autoridad desconocida o revocada, falta de capacidad, firmas alteradas, mensajes futuros y avisos caducados.

## Persistencia y evidencia

`NoticeStore` requiere que `ColuviStore` haya inicializado la base. Sus tablas aditivas `coluvi_notices`, `coluvi_notice_recipients` y `coluvi_notice_receipts` comparten los participantes existentes, no las tablas de reportes públicos. SQLite usa WAL, sincronización FULL y transacciones para conservar aviso, destinatarios y auditoría juntos.

Los destinatarios activos se fijan por zona al emitir. Un participante inscrito después no se añade retroactivamente. La bandeja tiene su propio cursor y devuelve solo avisos vigentes y autorizados. La paginación está limitada a 100 elementos y el almacén a 5.000 avisos conservados. No se pierden datos para admitir uno nuevo: la capacidad rechaza la escritura hasta una operación explícita de retención.

`x-coluvi-notice-receipt`, con dominio `COLUVI/NOTICE_RECEIPT/v1`, contiene evidencia `RECEIVED` o `SHOWN`, vinculada al aviso y firmada por el destinatario. Se comprueban la identidad autenticada, la clave del destinatario original, su estado activo, autorización del emisor y vigencia. No se cuenta dos veces el mismo tipo de evidencia de un dispositivo. `SHOWN` se genera cuando al menos el 25 % de la tarjeta entra en la pantalla de una página visible; no acredita lectura humana, comprensión ni asistencia. Sin IntersectionObserver no se inventa esa evidencia.

La recepción tardía de un recibo después de caducar el aviso se rechaza. La PWA conserva su evidencia local y la marca caducada sin fingir confirmación del servidor. La retención explícita elimina avisos, destinatarios y recibos 30 días después de su caducidad por defecto; preserva participantes y revocaciones. La auditoría compartida sigue su política existente. Todos los eventos `x-coluvi-*` siguen excluidos del mapa público.

## Configuración e interfaz

El generador de material nuevo provisiona `CHECKIN_REQUEST` y `OPERATIONAL_NOTICE`. Las configuraciones existentes siguen siendo válidas y mantienen sus capacidades originales: no se modifica ningún archivo privado ni se amplía una autoridad antigua al arrancar. El panel oculta el formulario de avisos si la configuración no los autoriza; la API también rechaza su emisión. Un cliente con confianza antigua de solo check-in no consulta ni acepta avisos hasta que el operador provisione explícitamente un archivo público de confianza adecuado. No basta con que el servidor envíe una capacidad nueva en la bandeja.

Después de inscribir participantes, el operador completa «Emitir aviso de simulacro»: incidente, zona, fuente declarada, título, mensaje, tipo y vigencia. La confirmación de simulacro es obligatoria. Ante una respuesta POST perdida, el panel no reemite automáticamente: hay que consultar la lista antes de reintentar. Los avisos recientes incluyen conteos y detalle privado de destinatarios; al cerrar sesión se eliminan de la vista junto con el borrador.

La PWA conserva el aviso y su recibo RECEIVED en una transacción, antes de avanzar su cursor independiente. La migración IndexedDB v3 añade `notices` sin borrar identidad, outbox, solicitudes ni recibos anteriores. Admite hasta 200 avisos locales y elimina explícitamente los que superan 30 días después de su caducidad. El worker v9 precarga el código nuevo; ninguna API privada entra en Cache Storage. Si falla la escritura o cambia la credencial durante la consulta, el cursor no avanza.

Cada tarjeta muestra SIMULACRO, texto literal —nunca HTML ejecutable—, fuente declarada, identidad firmante, zona, emisión y caducidad. Una copia vencida se conserva como historial claramente marcado CADUCADO, no como una instrucción vigente. La presentación depende del reloj local; una revocación de autoridad aún desconocida por un cliente aislado no puede propagarse por magia: su confianza debe actualizarse por el canal de provisión. La PWA no garantiza recepción con la aplicación cerrada. Los recibos se sincronizan mientras está abierta y dispone de ruta al centro; la firma no implica entrega.

## Evidencia reproducible

```bash
node --test tests/coluvi-notices.test.ts tests/coluvi-notice-store.test.ts
node --test tests/coluvi-api.test.ts tests/coluvi-inbox.test.ts tests/operator-view.test.ts
COLUVI_CHROMIUM_PATH=/ruta/al/chromium node examples/coluvi-browser-smoke.mjs
```

La suite completa pasó 185 pruebas en Ubuntu WSL2 el 4 de octubre de 2026 (`node --test --test-concurrency=2 tests/*.test.ts`), sin fallos, cancelaciones ni omisiones. Además del contrato y SQLite, cubre permisos antiguos, CSRF/origen, tipos y límites de texto, cursor independiente, fallo de disco, reloj adelantado, rotación de credenciales y recuperación de un recibo nuevo aunque existan más de 400 recibos ya sincronizados.

Chromium 151 verificó migración desde v1 y desde una base v2 con comandos y recibos previos a v3, emisión por formulario, recepción y presentación, texto literal, backend detenido durante la recarga offline, cierre y reapertura, recuperación de los cuatro recibos de check-in y aviso después de reiniciar, etiqueta de caducidad, aislamiento de caché y limpieza de sesión. El aviso contó un destinatario, una recepción y una presentación: no se suman como tres personas. También pasaron las regresiones anteriores de reporte offline y accesibilidad. Estos resultados no sustituyen una prueba física en los Samsung.
