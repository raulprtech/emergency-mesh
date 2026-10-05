# Mapa geográfico público de Coluvi

El mapa está en `/map/`; `/` redirige a esa ruta. Utiliza exclusivamente `/api/areas`, nunca reportes completos ni endpoints privados. Muestra celdas de coordenadas redondeadas y zonas que tienen una geometría pública explícita. Las áreas sin geometría permanecen en la lista: no se les inventa una ubicación.

## Uso durante el simulacro

1. Abra el mapa con el servidor disponible para descargar la interfaz y la cartografía local.
2. Consulte la hora de la vista y la política de publicación. Use los filtros de necesidad, intervalo y área; actúan sobre la proyección pública ya descargada.
3. Use «Ver reportes» para encuadrar las áreas publicadas, o el botón de una tarjeta para seleccionar una. Los botones de acercamiento y desplazamiento también funcionan con teclado.
4. Después de un corte, recargue `/map/`. Si había una vista guardada vigente, se presenta con la advertencia «Sin actualización del servidor». No representa el estado actual.
5. «Borrar vista guardada» elimina la copia y detiene la actualización automática en esa ventana hasta que se pulse «Actualizar».

La copia pública reside en `coluvi-public-map`, separada de las bases de identidad y bandeja móvil. Una vista caduca como máximo a las 24 horas; observaciones que superan su ventana de publicación se omiten antes. La caducidad se aplica al leer, no como un borrado en segundo plano garantizado mientras el navegador está cerrado. El navegador puede desalojar el almacenamiento: la disponibilidad offline no está garantizada sin una carga inicial correcta.

La actualización se intenta cada 30 segundos mientras la página está visible. La caché `coluvi-public-map-v1`, limitada a `/map/`, incluye únicamente HTML, JavaScript, CSS y geometría. No almacena `/api/areas` ni contenido privado. La persistencia de la proyección pública es explícita y validada en IndexedDB.

## Qué significan los colores y números

Los colores indican 1–9, 10–19 y 20 o más reportes publicados, no riesgo de inundación, personas distintas ni asistencia confirmada. El mapa suma los intervalos seleccionados por área; las tarjetas conservan cada intervalo. «No publicado» significa que un desglose está restringido, no que sea cero. La ausencia de grupos visibles no demuestra ausencia de emergencias. Las nueve necesidades estándar están disponibles como filtros; los desgloses restringidos quedan fuera de un filtro específico.

Las tres zonas de ejemplo en `src/web/public-map/zones.json` son rectángulos ficticios cerca de Mérida, identificados como simulacro. **No representan refugios reales ni ubicaciones operativas.** Cambiar esa geometría requiere definir áreas públicas suficientemente amplias y actualizar la versión de la caché para clientes ya instalados.

## Cartografía incluida y licencia

El fondo contiene 177 geometrías de países de Natural Earth a escala 1:110 millones. Es una vista general: no incluye calles, rutas de evacuación, límites locales detallados ni un modelo de inundación. La proyección equirectangular local sirve para visualizar grupos aproximados, no para navegar o medir distancias.

[Natural Earth declara sus datos vectoriales y ráster de dominio público](https://www.naturalearthdata.com/about/terms-of-use/). Se conserva crédito y procedencia en el archivo generado y en la interfaz. La licencia Apache-2.0 del código no reemplaza esta procedencia del conjunto de datos.

- Fuente: [archivo GeoJSON fijado a una revisión](https://raw.githubusercontent.com/nvkelso/natural-earth-vector/f1890d9f152c896d250a77557a5751a93d494776/geojson/ne_110m_admin_0_countries.geojson).
- Revisión del repositorio de datos: `f1890d9f152c896d250a77557a5751a93d494776` (etiqueta `v5.1.2` del repositorio; no se interpreta como versión individual de todas las capas).
- SHA-256 original: `6866c877d39cba9c357620878839b336d569f8c662d3cfab4cb1dbe2d39c977f`.
- Transformación: conserva nombre y geometría, redondea coordenadas a tres decimales y añade metadatos de procedencia.
- SHA-256 de `basemap.json`: `c4e5ae35abcc73458dd094e6191bc6f782df9bee2b5baf02e8864fe75223a645`.

La generación exige red y rechaza una fuente cuya huella no coincida; el funcionamiento del mapa no requiere servicios externos:

```bash
node scripts/build-map-basemap.mjs
```

## Verificación reproducible

```bash
node --test tests/aggregation-privacy.test.ts tests/public-map.test.ts
COLUVI_CHROMIUM_PATH=/ruta/a/chromium node examples/public-map-browser-smoke.mjs
```

El smoke crea únicamente su propio servidor, perfil de Chromium y SQLite temporal. Carga 24 reportes firmados ficticios en cuatro grupos, comprueba tres áreas geográficas y una solo en lista, filtros, controles, pantalla de 360 píxeles y nombres accesibles. Detiene abruptamente su servidor con `SIGKILL`, recarga sin conexión, comprueba cartografía y datos persistidos, y luego verifica que una vista caducada se rechaza. Inspecciona el contenido exacto de Cache Storage y la exclusión de campos privados. El primer resultado fue `PASS` en Chromium 151 sobre Ubuntu WSL2 el 4 de octubre de 2026. Esto no sustituye una prueba física en Android.

La suite del hito pasó 174 pruebas, sin fallos, cancelaciones ni pruebas omitidas, con `node --test --test-concurrency=2 tests/*.test.ts` (aproximadamente 57 segundos). El smoke de Coluvi también pasó su ciclo completo, regresión offline anterior y comprobaciones de accesibilidad. Durante la verificación se sustituyeron pausas fijas del smoke anterior por condiciones reales de inicialización y lecturas bajo el mismo Web Lock de Background Sync; las aserciones de custodia siguen exigiendo `QUEUED` offline y `SYNCED` solo con evidencia del backend.
