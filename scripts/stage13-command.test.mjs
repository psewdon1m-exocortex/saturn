import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCommand } from "./stage13-command.mjs";

test("operation deadline preserves the actor and its eventual real exit evidence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stage13-command-control-"));
  let joined = false;
  try {
    const result = runCommand(process.execPath, ["-e", "setTimeout(()=>{process.stdout.write('cooperative-completion');process.exitCode=7},200)"], { root, encoding: "utf8", timeout: 30 });
    assert.equal(result.status, null); assert.equal(result.error.code, "OPERATION_PENDING");
    assert(Number.isSafeInteger(result.actor.supervisorPid));
    const resultFile = path.join(result.evidence, "result.json"), deadline = Date.now() + 5_000;
    let actual;
    while (Date.now() < deadline) {
      try { actual = JSON.parse(await fs.readFile(resultFile, "utf8")); joined = true; break; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(joined, true, "fixture actor must join before deleting its root");
    assert.equal(actual.status, 7); assert.equal(actual.signal, null);
    assert.equal(await fs.readFile(path.join(result.evidence, "stdout"), "utf8"), "cooperative-completion");
  } finally { if (joined) await fs.rm(root, { recursive: true }); }
});
test("completed operations preserve exact numeric exit and binary bytes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stage13-command-binary-"));
  let joined = false;
  try {
    const result = runCommand(process.execPath, ["-e", "if(process.cwd()!==process.env.STAGE13_CWD)process.exit(9);process.stdin.on('data',b=>process.stdout.write(b));process.exitCode=3"], { root, cwd: root, env: { ...process.env, STAGE13_CWD: root }, encoding: null, input: Buffer.from([0,255,10,13]), timeout: 5_000 });
    joined = result.status !== null;
    assert.equal(result.status, 3); assert.deepEqual(result.stdout, Buffer.from([0,255,10,13]));
  } finally { if (joined) await fs.rm(root, { recursive: true }); }
});
