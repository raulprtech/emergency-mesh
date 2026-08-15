export interface QueueLimits {
  /** Maximum active custody records. */
  maxItems?: number;
  /** Maximum serialized envelope bytes in active custody. */
  maxBytes?: number;
  /** Time to remember an event after its signed expiration. */
  replayRetentionMs?: number;
}

export const DEFAULT_QUEUE_LIMITS: Required<QueueLimits> = {
  maxItems: 1_000,
  maxBytes: 4 * 1024 * 1024,
  replayRetentionMs: 24 * 60 * 60_000,
};

export function resolveQueueLimits(limits: QueueLimits = {}): Required<QueueLimits> {
  const resolved = { ...DEFAULT_QUEUE_LIMITS, ...limits };
  if (!Number.isInteger(resolved.maxItems) || resolved.maxItems < 1) throw new Error("maxItems must be a positive integer");
  if (!Number.isInteger(resolved.maxBytes) || resolved.maxBytes < 1) throw new Error("maxBytes must be a positive integer");
  if (!Number.isFinite(resolved.replayRetentionMs) || resolved.replayRetentionMs < 0) throw new Error("replayRetentionMs must be non-negative");
  return resolved;
}
