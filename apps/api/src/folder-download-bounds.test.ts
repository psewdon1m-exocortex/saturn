import { fixtureValue } from './test-values.fixture.js';
import { PassThrough, Readable } from "node:stream";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { FileController } from "./file.controller.js";

it("bounds physical ZIP source opens to the active and following member", async () => {
  const now = new Date(), bytes = Buffer.alloc(64 * 1024, 23), sha256 = createHash("sha256").update(bytes).digest("hex");
  const root = { id: "root", name: "tree", type: "folder", status: "active", storagePath: "fixture/tree", updatedAt: now };
  const children = Array.from({ length: 32 }, (_, index) => ({ id: String(index), name: `${String(index)}.bin`, parentId: "root", type: "file", status: "active", storagePath: `fixture/tree/${String(index)}.bin`, sizeBytes: bytes.length, sha256, updatedAt: now }));
  let active = 0, peak = 0, opened = 0;
  const files = { getResource: vi.fn(async () => root), listChildren: vi.fn(async () => children),
    openDownload: vi.fn(async (id: string, select?: (value: unknown) => unknown) => {
      const resource = fixtureValue(children.find(r => r.id === id)); select?.(resource); active++; opened++; peak = Math.max(peak, active);
      const stream = Readable.from((async function* () { try { await new Promise<void>(resolve => setImmediate(resolve)); yield bytes; } finally { active--; } })());
      return { resource, stream };
    }) };
  let output: Readable | undefined;
  const reply = { raw: new PassThrough(), header: vi.fn().mockReturnThis(), send: vi.fn((stream: Readable) => { output = stream; }) };
  const controller = new FileController(files as never, { share: { packageMaxFiles: 5000, packageMaxBytes: 1024 ** 3 } } as never, { trackDownload: (stream: Readable) => stream } as never);
  await controller.downloadFolder("root", {} as never, reply as never);
  let size = 0; for await (const chunk of fixtureValue(output)) size += (chunk as Buffer).length;
  expect(size).toBeGreaterThan(0); expect(opened).toBe(32); expect(active).toBe(0);
  expect(peak).toBeLessThanOrEqual(2);
});
