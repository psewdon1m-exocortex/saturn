import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./stage13-command.mjs";

const ownershipLabel = "exocortex.stage13.namespace";
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export const isWithin = (root, value) => {
  const relative = path.relative(root, path.resolve(value));
  return relative === "" || !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
};
const ordered = (value) => Array.isArray(value) ? value.map(ordered) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])])) : value;
const stable = (value) => JSON.stringify(ordered(value));
export function identity(kind, object) {
  if (kind === "container") return { id: object.Id, created: object.Created, image: object.Image,
    labels: object.Config.Labels, mounts: object.Mounts.map(({ Type, Name, Source, Destination, RW, Mode, Propagation, Driver }) => ({ Type, Name, Source, Destination, RW, Mode, Propagation, Driver })).sort((a,b) => a.Destination.localeCompare(b.Destination)) };
  if (kind === "network") return { id: object.Id, created: object.Created, labels: object.Labels, ipam: object.IPAM, driver: object.Driver };
  return { name: object.Name, created: object.CreatedAt, labels: object.Labels, driver: object.Driver, mountpoint: object.Mountpoint, options: object.Options };
}
export function assertIdentity(kind, expected, actual, namespace) {
  if (actual.labels?.[ownershipLabel] !== namespace || stable(expected) !== stable(actual)) throw new Error(`Stage13 ${kind} identity changed; effects refused`);
}
export function createIsolation(options = {}) {
  const namespace = options.namespace ?? `saturn-stage13-${randomUUID().replaceAll("-", "")}`;
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(namespace)) throw new Error("Invalid Stage13 namespace");
  const base = path.resolve(options.base ?? os.tmpdir());
  const root = fs.mkdtempSync(path.join(base, `${namespace}-`));
  fs.chmodSync(root, 0o700);
  const marker = { schema: "exocortex.local-isolation.v1", namespace, createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(root, ".exocortex-isolation.json"), JSON.stringify(marker), { mode: 0o600, flag: "wx" });
  return { root: fs.realpathSync(root), namespace };
}
export function removeIsolation({ root, namespace }) {
  if (!path.isAbsolute(root) || root !== path.resolve(root) || root === path.parse(root).root || fs.realpathSync(root) !== root || fs.lstatSync(root).isSymbolicLink() || !path.basename(root).startsWith(`${namespace}-`)) throw new Error("Stage13 cleanup target is not its canonical owned root");
  const marker = JSON.parse(fs.readFileSync(path.join(root, ".exocortex-isolation.json"), "utf8"));
  if (marker.namespace !== namespace || marker.schema !== "exocortex.local-isolation.v1") throw new Error("Stage13 cleanup owner mismatch");
  fs.rmSync(root, { recursive: true });
}

/** Every effect addresses an observed object ID after comparing its complete
 * ownership tuple. A timed out CLI leaves an honest pending admission; it never
 * grants permission to remove a resource by its former name. */
