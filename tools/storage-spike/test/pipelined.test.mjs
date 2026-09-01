import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { deterministicBuffer } from "../src/data.mjs";
import {
  hashRemoteFilePipelined,
  hashRemoteFileStriped,
  readRemoteRangeStriped,
  uploadDeterministicPipelined,
  uploadDeterministicStriped,
} from "../src/pipelined.mjs";

class FakeSftp {
  constructor(size, sharedData) {
    this.data = sharedData ?? Buffer.alloc(size);
    this.active = 0;
    this.maximumActive = 0;
  }

  open(_path, _flags, attrs, callback) {
    const cb = typeof attrs === "function" ? attrs : callback;
    queueMicrotask(() => cb(null, Buffer.from("handle")));
  }

  close(_handle, callback) {
    queueMicrotask(() => callback(null));
  }

  stat(_path, callback) {
    queueMicrotask(() => callback(null, { size: this.data.length }));
  }

  write(_handle, source, offset, length, position, callback) {
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    setTimeout(() => {
      source.copy(this.data, position, offset, offset + length);
      this.active -= 1;
      callback(null);
    }, position % 3);
  }

  read(_handle, target, offset, length, position, callback) {
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    setTimeout(() => {
      this.data.copy(target, offset, position, position + length);
      this.active -= 1;
      callback(null, length, target, position);
    }, (position + 1) % 3);
  }
}

test("pipelined upload and download preserve order with bounded concurrency", async () => {
  const totalBytes = 512 * 1024;
  const fake = new FakeSftp(totalBytes);
  const upload = await uploadDeterministicPipelined({
    sftp: fake,
    remotePath: "fixture.bin",
    totalBytes,
    requestBytes: 16 * 1024,
    concurrency: 8,
  });
  assert.deepEqual(fake.data, deterministicBuffer(totalBytes));
  assert.equal(upload.maximumOutstanding, 8);
  assert.ok(fake.maximumActive > 1);

  const download = await hashRemoteFilePipelined({
    sftp: fake,
    remotePath: "fixture.bin",
    requestBytes: 16 * 1024,
    concurrency: 8,
  });
  const expectedHash = createHash("sha256").update(fake.data).digest("hex");
  assert.equal(download.sha256, expectedHash);
  assert.equal(download.maximumBufferedBytes, 8 * 16 * 1024);
});

test("segmented striped reads preserve an exact non-zero range", async () => {
  const totalBytes = 1024 * 1024;
  const shared = deterministicBuffer(totalBytes);
  const lanes = Array.from({ length: 4 }, () => new FakeSftp(totalBytes, shared));
  const startOffset = 137 * 1024;
  const rangeBytes = 513 * 1024;
  const chunks = [];
  const result = await readRemoteRangeStriped({
    sftps: lanes,
    remotePath: "range.bin",
    startOffset,
    totalBytes: rangeBytes,
    requestBytes: 16 * 1024,
    concurrencyPerLane: 4,
    onChunk: (chunk) => chunks.push(Buffer.from(chunk)),
  });
  assert.deepEqual(
    Buffer.concat(chunks),
    shared.subarray(startOffset, startOffset + rangeBytes),
  );
  assert.equal(result.bytes, rangeBytes);
  assert.equal(result.maximumBufferedBytes, 4 * 4 * 16 * 1024);
});

test("striped transfer preserves byte order across independent SFTP lanes", async () => {
  const totalBytes = 1024 * 1024;
  const shared = Buffer.alloc(totalBytes);
  const lanes = Array.from({ length: 4 }, () => new FakeSftp(totalBytes, shared));
  const upload = await uploadDeterministicStriped({
    sftps: lanes,
    remotePath: "striped.bin",
    totalBytes,
    requestBytes: 16 * 1024,
    concurrencyPerLane: 4,
  });
  assert.deepEqual(shared, deterministicBuffer(totalBytes));
  assert.equal(upload.lanes, 4);
  assert.equal(upload.maximumOutstanding, 16);

  const download = await hashRemoteFileStriped({
    sftps: lanes,
    remotePath: "striped.bin",
    requestBytes: 16 * 1024,
    concurrencyPerLane: 4,
  });
  const expectedHash = createHash("sha256").update(shared).digest("hex");
  assert.equal(download.sha256, expectedHash);
  assert.equal(download.maximumBufferedBytes, 4 * 4 * 16 * 1024);
});
