import type { EmergencyReport } from "../protocol/types.ts";

export interface AreaAggregate {
  areaId: string;
  timeBucketStart?: number;
  timeBucketEnd?: number;
  total: number;
  critical: number;
  sos: number;
  needs: Record<string, number>;
  newestObservedAt: number;
}

export interface AggregationPolicy {
  /** Decimal coordinate precision. 1 is roughly an 11 km latitude grid. */
  spatialPrecisionDecimals: number;
  /** Time bucket width; zero disables time buckets. */
  timeBucketMs: number;
  /** Groups below this size are omitted entirely. */
  minimumGroupSize: number;
  /** Ignore observations older than this duration. */
  maximumAgeMs: number;
}

export interface AggregationResult {
  areas: AreaAggregate[];
  privacy: AggregationPolicy & {
    generatedAt: number;
    suppressedGroups: number;
  };
}

export const INTERNAL_AGGREGATION_POLICY: AggregationPolicy = {
  spatialPrecisionDecimals: 2,
  timeBucketMs: 0,
  minimumGroupSize: 1,
  maximumAgeMs: Number.MAX_SAFE_INTEGER,
};

export const PUBLIC_AGGREGATION_POLICY: AggregationPolicy = {
  spatialPrecisionDecimals: 1,
  timeBucketMs: 60 * 60_000,
  minimumGroupSize: 3,
  maximumAgeMs: 24 * 60 * 60_000,
};

export function validateAggregationPolicy(policy: AggregationPolicy): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(policy.spatialPrecisionDecimals) || policy.spatialPrecisionDecimals < 0 || policy.spatialPrecisionDecimals > 3) errors.push("spatialPrecisionDecimals must be an integer from 0 to 3");
  if (!Number.isInteger(policy.timeBucketMs) || policy.timeBucketMs < 0) errors.push("timeBucketMs must be a non-negative integer");
  if (!Number.isInteger(policy.minimumGroupSize) || policy.minimumGroupSize < 1) errors.push("minimumGroupSize must be a positive integer");
  if (!Number.isFinite(policy.maximumAgeMs) || policy.maximumAgeMs < 0) errors.push("maximumAgeMs must be non-negative");
  return errors;
}

function areaFor(report: EmergencyReport, precision: number): string {
  const location = report.location;
  if (location?.zoneId) return `zone:${location.zoneId}`;
  if (location?.latitude !== undefined && location.longitude !== undefined) {
    return `grid:${location.latitude.toFixed(precision)},${location.longitude.toFixed(precision)}`;
  }
  return "unknown";
}

export function aggregateReports(
  reports: Iterable<EmergencyReport>,
  policy: AggregationPolicy = INTERNAL_AGGREGATION_POLICY,
  now = Date.now(),
): AggregationResult {
  const errors = validateAggregationPolicy(policy);
  if (errors.length) throw new Error(`Invalid aggregation policy: ${errors.join("; ")}`);
  const groups = new Map<string, AreaAggregate>();
  const oldest = now - policy.maximumAgeMs;
  for (const report of reports) {
    if (policy.maximumAgeMs !== Number.MAX_SAFE_INTEGER && (report.observedAt < oldest || report.observedAt > now + 5 * 60_000)) continue;
    const areaId = areaFor(report, policy.spatialPrecisionDecimals);
    const timeBucketStart = policy.timeBucketMs > 0
      ? Math.floor(report.observedAt / policy.timeBucketMs) * policy.timeBucketMs
      : undefined;
    const key = `${areaId}|${timeBucketStart ?? "all"}`;
    const area = groups.get(key) ?? {
      areaId,
      timeBucketStart,
      timeBucketEnd: timeBucketStart === undefined ? undefined : timeBucketStart + policy.timeBucketMs,
      total: 0,
      critical: 0,
      sos: 0,
      needs: {},
      newestObservedAt: 0,
    };
    area.total += 1;
    if (report.priority === "CRITICAL") area.critical += 1;
    if (report.eventType === "SOS") area.sos += 1;
    area.newestObservedAt = Math.max(area.newestObservedAt, report.observedAt);
    for (const need of report.needs ?? []) area.needs[need.category] = (area.needs[need.category] ?? 0) + 1;
    groups.set(key, area);
  }
  let suppressedGroups = 0;
  const areas = [...groups.values()]
    .filter((area) => {
      const visible = area.total >= policy.minimumGroupSize;
      if (!visible) suppressedGroups += 1;
      return visible;
    })
    .sort((left, right) => right.critical - left.critical || right.total - left.total || left.areaId.localeCompare(right.areaId));
  return { areas, privacy: { ...policy, generatedAt: now, suppressedGroups } };
}
