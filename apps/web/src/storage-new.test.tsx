import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./app.js";
import { api, ApiError, uploadFile } from "./api.js";
import type * as ApiModule from "./api.js";
import { ROOT_RESOURCE_ID, BACKUPS_RESOURCE_ID, type Resource } from "./types.js";

vi.mock("./api.js", async (importOriginal) => ({ ...await importOriginal<typeof ApiModule>(), uploadFile: vi.fn() }));
const now = "2026-10-11T12:00:00.000Z";
const root: Resource = { id: ROOT_RESOURCE_ID, type: "folder", name: "root", storagePath: "", sizeBytes: 0, status: "active", createdAt: now, updatedAt: now };
const folder: Resource = { ...root, id: BACKUPS_RESOURCE_ID, parentId: root.id, name: "My files + notes", storagePath: "backups", sizeBytes: 4096 };
const file: Resource = { ...root, id: "01900000-0000-7000-8000-000000000091", parentId: folder.id, type: "file", name: "valuable.txt", mimeType: "text/plain", storagePath: "backups/valuable.txt", sizeBytes: 1024 };
const other: Resource = { ...file, id: "01900000-0000-7000-8000-000000000092", name: "settings.json", mimeType: "application/json" };
const ownerPreferences = {
  accentColor: "#f0e68c", sidebarMode: "fixed" as const,
  navigationOrder: ["inbox", "files", "dashboard", "shared", "synchronization", "trash", "settings"] as const,
  dashboardOrder: ["cpu", "ram", "disk", "uptime", "storage", "drop", "reachability", "tasks"] as const,
  settingsOrder: ["appearance", "security", "storage", "backup", "gryphon", "updates", "logs"] as const,
  trashRetentionDays: 30, uploadBufferGiB: 110, maximumUploadFileGiB: 20, updatedAt: now,
};

function fixture(path = "/storage-new") {
  window.history.replaceState({}, "", path);
  vi.spyOn(api, "publicAppearance").mockResolvedValue({ accentColor: "#f0e68c" });
  vi.spyOn(api, "session").mockResolvedValue({ state: "authenticated" });
  vi.spyOn(api, "preferences").mockResolvedValue(ownerPreferences);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "ready" }), { headers: { "Content-Type": "application/json" } })));
  const resolve = vi.spyOn(api, "resolveFolder").mockImplementation(async (_root, segments) => segments.length ? [root, folder] : [root]);
  vi.spyOn(api, "children").mockImplementation(async (id) => id === root.id ? [folder] : [file, other]);
  vi.spyOn(api, "resource").mockImplementation(async (id) => id === folder.id ? folder : root);
  vi.spyOn(api, "archiveJobs").mockResolvedValue([]);
  vi.spyOn(api, "shares").mockResolvedValue([]);
  return { resolve };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.mocked(uploadFile).mockReset(); window.history.replaceState({}, "", "/"); });

