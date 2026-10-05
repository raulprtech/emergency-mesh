# Meshtastic Node Serial bench

This private subpackage is a provisional two-radio harness. It imports the GPL-3.0-only Meshtastic runtime and is therefore deliberately isolated from the Apache-2.0 core package. It is not included by the root install or test commands and must not be distributed without a specific license review.

The currently published packages are pinned exactly:

- `@meshtastic/core@2.6.7`
- `@meshtastic/transport-node-serial@0.0.2`

They come from the archived `meshtastic/js` generation. The active official `meshtastic/web` repository has moved to `@meshtastic/sdk` and `MeshClient`, but version 1.0 is not yet published in NPM or JSR as of 2026-08-15. Its structural surface was audited at commit `1db40fe80bc6adc737eb045943c533292efaee92`; the Emergency Mesh port accepts both shapes. Replace these dependencies when the active packages are published and rerun the contract test before touching radios.

## Install and contract check

Run only inside Ubuntu WSL2:

```bash
cd /home/raulprtech/emergency-mesh/integrations/meshtastic-node-serial
npm install
npm run contract
```

The contract check opens no serial device. It verifies that the pinned runtime still supplies the structural methods/events consumed by `MeshtasticSdkFramePort`. Validate a complete command without opening serial by appending `--dry-run`.

## Two-radio workflow

Both radios must already use compatible region, modem preset, channel index, and channel key. Their node numbers must be known in canonical `!xxxxxxxx` form. Attach the USB devices to WSL2 first and verify that paths such as `/dev/ttyACM0` exist.

On the receiving machine or terminal:

```bash
npm run bench -- --mode receive --device /dev/ttyACM0 \
  --node-id bench-b --peer-id bench-a --peer !11112222
```

On the sender:

```bash
npm run bench -- --mode send --device /dev/ttyACM1 \
  --node-id bench-a --peer-id bench-b --peer !33334444
```

The JSON output records MTU, elapsed time, frame counts, routing ACKs, failures, and byte counts. The sender creates only a LOW-priority `AREA_STATUS` report labelled `SYNTHETIC BENCH TEST - NOT AN EMERGENCY`. Its SQLite file retains custody if no peer ACK arrives. The receiver accepts the signed envelope and its ACK atomically in SQLite.

To require authenticated ACKs, set the same secret in both terminals without placing it in shell arguments or repository files:

```bash
export EMERGENCY_MESH_ACK_KEY_HEX='<at least 64 hexadecimal characters>'
npm run bench -- --mode receive ... --key-id bench-v1
```

Use a randomly generated deployment test key. Never reuse a Meshtastic channel PSK or production secret. Generated SQLite files live under the ignored `.data/` directory unless `--db` overrides the path.

## Honest boundary

Passing `npm run contract` proves only API shape. A successful bench run proves custody exchange under the recorded devices, firmware, region, preset, distance, and conditions. It does not prove general range, guaranteed delivery, report truth, responder receipt, or suitability for emergency dispatch.
