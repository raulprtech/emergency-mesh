import assert from "node:assert/strict";
import test from "node:test";
import { PROTECTED_PAYLOAD_PREFIX, validateProtectedPayloadFormat } from "../src/protocol/protected-payload.ts";

test("protected payload parser rejects invalid and non-canonical base64url", () => {
  for (const encoded of ["@@@", "AA=", "A", "AA"]) {
    assert.notDeepEqual(validateProtectedPayloadFormat(PROTECTED_PAYLOAD_PREFIX + encoded), []);
  }
});
