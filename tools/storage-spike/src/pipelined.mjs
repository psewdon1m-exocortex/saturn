import { createHash } from "node:crypto";
import { deterministicBuffer } from "./data.mjs";
import { callSftp } from "./ssh.mjs";

function callbackWithTimeout(label, timeoutMs, register) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new Error(`${label} timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
    try {
      register(finish);
    } catch (error) {
      finish(error);
    }
  });
}

function writeAt(sftp, handle, buffer, position, timeoutMs) {
  return callbackWithTimeout(`SFTP write at ${position}`, timeoutMs, (finish) => {
    sftp.write(handle, buffer, 0, buffer.length, position, (error) => finish(error));
  });
}

function readAt(sftp, handle, length, position, timeoutMs) {
  return callbackWithTimeout(`SFTP read at ${position}`, timeoutMs, (finish) => {
    const target = Buffer.allocUnsafe(length);
    sftp.read(handle, target, 0, length, position, (error, bytesRead, returned) => {
      if (error) {
        finish(error);
        return;
      }
      if (bytesRead <= 0) {
        finish(new Error(`Unexpected EOF at position ${position}`));
        return;
      }
      finish(undefined, returned.subarray(0, bytesRead));
    });
  });
}

export async function uploadDeterministicPipelined({
  sftp,
  remotePath,
  totalBytes,
  requestBytes,
  concurrency,
  startOffset = 0,
  create = true,
  onProgress,
  operationTimeoutMs = 60_000,
}) {
  const flags = create ? "wx" : "r+";
  const handle = await callSftp(sftp, "open", remotePath, flags, { mode: 0o600 });
  const hash = createHash("sha256");
  let position = startOffset;
  let maximumOutstanding = 0;
  try {
    while (position < startOffset + totalBytes) {
      const window = [];
      while (window.length < concurrency && position < startOffset + totalBytes) {
        const length = Math.min(requestBytes, startOffset + totalBytes - position);
        const data = deterministicBuffer(length, position);
        hash.update(data);
        window.push(writeAt(sftp, handle, data, position, operationTimeoutMs));
        position += length;
      }
      maximumOutstanding = Math.max(maximumOutstanding, window.length);
      await Promise.all(window);
      onProgress?.({ transferredBytes: position - startOffset, totalBytes });
    }
  } finally {
    await callSftp(sftp, "close", handle);
  }
  return {
    bytes: totalBytes,
    sha256: hash.digest("hex"),
    maximumOutstanding,
    maximumBufferedBytes: maximumOutstanding * requestBytes,
  };
}

export async function hashRemoteFilePipelined({
  sftp,
  remotePath,
  requestBytes,
  concurrency,
  operationTimeoutMs = 60_000,
}) {
  const attributes = await callSftp(sftp, "stat", remotePath);
  const handle = await callSftp(sftp, "open", remotePath, "r");
  const hash = createHash("sha256");
  let position = 0;
  let maximumOutstanding = 0;
  try {
    while (position < attributes.size) {
      const window = [];
      while (window.length < concurrency && position < attributes.size) {
        const requestPosition = position;
        const length = Math.min(requestBytes, attributes.size - requestPosition);
        window.push(readAt(sftp, handle, length, requestPosition, operationTimeoutMs));
        position += length;
      }
      maximumOutstanding = Math.max(maximumOutstanding, window.length);
      const chunks = await Promise.all(window);
      for (const chunk of chunks) hash.update(chunk);
    }
  } finally {
    await callSftp(sftp, "close", handle);
  }
  return {
    bytes: attributes.size,
    sha256: hash.digest("hex"),
    maximumOutstanding,
    maximumBufferedBytes: maximumOutstanding * requestBytes,
  };
}

export async function uploadDeterministicStriped({
  sftps,
  remotePath,
  totalBytes,
  requestBytes,
  concurrencyPerLane,
  operationTimeoutMs = 60_000,
}) {
  const createHandle = await callSftp(sftps[0], "open", remotePath, "wx", { mode: 0o600 });
  await callSftp(sftps[0], "close", createHandle);
  const handles = await Promise.all(sftps.map((sftp) => callSftp(sftp, "open", remotePath, "r+")));
  const hash = createHash("sha256");
  let position = 0;
  let maximumOutstanding = 0;
  try {
    while (position < totalBytes) {
      const window = [];
      const windowLimit = sftps.length * concurrencyPerLane;
      while (window.length < windowLimit && position < totalBytes) {
        const requestIndex = window.length;
        const lane = requestIndex % sftps.length;
        const length = Math.min(requestBytes, totalBytes - position);
        const data = deterministicBuffer(length, position);
        hash.update(data);
        window.push(writeAt(
          sftps[lane],
          handles[lane],
          data,
          position,
          operationTimeoutMs,
        ));
        position += length;
      }
      maximumOutstanding = Math.max(maximumOutstanding, window.length);
      await Promise.all(window);
    }
  } finally {
    await Promise.all(handles.map((handle, index) => callSftp(sftps[index], "close", handle)));
  }
  return {
    bytes: totalBytes,
    sha256: hash.digest("hex"),
    lanes: sftps.length,
    maximumOutstanding,
    maximumBufferedBytes: maximumOutstanding * requestBytes,
  };
}

export async function hashRemoteFileStriped({
  sftps,
  remotePath,
  requestBytes,
  concurrencyPerLane,
  onProgress,
  operationTimeoutMs = 60_000,
}) {
  const attributes = await callSftp(sftps[0], "stat", remotePath);
  const handles = await Promise.all(sftps.map((sftp) => callSftp(sftp, "open", remotePath, "r")));
  const hash = createHash("sha256");
  let position = 0;
  let maximumOutstanding = 0;
  try {
    while (position < attributes.size) {
      const window = [];
      const windowLimit = sftps.length * concurrencyPerLane;
      while (window.length < windowLimit && position < attributes.size) {
        const requestIndex = window.length;
        const lane = requestIndex % sftps.length;
        const requestPosition = position;
        const length = Math.min(requestBytes, attributes.size - requestPosition);
        window.push(readAt(
          sftps[lane],
          handles[lane],
          length,
          requestPosition,
          operationTimeoutMs,
        ));
        position += length;
      }
      maximumOutstanding = Math.max(maximumOutstanding, window.length);
      const chunks = await Promise.all(window);
      for (const chunk of chunks) hash.update(chunk);
      onProgress?.({ transferredBytes: position, totalBytes: attributes.size });
    }
  } finally {
    await Promise.all(handles.map((handle, index) => callSftp(sftps[index], "close", handle)));
  }
  return {
    bytes: attributes.size,
    sha256: hash.digest("hex"),
    lanes: sftps.length,
    maximumOutstanding,
    maximumBufferedBytes: maximumOutstanding * requestBytes,
  };
}

export async function readRemoteRangeStriped({
  sftps,
  remotePath,
  startOffset,
  totalBytes,
  requestBytes,
  concurrencyPerLane,
  onChunk,
  onProgress,
  operationTimeoutMs = 60_000,
}) {
  const handles = await Promise.all(sftps.map((sftp) => callSftp(sftp, "open", remotePath, "r")));
  const endOffset = startOffset + totalBytes;
  let position = startOffset;
  let maximumOutstanding = 0;
  try {
    while (position < endOffset) {
      const window = [];
      const windowLimit = sftps.length * concurrencyPerLane;
      while (window.length < windowLimit && position < endOffset) {
        const requestIndex = window.length;
        const lane = requestIndex % sftps.length;
        const requestPosition = position;
        const length = Math.min(requestBytes, endOffset - requestPosition);
        window.push(readAt(
          sftps[lane],
          handles[lane],
          length,
          requestPosition,
          operationTimeoutMs,
        ));
        position += length;
      }
      maximumOutstanding = Math.max(maximumOutstanding, window.length);
      const chunks = await Promise.all(window);
      for (const chunk of chunks) onChunk(chunk);
      onProgress?.({
        transferredBytes: position - startOffset,
        totalBytes,
      });
    }
  } finally {
    await Promise.allSettled(
      handles.map((handle, index) => callSftp(sftps[index], "close", handle)),
    );
  }
  return {
    bytes: totalBytes,
    lanes: sftps.length,
    maximumOutstanding,
    maximumBufferedBytes: maximumOutstanding * requestBytes,
  };
}
