import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "./app.js";

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({ GlobalWorkerOptions: { workerSrc: "" }, getDocument: vi.fn() }));
HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); window.history.replaceState({}, "", "/"); });

it.each(["files", "storage-new"])("keeps overwrite and retained versions reachable from the %s file menu", async view => {
  window.history.replaceState({}, "", `/${view}/fixture`);
  const now = new Date().toISOString();
  const root = { id: "00000000-0000-7000-8000-000000000001", type: "folder", name: "root", storagePath: "", sizeBytes: 0, status: "active", createdAt: now, updatedAt: now };
  const folder = { ...root, id: "01900000-0000-7000-8000-000000000090", parentId: root.id, name: "fixture", storagePath: "fixture" };
  const file = { ...root, id: "01900000-0000-7000-8000-000000000091", parentId: folder.id, type: "file", name: "valuable.bin", storagePath: "fixture/valuable.bin", sizeBytes: 16, mimeType: "application/octet-stream" };
  const requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url; requests.push(url);
    let body: unknown = {};
    if (url.endsWith("/auth/session")) body = { state: "authenticated" };
    else if (url.endsWith("/auth/preferences")) body = { accentColor: "#00a8ff", sidebarMode: "fixed", navigationOrder: ["dashboard", "files", "storage-new", "inbox", "shared", "synchronization", "trash", "settings"], dashboardOrder: ["cpu", "ram", "disk", "uptime", "storage", "drop", "reachability", "tasks"], settingsOrder: ["appearance", "security", "storage", "backup", "gryphon", "updates", "logs"], updatedAt: now };
    else if (url.includes("/folders/resolve?")) body = [root, folder];
    else if (url.includes("/children")) body = [file];
    else if (url.includes("/versions") || url.includes("/shares") || url.includes("/archives/jobs")) body = [];
    else if (url.includes("/resources/")) body = folder;
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }));
  render(<App />);
  fireEvent.contextMenu(await screen.findByRole("button", { name: file.name }));
  const replacement = screen.getByLabelText("Choose replacement file");
  const picker = vi.spyOn(replacement as HTMLInputElement, "click");
  fireEvent.click(screen.getByRole("menuitem", { name: "Overwrite" }));
  expect(picker).toHaveBeenCalledExactlyOnceWith();
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.contextMenu(screen.getByRole("button", { name: file.name }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Versions" }));
  await waitFor(() => expect(requests.some(url => url.endsWith(`/files/${file.id}/versions?limit=100`))).toBe(true));
  await screen.findByRole("dialog", { name: `Versions — ${file.name}` });
  expect(screen.getByText("No historical versions.")).toBeTruthy();
});
