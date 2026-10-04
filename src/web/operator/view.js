export const METRICS = Object.freeze([
  ["requested", "Solicitados"], ["received", "Recibidos"], ["shown", "Mostrados"], ["responded", "Respondidos"],
  ["safe", "Estoy bien"], ["needsHelp", "Necesito ayuda"], ["unknown", "Sin respuesta · UNKNOWN"], ["pending", "Plazo abierto sin respuesta"], ["late", "Última respuesta llegó tarde"],
]);
export const STATES = Object.freeze({ SAFE: "Estoy bien", NEEDS_HELP: "Necesito ayuda", UNKNOWN: "Sin respuesta al vencer el plazo · no implica peligro", PENDING: "Sin respuesta · plazo abierto" });
export function checkinInput(incidentRef, zoneId, promptMinutes, lateMinutes, zones) {
  const prompt = Number(promptMinutes); const late = Number(lateMinutes);
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(incidentRef) || !zones.includes(zoneId)
    || !Number.isInteger(prompt) || prompt < 1 || prompt > 1440 || !Number.isInteger(late) || late < 0 || late > 1440) throw new Error("Revisa zona, referencia y plazos.");
  return { incidentRef, zoneId, promptMs: prompt * 60_000, lateMs: late * 60_000 };
}
export function requestPhase(payload, now = Date.now()) {
  return now < payload.promptUntil ? "Plazo de respuesta abierto" : now < payload.responseUntil ? "Solo entrega de respuestas ya guardadas" : "Ventana de entrega cerrada";
}
export function metricsElement(counts, document = globalThis.document, metrics = METRICS) {
  const list = document.createElement("dl"); list.className = "metrics";
  for (const [key, label] of metrics) {
    const group = document.createElement("div"); group.dataset.metric = key;
    const term = document.createElement("dt"); term.textContent = label;
    const value = document.createElement("dd"); value.textContent = String(counts[key]);
    group.append(term, value); list.append(group);
  }
  return list;
}

export function noticeInput(input, zones) {
  const minutes = Number(input.minutes);
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(input.incidentRef) || !zones.includes(input.zoneId) || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440
    || !["INFORMATION", "WARNING"].includes(input.level) || input.simulation !== true) throw new Error("Revisa zona, referencia, vigencia y confirmación de simulacro.");
  for (const [key, limit] of [["sourceLabel", 120], ["title", 160], ["message", 1200]]) {
    if (typeof input[key] !== "string" || !input[key].trim() || new TextEncoder().encode(input[key]).length > limit || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(input[key])) throw new Error("Revisa los textos y sus límites de bytes UTF-8.");
  }
  const { minutes: _minutes, ...fields } = input; return { ...fields, validMs: minutes * 60_000 };
}