export class OwnedDocker {
  constructor({ root, namespace, cwd = process.cwd(), docker = process.platform === "win32" ? "docker.exe" : "docker", expectedEngineId, execute, now = Date.now, pause = sleep }) {
    this.root = root; this.namespace = namespace; this.docker = docker;
    this.execute = execute ?? ((args, options) => runCommand(docker, args, { root, cwd, ...options }));
    this.now = now; this.pause = pause; this.objects = []; this.images = []; this.commands = []; this.pending = false; this.closed = false; this.counter = 0;
    this.expectedEngineId = expectedEngineId; this.engine = undefined; this.resolvingEngine = false;
    this.started = now(); this.budgets = { wallClockMs: 45 * 60_000, operationMs: 120_000, oneShotMs: 180_000, stopJoinMs: 30_000, buildMs: 1_200_000 };
    this.manifestPath = path.join(root, "docker-manifest.json");
    fs.mkdirSync(path.join(root, "commands"), { mode: 0o700 });
    this.persist();
  }
  persist() {
    fs.writeFileSync(this.manifestPath, `${JSON.stringify({ schema: "saturn.stage13.resources.v1", namespace: this.namespace, engine: this.engine, budgets: this.budgets, pending: this.pending, objects: this.objects, images: this.images, commands: this.commands }, null, 2)}\n`, { mode: 0o600 });
  }
  ensureLocalEngine(env) {
    if (this.engine || this.resolvingEngine) return;
    this.resolvingEngine = true;
    try {
      const context = this.cli(["context", "show"], { env }).stdout.trim();
      const configured = JSON.parse(this.cli(["context", "inspect", context], { env }).stdout)[0];
      const endpoint = env.DOCKER_CONTEXT ? configured.Endpoints?.docker?.Host : env.DOCKER_HOST || configured.Endpoints?.docker?.Host;
      if (!/^(?:unix:\/\/\/|npipe:\/\/\/\/\.\/pipe\/)/.test(endpoint ?? "")) throw new Error("Stage13 permits only a local Unix socket/named pipe Docker endpoint; remote daemon effects refused");
      this.engine = { context, endpoint };
      this.engine.id = JSON.parse(this.cli(["info", "--format", "{{json .ID}}"], { env }).stdout);
      if (!this.engine.id || this.expectedEngineId && this.engine.id !== this.expectedEngineId) { this.engine = undefined; throw new Error("Stage13 Docker daemon identity mismatch"); }
      this.persist();
    } finally { this.resolvingEngine = false; }
  }
  cli(args, { env = process.env, input, binary = false, allowFailure = false, timeout = 120_000 } = {}) {
    if (this.pending || this.now() - this.started >= this.budgets.wallClockMs) { this.pending = true; this.persist(); throw new Error("Stage13 wall-clock/admission budget exhausted; pending resources retained"); }
    this.ensureLocalEngine(env);
    const mutation = ["create", "start", "kill", "pause", "unpause", "build", "pull"].includes(args[0]) || ["volume", "network", "container"].includes(args[0]) && ["create", "connect", "rm"].includes(args[1]) || args[0] === "compose" && args.includes("create");
    if (this.engine && !this.resolvingEngine && mutation) {
      const actualEngineId = JSON.parse(this.cli(["info", "--format", "{{json .ID}}"], { env }).stdout);
      if (actualEngineId !== this.engine.id) throw new Error("Stage13 Docker daemon identity changed; effects refused");
    }
    const effectiveArgs = this.engine ? ["--host", this.engine.endpoint, ...args] : args;
    const effectiveEnvironment = { ...env }; if (this.engine) { delete effectiveEnvironment.DOCKER_CONTEXT; delete effectiveEnvironment.DOCKER_HOST; }
    const result = this.execute(effectiveArgs, { env: effectiveEnvironment, input, encoding: binary ? null : "utf8", timeout: Math.min(timeout, this.budgets.wallClockMs - (this.now() - this.started)) });
    const evidence = path.join(this.root, "commands", String(this.commands.length).padStart(5, "0"));
    fs.writeFileSync(`${evidence}.stdout`, result.stdout ?? "", { mode: 0o600 }); fs.writeFileSync(`${evidence}.stderr`, result.stderr ?? "", { mode: 0o600 });
    this.commands.push({ argv: effectiveArgs, operation: args[0], exitCode: result.status, signal: result.signal ?? null, errorCode: result.error?.code ?? null, supervisorEvidence: result.evidence, actor: result.actor, stdout: `${evidence}.stdout`, stderr: `${evidence}.stderr` });
    if (result.status === null || result.error) this.pending = true;
    this.persist();
    if (this.pending) throw new Error("Stage13 Docker CLI is pending; resources retained and further effects refused");
    if (!allowFailure && result.status !== 0) throw new Error(`Docker ${args[0]} failed (exit ${result.status}); private output retained by caller`);
    return result;
  }
  inspect(kind, name) {
    const args = kind === "container" ? ["container", "inspect", name] : [kind, "inspect", name];
    return JSON.parse(this.cli(args).stdout)[0];
  }
  lookup(kind, name) {
    if (!["container", "network", "volume"].includes(kind) || typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) throw new Error("Invalid qualified Stage13 lookup kind/name");
    const result = this.cli(kind === "container" ? ["container", "inspect", name] : [kind, "inspect", name], { allowFailure: true });
    if (result.status === 0) {
      const found = JSON.parse(result.stdout);
      if (!Array.isArray(found) || found.length !== 1 || !found[0] || typeof found[0] !== "object" || Array.isArray(found[0])) throw new Error("Qualified lookup did not return exactly one inspected resource");
      return found[0];
    }
    // Only observed, named Docker grammars establish absence, after a healthy
    // response from the same pinned daemon. Transport/permission errors do not.
    const healthyId = JSON.parse(this.cli(["info", "--format", "{{json .ID}}"]).stdout);
    if (healthyId !== this.engine.id) throw new Error("Stage13 Docker daemon identity changed; absence not established");
    const expected = {
      container: `Error response from daemon: No such container: ${name}`,
      network: `Error response from daemon: network ${name} not found`,
      volume: `Error response from daemon: get ${name}: no such volume`,
    }[kind];
    const stdout = String(result.stdout).trim();
    if (result.status !== 1 || result.signal || !["", "[]"].includes(stdout) || String(result.stderr).trimEnd() !== expected) throw new Error("Resource absence not established for the requested kind/name");
    return undefined;
  }
  record(kind, name, object) {
    const tuple = identity(kind, object);
    if (tuple.labels?.[ownershipLabel] !== this.namespace) throw new Error(`Stage13 ${kind} has no owner label`);
    const item = { kind, name, identity: tuple, removed: false };
    this.objects.push(item); this.persist(); return item;
  }
  checked(kind, name) {
    if (this.pending) throw new Error("Stage13 pending: admission closed");
    const item = this.objects.find((value) => value.kind === kind && !value.removed && (value.name === name || value.identity.id === name));
    if (!item) throw new Error(`Unowned Stage13 ${kind}: ${name}`);
    const observed = this.inspect(kind, item.identity.id ?? item.name);
    assertIdentity(kind, item.identity, identity(kind, observed), this.namespace);
    return { item, observed, id: item.identity.id ?? item.name };
  }
  image(reference) {
    const saved = this.images.find((value) => value.reference === reference || value.id === reference);
    if (saved) return saved.id;
    let result = this.cli(["image", "inspect", reference], { allowFailure: true });
    if (result.status !== 0) {
      if (!reference.includes("@sha256:") && !["alpine:3.24", "python:3.13-bookworm"].includes(reference)) throw new Error(`Required local image is missing: ${reference}; supply/build the exact artifact first`);
      this.cli(["pull", reference], { timeout: 600_000 });
      result = this.cli(["image", "inspect", reference]);
    }
    const value = JSON.parse(result.stdout)[0];
    if (!/^sha256:[a-f0-9]{64}$/.test(value.Id)) throw new Error("Invalid local image identity");
    this.images.push({ reference, id: value.Id, repoDigests: value.RepoDigests ?? [], created: value.Created, labels: value.Config?.Labels ?? {}, declaredVolumes: Object.keys(value.Config?.Volumes ?? {}) });
    this.persist(); return value.Id;
  }
  resource(kind, name, extra = []) {
    if (this.pending || this.closed) throw new Error("Stage13 resource admission closed");
    if (this.lookup(kind, name)) throw new Error(`Stage13 name already exists: ${name}`);
    const result = this.cli([kind, "create", "--label", `${ownershipLabel}=${this.namespace}`, ...extra, name]);
    this.record(kind, name, this.inspect(kind, name)); return result;
  }
  validateMounts(args) {
    for (let i = 0; i < args.length; i++) {
      if (!["-v", "--volume"].includes(args[i])) continue;
      const value = args[++i], readOnly = value.endsWith(":ro");
      const body = readOnly || value.endsWith(":rw") ? value.slice(0, -3) : value;
      const separator = body.lastIndexOf(":");
      if (separator < 1 || !body.slice(separator + 1).startsWith("/")) throw new Error("Stage13 mount must name its source and target");
      const source = body.slice(0, separator);
      if (path.isAbsolute(source) || source.startsWith("/")) {
        if (!readOnly && !isWithin(this.root, source)) throw new Error("Writable bind escapes Stage13 root");
        if (isWithin(this.root, source) && fs.existsSync(source) && !isWithin(this.root, fs.realpathSync(source))) throw new Error("Stage13 bind resolves outside owned root");
      } else this.checked("volume", source);
    }
    const network = args.indexOf("--network");
    if (network !== -1 && args[network + 1] !== "none") this.checked("network", args[network + 1]);
  }
  createRun(args, environment, allowFailure, input) {
    if (this.pending || this.closed) throw new Error("Stage13 container admission closed");
    const detached = args.includes("-d") || args.includes("--detach");
    args = args.filter((arg) => !["--rm", "-d", "--detach"].includes(arg));
    let nameIndex = args.indexOf("--name");
    const name = nameIndex === -1 ? `${this.namespace}-job-${++this.counter}` : args[nameIndex + 1];
    if (!name.startsWith(`${this.namespace}-`) || this.lookup("container", name)) throw new Error("Stage13 container name is not fresh/owned");
    this.validateMounts(args);
    // Docker options all precede the image. Never substitute command arguments
    // that happen to resemble an image reference.
    const takesValue = new Set(["--name", "--network", "--ip", "--network-alias", "--env-file", "--entrypoint", "--user", "--tmpfs", "--security-opt", "--cap-drop", "--cap-add", "--memory", "--cpus", "--pids-limit", "--health-cmd", "--health-interval", "--health-timeout", "--health-retries", "--health-start-period", "-v", "--volume", "-w", "--workdir", "-e", "--env", "-p", "--publish", "--label"]);
    let imageIndex = 0;
    for (; imageIndex < args.length; imageIndex++) { if (!args[imageIndex].startsWith("-")) break; if (takesValue.has(args[imageIndex])) imageIndex++; }
    args[imageIndex] = this.image(args[imageIndex]);
    const explicitTargets = args.flatMap((arg, index) => ["-v", "--volume"].includes(arg) ? [args[index + 1].replace(/:(?:ro|rw)$/, "").split(":").at(-1)] : []);
    const additionalMounts = [];
    for (const target of this.images.find((image) => image.id === args[imageIndex]).declaredVolumes ?? []) {
      if (explicitTargets.some((mounted) => target === mounted || target.startsWith(`${mounted}/`))) continue;
      const volume = `${this.namespace}-image-volume-${++this.counter}`;
      this.resource("volume", volume); additionalMounts.push("-v", `${volume}:${target}`);
    }
    const createArgs = ["create", "--label", `${ownershipLabel}=${this.namespace}`, ...(nameIndex === -1 ? ["--name", name] : []), ...(!args.includes("--memory") ? ["--memory", "512m", "--cpus", "2", "--pids-limit", "256"] : []), ...additionalMounts, ...args];
    const created = this.cli(createArgs, { env: environment });
    const item = this.record("container", name, this.inspect("container", created.stdout.trim()));
    if (item.identity.image !== args[imageIndex]) throw new Error("Container does not use the resolved exact image");
    for (const mount of item.identity.mounts) if (mount.Type === "volume") this.checked("volume", mount.Name);
    this.checked("container", name);
    this.cli(["start", item.identity.id]);
    if (detached) return { ...created, stdout: `${item.identity.id}\n` };
    const deadline = this.now() + this.budgets.oneShotMs;
    let state;
    do { state = this.checked("container", name).observed.State; if (!state.Running) break; this.pause(100); } while (this.now() < deadline);
    if (state.Running) { this.pending = true; this.persist(); throw new Error("Stage13 one-shot did not join; retained pending"); }
    const logs = this.cli(["logs", item.identity.id], { allowFailure: true });
    const result = { ...logs, status: state.ExitCode };
    this.commands.push({ operation: "container-exit", id: item.identity.id, exitCode: state.ExitCode }); this.persist();
    if (result.status !== 0 && !allowFailure) throw new Error(`Stage13 one-shot failed (exit ${result.status}); container/logs retained: ${name}`);
    return result;
  }
  stop(name, timeout = this.budgets.stopJoinMs) {
    let { id, observed } = this.checked("container", name);
    if (observed.State.Paused) { this.cli(["unpause", id]); observed = this.checked("container", name).observed; }
    if (!observed.State.Running) return;
    this.cli(["kill", "--signal", "TERM", id]);
    const deadline = this.now() + timeout;
    do { if (!this.checked("container", name).observed.State.Running) return; this.pause(100); } while (this.now() < deadline);
    this.pending = true; this.persist(); throw new Error(`Stage13 cooperative termination did not join: ${name}; retained pending`);
  }
  run(args, environment = process.env, allowFailure = false, input) {
    if (args[0] === "run") return this.createRun(args.slice(1), environment, allowFailure, input);
    if (["volume", "network"].includes(args[0]) && args[1] === "create") return this.resource(args[0], args.at(-1), args.slice(2,-1));
    if (args[0] === "stop") { for (const name of args.slice(1)) this.stop(name); return { status: 0, stdout: "", stderr: "" }; }
    if (args[0] === "rm" || args[0] === "kill" || args[1] === "rm" || args[0] === "compose" && !args.includes("config")) throw new Error("Use the owned lifecycle API, not an unqualified Docker mutation");
    if (args[0] === "network" && args[1] === "connect") {
      this.checked("network", args.at(-2)); const checked = this.checked("container", args.at(-1));
      return this.cli([...args.slice(0,-1), checked.id], { env: environment, allowFailure });
    }
    if (["exec", "logs", "port", "start", "pause", "unpause", "inspect"].includes(args[0])) {
      const index = args[0] === "exec" ? args.findIndex((arg, i) => i > 0 && !arg.startsWith("-")) : args[0] === "inspect" ? args.length - 1 : args[0] === "logs" ? args.length - 1 : 1;
      const checked = this.checked("container", args[index]); args = [...args]; args[index] = checked.id;
    }
    return this.cli(args, { env: environment, input, allowFailure, timeout: args[0] === "build" ? 1_200_000 : 120_000 });
  }
  binary(args, input) {
    if (args[0] !== "exec") throw new Error("Only owned binary exec is allowed");
    const index = args.findIndex((arg, i) => i > 0 && !arg.startsWith("-"));
    const checked = this.checked("container", args[index]); args = [...args]; args[index] = checked.id;
    return Buffer.from(this.cli(args, { input, binary: true }).stdout ?? []);
  }
  close(success) {
    this.closed = true;
    if (this.pending) return { status: "PENDING", retained: true };
    try {
      for (const item of [...this.objects].reverse().filter((value) => value.kind === "container" && !value.removed)) this.stop(item.name);
      if (!success) return { status: "STOPPED_RETAINED", retained: true };
      const removalOrder = ["container", "network", "volume"].flatMap((kind) => [...this.objects].reverse().filter((item) => item.kind === kind));
      for (const item of removalOrder) {
        if (item.removed) continue;
        const checked = this.checked(item.kind, item.name);
        if (item.kind === "container" && checked.observed.State.Running) throw new Error("Container still running");
        this.cli(item.kind === "container" ? ["container", "rm", checked.id] : [item.kind, "rm", checked.id]);
        item.removed = true; this.persist();
      }
      return { status: "CLOSED", retained: false };
    } catch (error) { return { status: this.pending ? "PENDING" : "IDENTITY_OR_CLOSURE_FAILURE", retained: true, error: error.message }; }
  }
}

