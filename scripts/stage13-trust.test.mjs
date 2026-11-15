import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { test } from "node:test";
import { assertCertificate, installProcessTrust, secureRequest, proveIngressRejection, prepareBrowserTrust } from "./stage13-trust.mjs";

test("normal TLS validates the owned CA while rejecting untrusted chains, wrong names and expired certificates", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stage13-tls-control-"));
  const ca = path.join(root, "ca.crt"), caKey = path.join(root, "ca.key"), key = path.join(root, "server.key"), csr = path.join(root, "server.csr"), cert = path.join(root, "server.crt"), ext = path.join(root, "server.ext");
  let server, restore;
  try {
    const execute = (args) => { const result = spawnSync("openssl", args, { encoding: "utf8", windowsHide: true, timeout: 10_000, killSignal: "SIGTERM" }); assert.equal(result.status, 0, "fresh fixture OpenSSL command failed"); };
    await fs.writeFile(ext, "subjectAltName=DNS:localhost\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n");
    execute(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Stage13 fixture CA", "-addext", "basicConstraints=critical,CA:TRUE", "-keyout", caKey, "-out", ca]);
    execute(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-keyout", key, "-out", csr]);
    execute(["x509", "-req", "-in", csr, "-CA", ca, "-CAkey", caKey, "-CAcreateserial", "-days", "1", "-extfile", ext, "-out", cert]);
    const certificate = await fs.readFile(cert), authority = await fs.readFile(ca);
    const validity = assertCertificate(certificate, authority, "localhost");
    assert.throws(() => assertCertificate(certificate, authority, "wrong.invalid"), /chain\/name/);
    assert.throws(() => assertCertificate(certificate, authority, "localhost", Date.parse(validity.validTo) + 1), /validity interval/);
    server = https.createServer({ key: await fs.readFile(key), cert: certificate }, (_request, response) => { response.writeHead(200); response.end("ready"); });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const port = server.address().port;
    await assert.rejects(secureRequest({ port, ca: [] }), (error) => ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"].includes(error.code));
    await assert.rejects(secureRequest({ port, ca: authority, servername: "wrong.invalid" }), (error) => error.code === "ERR_TLS_CERT_ALTNAME_INVALID");
    const before = tls.getCACertificates("default"); restore = installProcessTrust(authority);
    const positive = await secureRequest({ port });
    assert.deepEqual(positive, { status: 200, authorized: true });
    restore(); restore = undefined;
    const fingerprints = (values) => [...new Set(values.map((value) => new X509Certificate(value).fingerprint256))].sort().join("\n");
    assert.equal(fingerprints(tls.getCACertificates("default")) === fingerprints(before), true, "the exact prior trusted certificate set must be restored");
    const expired = path.join(root, "expired.crt");
    execute(["x509", "-req", "-in", csr, "-CA", ca, "-CAkey", caKey, "-CAcreateserial", "-days", "0", "-extfile", ext, "-out", expired]);
    server.setSecureContext({ key: await fs.readFile(key), cert: await fs.readFile(expired) });
    await assert.rejects(secureRequest({ port, ca: authority }), (error) => error.code === "CERT_HAS_EXPIRED");
  } finally {
    restore?.();
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    await fs.rm(root, { recursive: true });
  }
});
test("client certificate failures and unrelated socket errors never count as ingress rejection", async () => {
  let count = 0;
  await assert.rejects(proveIngressRejection({ port: 1, readLogs: async () => "", request: async () => {
    if (++count === 1) return { status: 200, authorized: true };
    throw Object.assign(new Error("certificate failure"), { code: "ERR_TLS_CERT_ALTNAME_INVALID", tlsAuthorized: false });
  } }), /lacks authorized TLS/);
  count = 0;
  await assert.rejects(proveIngressRejection({ port: 1, readLogs: async () => "unrelated 444", request: async () => {
    if (++count === 1) return { status: 200, authorized: true };
    throw Object.assign(new Error("reset"), { code: "ECONNRESET", tlsAuthorized: true });
  } }), /server-side 444 evidence/);
});
test("server Host log correlation and fatal SNI alert require positive controls on both sides", async () => {
  const logs = []; let positives = 0;
  const result = await proveIngressRejection({ port: 1, readLogs: async () => logs.join("\n"), request: async ({ host, servername, pathname }) => {
    if (servername === "unknown.invalid") throw Object.assign(new Error("TLS alert unrecognized name; alert number 112"), { code: "EPROTO", tlsAuthorized: false });
    if (host === "unknown.invalid") { logs.push(`client - - [date] "GET ${pathname} HTTP/1.1" 444 0`); throw Object.assign(new Error("reset"), { code: "ECONNRESET", tlsAuthorized: true }); }
    positives++; return { status: 200, authorized: true };
  } });
  assert.equal(positives, 2); assert.equal(result.positiveAfter, 200);
});
test("browser trust is confined to private HOME/NSS and unsupported hosts fail before launching tools", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stage13-nss-control-")), calls = [];
  try {
    const execute = (command, args) => { calls.push([command, args]); return { status: 0 }; };
    if (process.platform !== "linux") {
      await assert.rejects(prepareBrowserTrust(root, path.join(root, "ca.crt"), execute), /requires Linux/);
      assert.equal(calls.length, 0);
    } else {
      const env = await prepareBrowserTrust(root, path.join(root, "ca.crt"), execute);
      assert.equal(env.HOME, path.join(root, "browser-home"));
      assert.equal(calls.length, 2);
      assert(calls.every(([command, args]) => command === "certutil" && args.includes(`sql:${path.join(root, "browser-home", ".pki", "nssdb")}`)));
    }
  } finally { await fs.rm(root, { recursive: true }); }
});
