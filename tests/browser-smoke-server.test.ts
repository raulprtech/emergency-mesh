import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createManagedSmokeServer } from "../examples/smoke-server.mjs";

test("managed browser smoke rejects remote and ambiguous targets", () => {
  for (const target of ["https://127.0.0.1:8798/mobile/", "http://192.168.1.10:8798/mobile/", "http://127.0.0.1/mobile/", "http://user:password@127.0.0.1:8798/"]) {
    assert.throws(() => createManagedSmokeServer(target), /explicit http/);
  }
});

test("managed smoke server isolates fixture storage and stops the whole backend", { timeout: 20_000 }, async () => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const server = createManagedSmokeServer(`${origin}/mobile/`);
  try {
    await server.start();
    const health = await (await fetch(`${origin}/health`)).json();
    assert.equal(health.storage, "memory");
    assert.equal(health.https, false);
    assert.equal((await fetch(`${origin}/api/events`)).status, 404);
    const aggregate = await (await fetch(`${origin}/api/areas`)).json();
    assert.equal(aggregate.privacy.minimumGroupSize, 3);
    await assert.rejects(server.start(), /already running/);
    await server.stop();
    await assert.rejects(fetch(`${origin}/health`));
    await server.start();
    assert.equal((await fetch(`${origin}/health`)).status, 200);
  } finally {
    await server.stop();
  }
});

test("managed smoke refuses an occupied port without stopping its owner", { timeout: 20_000 }, async () => {
  const existing = createServer((_request, response) => response.end("unrelated server"));
  await new Promise<void>((resolve) => existing.listen(0, "127.0.0.1", resolve));
  const address = existing.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const smoke = createManagedSmokeServer(`${origin}/mobile/`);
  try {
    await assert.rejects(smoke.start(), /EADDRINUSE|address already in use/);
    assert.equal(await (await fetch(origin)).text(), "unrelated server");
  } finally {
    await smoke.stop();
    await new Promise<void>((resolve, reject) => existing.close((error) => error ? reject(error) : resolve()));
  }
});