export function startDependencies(owner, sourceRoot, prepared, names) {
  const { namespace, root } = owner;
  if (names.subnet) owner.resource("network", names.network, ["--subnet", names.subnet]);
  else owner.resource("network", names.network);
  owner.resource("volume", names.dataVolume);
  const overlay = path.join(root, "dependency-inputs.compose.json");
  fs.writeFileSync(overlay, JSON.stringify({ secrets: { postgres_password: { file: prepared.paths.postgresPasswordFile } } }), { mode: 0o600 });
  const base = JSON.parse(owner.cli(["compose", "--project-directory", sourceRoot, "-f", path.join(sourceRoot, "compose.yaml"), "-f", overlay, "config", "--format", "json"], { env: { ...process.env, ...prepared.environment } }).stdout);
  if (Object.keys(base.services).sort().join(",") !== "postgres,sftp" || base.services.postgres.environment.POSTGRES_PASSWORD_FILE !== "/run/secrets/postgres_password") throw new Error("Development dependency contract changed; review isolation adapter");
  base.name = namespace;
  base.networks = { default: { name: names.network, external: true } };
  base.volumes = { pgdata: { name: names.dataVolume, external: true } };
  base.secrets.postgres_password.file = prepared.paths.postgresPasswordFile;
  for (const [service, config] of Object.entries(base.services)) {
    config.container_name = names[service];
    config.labels = { ...config.labels, [ownershipLabel]: namespace };
    config.image = owner.image(config.image);
    config.networks = { default: { aliases: [service] } };
    // Retain PostgreSQL contents after a failed/pending qualification. The
    // ordinary development Compose tmpfs contract is untouched.
    if (service === "postgres") { delete config.tmpfs; config.volumes = [{ type: "volume", source: "pgdata", target: "/var/lib/postgresql" }]; }
    for (const target of owner.images.find((image) => image.id === config.image).declaredVolumes ?? []) {
      if ((config.volumes ?? []).some((volume) => volume.target === target || target.startsWith(`${volume.target}/`))) continue;
      const logical = `${service}_image_data`, name = `${namespace}-${service}-image-data`;
      owner.resource("volume", name); base.volumes[logical] = { name, external: true };
      (config.volumes ??= []).push({ type: "volume", source: logical, target });
    }
    if (owner.lookup("container", names[service])) throw new Error("Dependency name is occupied");
    for (const volume of config.volumes ?? []) if (volume.type === "bind" && !volume.read_only && !isWithin(root, volume.source)) throw new Error("Dependency writable mount escaped own root");
  }
  const configFile = prepared.paths.composeFile;
  fs.writeFileSync(configFile, JSON.stringify(base, null, 2), { mode: 0o600 });
  let failure;
  try { owner.cli(["compose", "--project-directory", root, "-p", namespace, "-f", configFile, "create", "--no-build"]); }
  catch (error) { failure = error; }
  if (!owner.pending) for (const [service, config] of Object.entries(base.services)) {
    const object = owner.lookup("container", names[service]);
    if (object) {
      owner.record("container", names[service], object);
      if (object.Image !== config.image) throw new Error("Dependency image identity mismatch");
      for (const mount of object.Mounts) if (mount.Type === "volume") owner.checked("volume", mount.Name);
    } else if (!failure) throw new Error("Expected dependency container missing");
  }
  if (failure) throw failure;
  for (const service of Object.keys(base.services)) owner.run(["start", names[service]]);
  const deadline = owner.now() + 90_000;
  do {
    if (Object.keys(base.services).every((service) => owner.checked("container", names[service]).observed.State.Health?.Status === "healthy")) return;
    owner.pause(250);
  } while (owner.now() < deadline);
  throw new Error("Owned dependencies did not become healthy");
}

export function composeCommandForEngine(command) {
  if (!Array.isArray(command) || command.length === 0 || command.some((argument) => typeof argument !== "string" || argument.includes("\0"))) throw new Error("Rendered Compose command must be a nonempty string argv");
  // `compose config` preserves dollar escapes for another Compose parse. A
  // direct Engine argv needs exactly one unescape, never env interpolation.
  return command.map((argument) => argument.replaceAll("$$", "$"));
}

export function offlineRegistryFixture(name) {
  // This digest is explicitly a schema/signature fixture, never a Docker image.
  return `registry.stage13.test/${name}@sha256:${createHash("sha256").update(`offline-validator-fixture:${name}`).digest("hex")}`;
}
