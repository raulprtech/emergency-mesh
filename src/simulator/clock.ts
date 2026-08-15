export interface Clock {
  now(): number;
}

export class SystemClock implements Clock {
  now(): number { return Date.now(); }
}

export class VirtualClock implements Clock {
  private current: number;
  constructor(startAt = 0) { this.current = startAt; }
  now(): number { return this.current; }
  advance(milliseconds: number): number {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error("Clock advance must be non-negative");
    this.current += milliseconds;
    return this.current;
  }
  set(timestamp: number): void {
    if (timestamp < this.current) throw new Error("Virtual clock cannot move backwards");
    this.current = timestamp;
  }
}
