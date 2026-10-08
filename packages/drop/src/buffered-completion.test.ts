import { describe, expect, it, vi } from "vitest";
import { DropService } from "./drop.service.js";
import type { DropBufferStore } from "./buffer-store.js";
import type { DropFileGateway, DropRepository, DropSession, DropUpload } from "./types.js";

describe("buffered Drop completion retry", () => {
  it.each(["buffered", "transferring", "verifying", "stored"] as const)("returns verified metadata after %s without reading removed local bytes", async (state) => {
    const session = { channelId: "channel", expiresAt: new Date(Date.now() + 60_000) } as DropSession;
    const upload: DropUpload = { id: "019cbb75-6352-7000-8000-000000000001", sessionId: "session", channelId: session.channelId, clientKeyHash: "key", filename: "precious.bin", expectedSize: 100, receivedSize: 100, state, actualSha256: "a".repeat(64), createdAt: new Date(), ...(state === "stored" ? {} : { localPath: "removed.part" }) };
    const digest = vi.fn().mockRejectedValue(new Error("Local buffer was already removed"));
    const markBuffered = vi.fn().mockRejectedValue(new Error("Already past buffering"));
    const repository = { getDropUpload: async () => upload, markUploadBuffered: markBuffered } as unknown as DropRepository;
    const service = new DropService({ repository, files: {} as DropFileGateway, buffer: { digest } as unknown as DropBufferStore, pepper: "test-pepper-at-least-thirty-two-characters", options: { publicOrigin: "https://saturn.test", codeTtlMs: 60_000, sessionTtlMs: 60_000, maxFiles: 10, maxBytes: 1000, failureLimit: 5, globalFailureLimit: 20, failureWindowMs: 60_000 } });
    await expect(service.completeUpload(session, upload.id)).resolves.toMatchObject({ sha256: upload.actualSha256, sizeBytes: 100, upload: { state } });
    expect(digest).not.toHaveBeenCalled();
    expect(markBuffered).not.toHaveBeenCalled();
  });
});
