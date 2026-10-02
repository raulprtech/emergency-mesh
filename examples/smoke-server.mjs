import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));

export function createManagedSmokeServer(targetUrl) {
  const target = new URL(targetUrl);
  const port = Number(target.port);
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" ||
      !Number.isInteger(port) || port < 1 || port > 65535 || target.username || target.password) {
    throw new Error("Managed smoke server requires an explicit http://127.0.0.1:<port> target");
  }
  let child;
  const stop = async () => {
    const running = child;
    if (!running || running.exitCode !== null || running.signalCode !== null) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => running.kill("SIGKILL"), 5_000);
      running.once("exit", () => { clearTimeout(timer); resolve(); });
      running.kill("SIGTERM");
    });
    if (child === running) child = undefined;
  };
  return {
    stop,
    async start() {
      if (child && child.exitCode === null && child.signalCode === null) throw new Error("Smoke server is already running");
      child = spawn(process.execPath, ["src/server.ts"], {
        cwd: repository,
        env: {
          ...process.env,
          PORT: String(port),
          EMERGENCY_MESH_HOST: "127.0.0.1",
          EMERGENCY_MESH_DATABASE_PATH: "",
          EMERGENCY_MESH_TLS_CERT_PATH: "",
          EMERGENCY_MESH_TLS_KEY_PATH: "",
          EMERGENCY_MESH_ENABLE_DEBUG_EVENTS: "0",
          EMERGENCY_MESH_PUBLIC_MIN_GROUP_SIZE: "3",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const running = child;
      let diagnostics = "";
      running.stderr.setEncoding("utf8");
      running.stderr.on("data", (chunk) => { diagnostics += chunk; });
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`Smoke server startup timed out: ${diagnostics}`)), 5_000);
          running.stdout.setEncoding("utf8");
          running.stdout.on("data", (chunk) => {
            if (chunk.includes(`http://127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); }
          });
          running.once("error", (error) => { clearTimeout(timer); reject(error); });
          running.once("exit", (code) => {
            clearTimeout(timer);
            reject(new Error(`Smoke server exited before ready (${code}): ${diagnostics}`));
          });
        });
      } catch (error) {
        await stop();
        throw error;
      }
    },
  };
}
