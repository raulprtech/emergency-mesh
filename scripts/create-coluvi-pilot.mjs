import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createDeviceIdentity } from "../src/protocol/identity.ts";
import { createColuviConfiguration } from "../src/commands/config.ts";

const origin = process.argv[2];
const directory = process.argv[3];
const zones = process.argv.slice(4);
if (!origin || !directory || !zones.length) throw new Error("Usage: node scripts/create-coluvi-pilot.mjs <https-origin-or-loopback> <new-private-directory> <zone> [zone...]");
const material = await createColuviConfiguration(createDeviceIdentity(), origin, zones);
const target = resolve(directory);
// Exclusive directory creation and exclusive writes never replace existing pilot secrets.
mkdirSync(target, { mode: 0o700 });
writeFileSync(resolve(target, "operator-config.json"), JSON.stringify(material.configuration, null, 2) + "\n", { flag: "wx", mode: 0o600 });
writeFileSync(resolve(target, "mobile-trust.json"), JSON.stringify(material.mobileTrust, null, 2) + "\n", { flag: "wx", mode: 0o600 });
writeFileSync(resolve(target, "operator-secrets.txt"), `Local pilot only. Keep this file private. Never commit or send it to a phone.\nOperator password: ${material.operatorPassword}\nEnrollment code: ${material.enrollmentCode}\nMobile authority SHA-256: ${material.mobileTrust.fingerprint}\n`, { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ configurationPath: resolve(target, "operator-config.json"), mobileTrustPath: resolve(target, "mobile-trust.json"), secretsPath: resolve(target, "operator-secrets.txt"), fingerprint: material.mobileTrust.fingerprint }));
