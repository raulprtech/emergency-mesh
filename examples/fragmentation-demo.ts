import { fragmentEnvelope, FragmentReassembler } from "../src/protocol/fragmentation.ts";
import { serializeEnvelope } from "../src/protocol/codec.ts";
import { verifyReportSignature } from "../src/protocol/identity.ts";
import { makeReport } from "../src/simulator/fixtures.ts";

const report = makeReport({ eventId: "fragmentation-demo" });
const envelope = {
  packetId: "fragmentation-demo-packet",
  report,
  expiresAt: report.validUntil,
  hopCount: 0,
  hopLimit: 12,
  transportHistory: [],
};
const mtu = 180;
const frames = fragmentEnvelope(envelope, mtu);
const reassembler = new FragmentReassembler({ maxFrameBytes: mtu });
let result;
for (const frame of frames.toReversed()) result = reassembler.ingestEnvelope(frame);

console.log(JSON.stringify({
  envelopeBytes: serializeEnvelope(envelope).length,
  mtu,
  frameCount: frames.length,
  largestFrameBytes: Math.max(...frames.map((frame) => frame.length)),
  reassemblyStatus: result?.status,
  signatureValid: result?.envelope ? verifyReportSignature(result.envelope.report) : false,
}, null, 2));
