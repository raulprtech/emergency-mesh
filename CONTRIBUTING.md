# Contributing

Thank you for helping build interoperable emergency communications infrastructure.

Start with an issue that names one module and its acceptance test. Protocol changes require an accompanying specification change, backward-compatibility note, JSON example, and binary test vector. Transport work must use the common adapter interface and must not modify an external protocol's internal routing.

Before proposing a change, run:

```bash
npm test
npm run demo
```

Keep safety claims precise: never state or imply guaranteed delivery, verified truth, responder acknowledgement, or current location when the data is historical. Do not include real emergency or personal data in fixtures.

Good first issues include: virtual clock, seeded packet loss, queue capacity limits, JSON Schema export, additional malformed-CBOR tests, aggregate age labels, and protocol examples in another language.

Security issues involving privacy exposure, signature bypass, replay amplification, or resource exhaustion should be reported privately to the maintainers rather than opened with exploit details in a public issue.
