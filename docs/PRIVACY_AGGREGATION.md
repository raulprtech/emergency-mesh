# Public aggregation and privacy policy

Raw reports and public map output are separate products. Storage preserves signed evidence; `publicAggregate` derives a policy-governed view without mutating it.

## Default public policy

- One decimal coordinate precision (roughly an 11 km latitude grid; longitude varies by latitude).
- One-hour observation buckets.
- At least three reports in the same area/time bucket.
- Maximum observation age of 24 hours.

Groups below the threshold are omitted. The response exposes only the number of suppressed groups, not their locations or event counts. Old and implausibly future observations are filtered before groups are formed.

Public breakdowns are now jointly protected. For a visible group, `critical`, `sos`, and all nine standard need-category counts are `null` together when the total is below twice the group threshold, or when any two distinct released count candidates (including zero and the total) differ by less than the threshold. Otherwise the nine category keys are always present, including true zero counts. This avoids exposing a rare count by publishing its complement or a simple difference between related breakdowns. Unknown extension categories are not exposed; the internal projection retains them. Repeated copies of a need category within one report count once.

`null` means **not published**, never zero. The public map labels it explicitly and filters only published positive counts. Sorting uses only the released values, not a withheld priority count. Counts represent reports, not distinct people, households, or devices; the report threshold must not be described as person-level anonymity. Operational `x-coluvi-*` events are excluded entirely.

The API returns:

```json
{
  "areas": [],
  "privacy": {
    "spatialPrecisionDecimals": 1,
    "timeBucketMs": 3600000,
    "minimumGroupSize": 3,
    "maximumAgeMs": 86400000,
    "generatedAt": 1800000000000,
    "suppressedGroups": 1,
    "protectBreakdowns": true,
    "breakdownProtection": true
  }
}
```

Environment variables can make an instance stricter or adapt it to geography:

- `EMERGENCY_MESH_PUBLIC_SPATIAL_DECIMALS`
- `EMERGENCY_MESH_PUBLIC_BUCKET_MINUTES`
- `EMERGENCY_MESH_PUBLIC_MIN_GROUP_SIZE`
- `EMERGENCY_MESH_PUBLIC_MAX_AGE_HOURS`

Invalid policies fail during startup. `/api/events` is disabled unless `EMERGENCY_MESH_ENABLE_DEBUG_EVENTS=1`; it must not be enabled on a public reference deployment.

## Limitations

Joint breakdown suppression is not differential privacy and does not prevent arbitrary combinations, differencing across successive snapshots, linkage, repeated submissions, or background-knowledge attacks. Production deployments should publish fixed snapshots, limit query combinations and frequency, define only coarse public `zoneId` values, audit access, and consider noise or delayed release. Precise and protected information requires authorization outside the public map service.

The map persists only a whitelisted public snapshot in a separate IndexedDB database, discards snapshots after at most 24 hours when read, and filters out aged observations. Its service worker caches only an explicit list of map shell assets and local geometry—not API responses, authenticated requests, or the operator panel. See [local public map](PUBLIC_MAP.md).
