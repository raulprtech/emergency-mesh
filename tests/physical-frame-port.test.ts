import assert from "node:assert/strict";
import test from "node:test";
import {
  MESHTASTIC_BROADCAST_NODE,
  MESHTASTIC_DATA_PAYLOAD_BYTES,
  MESHTASTIC_FRAME_CAPABILITIES,
  MESHTASTIC_PRIVATE_APP_PORT,
  createMeshtasticDataRequest,
} from "../src/transports/meshtastic-policy.ts";
import { isEmergencyMeshCustody, validateRawFrameSend } from "../src/transports/raw-frame-port.ts";

test("Meshtastic policy maps a maximum-size frame to PRIVATE_APP broadcast", () => {
  const frame = new Uint8Array(MESHTASTIC_DATA_PAYLOAD_BYTES).fill(7);
  const request = createMeshtasticDataRequest(frame, { requestRoutingAck: true });
  assert.equal(request.portNum, MESHTASTIC_PRIVATE_APP_PORT);
  assert.equal(request.destinationNode, MESHTASTIC_BROADCAST_NODE);
  assert.equal(request.wantAck, false);
  assert.deepEqual(request.payload, frame);
  assert.notEqual(request.payload, frame);
});

test("Meshtastic policy rejects frames above the official data payload ceiling", () => {
  assert.throws(
    () => createMeshtasticDataRequest(new Uint8Array(MESHTASTIC_DATA_PAYLOAD_BYTES + 1)),
    /exceeds physical port limit/,
  );
});

test("Meshtastic policy requests routing ACK only for unicast", () => {
  const request = createMeshtasticDataRequest(new Uint8Array([1, 2, 3]), {
    destinationNode: 0x1234_abcd,
    requestRoutingAck: true,
  });
  assert.equal(request.destinationNode, 0x1234_abcd);
  assert.equal(request.wantAck, true);
});

test("Meshtastic policy rejects invalid node identifiers", () => {
  for (const destinationNode of [-1, 1.5, 0x1_0000_0000, Number.NaN]) {
    assert.throws(() => createMeshtasticDataRequest(new Uint8Array([1]), { destinationNode }), /unsigned 32-bit/);
  }
});

test("raw-frame boundary rejects contradictory addressing and unsupported ACKs", () => {
  assert.throws(
    () => validateRawFrameSend(new Uint8Array([1]), { broadcast: true, destination: "peer" }, MESHTASTIC_FRAME_CAPABILITIES),
    /both broadcast and explicitly addressed/,
  );
  assert.throws(
    () => validateRawFrameSend(new Uint8Array([1]), { requestRoutingAck: true }, {
      ...MESHTASTIC_FRAME_CAPABILITIES,
      bidirectional: false,
    }),
    /bidirectional/,
  );
  assert.throws(
    () => validateRawFrameSend(new Uint8Array([1]), { requestRoutingAck: true }, {
      ...MESHTASTIC_FRAME_CAPABILITIES,
      acknowledgement: "LOCAL_QUEUE",
    }),
    /does not support routing acknowledgements/,
  );
});

test("physical transport acceptance never implies Emergency Mesh custody", () => {
  assert.equal(isEmergencyMeshCustody({
    acceptedByLocalPort: true,
    acceptance: "ROUTING_ACK",
    transportPacketId: "42",
  }), false);
});
