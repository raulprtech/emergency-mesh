# Offline mobile reference client

The first client is a dependency-free progressive web app at `/mobile/`. It is deliberately a thin protocol client, not a dispatch or responder application.

## Primary flow

The home screen offers four large actions:

- Estoy bien → `SAFE / SELF / NORMAL`
- Necesito recursos → `RESOURCE_REQUEST / SELF / NORMAL`
- Necesito asistencia → `ASSISTANCE_REQUEST / SELF / HIGH`
- Emergencia crítica → `SOS / SELF / CRITICAL`

Secondary flows create THIRD_PARTY SOS, PERSON_LAST_SEEN, and PERSON_FOUND reports. Person-related flows require a pseudonymous subject id but never require a name, telephone number, account, or installation by the reported person.

## Offline behavior

After the first successful visit, a Service Worker caches the application shell. Reports are created and saved in IndexedDB before any network attempt. The outbox retries when connectivity returns and never removes custody merely because a transport attempt began. When one-shot Background Sync is available, the app registers the queued outbox after durable local storage; a module service worker reopens the same IndexedDB database and retries even when the page is no longer active.

Delivery states are intentionally narrow:

- Created locally.
- Queued without delivery confirmation.
- Forwarded to a transport.
- Gateway reached, without human-attention confirmation.
- Received by a backend, without attention or assistance confirmation.
- Expired without final confirmation.

HTTP 429 admission responses leave the report in `QUEUED`, persist a bounded `nextAttemptAt`, and suppress foreground and background retries until that time. Server guidance is capped locally at one hour and never extends beyond signed expiration. Foreground and background attempts share a Web Locks mutex when available, while backend idempotency remains the duplicate-ingest boundary. A failed background attempt rejects its sync task so the browser may schedule another opportunity. Browsers without Background Sync or Web Locks retain the existing open-app, manual, and online-event fallbacks. No identity private key is read by the worker because queued envelopes are already signed.

Uncached API and asset requests fail honestly offline; only navigation within `/mobile/` may fall back to the cached application shell. The last synchronization error remains visible. HTTP acceptance includes explicit BACKEND evidence, which advances the local state to SYNCED.

## Coluvi pilot inbox

With the explicitly configured private service, the PWA imports `mobile-trust.json` and requires an independently verified authority fingerprint, authorized zone, enrollment code and pilot consent. It proves possession of the browser Ed25519 key and stores only the returned scoped credential and public trust. Unsigned devices can still use ordinary reporting, but cannot enroll or sign trusted check-ins.

The v2 IndexedDB migration adds inbox and receipt stores without replacing existing identity or reports. Polling is foreground-only, bounded, serialized and backed off on failure. A valid signed command commits with RECEIVED before its cursor advances. IntersectionObserver records SHOWN only when at least 25% of its card enters the visible page during the initial prompt window; neither receipt implies a human read it. The first-response actions persist a minimal signed SAFE or NEEDS_HELP envelope atomically with its command reference. This survives closing the window offline; duplicate clicks cannot create a second first response.

The UI now supports linked immutable state updates and late first responses until the total response deadline using CHECKIN_RESPONSE v2; v1 observations remain limited to the initial prompt window. Optional needs are a separate signed packet created only after saving NEEDS_HELP. They support nine categories and an optional declared group size, without summing that size across devices. New state snapshots do not inherit old needs. Both state and needs writes compare their expected predecessor inside an IndexedDB transaction, check the current enrollment token and retain local history. A concurrent loser must refresh rather than silently overwrite another tab. These are additive fields in existing v3 stores, not a destructive database migration.

Private APIs and the operator panel never enter the shell cache. Before private calls the UI confirms the v10 worker's cache policy; an old worker requires update/reload. Rotating identity clears local enrollment but preserves signed outbox history. The inbox is bounded to 200 commands, each with at most 100 state and 100 needs records, and explicitly prunes records 30 days after their response window. Full operational steps, browser evidence and physical limitations are in the [Coluvi demo guide](COLUVI_DEMO.md).

