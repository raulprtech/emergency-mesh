import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const usage = "Usage: node scripts/generate-pilot-cert.mjs <phone-visible IP-or-DNS-name> [output-directory]";
if (process.argv.includes("--help")) {
  console.log(usage);
  process.exit(0);
}

const address = process.argv[2];
const outputDirectory = resolve(process.argv[3] ?? ".data/pilot-tls");
const dnsName = (value) => value.length <= 253 && value.split(".").every((label) =>
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
if (!address || (!isIP(address) && !dnsName(address))) throw new Error(`${usage}\nAddress must be an IP address or a plain DNS name without a URL scheme or port`);

const paths = {
  caKey: resolve(outputDirectory, "ca-key.pem"),
  caCertificate: resolve(outputDirectory, "ca-cert.pem"),
  serverKey: resolve(outputDirectory, "server-key.pem"),
  serverCertificate: resolve(outputDirectory, "server-cert.pem"),
  request: resolve(outputDirectory, "server.csr"),
  extensions: resolve(outputDirectory, "server-ext.cnf"),
  serial: resolve(outputDirectory, "ca-cert.srl"),
};
for (const path of Object.values(paths)) {
  if (existsSync(path)) throw new Error(`Refusing to overwrite existing TLS material: ${path}`);
}
mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
chmodSync(outputDirectory, 0o700);
if ((statSync(outputDirectory).mode & 0o077) !== 0) throw new Error(`Filesystem cannot enforce private directory permissions for ${outputDirectory}`);

function openssl(...args) {
  const result = spawnSync("openssl", args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`openssl ${args[0]} failed with status ${result.status}`);
}

const subjectAlternativeName = isIP(address) ? `IP:${address}` : `DNS:${address}`;
let completed = false;
try {
  openssl("genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", paths.caKey);
  openssl("req", "-x509", "-new", "-key", paths.caKey, "-sha256", "-days", "30",
    "-subj", "/CN=Emergency Mesh Pilot Local CA", "-out", paths.caCertificate,
    "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign");
  openssl("genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", paths.serverKey);
  openssl("req", "-new", "-key", paths.serverKey, "-subj", `/CN=${address}`, "-out", paths.request);
  writeFileSync(paths.extensions, [
    `subjectAltName=${subjectAlternativeName}`,
    "basicConstraints=critical,CA:FALSE",
    "keyUsage=critical,digitalSignature",
    "extendedKeyUsage=serverAuth",
    "",
  ].join("\n"), { mode: 0o600 });
  openssl("x509", "-req", "-in", paths.request, "-CA", paths.caCertificate, "-CAkey", paths.caKey,
    "-CAcreateserial", "-out", paths.serverCertificate, "-days", "7", "-sha256", "-extfile", paths.extensions);
  chmodSync(paths.caKey, 0o600);
  chmodSync(paths.serverKey, 0o600);
  for (const path of [paths.caKey, paths.serverKey]) {
    if ((statSync(path).mode & 0o077) !== 0) throw new Error(`Filesystem cannot enforce private key permissions for ${path}`);
  }
  chmodSync(paths.caCertificate, 0o644);
  chmodSync(paths.serverCertificate, 0o644);
  completed = true;
} finally {
  for (const path of [paths.request, paths.extensions, paths.serial]) rmSync(path, { force: true });
  if (!completed) {
    for (const path of [paths.caKey, paths.caCertificate, paths.serverKey, paths.serverCertificate]) rmSync(path, { force: true });
  }
}

console.log(JSON.stringify({
  address,
  caCertificate: paths.caCertificate,
  serverCertificate: paths.serverCertificate,
  serverKey: paths.serverKey,
  expiresInDays: 7,
  warning: "Install only ca-cert.pem on the phone; never copy ca-key.pem or server-key.pem",
}, null, 2));
