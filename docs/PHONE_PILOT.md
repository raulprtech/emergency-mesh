# Phone-to-command-center pilot

This pilot uses the existing PWA as the simulated user's application and one Ubuntu WSL2 process as the receiving command-center backend. It validates report creation, offline custody, synchronization, durable backend receipt, and public aggregation. It is not an emergency service or a responder dispatch system.

## Topology

```text
phone PWA → trusted HTTPS endpoint → Ubuntu WSL2 reference server → SQLite
      └──────────────── GET /api/areas ────────────────────────────────┘
```

The public map and the PWA are served by the same origin. A successful BACKEND acknowledgement means only that the reference backend stored the report. It does not mean that a person saw it, that help was dispatched, or that assistance will arrive.

## Start the durable receiver

From the repository in Ubuntu WSL2:

```bash
EMERGENCY_MESH_HOST=0.0.0.0 \
EMERGENCY_MESH_DATABASE_PATH=.data/pilot.sqlite \
npm start
```

The server creates the parent directory and SQLite database when needed. `GET /health` reports `"storage":"sqlite"`. Graceful `SIGINT` and `SIGTERM` shutdowns close the database before exit.

Keep `EMERGENCY_MESH_ENABLE_DEBUG_EVENTS` disabled on a network-accessible instance. `/api/events` contains individual reports and exists only as an explicit development diagnostic. The public phone and map flows need only `/mobile/`, `/api/packets`, and `/api/areas`.

## HTTPS is mandatory for the phone

The receiver can terminate TLS directly for an isolated LAN pilot. First identify the exact IP address or DNS name that the phone will use. It must route to the WSL2 listener and remain stable for the exercise. Generate fresh, short-lived pilot material on the Ubuntu filesystem, never under `/mnt/c`:

```bash
npm run pilot:cert -- 192.0.2.10
```

Replace the documentation-only address with the real phone-visible address. The generator creates a 30-day local CA and a 7-day server certificate under `.data/pilot-tls`, refuses to overwrite existing material, and fails if the filesystem cannot enforce private-key permissions. Install only `.data/pilot-tls/ca-cert.pem` as a trusted local CA on the test phone. Never copy `ca-key.pem` or `server-key.pem` from the Ubuntu command center.

Start the durable HTTPS receiver:

```bash
EMERGENCY_MESH_HOST=0.0.0.0 \
EMERGENCY_MESH_DATABASE_PATH=.data/pilot.sqlite \
EMERGENCY_MESH_TLS_CERT_PATH=.data/pilot-tls/server-cert.pem \
EMERGENCY_MESH_TLS_KEY_PATH=.data/pilot-tls/server-key.pem \
npm start
```

`GET /health` must return `"https":true`. Open the resulting HTTPS origin on the phone and confirm there is no certificate warning before installing:

- `/mobile/` — installable user PWA.
- `/` — public aggregate map.
- `/health` — receiver readiness.

Direct TLS does not make the receiver suitable for public Internet exposure. Keep this pilot on a trusted isolated network. A public deployment still needs a reviewed reverse proxy or tunnel, network-level limits, monitoring, domain validation, and an automatically renewed public certificate. Remove the temporary CA from the phone and securely delete its private key when the exercise ends.

## Privacy threshold

The public map defaults to a minimum group size of three reports in the same coarse area/time bucket. This is the expected pilot behavior: one person's report is stored and acknowledged but remains suppressed from the public map.

For an isolated demonstration using fictional data only, the threshold can be lowered explicitly:

```bash
EMERGENCY_MESH_PUBLIC_MIN_GROUP_SIZE=1 \
EMERGENCY_MESH_HOST=0.0.0.0 \
EMERGENCY_MESH_DATABASE_PATH=.data/demo.sqlite \
npm start
```

The server emits a warning whenever this threshold is below three. Never use the demonstration setting for real reports.

## Test sequence

1. Open the HTTPS `/mobile/` URL and install the PWA.
2. Create a fictional help report while online and verify the `SYNCED` state.
3. Enable airplane mode, create another report, and verify that it remains locally queued.
4. Restore connectivity and verify that the report advances only after BACKEND evidence.
5. Restart the Ubuntu server and verify `GET /health` still reports SQLite.
6. Confirm the stored report remains available to aggregation after restart.
7. With the default threshold, create at least three fictional reports in the same coarse area/time bucket before expecting a public card.

Record the phone model, OS/browser version, network path, HTTPS termination method, timestamps, and any failed or delayed synchronization. Delete the fictional pilot database after the exercise if its retention is no longer needed.

## Current boundary

This topology has one command-center receiver and therefore one availability dependency. A later deployment must support multiple gateways/backends, authenticated operator views, encrypted storage or protected data services, backup and recovery, monitoring, and tested operational escalation. The native app can reuse the same signed-envelope and aggregate APIs after the PWA pilot validates the workflow.
