import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  callSftpWithTimeout,
  createHostVerifier,
  fingerprintForKey,
} from "../src/ssh.mjs";

test("host verifier accepts only the configured SHA-256 fingerprint", () => {
  const key = Buffer.from("test-host-key");
  const expected = `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
  assert.equal(fingerprintForKey(key), expected);
  assert.equal(createHostVerifier(expected)(key), true);
  assert.equal(createHostVerifier(`SHA256:${"A".repeat(43)}`)(key), false);
});

test("SFTP calls fail closed when a callback never arrives", async () => {
  const silentSftp = { stat() {} };
  await assert.rejects(
    () => callSftpWithTimeout(silentSftp, "stat", 10, "."),
    /timed out after 10 ms/,
  );
});
