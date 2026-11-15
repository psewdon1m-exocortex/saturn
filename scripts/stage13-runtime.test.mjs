import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createIsolation, removeIsolation, OwnedDocker, identity, offlineRegistryFixture, startDependencies, isWithin, composeCommandForEngine } from "./stage13-runtime.mjs";
import { runCommand } from "./stage13-command.mjs";

function fixture({ endpoint = "unix:///var/run/docker.sock", absence } = {}) {
  const isolation = createIsolation(), calls = [], containers = new Map(), volumes = new Map(), networks = new Map();
  let time = 0, sequence = 0, stuck = false, daemonId = "daemon-id", healthError = false;
  const digest = `sha256:${"1".repeat(64)}`;
  const execute = (args) => {
    if (args[0] === "--host") { assert.equal(args[1], endpoint); args = args.slice(2); }
    calls.push(args);
    const ok = (value = "") => ({ status: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" });
    const missing = (kind, name) => absence?.(kind, name) ?? ({ status: 1, stdout: "[]\n", stderr: `Error response from daemon: ${kind === "network" ? `network ${name} not found` : kind === "volume" ? `get ${name}: no such volume` : `No such container: ${name}`}\n` });
    if (args[0] === "context" && args[1] === "show") return ok("fixture");
    if (args[0] === "context" && args[1] === "inspect") return ok([{ Endpoints: { docker: { Host: endpoint } } }]);
    if (args[0] === "info") return healthError ? { status: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" } : ok(JSON.stringify(daemonId));
    if (args[0] === "image") return ok([{ Id: digest, Config: { Labels: {}, Volumes: {} }, RepoDigests: [`example.test/app@sha256:${"2".repeat(64)}`], Created: "image-created" }]);
    if (args[0] === "compose" && args.includes("config")) {
      const overlayFile = args[args.lastIndexOf("-f") + 1], overlay = JSON.parse(fs.readFileSync(overlayFile));
      assert(isWithin(isolation.root, overlay.secrets.postgres_password.file));
      return ok({ name: "vault-dev", secrets: overlay.secrets, services: {
        postgres: { image: "postgres-fixture", environment: { POSTGRES_PASSWORD_FILE: "/run/secrets/postgres_password" }, tmpfs: ["/var/lib/postgresql"], volumes: [] },
        sftp: { image: "sftp-fixture", volumes: [{ type: "bind", source: path.join(isolation.root, "data"), target: "/home/vault/gateway" }, { type: "bind", source: path.join(os.tmpdir(), "readonly-entrypoint.sh"), target: "/bootstrap/entrypoint.sh", read_only: true }] },
      } });
    }
    if (args[0] === "compose" && args.includes("create")) {
      const config = JSON.parse(fs.readFileSync(args[args.indexOf("-f") + 1]));
      for (const service of Object.values(config.services)) {
        const id = `container-${++sequence}`;
        containers.set(id, { Id: id, Name: service.container_name, Created: "created", Image: service.image, Config: { Labels: service.labels }, Mounts: service.volumes.map((volume) => ({ Type: volume.type, Name: volume.type === "volume" ? config.volumes[volume.source].name : undefined, Source: volume.source, Destination: volume.target, RW: !volume.read_only })), State: { Running: false, ExitCode: 0, Health: { Status: "healthy" } } });
      }
      return ok();
    }
    if (["volume", "network"].includes(args[0])) {
      const map = args[0] === "volume" ? volumes : networks, name = args.at(-1);
      if (args[1] === "create") { const labels = { "exocortex.stage13.namespace": isolation.namespace }; map.set(name, args[0] === "volume" ? { Name: name, CreatedAt: "created", Labels: labels, Driver: "local", Mountpoint: `/volumes/${name}`, Options: {} } : { Id: name, Created: "created", Labels: labels, Driver: "bridge", IPAM: {} }); return ok(name); }
      if (args[1] === "inspect") return map.has(name) ? ok([map.get(name)]) : missing(args[0], name);
      if (args[1] === "rm") { map.delete(name); return ok(name); }
    }
    if (args[0] === "create") {
      const name = args[args.indexOf("--name") + 1], id = `container-${++sequence}`;
      const mounts = args.flatMap((arg, index) => {
        if (arg !== "-v") return [];
        const value = args[index + 1], body = value.replace(/:(?:ro|rw)$/, ""), separator = body.lastIndexOf(":"), source = body.slice(0, separator);
        return [{ Type: volumes.has(source) ? "volume" : "bind", Name: volumes.has(source) ? source : undefined, Source: source, Destination: body.slice(separator + 1), RW: !value.endsWith(":ro") }];
      });
      containers.set(id, { Id: id, Name: name, Created: "created", Image: digest, Config: { Labels: { "exocortex.stage13.namespace": isolation.namespace } }, Mounts: mounts, State: { Running: false, ExitCode: 0 } }); return ok(id);
    }
    const find = (name) => containers.get(name) ?? [...containers.values()].find((value) => value.Name === name);
    if (args[0] === "container" && args[1] === "inspect") { const object = find(args[2]); return object ? ok([object]) : missing("container", args[2]); }
    if (args[0] === "start") { find(args[1]).State.Running = true; return ok(args[1]); }
    if (args[0] === "kill") { if (!stuck) find(args.at(-1)).State.Running = false; return ok(); }
    if (args[0] === "container" && args[1] === "rm") { containers.delete(args[2]); return ok(); }
    throw new Error(`Unexpected fake operation ${args.join(" ")}`);
  };
  const owner = new OwnedDocker({ ...isolation, execute, now: () => time, pause: (ms) => { time += ms; } });
  const launch = () => owner.run(["run", "-d", "--name", `${isolation.namespace}-app`, digest]);
  return { ...isolation, owner, calls, containers, volumes, networks, launch, setStuck: () => { stuck = true; }, setEngineId: (id) => { daemonId = id; }, setHealthError: () => { healthError = true; }, cleanup: () => fs.rmSync(isolation.root, { recursive: true }) };
}
test("local config digest and registry manifest digest remain distinct", () => {
  const f = fixture();
  try { const id = f.owner.image("input"); assert.notEqual(id, f.owner.images[0].repoDigests[0].split("@")[1]); assert(!offlineRegistryFixture("app").endsWith(id)); }
  finally { f.cleanup(); }
});
test("generated offline image refs pass the actual deployment policy while placeholders and mutable tags remain rejected", async () => {
  const isolation = createIsolation(), repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const configSource = pathToFileURL(path.join(repository, "packages/config/src/")).href;
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier === "@saturn/config") return { url: `${configSource}index.ts`, shortCircuit: true };
    if (context.parentURL?.startsWith(configSource) && specifier.startsWith("./") && specifier.endsWith(".js")) return { url: new URL(specifier.slice(0,-3) + ".ts", context.parentURL).href, shortCircuit: true };
    return next(specifier, context);
  } });
  try {
    // Native Node24 type stripping loads the real source policy/config even in
    // clean CI before workspace dist exists; no build or mock validator is used.
    const { validateProductionDeployment } = await import(pathToFileURL(path.join(repository, "packages/deployment/src/index.ts")).href);
    const secretFields = { DATABASE_PASSWORD_FILE: "database", OWNER_BOOTSTRAP_TOKEN_FILE: "owner", AUTH_PEPPER_FILE: "auth", DROP_PEPPER_FILE: "drop", SHARE_PEPPER_FILE: "share", DEVICE_PEPPER_FILE: "device", BACKUP_PEPPER_FILE: "backup", LABORATORY_PEPPER_FILE: "laboratory", GRYPHON_SERVICE_TOKEN_FILE: "gryphon", STORAGE_PRIVATE_KEY_FILE: "storage-key" };
    for (const [index, name] of Object.values(secretFields).entries()) fs.writeFileSync(path.join(isolation.root, name), name === "storage-key" ? `-----BEGIN OPENSSH PRIVATE KEY-----\n${"A".repeat(72)}\n-----END OPENSSH PRIVATE KEY-----\n` : `owned-${name}-${index}-${"x".repeat(48)}`, { mode: 0o600 });
    const environment = { NODE_ENV: "production", PUBLIC_ORIGIN: "https://vault.stage13.test", VAULT_DOMAIN: "vault.stage13.test", VAULT_VALIDATION_PROFILE: "verification", VAULT_DEPLOYMENT_ENVIRONMENT: "production", VAULT_STORAGE_ENVIRONMENT: "production", VAULT_SECRET_ROOT: isolation.root, VAULT_RELEASE_VERSION: "0.2.14", VAULT_APP_IMAGE: offlineRegistryFixture("saturn-app"), VAULT_WEB_IMAGE: offlineRegistryFixture("saturn-web"), SATURN_API_BIND_ADDRESS: "127.0.0.1", SATURN_API_BIND_PORT: "3000", SATURN_WEB_BIND_ADDRESS: "127.0.0.1", SATURN_WEB_BIND_PORT: "8080", API_TRUSTED_PROXIES: "172.31.250.1", VAULT_RPO_SECONDS: "21600", VAULT_RTO_SECONDS: "7200", VAULT_PUBLIC_LABORATORY_DECISION: "private", DATABASE_URL: "postgres://vault@postgres/vault", GRYPHON_ENABLED: "true", STORAGE_HOST: "prod.storage.test", STORAGE_USER: "prod-user", STORAGE_ROOT: ".", STORAGE_HOST_FINGERPRINT: `SHA256:${"A".repeat(43)}`, STORAGE_AUTH_MODE: "private_key_file", LABORATORY_PUBLIC_ENABLED: "false", ...Object.fromEntries(Object.entries(secretFields).map(([field, name]) => [field, `/run/secrets/${name}`])) };
    const result = validateProductionDeployment(environment, repository);
    assert.equal(result.state, "valid"); assert.equal(result.secretFiles, 10); assert.equal(result.immutableImages, 2);
    for (const field of ["VAULT_APP_IMAGE", "VAULT_WEB_IMAGE"]) assert.throws(() => validateProductionDeployment({ ...environment, [field]: environment[field].replace("registry.stage13.test", "registry.stage13.invalid") }, repository), new RegExp(`${field}.*placeholder`));
    assert.throws(() => validateProductionDeployment({ ...environment, VAULT_APP_IMAGE: "registry.stage13.test/saturn-app:latest" }, repository), /immutable image/);
  } finally { hooks.deregister(); removeIsolation(isolation); }
});
test("exact container tuple is verified before cooperative termination", () => {
  const f = fixture();
  try {
    f.launch(); const object = [...f.containers.values()][0];
    object.Image = `sha256:${"3".repeat(64)}`;
    assert.throws(() => f.owner.stop(object.Name), /identity changed/);
    assert.equal(f.calls.filter((args) => args[0] === "kill").length, 0);
    assert.equal(f.owner.close(true).status, "IDENTITY_OR_CLOSURE_FAILURE");
    assert.equal(f.containers.size, 1);
  } finally { f.cleanup(); }
});
test("mount and label changes cannot authorize cleanup", () => {
  const f = fixture();
  try {
    f.launch(); const object = [...f.containers.values()][0];
    object.Mounts.push({ Type: "bind", Source: "/unowned", Destination: "/data", RW: true });
    assert.throws(() => f.owner.checked("container", object.Name), /identity changed/);
    object.Mounts = []; object.Config.Labels["exocortex.stage13.namespace"] = "other-run";
    assert.throws(() => f.owner.checked("container", object.Name), /identity changed/);
    assert.equal(f.calls.filter((args) => args.includes("rm")).length, 0);
  } finally { f.cleanup(); }
});
test("successful closure joins TERM and removes containers before their networks and volumes", () => {
  const f = fixture();
  try {
    f.owner.resource("volume", `${f.namespace}-data`); f.launch(); f.owner.resource("network", `${f.namespace}-net`);
    assert.equal(f.owner.close(true).status, "CLOSED");
    const terms = f.calls.filter((args) => args[0] === "kill");
    assert.deepEqual(terms[0].slice(0,3), ["kill", "--signal", "TERM"]);
    const removed = f.calls.filter((args) => args[1] === "rm").map((args) => args[0]);
    assert.deepEqual(removed, ["container", "network", "volume"]);
    assert(f.calls.every((args) => !args.includes("-f") && !args.includes("SIGKILL") && !args.includes("KILL")));
  } finally { f.cleanup(); }
});
test("a failed run stops actors while retaining its secrets and volume evidence", () => {
  const f = fixture();
  try {
    f.owner.resource("volume", `${f.namespace}-data`); f.launch();
    fs.writeFileSync(path.join(f.root, "private-fixture"), "owned");
    assert.equal(f.owner.close(false).status, "STOPPED_RETAINED");
    assert.equal(f.volumes.size, 1); assert.equal(f.containers.size, 1);
    assert.equal(fs.readFileSync(path.join(f.root, "private-fixture"), "utf8"), "owned");
    assert.equal([...f.containers.values()][0].State.Running, false);
  } finally { f.cleanup(); }
});
test("a nonjoining actor closes admission and retains everything without force fallback", () => {
  const f = fixture();
  try {
    f.launch(); f.setStuck();
    assert.throws(() => f.owner.stop(`${f.namespace}-app`, 200), /did not join/);
    const count = f.calls.length;
    assert.equal(f.owner.close(true).status, "PENDING");
    assert.throws(() => f.owner.resource("volume", `${f.namespace}-new`), /admission closed/);
    assert.equal(f.calls.length, count);
    assert.equal(JSON.parse(fs.readFileSync(f.owner.manifestPath)).pending, true);
  } finally { f.cleanup(); }
});
test("writable bind mounts outside the owned root fail before Docker create", () => {
  const f = fixture();
  try {
    assert.throws(() => f.owner.run(["run", "-v", `${os.tmpdir()}:/escape`, `sha256:${"1".repeat(64)}`]), /escapes/);
    assert.equal(f.calls.filter((args) => args[0] === "create").length, 0);
    assert.doesNotThrow(() => f.owner.validateMounts(["-v", `${os.tmpdir()}:/source:ro`]));
    assert.doesNotThrow(() => f.owner.validateMounts(["-v", "/daemon-owned-volume/file:/source:ro"]));
    const snapshot = identity("volume", { Name: "n", Labels: {}, Options: {} });
    assert.equal(snapshot.name, "n");
  } finally { f.cleanup(); }
});
test("the fully resolved dependency graph confines mutable files and volumes to this run", () => {
  const f = fixture();
  try {
    const prepared = { paths: { postgresPasswordFile: path.join(f.root, "preparation-secrets", "postgres"), composeFile: path.join(f.root, "dependencies.compose.json") }, environment: {} };
    const names = { network: `${f.namespace}-default`, dataVolume: `${f.namespace}-pgdata`, postgres: `${f.namespace}-postgres`, sftp: `${f.namespace}-sftp` };
    startDependencies(f.owner, process.cwd(), prepared, names);
    const graph = JSON.parse(fs.readFileSync(prepared.paths.composeFile));
    assert.equal(graph.secrets.postgres_password.file, prepared.paths.postgresPasswordFile);
    assert.equal(graph.services.postgres.tmpfs, undefined);
    for (const value of Object.values(graph.volumes)) assert(f.volumes.has(value.name));
    for (const service of Object.values(graph.services)) {
      assert.equal(service.labels["exocortex.stage13.namespace"], f.namespace);
      for (const volume of service.volumes) if (volume.type === "bind" && !volume.read_only) assert(isWithin(f.root, volume.source));
    }
    assert.equal(f.owner.close(false).status, "STOPPED_RETAINED");
  } finally { f.cleanup(); }
});
test("image-declared data directories receive labeled retained volumes instead of anonymous data", () => {
  const f = fixture();
  try {
    f.owner.image("input"); f.owner.images[0].declaredVolumes = ["/home"];
    f.launch();
    const mount = [...f.containers.values()][0].Mounts[0];
    assert.equal(mount.Destination, "/home"); assert.equal(mount.Type, "volume");
    assert(f.volumes.has(mount.Name));
    assert.equal(f.owner.close(false).status, "STOPPED_RETAINED");
    assert.equal(f.volumes.size, 1);
  } finally { f.cleanup(); }
});
test("post-evidence host cleanup refuses another namespace and removes only its canonical marked root", () => {
  const own = createIsolation(), unrelated = createIsolation();
  try {
    assert.throws(() => removeIsolation({ root: unrelated.root, namespace: own.namespace }), /owned root|owner mismatch/);
    assert(fs.existsSync(unrelated.root));
    removeIsolation(own); assert.equal(fs.existsSync(own.root), false);
    assert(fs.existsSync(unrelated.root));
  } finally {
    if (fs.existsSync(own.root)) removeIsolation(own);
    removeIsolation(unrelated);
  }
});
test("remote Docker contexts are refused before contacting their daemon or creating resources", () => {
  const f = fixture({ endpoint: "ssh://production.example" });
  try {
    assert.throws(() => f.launch(), /remote daemon effects refused/);
    assert.equal(f.calls.some((args) => args[0] === "info" || args[0] === "create"), false);
  } finally { f.cleanup(); }
});
test("named Docker29 absence grammars require a healthy reply from the same pinned daemon", () => {
  const f = fixture();
  try {
    for (const kind of ["network", "container", "volume"]) {
      const name = `${f.namespace}-missing-${kind}`, start = f.calls.length;
      assert.equal(f.owner.lookup(kind, name), undefined);
      const operations = f.calls.slice(start);
      const inspected = operations.findIndex((args) => args[0] === kind && args[1] === "inspect");
      assert(inspected >= 0);
      assert(operations.slice(inspected + 1).some((args) => args[0] === "info" && args.includes("{{json .ID}}")));
    }
    assert.equal(f.calls.some((args) => ["create", "start", "kill"].includes(args[0]) || args.includes("rm")), false);
  } finally { f.cleanup(); }
});
test("wrong kind/name, generic errors, mixed output and nonstandard exits cannot establish absence", () => {
  const cases = [
    (name) => ({ stderr: `Error response from daemon: network ${name}-other not found\n` }),
    (name) => ({ stderr: `Error response from daemon: No such container: ${name}\n` }),
    () => ({ stderr: "Error response from daemon: not found\n" }),
    () => ({ stderr: "permission denied while trying to connect to the Docker daemon socket\n" }),
    () => ({ stderr: "Cannot connect to the Docker daemon\n" }),
    (name) => ({ stderr: `Error response from daemon: network ${name} not found\npermission denied\n` }),
    (name) => ({ status: 125, stderr: `Error response from daemon: network ${name} not found\n` }),
    (name) => ({ stdout: '[{"Id":"unexpected-object"}]', stderr: `Error response from daemon: network ${name} not found\n` }),
    (name) => ({ stdout: "partial output", stderr: `Error response from daemon: network ${name} not found\n` }),
    () => ({ status: 0, stdout: "[]", stderr: "" }),
  ];
  for (const fault of cases) {
    const f = fixture({ absence: (_kind, name) => ({ status: 1, stdout: "[]\n", ...fault(name) }) });
    try {
      assert.throws(() => f.owner.lookup("network", `${f.namespace}-missing`), /absence not established|exactly one inspected/);
      assert.equal(f.calls.some((args) => args[0] === "create" || args.includes("rm")), false);
    } finally { f.cleanup(); }
  }
  for (const kind of ["container", "volume"]) {
    const f = fixture({ absence: (_kind, name) => ({ status: 1, stdout: "[]", stderr: kind === "container" ? `Error response from daemon: No such container: ${name}-other\n` : `Error response from daemon: get ${name}-other: no such volume\n` }) });
    try { assert.throws(() => f.owner.lookup(kind, `${f.namespace}-missing`), /absence not established/); }
    finally { f.cleanup(); }
  }
});
test("a changed or unhealthy daemon cannot qualify a named not-found response", () => {
  for (const fault of ["changed", "unhealthy"]) {
    const f = fixture();
    try {
      f.owner.ensureLocalEngine(process.env);
      if (fault === "changed") f.setEngineId("different-daemon"); else f.setHealthError();
      assert.throws(() => f.owner.lookup("network", `${f.namespace}-missing`), fault === "changed" ? /daemon identity changed/ : /Docker info failed/);
      assert.equal(f.calls.some((args) => args[0] === "create" || args.includes("rm")), false);
    } finally { f.cleanup(); }
  }
});
test("unknown lookup kinds and unsafe requested names refuse before contacting Docker", () => {
  const f = fixture();
  try {
    assert.throws(() => f.owner.lookup("object", `${f.namespace}-missing`), /Invalid qualified/);
    assert.throws(() => f.owner.lookup("network", "--all"), /Invalid qualified/);
    assert.throws(() => f.owner.lookup("container", "name\nother"), /Invalid qualified/);
    assert.equal(f.calls.length, 0);
  } finally { f.cleanup(); }
});
test("Compose command transfer unescapes dollar pairs exactly once and preserves argv boundaries", () => {
  const original = ["sh", "-c", "value=$$NAME; braces=$${VALUE}; pid=$$$$; single=$name", "literal $$ argument", ""];
  const before = structuredClone(original);
  assert.deepEqual(composeCommandForEngine(original), ["sh", "-c", "value=$NAME; braces=${VALUE}; pid=$$; single=$name", "literal $ argument", ""]);
  assert.deepEqual(original, before);
  for (const command of [undefined, [], ["sh", 1], ["sh", "bad\0argument"]]) assert.throws(() => composeCommandForEngine(command), /nonempty string argv/);
});
test("actual readonly Compose secret-init command reaches a host shell with correct variable values", () => {
  const isolation = createIsolation(), repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const owner = new OwnedDocker({ ...isolation, cwd: repository });
  let pending = false, completed = false;
  try {
    const environment = { ...process.env, VAULT_APP_IMAGE: offlineRegistryFixture("saturn-app"), VAULT_WEB_IMAGE: offlineRegistryFixture("saturn-web"), VAULT_RUNTIME_ENV_FILE: path.join(repository, "infra/production/.env.production.example"), VAULT_SECRET_ROOT: path.join(isolation.root, "compose-secrets"), KERNEL_SERVICE_TOKEN: "owned-compose-fixture-token-012345678901234567890", GRYPHON_SERVICE_TOKEN_HOST_FILE: path.join(isolation.root, "gryphon-token"), NEPTUNE_CONTROL_TOKEN_HOST_FILE: path.join(isolation.root, "neptune-control"), NEPTUNE_EXPORT_TOKEN_HOST_FILE: path.join(isolation.root, "neptune-export"), UPDATER_SOCKET_GID: "1001", NEPTUNE_SOCKET_GID: "1002", GRYPHON_CLIENTS_GID: "1003" };
    const compose = JSON.parse(owner.cli(["compose", "-f", "compose.production.yaml", "config", "--format", "json"], { env: environment }).stdout);
    const original = compose.services["secret-runtime-init"].command, engine = composeCommandForEngine(original);
    assert.deepEqual(original.slice(0,2), ["sh", "-ceu"]);
    assert(original[2].includes("$$name") && original[2].includes("$$KERNEL_SERVICE_TOKEN"));
    assert(engine[2].includes("chmod 0400") && engine[2].includes("chown 1000:1000"));
    const names = ["database_password", "owner_access_key", "auth_pepper", "drop_pepper", "share_pepper", "device_pepper", "backup_pepper", "laboratory_pepper", "gryphon_service_token", "storage_private_key"];
    fs.mkdirSync(path.join(isolation.root, "fixture-secrets")); fs.mkdirSync(path.join(isolation.root, "fixture-target"));
    for (const name of names) fs.writeFileSync(path.join(isolation.root, "fixture-secrets", name), `owned-value-${name}`, { mode: 0o600 });
    // Only the transport/value semantics are qualified on an unprivileged host.
    // Ownership assertions in the actual component remain untouched. All other
    // original shell file operations execute against these owned fixture paths.
    const shellScript = (script) => `chown() { :; }\n${script.replaceAll("/run/secrets/", "./fixture-secrets/").replaceAll("/target", "./fixture-target")}`;
    const shellOptions = { root: isolation.root, cwd: isolation.root, env: { ...process.env, KERNEL_SERVICE_TOKEN: environment.KERNEL_SERVICE_TOKEN }, encoding: "utf8", timeout: 10_000 };
    const negative = runCommand(original[0], [original[1], shellScript(original[2])], shellOptions);
    pending ||= negative.status === null;
    assert.equal(negative.status, 1, "unadapted Compose escapes must reproduce the shell failure");
    const positive = runCommand(engine[0], [engine[1], shellScript(engine[2])], shellOptions);
    pending ||= positive.status === null;
    assert.equal(positive.status, 0, `adapted actual Compose command must finish with correct values; private fixture ${isolation.root}`);
    for (const name of names) assert.equal(fs.readFileSync(path.join(isolation.root, "fixture-target", name), "utf8"), `owned-value-${name}`);
    assert.equal(fs.readFileSync(path.join(isolation.root, "fixture-target/kernel_service_token"), "utf8"), `${environment.KERNEL_SERVICE_TOKEN}\n`);
    assert.equal(owner.objects.length, 0); assert.equal(owner.images.length, 0);
    assert(owner.commands.every((command) => ["context", "info", "compose"].includes(command.operation)));
    completed = true;
  } finally { owner.close(false); if (completed && !pending && !owner.pending) removeIsolation(isolation); }
});
