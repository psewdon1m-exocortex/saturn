import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hashPattern = /^[a-f0-9]{64}$/;
const imagePattern = /^sha256:[a-f0-9]{64}$/;
export const reviewedHarnessFiles = Object.freeze([
  ".github/workflows/release.yml", ".github/workflows/verify.yml", "scripts/prepare-dev.mjs",
  "scripts/verify-production-secret-runtime.mjs", "scripts/verify-stage-13.mjs",
  "scripts/stage13-browser.mjs", "scripts/stage13-command.mjs", "scripts/stage13-command.test.mjs",
  "scripts/stage13-mode.mjs", "scripts/stage13-mode.test.mjs", "scripts/stage13-prepare.test.mjs",
  "scripts/stage13-runtime.mjs", "scripts/stage13-runtime.test.mjs", "scripts/stage13-trust.mjs", "scripts/stage13-trust.test.mjs",
  "scripts/ci-workspace-inputs.mjs", "scripts/ci-workspace-pgdump.mjs", "scripts/ci-workspace-pgdump.test.mjs", "scripts/ci-workspace-accounting.mjs", "scripts/ci-workspace-accounting.test.mjs",
]);
export function parseStage13Mode(args) {
  if (args.length === 0) return "FULL";
  if (args.length === 1 && args[0] === "--runtime-diagnostic") return "RUNTIME_DIAGNOSTIC";
  throw new Error("Unknown Stage13 arguments; expected no arguments or exactly --runtime-diagnostic");
}
function assertMode(mode) {
  if (!["FULL", "RUNTIME_DIAGNOSTIC"].includes(mode)) throw new Error("Unknown Stage13 execution scope");
}
export function workspaceQualityCommands(pnpm, reportKey = "stage13") {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(reportKey)) throw new Error("Unsafe workspace report key");
  return [
    { name: "install", argv: [pnpm, "install", "--frozen-lockfile"] },
    { name: "lint", argv: [pnpm, "lint"] },
    { name: "typecheck", argv: [pnpm, "-r", "--workspace-concurrency=2", "--if-present", "typecheck"] },
    { name: "build", argv: [pnpm, "-r", "--workspace-concurrency=2", "--if-present", "build"] },
    // A15 requires a genuinely isolated file, not only an environment label.
    { name: "test", argv: [pnpm, "-r", "--workspace-concurrency=1", "--if-present", "test", "--maxWorkers=1", "--reporter=json", `--outputFile=.tmp/${reportKey}.json`] },
  ];
}
export function runWorkspaceQuality(mode, pnpm, execute, options = {}) {
  assertMode(mode);
  if (mode === "RUNTIME_DIAGNOSTIC") return { accepted: false, status: "not_accepted", reason: "Workspace quality is not qualified in runtime diagnostic scope", gates: [] };
  const gates = [];
  for (const command of workspaceQualityCommands(pnpm, options.reportKey)) {
    if (command.name === "test") options.beforeTests?.();
    const result = execute(command.argv);
    if (result.status !== 0 || result.signal || result.error) {
      options.failed?.(command.name, result);
      throw new Error(`Required workspace ${command.name} gate did not complete successfully`);
    }
    gates.push({ name: command.name, exitCode: result.status });
  }
  const accounting = options.accounting?.();
  if (accounting && accounting.ordinaryAccepted !== true) throw new Error("Required workspace case accounting failed");
  return { accepted: true, status: "pass", gates, accounting, fullQualificationAccepted: accounting?.fullQualificationAccepted === true };
}
export function completedRuntimeGraph(report) {
  return report.runtimeChecksPassed === true && !report.error && !report.cleanupError;
}
export function finalizeStage13Report(report, mode) {
  assertMode(mode);
  const closed = completedRuntimeGraph(report) && report.closure?.status === "CLOSED";
  report.readyToDeploy = false;
  report.executionScope = mode;
  if (mode === "RUNTIME_DIAGNOSTIC") {
    report.qualityAccepted = false; report.ordinaryCiAccepted = false; report.fullCiAccepted = false; report.success = false;
    report.exitCode = closed ? 2 : 1;
  } else {
    report.ordinaryCiAccepted = closed && report.qualityAccepted === true;
    report.fullCiAccepted = report.ordinaryCiAccepted && report.quality?.fullQualificationAccepted === true;
    report.success = report.ordinaryCiAccepted;
    report.exitCode = report.success ? 0 : 1;
  }
  return report.exitCode;
}
const inside = (root, target) => { const relative = path.relative(root, target); return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
function relativeName(name) {
  if (typeof name !== "string" || name === "" || name.includes("\\") || name.includes(":") || name.includes("\0") || path.posix.normalize(name) !== name || name === "." || name.startsWith("/") || name === ".." || name.startsWith("../")) throw new Error("Diagnostic manifest contains an unsafe relative file path");
  return name;
}
function rows(values, key) {
  if (!Array.isArray(values) || values.length === 0) throw new Error("Diagnostic file manifest is empty");
  const found = new Map();
  for (const row of values) {
    const name = relativeName(row[key]);
    if (found.has(name) || !hashPattern.test(row.sha256) || !Number.isSafeInteger(row.bytes) || row.bytes < 0) throw new Error("Invalid or duplicate diagnostic file row");
    found.set(name, row);
  }
  return found;
}
async function fileHash(root, name) {
  const target = path.resolve(root, relativeName(name));
  if (!inside(root, target) || (await fs.lstat(target)).isSymbolicLink() || !inside(root, await fs.realpath(target))) throw new Error("Diagnostic source file escapes its bound root");
  const bytes = await fs.readFile(target);
  return { sha256: digest(bytes), bytes: bytes.length };
}
async function boundJson(binding, title) {
  if (!binding || typeof binding.path !== "string" || !path.isAbsolute(binding.path) || !hashPattern.test(binding.sha256)) throw new Error(`Diagnostic ${title} binding is required`);
  const bytes = await fs.readFile(binding.path);
  if (digest(bytes) !== binding.sha256) throw new Error(`Diagnostic ${title} hash mismatch`);
  return JSON.parse(bytes.toString("utf8"));
}
function same(actual, expected, title) { if (actual !== expected) throw new Error(`Diagnostic ${title} mismatch`); }

/** Read-only admission. No directory, command, Docker or TLS effect is allowed
 * until every immutable input and reviewed harness file has been checked. */
export async function verifyRuntimeDiagnosticInput(input, sourceRoot) {
  if (input?.templateOnly === true) throw new Error("Populate the diagnostic input template before admission");
  const card = await boundJson(input?.diagnosticCard, "card");
  if (card.templateOnly === true) throw new Error("Populate the diagnostic card template before admission");
  same(card.schema, "saturn.stage13.runtime-diagnostic.v1", "card schema");
  const bindings = card.bindings;
  const [source, build, images, harness] = await Promise.all([
    boundJson(bindings?.sourceManifest, "original source manifest"), boundJson(bindings?.buildInputManifest, "original build-input manifest"),
    boundJson(bindings?.imageManifest, "image manifest"), boundJson(bindings?.harnessManifest, "reviewed harness manifest"),
  ]);
  const expected = card.expected;
  if (!expected || !hashPattern.test(expected.sourceRevision) || !hashPattern.test(expected.harnessSha256) || !hashPattern.test(expected.buildContextSha256)) throw new Error("Diagnostic expected tuple is required");
  for (const name of ["appImage", "webImage", "browserImage"]) {
    if (!imagePattern.test(expected[name])) throw new Error("Diagnostic image inputs must be exact local IDs from the bound manifest");
    same(input[name], expected[name], name);
  }
  for (const name of ["version", "sourceRevision", "dockerEngineId"]) {
    if (typeof expected[name] !== "string" || expected[name] === "") throw new Error("Diagnostic expected identity is empty");
    same(input[name], expected[name], name);
  }
  const canonicalRoot = await fs.realpath(sourceRoot);
  same(canonicalRoot, path.resolve(sourceRoot), "canonical source root");
  const packageVersion = JSON.parse(await fs.readFile(path.join(canonicalRoot, "package.json"), "utf8")).version;
  same(packageVersion, expected.version, "current source version");
  same(source.source_sha256, expected.sourceRevision, "original source revision");
  same(build.source_sha256, source.source_sha256, "build source revision");
  same(build.revision_label, expected.sourceRevision, "build revision label");
  same(build.version, expected.version, "build version");
  same(images.source_sha256, source.source_sha256, "image source revision");
  same(images.version, expected.version, "image version");
  same(images.docker_engine_id, expected.dockerEngineId, "image engine");
  same(digest(JSON.stringify(build.files)), expected.buildContextSha256, "build file tuple");
  same(build.context_sha256, expected.buildContextSha256, "build context digest");
  if (typeof build.context !== "string" || !path.isAbsolute(build.context)) throw new Error("Original build context path is required");
  const context = await fs.realpath(build.context);
  const sourceFiles = rows(source.files, "path"), buildFiles = rows(build.files, "path"), harnessFiles = rows(harness, "file");
  const requiredHarness = new Set(reviewedHarnessFiles);
  if (harnessFiles.size !== requiredHarness.size || [...harnessFiles.keys()].some((name) => !requiredHarness.has(name))) throw new Error("Reviewed harness manifest must enumerate the exact approved file set");
  same(harnessFiles.get("scripts/verify-stage-13.mjs").sha256, expected.harnessSha256, "reviewed main harness SHA");
  const observed = new Map();
  for (const [name, row] of harnessFiles) {
    const actual = await fileHash(canonicalRoot, name);
    same(actual.sha256, row.sha256, `reviewed harness ${name}`); same(actual.bytes, row.bytes, `reviewed harness bytes ${name}`);
    observed.set(name, actual);
  }
  for (const [name, row] of buildFiles) {
    const original = sourceFiles.get(name);
    if (!original) throw new Error("Build input is absent from the original source manifest");
    same(row.sha256, original.sha256, `original build source ${name}`); same(row.bytes, original.bytes, `original build bytes ${name}`);
    const actual = await fileHash(canonicalRoot, name), copied = await fileHash(context, name);
    for (const value of [actual, copied]) { same(value.sha256, row.sha256, `product build input ${name}`); same(value.bytes, row.bytes, `product build bytes ${name}`); }
    observed.set(name, actual);
  }
  const delta = [];
  for (const [name, row] of sourceFiles) {
    const actual = observed.get(name) ?? await fileHash(canonicalRoot, name);
    observed.set(name, actual);
    if (actual.sha256 === row.sha256 && actual.bytes === row.bytes) continue;
    if (!harnessFiles.has(name)) throw new Error(`Unreviewed source delta: ${name}`);
    delta.push({ file: name, beforeSha256: row.sha256, afterSha256: actual.sha256 });
  }
  for (const [role, title] of [["appImage", "Saturn Gateway runtime"], ["webImage", "Saturn web runtime"], ["browserImage", undefined]]) {
    const matches = (images.images ?? []).filter((image) => image.Id === expected[role]);
    if (matches.length !== 1) throw new Error(`Diagnostic ${role} is absent or ambiguous in the image manifest`);
    const labels = matches[0].Config?.Labels ?? {};
    if (title) { same(labels["org.opencontainers.image.title"], title, `${role} title`); same(labels["org.opencontainers.image.version"], expected.version, `${role} version`); same(labels["org.opencontainers.image.revision"], expected.sourceRevision, `${role} revision`); }
    else same(labels["exocortex.tool.scope"], "stage13-browser", "browser tool scope");
  }
  return { card: input.diagnosticCard, bindings, originalSourceSha256: source.source_sha256, productBuildInputsEqual: true, productBuildFileCount: buildFiles.size,
    originalSourceFileCount: sourceFiles.size, reviewedHarnessSha256: expected.harnessSha256, reviewedHarnessDelta: delta,
    newReviewedHarnessFiles: [...harnessFiles.keys()].filter((name) => !sourceFiles.has(name)), currentObservedFilesSha256: digest(JSON.stringify([...observed].sort(([a],[b]) => a.localeCompare(b)))) };
}
