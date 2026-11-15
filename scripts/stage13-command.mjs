import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const save = (file, value) => { const temporary = `${file}.${randomUUID()}.tmp`; fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(temporary, file); };

/** The deadline closes the caller's admission, never terminates a normal actor.
 * A detached supervisor continues collecting the real exit and raw evidence. */
export function runCommand(command, args, options) {
  const directory = fs.mkdtempSync(path.join(options.root, "operation-"));
  fs.chmodSync(directory, 0o700);
  const spec = { command, args, cwd: options.cwd, env: options.env ?? process.env, directory };
  if (options.input !== undefined) { spec.inputFile = path.join(directory, "stdin"); fs.writeFileSync(spec.inputFile, options.input, { mode: 0o600 }); }
  const specFile = path.join(directory, "spec.json");
  save(specFile, spec);
  const supervisor = spawn(process.execPath, [self, "--supervise", specFile], { detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=512" } });
  supervisor.once("error", () => undefined);
  supervisor.unref();
  const resultFile = path.join(directory, "result.json"), actorFile = path.join(directory, "actor.json");
  const deadline = Date.now() + options.timeout;
  while (!fs.existsSync(resultFile) && Date.now() < deadline) pause(20);
  const actor = fs.existsSync(actorFile) ? JSON.parse(fs.readFileSync(actorFile, "utf8")) : { supervisorPid: supervisor.pid };
  if (!fs.existsSync(resultFile)) return { status: null, stdout: options.encoding === null ? Buffer.alloc(0) : "", stderr: options.encoding === null ? Buffer.alloc(0) : "", actor, evidence: directory, error: { code: "OPERATION_PENDING" } };
  const result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  if (["stdout", "stderr"].some((name) => fs.statSync(path.join(directory, name)).size > 128 * 1024 * 1024)) return { status: null, stdout: "", stderr: "", actor, evidence: directory, error: { code: "OUTPUT_REVIEW_PENDING" } };
  const read = (name) => { const file = path.join(directory, name); return fs.readFileSync(file, options.encoding === null ? undefined : "utf8"); };
  return { ...result, actor, evidence: directory, stdout: read("stdout"), stderr: read("stderr") };
}

async function supervise(specFile) {
  const spec = JSON.parse(fs.readFileSync(specFile, "utf8"));
  const out = fs.openSync(path.join(spec.directory, "stdout"), "wx", 0o600), err = fs.openSync(path.join(spec.directory, "stderr"), "wx", 0o600);
  const input = spec.inputFile ? fs.openSync(spec.inputFile, "r") : "ignore";
  const startedAt = new Date().toISOString();
  const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, windowsHide: true, stdio: [input, out, err] });
  if (typeof input === "number") fs.closeSync(input);
  fs.closeSync(out); fs.closeSync(err);
  save(path.join(spec.directory, "actor.json"), { supervisorPid: process.pid, actorPid: child.pid ?? null, startedAt, command: spec.command });
  await new Promise((resolve) => {
    let error;
    child.once("error", (value) => { error = { code: value.code ?? "SPAWN_ERROR" }; });
    child.once("close", (status, signal) => { save(path.join(spec.directory, "result.json"), { status, signal, ...(error ? { error } : {}), startedAt, finishedAt: new Date().toISOString() }); resolve(); });
  });
}
if (path.resolve(process.argv[1] ?? "") === self && process.argv[2] === "--supervise") await supervise(process.argv[3]);