describe("Storage new", () => {
  it("inserts its tab after Storage without resetting the saved navigation and keeps the original table", async () => {
    fixture("/files"); render(<App />);
    expect(await screen.findByRole("heading", { name: "Storage" })).toBeTruthy();
    const navigation = screen.getByRole("navigation", { name: "Primary" });
    await waitFor(() => expect([...navigation.querySelectorAll("button")].slice(0, 4).map((button) => button.getAttribute("aria-label"))).toEqual(["Drop Point", "Storage", "Storage new", "Dashboard"]));
    expect(document.querySelector(".storage-workspace .storage-collection")).toBeTruthy();
    expect(document.querySelector(".storage-new")).toBeNull();
    fireEvent.click(within(navigation).getByRole("button", { name: "Storage new" }));
    await screen.findByRole("heading", { name: "Your storage" });
    expect(window.location.pathname).toBe("/storage-new");
    expect(document.querySelector(".storage-collection")).toBeNull();
    fireEvent.click(within(navigation).getByRole("button", { name: "Storage" }));
    await screen.findByRole("heading", { name: "Storage" });
    expect(document.querySelector(".storage-workspace .storage-collection")).toBeTruthy();
  });

  it("opens encoded nested paths, breadcrumbs and browser Back inside the new route", async () => {
    fixture(); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: `Open folder ${folder.name}` }));
    await screen.findByRole("heading", { name: folder.name });
    expect(window.location.pathname).toBe(`/storage-new/${encodeURIComponent(folder.name)}`);
    fireEvent.click(within(screen.getByRole("navigation", { name: "Folder breadcrumbs" })).getByRole("button", { name: "root" }));
    await screen.findByRole("heading", { name: "Your storage" });
    await new Promise<void>((resolve) => { window.addEventListener("popstate", () => resolve(), { once: true }); window.history.back(); });
    await screen.findByRole("heading", { name: folder.name });
    expect(screen.getByRole("button", { name: "Storage new" }).getAttribute("aria-current")).toBe("page");
  });

  it("keeps protected root folders safe and refuses a root drop", async () => {
    fixture(); const upload = vi.mocked(uploadFile); render(<App />);
    fireEvent.click(await screen.findByRole("checkbox", { name: `Select ${folder.name}` }));
    expect(screen.getByRole("button", { name: "Move" }).hasAttribute("disabled")).toBe(true);
    expect(within(screen.getByRole("toolbar", { name: "Selection actions" })).getByRole("button", { name: "Trash" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Upload files" }).hasAttribute("disabled")).toBe(true);
    const workspace = document.querySelector(".storage-new"); expect(workspace).toBeTruthy();
    if (workspace) fireEvent.drop(workspace, { dataTransfer: { types: ["Files"], items: [], files: [new File(["config"], "config.txt")] } });
    expect(await screen.findByText("Create or open a folder first. Files cannot be stored directly in the Saturn root.")).toBeTruthy();
    expect(upload).not.toHaveBeenCalled();
  });

  it("searches, sorts, selects ranges and uses the existing ZIP command", async () => {
    fixture(`/storage-new/${encodeURIComponent(folder.name)}`);
    const archive = vi.spyOn(api, "createArchive").mockResolvedValue({ id: "job", kind: "compress_zip", format: "zip", state: "queued", requestedState: "running", destinationParentId: folder.id, sourceResourceIds: [file.id, other.id], outputName: "archive.zip", processedBytes: 0, totalBytes: 2048, createdAt: now, updatedAt: now });
    render(<App />);
    const valuable = await screen.findByRole("checkbox", { name: `Select ${file.name}` });
    fireEvent.click(screen.getByRole("button", { name: /Name/ }));
    expect(document.querySelector(".storage-new-file")?.getAttribute("aria-label")).toBe(file.name);
    fireEvent.click(valuable);
    fireEvent.click(screen.getByRole("checkbox", { name: `Select ${other.name}` }), { shiftKey: true });
    expect(screen.getByText("2 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: `Actions for ${file.name}` }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Compress to ZIP" }));
    fireEvent.click(screen.getByRole("button", { name: "Create ZIP" }));
    await waitFor(() => expect(archive).toHaveBeenCalledWith(folder.id, expect.arrayContaining([file.id, other.id]), "archive.zip"));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search storage" }), { target: { value: "missing" } });
    expect(screen.getByText("No matching items. Try another search.")).toBeTruthy();
  });

  it.each(["input", "drop"])("uploads with %s into the resolved folder using the existing verified upload handler", async (source) => {
    fixture(`/storage-new/${encodeURIComponent(folder.name)}`);
    const upload = vi.mocked(uploadFile).mockResolvedValue(file); render(<App />);
    await screen.findByRole("checkbox", { name: `Select ${file.name}` });
    const chosen = new File(["important"], "important.conf");
    if (source === "input") fireEvent.change(screen.getByLabelText("Choose files to upload"), { target: { files: [chosen] } });
    else { const workspace = document.querySelector(".storage-new"); if (workspace) fireEvent.drop(workspace, { dataTransfer: { types: ["Files"], items: [], files: [chosen] } }); }
    await waitFor(() => expect(upload).toHaveBeenCalledWith(chosen, folder.id, undefined, expect.any(Function)));
    expect(await screen.findByText("Upload committed and verified.")).toBeTruthy();
  });

  it("requires confirmation for trash and does not trash on cancel", async () => {
    fixture(`/storage-new/${encodeURIComponent(folder.name)}`);
    const trash = vi.spyOn(api, "trashResource").mockResolvedValue(file); render(<App />);
    fireEvent.click(await screen.findByRole("checkbox", { name: `Select ${file.name}` }));
    fireEvent.keyDown(screen.getByLabelText("Stored files and folders"), { key: "Delete" });
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(trash).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("toolbar", { name: "Selection actions" })).getByRole("button", { name: "Trash" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Move to trash" }));
    await waitFor(() => expect(trash).toHaveBeenCalledWith(file.id));
  });

  it("creates a folder in the current location", async () => {
    fixture(`/storage-new/${encodeURIComponent(folder.name)}`);
    const create = vi.spyOn(api, "createFolder").mockResolvedValue(folder); render(<App />);
    await screen.findByRole("checkbox", { name: `Select ${file.name}` });
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    fireEvent.change(screen.getByLabelText("Folder name"), { target: { value: "Reports" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith(folder.id, "Reports"));
  });

  it.each(["Rename", "Move", "Copy"])("submits %s through the shared file operation", async (action) => {
    fixture(`/storage-new/${encodeURIComponent(folder.name)}`);
    const mutate = vi.spyOn(api, action === "Copy" ? "copy" : "move").mockResolvedValue(file); render(<App />);
    fireEvent.click(await screen.findByRole("checkbox", { name: `Select ${file.name}` }));
    fireEvent.click(within(screen.getByRole("toolbar", { name: "Selection actions" })).getByRole("button", { name: action }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "renamed.txt" } });
    if (action !== "Rename") fireEvent.change(screen.getByLabelText("Destination folder ID"), { target: { value: root.id } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(mutate).toHaveBeenCalledWith(file.id, action === "Rename" ? folder.id : root.id, "renamed.txt"));
  });

  it("uses the existing share composer and overwrite identity", async () => {
    fixture(`/storage-new/${encodeURIComponent(folder.name)}`);
    const share = { id: "fixture-share", resourceId: file.id, resourceType: "file" as const, resourceName: file.name, resourceSize: file.sizeBytes, mode: "download" as const, state: "active" as const, locked: false, downloadCount: 0, createdAt: now, updatedAt: now };
    const create = vi.spyOn(api, "createShare").mockResolvedValue({ share, token: "fixture", url: "https://saturn.example/s/fixture" });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
    render(<App />);
    fireEvent.click(await screen.findByRole("checkbox", { name: `Select ${file.name}` }));
    fireEvent.click(within(screen.getByRole("toolbar", { name: "Selection actions" })).getByRole("button", { name: "Share" }));
    fireEvent.click(screen.getByRole("button", { name: "Create share" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ resourceId: file.id, mode: "download" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    vi.mocked(uploadFile).mockResolvedValue(file);
    const replacement = new File(["replacement"], file.name);
    fireEvent.change(screen.getByLabelText("Choose replacement file"), { target: { files: [replacement] } });
    await waitFor(() => expect(uploadFile).toHaveBeenCalledWith(replacement, folder.id, file.id, expect.any(Function)));
    expect(await screen.findByText("File overwritten; the previous version is retained.")).toBeTruthy();
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("returns to authentication when a private folder request loses its session", async () => {
    const { resolve } = fixture(`/storage-new/${encodeURIComponent(folder.name)}`);
    resolve.mockRejectedValue(new ApiError(401, {})); render(<App />);
    expect(await screen.findByLabelText("Access Key")).toBeTruthy();
    expect(screen.queryByLabelText("Stored files and folders")).toBeNull();
  });

  it("does not send a drop to the previous folder while the new location is loading", async () => {
    const { resolve } = fixture(`/storage-new/${encodeURIComponent(folder.name)}`);
    render(<App />);
    await screen.findByRole("checkbox", { name: `Select ${file.name}` });
    resolve.mockImplementationOnce(() => new Promise(() => undefined));
    fireEvent.click(within(screen.getByRole("navigation", { name: "Folder breadcrumbs" })).getByRole("button", { name: "root" }));
    await screen.findByText("Loading folder…");
    const workspace = document.querySelector(".storage-new");
    if (workspace) fireEvent.drop(workspace, { dataTransfer: { types: ["Files"], items: [], files: [new File(["valuable"], "config.conf")] } });
    expect(uploadFile).not.toHaveBeenCalled();
    expect(screen.getByText("Wait for this folder to finish loading before uploading.")).toBeTruthy();
  });

  it("retries a failed folder request and exposes file download and keyboard actions", async () => {
    const { resolve } = fixture(`/storage-new/${encodeURIComponent(folder.name)}`);
    resolve.mockRejectedValueOnce(new ApiError(503, {})); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    const checkbox = await screen.findByRole("checkbox", { name: `Select ${file.name}` });
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("link", { name: `Download ${file.name}` }).getAttribute("href")).toContain(`/files/${file.id}/content`);
    const card = checkbox.closest("article");
    if (card) { fireEvent.keyDown(card, { key: " ", code: "Space" }); fireEvent.keyDown(card, { key: "F10", shiftKey: true }); }
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("menu")).toBeTruthy();
  });
});
