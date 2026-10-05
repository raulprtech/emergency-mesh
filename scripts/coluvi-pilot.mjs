import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { backupPilot, diagnosePilot, restorePilot, preparePilotStart, PilotOperationError } from "../src/operations/pilot.js";
import { preflightPilot } from "../src/operations/preflight.js";

// Foreground only: no daemon, firewall changes, installation or secret output.
const [operation, source, ...args] = process.argv.slice(2);
const usage = "Usage: node scripts/coluvi-pilot.mjs diagnose <pilot-dir> | preflight <pilot-dir> [--probe] [--tls-cert FILE --tls-key FILE --ca-cert FILE] | backup <pilot-dir> <new-backup-dir> | restore <backup-dir> <new-pilot-dir> | start <pilot-dir> [--host HOST] [--tls-cert FILE --tls-key FILE] [--acknowledge-rollback]";
process.umask(0o077);
try {
  if (!source) throw new PilotOperationError(usage);
  if (operation === "diagnose" && args.length === 0) console.log(JSON.stringify(diagnosePilot(source), null, 2));
  else if (operation === "preflight") {
    const options = {}; const seen = new Set();
    for (let index = 0; index < args.length; index++) {
      const flag = args[index]; if (seen.has(flag)) throw new PilotOperationError(usage); seen.add(flag);
      if (flag === "--probe") options.probe = true;
      else if (["--tls-cert", "--tls-key", "--ca-cert"].includes(flag) && args[index + 1] && !args[index + 1].startsWith("--")) options[{ "--tls-cert": "tlsCert", "--tls-key": "tlsKey", "--ca-cert": "caCert" }[flag]] = args[++index];
      else throw new PilotOperationError(usage);
    }
    const result = await preflightPilot(source, options);
    console.log(JSON.stringify(result, null, 2)); process.exitCode = result.status === "FAIL" ? 1 : 0;
  }
  else if (operation === "backup" && args.length === 1) console.log(JSON.stringify(await backupPilot(source, args[0]), null, 2));
  else if (operation === "restore" && args.length === 1) console.log(JSON.stringify(await restorePilot(source, args[0]), null, 2));
  else if (operation === "start") {
    const options = {}; const seen = new Set();
    for (let index = 0; index < args.length; index++) {
      const flag = args[index]; if (seen.has(flag)) throw new PilotOperationError(usage); seen.add(flag);
      if (flag === "--acknowledge-rollback") options.acknowledgeRollback = true;
      else if (["--host", "--tls-cert", "--tls-key"].includes(flag) && args[index + 1] && !args[index + 1].startsWith("--")) options[{ "--host": "host", "--tls-cert": "tlsCert", "--tls-key": "tlsKey" }[flag]] = args[++index];
      else throw new PilotOperationError(usage);
    }
    const prepared = await preparePilotStart(source, options);
    console.log(JSON.stringify({ starting: prepared.origin, directory: prepared.root, foreground: true, physicalConnectivityVerified: false }));
    const child = spawn(process.execPath, [fileURLToPath(new URL("../src/server.ts", import.meta.url))], { stdio: "inherit", env: { ...process.env, ...prepared.environment } });
    let shutdownTimer;
    const handlers = ["SIGINT", "SIGTERM"].map(signal => { const handler = () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
        shutdownTimer ??= setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 3_000);
      }
    }; process.on(signal, handler); return [signal, handler]; });
    try { process.exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGINT" || signal === "SIGTERM" ? 0 : 1))); }); }
    finally { clearTimeout(shutdownTimer); for (const [signal, handler] of handlers) process.off(signal, handler); }
  } else throw new PilotOperationError(usage);
} catch (error) {
  console.error(error instanceof PilotOperationError ? error.message : "Pilot operation failed. Check explicit paths, ownership, permissions, configuration and integrity. No existing file is replaced; an incomplete new destination may remain.");
  process.exitCode = 1;
}
