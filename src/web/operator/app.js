import { checkinInput, noticeInput, metricsElement, requestPhase, STATES, NEED_NAMES, HISTORY_LINKS } from "./view.js";

const byId = (id) => document.getElementById(id);
let session;
let epoch = 0;
let busy = false;
let timer;
let selected;
let selectedKind = "checkins";
let offset = 0;
let pageData;
let participantOffset = 0;
let participantPage;
let revokeTarget;
let revokePending = false;
const LIMIT = 10;
const NOTICE_METRICS = [["requested", "Destinatarios"], ["received", "Recibidos"], ["shown", "Mostrados"]];
const formatTime = (time) => new Date(time).toLocaleString("es-MX");
const status = (message) => { if (byId("status").textContent !== message) byId("status").textContent = message; };

function clearPrivate(message = "Sesión cerrada. Vuelve a entrar para consultar el centro.") {
  epoch += 1; session = undefined; selected = undefined; selectedKind = "checkins"; offset = 0; pageData = undefined;
  participantOffset = 0; participantPage = undefined; revokeTarget = undefined;
  byId("revoke-dialog").close(); byId("revoke-form").reset(); byId("revoke-target").textContent = ""; byId("participants-filter").reset();
  clearTimeout(timer); byId("workspace").hidden = true; byId("detail-panel").hidden = true; byId("login-panel").hidden = false;
  for (const id of ["requests", "recipients", "detail-counts", "zone", "notice-zone", "notices", "participants", "participant-zone"]) byId(id).replaceChildren();
  byId("notice-form").reset(); byId("notice-form").hidden = true; byId("notice-capability").textContent = "";
  for (const id of ["fingerprint", "session-expiry", "updated", "detail-meta", "page", "participant-counts", "participants-page"]) byId(id).textContent = "";
  byId("password").value = ""; status(message);
}

