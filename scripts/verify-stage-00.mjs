import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const vaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const implementation = path.join(vaultRoot, "docs", "implementation");
const outputPath = path.join(vaultRoot, "artifacts", "verification", "stage-00-contracts.json");
const requiredImplementationFiles = [
  "README.md",
  "APPLICABILITY_MATRIX.md",
  "BASELINE.md",
  "ARCHITECTURE_DECISIONS.md",
  "EXPOSURE_AND_CONNECTION_MATRIX.md",
  "VERIFICATION_MATRIX.md",
  "TEST_STRATEGY.md",
];
const requiredNormativeFiles = [
  "UNIFICATION_SPECIFICATION.md",
  "PART_I_INTERFACE_AND_INTERACTION_UNIFICATION.md",
  "PART_II_OBSERVABILITY_AUDIT_AND_LOG_EXPORT.md",
  "PART_III_BACKUP_AND_RECOVERY.md",
  "PART_IV_BOOTSTRAP_AND_DEPLOYMENT.md",
  "PART_V_CI_RELEASES_AND_LOCAL_UPDATES.md",
  "PART_VI_UNIFIED_ACCEPTANCE_CHECKLIST.md",
  "PART_VII_SECURITY_AND_EXPOSURE_CONTROL.md",
  "outer connections.md",
  "SEO and GEO.md",
];

const report = { schema: "vault.stage-verification.v1", stage: 0, startedAt: new Date().toISOString(), success: false, checks: [] };
function pass(name, detail) { report.checks.push({ name, status: "pass", detail }); }

try {
  for (const name of requiredImplementationFiles) await fs.access(path.join(implementation, name));
  pass("implementation-documents", { files: requiredImplementationFiles.length });
  const normativeRoot = path.resolve(vaultRoot, "..", ".docs");
  for (const name of requiredNormativeFiles) await fs.access(path.join(normativeRoot, name));
  pass("normative-documents", { files: requiredNormativeFiles.length });
  const program = await fs.readFile(path.join(implementation, "README.md"), "utf8");
  const stages = [...program.matchAll(/^### Stage (\d+) /gm)].map((match) => Number(match[1]));
  if (JSON.stringify(stages) !== JSON.stringify([...Array(14).keys()])) throw new Error("Program must define ordered Stages 0-13");
  for (const marker of ["**Entry state**", "**Exit state**", "**Verification**", "**Rollback**"]) {
    const count = program.split(marker).length - 1;
    if (count !== 14) throw new Error(`${marker} must appear for every stage`);
  }
  pass("stage-contracts", { stages: stages.length, entryExitVerificationRollback: true });
  const ignore = await fs.readFile(path.join(vaultRoot, ".gitignore"), "utf8");
  if (!ignore.includes("docs/server_password.txt") || !ignore.includes(".secrets/")) throw new Error("Secret paths are not ignored");
  pass("secret-ignore-boundary", { protectedPatterns: 2 });
  report.success = true;
} catch (error) {
  report.failure = { name: error.name, message: error.message };
  process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ stage: 0, result: report.success ? "PASS" : "FAIL", checks: report.checks.length })}\n`);
}
