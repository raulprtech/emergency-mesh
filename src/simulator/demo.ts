import { runVerticalSlice } from "./scenario.ts";

const result = await runVerticalSlice();
console.log(JSON.stringify({
  success: result.backend.size() === 1,
  eventId: result.report.eventId,
  route: result.trace,
  backendEvents: result.backend.size(),
  aggregate: result.backend.aggregate(),
}, null, 2));
