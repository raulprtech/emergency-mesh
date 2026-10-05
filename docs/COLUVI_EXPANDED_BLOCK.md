# Bloque ampliado del centro de mando Coluvi

Objetivo autorizado el 4 de octubre de 2026: aprovechar una ventana aproximada de ocho horas para llevar el prototipo a un simulacro completo de inundación, encadenando entregables y reservando el cierre para integración, verificación y publicación. El punto de partida es `4b7d033`, con 166 pruebas y el ciclo básico de check-in verificado en Chromium. Todo el trabajo se ejecuta en Ubuntu WSL2.

## Entregables y evidencia necesaria

| Entregable | Criterio de aceptación | Estado |
|---|---|---|
| Mapa geográfico | Celdas y zonas públicas sobre cartografía local, filtros, leyenda y antigüedad; recarga sin backend con datos guardados identificados como antiguos; privacidad conservada | Implementado; pruebas específicas y Chromium offline aprobados. Véase `PUBLIC_MAP.md` |
| Avisos operativos | Avisos de simulacro firmados, autorizados por tipo y zona, con fuente y caducidad; bandeja y presentación móvil verificadas; persistencia tras reinicio | Integrados y verificados en Chromium; suite completa de 185 pruebas aprobada. Véase `COLUVI_NOTICES.md` |
| Evolución de estado y necesidades | Nueva respuesta vinculada a la anterior; señal mínima guardada antes de enriquecer; historial inmutable y estado más reciente sin duplicar destinatarios | Implementado en contrato, SQLite, PWA y panel; 193 pruebas y Chromium offline aprobados, incluida concurrencia real de IndexedDB. Véase `COLUVI_DEMO.md` |
| Operación del piloto | Participantes y revocación en el panel; arranque, diagnóstico y respaldo reproducibles; pruebas de restauración sin sobrescribir material existente | Implementado; 199 pruebas, revocación en Chromium y recuperación/arranque HTTP y HTTPS con archivos temporales aprobados. Véase `COLUVI_OPERATIONS.md` |
| Pruebas exigentes | Varios clientes y zonas, concurrencia, reinicios abruptos, entregas fuera de orden y cientos de dispositivos simulados; resultados medidos y repetibles | Implementadas y verificadas con 300, 600 y 990 dispositivos ficticios, tres zonas, 24/32/48 solicitudes concurrentes, dos SIGKILL por ejecución y reenvío completo. El perfil de 990 aprobó aislado después de un timeout bajo carga adicional; no acredita capacidad garantizada. Informes en `COLUVI_LOAD.md` |
| Entrega integrada | Escenario completo desde mapa y panel hasta PWA; guía y resultados actualizados; versión identificada y publicada en GitHub | Implementada y calificada: 204 pruebas, Chromium integrado con recargas de documento nuevo, mapa offline y carga de 300 en una ejecución completa PASS. Informe `coluvi-qualification-20261004-release.json`; versión candidata `coluvi-simulacro-20261004-rc1` |

Los hitos se publicarán después de verificarlos. Completar el mapa no cierra este objetivo. Si una dependencia exige intervención, continuará el trabajo independiente de esa dependencia y se registrará el alcance pendiente.

## Cierre verificable del bloque

La [calificación final](coluvi-qualification-20261004-release.json) corresponde al código del commit `878a37c3d18957f39f06d71bf897eaa21ed8c0e7`, con árbol limpio al iniciar, 157 archivos de código y pruebas identificados por SHA-256 y cero fallos, cancelaciones u omisiones. El [CI del mismo commit](https://github.com/raulprtech/emergency-mesh/actions/runs/37241725818) aprobó. La etiqueta candidata añade documentación y este informe sin cambiar el código calificado.

El recorrido integrado verifica mapa, aviso, solicitud, ayuda mínima, necesidades, reapertura offline, sincronización, actualización SAFE, revocación e historial conservado en un mismo servidor. Las pruebas de operación verifican respaldo con WAL, restauración en destino nuevo y arranque HTTP/HTTPS con material temporal. Los informes de [300](coluvi-load-300-20261004.json), [600](coluvi-load-600-20261004.json) y [990 dispositivos](coluvi-load-990-20261004.json) conservan los parámetros y resultados medidos. La [guía de carga](COLUVI_LOAD.md) también registra el intento de 990 que excedió el timeout mientras corrían otras verificaciones; no se oculta como si todos los intentos hubieran aprobado.

Para repetir la calificación, usa un Chromium ya instalado y un destino nuevo:

```bash
COLUVI_CHROMIUM_PATH=/ruta/al/chromium node scripts/qualify-coluvi.mjs /tmp/coluvi-calificacion-nueva
```

Para preparar un piloto manual, sigue [la demostración](COLUVI_DEMO.md) y [las operaciones](COLUVI_OPERATIONS.md). El cierre corresponde al bloque de software, no al producto completo ni a la postulación. Siguen fuera de lo demostrado: Samsung/LAN físicos, app nativa, BLE/LoRa/Bitchat, comportamiento garantizado de pestañas suspendidas, cortes eléctricos reales y capacidad de atención humana. No se modificaron datos reales del piloto, certificados del usuario ni reglas de firewall para estas pruebas.

## Decisiones de implementación

El mapa consumirá únicamente la proyección pública, con geometría servida desde el propio proyecto y procedencia documentada. Los filtros operarán sobre los mismos agregados publicados, sin consultas de reportes personales. El ciclo privado reutilizará la autoridad y los almacenes actuales. Las migraciones serán aditivas, las configuraciones antiguas seguirán siendo interpretables y las pruebas usarán datos ficticios y recursos temporales propios.

La ventana de trabajo comienza aproximadamente a las 14:10 del 4 de octubre, hora de Ciudad de México. La referencia de ocho horas es aproximadamente las 22:10. No implica autorizar compras, nuevas cuentas, despliegues públicos ni cambios al firewall. Las pruebas físicas en Samsung, la aplicación nativa y el transporte por radio requieren una etapa posterior.
