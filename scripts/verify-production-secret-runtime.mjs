import fs from "node:fs";
import { createIsolation, removeIsolation, OwnedDocker, composeCommandForEngine } from "./stage13-runtime.mjs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const input = process.env.VAULT_STAGE13_INPUT ? JSON.parse(fs.readFileSync(process.env.VAULT_STAGE13_INPUT, "utf8")) : {};
if (input.templateOnly === true) throw new Error("Populate the Stage13 input template before admission");
const isolation = createIsolation({ base: input.temporaryBase ?? process.env.VAULT_STAGE13_TEMP_BASE });
const owner = new OwnedDocker({ ...isolation, cwd: root, docker: process.env.DOCKER_BIN, expectedEngineId: input.dockerEngineId }), docker = owner.docker;
const previousReport = path.join(root, "artifacts", "verification", "stage-13-production-hardening.json");
let appInput = input.appImage ?? process.env.VAULT_STAGE13_APP_IMAGE;
if (!appInput) {
  const report = JSON.parse(fs.readFileSync(previousReport, "utf8"));
  if (!report.success || Date.now() - Date.parse(report.finishedAt) > 3_600_000) throw new Error("Fresh successful Stage13 handoff or explicit exact app image is required");
  appInput = report.artifacts.appLocalConfigId;
}
if (!/^sha256:[a-f0-9]{64}$/.test(appInput) && !/@sha256:[a-f0-9]{64}$/.test(appInput)) throw new Error("Secret runtime requires an exact image ID or registry manifest reference");
const appImage = owner.image(appInput), project = isolation.namespace;
const sourceVolume = project + "-secret-source";
const evidence = { schema: "saturn.stage13.secret-runtime.v1", root: isolation.root, namespace: project, appLocalConfigId: appImage, startedAt: new Date().toISOString(), success: false };
process.stdout.write("Secret runtime private evidence root: " + isolation.root + "\n");
const runtimeVolume = `${project}_runtime_secrets`;
const dataVolumes = [
  `${project}_drop_buffer`, `${project}_recovery_spool`, `${project}_recovery_archives`, `${project}_storage_runtime`,
];
const names = [
  "database_password", "owner_access_key", "auth_pepper", "drop_pepper", "share_pepper",
  "device_pepper", "backup_pepper", "laboratory_pepper", "gryphon_service_token", "kernel_service_token", "storage_private_key",
];
const vaultNames = names.filter((name) => !["gryphon_service_token", "kernel_service_token"].includes(name));

