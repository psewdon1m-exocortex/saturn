import { X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import tls from "node:tls";
import { spawnSync } from "node:child_process";
import { runCommand } from "./stage13-command.mjs";

export function assertCertificate(certificate, ca, hostname, now = Date.now()) {
  const leaf = new X509Certificate(certificate), authority = new X509Certificate(ca);
  for (const value of [leaf, authority]) if (now < Date.parse(value.validFrom) || now >= Date.parse(value.validTo)) throw new Error("Stage13 certificate is outside its validity interval");
  if (!authority.ca || !leaf.verify(authority.publicKey) || !leaf.checkHost(hostname)) throw new Error("Stage13 certificate chain/name verification failed");
  return { leafSha256: leaf.fingerprint256.replaceAll(":", "").toLowerCase(), caSha256: authority.fingerprint256.replaceAll(":", "").toLowerCase(), validTo: leaf.validTo, hostname };
}
export function installProcessTrust(ca) {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED !== undefined && process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "1") throw new Error("Insecure inherited TLS configuration is refused");
  if (typeof tls.setDefaultCACertificates !== "function") throw new Error("Stage13 requires Node >=24 with per-process CA trust");
  const previous = tls.getCACertificates("default");
  tls.setDefaultCACertificates([...previous, String(ca)]);
  return () => tls.setDefaultCACertificates(previous);
}
export async function prepareBrowserTrust(root, caFile, execute = spawnSync) {
  if (process.platform !== "linux") throw new Error("Native Chromium trust fixture requires Linux + certutil; provide VAULT_STAGE13_BROWSER_IMAGE on other hosts");
  const home = path.join(root, "browser-home");
  const database = path.join(home, ".pki", "nssdb");
  await fs.mkdir(database, { recursive: true, mode: 0o700 });
  for (const args of [["-N", "--empty-password", "-d", `sql:${database}`], ["-A", "-d", `sql:${database}`, "-n", "Stage13 owned CA", "-t", "C,,", "-i", caFile]]) {
    const result = execute === spawnSync ? runCommand("certutil", args, { root, encoding: "utf8", timeout: 10_000 }) : execute("certutil", args, { encoding: "utf8" });
    if (result.status !== 0) throw new Error("Private NSS CA setup failed; install libnss3-tools in the Linux browser tool environment");
  }
  return { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache") };
}
export function secureRequest({ port, servername = "localhost", host = servername, pathname = "/health/ready", ca }) {
  return new Promise((resolve, reject) => {
    let authorized = false;
    const request = https.request({ hostname: "127.0.0.1", port, servername, path: pathname, agent: false, headers: { Host: host }, ...(ca === undefined ? {} : { ca }), rejectUnauthorized: true }, (response) => {
      response.resume(); response.once("end", () => resolve({ status: response.statusCode, authorized }));
    });
    request.once("socket", (socket) => socket.once("secureConnect", () => { authorized = socket.authorized; }));
    request.setTimeout(5_000, () => request.destroy(Object.assign(new Error("TLS probe timeout"), { code: "PROBE_TIMEOUT" })));
    request.once("error", (error) => { error.tlsAuthorized = authorized; reject(error); }); request.end();
  });
}
export async function proveIngressRejection({ port, readLogs, request = secureRequest }) {
  const positive = await request({ port });
  if (!positive.authorized || positive.status !== 200) throw new Error("TLS positive control failed before rejection probes");
  const nonce = `/stage13-host-negative-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let hostRejected = false;
  try { await request({ port, host: "unknown.invalid", pathname: nonce }); }
  catch (error) {
    // Nginx 444 must follow an authorized handshake and have a correlated
    // server access log. A certificate/timeout/client failure cannot pass.
    hostRejected = error.code === "ECONNRESET" && error.tlsAuthorized === true;
  }
  const logs = await readLogs();
  if (!hostRejected || !logs.split(/\r?\n/).some((line) => line.includes(nonce) && /"\s+444\s/.test(line))) throw new Error("Unknown Host rejection lacks authorized TLS/server-side 444 evidence");
  let sniRejected = false;
  try { await request({ port, servername: "unknown.invalid", host: "unknown.invalid" }); }
  catch (error) { sniRejected = error.code === "EPROTO" && /(?:alert.*(?:unrecognized name|handshake failure)|alert number (?:112|40))/i.test(error.message); }
  if (!sniRejected) throw new Error("Unknown SNI was not rejected with a server TLS fatal alert");
  const after = await request({ port });
  if (!after.authorized || after.status !== 200) throw new Error("TLS positive control failed after rejection probes");
  return { positiveBefore: 200, positiveAfter: 200, host: "authorized TLS + correlated server 444", sni: "server fatal TLS alert", certificateValidation: "normal chain/name/expiry" };
}
