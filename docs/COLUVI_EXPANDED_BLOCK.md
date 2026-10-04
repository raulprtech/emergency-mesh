# Bloque ampliado del centro de mando Coluvi

Objetivo autorizado el 4 de octubre de 2026: aprovechar una ventana aproximada de ocho horas para llevar el prototipo a un simulacro completo de inundación, encadenando entregables y reservando el cierre para integración, verificación y publicación. El punto de partida es `4b7d033`, con 166 pruebas y el ciclo básico de check-in verificado en Chromium. Todo el trabajo se ejecuta en Ubuntu WSL2.

## Entregables y evidencia necesaria

| Entregable | Criterio de aceptación | Estado |
|---|---|---|
| Mapa geográfico | Celdas y zonas públicas sobre cartografía local, filtros, leyenda y antigüedad; recarga sin backend con datos guardados identificados como antiguos; privacidad conservada | Implementado; pruebas específicas y Chromium offline aprobados. Véase `PUBLIC_MAP.md` |
| Avisos operativos | Avisos de simulacro firmados, autorizados por tipo y zona, con fuente y caducidad; bandeja y presentación móvil verificadas; persistencia tras reinicio | Integrados y verificados en Chromium; suite completa de 185 pruebas aprobada. Véase `COLUVI_NOTICES.md` |
| Evolución de estado y necesidades | Nueva respuesta vinculada a la anterior; señal mínima guardada antes de enriquecer; historial inmutable y estado más reciente sin duplicar destinatarios | Pendiente |
| Operación del piloto | Participantes y revocación en el panel; arranque, diagnóstico y respaldo reproducibles; pruebas de restauración sin sobrescribir material existente | Pendiente |
| Pruebas exigentes | Varios clientes y zonas, concurrencia, reinicios abruptos, entregas fuera de orden y cientos de dispositivos simulados; resultados medidos y repetibles | Pendiente |
| Entrega integrada | Escenario completo desde mapa y panel hasta PWA; guía y resultados actualizados; versión identificada y publicada en GitHub | Pendiente |

Los hitos se publicarán después de verificarlos. Completar el mapa no cierra este objetivo. Si una dependencia exige intervención, continuará el trabajo independiente de esa dependencia y se registrará el alcance pendiente.

## Decisiones de implementación

El mapa consumirá únicamente la proyección pública, con geometría servida desde el propio proyecto y procedencia documentada. Los filtros operarán sobre los mismos agregados publicados, sin consultas de reportes personales. El ciclo privado reutilizará la autoridad y los almacenes actuales. Las migraciones serán aditivas, las configuraciones antiguas seguirán siendo interpretables y las pruebas usarán datos ficticios y recursos temporales propios.

La ventana de trabajo comienza aproximadamente a las 14:10 del 4 de octubre, hora de Ciudad de México. La referencia de ocho horas es aproximadamente las 22:10. No implica autorizar compras, nuevas cuentas, despliegues públicos ni cambios al firewall. Las pruebas físicas en Samsung, la aplicación nativa y el transporte por radio requieren una etapa posterior.
