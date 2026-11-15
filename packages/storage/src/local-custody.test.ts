import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { inspectLocalCustody, LocalCustodyStorageAdapter } from "./local-custody.js";

const fixtures: string[] = [];
afterEach(async () => { for (const root of fixtures.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "saturn-local-custody-")); fixtures.push(directory);
  const root = path.join(directory, "backend"), custodyFile = path.join(directory, "custody.json");
  await fs.mkdir(root, { mode: 0o700 });
  const proof = await inspectLocalCustody(root, "local-" + randomUUID(), randomUUID());
  await fs.writeFile(custodyFile, JSON.stringify(proof), { flag: "wx", mode: 0o600 });
  const adapter = new LocalCustodyStorageAdapter({ backend: "local", root, custodyFile });
  return { directory, root, custodyFile, proof, adapter };
}

describe("operator-pinned local storage custody", () => {
  it("writes durably and independently reads the saved bytes under the pinned root", async () => {
    const f = await fixture(), bytes = Buffer.from("independent physical readback");
    await f.adapter.write("file", Readable.from([bytes]), { offset: 0, create: true, exclusive: true });
    const hash = createHash("sha256");
    for await (const chunk of await f.adapter.openRead("file")) { expect(Buffer.isBuffer(chunk)).toBe(true); hash.update(chunk as Buffer); }
    expect(hash.digest("hex")).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect((await f.adapter.custody()).receipt).toEqual(f.proof);
    expect(await f.adapter.supportsVerify()).toBe(false);
  });
  it("refuses a replacement root at the same path after startup", async () => {
    const f = await fixture(); await f.adapter.custody();
    await fs.rename(f.root, path.join(f.directory, "old-backend")); await fs.mkdir(f.root);
    await expect(f.adapter.write("file", Readable.from(["x"]), { offset: 0, create: true })).rejects.toThrow("custody_invalid");
    expect(await fs.readdir(f.root)).toEqual([]);
  });
  it("refuses the changed final custody field even when its JSON remains valid", async () => {
    const f = await fixture(); await f.adapter.custody();
    await fs.writeFile(f.custodyFile, JSON.stringify({ ...f.proof, birthtimeNs: "1" }));
    await expect(f.adapter.statFs()).rejects.toThrow("custody_invalid");
  });
  it("rejects a directory link inside the backend before touching outside bytes", async () => {
    const f = await fixture(), outside = path.join(f.directory, "outside"); await fs.mkdir(outside);
    await fs.symlink(outside, path.join(f.root, "escape"), process.platform === "win32" ? "junction" : "dir");
    await expect(f.adapter.write("escape/file", Readable.from(["x"]), { offset: 0, create: true })).rejects.toThrow("custody_invalid");
    expect(await fs.readdir(outside)).toEqual([]);
  });
  it("requires an absolute dedicated root and custody outside its writable tree", () => {
    expect(() => new LocalCustodyStorageAdapter({ backend: "local", root: ".", custodyFile: path.resolve("custody") })).toThrow();
    const root = path.resolve("backend");
    expect(() => new LocalCustodyStorageAdapter({ backend: "local", root, custodyFile: path.join(root, "custody") })).toThrow();
  });
});
