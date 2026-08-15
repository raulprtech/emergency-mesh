export const mapHtml = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Emergency Map · referencia</title>
<style>
:root{font-family:system-ui,sans-serif;color:#17202a;background:#f5f7f8}body{max-width:1000px;margin:0 auto;padding:24px}
h1{margin-bottom:4px}.note{color:#52606d;margin-top:0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}
.area{background:white;border-left:10px solid #58a65c;border-radius:10px;padding:18px;box-shadow:0 2px 12px #0001}.moderate{border-color:#e3c33f}.high{border-color:#e57b25}.critical{border-color:#c0392b}
.count{font-size:2rem;font-weight:750}.age{color:#667;font-size:.9rem}.empty{padding:40px;background:#fff;border-radius:10px}
</style></head><body><h1>Emergency Map</h1><p class="note">Vista pública agregada; no muestra coordenadas personales exactas.</p><p id="privacy" class="note"></p><main id="areas" class="grid"></main>
<script>
const root=document.querySelector('#areas');const privacy=document.querySelector('#privacy');
function esc(value){const node=document.createElement('span');node.textContent=String(value);return node.innerHTML}
function severity(a){return a.critical>0?'critical':a.total>=5?'high':a.total>=2?'moderate':''}
fetch('/api/areas').then(r=>r.json()).then(result=>{const areas=result.areas;privacy.textContent='Política: mínimo '+result.privacy.minimumGroupSize+' reportes, precisión '+result.privacy.spatialPrecisionDecimals+' decimal(es), '+result.privacy.suppressedGroups+' grupo(s) suprimido(s).';root.innerHTML=areas.length?areas.map(a=>
  '<article class="area '+severity(a)+'"><div class="count">'+a.total+'</div><strong>Zona '+esc(a.areaId)+'</strong><p>'+a.sos+' SOS · '+a.critical+' críticos</p><p>'+Object.entries(a.needs).map(([k,v])=>v+' '+esc(k.toLowerCase())).join(' · ')+'</p><div class="age">Actualizado '+new Date(a.newestObservedAt).toLocaleString()+'</div></article>'
).join(''):'<p class="empty">Aún no hay reportes sincronizados.</p>'}).catch(()=>{root.innerHTML='<p class="empty">No fue posible cargar los datos.</p>'});
</script></body></html>`;
