# Sesión de prueba de Coluvi con dos Samsung

Esta guía prepara la primera prueba física con el S26 Ultra y el A54. La computadora será el centro de mando y cada teléfono utilizará la PWA como participante ficticio. No se necesita Bitchat ni una app nativa. El resultado de esta sesión sigue pendiente: las pruebas de Chromium y clientes simulados no sustituyen lo que ocurra en los teléfonos.

Usa solo datos de simulacro. SYNCED significa que un backend confirmó almacenamiento, no atención ni ayuda despachada. El mapa público no muestra las respuestas privadas del piloto.

La instalación todavía se identifica como «Emergency Mesh» y puede mostrar «Emergency» como nombre corto. Es la PWA de este prototipo de Coluvi, no otra aplicación que debas descargar. Durante la sesión no ejecutes en el centro de mando calificaciones completas, simulaciones masivas ni ensayos de carga: la combinación con 990 actores produjo timeouts reproducibles. Las pruebas automatizadas se realizan antes o después del piloto, con sus propios datos temporales.

## Antes de conectar los teléfonos

Registra fecha, versión de Coluvi, modelos, versiones de Android y navegador. Comprueba la IP actual visible desde el Wi-Fi, el acceso a WSL2 y la vigencia del certificado. No reutilices las direcciones antiguas del chat ni un certificado anterior sin verificarlos. Un cambio de IP puede exigir certificado y configuración nuevos; no se deben sobrescribir claves o bases existentes.

El proyecto no instala automáticamente la CA ni modifica las reglas de Windows. Si falta acceso LAN, detén esa parte y revisa [Phone pilot](PHONE_PILOT.md); no desactives la validación TLS ni aceptes un aviso de certificado como si fuera una conexión confiable. Toda operación del servidor se realiza en Ubuntu de WSL2, nunca UbuntuPreview.

Si no existe material bidireccional válido para esta sesión, crea un piloto nuevo con los generadores de [la demostración](COLUVI_DEMO.md) y [Phone pilot](PHONE_PILOT.md). Debe contener una zona ficticia común, por ejemplo `refugio-norte`, y autorizar solicitudes y avisos. Un servidor general sin `operator-config.json` no permite inscribir participantes ni emitir comandos.

Para material ya preparado, usa las rutas reales en lugar de los ejemplos siguientes:

```bash
node scripts/coluvi-pilot.mjs preflight .data/mi-piloto-https \
  --tls-cert .data/mi-tls/server-cert.pem \
  --tls-key .data/mi-tls/server-key.pem \
  --ca-cert .data/mi-tls/ca-cert.pem

node scripts/coluvi-pilot.mjs start .data/mi-piloto-https \
  --host 0.0.0.0 \
  --tls-cert .data/mi-tls/server-cert.pem \
  --tls-key .data/mi-tls/server-key.pem
```

Mantén esa terminal abierta. Desde otra terminal Ubuntu repite `preflight` con las mismas opciones y `--probe`. El informe no debe tener comprobaciones FAIL. Los PENDING deben revisarse individualmente; el resultado global permanecerá `PENDING_PHYSICAL_TESTS` hasta comprobar los teléfonos. El código de salida cero no certifica conectividad Android.

En cada teléfono verifica la CA por el canal local acordado e instala únicamente el certificado público de esa CA. Nunca transfieras claves TLS, `operator-config.json` ni el archivo completo `operator-secrets.txt`. Abre el origen HTTPS configurado seguido de `/health`: debe responder sin advertencias de certificado. Solo entonces abre `/mobile/` e instala la PWA mediante la opción disponible en el navegador. Conserva el mismo origen durante todo el ensayo.

## Inscripción y roles

En ambos teléfonos abre «Inscribirme en el piloto Coluvi». Importa solo `mobile-trust.json`, contrasta su huella con la mostrada por el centro mediante otro canal, escribe la misma zona y el código de inscripción, y acepta el consentimiento del simulacro. El código se comparte por separado; la contraseña del operador permanece en la computadora.

Abre `/command-center/` en la computadora e inicia sesión. Confirma que aparecen dos dispositivos inscritos en la zona. Emite solicitudes después de la inscripción: sus destinatarios quedan fijados al emitirlas. Cuenta dispositivos, no personas. Para el registro usa las etiquetas locales «S26» y «A54», sin publicar sus identificadores criptográficos.

## Recorrido y criterios de aceptación

