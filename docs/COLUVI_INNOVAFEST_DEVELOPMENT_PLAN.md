# Plan de desarrollo de Coluvi para InnovaFest Mérida

Preparado el 2 de octubre de 2026. Este plan organiza el trabajo pendiente para presentar un prototipo verificable de comunicación resiliente ante huracanes e inundaciones. La categoría elegida es Sostenibilidad ambiental y cambio climático. La contribución propuesta es adaptación y resiliencia comunitaria, no reducción de emisiones ni predicción de desastres.

La referencia de producto es `Coluvi_documento_maestro_v0.1.md`, proporcionada por Raúl, especialmente sus secciones 6, 9, 11, 16, 19, 24 y 25. Este documento concreta su siguiente etapa, sin declarar terminado el producto completo ni autorizar registros, contactos, compras o despliegues externos.

## Avance verificado del bloque autónomo

El primer bloque del 4 de octubre implementó el ciclo autorizado de inscripción, bandeja, respuesta mínima offline, recuperación al reabrir, panel privado y treinta ciclos ficticios; en ese hito pasaron 166 pruebas. El bloque ampliado añadió mapa geográfico offline, avisos firmados, cambios de estado con historial, necesidades independientes, revocación y herramientas de respaldo y recuperación. La suite posterior pasó 204 pruebas. Los ensayos HTTP medidos con 300, 600 y 990 dispositivos ficticios verificaron concurrencia, mensajes desordenados, cortes abruptos y reenvío completo. El perfil de 990 aprobó en una ejecución aislada tras un timeout con pruebas concurrentes; no se presenta como capacidad garantizada.

La [guía de demostración](COLUVI_DEMO.md), la [guía de carga](COLUVI_LOAD.md) y el [estado del bloque ampliado](COLUVI_EXPANDED_BLOCK.md) contienen los recorridos, resultados y criterios de cierre. La [preparación de RC2](COLUVI_RC2.md) añade preflight, diagnóstico privado seguro, simulacros con checkpoints, recuperación del navegador y comparación instrumentada de carga; su calificación de software aprobó 225 pruebas. Sus criterios de cierre y la observación prolongada se siguen en ese registro. No se declaran completos los hitos físicos ni la postulación: siguen pendientes Samsung/LAN, transporte por radio y evidencia presencial. La línea base y el calendario siguientes conservan el contexto del plan original del 2 de octubre; no deben confundirse con un inventario actualizado de funciones faltantes.

## Objetivo de la entrega

Demostrar dos recorridos reproducibles:

1. Una persona crea un reporte sin conexión; el teléfono lo conserva y lo sincroniza al recuperar una ruta. El backend deduplica y el mapa muestra información agregada.
2. Un operador autorizado emite una solicitud de estado; un teléfono alcanzable presenta «¿Estás bien?» y devuelve SAFE o NEEDS_HELP. El panel conserva historial y diferencia falta de respuesta de evidencia de peligro.

El caso de demostración será un refugio o comunidad ficticia de Yucatán durante un simulacro de inundación. La red local continuará funcionando aunque se interrumpa su salida a Internet. La prueba entre teléfonos por mesh seguirá identificada como simulada hasta contar con evidencia física.

## Línea base verificada

Inspección del repositorio en el commit `16fa568`, rama `agent/physical-transport-feasibility`. El 2 de octubre se ejecutó `node --test tests/*.test.ts` con Node 24.18.0: 125 pruebas aprobadas, cero fallos y cero omitidas. No sustituye una prueba manual de Android ni una nueva ejecución de los smoke tests de navegador.

| Componente | Disponible | Pendiente para esta entrega |
|---|---|---|
| Protocolo | Reportes firmados, CBOR y JSON, expiración, fragmentación | Semántica y validación del check-in y los avisos |
| Persistencia | IndexedDB móvil y backend SQLite, deduplicación | Bandeja de entrada, comandos, acuses y proyección de estados |
| PWA | Acciones de ayuda, estado propio y terceros, cola offline | Recepción, respuesta inmediata y recuperación de solicitudes |
| Backend | Ingesta, límites, HTTPS local y agregación pública | Autorización operativa y APIs privadas acotadas |
| Vista pública | Tarjetas de zonas agregadas | Representación geográfica y actualización controlada |
| Simulador | Nodos, pérdidas, energía, multipath y conectividad | Escenario climático bidireccional y métricas exportables |
| Radio físico | Frontera de integración y banco Meshtastic preparados | Ningún dispositivo validado; Bitchat sigue pendiente |

