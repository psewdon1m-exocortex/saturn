import { describe, expect, it } from "vitest";
import type { Database } from "@saturn/database";
import type { StorageAdapter } from "@saturn/storage";
import type { CatalogFolderAuthority, CatalogFolderAuthorityIssuer } from "./catalog-folder-authority.js";
import type { FileService } from "./file.service.js";
import { CatalogStreamUpload, parseStreamPrepare } from "./catalog-stream-upload.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function original() {
  const root = "00000000-0000-4000-8000-000000000001";
  const node = "00000000-0000-4000-8000-000000000003";
  return parseStreamPrepare({
    schema: "saturn.stream-upload.v2", operationId: "00000000-0000-4000-8000-000000000006",
    source: { generation: "3", witnessSha256: "a".repeat(64) }, chunkBytes: 4194304,
    prepare: {
      epoch: "00000000-0000-4000-8000-000000000007", bindingVersion: "00000000-0000-4000-8000-000000000008", backendIdentity: "liveness-fixture",
      intent: {
        schema: "saturn.upload-intent.v2", deviceKind: "pluto", deviceId: "00000000-0000-4000-8000-000000000002",
        rootId: root, requestPath: "/stream.bin", idempotencyKey: "liveness-overwrite-original", parentId: root, name: "stream.bin",
        targetId: node, sizeBytes: "8388625", sha256: null, ifMatch: null, ifNoneMatch: null, requireAbsent: false,
        expectedVersionId: "00000000-0000-4000-8000-000000000004",
        condition: { kind: "match", nodeId: node, metadataVersion: "00000000-0000-4000-8000-000000000005" },
        parentTopology: [{ nodeId: root, parentId: null, name: "liveness-fixture" }],
      },
    },
  });
}
const proof = {} as CatalogFolderAuthority;
const seal = { sha256: "b".repeat(64), sourceGeneration: "3", sourceWitnessSha256: "a".repeat(64) };
function heldCommands() {
  const entered = deferred<undefined>();
  const gate = deferred<never>();
  const writer = { transaction: () => { entered.resolve(undefined); return gate.promise; } } as unknown as Database;
  const issuer = { deviceCredential: () => ({}) } as unknown as CatalogFolderAuthorityIssuer;
  const stream = new CatalogStreamUpload(writer, issuer, {} as StorageAdapter, {} as FileService);
  return { stream, entered, gate };
}

describe("stream completion request liveness before a background job exists", () => {
  for (const stage of ["seal", "publication status"] as const) {
    it(`keeps ${stage} await visible until the validated request settles`, async () => {
      const { stream, entered, gate } = heldCommands();
      const request = stream.completeWithin(original(), proof, stage === "seal" ? seal : undefined);
      await entered.promise;
      try {
        // A namespace read can reject a sealed overwrite while this first
        // command is pending. Its retry classification needs this liveness,
        // even though no detached completion job has been registered yet.
        expect(stream.hasPendingCompletion).toBe(true);
      } finally {
        gate.reject(new Error("binding_invalid"));
        await expect(request).rejects.toMatchObject({ code: "binding_invalid" });
        await stream.close();
      }
      expect(stream.hasPendingCompletion).toBe(false);
    });
  }

  it("close joins an active seal request and retains its liveness until settlement", async () => {
    const { stream, entered, gate } = heldCommands();
    const request = stream.completeWithin(original(), proof, seal);
    await entered.promise;
    const closing = stream.close();
    try {
      expect(stream.hasPendingCompletion).toBe(true);
    } finally {
      gate.reject(new Error("binding_invalid"));
      await expect(request).rejects.toMatchObject({ code: "binding_invalid" });
      await closing;
    }
    expect(stream.hasPendingCompletion).toBe(false);
  });

  it("does not retain liveness after an invalid request is rejected", async () => {
    const { stream } = heldCommands();
    await expect(stream.completeWithin({}, proof)).rejects.toMatchObject({ code: "invalid_input" });
    await stream.close();
    expect(stream.hasPendingCompletion).toBe(false);
  });
});
