import fs from "node:fs/promises";

const reportPath = process.env.VAULT_STORAGE_REPORT;
if (!reportPath) throw new Error("VAULT_STORAGE_REPORT is required");

const raw = await fs.readFile(reportPath, "utf8");
const report = JSON.parse(raw);
const minimumPayloadBytes = 20 * 1024 * 1024 * 1024;
const requiredTests = [
  "connect-and-host-verification",
  "storage-capacity",
  "namespace-create",
  "stream-upload",
  "stream-download-and-checksum",
  "range-read",
  "offset-write",
  "upload-interrupt-and-reconnect",
  "rename",
  "safe-connection-pool",
];

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

requireCondition(report.schema === "vault.storage-qualification.v1", "Unexpected report schema");
requireCondition(report.success === true, "Qualification did not succeed");
requireCondition(report.cleanup?.attempted === true, "Cleanup was not attempted");
requireCondition(report.cleanup?.complete === true, "Cleanup did not complete");
requireCondition(
  Number.isSafeInteger(report.metrics?.payloadBytes)
    && report.metrics.payloadBytes >= minimumPayloadBytes,
  `Qualification payload must be at least ${minimumPayloadBytes} bytes`,
);
requireCondition(
  Number.isFinite(report.metrics?.maximumRssBytes)
    && report.metrics.maximumRssBytes < 512 * 1024 * 1024,
  "Peak process RSS must stay below the 512 MiB qualification ceiling",
);

const testMap = new Map(report.tests.map((entry) => [entry.name, entry]));
for (const name of requiredTests) {
  requireCondition(testMap.get(name)?.status === "pass", `Required test did not pass: ${name}`);
}

const upload = testMap.get("stream-upload").detail;
const download = testMap.get("stream-download-and-checksum").detail;
requireCondition(upload.bytes === report.metrics.payloadBytes, "Upload byte count differs from payload");
requireCondition(download.bytes === report.metrics.payloadBytes, "Download byte count differs from payload");
requireCondition(upload.sha256 === download.sha256, "Upload and download SHA-256 differ");
requireCondition(
  upload.maximumBufferedBytes <= 8 * 1024 * 1024,
  "Upload exceeded the 8 MiB per-connection logical buffer limit",
);

const forbiddenKey = /password|passphrase|private.?key|credential.?file/i;
function assertNoSecretKeys(value, currentPath = "report") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    requireCondition(!forbiddenKey.test(key), `Forbidden secret-bearing key in report: ${currentPath}.${key}`);
    assertNoSecretKeys(child, `${currentPath}.${key}`);
  }
}
assertNoSecretKeys(report);

process.stdout.write(
  `${JSON.stringify({
    result: "PASS",
    report: reportPath,
    payloadBytes: report.metrics.payloadBytes,
    uploadMebibytesPerSecond: report.metrics.uploadMebibytesPerSecond,
    downloadMebibytesPerSecond: report.metrics.downloadMebibytesPerSecond,
    maximumRssBytes: report.metrics.maximumRssBytes,
    tests: requiredTests.length,
    cleanup: report.cleanup.complete,
  })}\n`,
);
