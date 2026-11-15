import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import archiver from "archiver";
import type { Resource } from "@saturn/file-core";
import { validatePortableMemberPath } from "./runner.js";

export interface DownloadArchiveEntry { readonly resource: Resource; readonly path: string }

export function downloadTreeFingerprint(entries: readonly DownloadArchiveEntry[]): string {
  return createHash("sha256").update(JSON.stringify(entries.map(({ resource: r, path }) =>
    [r.id, r.parentId, path, r.type, r.status, r.currentVersionId, r.sha256, r.sizeBytes, r.securityClassification ?? "internal"])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]))))).digest("hex");
}

/** Open members in order so a later physical reader never waits idle behind a large member. */
export function createDownloadArchive(input: {
  readonly entries: readonly DownloadArchiveEntry[];
  readonly emptyRoot: string;
  readonly open: (entry: DownloadArchiveEntry) => Promise<Readable>;
  readonly validate: () => Promise<void>;
}): Readable {
  const names = new Set<string>();
  for (const entry of input.entries) {
    validatePortableMemberPath(entry.path);
    const key = entry.path.replace(/\/$/, "").toLocaleLowerCase("en-US");
    if (names.has(key)) throw new Error("Archive has colliding member paths");
    names.add(key);
  }
  validatePortableMemberPath(input.emptyRoot);
  const zip = archiver("zip", { zlib: { level: 6 } });
  let member: Readable | undefined;
  const sources = new Set<Readable>();
  const pending = new Map<DownloadArchiveEntry, Promise<Readable | undefined>>();
  const files = input.entries.filter(entry => entry.resource.type === "file");
  let next = 0;
  const dispose = () => { for (const source of sources) source.destroy(); member?.destroy(); };
  zip.on("error", dispose); // Also covers an error before the HTTP consumer attaches.
  zip.once("close", dispose);

  function prepare(): void {
    while (!zip.destroyed && pending.size < 1 && next < files.length) {
      const entry = files[next++];
      if (entry === undefined) throw new Error("Archive member is missing");
      pending.set(entry, input.open(entry).then(source => {
        if (zip.destroyed) { source.destroy(); return undefined; }
        sources.add(source);
        source.on("error", error => zip.destroy(error));
        return source;
      }).catch((error: unknown) => { zip.destroy(error instanceof Error ? error : new Error("Archive source open failed")); return undefined; }));
    }
  }

  async function append(value: Readable | string, name: string, date?: Date): Promise<void> {
    if (zip.destroyed) throw new Error("Archive download was cancelled");
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { zip.off("entry", complete); zip.off("error", failed); zip.off("close", closed); };
      const complete = () => { cleanup(); resolve(); };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const closed = () => failed(new Error("Archive closed before its member completed"));
      zip.once("entry", complete); zip.once("error", failed); zip.once("close", closed);
      try { zip.append(value, { name, ...(date === undefined ? {} : { date }) }); } catch (error) { cleanup(); reject(error instanceof Error ? error : new Error("Archive member append failed")); }
    });
  }

  void (async () => {
    if (input.entries.length === 0) await append("", input.emptyRoot);
    for (const entry of input.entries) {
      if (zip.destroyed) return;
      if (entry.resource.type === "folder") { await append("", entry.path, entry.resource.updatedAt); continue; }
      prepare();
      const opened = await pending.get(entry);
      const cancelled = () => zip.destroyed;
      if (opened === undefined || cancelled()) { opened?.destroy(); return; }
      member = Readable.from((async function* () {
        const hash = createHash("sha256"); let size = 0;
        try {
          for await (const chunk of opened) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
            size += bytes.length;
            if (size > entry.resource.sizeBytes) throw new Error("Archive source size changed");
            hash.update(bytes); yield bytes;
          }
          if (size !== entry.resource.sizeBytes || entry.resource.sha256 !== undefined && hash.digest("hex") !== entry.resource.sha256) throw new Error("Archive source content changed");
        } finally { opened.destroy(); }
      })());
      member.on("error", error => zip.destroy(error));
      await append(member, entry.path, entry.resource.updatedAt);
      sources.delete(opened); pending.delete(entry); member = undefined;
    }
    // A changed tree must not receive a valid ZIP central directory.
    await input.validate();
    if (!zip.destroyed) await zip.finalize();
  })().catch((error: unknown) => zip.destroy(error instanceof Error ? error : new Error("Archive download failed")));
  return zip;
}
