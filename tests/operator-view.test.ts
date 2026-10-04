import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkinInput, noticeInput, METRICS, STATES, requestPhase } from "../src/web/operator/view.js";
import { operatorAsset } from "../src/web/operator/assets.ts";

test("operator input is scoped and keeps minutes bounded without implicit coercion to defaults", () => {
  assert.deepEqual(checkinInput("drill-flood", "refuge", "10", "0", ["refuge"]), { incidentRef: "drill-flood", zoneId: "refuge", promptMs: 600_000, lateMs: 0 });
  for (const input of [["<script>", "refuge", 10, 1], ["drill", "elsewhere", 10, 1], ["drill", "refuge", 0, 1], ["drill", "refuge", 1441, 1], ["drill", "refuge", 1.5, 1], ["drill", "refuge", 10, -1], ["drill", "refuge", 10, 1441]]) {
    assert.throws(() => checkinInput(...input, ["refuge"]));
  }
});
test("operator labels separate deadlines, custody and missing answers from danger", () => {
  const payload = { promptUntil: 100, responseUntil: 200 };
  assert.match(requestPhase(payload, 99), /abierto/); assert.match(requestPhase(payload, 100), /guardadas/); assert.match(requestPhase(payload, 200), /cerrada/);
  assert.match(STATES.UNKNOWN, /no implica peligro/);
  assert.deepEqual(METRICS.map(([key]) => key), ["requested", "received", "shown", "responded", "safe", "needsHelp", "unknown", "pending", "late"]);
});
test("notice form requires simulation consent, authorized zone and bounded UTF-8 text", () => {
  const input = { incidentRef: "drill", zoneId: "north", sourceLabel: "Equipo", title: "Prueba", message: "SIMULACRO", level: "WARNING", minutes: "60", simulation: true };
  assert.equal(noticeInput(input, ["north"]).validMs, 3_600_000);
  for (const patch of [{ simulation: false }, { zoneId: "south" }, { minutes: "0" }, { level: "EMERGENCY" }, { message: "é".repeat(601) }, { sourceLabel: " " }]) assert.throws(() => noticeInput({ ...input, ...patch }, ["north"]));
});
test("operator assets are exact allowlist, static shell has no embedded private data or inline scripts", () => {
  for (const path of ["/command-center/", "/command-center/app.js", "/command-center/view.js", "/command-center/styles.css"]) assert.ok(operatorAsset(path));
  for (const path of ["/command-center/../commands/config.ts", "/command-center/?password=secret", "/command-center/config.json"]) assert.equal(operatorAsset(path), undefined);
  const html = operatorAsset("/command-center/")!.body.toString();
  assert.match(html, /id="workspace" hidden/); assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
  const script = readFileSync(new URL("../src/web/operator/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(script, /localStorage|sessionStorage|innerHTML/);
  assert.match(script, /generation !== epoch/); assert.match(script, /pagehide/); assert.match(script, /no-store/);
});
