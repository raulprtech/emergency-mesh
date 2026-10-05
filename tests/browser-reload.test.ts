import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { reloadDocument } from "../examples/browser-fixture.mjs";

test("browser reload witness rejects an unchanged old document even if its UI was already ready", async () => {
  let context = { document: { readyState: "complete" } };
  let sent = false; let waited = false;
  await reloadDocument({
    evaluate: async (expression: string) => runInNewContext(expression, context),
    send: async (method: string) => { assert.equal(method, "Page.reload"); sent = true; },
    until: async (expression: string) => {
      assert.equal(sent, true); assert.equal(runInNewContext(expression, context), false);
      context = { document: { readyState: "loading" } }; assert.equal(runInNewContext(expression, context), false);
      context.document.readyState = "complete"; assert.equal(runInNewContext(expression, context), true); waited = true;
    },
  }, "test reload");
  assert.equal(waited, true);
});