| Paso | Acción | Resultado esperado | Resultado observado |
|---|---|---|---|
| 1 | Abre `/map/` en la computadora y en un teléfono | Cartografía y controles disponibles; un mapa sin grupos puede ser correcto | Pendiente |
| 2 | Emite un aviso de SIMULACRO a la zona | Ambos teléfonos abiertos y conectados reciben fuente, firma y caducidad; SHOWN no se interpreta como lectura humana | Pendiente |
| 3 | Emite «¿Estás bien?» con tiempo suficiente para el ensayo | Dos destinatarios; la solicitud aparece en ambos teléfonos | Pendiente |
| 4 | En S26 responde «Estoy bien» con conexión | Confirmación de backend y un dispositivo SAFE en el detalle | Pendiente |
| 5 | Desconecta A54 de Wi-Fi y datos después de recibir la solicitud | La copia local sigue visible; no se espera recibir solicitudes nuevas sin ruta | Pendiente |
| 6 | En A54 responde «Necesito ayuda» y añade agua por separado | Señal mínima guardada primero y detalle independiente; ambos pendientes, sin confirmación inventada | Pendiente |
| 7 | Cierra y vuelve a abrir la PWA del A54, todavía sin conexión | Misma respuesta y necesidades conservadas; no se crean duplicados | Pendiente |
| 8 | Restablece Wi-Fi y pulsa «Intentar sincronizar» | Confirmación de ambos paquetes; panel con un SAFE y un NEEDS_HELP, agua contada una vez | Pendiente |
| 9 | En A54 actualiza a «Estoy bien» | Dos SAFE; agua deja de contar como necesidad vigente, pero el historial permanece | Pendiente |
| 10 | Guarda la vista pública del mapa y desconecta su dispositivo | Se muestra la instantánea con su antigüedad; no se presenta como dato actualizado | Pendiente |
| 11 | Detén solo el servidor de esta sesión y arráncalo con la misma base | Historial conservado; operador debe volver a iniciar sesión; teléfonos mantienen inscripción | Pendiente |
| 12 | Emite otra solicitud y deja un teléfono sin responder hasta acabar el plazo inicial | UNKNOWN significa ausencia de respuesta, nunca víctima o peligro confirmado | Pendiente |

Para el paso 5 no basta con activar modo avión: comprueba que Wi-Fi no permanezca encendido. No borres almacenamiento ni reinstales la PWA entre los pasos; eso invalidaría la prueba de conservación. Elige plazos suficientemente largos para sincronizar los mensajes que quieres comprobar antes de que caduque la solicitud. Las operaciones fuera de su vigencia deben rechazarse, no forzarse.

El mapa público y el panel privado tienen propósitos diferentes. Los check-ins, necesidades vinculadas y avisos de esta sesión no deben cambiar el agregado público. La cartografía puede verse aunque no existan grupos publicados. La política pública por defecto exige al menos tres reportes generales en la misma celda y periodo; no se reducirá el umbral ni se añadirán ubicaciones reales para lograr una captura más vistosa.

## Si algo falla

Antes de reintentar anota la hora y lo que muestra cada pantalla. Abre «Diagnóstico del dispositivo», actualízalo y descarga el archivo local. Distingue reportes guardados, pendientes y confirmados. Una indicación de red no demuestra acceso al centro; una respuesta HTTP no basta para confirmar un reporte. Un error al guardar el acuse puede dejar la entrega local sin confirmar aunque el servidor haya recibido el paquete: el reintento debe deduplicarse.

Si falla el guardado, conserva el formulario y no anuncies el reporte como enviado. Si el mensaje dice que terminó el guardado pero falló la vista, no crees otra copia. No borres datos para reparar un problema. Si aparece 429, espera antes de consultar otra vez; repetir clics puede prolongar la saturación. Los dispositivos detrás de una misma dirección de origen pueden compartir límites de la API privada.

Registra también resultados inesperados: latencia, mensajes que no aparecen, pasos que confunden o acciones que requieren demasiados intentos. No sustituyas un fallo por un resultado esperado en la tabla. Si se cierra o suspende la aplicación, mide qué sucede; no presupongas recepción en segundo plano.

## Registro y cierre

Para cada caso conserva: etiqueta del teléfono, versión de Android y navegador, hora de creación, hora de confirmación, estado en la PWA, estado en el panel, si había conexión y observaciones. Usa «no medido» cuando falte evidencia. Comprueba que los archivos o capturas para compartir no incluyan contraseñas, códigos, claves, identificadores o datos de otras personas. El diagnóstico depurado contiene fechas y cantidades: revísalo también antes de publicarlo.

Si necesitas guardar el ensayo, crea un respaldo privado mediante `coluvi-pilot.mjs backup` antes de cerrarlo. No subas ese respaldo a GitHub. Detén solo el proceso de esta sesión. Retira la confianza temporal del teléfono cuando ya no sea necesaria; no elimines bases ni claves mientras todavía hagan falta para investigar incidencias o continuar la prueba.

Solo después de completar el registro podremos afirmar qué funcionó en los dos Samsung. Alcance Bluetooth, malla física, batería y recepción garantizada con la app cerrada siguen fuera de este ensayo LAN.