function runDocker(args, options = {}) { return owner.run(args, options.env ?? process.env, options.allowFailure ?? false).stdout.trim(); }
try {
  runDocker(["volume", "create", sourceVolume]);
  runDocker([
    "run", "--rm", "-v", `${sourceVolume}:/source`, "alpine:3.24", "sh", "-ceu",
    `mkdir -m 0700 /source/config /source/vault /source/gryphon
     printf '%s\\n' protected > /source/config/.env.production
     chmod 0600 /source/config/.env.production
     for name in ${vaultNames.join(" ")}; do
       printf '%s\\n' "secret-$name-0123456789012345678901234567890123456789" > "/source/$name"
       mv "/source/$name" "/source/vault/$name"
       chmod 0600 "/source/vault/$name"
     done`,
  ]);
  runDocker([
    "run", "--rm", "-v", `${sourceVolume}:/source`, "alpine:3.24", "sh", "-ceu",
    "printf '%s\\n' gryphon-token-0123456789012345678901234567890123456789 > /source/gryphon/saturn.token && chmod 0640 /source/gryphon/saturn.token",
  ]);

  const denied = owner.run([
    "run", "--rm", "-v", `${sourceVolume}:/source:ro`, appImage,
    "node", "-e", "require('node:fs').readFileSync('/source/config/.env.production')",
  ], process.env, true);
  if (denied.status === 0 || !/EACCES/.test(`${denied.stdout} ${denied.stderr}`)) throw new Error("non-root root-only env negative control did not fail with EACCES");

  runDocker([
    "run", "--rm", "--user", "0:0", "--network", "none", "--read-only",
    "--security-opt", "no-new-privileges", "--cap-drop", "ALL",
    "-v", `${sourceVolume}:/source:ro`, appImage,
    "node", "-e", "require('node:fs').readFileSync('/source/config/.env.production')",
  ]);

  const configEnvironment = {
    ...process.env,
    VAULT_APP_IMAGE: appImage,
    VAULT_WEB_IMAGE: "registry.test/saturn-web@sha256:" + "1".repeat(64),
    VAULT_RUNTIME_ENV_FILE: path.join(root, "infra", "production", ".env.production.example"),
    VAULT_SECRET_ROOT: `/var/lib/docker/volumes/${sourceVolume}/_data/vault`,
    KERNEL_SERVICE_TOKEN: "kernel-service-token-0123456789012345678901234567890123456789",
    GRYPHON_SERVICE_TOKEN_HOST_FILE: `/var/lib/docker/volumes/${sourceVolume}/_data/gryphon/saturn.token`,
    NEPTUNE_CONTROL_TOKEN_HOST_FILE: path.join(isolation.root, "unused-neptune-control-token"),
    NEPTUNE_EXPORT_TOKEN_HOST_FILE: path.join(isolation.root, "unused-neptune-export-token"),
    UPDATER_SOCKET_GID: "1001",
    NEPTUNE_SOCKET_GID: "1002",
    GRYPHON_CLIENTS_GID: "1003",
  };
  const compose = JSON.parse(runDocker([
    "compose", "-f", "compose.production.yaml", "config", "--format", "json",
  ], { env: configEnvironment }));
  const init = compose.services["secret-runtime-init"];
  if (init?.user !== "0:0" || !Array.isArray(init.command)) throw new Error("secret-runtime-init is not root-scoped");
  const api = compose.services.api;
  if (api?.environment?.KERNEL_SERVICE_TOKEN !== "" || api?.environment?.KERNEL_TOKEN_FILE !== "/run/secrets/kernel_service_token") {
    throw new Error("long-running services must receive only the Kernel runtime-secret path");
  }
  const apiTargets = (api?.volumes ?? []).map((volume) => typeof volume === "string" ? volume : volume.target);
  if (!apiTargets.includes("/run/neptune-control.token") || !apiTargets.includes("/run/neptune-export.token") || apiTargets.some((target) => /^\/run\/secrets\/neptune-/.test(target))) {
    throw new Error("Neptune token bind mounts must not be nested inside the read-only runtime_secrets volume");
  }

  for (const volume of [runtimeVolume, ...dataVolumes]) owner.resource("volume", volume);
  const sourceMountpoint = owner.checked("volume", sourceVolume).observed.Mountpoint;
  const initEnvironment = path.join(isolation.root, "init.env");
  fs.writeFileSync(initEnvironment, "KERNEL_SERVICE_TOKEN=" + configEnvironment.KERNEL_SERVICE_TOKEN + "\n", { mode: 0o600 });
  for (const service of ["secret-runtime-init", "drop-buffer-init", "recovery-volume-init", "storage-runtime-init"]) {
    const config = compose.services[service];
    if (config.user !== "0:0" || !Array.isArray(config.command)) throw new Error("Production init command contract changed");
    const args = ["run", "--rm", "--name", project + "-" + service, "--network", "none", "--user", config.user, "--read-only", "--security-opt", "no-new-privileges", "--cap-drop", "ALL"];
    for (const capability of config.cap_add ?? []) args.push("--cap-add", capability);
    for (const volume of config.volumes ?? []) {
      const actual = volume.source === "runtime_secrets" ? runtimeVolume : project + "_" + volume.source;
      args.push("-v", actual + ":" + volume.target);
    }
    if (service === "secret-runtime-init") {
      args.push("--env-file", initEnvironment);
      for (const name of vaultNames) args.push("-v", sourceMountpoint + "/vault/" + name + ":/run/secrets/" + name + ":ro");
      args.push("-v", sourceMountpoint + "/gryphon/saturn.token:/run/secrets/gryphon_service_token:ro");
    }
    args.push(appImage, ...composeCommandForEngine(config.command));
    runDocker(args);
  }

  for (const volume of dataVolumes) {
    runDocker([
      "run", "--rm", "-v", `${volume}:/target:ro`, "alpine:3.24", "sh", "-ceu",
      "test \"$(stat -c '%u:%g:%a' /target)\" = 1000:1000:700",
    ]);
  }

  runDocker([
    "run", "--rm", "--user", "1000:1000", "-v", `${runtimeVolume}:/run/secrets:ro`,
    appImage, "node", "-e",
    `const fs=require('node:fs');for(const name of ${JSON.stringify(names)}){const file='/run/secrets/'+name;fs.readFileSync(file);const stat=fs.statSync(file);if(stat.uid!==1000||stat.gid!==1000||(stat.mode&0o777)!==0o400)process.exit(1)}`,
  ]);

  runDocker([
    "run", "--rm", "-v", `${sourceVolume}:/source:ro`, "alpine:3.24", "sh", "-ceu",
    `for name in ${vaultNames.join(" ")}; do
       test "$(stat -c '%u:%g:%a' "/source/vault/$name")" = 0:0:600
     done
     test "$(stat -c '%u:%g:%a' /source/gryphon/saturn.token)" = 0:0:640`,
  ]);

  evidence.success = true;
  Object.assign(evidence, { rootOnlySource: true, nonRootRuntime: true, files: names.length, dataVolumes: dataVolumes.length });
  process.stdout.write(`${JSON.stringify({ rootOnlySource: true, nonRootRuntime: true, files: names.length, dataVolumes: dataVolumes.length })}\n`);
} finally {
  evidence.finishedAt = new Date().toISOString();
  const reportPath = path.join(isolation.root, "report.json");
  fs.writeFileSync(reportPath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  evidence.closure = owner.close(evidence.success);
  if (evidence.closure.status !== "CLOSED") { evidence.success = false; process.exitCode = 1; }
  evidence.resources = { engine: owner.engine, budgets: owner.budgets, images: owner.images, objects: owner.objects, operations: owner.commands.map((command) => ({ exitCode: command.exitCode, signal: command.signal, actor: command.actor, supervisorEvidence: command.supervisorEvidence })) };
  fs.writeFileSync(reportPath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  const finalReport = process.env.VAULT_STAGE13_SECRET_REPORT ?? path.join(root, "artifacts", "verification", "stage-13-secret-runtime.json");
  fs.mkdirSync(path.dirname(finalReport), { recursive: true });
  fs.writeFileSync(finalReport, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  if (evidence.success && input.retainSuccessfulPrivateEvidence !== true) {
    try { removeIsolation(isolation); evidence.privateEvidenceRetained = false; }
    catch (error) { evidence.success = false; process.exitCode = 1; evidence.cleanupError = error.message; }
    fs.writeFileSync(finalReport, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  }
}
