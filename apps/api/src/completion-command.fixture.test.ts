import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { CompletionCommandOwner, completionCommandBudget, completionCommandPaths, validateCompletionCommandPaths } from "./completion-command.fixture.js";

const owners: CompletionCommandOwner[] = [];
async function owner(options: { phaseMs?: number; outputBytes?: number } = {}) {
  const base = process.env.COMPLETION_COMMAND_TEST_ROOT ?? os.tmpdir();
  const root = await fs.mkdtemp(path.join(base, "completion-command-"));
  await fs.chmod(root, 0o700);
  const commands = new CompletionCommandOwner(completionCommandPaths(), root, options);
  owners.push(commands);
  return commands;
}
async function json(file: string): Promise<unknown> { return JSON.parse(await fs.readFile(file, "utf8")) as unknown; }

afterEach(async () => {
  for (const commands of owners.splice(0)) {
    if (commands.lastOperation) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const joined = await Promise.race([commands.lastOperation.join, new Promise<undefined>(resolve => {
          timer = setTimeout(() => { resolve(undefined); }, 5000);
        })]);
        expect(joined, "owned supervisor must actually join; preserve evidence if it does not").toBeDefined();
        expect(joined?.supervisorExitCode).toBe(0);
      } finally { if (timer !== undefined) clearTimeout(timer); }
    }
  }
});

it("uses absolute reviewed paths from the actual API package cwd and the real CLI refuses invalid usage before SQL", async () => {
  const commands = await owner();
  expect(path.resolve(process.cwd())).toBe(path.join(commands.paths.cwd, "apps", "api"));
  await validateCompletionCommandPaths(commands.paths);
  await expect(commands.lifecycle("invalid-source-ci-usage")).rejects.toMatchObject({ code: "completion_command_failed" });
  const operation = commands.lastOperation;
  expect(operation).toBeDefined();
  if (!operation) throw new Error("owned operation absent");
  const result = await operation.join;
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr) as unknown).toEqual({ code: "lifecycle_failed" });
  expect(await json(path.join(operation.evidence, "launch.json"))).toMatchObject({ cwd: commands.paths.cwd, parentPid: process.pid, osCreated: { status: "UNKNOWN" } });
  expect(await json(path.join(operation.evidence, "exit.json"))).toMatchObject({ phase: "EXIT_OBSERVED", exitCode: 1, signal: null, supervisorExitCode: 0 });
  expect(await json(path.join(operation.evidence, "raw.json"))).toMatchObject({ phase: "RAW_HASHED", exitCode: 1,
    stderr: { sha256: createHash("sha256").update(result.stderr).digest("hex"), accepted: true } });
  expect(commands.admissionClosed).toBe(true);
}, 15_000);

it("refuses missing paths before any operation directory or child exists", async () => {
  const valid = await owner();
  const commands = new CompletionCommandOwner({ ...valid.paths, cli: path.join(valid.root, "missing.mts") }, valid.root);
  await expect(commands.run(["--eval", "process.exitCode=99"])).rejects.toMatchObject({ code: "ENOENT" });
  expect(commands.lastOperation).toBeUndefined();
  expect(await fs.readdir(valid.root)).toEqual([]);
  expect(commands.admissionClosed).toBe(true);
});

it("persists real exit 7 and raw hashes before an injected post-metadata failure", async () => {
  const commands = await owner();
  await expect(commands.run(["--eval", "process.stdout.write('seven');process.stderr.write('private-fixture-error');process.exitCode=7"],
    () => Promise.reject(new Error("post-metadata-fixture-failure")))).rejects.toMatchObject({ code: "completion_post_metadata_failed" });
  const operation = commands.lastOperation;
  if (!operation) throw new Error("owned operation absent");
  expect(await json(path.join(operation.evidence, "exit.json"))).toMatchObject({ exitCode: 7, signal: null });
  expect(await json(path.join(operation.evidence, "raw.json"))).toMatchObject({ exitCode: 7,
    stdout: { bytes: 5, sha256: createHash("sha256").update("seven").digest("hex") } });
  expect(await json(path.join(operation.evidence, "completion.json"))).toMatchObject({ phase: "POST_METADATA_FAILED", exitCode: 7 });
  expect(commands.admissionClosed).toBe(true);
});

