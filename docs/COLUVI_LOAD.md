# Carga y recuperación de Coluvi

Este ensayo mide el recorrido HTTP local y la persistencia SQLite con dispositivos ficticios. Comprueba qué eventos confirmados sobreviven a una interrupción abrupta del backend y si la entrega desordenada o repetida cambia incorrectamente el estado vigente. No mide teléfonos, radio ni capacidad de atención humana.

## Repetir el ensayo

Desde Ubuntu en WSL2, con Node 22.18 o posterior:

```bash
node examples/coluvi-load.mjs 300 24 20261004 nuevo-informe.json
# Perfil ampliado, con dos páginas de destinatarios por zona:
node examples/coluvi-load.mjs 600 32 20261005 otro-informe.json
```

Los argumentos son dispositivos, solicitudes concurrentes, semilla y archivo nuevo de salida opcional. El JSON también se imprime en stdout; el progreso aparece en stderr. El archivo no puede existir. Se admiten de 30 a 990 dispositivos en múltiplos de 30 y de 2 a 64 solicitudes simultáneas. La ejecución tiene un límite de veinte minutos. No instala paquetes, cambia el firewall ni utiliza datos del piloto.

Cada ejecución crea su propia configuración privada, SQLite, puerto loopback y procesos temporales. Solo interrumpe su backend y elimina su directorio temporal al finalizar. Las identidades se derivan de material público reproducible: son exclusivamente de prueba y nunca deben usarse en un piloto.

## Secuencia y criterios

Tres zonas reciben la misma cantidad de destinatarios. El 10 % no responde; el resto guarda NEEDS_HELP y una actualización. El resultado previsto es 40 % SAFE, 50 % NEEDS_HELP y 10 % PENDING mientras siga abierto el plazo inicial. PENDING no se interpreta como peligro. Quienes siguen necesitando ayuda declaran agua y transporte; las cantidades de personas declaradas no se suman entre dispositivos.

El ensayo entrega primero las actualizaciones, luego los detalles de necesidades y al final las respuestas iniciales. Comprueba todas las páginas de destinatarios: el antecedente aparece como faltante antes de llegar y como vinculado después. Los detalles históricos de quien ya declaró SAFE permanecen almacenados, pero no contribuyen a las necesidades actuales.

El primer SIGKILL ocurre después de recibir acuses válidos, con solicitudes HTTP aún pendientes. El proceso padre conserva el registro de acuses observados. Tras confirmar la muerte del backend, abre SQLite, ejecuta `integrity_check` y `foreign_key_check`, y compara íntegramente cada reporte firmado confirmado. También informa eventos persistidos cuyo acuse no alcanzó a observarse; no los clasifica automáticamente como perdidos.

Después del reinicio se reintenta lo no confirmado. Se comprueba la invalidación de la sesión del operador y, por muestreo, la supervivencia de una credencial móvil por zona. Tras confirmar todos los eventos se provoca otro SIGKILL. Se verifica de nuevo su persistencia y se reenvía el conjunto completo: cada respuesta debe ser DUPLICATE y las proyecciones privadas completas deben permanecer idénticas, incluidos historiales y fechas de recepción.

Los límites de producción permanecen en 600 solicitudes por minuto globales y 60 por identidad. Los rechazos 429 no pueden contener evidencia de custodia; el cliente respeta tanto `retryAfterMs` como `Retry-After`. Dos controles negativos comprueban que un reporte de otra zona y una firma alterada se rechacen sin acuse. Al final, los eventos privados no deben aparecer en el agregado público.

## Resultados guardados

La ejecución de 300 dispositivos del 4 de octubre de 2026 está en [el informe JSON](coluvi-load-300-20261004.json). Usó Node 24.18.0, Ubuntu WSL, tres zonas y 24 solicitudes concurrentes. Confirmó 810 eventos únicos y 810 duplicados en el reenvío; hubo 48 rechazos de admisión con reintento respetado. Tras el segundo corte, los 810 eventos confirmados seguían almacenados y la integridad SQLite era correcta.

La duración total observada fue 131,23 segundos. Entre las 1.620 solicitudes exitosas, la mediana fue 59,74 ms y el percentil 95 fue 218,26 ms. Esas latencias excluyen la espera en cola y las pausas impuestas por admisión; el tiempo total sí las incluye. Son observaciones de esta máquina y ejecución, no objetivos de servicio ni una estimación para Android. Otras pruebas pueden compartir recursos de la computadora.

El informe incluye fecha UTC, versión de Node, parámetros y SHA-256 del código del ensayo. La semilla fija identidades y barajado, pero no fija los identificadores aleatorios de eventos, el planificador del sistema, las latencias o la frontera exacta de confirmación del corte. Lo repetible son el escenario y sus invariantes, no una duración idéntica.

El [perfil de 600 dispositivos](coluvi-load-600-20261004.json), con semilla 20261005 y concurrencia 32, también aprobó: 1.620 eventos únicos, 1.620 duplicados durante el reenvío y 128 rechazos 429 respetados. Conservó todos los eventos confirmados tras el segundo corte. Verificó las dos páginas de 100 destinatarios de cada zona, tanto con antecedentes faltantes como después de completarlos. El resultado fue 240 SAFE, 300 NEEDS_HELP y 60 PENDING, sin multiplicar dispositivos por sus historiales. Duró 259,86 segundos; la mediana de solicitud exitosa fue 81,70 ms y el percentil 95, 334,46 ms. Estas ejecuciones no constituyen una prueba de capacidad máxima.

