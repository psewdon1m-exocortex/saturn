import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { prepareDevelopmentEnvironment } from "./prepare-dev.mjs";

const vaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pnpmScript = path.join(vaultRoot, "node_modules", "pnpm", "bin", "pnpm.cjs");

function run(command, args, environment = process.env) {
  const result = spawnSync(command, args, {
    cwd: vaultRoot,
    env: environment,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? "no status"}`);
}

const prepared = await prepareDevelopmentEnvironment();
const environment = { ...process.env, ...prepared.environment };
run(process.platform === "win32" ? "docker.exe" : "docker", ["compose", "-p", "vault-dev", "up", "-d", "--wait"], environment);
run(process.execPath, [pnpmScript, "--filter", "@saturn/storage", "migrate:layout", "--", "up"], environment);
run(process.execPath, [pnpmScript, "--filter", "@saturn/database", "migrate"], environment);

const child = spawn(process.execPath, [pnpmScript, "dev"], {
  cwd: vaultRoot,
  env: environment,
  stdio: "inherit",
  windowsHide: true,
});
const stop = (signal) => {
  if (!child.killed) child.kill(signal);
};
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
child.once("exit", (code) => { process.exitCode = code ?? 1; });
