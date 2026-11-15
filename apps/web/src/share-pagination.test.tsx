import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "./app.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState({}, "", "/"); });
it.each([false, true])("follows explicit filtered-page offsets and resets on folder navigation (legacy=%s)", async legacy => {
  const token = "P".repeat(43), requests: URL[] = [];
  window.history.replaceState({}, "", `/s/${token}${legacy ? "?legacy=1" : ""}`);
  const child = (index: number) => ({ id: String(index), type: "file", name: `item-${String(index)}.bin`, sizeBytes: 1, updatedAt: "2026-10-19T00:00:00Z" });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://saturn.test");
    if (url.pathname.endsWith("/children/page")) {
      requests.push(url); expect(url.searchParams.get("limit")).toBe("500");
      const offset = Number(url.searchParams.get("offset"));
      if (url.searchParams.has("parentId")) return Response.json({ items: [], nextOffset: null });
      if (offset === 0) return Response.json({ items: Array.from({ length: 500 }, (_, index) => child(index)), nextOffset: 500 });
      if (offset === 500) return Response.json({ items: [], nextOffset: 1000 });
      return Response.json({ items: [{ ...child(1000), id: "nested", type: "folder", name: "nested" }], nextOffset: null });
    }
    if (url.pathname.includes("/public/shares/")) return Response.json({ id: "share", resourceId: "root", resourceType: "folder", resourceName: "archive", resourceSize: 100_000, mode: "download_folder", state: "active", locked: false, downloadCount: 0, createdAt: "2026-10-19T00:00:00Z", updatedAt: "2026-10-19T00:00:00Z" });
    return Response.json({ status: "ready" });
  }));
  render(<App />);
  await screen.findByText("item-499.bin");
  expect(document.querySelectorAll(legacy ? ".share-browser__row" : ".share-client-file")).toHaveLength(500);
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  await screen.findByText("No visible items on this page.");
  expect(screen.queryByText("item-0.bin")).toBeNull();
  expect(screen.getByRole("button", { name: "Next page" }).hasAttribute("disabled")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
  await screen.findByText("item-499.bin");
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  await screen.findByText("No visible items on this page.");
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  fireEvent.click(await screen.findByRole("button", { name: legacy ? "nested" : "Open folder nested" }));
  await screen.findByText("This shared folder is empty.");
  expect(screen.getByRole("button", { name: "Previous page" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "← Back" }));
  await screen.findByText("item-499.bin");
  await waitFor(() => expect(requests.at(-1)?.searchParams.get("offset")).toBe("0"));
  expect(requests.map(url => Number(url.searchParams.get("offset")))).toEqual([0, 500, 0, 500, 1000, 0, 0]);
  expect(screen.getByText("Download all includes the entire shared folder, including other pages.")).toBeTruthy();
});
vi.mock("./upload-recovery-durable.js", async () => (await import("./upload-recovery-test-backend.js")).recoveryUnitBackend());