it("runs the actual child at the Saturn root with the recorded supervisor as parent", async () => {
  const commands = await owner();
  const result = await commands.run(["--eval", "process.stdout.write(JSON.stringify({cwd:process.cwd(),parentPid:process.ppid,pid:process.pid}))"]);
  const actual = JSON.parse(result.stdout) as unknown;
  expect(actual).toMatchObject({ cwd: path.resolve(commands.paths.cwd), parentPid: commands.lastOperation?.supervisorPid });
  expect(await json(path.join(result.evidence, "raw.json"))).toMatchObject({ actor: {
    parentPid: commands.lastOperation?.supervisorPid, osCreated: { status: "UNKNOWN" },
  } });
});

it("excludes an unrelated sentinel secret from the actual child, private spec and supervisor environment", async () => {
  const key = "COMPLETION_UNLISTED_SECRET_SENTINEL";
  const previous = process.env[key];
  const sentinel = "dummy-private-sentinel-value";
  process.env[key] = sentinel;
  try {
    const commands = await owner();
    const result = await commands.run(["--eval", "process.stdout.write(JSON.stringify(Object.keys(process.env)))"]);
    expect(JSON.parse(result.stdout) as unknown).not.toContain(key);
    const spec = await fs.readFile(path.join(result.evidence, "spec.json"), "utf8");
    const environment = await fs.readFile(path.join(result.evidence, "supervisor-env.json"), "utf8");
    expect(JSON.parse(spec) as unknown).not.toHaveProperty(`env.${key}`);
    expect(JSON.parse(environment) as unknown).not.toHaveProperty(key);
    expect(spec).not.toContain(sentinel);
    expect(environment).not.toContain(sentinel);
  } finally {
    if (previous === undefined) delete process.env.COMPLETION_UNLISTED_SECRET_SENTINEL;
    else process.env[key] = previous;
  }
});

it("a deadline persists PENDING, refuses new admission and observes delayed natural exit without a signal", async () => {
  const commands = await owner({ phaseMs: 200 });
  await expect(commands.run(["--eval", "setTimeout(()=>{process.stdout.write('natural-after-deadline');process.exitCode=7},700)"])).rejects.toMatchObject({ code: "completion_command_pending" });
  const operation = commands.lastOperation;
  if (!operation) throw new Error("owned operation absent");
  expect(await json(path.join(operation.evidence, "deadline.json"))).toMatchObject({ phase: "PENDING", admissionClosed: true, killIssued: false });
  await expect(commands.run(["--eval", "process.exitCode=99"])).rejects.toMatchObject({ code: "completion_admission_closed" });
  const result = await operation.join;
  expect(result.exitCode).toBe(7);
  expect(result.signal).toBeNull();
  expect(result.stdout).toBe("natural-after-deadline");
  expect(result.supervisorExitCode).toBe(0);
  expect(await fs.readdir(commands.root)).toHaveLength(1);
}, 10_000);

it("refuses concurrent admission while preserving the original owner and its join", async () => {
  const commands = await owner();
  const running = commands.run(["--eval", "setTimeout(()=>{process.stdout.write('single-owner')},250)"]);
  await expect(commands.run(["--eval", "process.exitCode=99"])).rejects.toMatchObject({ code: "completion_admission_closed" });
  expect((await running).stdout).toBe("single-owner");
  expect(await fs.readdir(commands.root)).toHaveLength(1);
});

it("rejects oversized stdout for parsing while retaining exact byte count and digest", async () => {
  const commands = await owner({ outputBytes: 16 });
  const result = await commands.run(["--eval", "process.stdout.write('x'.repeat(1024))"]);
  expect(result.exitCode).toBe(0);
  expect(result.outputAccepted).toBe(false);
  expect(result.stdout).toBe("");
  expect(commands.admissionClosed).toBe(true);
  expect(await json(path.join(result.evidence, "raw.json"))).toMatchObject({ stdout: { bytes: 1024, accepted: false,
    sha256: createHash("sha256").update("x".repeat(1024)).digest("hex") } });
});

it("refuses a command phase that would consume the existing verifier test budget", () => {
  expect(completionCommandBudget.phaseMs + completionCommandBudget.cleanupReserveMs).toBeLessThan(60_000);
  expect(() => new CompletionCommandOwner(completionCommandPaths(), os.tmpdir(), { phaseMs: 60_000 })).toThrow("completion_budget_invalid");
});
