import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const completionCommandBudget = { phaseMs: 20_000, cleanupReserveMs: 10_000, outputBytes: 1024 * 1024 } as const;
export const nativeCompletionCommandPhaseMs = 180_000;

export interface CompletionCommandPaths {
  cwd: string;
  cli: string;
  tsx: string;
  tsconfig: string;
  supervisor: string;
}

export function completionCommandPaths(): CompletionCommandPaths {
  return {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    cli: fileURLToPath(new URL("../../../scripts/sync-lifecycle.mts", import.meta.url)),
    tsx: createRequire(import.meta.url).resolve("tsx"),
    tsconfig: fileURLToPath(new URL("../tsconfig.json", import.meta.url)),
    supervisor: fileURLToPath(new URL("../../../scripts/stage13-command.mjs", import.meta.url)),
  };
}

export async function validateCompletionCommandPaths(paths: CompletionCommandPaths): Promise<void> {
  for (const name of ["cwd", "cli", "tsx", "tsconfig", "supervisor"] as const) {
    const file = paths[name];
    const stat = await fs.lstat(file);
    if (!path.isAbsolute(file) || stat.isSymbolicLink() || (name === "cwd" ? !stat.isDirectory() : !stat.isFile()))
      throw new Error("completion_command_path_invalid");
  }
}

async function save(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temporary, file);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("completion_receipt_invalid");
  return value as Record<string, unknown>;
}

async function readRecord(file: string): Promise<Record<string, unknown>> {
  return record(JSON.parse(await fs.readFile(file, "utf8")) as unknown);
}

function runtimeEnvironment(paths: CompletionCommandPaths, heapMiB: number): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "LOCALAPPDATA", "USERPROFILE"])
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  return { ...environment, CI: "true", NODE_OPTIONS: `--max-old-space-size=${String(heapMiB)}`, TSX_TSCONFIG_PATH: paths.tsconfig };
}

async function raw(file: string, maximum: number) {
  const digest = createHash("sha256");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const part of createReadStream(file)) {
    const chunk = Buffer.from(part as Uint8Array);
    digest.update(chunk); bytes += chunk.length;
    if (bytes <= maximum) chunks.push(chunk);
  }
  return { bytes, sha256: digest.digest("hex"), accepted: bytes <= maximum, text: bytes <= maximum ? Buffer.concat(chunks).toString("utf8") : "" };
}

export interface CompletionCommandResult {
  evidence: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  outputAccepted: boolean;
  metadataFailed: boolean;
  supervisorExitCode: number | null;
}

export interface CompletionCommandOperation {
  evidence: string;
  supervisorPid: number | undefined;
  join: Promise<CompletionCommandResult>;
}

export class CompletionCommandError extends Error {
  constructor(readonly code: string, readonly evidence?: string) { super(code); }
}

/** Source-CI only. The reviewed supervisor owns the actor after a caller deadline.
 * The caller supplies a restricted root (including its inherited Windows DACL;
 * chmod alone does not establish that). Only bounded, joined output is parsed.
 * The supervisor's raw spool has no on-disk quota. */
export class CompletionCommandOwner {
  readonly #deadline: number;
  #closed = false;
  #active = false;
  lastOperation: CompletionCommandOperation | undefined;

  constructor(readonly paths: CompletionCommandPaths, readonly root: string,
    readonly options: { phaseMs?: number; outputBytes?: number; nativeExecutable?: string } = {}) {
    const phaseMs = options.phaseMs ?? completionCommandBudget.phaseMs;
    const maximumPhase = options.nativeExecutable ? nativeCompletionCommandPhaseMs : completionCommandBudget.phaseMs;
    const maximum = options.outputBytes ?? completionCommandBudget.outputBytes;
    if (!path.isAbsolute(root) || (options.nativeExecutable !== undefined && !path.isAbsolute(options.nativeExecutable))
      || !Number.isSafeInteger(phaseMs) || phaseMs < 1 || phaseMs > maximumPhase
      || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > completionCommandBudget.outputBytes)
      throw new CompletionCommandError("completion_budget_invalid");
    this.#deadline = Date.now() + phaseMs;
  }

