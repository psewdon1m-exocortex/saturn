import assert from "node:assert/strict";
import { constants, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { sha256, verifyRsaManifest } from "./verify-published-release.mjs";

test("hashes published bytes deterministically", () => {
  assert.equal(sha256(Buffer.from("saturn")), "b988b5837c24ad1987f31266e0246b0fdaaf7948714cfa2a9f7757c52977ff14");
});

test("verifies the detached RSA-PSS manifest signature and key identity", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const manifest = Buffer.from('{"service":"saturn"}\n');
  const signature = sign("sha256", manifest, { key: privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 });
  const document = Buffer.from(JSON.stringify({
    schema: "exocortex.release-signature.v1",
    algorithm: "RSA-PSS-SHA256",
    key_id: sha256(publicKey.export({ type: "spki", format: "der" })),
    signature: signature.toString("base64"),
  }));
  assert.doesNotThrow(() => verifyRsaManifest(manifest, document, publicKey.export({ type: "spki", format: "pem" })));
  assert.throws(() => verifyRsaManifest(Buffer.from("tampered"), document, publicKey.export({ type: "spki", format: "pem" })), /verification failed/);
});
