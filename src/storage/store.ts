import { serializeEnvelope } from "../protocol/codec.ts";
import { resolveQueueLimits, type QueueLimits } from "./limits.ts";
import { canForward, isExpired, type EmergencyEnvelope } from "../protocol/types.ts";

const priorityRank = { CRITICAL: 0, HIGH: 1, NORMAL: 2, LOW: 3 } as const;

export interface QueueRecord {
  envelope: EmergencyEnvelope;
  receivedAt: number;
  attempts: number;
  nextAttemptAt: number;
  byteSize: number;
}

export class StoreAndForwardQueue {
  private readonly records = new Map<string, QueueRecord>();
  private readonly seen = new Map<string, number>();
  private readonly limits: Required<QueueLimits>;

  constructor(limits: QueueLimits = {}) { this.limits = resolveQueueLimits(limits); }

  enqueue(envelope: EmergencyEnvelope, now = Date.now()): boolean {
    this.prune(now);
    const id = envelope.report.eventId;
    if (this.seen.has(id) || isExpired(envelope, now)) return false;
    const byteSize = serializeEnvelope(envelope).length;
    if (!this.makeRoom(envelope, byteSize)) return false;
    this.seen.set(id, envelope.expiresAt + this.limits.replayRetentionMs);
    this.records.set(id, { envelope: structuredClone(envelope), receivedAt: now, attempts: 0, nextAttemptAt: now, byteSize });
    return true;
  }

  ready(now = Date.now()): QueueRecord[] {
    this.prune(now);
    return [...this.records.values()]
      .filter((record) => record.nextAttemptAt <= now && canForward(record.envelope, now))
      .sort((left, right) =>
        priorityRank[left.envelope.report.priority] - priorityRank[right.envelope.report.priority]
        || left.receivedAt - right.receivedAt,
      );
  }

  recordFailure(eventId: string, now = Date.now()): void {
    const record = this.records.get(eventId);
    if (!record) return;
    record.attempts += 1;
    record.nextAttemptAt = now + Math.min(60_000, 1_000 * 2 ** Math.min(record.attempts, 6));
  }

  remove(eventId: string): boolean { return this.records.delete(eventId); }
  has(eventId: string): boolean { return this.records.has(eventId); }
  size(): number { return this.records.size; }
  hasSeen(eventId: string): boolean { return this.seen.has(eventId); }

  prune(now = Date.now()): number {
    let removed = 0;
    for (const [id, record] of this.records) {
      if (isExpired(record.envelope, now) || record.envelope.hopCount >= record.envelope.hopLimit) {
        this.records.delete(id);
        removed += 1;
      }
    }
    for (const [id, seenUntil] of this.seen) if (seenUntil <= now && !this.records.has(id)) this.seen.delete(id);
    return removed;
  }

  private makeRoom(envelope: EmergencyEnvelope, byteSize: number): boolean {
    if (byteSize > this.limits.maxBytes) return false;
    let items = this.records.size + 1;
    let bytes = [...this.records.values()].reduce((total, record) => total + record.byteSize, 0) + byteSize;
    if (items <= this.limits.maxItems && bytes <= this.limits.maxBytes) return true;
    const incomingRank = priorityRank[envelope.report.priority];
    const candidates = [...this.records.entries()]
      .filter(([, record]) => priorityRank[record.envelope.report.priority] > incomingRank)
      .sort((left, right) => priorityRank[right[1].envelope.report.priority] - priorityRank[left[1].envelope.report.priority] || right[1].receivedAt - left[1].receivedAt);
    const evict: string[] = [];
    for (const [id, record] of candidates) {
      evict.push(id); items -= 1; bytes -= record.byteSize;
      if (items <= this.limits.maxItems && bytes <= this.limits.maxBytes) break;
    }
    if (items > this.limits.maxItems || bytes > this.limits.maxBytes) return false;
    for (const id of evict) this.records.delete(id);
    return true;
  }
}
