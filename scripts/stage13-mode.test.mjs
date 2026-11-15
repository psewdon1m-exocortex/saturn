import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { parseStage13Mode, workspaceQualityCommands, runWorkspaceQuality, completedRuntimeGraph, finalizeStage13Report, reviewedHarnessFiles, verifyRuntimeDiagnosticInput } from "./stage13-mode.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stage13-mode-control-"));
  const source = path.join(root, "source"), context = path.join(root, "context");
  await fs.mkdir(source); await fs.mkdir(context);
  const write = async (base, name, bytes) => { const target = path.join(base, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes); return { path: name, bytes: Buffer.byteLength(bytes), sha256: digest(bytes) }; };
  const original = [];
  original.push(await write(source, "package.json", JSON.stringify({ version: "0.2.14" })));
  original.push(await write(source, "packages/product.ts", "export const product = 1;\n"));
  original.push(await write(source, "README.md", "original documentation\n"));
  const buildFiles = original.slice(0,2);
  for (const row of buildFiles) await write(context, row.path, await fs.readFile(path.join(source, row.path)));
  const harness = [];
  for (const name of reviewedHarnessFiles) {
    const current = await write(source, name, `reviewed ${name}\n`);
    harness.push({ file: name, bytes: current.bytes, sha256: current.sha256 });
    if (["scripts/stage13-mode.mjs", "scripts/stage13-mode.test.mjs"].includes(name)) continue;
    const previous = name === "scripts/verify-stage-13.mjs" ? "previous harness\n" : `reviewed ${name}\n`;
    original.push({ path: name, bytes: Buffer.byteLength(previous), sha256: digest(previous) });
  }
  const revision = "a".repeat(64), app = `sha256:${"1".repeat(64)}`, web = `sha256:${"2".repeat(64)}`, browser = `sha256:${"3".repeat(64)}`;
  const documents = {
    sourceManifest: { source_sha256: revision, files: original },
    buildInputManifest: { source_sha256: revision, revision_label: revision, version: "0.2.14", context, files: buildFiles, context_sha256: digest(JSON.stringify(buildFiles)) },
    imageManifest: { source_sha256: revision, version: "0.2.14", docker_engine_id: "fixture-engine", images: [
      ...[[app, "Saturn Gateway runtime"], [web, "Saturn web runtime"]].map(([Id, title]) => ({ Id, Config: { Labels: { "org.opencontainers.image.title": title, "org.opencontainers.image.version": "0.2.14", "org.opencontainers.image.revision": revision } } })),
      { Id: browser, Config: { Labels: { "exocortex.tool.scope": "stage13-browser" } } },
    ] },
    harnessManifest: harness,
  };
  const card = { schema: "saturn.stage13.runtime-diagnostic.v1", bindings: {}, expected: { sourceRevision: revision, version: "0.2.14", dockerEngineId: "fixture-engine", appImage: app, webImage: web, browserImage: browser, buildContextSha256: documents.buildInputManifest.context_sha256, harnessSha256: harness.find((row) => row.file === "scripts/verify-stage-13.mjs").sha256 } };
  const input = { ...card.expected };
  const saveCard = async () => { const file = path.join(root, "card.json"), bytes = JSON.stringify(card); await fs.writeFile(file, bytes); input.diagnosticCard = { path: file, sha256: digest(bytes) }; };
  const saveBinding = async (name) => { const file = path.join(root, `${name}.json`), bytes = JSON.stringify(documents[name]); await fs.writeFile(file, bytes); card.bindings[name] = { path: file, sha256: digest(bytes) }; await saveCard(); };
  for (const name of Object.keys(documents)) await saveBinding(name);
  return { root, source, context, input, documents, card, saveCard, saveBinding, cleanup: () => fs.rm(root, { recursive: true }) };
}

