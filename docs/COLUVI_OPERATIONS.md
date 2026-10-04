# Operación y recuperación del piloto Coluvi

Esta guía sirve para administrar el simulacro desde Ubuntu WSL2, arrancarlo de forma reproducible y recuperar una copia sin sobrescribir el piloto existente. Los comandos trabajan con una carpeta privada que contiene `operator-config.json`, `mobile-trust.json` y, después del primer arranque, `pilot.sqlite`. No crean servicios automáticos ni cambian el firewall de Windows.

El prototipo no garantiza entrega ni atención. Un diagnóstico correcto de archivos no demuestra conectividad con los Samsung.

## Arrancar y diagnosticar

Usa Ubuntu, nunca UbuntuPreview. Los ejemplos asumen Node disponible como `node`; se verificaron con Node 24.18.0. Si ya tienes material del piloto, usa su ruta exacta y no vuelvas a generarlo sobre la misma carpeta.

```bash
cd /home/raulprtech/emergency-mesh
node scripts/coluvi-pilot.mjs diagnose .data/coluvi-dev-20261004
node scripts/coluvi-pilot.mjs start .data/coluvi-dev-20261004
```

Para crear otro simulacro, utiliza primero el generador de la [guía de demostración](COLUVI_DEMO.md). Este exige una carpeta nueva. El diagnóstico admite que aún no exista la base y lo informa como `NOT_CREATED`, sin crearla. Comprueba que la configuración y la confianza pública coincidan, los permisos, la integridad SQLite y las claves foráneas. Devuelve conteos y huella pública, no claves privadas, contraseñas, tokens ni identificadores de participantes. `network: NOT_PROBED` significa exactamente que no se probó la red.

El arranque toma origen y puerto de la configuración, comprueba que la dirección esté disponible y mantiene el servidor en primer plano. Ctrl+C detiene su proceso hijo; no busca ni termina otros servidores. La base nueva se crea con permisos privados. HTTP solo se permite en loopback. Para HTTPS se deben indicar explícitamente las rutas de certificado y clave, y una dirección de escucha válida:

```bash
node scripts/coluvi-pilot.mjs start .data/mi-piloto-https \
  --host 0.0.0.0 \
  --tls-cert .data/mi-tls/server-cert.pem \
  --tls-key .data/mi-tls/server-key.pem
```

Esas rutas son ejemplos, no material creado por este bloque. El certificado debe corresponder al origen configurado, a la clave y a la fecha actual. El comando no instala una CA, no desactiva TLS y no prueba la confianza del teléfono. Abrir acceso LAN exige completar por separado [Phone pilot](PHONE_PILOT.md). No se incluye arranque automático después de reiniciar Windows o WSL.

## Administrar participantes

Entra al centro de mando como operador. «Participantes del piloto» permite filtrar por zona autorizada y estado, y recorrer páginas de diez dispositivos. Muestra la fecha de inscripción y si la credencial está vigente, caducada, ausente o revocada; no revela claves ni tokens. Los conteos se refieren a las zonas consultadas y la paginación al filtro seleccionado.

Para revocar, comprueba el identificador y la zona en el diálogo, marca la confirmación y envía la acción. Cancelar antes de confirmar no modifica nada. Una vez enviado, no se ofrece cancelar como si pudiera deshacer la petición. Si se pierde la respuesta, consulta el estado antes de repetir; la interfaz no reenvía la mutación automáticamente. Repetir una revocación confirmada no agrega otra revocación a la auditoría.

Revocar elimina la credencial activa y bloquea futuras consultas, recibos y paquetes operativos del dispositivo, incluso después de reiniciar. No borra respuestas, necesidades, avisos ni destinatarios de solicitudes ya emitidas. El dispositivo queda excluido de solicitudes nuevas. No hay reactivación de esa misma identidad en este piloto: para participar de nuevo necesita otra identidad e inscripción. No se retiran copias offline ni se bloquean los reportes generales no operativos.

## Crear un respaldo

Elige una carpeta nueva fuera del piloto, dentro de una ubicación privada de Ubuntu:

