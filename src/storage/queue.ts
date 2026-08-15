import type { EmergencyEnvelope } from "../protocol/types.ts";
import type { QueueRecord } from "./store.ts";

export interface StoreAndForwardStore {
  enqueue(envelope: EmergencyEnvelope, now?: number): boolean;
  ready(now?: number): QueueRecord[];
  recordFailure(eventId: string, now?: number): void;
  remove(eventId: string): boolean;
  has(eventId: string): boolean;
  size(): number;
  hasSeen(eventId: string): boolean;
  prune(now?: number): number;
}
