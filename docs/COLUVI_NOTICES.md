# Avisos operativos de simulacro

Estado del hito: contrato firmado y almacenamiento privado implementados y verificados. **Todavía no están conectados a la API, el panel ni la bandeja de la PWA.** Esta base no se presenta como una función terminada para participantes. El bloque ampliado sigue abierto.

## Contrato

El evento `x-coluvi-operational-notice` conserva el sobre v0.1 y añade una carga Coluvi v1 de tipo `OPERATIONAL_NOTICE`. La firma Ed25519 del reporte y la firma de dominio `COLUVI/OPERATIONAL_NOTICE/v1` cubren sus campos. El aviso incluye identificador, incidente, emisor, zona, emisión, caducidad, etiqueta de fuente, título, mensaje, nivel `INFORMATION` o `WARNING`, nonce y `simulation: true`. Una carga con `simulation: false` no se acepta, incluso con firmas válidas.

La vigencia dura entre un segundo y 24 horas. Fuente, título y mensaje tienen límites de 120, 160 y 1.200 bytes UTF-8 respectivamente. No se admiten campos adicionales, coordenadas personales, datos de afectados ni necesidades. La fuente es una etiqueta firmada del emisor del piloto, no una certificación de pertenencia a una autoridad pública ni una garantía de veracidad. La futura interfaz debe mostrar por separado esa etiqueta, la identidad verificable del emisor, la caducidad y el carácter de simulacro.

La capacidad `CHECKIN_REQUEST` no autoriza avisos por sí sola. Se necesita `OPERATIONAL_NOTICE` provisionada explícitamente para la misma clave y zona. `authorityFor` continúa creando una autoridad solo de check-in por defecto; no se amplían permisos anteriores de manera implícita. Los verificadores de Node y navegador rechazan zonas distintas, autoridad desconocida o revocada, falta de capacidad, firmas alteradas, mensajes futuros y avisos caducados.

## Persistencia y evidencia

`NoticeStore` requiere que `ColuviStore` haya inicializado la base. Sus tablas aditivas `coluvi_notices`, `coluvi_notice_recipients` y `coluvi_notice_receipts` comparten los participantes existentes, no las tablas de reportes públicos. SQLite usa WAL, sincronización FULL y transacciones para conservar aviso, destinatarios y auditoría juntos.

Los destinatarios activos se fijan por zona al emitir. Un participante inscrito después no se añade retroactivamente. La bandeja tiene su propio cursor y devuelve solo avisos vigentes y autorizados. La paginación está limitada a 100 elementos y el almacén a 5.000 avisos conservados. No se pierden datos para admitir uno nuevo: la capacidad rechaza la escritura hasta una operación explícita de retención.

`x-coluvi-notice-receipt`, con dominio `COLUVI/NOTICE_RECEIPT/v1`, contiene evidencia `RECEIVED` o `SHOWN`, vinculada al aviso y firmada por el destinatario. Se comprueban la identidad autenticada, la clave del destinatario original, su estado activo, autorización del emisor y vigencia. No se cuenta dos veces el mismo tipo de evidencia de un dispositivo. `SHOWN` será evidencia de presentación en la interfaz, no de lectura humana, comprensión ni asistencia. Hasta integrar el navegador, las pruebas solo acreditan el contrato y la persistencia de ese campo.

La recepción tardía de un recibo después de caducar el aviso se rechaza. La PWA deberá conservar su evidencia local y marcarla caducada sin fingir confirmación del servidor. La retención explícita elimina avisos, destinatarios y recibos 30 días después de su caducidad por defecto; preserva participantes y revocaciones. La auditoría compartida sigue su política existente. Todos los eventos `x-coluvi-*` siguen excluidos del mapa público.

## Evidencia y trabajo pendiente

```bash
node --test tests/coluvi-notices.test.ts tests/coluvi-notice-store.test.ts
```

Seis pruebas aprobadas en Ubuntu WSL2: verificadores Node/navegador, manipulación de campos y firmas, simulación obligatoria, límites temporales, destinatarios congelados, paginación, duplicados, recepción por otro dispositivo, revocación, cierre/reapertura de SQLite, integridad y retención.

Siguiente integración: ampliar configuraciones nuevas sin modificar secretos existentes; añadir rutas privadas y capacidades a la sesión; almacenamiento móvil aditivo con cursor propio; emisión y conteos en el panel; presentación verificada con fuente y caducidad; recibos generados solo después de custodia/presentación efectiva; y smoke real que incluya desconexión, reapertura y reinicio. Ninguno de esos puntos queda acreditado por las seis pruebas actuales.
