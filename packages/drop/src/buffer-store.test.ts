import { requireTestValue } from "../../contracts/src/test-support.js";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { DropBufferStore } from "./buffer-store.js";

const directories: string[] = [];

afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "saturn-drop-buffer-"));
  directories.push(root);
  const store = new DropBufferStore({ root, maxBytes: 1_000, minFreeBytes: 0, warningRatio: 0.7, criticalRatio: 0.85, refusalRatio: 0.92 });
  await store.initialize();
  return store;
}

describe("DropBufferStore", () => {
  it("writes exact-offset chunks and verifies their SHA-256 digest", async () => {
    const store = await fixture();
    const relative = store.relativePath("00000000-0000-7000-8000-000000000099");
    await store.create(relative);
    expect(await store.append(relative, 0, 5, Readable.from([Buffer.from("hello")]))).toBe(5);
    expect(await store.append(relative, 5, 7, Readable.from([Buffer.from(" saturn")]))).toBe(7);
    await expect(store.digest(relative)).resolves.toEqual({ bytes: 12, sha256: "77ed55cbc161c6fad6942347447f9055e80b8676d87ff18a2d1596491281c966" });
  });

  it("refuses reservations at the configured high watermark", async () => {
    const store = await fixture();
    expect((await store.capacity(919, 1)).state).toBe("refusing");
    expect((await store.capacity(699, 1)).state).toBe("warning");
  });

  it("rejects paths outside the UUID staging namespace", async () => {
    const store = await fixture();
    await expect(store.create("../outside.part")).rejects.toThrow(/path is invalid/);
  });

  it("reopens only the original empty reservation without truncating received data", async () => {
    const store=await fixture(),relative=store.relativePath("00000000-0000-7000-8000-000000000098");
    await store.createReserved(relative);await store.createReserved(relative);
    await store.append(relative,0,4,Readable.from([Buffer.from("kept")]));
    await expect(store.createReserved(relative)).rejects.toThrow("retain it");
    await expect(store.digest(relative)).resolves.toMatchObject({bytes:4});
  });

  it("refuses linked reservation paths without following or changing their targets", async () => {
    const store=await fixture(),root=requireTestValue(directories.at(-1)),hard=store.relativePath("00000000-0000-7000-8000-000000000097"),symbolic=store.relativePath("00000000-0000-7000-8000-000000000096");
    const target=path.join(root,"retained-empty-file"),directory=path.join(root,"retained-directory");
    await writeFile(target,"");await link(target,path.join(root,hard));await mkdir(directory);await symlink(directory,path.join(root,symbolic),"junction");
    await expect(store.createReserved(hard)).rejects.toThrow("private file");await expect(store.createReserved(symbolic)).rejects.toThrow("private file");
  });
});