  get admissionClosed(): boolean { return this.#closed; }

  async run(args: readonly string[], postMetadata?: () => Promise<void>): Promise<CompletionCommandResult> {
    if (this.#closed || this.#active || Date.now() >= this.#deadline) {
      this.#closed = true;
      throw new CompletionCommandError("completion_admission_closed");
    }
    this.#active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await validateCompletionCommandPaths(this.paths);
      const command = this.options.nativeExecutable ?? process.execPath;
      if (this.options.nativeExecutable) {
        const nativeFile = await fs.lstat(command);
        if (!nativeFile.isFile() || nativeFile.isSymbolicLink()) throw new CompletionCommandError("completion_native_path_invalid");
      }
      const rootStat = await fs.lstat(this.root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new CompletionCommandError("completion_private_root_invalid");
      if (Date.now() >= this.#deadline) throw new CompletionCommandError("completion_admission_closed");
      const directory = await fs.mkdtemp(path.join(this.root, "command-"));
      await fs.chmod(directory, 0o700);
      const launch = { parentPid: process.pid, command, args, cwd: this.paths.cwd,
        observedAt: new Date().toISOString(), osCreated: { status: "UNKNOWN" },
        phaseBudgetMs: this.options.phaseMs ?? completionCommandBudget.phaseMs,
        cleanupReserveMs: completionCommandBudget.cleanupReserveMs,
        maxAcceptedStreamBytes: this.options.outputBytes ?? completionCommandBudget.outputBytes };
      await save(path.join(directory, "launch.json"), { phase: "PREPARED", ...launch });
      const specFile = path.join(directory, "spec.json");
      const actorEnvironment = runtimeEnvironment(this.paths, 256);
      if (this.options.nativeExecutable) {
        actorEnvironment.DOCKER_HOST = process.env.DOCKER_HOST;
        actorEnvironment.DOTNET_ROOT = process.env.DOTNET_ROOT;
        actorEnvironment.DOTNET_PROCESSOR_COUNT = "2";
      }
      const supervisorEnvironment = runtimeEnvironment(this.paths, 64);
      await save(specFile, { command, args, cwd: this.paths.cwd, directory,
        env: actorEnvironment });
      await save(path.join(directory, "supervisor-env.json"), supervisorEnvironment);
      const supervisor = spawn(process.execPath, [this.paths.supervisor, "--supervise", specFile], {
        cwd: this.paths.cwd, detached: true, stdio: "ignore", windowsHide: true,
        env: supervisorEnvironment,
      });
      let spawnError = false;
      supervisor.once("error", () => { spawnError = true; });
      const supervisorExit = new Promise<number | null>(resolve => { supervisor.once("close", code => { resolve(code); }); });
      const launched = { ...launch, supervisorPid: supervisor.pid ?? null };
      // Keep an in-memory actor reference before any fallible post-launch metadata.
      const join = (async (): Promise<CompletionCommandResult> => {
        const supervisorExitCode = await supervisorExit;
        await save(path.join(directory, "supervisor-exit.json"), { phase: "SUPERVISOR_JOINED", ...launched,
          supervisorExitCode, spawnError, childOutcome: "UNKNOWN until result.json is read" });
        const actual = await readRecord(path.join(directory, "result.json"));
        const exitCode = typeof actual.status === "number" && Number.isInteger(actual.status) ? actual.status : null;
        const signal = typeof actual.signal === "string" ? actual.signal : null;
        await save(path.join(directory, "exit.json"), { phase: "EXIT_OBSERVED", ...launched,
          exitCode, signal, supervisorExitCode, spawnError, observedAt: new Date().toISOString() });
        const maximum = this.options.outputBytes ?? completionCommandBudget.outputBytes;
        const [stdout, stderr, actor] = await Promise.all([raw(path.join(directory, "stdout"), maximum), raw(path.join(directory, "stderr"), maximum), readRecord(path.join(directory, "actor.json"))]);
        const managedActor = { ...actor, parentPid: actor.supervisorPid, osCreated: { status: "UNKNOWN" } };
        await save(path.join(directory, "raw.json"), { phase: "RAW_HASHED", ...launched, actor: managedActor,
          exitCode, signal, supervisorExitCode, stdout: { bytes: stdout.bytes, sha256: stdout.sha256, accepted: stdout.accepted },
          stderr: { bytes: stderr.bytes, sha256: stderr.sha256, accepted: stderr.accepted } });
        let metadataFailed = false;
        try { await postMetadata?.(); }
        catch { metadataFailed = true; }
        const result = { evidence: directory, exitCode, signal, stdout: stdout.text, stderr: stderr.text,
          outputAccepted: stdout.accepted && stderr.accepted, metadataFailed, supervisorExitCode };
        await save(path.join(directory, "completion.json"), { phase: metadataFailed ? "POST_METADATA_FAILED" : "JOINED",
          ...launched, actor: managedActor, exitCode, signal, supervisorExitCode, outputAccepted: result.outputAccepted, admissionClosed: this.#closed });
        return result;
      })();
      this.lastOperation = { evidence: directory, supervisorPid: supervisor.pid, join };
      // A reporting error must not leave a rejected actor observer unhandled.
      void join.catch(() => undefined);
      await save(path.join(directory, "launch.json"), { phase: "SUPERVISOR_LAUNCHED", ...launched });
        const result = await Promise.race([join, new Promise<undefined>(resolve => {
        timer = setTimeout(() => { resolve(undefined); }, Math.max(0, this.#deadline - Date.now()));
      })]);
      if (!result) {
        this.#closed = true;
        const actor = await readRecord(path.join(directory, "actor.json")).catch(() => ({ actorPid: null, status: "UNKNOWN" }));
        await save(path.join(directory, "deadline.json"), { phase: "PENDING", ...launched,
          actor, actorReceiptFile: path.join(directory, "actor.json"),
          admissionClosed: true, disposition: "UNKNOWN until actual exit and supervisor join", killIssued: false });
        throw new CompletionCommandError("completion_command_pending", directory);
      }
      if (result.exitCode !== 0 || result.signal !== null || result.metadataFailed || !result.outputAccepted) this.#closed = true;
      if (result.metadataFailed) throw new CompletionCommandError("completion_post_metadata_failed", directory);
      return result;
    } catch (error) {
      this.#closed = true;
      throw error;
    } finally { if (timer !== undefined) clearTimeout(timer); this.#active = false; }
  }

  async lifecycle<T>(action: string, config?: string, artifact?: string): Promise<T> {
    const result = await this.run(["--import", pathToFileURL(this.paths.tsx).href, this.paths.cli, action,
      ...(config ? [config] : []), ...(artifact ? [artifact] : [])]);
    if (result.exitCode !== 0 || result.signal !== null) throw new CompletionCommandError("completion_command_failed", result.evidence);
    if (!result.outputAccepted) throw new CompletionCommandError("completion_output_too_large", result.evidence);
    try { return JSON.parse(result.stdout) as T; }
    catch {
      this.#closed = true;
      await save(path.join(result.evidence, "parse-failure.json"), { phase: "INVALID_JSON", exitCode: result.exitCode,
        rawReceiptFile: path.join(result.evidence, "raw.json"), admissionClosed: true });
      throw new CompletionCommandError("completion_json_invalid", result.evidence);
    }
  }
}