```bash
node scripts/coluvi-pilot.mjs backup \
  .data/coluvi-dev-20261004 .data/coluvi-respaldo-01
```

El respaldo usa la API de copia online de SQLite. Puede tomar una instantánea coherente mientras el servidor mantiene datos confirmados en el WAL; no copia únicamente el archivo principal ignorando ese registro. Comprueba la integridad del resultado y guarda la configuración, la confianza pública, la base y `operator-secrets.txt` si existe. Los directorios quedan en 0700 y los archivos en 0600.

El manifiesto registra inicio y final de la operación, tamaños y hashes SHA-256. Los hashes detectan alteraciones accidentales; no son una firma que autentique un respaldo obtenido de un tercero. El contenido no está cifrado: incluye claves y posiblemente contraseñas. No lo subas al repositorio, no lo envíes al teléfono y no lo compartas como evidencia del concurso. Si necesitas protegerlo en otro disco, utiliza almacenamiento cifrado bajo tu control.

La carpeta de respaldo no debe utilizarse como una base en ejecución. El lanzador se niega a arrancarla directamente. Los certificados TLS, la CA, la clave TLS, el código del proyecto y la configuración de Windows no forman parte de este respaldo; conserva ese material por separado.

## Restaurar sin reemplazar el original

```bash
node scripts/coluvi-pilot.mjs restore \
  .data/coluvi-respaldo-01 .data/coluvi-restaurado-01
node scripts/coluvi-pilot.mjs diagnose .data/coluvi-restaurado-01
```

La restauración verifica el manifiesto, los hashes, la correspondencia de confianza y la integridad SQLite antes de aceptar la copia. Rechaza destinos existentes, rutas fuera de la lista de archivos admitidos, enlaces simbólicos y respaldos con un WAL activo. Una restauración parcial no tiene marcador de finalización y el lanzador no permite arrancarla. Si falla, puede quedar una carpeta nueva incompleta; el original no se reemplaza.

Restaurar recupera el estado anterior, incluidas credenciales y revocaciones de aquel momento. Una revocación hecha después del inicio del respaldo puede perderse en la copia. Antes de exponerla, revisa los cambios desde `snapshotAt` y restablece las restricciones necesarias. La prueba automatizada demuestra deliberadamente este riesgo: el original sigue revocado, mientras la instantánea conserva su inscripción anterior.

Solo después de esa revisión, detén el servidor anterior si ocupa el mismo puerto y arranca la copia con reconocimiento explícito:

```bash
node scripts/coluvi-pilot.mjs start \
  .data/coluvi-restaurado-01 --acknowledge-rollback
```

Para HTTPS también hacen falta las opciones de certificado y clave anteriores. El reconocimiento es una precaución del lanzador, no una protección contra un administrador que ejecute directamente otro comando. No elimina ni actualiza automáticamente revocaciones y no certifica que la revisión se haya realizado.

## Evidencia automatizada

`tests/coluvi-participants.test.ts` y `tests/coluvi-api.test.ts` cubren alcance por zona, paginación, ausencia de secretos, autenticación, CSRF, confirmación exacta, idempotencia, conservación de destinatarios y revocación tras reiniciar. El smoke de Chromium recorre cancelar y confirmar desde el diálogo real: después, la bandeja devuelve 401 y un paquete operativo se rechaza sin inventar un acuse; los dos estados históricos siguen presentes.

`tests/coluvi-operations.test.ts` usa carpetas temporales propias. Verifica respaldo con WAL confirmado, restauración del historial y credenciales, permisos privados, rechazo de sobrescritura y corrupción, arranque de la copia revisada, puerto ocupado sin terminar a su dueño y parada del hijo. HTTPS se prueba con una CA temporal confiada explícitamente por el cliente de prueba, sin instalarla ni desactivar la validación TLS.

Estas pruebas no cubren corte eléctrico físico, fallo de disco real ni llegada desde los Samsung. El [plan ampliado](COLUVI_EXPANDED_BLOCK.md) mantiene por separado las pruebas de escala y la entrega integrada pendientes.