## Límites de la evidencia

- Son clientes sintéticos de Node, no cientos de ventanas PWA o teléfonos reales.
- La inscripción inicial se prepara directamente en el almacén de prueba; no se mide rendimiento de inscripción HTTP.
- Se utiliza HTTP loopback. No se miden LAN, Internet, TLS, BLE, LoRa, alcance o batería.
- SIGKILL del backend no equivale a cortar la energía del equipo ni a fallar el disco.
- El registro del cliente permanece en la memoria del proceso padre. La recuperación de IndexedDB y ventanas PWA se verifica por separado en Chromium.
- El perfil base no incluye avisos operativos. El nuevo [perfil mixto de RC2](COLUVI_RC2.md) añade emisión y lecturas de avisos, junto con métricas por endpoint y del proceso. La presentación y los recibos se verifican también en el recorrido integrado de navegador.

## Calificación completa con un comando

```bash
COLUVI_CHROMIUM_PATH=/ruta/al/chromium \
  node scripts/qualify-coluvi.mjs /tmp/coluvi-calificacion-nueva
```

El comando exige Ubuntu WSL y un Chromium ya instalado. Crea exclusivamente una carpeta nueva y ejecuta, en orden, la suite completa con concurrencia de dos archivos, seis simulacros con cronología, el recorrido integrado mapa–PWA–panel, la continuidad del cliente desde RC1, doce combinaciones de pantalla e idioma con texto normal y ampliado, la prueba específica del mapa offline, un ensayo sostenido breve y la carga base de 300 dispositivos. Cada etapa conserva stdout y stderr en archivos privados. Un fallo detiene la calificación y genera `qualification-failed.json`; solo después de aprobar todas las etapas se crea `qualification.json` con estado PASS. El ensayo breve no sustituye el criterio independiente de tres horas reales de RC2; tampoco sustituye sus perfiles de carga mixta.

El informe final identifica el commit base, si había cambios locales y una huella del contenido de `src`, `tests`, `scripts`, `examples` y `package.json`. Si esos archivos cambian durante la ejecución, no se emite PASS. La huella no cubre documentación ni convierte un árbol con cambios locales en un commit publicado. Los límites de cada etapa y las señales de cancelación afectan solo al grupo de procesos creado por esa etapa.

La calificación acredita el recorrido de software probado. No sustituye el piloto físico en Samsung ni certifica el sistema para emergencias reales.

## Calificación conservada del commit publicado

La [calificación de la versión candidata](coluvi-qualification-20261004-release.json) registra PASS para el código `878a37c3d18957f39f06d71bf897eaa21ed8c0e7`: 204 pruebas y las cuatro etapas aprobadas en 223,30 segundos. Añade evidencia de documento nuevo tras cada recarga del mapa y de la PWA, y una consulta retenida que comprueba que el panel deshabilita los botones de emisión mientras está ocupado. El [CI de ese código](https://github.com/raulprtech/emergency-mesh/actions/runs/37241725818) también aprobó. La huella del informe permite comprobar que una revisión posterior de documentación no alteró el código probado.

Como antecedente, el [informe anterior del 4 de octubre](coluvi-qualification-20261004.json) registra PASS para `755466d039c1bbac26a4746fb9fda7ac40715b39`, con árbol limpio al iniciar. Pasaron 203 pruebas, el recorrido integrado, la prueba específica del mapa y la carga de 300 dispositivos. La ejecución conjunta de esas cuatro etapas duró 227,45 segundos. El [CI de GitHub de ese commit](https://github.com/raulprtech/emergency-mesh/actions/runs/37240329269) también terminó con éxito; es evidencia adicional distinta de la ejecución local en Ubuntu WSL. La revisión final reforzó las comprobaciones de recarga y corrigió una carrera de los formularios que ese informe anterior no demostraba resuelta.

Una ampliación posterior a 990 dispositivos y concurrencia 48 terminó por timeout HTTP de diez segundos mientras se ejecutaban otras verificaciones. Ese intento no se incluye entre los perfiles aprobados. Se conservó el timeout y se añadió diagnóstico de ruta, fase y acuses observados. No se estableció la causa del fallo ni se garantiza capacidad bajo carga adicional de la máquina.

La [repetición aislada de 990 dispositivos](coluvi-load-990-20261004.json), con la misma concurrencia y semilla 20261006, aprobó sin ampliar plazos: 2.673 eventos únicos confirmados y conservados tras el segundo corte, 2.673 duplicados en el reenvío y 384 rechazos de admisión respetados. Comprobó cuatro páginas por zona, incluida la última de 30 destinatarios. El resultado fue 396 SAFE, 495 NEEDS_HELP y 99 PENDING. Duró 509,27 segundos; la mediana de solicitud exitosa fue 140,69 ms y el percentil 95, 448,79 ms. Se ejecutó sin otras baterías de pruebas lanzadas por este trabajo; no se afirma que el equipo estuviera libre de toda actividad externa. El contraste con el intento fallido impide presentar esta cifra como capacidad garantizada o máxima.
