import { monitorEventLoopDelay } from "node:perf_hooks";

// Test-only launcher. Metrics travel through its parent's IPC, never a public endpoint.
if (!process.send) throw new Error("Instrumented fixture requires an owning IPC parent");
const lag = monitorEventLoopDelay({ resolution: 20 }); lag.enable();
let previousCpu = process.cpuUsage(); let previousAt = performance.now();
const timer = setInterval(() => {
  const now = performance.now(); const cpu = process.cpuUsage(); const memory = process.memoryUsage();
  if (process.connected) process.send({ type: "COLUVI_FIXTURE_METRICS", elapsedMs: now - previousAt,
    cpuUserMs: (cpu.user - previousCpu.user) / 1000, cpuSystemMs: (cpu.system - previousCpu.system) / 1000,
    rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, eventLoopMaxMs: lag.max / 1_000_000 });
  previousCpu = cpu; previousAt = now; lag.reset();
}, 1000); timer.unref();
process.once("disconnect", () => { clearInterval(timer); lag.disable(); process.exit(1); });
await import("../src/server.ts");