async function api(path, data) {
  const response = await fetch(`/api/operator/${path}`, {
    method: data === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(8_000),
    headers: data === undefined ? {} : { "content-type": "application/json", "x-coluvi-csrf": session?.csrf ?? "" },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  if (!response.ok) {
    if (response.status === 401 && path !== "login" && session) clearPrivate("La sesión terminó o el servidor se reinició. Vuelve a entrar.");
    const error = new Error(response.status === 429 ? "Límite de consultas. Espera un minuto." : response.status === 401 ? "Acceso denegado." : "El centro rechazó la operación.");
    error.status = response.status; throw error;
  }
  // Ten recipients, each with at most 100 states and 100 details; limit actual bytes too.
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 4_194_304) throw new Error("Detalle demasiado grande."); chunks.push(value); }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(size); let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function showSession(value) {
  session = value; byId("login-panel").hidden = true; byId("workspace").hidden = false;
  byId("fingerprint").textContent = value.fingerprint;
  byId("session-expiry").textContent = `Sesión hasta ${formatTime(value.expiresAt)}. No se guardan contraseña ni token en el almacenamiento del navegador.`;
  byId("zone").replaceChildren(...value.zones.map((zone) => { const option = document.createElement("option"); option.value = zone; option.textContent = zone; return option; }));
  byId("notice-zone").replaceChildren(...value.zones.map(zone => new Option(zone, zone)));
  byId("participant-zone").replaceChildren(new Option("Todas las zonas autorizadas", ""), ...value.zones.map(zone => new Option(zone, zone)));
  const noticesAllowed = value.kinds?.includes("OPERATIONAL_NOTICE"); byId("notice-form").hidden = !noticesAllowed;
  byId("notice-capability").textContent = noticesAllowed ? "Esta configuración autoriza avisos firmados para las zonas indicadas." : "Esta configuración solo autoriza las capacidades provisionadas anteriormente. No se han ampliado sus permisos.";
}

function renderParticipants(result) {
  participantPage = result.pagination;
  byId("participant-counts").textContent = `${result.counts.total} dispositivos en las zonas consultadas · ${result.counts.active} activos · ${result.counts.revoked} revocados`;
  const list = byId("participants"); const focused = document.activeElement?.dataset.revoke; list.replaceChildren();
  const credentials = { ACTIVE: "vigente", EXPIRED: "caducada; debe renovar inscripción", NONE: "sin credencial", REVOKED: "revocada" };
  for (const participant of result.participants) {
    const article = document.createElement("article"); article.dataset.participantId = participant.deviceId;
    const heading = document.createElement("h3"); heading.textContent = `Dispositivo ${participant.deviceId}`;
    const description = document.createElement("p"); description.textContent = `${participant.zoneId} · ${participant.active ? "Activo" : "Revocado"} · Inscrito ${formatTime(participant.enrolledAt)} · Credencial ${credentials[participant.credential]}`;
    article.append(heading, description);
    if (participant.revokedAt !== null) { const at = document.createElement("p"); at.textContent = `Revocado ${formatTime(participant.revokedAt)}`; article.append(at); }
    if (participant.active) {
      const button = document.createElement("button"); button.type = "button"; button.dataset.revoke = participant.deviceId; button.textContent = "Revocar dispositivo";
      button.setAttribute("aria-label", `Revocar dispositivo ${participant.deviceId} de ${participant.zoneId}`);
      button.addEventListener("click", () => {
        if (busy || !session) return;
        revokeTarget = { deviceId: participant.deviceId, zoneId: participant.zoneId };
        byId("revoke-form").reset(); byId("revoke-target").textContent = `${participant.deviceId} · Zona ${participant.zoneId}`; byId("revoke-dialog").showModal();
      });
      article.append(button); list.append(article); if (focused === participant.deviceId) button.focus({ preventScroll: true });
    } else list.append(article);
  }
  if (!result.participants.length) { const empty = document.createElement("p"); empty.textContent = "No hay participantes en esta página con los filtros seleccionados."; list.append(empty); }
  byId("participants-previous").disabled = participantPage.offset === 0; byId("participants-next").disabled = !participantPage.hasMore;
  byId("participants-page").textContent = result.participants.length ? `${participantPage.offset + 1}–${participantPage.offset + result.participants.length} de ${participantPage.total}` : `0 en esta página; ${participantPage.total} coinciden`;
}

function renderRequests(rows) {
  const list = byId("requests");
  const focusedId = document.activeElement?.dataset?.detail;
  list.replaceChildren();
  for (const row of rows) {
    const payload = row.command.extensions.coluvi;
    const article = document.createElement("article"); article.dataset.commandId = row.command.eventId;
    const title = document.createElement("h3"); title.textContent = `${payload.incidentRef} · ${payload.zoneId}`;
    const meta = document.createElement("p"); meta.textContent = `${requestPhase(payload)} · Responder antes de ${formatTime(payload.promptUntil)}`;
    const button = document.createElement("button"); button.type = "button"; button.dataset.detail = row.command.eventId; button.textContent = "Ver destinatarios e historial";
    button.setAttribute("aria-label", `${button.textContent} · ${payload.incidentRef} · ${payload.zoneId}`);
    button.addEventListener("click", () => { if (busy) return; selected = row.command.eventId; selectedKind = "checkins"; offset = 0; void refresh(true); });
    article.append(title, meta, metricsElement(row.counts), button); list.append(article);
    if (focusedId === row.command.eventId) button.focus({ preventScroll: true });
  }
  if (!rows.length) { const empty = document.createElement("p"); empty.textContent = "Sin solicitudes. Inscribe al menos un cliente antes de emitir el simulacro."; list.append(empty); }
}

function renderNotices(rows) {
  const list = byId("notices"); const focused = document.activeElement?.dataset.noticeDetail; list.replaceChildren();
  for (const row of rows) {
    const notice = row.notice.extensions.coluvi; const article = document.createElement("article"); article.dataset.noticeId = notice.noticeId;
    const title = document.createElement("h3"); title.textContent = `SIMULACRO · ${notice.title}`;
    const meta = document.createElement("p"); meta.textContent = `${notice.zoneId} · ${Date.now() >= notice.expiresAt ? "CADUCADO" : "Vigente"} · Caduca ${formatTime(notice.expiresAt)} · Fuente: ${notice.sourceLabel}`;
    const message = document.createElement("p"); message.className = "notice-message"; message.textContent = notice.message;
    const button = document.createElement("button"); button.type = "button"; button.textContent = "Ver evidencia del aviso"; button.dataset.noticeDetail = notice.noticeId;
    button.setAttribute("aria-label", `${button.textContent} · ${notice.title} · ${notice.zoneId}`);
    button.addEventListener("click", () => { if (busy) return; selected = notice.noticeId; selectedKind = "notices"; offset = 0; void refresh(true); });
    article.append(title, meta, message, metricsElement(row.counts, document, NOTICE_METRICS), button); list.append(article);
    if (focused === notice.noticeId) button.focus({ preventScroll: true });
  }
  if (!rows.length) { const empty = document.createElement("p"); empty.textContent = "Sin avisos emitidos."; list.append(empty); }
}

function renderDetail(detail, focus) {
  pageData = detail.pagination;
  const isNotice = Boolean(detail.notice); const payload = (detail.notice ?? detail.command).extensions.coluvi;
  byId("detail-panel").hidden = false;
  byId("detail-meta").textContent = isNotice ? `${payload.incidentRef} · ${payload.zoneId} · Aviso de simulacro · Caduca ${formatTime(payload.expiresAt)}` : `${payload.incidentRef} · ${payload.zoneId} · ${requestPhase(payload)} · Entrega hasta ${formatTime(payload.responseUntil)}`;
  byId("detail-counts").replaceChildren(isNotice ? metricsElement(detail.counts, document, NOTICE_METRICS) : metricsElement(detail.counts));
  if (!isNotice && detail.needsCounts) {
    const description = document.createElement("p"); description.textContent = "Necesidades actuales: dispositivos, no personas únicas. Solo se incluyen detalles vinculados al estado de ayuda vigente.";
    byId("detail-counts").append(description, metricsElement(detail.needsCounts, document, Object.entries(NEED_NAMES)));
  }
  byId("recipients").replaceChildren();
  for (const recipient of detail.recipients) {
    const article = document.createElement("article");
    const heading = document.createElement("h3"); heading.textContent = `Dispositivo ${recipient.deviceId}`;
    const evidence = document.createElement("p"); evidence.textContent = `${isNotice ? "Aviso de simulacro" : STATES[recipient.state]} · Evidencia de recepción: ${recipient.received ? "sí" : "no"} · Presentación: ${recipient.shown ? "sí" : "no"}`;
    const history = document.createElement("ol");
    for (const entry of recipient.history ?? []) {
      const item = document.createElement("li"); item.textContent = `${STATES[entry.report.extensions.coluvi.status]} · Declarado ${formatTime(entry.report.observedAt)} · Recibido ${formatTime(entry.receivedAt)}${entry.late ? " · Entrega tardía" : ""} · ${HISTORY_LINKS[entry.link] ?? "Historial anterior"}`; history.append(item);
    }
    article.append(heading, evidence, history);
    if (!isNotice) {
      const needs = document.createElement("p"); needs.dataset.currentNeeds = recipient.deviceId;
      needs.textContent = recipient.needs ? `Detalles vigentes: ${recipient.needs.categories.map(category => NEED_NAMES[category]).join(", ") || "sin categorías"} · Personas declaradas: ${recipient.needs.peopleAffected ?? "no indicado"} (no verificadas, no se suman entre dispositivos).` : "Sin detalles de necesidades vinculados al estado vigente.";
      article.append(needs);
      if (recipient.needsHistory?.length) {
        const details = document.createElement("details"); const summary = document.createElement("summary"); summary.textContent = `Historial de necesidades (${recipient.needsHistory.length})`; details.append(summary);
        for (const entry of recipient.needsHistory) {
          const payload = entry.report.extensions.coluvi; const line = document.createElement("p");
          line.textContent = `${formatTime(entry.report.observedAt)} · ${payload.categories.map(category => NEED_NAMES[category]).join(", ") || "sin categorías"} · Personas declaradas: ${payload.peopleAffected ?? "no indicado"} · ${HISTORY_LINKS[entry.link]} · ${recipient.needs?.eventId === entry.report.eventId ? "Detalle vigente" : "Histórico o pendiente de vínculo"}`; details.append(line);
        }
        article.append(details);
      }
    }
    byId("recipients").append(article);
  }
  byId("previous").disabled = pageData.offset === 0; byId("next").disabled = !pageData.hasMore;
  byId("page").textContent = pageData.total ? `${pageData.offset + 1}–${pageData.offset + detail.recipients.length} de ${pageData.total} dispositivos` : "Sin destinatarios al emitir";
  if (focus) byId("detail-title").focus();
}

async function refresh(focus = false) {
  if (busy || !session) return;
  busy = true; clearTimeout(timer); const generation = epoch; let delay = 10_000;
  byId("refresh").disabled = true;
  byId("create").disabled = true; byId("notice-create").disabled = true;
  try {
    if (Date.now() >= session.expiresAt) { clearPrivate("Sesión caducada. Vuelve a entrar."); return; }
    if (!navigator.onLine) throw new Error("Sin ruta al centro. Los datos visibles son la última consulta, no estado actualizado.");
    const result = await api("checkins");
    if (generation !== epoch) return;
    renderRequests(result.checkins);
    const notices = await api("notices"); if (generation !== epoch) return; renderNotices(notices.notices);
    const participantQuery = new URLSearchParams({ state: byId("participant-state").value, offset: String(participantOffset), limit: String(LIMIT) });
    if (byId("participant-zone").value) participantQuery.set("zoneId", byId("participant-zone").value);
    const participants = await api(`participants?${participantQuery}`); if (generation !== epoch) return; renderParticipants(participants);
    if (selected) {
      const detail = await api(`${selectedKind}/${encodeURIComponent(selected)}?offset=${offset}&limit=${LIMIT}`);
      if (generation !== epoch) return;
      renderDetail(detail, focus);
    }
    byId("updated").textContent = `Última consulta al centro: ${formatTime(Date.now())}`;
    status("Datos consultados. Ninguna evidencia significa ayuda despachada.");
  } catch (error) {
    if (generation === epoch) { status(error.message); delay = error.status === 429 ? 60_000 : 30_000; }
  } finally {
    busy = false; byId("refresh").disabled = false;
    byId("create").disabled = false; byId("notice-create").disabled = false;
    if (session && generation === epoch) timer = setTimeout(() => {
      if (document.visibilityState === "visible") void refresh();
    }, delay);
  }
}

async function restoreSession() {
  const generation = epoch;
  try {
    const value = await api("session"); if (generation !== epoch) return;
    showSession(value); await refresh();
  } catch (error) {
    if (generation === epoch) clearPrivate(error.status === 401 ? "Introduce la contraseña del operador." : "No se pudo comprobar el centro. Reintenta cuando esté disponible.");
  }
}

byId("participants-filter").addEventListener("submit", event => { event.preventDefault(); if (busy || !session) return; participantOffset = 0; void refresh(); });
byId("participants-previous").addEventListener("click", () => { if (busy || !session) return; participantOffset = Math.max(0, participantOffset - LIMIT); void refresh(); });
byId("participants-next").addEventListener("click", () => { if (busy || !session || !participantPage?.hasMore) return; participantOffset += LIMIT; void refresh(); });
byId("revoke-cancel").addEventListener("click", () => { if (!revokePending) byId("revoke-dialog").close(); });
byId("revoke-dialog").addEventListener("cancel", event => { if (revokePending) event.preventDefault(); });
byId("revoke-dialog").addEventListener("close", () => { revokeTarget = undefined; byId("revoke-form").reset(); byId("revoke-target").textContent = ""; });
byId("revoke-form").addEventListener("submit", async event => {
  event.preventDefault(); if (busy || !session || !revokeTarget || !event.target.reportValidity()) return;
  const target = revokeTarget; const generation = epoch; busy = true; revokePending = true; clearTimeout(timer); byId("revoke-confirm").disabled = true; byId("revoke-cancel").disabled = true;
  try {
    await api(`participants/${encodeURIComponent(target.deviceId)}/revoke`, { confirmDeviceId: target.deviceId });
    if (generation !== epoch) return;
    byId("revoke-dialog").close(); busy = false; await refresh(); if (generation === epoch) status("Dispositivo revocado. El historial se conserva; las copias offline no se retiran a distancia.");
  } catch (error) {
    if (generation === epoch) {
      byId("revoke-dialog").close(); status(`${error.message} Consulta el estado antes de volver a intentar; la operación no se repitió automáticamente.`);
      if (session) timer = setTimeout(() => { if (document.visibilityState === "visible") void refresh(); }, error.status === 429 ? 60_000 : 10_000);
    }
  } finally { busy = false; revokePending = false; byId("revoke-confirm").disabled = false; byId("revoke-cancel").disabled = false; }
});

byId("login-form").addEventListener("submit", async (event) => {
  event.preventDefault(); if (busy) return;
  busy = true; byId("login").disabled = true; const generation = epoch;
  try { await api("login", { password: byId("password").value }); if (generation === epoch) { busy = false; await restoreSession(); } }
  catch (error) { if (generation === epoch) status(error.message); }
  finally { byId("password").value = ""; busy = false; byId("login").disabled = false; }
});
byId("checkin-form").addEventListener("submit", async (event) => {
  event.preventDefault(); if (busy || !session) return;
  busy = true; byId("create").disabled = true; byId("notice-create").disabled = true; clearTimeout(timer); const generation = epoch;
  try {
    const input = checkinInput(byId("incident").value.trim(), byId("zone").value, byId("prompt-minutes").value, byId("late-minutes").value, session.zones);
    const detail = await api("checkins", input);
    if (generation !== epoch) return;
    selected = detail.command.eventId; selectedKind = "checkins"; offset = 0; byId("drill-consent").checked = false;
    busy = false; await refresh(true);
  } catch (error) {
    // A lost POST response is ambiguous: never resend automatically.
    if (generation === epoch) {
      status(`${error.message} No se reemitió automáticamente. Actualiza la lista antes de intentar otra solicitud.`);
      if (session) timer = setTimeout(() => { if (document.visibilityState === "visible") void refresh(); }, error.status === 429 ? 60_000 : 30_000);
    }
  } finally { busy = false; byId("create").disabled = false; byId("notice-create").disabled = false; }
});
byId("notice-form").addEventListener("submit", async event => {
  event.preventDefault(); if (busy || !session?.kinds?.includes("OPERATIONAL_NOTICE")) return;
  busy = true; byId("notice-create").disabled = true; byId("create").disabled = true; clearTimeout(timer); const generation = epoch;
  try {
    const input = noticeInput({ incidentRef: byId("notice-incident").value.trim(), zoneId: byId("notice-zone").value, sourceLabel: byId("notice-source").value.trim(), title: byId("notice-title").value.trim(), message: byId("notice-message").value.trim(), level: byId("notice-level").value, minutes: byId("notice-minutes").value, simulation: byId("notice-consent").checked }, session.zones);
    const detail = await api("notices", input); if (generation !== epoch) return;
    selected = detail.notice.eventId; selectedKind = "notices"; offset = 0; byId("notice-consent").checked = false;
    busy = false; await refresh(true);
  } catch (error) {
    if (generation === epoch) {
      status(`${error.message} El aviso no se reemitió automáticamente. Consulta la lista antes de reintentar.`);
      if (session) timer = setTimeout(() => { if (document.visibilityState === "visible") void refresh(); }, error.status === 429 ? 60_000 : 30_000);
    }
  } finally { busy = false; byId("notice-create").disabled = false; byId("create").disabled = false; }
});
byId("logout").addEventListener("click", async () => {
  const request = api("logout", {}); clearPrivate(); byId("password").focus();
  try { await request; } catch { status("Vista privada cerrada. No se confirmó el cierre de la sesión en el servidor; vuelve a conectar y ciérrala, o espera su caducidad."); }
});
byId("refresh").addEventListener("click", () => { void refresh(); });
byId("previous").addEventListener("click", () => { if (!busy && offset > 0) { offset = Math.max(0, offset - LIMIT); void refresh(); } });
byId("next").addEventListener("click", () => { if (!busy && pageData?.hasMore) { offset += LIMIT; void refresh(); } });
window.addEventListener("online", () => { if (session) void refresh(); else void restoreSession(); });
window.addEventListener("offline", () => status("Sin ruta al centro. Última consulta conservada en esta vista; no es estado actualizado."));
window.addEventListener("pagehide", () => clearPrivate());
window.addEventListener("pageshow", (event) => { if (event.persisted) void restoreSession(); });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") { if (session) void refresh(); else void restoreSession(); }
  else clearTimeout(timer);
});
await restoreSession();