No se reemplazarán las colas, el protocolo base ni el backend por una plataforma nueva. El núcleo mantiene Apache 2.0 y las integraciones opcionales conservan sus fronteras de licencia.

## Plazos y supuestos

El PDF del premio indica cierre el 16 de octubre de 2026 a las 23:59, CDMX, y ceremonia el 6 de noviembre. La web publica cierre el 26 de octubre y ceremonia el 4 de noviembre. Trabajaremos con el plazo más corto y objetivo interno del 14 de octubre mientras Raúl confirma las fechas. Fuentes consultadas el 2 de octubre: [bases del premio](https://innovafest.mx/files/Convocatoria-MERIDA.pdf) y [página del premio](https://innovafest.mx/premio-innovacion-mexicana).

La exhibición tiene un registro distinto y sus bases consultadas anteriormente publican cierre el 4 de octubre. Si se desea participar, resolverlo inmediatamente y verificar vigencia en la plataforma; no esperar a terminar nuevas funciones. [Bases de exhibición](https://innovafest.mx/files/Convocatoria-Exhibicion-Merida-SUBPAG.pdf).

El calendario es una estimación de trabajo concentrado de Codex con apoyo de Raúl para pruebas físicas. Supone una computadora, al menos un Android disponible desde el inicio, acceso a una red local y un segundo teléfono antes del simulacro. Si el trabajo arranca más tarde, se reduce alcance; no se presupone una prórroga.

Todo desarrollo y pruebas locales se ejecutarán en la distribución Ubuntu de WSL2, nunca UbuntuPreview. Claves, certificados y bases de prueba permanecerán en el filesystem de Ubuntu y fuera de Git. La IP previamente comunicada, `192.168.1.182`, debe volver a comprobarse antes de generar certificados o abrir la PWA.

## Alcance y prioridades

P0 significa imprescindible para el ciclo bidireccional seguro; P1, necesario para demostrar y medir; P2, posterior o condicional.

| Prioridad | Entregable | Dependencia |
|---|---|---|
| P0 | Piloto HTTPS reproducible y línea base | Equipo y red local |
| P0 | Contrato de comandos, confianza y respuestas | Decisiones de protocolo |
| P0 | Persistencia y autorización del centro | Contrato y configuración de claves |
| P0 | Recepción y check-in en la PWA | API y persistencia móvil |
| P1 | Panel y mapa geográfico agregado | APIs autorizadas y agregación |
| P1 | Simulador bidireccional y pruebas Android | Recorridos completos |
| P1 | Evidencia y versión reproducible | Pruebas y resultados registrados |
| P2 | Avisos adicionales y mejoras visuales | P0 estable |
| P2 | Experimento Meshtastic | Hardware disponible y tiempo separado |

Fuera del camino crítico: app nativa, BLE real, integración Bitchat, SMS, federación, credenciales de voluntarios, matching, alertas meteorológicas externas, IA, ARIA, Nigma y Ego. No habrá despacho automático, datos médicos, contactos personales ni ubicación exacta en este piloto.

## Arquitectura propuesta

La PWA y el panel compartirán el servidor HTTPS existente. La PWA consultará una bandeja acotada mientras esté abierta y conectada; conservará solicitudes recibidas en IndexedDB para responder después de perder conexión. Las respuestas usarán la cola de salida actual. Un comando que nunca llegó al teléfono no puede mostrarse allí durante una desconexión total.

El centro conservará comandos y evidencias en SQLite. El servicio de autoridad validará permisos y firmará comandos; el servicio de check-in proyectará estados a partir de eventos sin modificar sus bytes firmados. El simulador reutilizará los contratos para transportar comandos y respuestas sobre enlaces mock.

| Área de código | Cambio previsto |
|---|---|
| `src/protocol` | Tipos, validadores, firma de dominio y vectores de comandos |
| `src/commands` nuevo | Autoridad configurada, solicitudes, avisos y estados derivados |
| `src/backend` y `src/storage` | Comandos, participación del piloto, acuses y auditoría |
| `src/server.ts` | Enrutamiento de endpoints nuevos y límites de acceso |
| `src/mobile-client` | Bandeja local, verificación, check-in, cola e idiomas |
| `src/web` | Panel privado y mapa público sin filtraciones |
| `src/simulator` y `examples` | Escenario de inundación y exportación de métricas |
| `tests` y `docs` | Contratos, regresión, ejecución y límites del piloto |

### Compatibilidad y semántica

Estas son decisiones propuestas para cerrar en el primer hito, no APIs ya implementadas:

- Mantener estable el vector v0.1 y los reportes actuales. Usar extensiones `x-coluvi-*` y un esquema propio versionado para transportar CHECKIN_REQUEST, CHECKIN_RESPONSE y OPERATIONAL_NOTICE mediante las colas actuales. Documentar el mapeo desde los nombres del maestro; no crear una versión incompatible silenciosamente.
- Separar comandos humanos de los ACK y anuncios de egress de `docs/CONTROL_MESSAGES.md`. La autenticación HMAC de un peer no habilita a emitir órdenes operativas.
- Definir `commandId`, incidente, emisor, ámbito, creación, vigencia, nonce y firma. Vincular la respuesta al comando, al seudónimo firmante y al instante observado.
- Preservar el comando original; retransmisiones cambian el envelope, nunca los campos firmados. Definir separación criptográfica de dominio y vectores compartidos entre Node y navegador.
- Distinguir expiración de la notificación de la ventana permitida para respuestas tardías. Registrar una respuesta tardía como tal, sin reactivar un comando vencido ni descartar el historial.
- Definir actualización de estado mediante un nuevo evento relacionado. Enriquecer una petición no modifica el reporte ya firmado ni cuenta como otra persona necesitada.
- SAFE y NEEDS_HELP son estados declarados del check-in; NEEDS_HELP no convierte toda respuesta en SOS. UNKNOWN es derivado después del plazo y no un evento de víctima. El UNKNOWN de egress sigue siendo un estado de transporte diferente.

### Confianza y privacidad del piloto

Usar un único centro y ámbitos de zona preconfigurados. Provisionar su clave pública por una configuración autenticada, por ejemplo un QR local cuya huella se verifica; un certificado HTTPS no prueba autoridad de emergencia. Mantener la clave privada del emisor en Ubuntu, con permisos restrictivos y nunca en el navegador ni en Git.

El operador tendrá acceso autenticado por sesión con caducidad. Incluir cookie Secure, HttpOnly y SameSite, verificación de origen y protección CSRF para mutaciones, límites de intentos y auditoría de creación. No colocar un token de administración en URLs o recursos JavaScript públicos.

Los teléfonos del ensayo se inscribirán voluntariamente en una zona ficticia y recibirán credenciales de participación acotadas. La bandeja no debe permitir enumerar otros dispositivos. Definir el conjunto destinatario al emitir una solicitud; no inferirlo a partir de población estimada ni de coordenadas antiguas.

Aceptar solo comandos con firma válida, emisor habilitado, tipo y zona autorizados y vigencia correcta. Los móviles verificarán también antes de mostrarlos. La proyección de check-in no confiará en una identidad no verificada: el modo sin firma puede seguir ofreciendo reportes generales con su aviso actual, pero no fingirá continuidad de un dispositivo inscrito.

El panel privado no será una habilitación de `/api/events`. No recolectar ubicación precisa ni abrir el contenedor cifrado hasta tener una política de destinatarios operativa. La vista pública conserva supresión de grupos pequeños; cualquier desglose por estado debe evitar reconstruir grupos suprimidos por diferencia. Exportar únicamente datos ficticios y métricas anonimizadas, sin credenciales.

### API candidata

| Ruta propuesta | Acceso y finalidad |
|---|---|
| `/command-center/` | Interfaz del operador; sin datos antes de autenticar |
| `POST /api/operator/checkins` | Crear solicitud dentro del ámbito permitido |
| `POST /api/operator/notices` | Emitir aviso de simulacro autorizado |
| `GET /api/operator/checkins/:id` | Historial, estados y métricas privadas |
| `/api/mobile/enrollment` | Inscripción limitada al piloto y prueba de posesión de clave |
| `GET /api/mobile/inbox` | Comandos del ámbito autorizado, paginados y con cursor |
| `POST /api/mobile/receipts` | Evidencia correlacionada de recepción o presentación |
| `POST /api/packets` existente | Reportes y respuestas a través de la cola actual |
| `GET /api/areas` existente | Agregados públicos sujetos a la política de privacidad |

Métodos, cuerpos, límites y errores se cerrarán en el contrato. Recibido, mostrado y respondido son evidencias distintas; ninguna significa ayuda despachada. Los recibos móviles requieren autenticación y protección contra repetición, no un identificador arbitrario enviado por el cliente.

## Hitos de implementación

### Hito 0 Estabilizar el piloto

Ventana objetivo: 2 al 3 de octubre. Responsable técnico: Codex; equipo y prueba presencial: Raúl.

- Verificar Node, suite existente, modo SQLite y salud del servidor.
- Comprobar IP actual, acceso desde Android y certificado vigente. Generar material nuevo solo si corresponde, sin sobrescribir claves existentes ni bajar la validación TLS.
- Instalar la PWA, ejecutar el recorrido offline y registrar modelo, Android, navegador y red. Separar base de simulacro de datos anteriores; no borrar datos existentes.
- Documentar arranque y parada en Ubuntu. Registrar smoke de navegador disponible y lo que no pudo ejecutarse.

Aceptación: un reporte ficticio permanece en cola al perder la red, obtiene evidencia BACKEND al volver y sigue almacenado tras un reinicio limpio. Sin advertencias de certificado ni exposición de reportes crudos.

### Hito 1 Cerrar contratos y autoridad

Ventana objetivo: 3 al 4 de octubre. Dependencia: hito 0.

- Escribir ADR y especificación de comandos, respuestas y compatibilidad.
- Definir claves autorizadas, zonas, plazos, destinatarios y regla de respuestas tardías.
- Publicar vectores deterministas y validadores Node y navegador.
- Preparar pruebas negativas de firma, replay, vigencia, ámbito, tamaño y emisor revocado.

Aceptación: los vectores nuevos coinciden entre implementaciones y el vector v0.1 existente permanece idéntico. Un comando sin autorización no puede crear un prompt ni un estado operativo confiable.

### Hito 2 Persistir y exponer el ciclo operativo

Ventana objetivo: 4 al 6 de octubre. Dependencia: hito 1.

- Añadir tablas con migración aditiva: comandos, destinatarios, recibos, proyección y auditoría. Conservar los reportes y la evidencia existente.
- Implementar autorización, endpoints limitados y política de retención.
- Proyectar estado por solicitud y seudónimo. Duplicados y reinicios no generan nuevas respuestas ni reinician el plazo de UNKNOWN.
- Emitir un aviso libre marcado SIMULACRO; no simular confirmación de un equipo real ni recomendaciones de evacuación operativas.

Aceptación: creación autorizada, rechazo de creación anónima o fuera de zona, aislamiento entre destinatarios y recuperación consistente de estado tras reiniciar. Los endpoints públicos no revelan sujetos o comandos privados.

### Hito 3 Completar recepción y respuesta móvil

Ventana objetivo: 6 al 8 de octubre. Dependencia: hito 2.

- Migrar IndexedDB sin perder outbox ni identidad, con bandeja, recibos y versión de esquema.
- Consultar comandos con backoff mientras la aplicación esté abierta; verificar autoridad y deduplicar prompts.
- Mostrar las dos respuestas inmediatas. Persistir y firmar la señal mínima antes de pedir datos adicionales; respetar el consentimiento de ubicación.
- Permitir responder a una solicitud ya almacenada estando offline. Mantener manual sync y recuperación al volver a abrir.
- Añadir español e inglés, foco accesible y mensajes claros sobre recepción y expiración.

Aceptación: un comando recibido online sigue disponible offline; una respuesta sobrevive al cierre y solo avanza a SYNCED con evidencia backend. Repetir la consulta no vuelve a molestar al usuario. No se garantiza recepción en segundo plano con la PWA cerrada.

### Hito 4 Mostrar el mapa y el panel

Ventana objetivo: 8 al 9 de octubre. Dependencias: hitos 2 y 3.

- Añadir región ficticia del simulacro, celdas públicas, leyenda, antigüedad y filtros de necesidades. Los colores indican reportes recibidos, no intensidad medida de inundación.
- Incluir mapa de respaldo local con geometría simplificada y licencia documentada, para no depender de descargar tiles durante el corte de Internet.
- En el panel, mostrar solicitados, recibidos, mostrados, respuestas, SAFE, NEEDS_HELP y UNKNOWN. Separar no alcanzado de no respondido.
- Etiquetar unidades como dispositivos o respuestas, no personas. Conservar alternativa en lista para accesibilidad y fallos gráficos.

Aceptación: la demostración funciona sin servicios cartográficos remotos, respeta la agregación pública y no expone datos privados por filtros, URLs, caché o exportaciones.

### Hito 5 Validar el simulacro y registrar resultados

Ventana objetivo: 9 al 11 de octubre. Dependencias: hitos anteriores.

- Añadir un escenario determinista de refugio, nodos aislados, gateway intermitente, solicitudes y respuestas. Reutilizar el formato de escenarios actual.
- Ejecutar al menos 30 ciclos ficticios en condiciones documentadas, incluyendo desconexión total, LAN sin Internet, reinicio y duplicados. Separar latencia durante disponibilidad de la demora impuesta por el corte.
- Probar con dos Android si están disponibles y objetivo de cinco participantes adultos voluntarios. Si no se consigue, registrar el tamaño real y no declarar validación comunitaria.
- Capturar una demo y elaborar resultados, fallos, limitaciones y comentarios de uso. No realizar pruebas en una emergencia real ni enviar alertas a personas ajenas al ensayo.

Aceptación: dos recorridos completos y reproducibles, datos ficticios, pruebas negativas aprobadas y evidencia que distingue hardware real, red local y simulación. La demostración no demuestra alcance BLE o LoRa.

### Hito 6 Congelar la versión y preparar la entrega

Ventana objetivo: 12 al 14 de octubre. Dependencia: hito 5.

- Congelar funcionalidades el 12 de octubre; corregir solo fallos que afecten seguridad, demostración o integridad.
- Registrar versión, commit, configuración sin secretos, comandos y resultados. Preparar notas de entrega e instrucciones de reproducción.
- Preparar expediente y video con los avances realmente verificados; Raúl revisa autoría, datos y aprobación final. El premio exige PDF de máximo cinco cuartillas y video MP4 de máximo tres minutos y 150 MB. [Bases del premio](https://innovafest.mx/files/Convocatoria-MERIDA.pdf).
- Resolver fase de desarrollo con la evidencia y los organizadores, no por número de pruebas o cantidad de código. Previsualizar y guardar comprobante si Raúl autoriza la postulación.

Aceptación técnica: otra persona puede repetir la demo desde un checkout limpio con instrucciones. Aceptación administrativa: expediente revisado; enviar sigue requiriendo aprobación, no está autorizado por este plan.

## Métricas y pruebas de aceptación

Estos valores son objetivos de ensayo, no resultados ni garantías para uso real.

| Métrica | Cómo medir | Objetivo de aceptación propuesto |
|---|---|---|
| Conservación offline | Reportes persistidos y recuperados tras cierre | Ninguna pérdida en los casos ensayados |
| Recuperación de sincronización | Entregados frente a creados, antes de expiración | Todos los reportes del ensayo controlado, o fallo documentado y corregido |
| Deduplicación | Proyecciones frente a copias recibidas | Un estado por respuesta, sin doble conteo |
| Latencia LAN | Mediana y p95 desde creación hasta ACK backend | Reportar ambas; investigar p95 mayor de 5 segundos con red disponible |
| Recepción del check-in | Emitido hasta mostrado con PWA abierta | Investigar más de 15 segundos en LAN disponible |
| Uso | Tiempo y errores para responder tras ver el prompt | Objetivo de menos de 15 segundos; registrar mediana y participantes |
| Autoridad | Comandos inválidos y fuera de ámbito | Cero aceptados en la matriz negativa |
| Privacidad | Respuestas de API, exportaciones y UI pública | Ningún dato individual o desglose que anule supresión |
| Recuperación | Reiniciar servidor y reabrir la PWA | Conservar historial y no duplicar prompts ni respuestas |

La tasa de respuesta usa como denominador dispositivos inscritos y destinatarios de una solicitud concreta. Mostrar por separado tasa entre destinatarios y tasa entre recepciones confirmadas. Un mismo dispositivo no representa necesariamente una persona; una misma persona puede usar varios dispositivos. Cero destinatarios no produce una tasa válida.

Agregar pruebas dedicadas de protocolo de comandos, autoridad, estados de check-in, persistencia, endpoints, bandeja móvil, evolución de IndexedDB, agregación y escenario climático. Ejecutar suite existente, demo, escenario nuevo, fuzz y smoke de navegador/accesibilidad disponibles. Añadir revisión manual de Android y teclado. No llamar certificación de seguridad o accesibilidad a esta batería.

## Riesgos y recortes

| Riesgo | Medida y decisión |
|---|---|
| Calendario menor al previsto | Congelar P0 antes de añadir avisos y diseño; no esperar el 26 sin confirmación |
| HTTPS o red WSL inaccesible | Resolver en hito 0; mantener grabación reproducible, sin eludir TLS |
| Comandos o autorización incompletos el 8 de octubre | No habilitarlos a usuarios reales; presentar el recorrido existente y su alcance real, o consultar alternativa de participación |
| Mapa consume tiempo | Usar geometría local simple y lista; posponer animaciones y tiles externos |
| No hay testers externos | Reportar prueba técnica interna, no un piloto institucional |
| Limitaciones de background | App abierta como condición del piloto; app nativa después |
| No hay radios | Mantener simulador y LAN; no comprar ni prometer radios por defecto |
| Datos sensibles | No capturarlos; revisar muestras y grabaciones antes de publicar |

Si no se completa el núcleo, se conserva la evidencia y se declara qué falta. No cambiar artificialmente la fase del proyecto ni presentar mock como validación física para encajar en la convocatoria.

## Responsabilidades y seguimiento

Codex implementará, verificará y documentará incrementos pequeños. Raúl aportará equipos, probará Android, organizará participantes y decidirá la postulación. Contactar a brigadas o refugios es una acción de Raúl o requiere autorización expresa; no hay alianzas confirmadas.

Mantener un commit por incremento coherente y actualizar documentación junto al contrato. Verificar tests y diff antes de publicar en el repositorio GitHub ya autorizado. No incluir `.data`, llaves, credenciales, certificados privados, grabaciones identificables ni bases reales. Etiquetar la versión demostrable solo después de validar el recorrido. Este turno prepara el plan; no ejecuta los hitos ni crea issues externos.

El avance se reportará por criterio de aceptación cumplido, bloqueo y siguiente paso, no mediante un porcentaje global estimado. Las pruebas físicas tienen fecha, modelo, condiciones y versión; los resultados de CI no las sustituyen.

## Continuación después de InnovaFest

1. Estabilizar el piloto con una organización voluntaria, política de datos y protocolos de simulacro.
2. Validar Meshtastic con el banco preparado si hay radios disponibles y configuración apropiada. La investigación del repositorio permite priorizarlo sobre Bitchat, aunque el maestro sugiera BLE primero; documentar la desviación por factibilidad.
3. Diseñar el cliente Android nativo como emisor y receptor, reutilizando protocolo y colas. Evaluar keystore, background y transporte real sin promesas de cobertura.
4. Incorporar avisos externos con procedencia y voluntariado con consentimiento cuando existan pruebas y aliados suficientes.

La postulación busca mostrar un núcleo útil y medible de adaptación comunitaria. Beneficios como mejor coordinación o menor demora son hipótesis que el piloto ayudará a evaluar; vidas salvadas, reducción de daños o ahorro económico no son resultados demostrados por esta entrega.
