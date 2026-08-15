# Public aggregation and privacy policy

Raw reports and public map output are separate products. Storage preserves signed evidence; `publicAggregate` derives a policy-governed view without mutating it.

## Default public policy

- One decimal coordinate precision (roughly an 11 km latitude grid; longitude varies by latitude).
- One-hour observation buckets.
- At least three reports in the same area/time bucket.
- Maximum observation age of 24 hours.

Groups below the threshold are omitted. The response exposes only the number of suppressed groups, not their locations or event counts. Old and implausibly future observations are filtered before groups are formed.

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
    "suppressedGroups": 1
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

Thresholding alone does not prevent differencing, linkage, or background-knowledge attacks. Production deployments should publish fixed snapshots, limit query combinations and frequency, define only coarse public `zoneId` values, suppress sensitive categories independently, audit access, and consider noise or delayed release. Precise and protected information requires authorization outside the public map service.
