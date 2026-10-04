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

## Recorrido manual

1. Abre `http://127.0.0.1:8797/mobile/`. Expande «Inscribirme en el piloto Coluvi».
2. Importa únicamente `mobile-trust.json`, introduce la huella SHA-256 verificada por otro canal, una zona autorizada y el código de inscripción. Marca el consentimiento. El cliente demuestra posesión de su clave; no guarda el código.
3. Abre `http://127.0.0.1:8797/command-center/`. Inicia sesión con la contraseña del operador. Selecciona la misma zona, confirma que es un simulacro y emite la solicitud. Solo incluye dispositivos ya inscritos en ese instante.
4. Vuelve al cliente y consulta solicitudes mientras esté abierto y conectado. Tras recibir una solicitud válida, deja que su tarjeta entre en pantalla. RECEIVED y SHOWN se guardan como evidencias separadas y se sincronizan en consultas posteriores.
5. Detén el servidor con Ctrl+C. En el cliente, responde a la solicitud ya recibida. Debe conservarse en cola. Cierra la ventana y vuelve a abrirla dentro del plazo; no debe generar otra respuesta por repetir el clic.
6. Arranca el servidor con el mismo comando, configuración y base. Usa «Intentar sincronizar». SYNCED requiere un acuse BACKEND correlacionado, no solo HTTP exitoso.
7. El reinicio invalida la sesión del operador: vuelve a entrar y abre el detalle. Debe aparecer una única respuesta y su historial. Las credenciales móviles sobreviven al reinicio, salvo expiración, rotación o revocación.

La interfaz admite una primera respuesta por solicitud. El almacén conserva múltiples eventos válidos y ordenados, pero la edición posterior del estado todavía no tiene interfaz. SAFE no inscribe voluntarios y NEEDS_HELP no convierte automáticamente la respuesta en SOS. Las respuestas mínimas no contienen GPS, contactos ni texto libre.

## Plazos y falta de respuesta

El plazo de respuesta controla hasta cuándo se ofrece una nueva interacción. La ventana adicional permite entregar una respuesta firmada antes del plazo que seguía en cola; no reactiva preguntas vencidas. UNKNOWN se deriva después del plazo sin respuesta válida: no significa peligro, inconsciencia ni víctima.

Los contadores usan dispositivos, no personas. Recibidos, mostrados y respondidos pueden solaparse y no deben sumarse como categorías excluyentes. Las respuestas tardías se conservan sin borrar historial ni hacer retroceder una observación más reciente.

## Verificación automatizada

```bash
node --test tests/*.test.ts
COLUVI_CHROMIUM_PATH=/ruta/al/chromium node examples/coluvi-browser-smoke.mjs
node examples/coluvi-drill.ts 30 20261004
```

La prueba de navegador genera configuración, perfil y SQLite temporales propios. No modifica datos del piloto, no instala navegadores y no desactiva validación TLS. Usa HTTP loopback como contexto seguro de desarrollo; no equivale a un origen HTTPS confiable desde Android. Al terminar detiene sus procesos y elimina únicamente sus archivos temporales.

Verificación del 4 de octubre de 2026 en Ubuntu WSL2: 166 pruebas aprobadas, cero fallos, cancelaciones u omisiones. Chromium 151.0.7922.34 verificó migración real de IndexedDB v1 a v2 sin perder identidad ni reporte, inscripción y emisión desde las interfaces, backend completamente detenido durante la respuesta offline, cierre y reapertura de la ventana, QUEUED a SYNCED con evidencia BACKEND y recuperación de los dos recibos tras reiniciar. Consultar de nuevo una solicitud sin cambios conservó su tarjeta, sin reconstruir el aviso. El panel mostró una respuesta NEEDS_HELP, no dos, incluso al reenviar el mismo paquete. Ninguna API privada apareció en CacheStorage y el agregado público no incluyó el check-in. Cerrar sesión vació la vista privada. Ambas interfaces quedaron sin desbordamiento a 360 píxeles; el panel no tuvo controles interactivos sin nombre. Pasaron también las regresiones anteriores de reporte offline y accesibilidad móvil, sin diagnósticos de página.

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

La PWA recibe solicitudes mientras está abierta y tiene una ruta al centro. Una solicitud nunca recibida no aparece durante aislamiento total; no se garantiza recepción con la aplicación cerrada. Background Sync, si existe, intenta entregar respuestas ya firmadas, no recibir nuevas solicitudes. Continúan fuera de esta demostración la app nativa, BLE/Bitchat/LoRa reales, avisos operativos adicionales y el mapa geográfico nuevo. La vista pública actual conserva sus agregados y umbrales de privacidad.
