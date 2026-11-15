import { createHash } from "node:crypto";
import { type FileHandle } from "node:fs/promises";
import { StorageVerifyError, storageVerifyResult, type StorageVerifyRequest, type StorageVerifyResult } from "../../contracts/src/storage-verifier.js";
import type { RegistryAuthority } from "./authority.js";
import { openBeneath, openNoFollow, unchanged } from "./secure-files.js";

export class HostVerifier {
  private active = 0;
  private stopping = false;
  constructor(readonly authority: RegistryAuthority) {}
  stopAdmission(): void { this.stopping = true; }
  get activeRequests(): number { return this.active; }
  async verify(request: StorageVerifyRequest, signal: AbortSignal): Promise<StorageVerifyResult> {
    if (this.stopping) throw new StorageVerifyError("verifier_unavailable");
    if (this.active >= this.authority.config.maximumActive) throw new StorageVerifyError("capacity");
    if (BigInt(request.maximumBytes) > BigInt(this.authority.config.maximumBytes)) throw new StorageVerifyError("capacity");
    this.active++;
    const deadline = performance.now() + request.timeoutMs;
    const checkpoint = (): void => { if (signal.aborted || performance.now() >= deadline) throw new StorageVerifyError("cancelled"); };
    const handles: FileHandle[] = [];
    try {
      checkpoint();
      const proof = await this.authority.authorize(request);
      const root = await openNoFollow(proof.root.directory); handles.push(root);
      const rootIdentity = await root.stat({ bigint: true });
      if (!rootIdentity.isDirectory()) throw new StorageVerifyError("scope_denied");
      const opened = await openBeneath(root, request.relativePath);
      handles.push(...opened.parents, opened.file);
      const before = await opened.file.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n) throw new StorageVerifyError("scope_denied");
      if (before.size !== BigInt(request.sizeBytes) || before.size > BigInt(request.maximumBytes)) throw new StorageVerifyError("verification_failed");
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(65536);
      let offset = 0;
      while (offset < Number(before.size)) {
        checkpoint();
        const { bytesRead } = await opened.file.read(buffer, 0, Math.min(buffer.length, Number(before.size) - offset), offset);
        if (!bytesRead) throw new StorageVerifyError("source_changed");
        hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
      }
      checkpoint();
      if (hash.digest("hex") !== request.sha256) throw new StorageVerifyError("verification_failed");
      if (request.requireDurability === "file-sync") await opened.file.sync();
      checkpoint();
      if (!unchanged(before, await opened.file.stat({ bigint: true }))) throw new StorageVerifyError("source_changed");
      // Re-open the root and path as well as checking the original handle: a
      // rename/replacement cannot make verification of an old inode current.
      const currentRoot = await openNoFollow(proof.root.directory); handles.push(currentRoot);
      const rootAfter = await currentRoot.stat({ bigint: true });
      if (rootAfter.dev !== rootIdentity.dev || rootAfter.ino !== rootIdentity.ino) throw new StorageVerifyError("source_changed");
      const current = await openBeneath(currentRoot, request.relativePath); handles.push(...current.parents, current.file);
      if (!unchanged(before, await current.file.stat({ bigint: true }))) throw new StorageVerifyError("source_changed");
      if ((await this.authority.authorize(request)).witness !== proof.witness) throw new StorageVerifyError("identity_mismatch");
      checkpoint();
      return storageVerifyResult(request, request.requireDurability);
    } finally {
      await Promise.allSettled(handles.reverse().map(h => h.close()));
      this.active--;
    }
  }
}
