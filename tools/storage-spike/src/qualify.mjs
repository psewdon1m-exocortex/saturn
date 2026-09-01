import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, publicConfig } from "./config.mjs";
import {
  collectBounded,
  deterministicBuffer,
} from "./data.mjs";
import {
  hashRemoteFilePipelined,
  readRemoteRangeStriped,
  uploadDeterministicPipelined,
} from "./pipelined.mjs";
import { callSftp, connectSftp } from "./ssh.mjs";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const configPath = process.env.VAULT_STORAGE_CONFIG;
const passwordFile = process.env.VAULT_STORAGE_PASSWORD_FILE;
const outputPath = path.resolve(
  process.env.VAULT_STORAGE_REPORT
    ?? path.join(sourceRoot, "artifacts/verification/stage-01-storage-qualification.json"),
);

const config = await loadConfig({ configPath, passwordFile });
const runId = randomUUID();
const namespaceName = `.vault-qualification-${runId}`;
const root = config.root === "." ? "" : config.root.replace(/^\/+|\/+$/g, "");
const namespace = root ? `${root}/${namespaceName}` : namespaceName;
const paths = {
  namespace,
  stream: `${namespace}/stream.bin`,
  resumed: `${namespace}/resumed.bin`,
  offset: `${namespace}/offset.bin`,
  renamed: `${namespace}/renamed.bin`,
};

const report = {
  schema: "vault.storage-qualification.v1",
  runId,
  startedAt: new Date().toISOString(),
  completedAt: null,
  success: false,
  config: publicConfig(config),
  tests: [],
  metrics: {},
  cleanup: { attempted: false, complete: false },
};

let connection;
let transferConnections = [];
let maximumRss = process.memoryUsage().rss;
const memorySampler = setInterval(() => {
  maximumRss = Math.max(maximumRss, process.memoryUsage().rss);
}, 100);
memorySampler.unref();

async function record(name, action) {
  const started = performance.now();
  try {
    const detail = await action();
    report.tests.push({ name, status: "pass", durationMs: Math.round(performance.now() - started), detail });
    process.stdout.write(`PASS ${name}\n`);
    return detail;
  } catch (error) {
    report.tests.push({
      name,
      status: "fail",
      durationMs: Math.round(performance.now() - started),
      error: { name: error.name, message: String(error.message).slice(0, 500) },
    });
    throw error;
  }
}

async function closeConnection() {
  if (!connection) return;
  const current = connection;
  connection = undefined;
  await current.close();
}

async function openConnection() {
  connection = await connectSftp(config);
  return connection;
}

async function openTransferConnections() {
  transferConnections = [];
  try {
    for (let lane = 0; lane < config.transferLanes; lane += 1) {
      transferConnections.push(await connectSftp(config));
    }
  } catch (error) {
    await closeTransferConnections();
    throw error;
  }
  return transferConnections;
}

async function closeTransferConnections() {
  const additional = transferConnections;
  transferConnections = [];
  await Promise.allSettled(additional.map((item) => item.close()));
}

async function hashRemoteFile(remotePath) {
  return hashRemoteFilePipelined({
    sftp: connection.sftp,
    remotePath,
    requestBytes: config.requestBytes,
    concurrency: config.requestConcurrency,
    operationTimeoutMs: config.operationTimeoutMs,
  });
}

function progressPrinter(name, totalBytes) {
  if (totalBytes < 1024 * 1024 * 1024) return undefined;
  const stepPercent = totalBytes >= 20 * 1024 * 1024 * 1024 ? 2 : 5;
  let nextPercent = stepPercent;
  return ({ transferredBytes }) => {
    const percent = Math.floor((transferredBytes / totalBytes) * 100);
    if (percent < nextPercent) return;
    process.stdout.write(`PROGRESS ${name} ${Math.min(percent, 100)}%\n`);
    nextPercent += stepPercent;
  };
}

function numericStat(value, field) {
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`StatFS field ${field} exceeds JavaScript safe integer range`);
    }
    return Number(value);
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`StatFS field ${field} is not a non-negative safe integer`);
  }
  return value;
}

async function cleanup() {
  report.cleanup.attempted = true;
  try {
    if (!connection) await openConnection();
    for (const remotePath of Object.values(paths).filter((value) => value !== namespace)) {
      try {
        await callSftp(connection.sftp, "unlink", remotePath);
      } catch (error) {
        if (error.code !== 2) throw error;
      }
    }
    try {
      await callSftp(connection.sftp, "rmdir", namespace);
    } catch (error) {
      if (error.code !== 2) throw error;
    }
    try {
      await callSftp(connection.sftp, "stat", namespace);
      throw new Error("Qualification namespace still exists after cleanup");
    } catch (error) {
      if (error.message === "Qualification namespace still exists after cleanup") throw error;
      if (error.code !== 2) throw error;
    }
    report.cleanup.complete = true;
  } catch (error) {
    report.cleanup.error = { name: error.name, message: String(error.message).slice(0, 500) };
  }
}

