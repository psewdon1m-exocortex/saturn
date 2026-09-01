import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { AuditWriteInput } from "@saturn/audit";
import type { ResourceStatus } from "@saturn/file-core";
import { LocalStorageAdapter } from "@saturn/storage";
import { ReconciliationService } from "./reconciliation.service.js";
import type {
  InterruptedOperation,
  ReconciliationIssue,
  ReconciliationMode,
  ReconciliationRepository,
  ReconciliationRun,
  TrackedFile,
} from "./types.js";

class MemoryRepository implements ReconciliationRepository {
  readonly files: TrackedFile[] = [];
  readonly managedRootPaths: string[] = ["drop point", "mastermind", "volt", "sync"];
  readonly issues: ReconciliationIssue[] = [];
  readonly runs: ReconciliationRun[] = [];
  readonly interrupted: InterruptedOperation[] = [];

  async startRun(id: string, mode: ReconciliationMode) {
    const run: ReconciliationRun = {
      id,
      mode,
      state: "running",
      startedAt: new Date(),
      scannedResources: 0,
      scannedStorageEntries: 0,
      issueCount: 0,
    };
    this.runs.push(run);
    return run;
  }
  async finishRun(id: string, result: { readonly state: "complete" | "failed"; readonly scannedResources: number; readonly scannedStorageEntries: number; readonly issueCount: number; readonly errorCode?: string }) {
    const index = this.runs.findIndex((item) => item.id === id);
    const current = this.runs[index];
    if (current === undefined) throw new Error("Run missing");
    const run: ReconciliationRun = { ...current, ...result, finishedAt: new Date() };
    this.runs[index] = run;
    return run;
  }
  async listActiveFiles(afterId: string | undefined, limit: number) {
    return this.files.filter((item) => item.status === "active" && (afterId === undefined || item.id > afterId)).slice(0, limit);
  }
  async listManagedRootPaths() { return this.managedRootPaths; }
  async hasResourceAtPath(storagePath: string) { return this.files.some((item) => item.storagePath === storagePath); }
  async setResourceStatus(id: string, status: ResourceStatus) {
    const index = this.files.findIndex((item) => item.id === id);
    const current = this.files[index];
    if (current === undefined) throw new Error("File missing");
    this.files[index] = { ...current, status };
  }
  async listInterruptedOperations() { return this.interrupted; }
  async addIssue(issue: ReconciliationIssue) { this.issues.push(issue); }
  async listRuns(limit: number) { return this.runs.slice(0, limit); }
  async listIssues(runId: string, limit: number) { return this.issues.filter((item) => item.runId === runId).slice(0, limit); }
}

describe("ReconciliationService", () => {
  it("classifies missing, size, checksum, orphan and interrupted states without deleting unknown bytes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vault-reconcile-"));
    const storage = new LocalStorageAdapter(root);
    const repository = new MemoryRepository();
    const audit: AuditWriteInput[] = [];
    try {
      await storage.initialize();
      for (const directory of ["drop point", "mastermind", "volt", "sync"]) await storage.mkdir(directory);
      await storage.mkdir("personal files");
      repository.managedRootPaths.push("personal files");
      const payload = Buffer.from("abc");
      const digest = createHash("sha256").update(payload).digest("hex");
      for (const [name, data] of [["ok.bin", payload], ["short.bin", Buffer.from("ab")], ["bad-hash.bin", payload], ["orphan.bin", Buffer.from("unknown")]] as const) {
        await storage.write(`sync/${name}`, Readable.from(data), { offset: 0, create: true, exclusive: true });
      }
      await storage.write("personal files/orphan.txt", Readable.from("personal orphan"), { offset: 0, create: true, exclusive: true });
      repository.files.push(
        { id: "01", storagePath: "sync/ok.bin", sizeBytes: 3, sha256: digest, status: "active" },
        { id: "02", storagePath: "sync/missing.bin", sizeBytes: 3, sha256: digest, status: "active" },
        { id: "03", storagePath: "sync/short.bin", sizeBytes: 3, sha256: digest, status: "active" },
        { id: "04", storagePath: "sync/bad-hash.bin", sizeBytes: 3, sha256: "0".repeat(64), status: "active" },
      );
      repository.interrupted.push({ id: "operation", storagePath: "sync/pending.bin", state: "rollback_failed" });
      const service = new ReconciliationService(repository, storage, { write: async (input) => { audit.push(input); } });
      const run = await service.run("full_hash");
      expect(run.state).toBe("complete");
      expect(repository.issues.map((item) => item.issueType).sort()).toEqual([
        "checksum_mismatch",
        "missing",
        "operation_interrupted",
        "orphaned",
        "orphaned",
        "size_mismatch",
      ]);
      expect(repository.files.find((item) => item.id === "02")?.status).toBe("missing");
      expect(repository.files.find((item) => item.id === "03")?.status).toBe("error");
      expect(repository.files.find((item) => item.id === "04")?.status).toBe("quarantined");
      expect(await storage.exists("sync/orphan.bin")).toBe(false);
      const orphan = repository.issues.find((item) => item.issueType === "orphaned");
      expect(await storage.exists(String(orphan?.actual.orphanPath))).toBe(true);
      expect(audit.at(-1)?.action).toBe("reconciliation.completed");
    } finally {
      await storage.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
