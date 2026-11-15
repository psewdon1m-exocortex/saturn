import { errorValue } from "./error-value.js";
import { requiredValue } from "./test-value.js";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DropRecoveryAccessHint, UploadRecoveryPanel } from "./upload-recovery-panel.js";
import { resumeOwnerUpload } from "./api.js";
import { saveUploadRecovery } from "./upload-recovery-store.js";
vi.mock("./api.js", () => ({ api: {}, dropApi: {}, resumeOwnerUpload: vi.fn(), uploadDropFile: vi.fn() }));
afterEach(() => { cleanup(); localStorage.clear(); vi.resetAllMocks(); });
function save(filename: string, parentId = "parent") {
  const operationId = crypto.randomUUID();
  saveUploadRecovery({ schema: 2, channel: "owner", operationId, idempotencyKey: `web-upload-${operationId}`, filename, parentId, expectedSize: 1, lastModified: 123, sha256: "a".repeat(64), createdAt: Date.now() });
  return operationId;
}
it("shows only the current destination and bounds the recovery DOM to eight records", () => {
  for (let i = 0; i < 12; i++) save(`source-${String(i)}.bin`);
  save("unrelated.bin", "other");
  render(<UploadRecoveryPanel channel="owner" scopeId="parent" />);
  expect(screen.getAllByRole("listitem")).toHaveLength(8);
  expect(screen.queryByText(/unrelated.bin/)).toBeNull();
  fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: "Next" }));
  expect(screen.getAllByRole("listitem")).toHaveLength(4);
});
it("keeps original admission identity on reselection and offers cancellation during verification", async () => {
  const id = save("original.bin"), busy = vi.fn<(busy:boolean)=>void>();
  vi.mocked(resumeOwnerUpload).mockImplementation(async (_id, _file, _progress, _before, options) => new Promise((_resolve, reject) => {
    requiredValue(requiredValue(options).signal).addEventListener("abort", () => reject(errorValue(requiredValue(requiredValue(options).signal).reason)), { once: true });
  }));
  render(<UploadRecoveryPanel channel="owner" scopeId="parent" onBusy={busy} />);
  fireEvent.click(screen.getByRole("button", { name: "Reselect original file" }));
  const file = new File(["x"], "original.bin", { lastModified: 123 });
  fireEvent.change(screen.getByLabelText("Reselect original upload source"), { target: { files: [file] } });
  await waitFor(() => expect(resumeOwnerUpload).toHaveBeenCalledWith(id, file, expect.any(Function), expect.any(Function), { signal: expect.any(AbortSignal) as unknown }));
  fireEvent.click(screen.getByRole("button", { name: "Stop recovery" }));
  await waitFor(() => expect(busy.mock.calls.map(call => call[0])).toEqual([true, false]));
  expect(localStorage.length).toBe(1);
});
vi.mock("./upload-recovery-durable.js", async () => (await import("./upload-recovery-test-backend.js")).recoveryUnitBackend());
it("directs lost-cookie recovery to the original Drop code and distinguishes another channel", async () => {
  const operationId = crypto.randomUUID();
  saveUploadRecovery({ schema: 2, channel: "drop", channelId: "original-channel", operationId, idempotencyKey: `drop-web-${operationId}`, filename: "pending.bin", expectedSize: 1, lastModified: 1, sha256: "a".repeat(64), createdAt: 1 });
  const view = render(<DropRecoveryAccessHint />);
  expect(screen.getByRole("status").textContent).toContain("original Drop code while it is valid");
  view.rerender(<DropRecoveryAccessHint channelId="other-channel" />);
  expect(screen.getByRole("status").textContent).toContain("belong to another Drop channel");
  view.rerender(<DropRecoveryAccessHint channelId="original-channel" />);
  await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  expect(localStorage.length).toBe(1);
});