try {
  await record("connect-and-host-verification", async () => {
    await openConnection();
    const resolvedRoot = await callSftp(connection.sftp, "realpath", config.root);
    return { resolvedRoot };
  });

  await record("storage-capacity", async () => {
    const info = await callSftp(connection.sftp, "ext_openssh_statvfs", config.root);
    const fragmentBytes = numericStat(info.f_frsize || info.f_bsize, "f_frsize");
    const availableBlocks = numericStat(info.f_bavail, "f_bavail");
    const totalBlocks = numericStat(info.f_blocks, "f_blocks");
    const availableBytes = fragmentBytes * availableBlocks;
    const totalBytes = fragmentBytes * totalBlocks;
    const reserveBytes = 512 * 1024 * 1024;
    const requiredBytes = config.qualificationBytes + reserveBytes;
    if (!Number.isSafeInteger(availableBytes) || !Number.isSafeInteger(totalBytes)) {
      throw new Error("StatFS byte totals exceed JavaScript safe integer range");
    }
    if (availableBytes < requiredBytes) {
      throw new Error(
        `Insufficient storage capacity: ${availableBytes} bytes available, ${requiredBytes} required`,
      );
    }
    return {
      availableBytes,
      totalBytes,
      requiredBytes,
      reserveBytes,
    };
  });

  await record("namespace-create", async () => {
    await callSftp(connection.sftp, "mkdir", namespace, { mode: 0o700 });
    const attributes = await callSftp(connection.sftp, "stat", namespace);
    if (!attributes.isDirectory()) throw new Error("Qualification namespace is not a directory");
    return { created: true };
  });

  const uploadResult = await record("stream-upload", async () => {
    const started = performance.now();
    const upload = await uploadDeterministicPipelined({
      sftp: connection.sftp,
      remotePath: paths.stream,
      totalBytes: config.qualificationBytes,
      requestBytes: config.requestBytes,
      concurrency: config.requestConcurrency,
      onProgress: progressPrinter("stream-upload", config.qualificationBytes),
      operationTimeoutMs: config.operationTimeoutMs,
    });
    const durationSeconds = (performance.now() - started) / 1000;
    const attributes = await callSftp(connection.sftp, "stat", paths.stream);
    if (attributes.size !== config.qualificationBytes) {
      throw new Error(`Remote size ${attributes.size} differs from ${config.qualificationBytes}`);
    }
    return {
      bytes: attributes.size,
      sha256: upload.sha256,
      maximumOutstanding: upload.maximumOutstanding,
      maximumBufferedBytes: upload.maximumBufferedBytes,
      seconds: durationSeconds,
      mebibytesPerSecond: attributes.size / 1024 / 1024 / durationSeconds,
    };
  });

  const downloadResult = await record("stream-download-and-checksum", async () => {
    const started = performance.now();
    const expectedSize = (await callSftp(connection.sftp, "stat", paths.stream)).size;
    let hash = createHash("sha256");
    const printProgress = progressPrinter("stream-download", expectedSize);
    let transferredBytes = 0;
    let maximumOutstanding = 0;
    let maximumBufferedBytes = 0;
    let reconnectRetries = 0;
    let segments = 0;
    while (transferredBytes < expectedSize) {
      const segmentBytes = Math.min(
        config.downloadSegmentBytes,
        expectedSize - transferredBytes,
      );
      let segmentComplete = false;
      let lastError;
      for (let attempt = 0; attempt < 3 && !segmentComplete; attempt += 1) {
        const attemptHash = hash.copy();
        try {
          await openTransferConnections();
          const result = await readRemoteRangeStriped({
            sftps: transferConnections.map((item) => item.sftp),
            remotePath: paths.stream,
            startOffset: transferredBytes,
            totalBytes: segmentBytes,
            requestBytes: config.requestBytes,
            concurrencyPerLane: config.laneRequestConcurrency,
            onChunk: (chunk) => attemptHash.update(chunk),
            operationTimeoutMs: config.operationTimeoutMs,
          });
          maximumOutstanding = Math.max(maximumOutstanding, result.maximumOutstanding);
          maximumBufferedBytes = Math.max(maximumBufferedBytes, result.maximumBufferedBytes);
          hash = attemptHash;
          segmentComplete = true;
        } catch (error) {
          lastError = error;
          reconnectRetries += 1;
          process.stdout.write(
            `RETRY stream-download segment=${segments + 1} attempt=${attempt + 1}\n`,
          );
          if (attempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
          }
        } finally {
          await closeTransferConnections();
        }
      }
      if (!segmentComplete) throw lastError;
      transferredBytes += segmentBytes;
      segments += 1;
      printProgress?.({ transferredBytes, totalBytes: expectedSize });
    }
    const result = {
      bytes: transferredBytes,
      sha256: hash.digest("hex"),
      lanes: config.transferLanes,
      segments,
      reconnectRetries,
      maximumOutstanding,
      maximumBufferedBytes,
    };
    const durationSeconds = (performance.now() - started) / 1000;
    if (result.sha256 !== uploadResult.sha256) throw new Error("Round-trip SHA-256 mismatch");
    return {
      ...result,
      seconds: durationSeconds,
      mebibytesPerSecond: result.bytes / 1024 / 1024 / durationSeconds,
    };
  });
  await closeTransferConnections();

  await record("range-read", async () => {
    const start = Math.floor(config.qualificationBytes / 3);
    const length = Math.min(4096, config.qualificationBytes - start);
    const actual = await collectBounded(
      connection.sftp.createReadStream(paths.stream, { start, end: start + length - 1 }),
      length,
    );
    const expected = deterministicBuffer(length, start);
    if (!actual.equals(expected)) throw new Error("Range bytes differ from deterministic source");
    return { start, end: start + length - 1, bytes: actual.length };
  });

  await record("offset-write", async () => {
    const original = deterministicBuffer(1024 * 1024);
    await callSftp(connection.sftp, "writeFile", paths.offset, original, { mode: 0o600, flag: "wx" });
    const patch = randomBytes(4096);
    const position = 257 * 1024;
    const handle = await callSftp(connection.sftp, "open", paths.offset, "r+");
    try {
      await callSftp(connection.sftp, "write", handle, patch, 0, patch.length, position);
    } finally {
      await callSftp(connection.sftp, "close", handle);
    }
    const actual = await collectBounded(
      connection.sftp.createReadStream(paths.offset, { start: position, end: position + patch.length - 1 }),
      patch.length,
    );
    if (!actual.equals(patch)) throw new Error("Offset rewrite did not persist expected bytes");
    return { position, bytes: patch.length };
  });

  const resumeBytes = Math.min(config.qualificationBytes, 16 * 1024 * 1024);
  const resumeOffset = Math.floor(resumeBytes / 2);
  const resumeHash = createHash("sha256");
  resumeHash.update(deterministicBuffer(resumeOffset));
  resumeHash.update(deterministicBuffer(resumeBytes - resumeOffset, resumeOffset));
  const expectedResumeHash = resumeHash.digest("hex");

  await record("upload-interrupt-and-reconnect", async () => {
    await uploadDeterministicPipelined({
      sftp: connection.sftp,
      remotePath: paths.resumed,
      totalBytes: resumeOffset,
      requestBytes: config.requestBytes,
      concurrency: config.requestConcurrency,
      operationTimeoutMs: config.operationTimeoutMs,
    });
    await closeConnection();
    await openConnection();
    const partial = await callSftp(connection.sftp, "stat", paths.resumed);
    if (partial.size !== resumeOffset) throw new Error("Partial upload size changed after reconnect");
    await uploadDeterministicPipelined({
      sftp: connection.sftp,
      remotePath: paths.resumed,
      totalBytes: resumeBytes - resumeOffset,
      requestBytes: config.requestBytes,
      concurrency: config.requestConcurrency,
      startOffset: resumeOffset,
      create: false,
      operationTimeoutMs: config.operationTimeoutMs,
    });
    const final = await hashRemoteFile(paths.resumed);
    if (final.bytes !== resumeBytes || final.sha256 !== expectedResumeHash) {
      throw new Error("Resumed upload differs from deterministic source");
    }
    return { resumeOffset, finalBytes: final.bytes, sha256: final.sha256 };
  });

  await record("rename", async () => {
    await callSftp(connection.sftp, "rename", paths.offset, paths.renamed);
    const attributes = await callSftp(connection.sftp, "stat", paths.renamed);
    return { bytes: attributes.size };
  });

  await record("safe-connection-pool", async () => {
    const clients = await Promise.all(Array.from({ length: config.safeConnectionPool }, () => connectSftp(config)));
    try {
      const roots = await Promise.all(clients.map((item) => callSftp(item.sftp, "realpath", config.root)));
      return { connections: clients.length, roots: [...new Set(roots)] };
    } finally {
      await Promise.all(clients.map((item) => item.close()));
    }
  });

  report.metrics = {
    uploadMebibytesPerSecond: uploadResult.mebibytesPerSecond,
    downloadMebibytesPerSecond: downloadResult.mebibytesPerSecond,
    maximumRssBytes: maximumRss,
    payloadBytes: config.qualificationBytes,
  };
  report.success = true;
} catch (error) {
  report.failure = { name: error.name, message: String(error.message).slice(0, 500) };
  process.exitCode = 1;
} finally {
  clearInterval(memorySampler);
  await cleanup();
  await closeTransferConnections();
  await closeConnection();
  report.metrics.maximumRssBytes = maximumRss;
  report.completedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`REPORT ${outputPath}\n`);
  process.stdout.write(`RESULT ${report.success && report.cleanup.complete ? "PASS" : "FAIL"}\n`);
}