test("only the default full scope and explicit single diagnostic argument are admitted", () => {
  assert.equal(parseStage13Mode([]), "FULL");
  assert.equal(parseStage13Mode(["--runtime-diagnostic"]), "RUNTIME_DIAGNOSTIC");
  for (const args of [["--skip-quality"], ["--reuse"], ["--runtime-diagnostic", "extra"], ["--runtime-diagnostic=true"]]) assert.throws(() => parseStage13Mode(args), /Unknown Stage13 arguments/);
});
test("default full mode executes all five required quality gates with supported finite workers", () => {
  const calls = [], quality = runWorkspaceQuality("FULL", "pnpm.cjs", (argv) => { calls.push(argv); return { status: 0, signal: null }; });
  assert.equal(quality.accepted, true);
  assert.deepEqual(quality.gates.map((gate) => gate.name), ["install", "lint", "typecheck", "build", "test"]);
  assert.deepEqual(calls, workspaceQualityCommands("pnpm.cjs").map((command) => command.argv));
  assert(calls[4].includes("--maxWorkers=1")); assert(calls[4].includes("--workspace-concurrency=1"));
  assert(calls[4].includes("--reporter=json"));
  assert.equal(quality.fullQualificationAccepted, false, "command exits alone do not resolve conditional qualification");
  assert.equal(calls.flat().some((arg) => arg.startsWith("--minWorkers")), false);
});
test("each default quality gate must really finish with numeric zero", () => {
  for (let failed = 0; failed < 5; failed++) {
    let count = 0;
    assert.throws(() => runWorkspaceQuality("FULL", "pnpm", () => ({ status: count++ === failed ? 1 : 0 })), /did not complete/);
    assert.equal(count, failed + 1);
  }
  assert.throws(() => runWorkspaceQuality("FULL", "pnpm", () => ({ status: null })), /did not complete/);
  const recorded=[];
  assert.throws(() => runWorkspaceQuality("FULL", "pnpm", () => ({ status: 1 }), { failed: (name,result) => recorded.push({name,exit:result.status}) }), /did not complete/);
  assert.deepEqual(recorded,[{name:'install',exit:1}]);
});
test("runtime diagnostic never accepts quality and cannot return full CI green", () => {
  const quality = runWorkspaceQuality("RUNTIME_DIAGNOSTIC", "pnpm", () => { throw new Error("Diagnostic must not execute workspace quality"); });
  assert.equal(quality.accepted, false); assert.equal(quality.status, "not_accepted");
  const report = { runtimeChecksPassed: true, qualityAccepted: true, fullCiAccepted: true, success: true, readyToDeploy: true, closure: { status: "CLOSED" } };
  assert.equal(completedRuntimeGraph(report), true);
  assert.equal(finalizeStage13Report(report, "RUNTIME_DIAGNOSTIC"), 2);
  for (const field of ["qualityAccepted", "fullCiAccepted", "success", "readyToDeploy"]) assert.equal(report[field], false);
  assert.equal(completedRuntimeGraph(report), true, "completed diagnostic closure must not depend on full acceptance");
  for (const closure of ["PENDING", "IDENTITY_OR_CLOSURE_FAILURE", "STOPPED_RETAINED"]) assert.equal(finalizeStage13Report({ runtimeChecksPassed: true, closure: { status: closure } }, "RUNTIME_DIAGNOSTIC"), 1);
});
test("the actual Node exit for a completed diagnostic policy is nonzero two", () => {
  const moduleUrl = pathToFileURL(path.join(sourceRoot, "scripts/stage13-mode.mjs")).href;
  const code = `import {finalizeStage13Report} from ${JSON.stringify(moduleUrl)};const report={runtimeChecksPassed:true,qualityAccepted:true,closure:{status:'CLOSED'}};process.exitCode=finalizeStage13Report(report,'RUNTIME_DIAGNOSTIC');process.stdout.write(JSON.stringify(report));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 2);
  const report = JSON.parse(result.stdout);
  assert.equal(report.runtimeChecksPassed, true);
  for (const field of ["qualityAccepted", "fullCiAccepted", "success", "readyToDeploy"]) assert.equal(report[field], false);
});
test("full CI acceptance requires all quality, runtime and closure facts", () => {
  const pass = { qualityAccepted: true, quality: { fullQualificationAccepted: true }, runtimeChecksPassed: true, closure: { status: "CLOSED" } };
  assert.equal(finalizeStage13Report(pass, "FULL"), 0); assert.equal(pass.success, true);
  assert.equal(pass.fullCiAccepted, true);
  assert.equal(finalizeStage13Report({ ...pass, qualityAccepted: false }, "FULL"), 1);
  assert.equal(finalizeStage13Report({ ...pass, error: "failure" }, "FULL"), 1);
  assert.equal(finalizeStage13Report({ ...pass, cleanupError: "cleanup failed" }, "FULL"), 1);
  assert.equal(completedRuntimeGraph({ runtimeChecksPassed: true, error: "failure" }), false);
});
test("ordinary CI with conditional NOT_RUN stays distinct from full qualification", () => {
  const accounting = { ordinaryAccepted: true, fullQualificationAccepted: false, counts: { passed: 1, pending: 1 } };
  const order = [];
  const quality = runWorkspaceQuality("FULL", "pnpm", () => { order.push("command"); return { status: 0 }; }, {
    beforeTests: () => order.push("fixture-migration"), accounting: () => accounting,
  });
  assert.equal(order[4], "fixture-migration"); assert.equal(order[5], "command");
  const report = { quality, qualityAccepted: quality.accepted, runtimeChecksPassed: true, closure: { status: "CLOSED" } };
  assert.equal(finalizeStage13Report(report, "FULL"), 0);
  assert.equal(report.ordinaryCiAccepted, true); assert.equal(report.fullCiAccepted, false); assert.equal(report.readyToDeploy, false);
  assert.throws(() => runWorkspaceQuality("FULL", "pnpm", () => ({status:0}), { accounting: () => ({ordinaryAccepted:false}) }), /accounting failed/);
});
test("bound diagnostic admission proves copied and current product inputs while disclosing the reviewed harness delta", async () => {
  const f = await fixture();
  try {
    const before = await fs.readdir(f.root, { recursive: true });
    const result = await verifyRuntimeDiagnosticInput(f.input, f.source);
    assert.equal(result.productBuildInputsEqual, true); assert.equal(result.productBuildFileCount, 2);
    assert.deepEqual(result.reviewedHarnessDelta.map((row) => row.file), ["scripts/verify-stage-13.mjs"]);
    assert.deepEqual(result.newReviewedHarnessFiles.sort(), ["scripts/stage13-mode.mjs", "scripts/stage13-mode.test.mjs"]);
    assert.deepEqual(await fs.readdir(f.root, { recursive: true }), before, "admission must be read-only");
  } finally { await f.cleanup(); }
});
test("missing or mismatched card and manifest hashes refuse admission without filesystem effects", async () => {
  const f = await fixture();
  try {
    const before = await fs.readdir(f.root, { recursive: true });
    await assert.rejects(verifyRuntimeDiagnosticInput({}, f.source), /card binding is required/);
    await assert.rejects(verifyRuntimeDiagnosticInput({ ...f.input, diagnosticCard: { ...f.input.diagnosticCard, sha256: "0".repeat(64) } }, f.source), /card hash mismatch/);
    for (const name of Object.keys(f.card.bindings)) {
      const saved = f.card.bindings[name].sha256; f.card.bindings[name].sha256 = "0".repeat(64); await f.saveCard();
      await assert.rejects(verifyRuntimeDiagnosticInput(f.input, f.source), /hash mismatch/);
      f.card.bindings[name].sha256 = saved; await f.saveCard();
    }
    assert.deepEqual(await fs.readdir(f.root, { recursive: true }), before);
  } finally { await f.cleanup(); }
});
test("current product changes cannot be exempted by a harness manifest entry", async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.source, "packages/product.ts"), "changed\n");
    await assert.rejects(verifyRuntimeDiagnosticInput(f.input, f.source), /product build input/);
    f.documents.harnessManifest.push({ file: "packages/product.ts", bytes: 8, sha256: digest("changed\n") }); await f.saveBinding("harnessManifest");
    await assert.rejects(verifyRuntimeDiagnosticInput(f.input, f.source), /exact approved file set/);
  } finally { await f.cleanup(); }
});
test("the archived build context and non-product original source are independently checked", async () => {
  const f = await fixture();
  try {
    const product = path.join(f.context, "packages/product.ts"), original = await fs.readFile(product);
    await fs.writeFile(product, "tampered snapshot\n");
    await assert.rejects(verifyRuntimeDiagnosticInput(f.input, f.source), /product build input/);
    await fs.writeFile(product, original);
    await fs.writeFile(path.join(f.source, "README.md"), "unreviewed source\n");
    await assert.rejects(verifyRuntimeDiagnosticInput(f.input, f.source), /Unreviewed source delta/);
  } finally { await f.cleanup(); }
});
test("current harness bytes and exact image, engine, version and revision tuples must match the reviewed card", async () => {
  const f = await fixture();
  try {
    for (const field of ["appImage", "webImage", "browserImage", "dockerEngineId", "version", "sourceRevision"]) await assert.rejects(verifyRuntimeDiagnosticInput({ ...f.input, [field]: "mismatch" }, f.source), /mismatch/);
    await fs.writeFile(path.join(f.source, "scripts/verify-stage-13.mjs"), "unreviewed harness\n");
    await assert.rejects(verifyRuntimeDiagnosticInput(f.input, f.source), /reviewed harness/);
  } finally { await f.cleanup(); }
});
test("an image with the wrong product role cannot satisfy a matching numeric digest", async () => {
  const f = await fixture();
  try {
    f.documents.imageManifest.images[0].Config.Labels["org.opencontainers.image.title"] = "different product";
    await f.saveBinding("imageManifest");
    await assert.rejects(verifyRuntimeDiagnosticInput(f.input, f.source), /appImage title mismatch/);
  } finally { await f.cleanup(); }
});
test("unsafe file paths are refused even when a manifest document hash is bound", async () => {
  const f = await fixture();
  try {
    f.documents.sourceManifest.files[0].path = "../outside"; await f.saveBinding("sourceManifest");
    await assert.rejects(verifyRuntimeDiagnosticInput(f.input, f.source), /unsafe relative file path/);
  } finally { await f.cleanup(); }
});
test("actual main CLI refuses unknown args and missing diagnostic bindings before isolation or Docker effects", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stage13-main-guard-"));
  try {
    const base = path.join(root, "isolation-base"); await fs.mkdir(base);
    const inputFile = path.join(root, "input.json"); await fs.writeFile(inputFile, JSON.stringify({ temporaryBase: base }));
    for (const [args, input, expected] of [
      [["--skip-quality"], path.join(root, "does-not-exist.json"), /Unknown Stage13 arguments/],
      [["--runtime-diagnostic"], undefined, /requires an explicit bound input card/],
      [["--runtime-diagnostic"], inputFile, /card binding is required/],
    ]) {
      const env = { ...process.env, VAULT_STAGE13_TEMP_BASE: base, NODE_OPTIONS: "--max-old-space-size=512" };
      delete env.VAULT_STAGE13_INPUT; if (input) env.VAULT_STAGE13_INPUT = input;
      const result = spawnSync(process.execPath, [path.join(sourceRoot, "scripts/verify-stage-13.mjs"), ...args], { env, encoding: "utf8", windowsHide: true });
      assert.equal(result.status, 1); assert.match(result.stderr, expected);
      assert.equal(result.stdout.includes("private evidence root"), false);
      assert.deepEqual(await fs.readdir(base), []);
    }
  } finally { await fs.rm(root, { recursive: true }); }
});