The additive v3 migration preserves the v2 stores and adds up to 200 operational notices with an independent cursor. Only explicitly provisioned `OPERATIONAL_NOTICE` authority capabilities permit polling and verification. A signed simulation notice commits with RECEIVED before advancing the cursor; SHOWN requires at least 25% of the card to intersect the visible page. Source label, signing identity, zone and validity remain visible offline; expired cards are marked historical, not current instructions. The message is rendered as literal text, not HTML. Notice receipts use the foreground private receipt queue, not a promise of background reception. See [operational notices](COLUVI_NOTICES.md).

## Local identity

The client creates an extractable Ed25519 key using Web Crypto and stores its JWK in IndexedDB. The pseudonymous device id is derived from the SHA-256 digest of the SPKI public key and produces signatures compatible with the shared protocol verifier.

If the browser lacks Ed25519, reporting remains available in visibly labelled unsigned mode. This preserves emergency access while making the loss of cryptographic continuity explicit. Rotating identity is user-controlled and warns that future reports will no longer link cryptographically to prior reports.

This storage is not hardened key custody. Native secure-enclave/keystore integration and recovery policy belong to a future native client.

## Location and protected information

The MVP requests location only after an explicit button press, uses low-accuracy geolocation, rounds coordinates to three decimals, and enforces at least 100 metres of declared uncertainty. The protocol now implements an interoperable protected-payload container, but this reference UI still does not collect precise coordinates because no authenticated deployment recipient policy is provisioned. Names and contact details are not requested.

## Accessibility and safety language

The interface uses semantic buttons, labelled fields, fieldsets, live status regions, a skip link, visible keyboard focus, minimum touch targets, and responsive action cards. Opening a report moves focus into the composer; Escape, cancel, and successful queue admission return it to the action that opened the flow. It honors reduced-motion and increased-contrast preferences. A persistent selector provides complete Spanish and English catalogs, updates the document language, and preserves equivalent non-guarantee language in both locales.

## Automated browser accessibility profile

`examples/accessibility-smoke.mjs` uses the Chromium accessibility tree plus a 360 × 640 CSS-pixel touch viewport, 2× device scale, five touch points, and 4× CPU throttling. It fails on unnamed interactive controls, missing landmarks or key labels, buttons below 44 × 44 CSS pixels, horizontal overflow, a multi-column primary-action layout, an invisible focused skip link, broken composer focus or keyboard dismissal, inactive reduced-motion or increased-contrast media queries, and page diagnostics. Run it through `npm run smoke:accessibility -- [debug-port] [target-url] [debug-host]` while the local server and a Chromium remote-debugging endpoint are active.

This is deterministic regression coverage, not assistive-technology certification. Manual testing with current screen readers, switch or voice input, low-end physical phones, and people performing high-stress tasks remains required.

## Verification

Unit tests cover Background Sync retry and locking, every action mapping, person semantics, location reduction, deterministic CBOR compatibility, cross-runtime Ed25519 verification, valid state transitions, offline custody, ACK synchronization, expiration, catalog parity, and accessibility landmarks. `examples/browser-smoke.mjs` drives a real local Chromium session through online initialization, locale persistence, a service-worker reload with transport disabled, offline IndexedDB custody, and synchronization after reconnection.

For strict offline evidence, use an unused loopback port and the managed fixture mode:

```bash
npm run smoke:browser -- 9222 http://127.0.0.1:8798/mobile/ 127.0.0.1 --managed-server
```

This starts its own in-memory fixture server, stops the entire backend during the offline stage, and restarts it before reconnection. A page-only network override does not necessarily isolate a Service Worker. The smoke now requires the new marker to remain `QUEUED` while offline; `SYNCED` is not accepted as proof of offline custody even when Background Sync is available. The managed mode accepts only explicit HTTP loopback targets, refuses occupied ports, cleans up its own child, and never stops or changes an existing pilot server. HTTP localhost is a secure context for this browser fixture, not a substitute for trusted HTTPS on an Android LAN origin.
