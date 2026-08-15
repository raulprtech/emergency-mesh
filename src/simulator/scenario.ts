import { ReferenceBackend } from "../backend/backend.ts";
import { Gateway } from "../gateway/gateway.ts";
import { DeterministicRoutingManager } from "../routing/manager.ts";
import { InternetAdapter } from "../transports/internet.ts";
import { MockTransportAdapter } from "../transports/mock.ts";
import { makeReport } from "./fixtures.ts";
import { SimulatedNode } from "./node.ts";

export async function runVerticalSlice() {
  const backend = new ReferenceBackend();
  const gateway = new Gateway("gateway-1", backend);
  const routing = new DeterministicRoutingManager();
  const nodeA = new SimulatedNode("node-a", routing);
  const nodeB = new SimulatedNode("node-b", routing);
  const aToB = new MockTransportAdapter("mock-a-b");
  const internetB = new InternetAdapter("internet-b", gateway);
  aToB.connect((envelope) => nodeB.receive(envelope));
  nodeA.addTransport(aToB);
  nodeB.addTransport(internetB);

  const report = makeReport();
  const envelope = nodeA.create(report);
  const firstHop = await nodeA.flush(report.createdAt);
  const whileOffline = await nodeB.flush(report.createdAt);
  internetB.setOnline(true);
  const afterEgress = await nodeB.flush(report.createdAt + 1_001);

  return { backend, gateway, nodeA, nodeB, report, envelope, trace: { firstHop, whileOffline, afterEgress } };
}
