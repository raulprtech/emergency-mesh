import type { EmergencyEnvelope } from "../protocol/types.ts";
import type { EmergencyBackend, IngestResult } from "../backend/backend.ts";

export class Gateway {
  readonly id: string;
  private readonly backend: EmergencyBackend;
  constructor(id: string, backend: EmergencyBackend) { this.id = id; this.backend = backend; }
  sync(envelope: EmergencyEnvelope, now = Date.now()): IngestResult {
    // The gateway preserves the semantic report exactly as received.
    return this.backend.ingest(structuredClone(envelope), now);
  }
}
