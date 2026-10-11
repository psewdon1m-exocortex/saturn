import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./app.js";
import { api, ApiError, uploadFile } from "./api.js";
import type * as ApiModule from "./api.js";
import { ROOT_RESOURCE_ID, BACKUPS_RESOURCE_ID, type Resource } from "./types.js";

vi.mock("./api.js", async (importOriginal) => ({ ...await importOriginal<typeof ApiModule>(), uploadFile: vi.fn() }));
const now = "2026-10-11T12:00:00.000Z";
const root: Resource = { id: ROOT_RESOURCE_ID, type: "folder", name: "root", storagePath: "", sizeBytes: 0, status: "active", createdAt: now, updatedAt: now };
const folder: Resource = { ...root, id: BACKUPS_RESOURCE_ID, parentId: root.id, name: "# sync inner services", storagePath: "# sync inner services", sizeBytes: 4096 };
const file: Resource = { ...root, id: "01900000-0000-7000-8000-000000000091", parentId: folder.id, type: "file", name: "valuable.txt", mimeType: "text/plain", storagePath: "# sync inner services/valuable.txt", sizeBytes: 1024 };
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
    expect(screen.queryByRole("group", { name: "Folder navigation" })).toBeNull();
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

  it("navigates Back, Forward and Up without leaving Storage new and discards the forward branch", async () => {
    fixture(); render(<App />);
    await screen.findByRole("button", { name: `Open folder ${folder.name}` });
    const navigation = () => within(screen.getByRole("group", { name: "Folder navigation" }));
    const disabled = (name: string) => navigation().getByRole("button", { name }).hasAttribute("disabled");
    expect(disabled("Back")).toBe(true);
    expect(disabled("Forward")).toBe(true);
    expect(disabled("Up one level")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: `Open folder ${folder.name}` }));
    await waitFor(() => expect(disabled("Up one level")).toBe(false));
    expect(disabled("Back")).toBe(false);
    expect(disabled("Forward")).toBe(true);
    fireEvent.click(navigation().getByRole("button", { name: "Up one level" }));
    await screen.findByRole("button", { name: `Open folder ${folder.name}` });
    expect(window.location.pathname).toBe("/storage-new");
    expect(disabled("Up one level")).toBe(true);
    fireEvent.click(navigation().getByRole("button", { name: "Back" }));
    await screen.findByRole("article", { name: file.name });
    await waitFor(() => expect(disabled("Forward")).toBe(false));
    expect(window.location.pathname).toBe(`/storage-new/${encodeURIComponent(folder.name)}`);
    fireEvent.click(navigation().getByRole("button", { name: "Back" }));
    await screen.findByRole("button", { name: `Open folder ${folder.name}` });
    expect(disabled("Back")).toBe(true);
    expect(disabled("Forward")).toBe(false);
    fireEvent.click(navigation().getByRole("button", { name: "Forward" }));
    await screen.findByRole("article", { name: file.name });
    await waitFor(() => expect(disabled("Up one level")).toBe(false));
    await new Promise<void>((resolve) => { window.addEventListener("popstate", () => resolve(), { once: true }); window.history.back(); });
    await screen.findByRole("button", { name: `Open folder ${folder.name}` });
    expect(disabled("Forward")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: `Open folder ${folder.name}` }));
    await screen.findByRole("article", { name: file.name });
    await waitFor(() => expect(disabled("Up one level")).toBe(false));
    expect(disabled("Forward")).toBe(true);
  });

  it("opens the parent of a direct nested URL, including a failed path, without inventing Back history", async () => {
    const { resolve } = fixture(`/storage-new/${encodeURIComponent(folder.name)}/missing`);
    resolve.mockImplementation(async (_root, segments) => {
      if (segments.length > 1) throw new ApiError(404, {});
      return segments.length ? [root, folder] : [root];
    });
    render(<App />);
    await screen.findByRole("alert");
    await waitFor(() => expect(screen.getByRole("button", { name: "Up one level" }).hasAttribute("disabled")).toBe(false));
    expect(screen.getByRole("button", { name: "Back" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Forward" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Up one level" }));
    await screen.findByRole("article", { name: file.name });
    expect(window.location.pathname).toBe(`/storage-new/${encodeURIComponent(folder.name)}`);
  });

  it("keeps protected root folders safe and refuses a root drop", async () => {
    fixture(); const upload = vi.mocked(uploadFile); render(<App />);
    fireEvent.contextMenu(await screen.findByRole("article", { name: folder.name }));
    expect(screen.getByRole("menuitem", { name: "Move" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("menuitem", { name: "Copy to folder" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("menuitem", { name: "Copy" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("menuitem", { name: "Rename" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("menuitem", { name: "Delete" }).hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
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
    const valuable = await screen.findByRole("button", { name: file.name });
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("toolbar", { name: "Selection actions" })).toBeNull();
    expect(screen.queryByRole("button", { name: `Actions for ${file.name}` })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Name/ }));
    expect(document.querySelector(".storage-new-file")?.getAttribute("aria-label")).toBe(file.name);
    fireEvent.click(valuable);
    fireEvent.click(screen.getByRole("button", { name: other.name }), { shiftKey: true });
    expect(screen.getByText(/2 selected/)).toBeTruthy();
    expect(screen.queryByRole("toolbar", { name: "Selection actions" })).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.contextMenu(screen.getByRole("article", { name: file.name }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Compress to ZIP" }));
    fireEvent.click(screen.getByRole("button", { name: "Create ZIP" }));
    await waitFor(() => expect(archive).toHaveBeenCalledWith(folder.id, expect.arrayContaining([file.id, other.id]), "archive.zip"));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search storage" }), { target: { value: "missing" } });
    expect(screen.getByText("No matching items. Try another search.")).toBeTruthy();
  });

  it.each(["input", "drop"])("uploads with %s into the resolved folder using the existing verified upload handler", async (source) => {
    fixture(`/storage-new/${encodeURIComponent(folder.name)}`);
    const upload = vi.mocked(uploadFile).mockResolvedValue(file); render(<App />);
    await screen.findByRole("article", { name: file.name });
    const chosen = new File(["important"], "important.conf");
    if (source === "input") fireEvent.change(screen.getByLabelText("Choose files to upload"), { target: { files: [chosen] } });
    else { const workspace = document.querySelector(".storage-new"); if (workspace) fireEvent.drop(workspace, { dataTransfer: { types: ["Files"], items: [], files: [chosen] } }); }
    await waitFor(() => expect(upload).toHaveBeenCalledWith(chosen, folder.id, undefined, expect.any(Function)));
    expect(await screen.findByText("Upload committed and verified.")).toBeTruthy();
  });

  it("requires confirmation for trash and does not trash on cancel", async () => {
    fixture(`/storage-new/${encodeURIComponent(folder.name)}`);
    const trash = vi.spyOn(api, "trashResource").mockResolvedValue(file); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: file.name }));
    fireEvent.keyDown(screen.getByLabelText("Stored files and folders"), { key: "Delete" });
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(trash).not.toHaveBeenCalled();
    fireEvent.contextMenu(screen.getByRole("article", { name: file.name }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Move to trash" }));
    await waitFor(() => expect(trash).toHaveBeenCalledWith(file.id));
  });

  it.each(["root", "nested"])("creates a folder in the current %s location", async (location) => {
    fixture(location === "root" ? "/storage-new" : `/storage-new/${encodeURIComponent(folder.name)}`);
    const create = vi.spyOn(api, "createFolder").mockResolvedValue(folder); render(<App />);
    await screen.findByRole("article", { name: location === "root" ? folder.name : file.name });
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    fireEvent.change(screen.getByLabelText("Folder name"), { target: { value: "Reports" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Create folder" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith(location === "root" ? root.id : folder.id, "Reports"));
  });

  it.each(["Rename", "Move", "Copy"])("submits %s through the shared file operation", async (action) => {
    fixture(`/storage-new/${encodeURIComponent(folder.name)}`);
    const mutate = vi.spyOn(api, action === "Copy" ? "copy" : "move").mockResolvedValue(file); render(<App />);
    fireEvent.contextMenu(await screen.findByRole("article", { name: file.name }));
    fireEvent.click(screen.getByRole("menuitem", { name: action === "Copy" ? "Copy to folder" : action }));
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
    fireEvent.contextMenu(await screen.findByRole("article", { name: file.name }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Share" }));
    fireEvent.click(screen.getByRole("button", { name: "Create share" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ resourceId: file.id, mode: "download" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    vi.mocked(uploadFile).mockResolvedValue(file);
    const replacement = new File(["replacement"], file.name);
    fireEvent.contextMenu(screen.getByRole("article", { name: file.name }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Overwrite" }));
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

  it("loads and reuses a shared link, blocks duplicate copies and revokes through the existing handlers", async () => {
    fixture(`/storage-new/${encodeURIComponent(folder.name)}`);
    const share = { id: "fixture-share", resourceId: file.id, resourceType: "file" as const, resourceName: file.name, resourceSize: file.sizeBytes, mode: "download" as const, state: "active" as const, locked: true, expiresAt: "2026-11-11T12:00:00.000Z", downloadCount: 0, createdAt: now, updatedAt: now };
    vi.mocked(api.shares).mockResolvedValue([share]);
    let finishCopy: ((value: { url: string; replaced: boolean }) => void) | undefined;
    const capability = vi.spyOn(api, "shareCapability").mockImplementation(() => new Promise((resolve) => { finishCopy = resolve; }));
    const revoked = { ...share, state: "revoked" as const };
    const revoke = vi.spyOn(api, "revokeShare").mockImplementation(async () => { vi.mocked(api.shares).mockResolvedValue([]); return revoked; });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      render(<App />);
      const trigger = await screen.findByRole("button", { name: `Shared access for ${file.name}` });
      trigger.focus(); fireEvent.click(trigger);
      const dialog = screen.getByRole("dialog", { name: "Shared access" });
      expect(dialog.classList.contains("storage-new-share-dialog")).toBe(true);
      expect(within(dialog).getByRole("heading", { name: file.name })).toBeTruthy();
      expect(within(dialog).getByText("Required")).toBeTruthy();
      expect(within(dialog).getByText("Download")).toBeTruthy();
      fireEvent.click(within(dialog).getByRole("button", { name: "Copy link" }));
      const copying = within(dialog).getByRole("button", { name: "Copying…" });
      expect(copying.hasAttribute("disabled")).toBe(true);
      expect(within(dialog).getByRole("button", { name: "Revoke link" }).hasAttribute("disabled")).toBe(true);
      fireEvent.click(copying);
      expect(capability).toHaveBeenCalledTimes(1);
      finishCopy?.({ url: "https://saturn.example/s/recovered", replaced: true });
      await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://saturn.example/s/recovered"));
      expect(within(dialog).getByLabelText("Share link")).toHaveProperty("value", "https://saturn.example/s/recovered");
      expect(await screen.findByText(/legacy share link was securely replaced and copied/)).toBeTruthy();
      fireEvent.click(within(dialog).getByRole("button", { name: "Copy link" }));
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
      expect(capability).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(window, { key: "Escape" });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.activeElement).toBe(trigger);
      fireEvent.click(trigger);
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Revoke link" }));
      await waitFor(() => expect(revoke).toHaveBeenCalledWith(share.id));
      expect(await screen.findByText("Revoked")).toBeTruthy();
      expect(screen.queryByLabelText("Share link")).toBeNull();
      expect(screen.getByRole("button", { name: "Revoke link" }).hasAttribute("disabled")).toBe(true);
      expect(screen.getByRole("article", { name: file.name })).toBeTruthy();
    } finally { Reflect.deleteProperty(navigator, "clipboard"); }
  });

  it("keeps the shared dialog usable after link retrieval or clipboard failure", async () => {
    fixture(`/storage-new/${encodeURIComponent(folder.name)}`);
    const share = { id: "fixture-share", resourceId: file.id, resourceType: "file" as const, resourceName: file.name, resourceSize: file.sizeBytes, mode: "view" as const, state: "active" as const, locked: false, downloadCount: 0, createdAt: now, updatedAt: now };
    vi.mocked(api.shares).mockResolvedValue([share]);
    const capability = vi.spyOn(api, "shareCapability").mockRejectedValueOnce(new ApiError(503, {})).mockResolvedValue({ url: "https://saturn.example/s/manual-copy", replaced: false });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("Clipboard blocked")) } });
    try {
      render(<App />);
      fireEvent.click(await screen.findByRole("button", { name: `Shared access for ${file.name}` }));
      const dialog = screen.getByRole("dialog", { name: "Shared access" });
      fireEvent.click(within(dialog).getByRole("button", { name: "Copy link" }));
      await screen.findByText("The share link could not be copied.");
      await waitFor(() => expect(within(dialog).getByRole("button", { name: "Copy link" }).hasAttribute("disabled")).toBe(false));
      fireEvent.click(within(dialog).getByRole("button", { name: "Copy link" }));
      const input = await within(dialog).findByLabelText<HTMLInputElement>("Share link");
      expect(input.value).toBe("https://saturn.example/s/manual-copy");
      expect(input.readOnly).toBe(true);
      fireEvent.focus(input);
      expect(input.selectionEnd).toBe(input.value.length);
      expect(capability).toHaveBeenCalledTimes(2);
    } finally { Reflect.deleteProperty(navigator, "clipboard"); }
  });

  it("keeps the original Storage share details and controls", async () => {
    fixture("/files");
    vi.mocked(api.shares).mockResolvedValue([{ id: "original-share", resourceId: folder.id, resourceType: "folder", resourceName: folder.name, resourceSize: folder.sizeBytes, mode: "download_folder", state: "active", locked: false, downloadCount: 0, createdAt: now, updatedAt: now }]);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "[ Shared ]" }));
    const dialog = screen.getByRole("dialog", { name: "Share" });
    expect(dialog.classList.contains("storage-new-share-dialog")).toBe(false);
    expect(dialog.querySelector(".share-details")).toBeTruthy();
    expect(within(dialog).getByText("download folder")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Copy link" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Revoke" })).toBeTruthy();
  });

  it("targets versions and overwrite at the right-clicked file within a group selection", async () => {
    fixture(`/storage-new/${encodeURIComponent(folder.name)}`);
    const versions = vi.spyOn(api, "versions").mockResolvedValue([]);
    vi.mocked(uploadFile).mockResolvedValue(other);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: file.name }));
    fireEvent.click(screen.getByRole("button", { name: other.name }), { ctrlKey: true });
    fireEvent.contextMenu(screen.getByRole("article", { name: other.name }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Versions" }));
    await screen.findByRole("dialog", { name: `Versions — ${other.name}` });
    expect(versions).toHaveBeenCalledWith(other.id);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.contextMenu(screen.getByRole("article", { name: other.name }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Overwrite" }));
    const replacement = new File(["replacement"], other.name);
    fireEvent.change(screen.getByLabelText("Choose replacement file"), { target: { files: [replacement] } });
    await waitFor(() => expect(uploadFile).toHaveBeenCalledWith(replacement, folder.id, other.id, expect.any(Function)));
  });

  it("keeps group trash confirmation and clipboard paste available without a toolbar", async () => {
    fixture(`/storage-new/${encodeURIComponent(folder.name)}`);
    const copy = vi.spyOn(api, "copy").mockResolvedValue(file);
    const trash = vi.spyOn(api, "trashResource").mockResolvedValue(file);
    render(<App />);
    const card = await screen.findByRole("article", { name: file.name });
    fireEvent.contextMenu(card);
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Copy" }), { key: " ", code: "Space" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy" }));
    expect(document.activeElement).toBe(card);
    const grid = screen.getByLabelText("Stored files and folders");
    grid.focus(); fireEvent.keyDown(grid, { key: "ContextMenu" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Paste" }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith(file.id, folder.id));
    await waitFor(() => expect(screen.getByRole("button", { name: "Upload files" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: file.name }));
    fireEvent.click(screen.getByRole("button", { name: other.name }), { ctrlKey: true });
    fireEvent.contextMenu(screen.getByRole("article", { name: file.name }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(trash).not.toHaveBeenCalled();
    expect(within(screen.getByRole("dialog")).getByText(/2 item\(s\)/)).toBeTruthy();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Move to trash" }));
    await waitFor(() => expect(trash.mock.calls.map(([id]) => id)).toEqual([file.id, other.id]));
    expect(screen.queryByRole("toolbar", { name: "Selection actions" })).toBeNull();
  });

  it("does not send a drop to the previous folder while the new location is loading", async () => {
    const { resolve } = fixture(`/storage-new/${encodeURIComponent(folder.name)}`);
    render(<App />);
    await screen.findByRole("article", { name: file.name });
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
    const card = await screen.findByRole("article", { name: file.name });
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("link", { name: `Download ${file.name}` }).getAttribute("href")).toContain(`/files/${file.id}/content`);
    fireEvent.keyDown(card, { key: " ", code: "Space" }); fireEvent.keyDown(card, { key: "F10", shiftKey: true });
    expect(card.classList.contains("storage-new-file--selected")).toBe(true);
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(document.activeElement).toBe(card);
  });
});
