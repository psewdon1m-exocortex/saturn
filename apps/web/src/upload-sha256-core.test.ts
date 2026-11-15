import { requiredValue } from "./test-value.js";
import { createHash } from "node:crypto";
import { Blob as NodeBlob } from "node:buffer";
import { describe, expect, it } from "vitest";
import { createBlobSha256, UPLOAD_HASH_CHUNK_BYTES } from "./upload-sha256-core.js";

const blob = (bytes: Uint8Array) => new NodeBlob([new Uint8Array(bytes)]) as unknown as Blob;
describe("bounded full-source upload SHA256", () => {
  it("matches independent Node SHA256 for empty and multi-chunk boundary/tail data", async () => {
    const hash = await createBlobSha256();
    for (const size of [0, 1, 255, 256 * 1024 - 1, 256 * 1024, 256 * 1024 + 1, UPLOAD_HASH_CHUNK_BYTES - 1, UPLOAD_HASH_CHUNK_BYTES, UPLOAD_HASH_CHUNK_BYTES + 1, 2 * UPLOAD_HASH_CHUNK_BYTES + 7]) {
      const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 31 + (i >>> 12)) & 255);
      expect(await hash(blob(bytes))).toBe(createHash("sha256").update(bytes).digest("hex"));
      if (size) { bytes[size - 1] = requiredValue(bytes[size - 1]) ^ 1; expect(await hash(blob(bytes))).toBe(createHash("sha256").update(bytes).digest("hex")); }
    }
  });
  it("does not read past cancellation and reinitializes the independent state", async () => {
    const hash = await createBlobSha256(), controller = new AbortController();
    let reads = 0, peak = 0;
    const source = { size: 3 * UPLOAD_HASH_CHUNK_BYTES, slice(start: number, end: number) { reads++; peak = Math.max(peak, end - start); return blob(new Uint8Array(end - start)); } } as Blob;
    await expect(hash(source, { signal: controller.signal, onProgress: () => controller.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(reads).toBe(1); expect(peak).toBeLessThanOrEqual(UPLOAD_HASH_CHUNK_BYTES);
    expect(await hash(blob(new TextEncoder().encode("abc")))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
