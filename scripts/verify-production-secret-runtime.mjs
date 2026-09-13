import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docker = process.env.DOCKER_BIN ?? "docker";
const appImage = process.env.VAULT_STAGE13_APP_IMAGE ?? "vault-app:stage13";
const suffix = randomUUID().replaceAll("-", "");
const sourceVolume = `saturn-linux-secrets-source-${suffix}`;
const project = `saturnsecrets${suffix}`;
const runtimeVolume = `${project}_runtime_secrets`;
const names = [
  "database_password", "owner_access_key", "auth_pepper", "drop_pepper", "share_pepper",
  "device_pepper", "backup_pepper", "laboratory_pepper", "gryphon_service_token", "storage_private_key",
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
  return result.stdout.trim();
}

function runDocker(args, options) {
  return run(docker, args, options);
}

try {
  runDocker(["volume", "create", sourceVolume]);
  runDocker([
    "run", "--rm", "-v", `${sourceVolume}:/source`, "alpine:3.24", "sh", "-ceu",
    `mkdir -m 0700 /source/config
     printf '%s\\n' protected > /source/config/.env.production
     chmod 0600 /source/config/.env.production
     for name in ${names.join(" ")}; do
       printf '%s\\n' "secret-$name-0123456789012345678901234567890123456789" > "/source/$name"
       chmod 0600 "/source/$name"
     done`,
  ]);

  const denied = spawnSync(docker, [
    "run", "--rm", "-v", `${sourceVolume}:/source:ro`, appImage,
    "node", "-e", "require('node:fs').readFileSync('/source/config/.env.production')",
  ], { cwd: root, encoding: "utf8" });
  if (denied.status === 0) throw new Error("non-root image unexpectedly read the root-only production env file");

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
    VAULT_SECRET_ROOT: `/var/lib/docker/volumes/${sourceVolume}/_data`,
    GRYPHON_SERVICE_TOKEN_HOST_FILE: `/var/lib/docker/volumes/${sourceVolume}/_data/gryphon_service_token`,
    NEPTUNE_CONTROL_TOKEN_HOST_FILE: path.join(root, ".tmp", "unused-neptune-control-token"),
    NEPTUNE_EXPORT_TOKEN_HOST_FILE: path.join(root, ".tmp", "unused-neptune-export-token"),
    UPDATER_SOCKET_GID: "1001",
    NEPTUNE_SOCKET_GID: "1002",
    GRYPHON_CLIENTS_GID: "1003",
  };
  const compose = JSON.parse(runDocker([
    "compose", "-f", "compose.production.yaml", "config", "--format", "json",
  ], { env: configEnvironment }));
  const init = compose.services["secret-runtime-init"];
  if (init?.user !== "0:0" || !Array.isArray(init.command)) throw new Error("secret-runtime-init is not root-scoped");

  runDocker([
    "compose", "-p", project, "-f", "compose.production.yaml",
    "run", "--rm", "--no-deps", "secret-runtime-init",
  ], { env: configEnvironment });

  runDocker([
    "run", "--rm", "--user", "1000:1000", "-v", `${runtimeVolume}:/run/secrets:ro`,
    appImage, "node", "-e",
    `const fs=require('node:fs');for(const name of ${JSON.stringify(names)}){const file='/run/secrets/'+name;fs.readFileSync(file);const stat=fs.statSync(file);if(stat.uid!==1000||stat.gid!==1000||(stat.mode&0o777)!==0o400)process.exit(1)}`,
  ]);

  runDocker([
    "run", "--rm", "-v", `${sourceVolume}:/source:ro`, "alpine:3.24", "sh", "-ceu",
    `for name in ${names.join(" ")}; do
       test "$(stat -c '%u:%g:%a' "/source/$name")" = 0:0:600
     done`,
  ]);

  process.stdout.write(`${JSON.stringify({ rootOnlySource: true, nonRootRuntime: true, files: names.length })}\n`);
} finally {
  spawnSync(docker, ["volume", "rm", "-f", runtimeVolume, sourceVolume], { cwd: root, encoding: "utf8" });
}
