import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

/** Deadlines cover subprocess startup, pipe I/O and exit; completion reaps it. */
export async function runPgProcess(input: {
  executable: string;
  args: readonly string[];
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
  idleTimeoutMs?: number;
  inputPath?: string;
  outputPath?: string;
  maximumBytes?: number;
  signal?: AbortSignal;
}): Promise<void> {
  if (input.signal?.aborted) throw new Error("PostgreSQL operation was cancelled");
  const child = spawn(input.executable, input.args, {
    env: input.environment, windowsHide: true,
    stdio: [input.inputPath === undefined ? "ignore" : "pipe", input.outputPath === undefined ? "ignore" : "pipe", "pipe"],
  });
  let failure: Error | undefined, stderr = "", closed = false;
  let idle: NodeJS.Timeout | undefined, kill: NodeJS.Timeout | undefined;
  const stop = (error: Error) => {
    failure ??= error;
    if (closed) return;
    child.kill("SIGTERM");
    kill ??= setTimeout(() => child.kill("SIGKILL"), 250);
    child.stdin?.destroy(); child.stdout?.destroy();
  };
  const resetIdle = () => {
    if (input.idleTimeoutMs === undefined) return;
    if (idle !== undefined) clearTimeout(idle);
    idle = setTimeout(() => stop(new Error("PostgreSQL dump stopped making progress")), input.idleTimeoutMs);
  };
  const abort = () => stop(new Error("PostgreSQL operation was cancelled"));
  const deadline = setTimeout(() => stop(new Error("PostgreSQL operation exceeded its deadline")), input.timeoutMs);
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) abort();
  child.stderr?.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-32_768); });
  const finished = new Promise<void>((resolve, reject) => {
    child.on("error", error => { failure ??= error; });
    child.on("close", code => {
      closed = true;
      if (failure) reject(failure);
      else if (code === 0) resolve();
      else reject(new Error(`PostgreSQL tool exited with code ${String(code)}: ${stderr.trim().slice(-2_000)}`));
    });
  });
  const pipes: Promise<void>[] = [];
  if (input.inputPath !== undefined && child.stdin !== null) pipes.push(pipeline(createReadStream(input.inputPath), child.stdin));
  if (input.outputPath !== undefined && child.stdout !== null) {
    let bytes = 0;
    const bound = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      resetIdle(); bytes += chunk.length;
      if (bytes > (input.maximumBytes ?? 0)) callback(new Error("PostgreSQL dump exceeds configured spool limit"));
      else callback(null,chunk);
    } });
    resetIdle();
    pipes.push(pipeline(child.stdout,bound,createWriteStream(input.outputPath,{ flags:"wx",mode:0o600 })));
  }
  // Attach rejection handlers immediately, including EPIPE and failed spawn.
  for (const pipe of pipes) void pipe.catch((error: unknown) => stop(error instanceof Error ? error : new Error("PostgreSQL pipe failed")));
  try { await Promise.all([finished,...pipes]); }
  catch (error) {
    stop(error instanceof Error ? error : new Error("PostgreSQL tool failed"));
    await Promise.allSettled([finished,...pipes]);
    throw failure ?? error;
  } finally {
    clearTimeout(deadline); if (idle !== undefined) clearTimeout(idle); if (kill !== undefined) clearTimeout(kill);
    input.signal?.removeEventListener("abort",abort);
  }
}
