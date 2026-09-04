import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./app.js";
import { DROP_POINT_RESOURCE_ID } from "./types.js";

afterEach(() => { cleanup(); Reflect.deleteProperty(window.navigator, "clipboard"); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState({}, "", "/"); });

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function jsonRequestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
  const body: unknown = JSON.parse(init.body);
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("Expected a JSON object body");
  return body as Record<string, unknown>;
}

function preferences(overrides: Record<string, unknown> = {}) {
  return {
    accentColor: "#00a8ff",
    sidebarMode: "fixed",
    navigationOrder: ["dashboard", "files", "inbox", "shared", "trash", "settings"],
    dashboardOrder: ["cpu", "ram", "disk", "uptime", "storage", "drop", "reachability", "tasks"],
    settingsOrder: ["appearance", "security", "telegram", "backup", "updates", "logs"],
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function overview() {
  return {
    sampledAt: new Date().toISOString(),
    cpu: { state: "available", percent: 1, logicalCores: 8 },
    ram: { state: "available", usedBytes: 1, totalBytes: 100, percent: 1, processBytes: 1 },
    disk: { state: "unavailable", reason: "unavailable" },
    uptime: { state: "available", seconds: 10 },
    storage: { state: "available", indexedBytes: 1, fileCount: 1, capacity: { state: "unavailable", reason: "unavailable" } },
    transfers: { uploadBytesPerSecond: 128, downloadBytesPerSecond: 64, activeCount: 1, queuedCount: 1, tasks: [{ id: "task-1", direction: "upload", filename: "archive.bin", state: "uploading", transferredBytes: 50, totalBytes: 100, percent: 50, bytesPerSecond: 128, updatedAt: new Date().toISOString() }] },
  };
}

describe("owner Saturn UI", () => {
  it("renders an empty credential field and exchanges it for a session", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const url = requestUrl(input);
      if (url === "/health/ready") return json({ status: "ok" });
      if (url.endsWith("/auth/session")) return json({ code: "unauthorized" }, 401);
      if (url.endsWith("/auth/login")) return json({ state: "authenticated" });
      if (url.endsWith("/auth/preferences")) return json(preferences());
      if (url.endsWith("/operator/overview")) return json(overview());
      if (url.includes("/folders/resolve?")) return json([{ id: "00000000-0000-7000-8000-000000000001", type: "folder", name: "root", storagePath: "", sizeBytes: 0, status: "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]);
      if (url.includes("/resources/")) return json({ id: "00000000-0000-7000-8000-000000000001", type: "folder", name: "root", storagePath: "", sizeBytes: 0, status: "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      if (url.includes("/children")) return json([]);
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    const field = await screen.findByLabelText("Access Key");
    expect(field).toHaveProperty("value", "");
    fireEvent.change(field, { target: { value: "temporary-owner-proof" } });
    expect(field).toHaveProperty("value", "temporary-owner-proof");
    fireEvent.click(screen.getByRole("button", { name: "Enter service" }));
    expect(await screen.findByRole("heading", { name: "dashboard" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Tasks" })).toBeTruthy();
    expect(await screen.findByText("archive.bin")).toBeTruthy();
    expect(screen.getByText("50.0%")).toBeTruthy();
    expect(screen.getAllByText("128 B/s").length).toBeGreaterThan(0);
    expect(screen.getByRole("progressbar", { name: "archive.bin 50.0%" })).toHaveProperty("value", 50);
    const loginCall = fetchMock.mock.calls.find((call) => requestUrl(call[0]).endsWith("/auth/login"));
    expect(loginCall).toBeDefined();
    expect(jsonRequestBody(loginCall?.[1])).toEqual({ accessKey: "temporary-owner-proof" });
    expect(window.localStorage.length).toBe(0);
  });

  it("keeps the normative login composition stable and refocuses a rejected Access Key", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === "/health/ready") return json({ status: "ok" });
      if (url.endsWith("/auth/session")) return json({ code: "unauthorized" }, 401);
      if (url.endsWith("/auth/login")) return json({ code: "unauthorized" }, 401);
      return json({});
    }));

    render(<App />);
    const field = await screen.findByLabelText("Access Key");
    expect(screen.getByRole("heading", { name: "Saturn" })).toBeTruthy();
    expect(screen.getByRole("status", { name: "Service reachability: reachable" })).toBeTruthy();
    expect(field.getAttribute("type")).toBe("text");
    expect(field.getAttribute("autocomplete")).toBe("off");
    expect(field.getAttribute("placeholder")).toBe("Access Key...");

    fireEvent.change(field, { target: { value: "rejected-owner-proof" } });
    fireEvent.click(screen.getByRole("button", { name: "Enter service" }));

    expect((await screen.findByRole("alert")).textContent).toBe("The access key was not accepted.");
    expect(field).toHaveProperty("value", "");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect(screen.getByRole("status", { name: "Service reachability: reachable" })).toBeTruthy();
  });

  it("reports the storage readiness check independently from degraded gateway readiness", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === "/health/ready") return json({
        status: "degraded",
        checks: { database: { state: "pass" }, storage: { state: "pass" }, worker: { state: "fail" } },
      });
      if (url.endsWith("/auth/session")) return json({ state: "authenticated" });
      if (url.endsWith("/auth/preferences")) return json(preferences());
      if (url.endsWith("/operator/overview")) return json(overview());
      if (url.endsWith("/telegram/status")) return json({ provider: { state: "disabled" } });
      return json({});
    }));

    render(<App />);
    const title = await screen.findByRole("heading", { name: "Storage Reachability" });
    expect(title.parentElement?.textContent).toContain("Available");
    expect(title.parentElement?.textContent).toContain("SFTP storage readiness check");
    expect(title.parentElement?.classList.contains("metric--success")).toBe(true);
  });

  it("marks unavailable storage reachability in red", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === "/health/ready") return json({
        status: "degraded",
        checks: { database: { state: "pass" }, storage: { state: "fail" }, worker: { state: "pass" } },
      }, 503);
      if (url.endsWith("/auth/session")) return json({ state: "authenticated" });
      if (url.endsWith("/auth/preferences")) return json(preferences());
      if (url.endsWith("/operator/overview")) return json(overview());
      return json({});
    }));

    render(<App />);
    const title = await screen.findByRole("heading", { name: "Storage Reachability" });
    expect(title.parentElement?.textContent).toContain("Unavailable");
    expect(title.parentElement?.classList.contains("metric--danger")).toBe(true);
  });

  it("creates and copies a Drop point code directly from the dashboard", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText } });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const url = requestUrl(input);
      if (url === "/health/ready") return json({ status: "ok" });
      if (url.endsWith("/auth/session")) return json({ state: "authenticated" });
      if (url.endsWith("/auth/preferences")) return json(preferences());
      if (url.endsWith("/operator/overview")) return json(overview());
      if (url.endsWith("/drop/codes")) return json({ code: "ABCD-EFGH", expiresAt: "2026-09-02T12:05:00.000Z" }, 201);
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Create and copy Drop point code" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("ABCD-EFGH"));
    expect(screen.getByText("ABCD-EFGH")).toBeTruthy();
    const request = fetchMock.mock.calls.find((call) => requestUrl(call[0]).endsWith("/drop/codes"));
    expect(request?.[1]?.method).toBe("POST");
  });

  it("renders the authenticated collection toolbar and empty recovery state", async () => {
    window.history.replaceState({}, "", "/files");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === "/health/ready") return json({ status: "ok" });
      if (url.endsWith("/auth/session")) return json({ state: "authenticated" });
      if (url.endsWith("/auth/preferences")) return json(preferences());
      if (url.includes("/folders/resolve?")) return json([{ id: "00000000-0000-7000-8000-000000000001", type: "folder", name: "root", storagePath: "", sizeBytes: 0, status: "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]);
      if (url.includes("/resources/")) return json({ id: "00000000-0000-7000-8000-000000000001", type: "folder", name: "root", storagePath: "", sizeBytes: 0, status: "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      if (url.includes("/children")) return json([]);
      return json({});
    }));
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Storage" })).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "Search storage" })).toBeTruthy();
    expect(screen.getByText("0 items · 0 selected · 0 B")).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/Create arbitrary folders here/i)).toBeTruthy());
    const collection = document.querySelector(".storage-collection");
    if (collection === null) throw new Error("Storage collection is missing");
    fireEvent.contextMenu(collection);
    const contextMenu = screen.getByRole("menu", { name: "Folder actions" });
    expect([...contextMenu.querySelectorAll(".context-menu__ordinal")].map((item) => item.textContent)).toEqual(["1.", "2.", "3.", "4.", "5.", "6.", "7.", "8."]);
    expect(screen.getByRole("menuitem", { name: "New folder" })).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: "Upload here" })).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: "Quick upload" })).toBeNull();
    expect(screen.getByRole("navigation", { name: "Primary" }).querySelectorAll("button")).toHaveLength(6);
    expect(screen.queryByRole("button", { name: "Activity" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Laboratory" })).toBeNull();
  });

  it("renders the in-house Drop Point as a confined storage browser and an always-open upload channel", async () => {
    window.history.replaceState({}, "", "/inbox");
    const now = new Date().toISOString();
    const dropPoint = { id: DROP_POINT_RESOURCE_ID, type: "folder", name: "drop point", storagePath: "drop point", sizeBytes: 216 * 1024 ** 2, status: "active", createdAt: now, updatedAt: now } as const;
    const upload = { id: "01900000-0000-7000-8000-000000000040", parentId: DROP_POINT_RESOURCE_ID, type: "file", name: "incoming.bin", storagePath: "drop point/incoming.bin", mimeType: "application/octet-stream", sizeBytes: 1024, status: "active", createdAt: now, updatedAt: now } as const;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const url = requestUrl(input);
      if (url === "/health/ready") return json({ status: "ok", checks: { storage: { state: "pass" } } });
      if (url.endsWith("/auth/session")) return json({ state: "authenticated" });
      if (url.endsWith("/auth/preferences")) return json(preferences());
      if (url.includes("/folders/resolve?")) return json([dropPoint]);
      if (url.includes(`/folders/${DROP_POINT_RESOURCE_ID}/children`)) return json([upload]);
      if (url.endsWith("/shares")) return json([]);
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "drop point" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "incoming.bin" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "saturn drop point" })).toBeTruthy();
    expect(screen.getByText("root", { selector: ".breadcrumbs__boundary" })).toBeTruthy();
    expect(screen.getByText(/^drop point$/i, { selector: ".breadcrumbs span:not(.breadcrumbs__boundary):not(.breadcrumbs__separator)" })).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "Search storage" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Drop and drag files here/i })).toBeTruthy();
    expect(screen.getByText("Drop code status:").parentElement?.textContent).toContain("none");
    expect(screen.getByRole("status", { name: "Service Reachability: Available" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Upload here" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Quick upload" })).toBeNull();
    expect(screen.queryByLabelText("Drop code")).toBeNull();

    const resolveRequest = fetchMock.mock.calls.find((call) => requestUrl(call[0]).includes("/folders/resolve?"));
    expect(new URL(requestUrl(resolveRequest?.[0] ?? ""), "http://saturn.test").searchParams.get("rootId")).toBe(DROP_POINT_RESOURCE_ID);
  });

  it("renders searchable expandable Trash records and restores only after confirmation", async () => {
    window.history.replaceState({}, "", "/trash");
    const deletedAt = "2026-09-03T12:20:00.000Z";
    const purgeAt = "2026-12-02T12:20:00.000Z";
    const trashed = {
      id: "01900000-0000-7000-8000-000000000050",
      type: "folder",
      name: "archive-project",
      storagePath: "_system/trash/2026/09/01900000-0000-7000-8000-000000000050/archive-project",
      sizeBytes: 216 * 1024 ** 2,
      status: "trashed",
      trashedFromParentId: "00000000-0000-7000-8000-000000000007",
      trashedFromName: "archive project",
      purgeAfter: purgeAt,
      createdAt: deletedAt,
      updatedAt: deletedAt,
    } as const;
    let restored = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url === "/health/ready") return json({ status: "ok" });
      if (url.endsWith("/auth/session")) return json({ state: "authenticated" });
      if (url.endsWith("/auth/preferences")) return json(preferences());
      if (url.includes("/trash?")) return json(restored ? [] : [trashed]);
      if (url.endsWith(`/resources/${trashed.id}/restore`) && init?.method === "POST") { restored = true; return json({ ...trashed, name: trashed.trashedFromName, status: "active" }); }
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "trash" })).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "Search trash" })).toBeTruthy();
    expect((await screen.findByRole("button", { name: /archive project/i })).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("1 items · 216.0 MB · 90-day retention")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Quick upload" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete permanently" })).toBeNull();

    const record = screen.getByRole("button", { name: /archive project/i });
    fireEvent.click(record);
    expect(record.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Original folder ID")).toBeTruthy();
    expect(screen.getByText(trashed.trashedFromParentId)).toBeTruthy();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search trash" }), { target: { value: "missing" } });
    expect(screen.getByText("No matching trash records.")).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search trash" }), { target: { value: "archive" } });

    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(screen.getByRole("heading", { name: "Restore archive project" })).toBeTruthy();
    const dialog = document.querySelector(".dialog");
    const confirm = dialog?.querySelector<HTMLButtonElement>(".button--primary");
    if (confirm === undefined || confirm === null) throw new Error("Restore confirmation action is missing");
    fireEvent.click(confirm);

    await waitFor(() => expect(fetchMock.mock.calls.some((call) => requestUrl(call[0]).endsWith(`/resources/${trashed.id}/restore`) && call[1]?.method === "POST")).toBe(true));
    expect(await screen.findByText("No matching trash records.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /archive project/i })).toBeNull();
    expect(screen.getByText("0 items · 0 B · 90-day retention")).toBeTruthy();
  });

  it("permanently deletes a trashed file only after an irreversible-action warning", async () => {
    window.history.replaceState({}, "", "/trash");
    const deletedAt = "2026-09-03T12:20:00.000Z";
    const trashed = {
      id: "01900000-0000-7000-8000-000000000051",
      type: "file",
      name: "report.pdf",
      storagePath: "_system/trash/2026/09/01900000-0000-7000-8000-000000000051/report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 2048,
      status: "trashed",
      trashedFromParentId: "00000000-0000-7000-8000-000000000007",
      trashedFromName: "report.pdf",
      purgeAfter: "2026-12-02T12:20:00.000Z",
      createdAt: deletedAt,
      updatedAt: deletedAt,
    } as const;
    let purged = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url === "/health/ready") return json({ status: "ok" });
      if (url.endsWith("/auth/session")) return json({ state: "authenticated" });
      if (url.endsWith("/auth/preferences")) return json(preferences());
      if (url.includes("/trash?")) return json(purged ? [] : [trashed]);
      if (url.endsWith(`/trash/${trashed.id}`) && init?.method === "DELETE") {
        purged = true;
        return json({ ...trashed, status: "purged", purgeAfter: undefined });
      }
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Delete permanently" }));
    expect(screen.getByRole("heading", { name: "Delete report.pdf permanently" })).toBeTruthy();
    expect(screen.getByText(/permanently destroys the stored file bytes and every retained version/i)).toBeTruthy();
    expect(fetchMock.mock.calls.some((call) => requestUrl(call[0]).endsWith(`/trash/${trashed.id}`))).toBe(false);

    const confirm = document.querySelector<HTMLButtonElement>(".dialog .button--danger");
    if (confirm === null) throw new Error("Permanent-delete confirmation action is missing");
    fireEvent.click(confirm);

    await waitFor(() => expect(fetchMock.mock.calls.some((call) => requestUrl(call[0]).endsWith(`/trash/${trashed.id}`) && call[1]?.method === "DELETE")).toBe(true));
    expect(await screen.findByText("Trash is empty.")).toBeTruthy();
    expect(screen.queryByText("report.pdf")).toBeNull();
  });

  it("restores the owner navigation order and persists keyboard reordering", async () => {
    const now = new Date().toISOString();
    const initial = {
      accentColor: "#00a8ff",
      sidebarMode: "fixed",
      navigationOrder: ["inbox", "dashboard", "files", "shared", "trash", "settings"],
      dashboardOrder: ["cpu", "ram", "disk", "uptime", "storage", "drop", "reachability", "tasks"],
      settingsOrder: ["appearance", "security", "telegram", "backup", "updates", "logs"],
    } as const;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url === "/health/ready") return json({ status: "ok" });
      if (url.endsWith("/auth/session")) return json({ state: "authenticated" });
      if (url.endsWith("/auth/preferences") && init?.method === "PUT") return json({ ...jsonRequestBody(init), updatedAt: now });
      if (url.endsWith("/auth/preferences")) return json({ ...initial, updatedAt: now });
      if (url.endsWith("/operator/overview")) return json(overview());
      if (url.includes("/folders/resolve?")) return json([{ id: "00000000-0000-7000-8000-000000000001", type: "folder", name: "root", storagePath: "", sizeBytes: 0, status: "active", createdAt: now, updatedAt: now }]);
      if (url.includes("/resources/")) return json({ id: "00000000-0000-7000-8000-000000000001", type: "folder", name: "root", storagePath: "", sizeBytes: 0, status: "active", createdAt: now, updatedAt: now });
      if (url.includes("/children")) return json([]);
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    const navigation = await screen.findByRole("navigation", { name: "Primary" });
    await waitFor(() => expect(navigation.querySelector("button")?.getAttribute("aria-label")).toBe("Drop Point"));
    expect(screen.getByRole("button", { name: "Drop Point" }).textContent).toContain("04");
    fireEvent.keyDown(screen.getByRole("button", { name: "Drop Point" }), { key: "ArrowDown", altKey: true });

    await waitFor(() => {
      const request = fetchMock.mock.calls.find((call) => requestUrl(call[0]).endsWith("/auth/preferences") && call[1]?.method === "PUT");
      expect(request).toBeDefined();
      expect(jsonRequestBody(request?.[1]).navigationOrder).toEqual(["dashboard", "inbox", "files", "shared", "trash", "settings"]);
    });
    expect(navigation.querySelector("button")?.getAttribute("aria-label")).toBe("Dashboard");
  });

  it("persists all dashboard card positions and recomputes their ordinals", async () => {
    const now = new Date().toISOString();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url === "/health/ready") return json({ status: "ok" });
      if (url.endsWith("/auth/session")) return json({ state: "authenticated" });
      if (url.endsWith("/auth/preferences") && init?.method === "PUT") return json({ ...jsonRequestBody(init), updatedAt: now });
      if (url.endsWith("/auth/preferences")) return json(preferences({ updatedAt: now }));
      if (url.endsWith("/operator/overview")) return json(overview());
      if (url.endsWith("/telegram/status")) return json({ provider: { state: "disabled" } });
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Tasks" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("button", { name: "Reorder tasks card" }), { key: "ArrowUp", altKey: true });

    await waitFor(() => {
      const request = fetchMock.mock.calls.find((call) => requestUrl(call[0]).endsWith("/auth/preferences") && call[1]?.method === "PUT");
      expect(jsonRequestBody(request?.[1]).dashboardOrder).toEqual(["cpu", "ram", "disk", "uptime", "storage", "drop", "tasks", "reachability"]);
    });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Tasks" }).closest("article")?.textContent).toContain("07Tasks"));
  });

  it("keeps preinstalled roots renameable and copyable but not movable or trashable", async () => {
    window.history.replaceState({}, "", "/files");
    const now = new Date().toISOString();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === "/health/ready") return json({ status: "ok" });
      if (url.endsWith("/auth/session")) return json({ state: "authenticated" });
      if (url.endsWith("/auth/preferences")) return json(preferences({ updatedAt: now }));
      if (url.includes("/folders/resolve?")) return json([{ id: "00000000-0000-7000-8000-000000000001", type: "folder", name: "root", storagePath: "", sizeBytes: 0, status: "active", createdAt: now, updatedAt: now }]);
      if (url.includes("/folders/") && url.includes("/children")) return json([
        { id: "00000000-0000-7000-8000-000000000004", parentId: "00000000-0000-7000-8000-000000000001", type: "folder", name: "sync", storagePath: "sync", sizeBytes: 144_076, status: "active", createdAt: now, updatedAt: now },
        { id: "01900000-0000-7000-8000-000000000001", parentId: "00000000-0000-7000-8000-000000000001", type: "folder", name: "ordinary", storagePath: "ordinary", sizeBytes: 0, status: "active", createdAt: now, updatedAt: now },
      ]);
      if (url.includes("/resources/")) return json({ id: "00000000-0000-7000-8000-000000000001", type: "folder", name: "root", storagePath: "", sizeBytes: 0, status: "active", createdAt: now, updatedAt: now });
      return json({});
    }));
    render(<App />);

    await waitFor(() => expect(document.querySelector(".storage-meta")?.textContent).toBe("2 items · 0 selected · 140.7 KB"));
    expect(screen.getByText("140.7 KB")).toBeTruthy();
    fireEvent.click(await screen.findByLabelText("Select sync"));
    const trashAction = screen.getAllByRole("button", { name: "Trash" }).find((button) => button.classList.contains("danger-link"));
    if (trashAction === undefined) throw new Error("Selection trash action is missing");
    expect(screen.getByRole("button", { name: "Rename" })).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: "Move" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Copy" })).toHaveProperty("disabled", false);
    expect(trashAction).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByLabelText("Select sync"));
    fireEvent.click(screen.getByLabelText("Select ordinary"));
    expect(screen.getByRole("button", { name: "Move" })).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: "Copy" })).toHaveProperty("disabled", false);
    expect(trashAction).toHaveProperty("disabled", false);
  });

  it("selects an inclusive visible range with Shift", async () => {
    window.history.replaceState({}, "", "/files");
    const now = new Date().toISOString();
    const rootId = "00000000-0000-7000-8000-000000000001";
    const names = ["alpha", "bravo", "charlie", "delta", "echo"];
    const children = names.map((name, index) => ({
      id: `01900000-0000-7000-8000-00000000000${String(index + 1)}`,
      parentId: rootId,
      type: "folder",
      name,
      storagePath: name,
      sizeBytes: 0,
      status: "active",
      createdAt: now,
      updatedAt: now,
    }));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === "/health/ready") return json({ status: "ok" });
      if (url.endsWith("/auth/session")) return json({ state: "authenticated" });
      if (url.endsWith("/auth/preferences")) return json(preferences({ updatedAt: now }));
      if (url.includes("/folders/resolve?")) return json([{ id: rootId, type: "folder", name: "root", storagePath: "", sizeBytes: 0, status: "active", createdAt: now, updatedAt: now }]);
      if (url.includes("/folders/") && url.includes("/children")) return json(children);
      return json({});
    }));
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /bravo/i }));
    fireEvent.click(screen.getByRole("button", { name: /delta/i }), { shiftKey: true });

    await waitFor(() => expect(document.querySelector(".storage-meta")?.textContent).toContain("3 selected"));
    expect(screen.getByLabelText("Select alpha")).toHaveProperty("checked", false);
    expect(screen.getByLabelText("Select bravo")).toHaveProperty("checked", true);
    expect(screen.getByLabelText("Select charlie")).toHaveProperty("checked", true);
    expect(screen.getByLabelText("Select delta")).toHaveProperty("checked", true);
    expect(screen.getByLabelText("Select echo")).toHaveProperty("checked", false);
  });

  it("renders the Shared template with access status, sorts its table columns, and expands policy details", async () => {
    window.history.replaceState({}, "", "/shared");
    const older = "2026-09-02T11:29:00.000Z";
    const newer = "2026-09-03T16:14:00.000Z";
    const shares = [
      { id: "01900000-0000-7000-8000-000000000202", resourceId: "01900000-0000-7000-8000-000000000302", resourceType: "file", resourceName: "zeta-report.pdf", resourceSize: 144_076, resourceMimeType: "application/pdf", mode: "download", state: "active", locked: false, downloadCount: 2, createdAt: newer, updatedAt: newer },
      { id: "01900000-0000-7000-8000-000000000201", resourceId: "01900000-0000-7000-8000-000000000301", resourceType: "folder", resourceName: "alpha archive", resourceSize: 0, mode: "browse", state: "active", locked: true, expiresAt: "2026-09-08T00:00:00.000Z", downloadCount: 0, createdAt: older, updatedAt: older },
    ] as const;
    let revokeAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url === "/health/ready") return json({ status: "ok" });
      if (url.endsWith("/auth/session")) return json({ state: "authenticated" });
      if (url.endsWith("/auth/preferences")) return json(preferences({ updatedAt: newer }));
      if (url.endsWith(`/shares/${shares[1].id}`) && init?.method === "DELETE") {
        revokeAttempts += 1;
        return json({ ...shares[1], state: "revoked", updatedAt: newer });
      }
      if (url.includes("/shares?")) return json(shares);
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "shared" })).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "Search shared objects" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Quick upload" })).toBeNull();
    expect(screen.queryByText("Create by resource ID")).toBeNull();
    await waitFor(() => expect([...document.querySelectorAll(".share-owner-row__name")].map((item) => item.textContent)).toEqual(["zeta-report.pdf", "alpha archive"]));
    expect([...document.querySelectorAll(".share-owner-row__access")].map((item) => item.textContent)).toEqual(["Download", "Browse"]);

    const modifiedSort = screen.getByRole("button", { name: "Modified" });
    expect(modifiedSort.getAttribute("aria-sort")).toBe("descending");
    fireEvent.click(modifiedSort);
    expect([...document.querySelectorAll(".share-owner-row__name")].map((item) => item.textContent)).toEqual(["alpha archive", "zeta-report.pdf"]);
    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    expect([...document.querySelectorAll(".share-owner-row__name")].map((item) => item.textContent)).toEqual(["alpha archive", "zeta-report.pdf"]);
    expect(document.querySelector(".share-owner-row__name--folder")?.textContent).toBe("alpha archive");

    fireEvent.click(screen.getByRole("button", { name: /alpha archive/i }));
    expect(screen.getByText("Password").parentElement?.textContent).toContain("On");
    expect(screen.getByText("Expires at").parentElement?.textContent).not.toContain("None");
    expect(screen.getByText(/You can still revoke access/i)).toBeTruthy();
    for (const button of screen.getAllByRole("button", { name: "Copy link" })) expect(button).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(revokeAttempts).toBe(1));
    await waitFor(() => expect(screen.queryByText("alpha archive")).toBeNull());
    expect(screen.queryByLabelText("Revoke Access Key")).toBeNull();
    expect(fetchMock.mock.calls.some((call) => requestUrl(call[0]).endsWith("/auth/reauthenticate"))).toBe(false);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search shared objects" }), { target: { value: "zeta" } });
    expect([...document.querySelectorAll(".share-owner-row__name")].map((item) => item.textContent)).toEqual(["zeta-report.pdf"]);
  });

  it("creates a password-protected share without requesting the Access Key again", async () => {
    window.history.replaceState({}, "", "/files");
    const now = new Date().toISOString();
    const rootId = "00000000-0000-7000-8000-000000000001";
    const file = { id: "01900000-0000-7000-8000-000000000101", parentId: rootId, type: "file", name: "report.pdf", storagePath: "report.pdf", sizeBytes: 1024, mimeType: "application/pdf", status: "active", createdAt: now, updatedAt: now } as const;
    const createdShare = { id: "01900000-0000-7000-8000-000000000102", resourceId: file.id, resourceType: "file", resourceName: file.name, resourceSize: file.sizeBytes, resourceMimeType: file.mimeType, mode: "download", state: "active", locked: false, downloadCount: 0, createdAt: now, updatedAt: now } as const;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url === "/health/ready") return json({ status: "ok" });
      if (url.endsWith("/auth/session")) return json({ state: "authenticated" });
      if (url.endsWith("/auth/preferences")) return json(preferences({ updatedAt: now }));
      if (url.endsWith("/shares") && init?.method === "POST") {
        return json({ token: "share-token", url: "http://saturn.test/s/share-token", share: { ...createdShare, locked: true } }, 201);
      }
      if (url.includes("/shares?")) return json([]);
      if (url.includes("/folders/resolve?")) return json([{ id: rootId, type: "folder", name: "root", storagePath: "", sizeBytes: 1024, status: "active", createdAt: now, updatedAt: now }]);
      if (url.includes("/folders/") && url.includes("/children")) return json([file]);
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    fireEvent.click(await screen.findByLabelText("Select report.pdf"));
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    fireEvent.change(await screen.findByLabelText("Password"), { target: { value: "protected-share-password" } });
    fireEvent.click(await screen.findByRole("button", { name: "Create share" }));

    expect(await screen.findByLabelText("Share link")).toHaveProperty("value", "http://saturn.test/s/share-token");
    expect(screen.queryByLabelText("Share Access Key")).toBeNull();
    expect(fetchMock.mock.calls.some((call) => requestUrl(call[0]).endsWith("/auth/reauthenticate"))).toBe(false);
    const createCall = fetchMock.mock.calls.find((call) => requestUrl(call[0]).endsWith("/shares") && call[1]?.method === "POST");
    expect(jsonRequestBody(createCall?.[1])).toMatchObject({ resourceId: file.id, mode: "download", password: "protected-share-password" });

    fireEvent.click(screen.getByRole("button", { name: "Shared" }));
    expect(await screen.findByRole("heading", { name: "shared" })).toBeTruthy();
  });

  it("restores a nested Files folder from the URL and follows browser history", async () => {
    const now = new Date().toISOString();
    const root = { id: "00000000-0000-7000-8000-000000000001", type: "folder", name: "root", storagePath: "", sizeBytes: 0, status: "active", createdAt: now, updatedAt: now } as const;
    const archive = { ...root, id: "01900000-0000-7000-8000-000000000010", parentId: root.id, name: "archive", storagePath: "archive" } as const;
    const photos = { ...root, id: "01900000-0000-7000-8000-000000000011", parentId: archive.id, name: "photos 2026", storagePath: "archive/photos 2026" } as const;
    window.history.replaceState({}, "", "/files/archive");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const url = requestUrl(input);
      if (url === "/health/ready") return json({ status: "ok" });
      if (url.endsWith("/auth/session")) return json({ state: "authenticated" });
      if (url.endsWith("/auth/preferences")) return json(preferences({ updatedAt: now }));
      if (url.includes("/folders/resolve?")) {
        const path = new URL(url, "http://saturn.test").searchParams.get("path");
        return json(path === "archive/photos 2026" ? [root, archive, photos] : [root, archive]);
      }
      if (url.includes(`/folders/${archive.id}/children`)) return json([photos]);
      if (url.includes(`/folders/${photos.id}/children`)) return json([]);
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    expect(await screen.findByText("archive", { selector: ".breadcrumbs span" })).toBeTruthy();
    fireEvent.doubleClick(await screen.findByRole("button", { name: /photos 2026/i }));
    await waitFor(() => expect(window.location.pathname).toBe("/files/archive/photos%202026"));
    expect(await screen.findByText("photos 2026", { selector: ".breadcrumbs span" })).toBeTruthy();

    const popped = new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
    window.history.back();
    await popped;
    await waitFor(() => expect(window.location.pathname).toBe("/files/archive"));
    expect(await screen.findByText("archive", { selector: ".breadcrumbs span" })).toBeTruthy();
  });

  it("renders the six Saturn Settings cards and persists keyboard card order", async () => {
    window.history.replaceState({}, "", "/settings");
    const now = new Date().toISOString();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url === "/health/ready") return json({ status: "ok" });
      if (url.endsWith("/auth/session")) return json({ state: "authenticated" });
      if (url.endsWith("/auth/preferences") && init?.method === "PUT") return json({ ...jsonRequestBody(init), updatedAt: now });
      if (url.endsWith("/auth/preferences")) return json(preferences({ updatedAt: now }));
      if (url.endsWith("/operator/kernel")) return json({ configured: false, reachability: "unavailable", revision: 1 });
      if (url.endsWith("/operator/recovery")) return json({ exportEnabled: false, restoreEnabled: false, reason: "not configured" });
      if (url.endsWith("/operator/updates")) return json({ installedVersion: "0.1.0", updater: { state: "unavailable" }, registry: { state: "unavailable" }, discoveryEnabled: false });
      if (url.includes("/activity")) return json([]);
      if (url.endsWith("/telegram/status")) return json({ provider: { state: "disabled" } });
      if (url.includes("/devices")) return json([]);
      if (url.includes("/backup-services")) return json([]);
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "settings" })).toBeTruthy();
    for (const title of ["Appearance", "Security", "Telegram bot connection", "Backup", "Updates", "Logs"]) expect(screen.getByRole("heading", { name: title })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Accent color"), { target: { value: "#111111" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply color" }));
    expect(await screen.findByText("Accent color applied.")).toBeTruthy();
    await waitFor(() => {
      const request = fetchMock.mock.calls.find((call) => requestUrl(call[0]).endsWith("/auth/preferences") && call[1]?.method === "PUT" && jsonRequestBody(call[1]).accentColor === "#111111");
      expect(request).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Start Access Key change" }));
    const accessKeyDialog = within(screen.getByRole("dialog", { name: "Change Access Key" }));
    expect(accessKeyDialog.getByLabelText("Current Access Key")).toHaveProperty("value", "");
    expect(accessKeyDialog.getByLabelText("New Access Key")).toHaveProperty("value", "");
    expect(accessKeyDialog.getByLabelText("Confirm new Access Key")).toHaveProperty("value", "");
    fireEvent.click(accessKeyDialog.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Reorder security settings card" }), { key: "ArrowUp", altKey: true });
    await waitFor(() => {
      const request = fetchMock.mock.calls.find((call) => {
        if (!requestUrl(call[0]).endsWith("/auth/preferences") || call[1]?.method !== "PUT") return false;
        const body = jsonRequestBody(call[1]);
        return Array.isArray(body.settingsOrder) && body.settingsOrder[0] === "security";
      });
      expect(jsonRequestBody(request?.[1]).settingsOrder).toEqual(["security", "appearance", "telegram", "backup", "updates", "logs"]);
    });
  });

  it("keeps storage credentials write-only and requires owner proof plus a fresh connection test", async () => {
    window.history.replaceState({}, "", "/settings");
    const now = new Date().toISOString();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const url = requestUrl(input);
      if (url === "/health/ready") return json({ status: "ok" });
      if (url.endsWith("/auth/session")) return json({ state: "authenticated" });
      if (url.endsWith("/auth/preferences")) return json(preferences({ updatedAt: now }));
      if (url.endsWith("/auth/reauthenticate")) return json({ state: "authenticated" });
      if (url.endsWith("/operator/storage/test")) return json({ host: "new.example", port: 22, username: "sub2", root: ".", hostFingerprint: `SHA256:${"A".repeat(43)}`, authMode: "password_file", credentialConfigured: true, reachability: "ready" });
      if (url.endsWith("/operator/storage")) return json({ profileId: "bootstrap", revision: 1, activatedAt: now, source: "bootstrap", host: "old.example", port: 22, username: "sub1", root: ".", hostFingerprint: `SHA256:${"B".repeat(43)}`, authMode: "password_file", credentialConfigured: true, reachability: "ready" });
      if (url.endsWith("/operator/kernel")) return json({ configured: false, reachability: "unavailable", revision: 1 });
      if (url.endsWith("/operator/recovery")) return json({ exportEnabled: false, restoreEnabled: false, reason: "not configured" });
      if (url.endsWith("/operator/updates")) return json({ installedVersion: "0.1.0", updater: { state: "unavailable" }, registry: { state: "unavailable" }, discoveryEnabled: false });
      if (url.includes("/activity")) return json([]);
      if (url.endsWith("/telegram/status")) return json({ provider: { state: "disabled" } });
      if (url.includes("/devices") || url.includes("/backup-services")) return json([]);
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    expect(await screen.findByText(/sub1@old\.example:22/)).toBeTruthy();
    fireEvent.click(screen.getByText("Advanced security and owner proof"));
    const configure = screen.getByRole("button", { name: "Configure storage" });
    expect(configure).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText("Current Access Key"), { target: { value: "owner-proof" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify owner" }));
    await waitFor(() => expect(configure).toHaveProperty("disabled", false));
    fireEvent.click(configure);
    const dialog = within(screen.getByRole("dialog", { name: "Configure storage" }));
    expect(dialog.getByLabelText("New storage password")).toHaveProperty("value", "");
    expect(dialog.getByLabelText("Host")).toHaveProperty("value", "old.example");
    fireEvent.change(dialog.getByLabelText("Host"), { target: { value: "new.example" } });
    fireEvent.change(dialog.getByLabelText("User"), { target: { value: "sub2" } });
    fireEvent.change(dialog.getByLabelText("Pinned host fingerprint"), { target: { value: `SHA256:${"A".repeat(43)}` } });
    fireEvent.change(dialog.getByLabelText("New storage password"), { target: { value: "write-only-secret" } });
    fireEvent.click(dialog.getByRole("button", { name: "Test connection" }));
    expect(await dialog.findByText(/Connection verified/)).toBeTruthy();
    const testCall = fetchMock.mock.calls.find((call) => requestUrl(call[0]).endsWith("/operator/storage/test"));
    expect(jsonRequestBody(testCall?.[1])).toMatchObject({ host: "new.example", username: "sub2", credential: "write-only-secret" });
    expect(dialog.getByRole("button", { name: "Switch without migration" })).toHaveProperty("disabled", true);
    fireEvent.click(dialog.getByRole("checkbox"));
    expect(dialog.getByRole("button", { name: "Switch without migration" })).toHaveProperty("disabled", false);
  });

  it("creates a snapshot in one action and validates a local ZIP before confirmed restore", async () => {
    window.history.replaceState({}, "", "/settings");
    const now = new Date().toISOString();
    const createObjectUrl = vi.fn(() => "blob:saturn-snapshot");
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url === "/health/ready") return json({ status: "ok" });
      if (url.endsWith("/auth/session")) return json({ state: "authenticated" });
      if (url.endsWith("/auth/preferences")) return json(preferences({ updatedAt: now }));
      if (url.endsWith("/operator/recovery/snapshots")) return new Response("zip", { headers: { "content-type": "application/zip", "content-disposition": "attachment; filename=\"saturn-snapshot.zip\"", "x-saturn-created-at": now } });
      if (url.endsWith("/operator/recovery/restores") && init?.method === "POST") return json({ id: "restore-1", filename: "snapshot.zip", archiveBytes: 2050, state: "uploading" });
      if (url.endsWith("/operator/recovery/restores/restore-1") && init?.method === "PATCH") return new Response(null, { status: 204 });
      if (url.endsWith("/operator/recovery/restores/restore-1/validate")) return json({ id: "restore-1", filename: "snapshot.zip", archiveBytes: 2050, archiveSha256: "a".repeat(64), schema: "vault.backup.v1", backupId: "backup-1", createdAt: now, memberCount: 20, state: "ready" });
      if (url.endsWith("/operator/recovery/restores/restore-1/apply")) return json({ backupId: "backup-1", mode: "replace", startedAt: now, finishedAt: now, measuredRpoMs: 1, measuredRtoMs: 25, verification: { resources: 6, versions: 2, auditEvents: 1, migrations: 23 } });
      if (url.endsWith("/operator/recovery")) return json({ exportEnabled: true, restoreEnabled: true, busy: false, maxArchiveBytes: 1024 * 1024, maxChunkBytes: 1024 });
      if (url.endsWith("/operator/kernel")) return json({ configured: false, reachability: "unavailable", revision: 1 });
      if (url.endsWith("/operator/updates")) return json({ installedVersion: "0.1.0", updater: { state: "unavailable" }, registry: { state: "unavailable" }, discoveryEnabled: false });
      if (url.includes("/activity")) return json([]);
      if (url.endsWith("/telegram/status")) return json({ provider: { state: "disabled" } });
      if (url.includes("/devices") || url.includes("/backup-services")) return json([]);
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    const createSnapshot = await screen.findByRole("button", { name: "Create and download snapshot" });
    await waitFor(() => expect(createSnapshot).toHaveProperty("disabled", false));
    fireEvent.click(createSnapshot);
    await waitFor(() => expect(createObjectUrl).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/created.*downloaded/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Restore snapshot" }));
    const dialog = within(screen.getByRole("dialog", { name: "Restore snapshot" }));
    fireEvent.change(dialog.getByLabelText("Choose snapshot"), { target: { files: [new File([new Uint8Array(2050)], "snapshot.zip", { type: "application/zip" })] } });
    expect(await dialog.findByText("vault.backup.v1")).toBeTruthy();
    const chunks = fetchMock.mock.calls.filter((call) => requestUrl(call[0]).endsWith("/operator/recovery/restores/restore-1") && call[1]?.method === "PATCH");
    expect(chunks.map((call) => new Headers(call[1]?.headers).get("Upload-Offset"))).toEqual(["0", "1024", "2048"]);
    expect(chunks.map((call) => (call[1]?.body as Blob).size)).toEqual([1024, 1024, 2]);
    const confirmation = dialog.getByRole("checkbox");
    fireEvent.click(confirmation);
    fireEvent.click(dialog.getByRole("button", { name: "Restore and replace" }));
    expect(await dialog.findByText(/Restore complete/i)).toBeTruthy();
    expect(dialog.getByText(/resources/i)).toBeTruthy();
  });
});

describe("public Drop UI", () => {
  it("renders the closed gate and redeems a body-only code into the opened upload-only template", async () => {
    window.history.replaceState({}, "", "/drop");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const url = requestUrl(input);
      if (url === "/health/ready") return json({ status: "ok" });
      if (url.endsWith("/drop/session")) return json({ code: "unauthorized" }, 401);
      if (url.endsWith("/drop/redeem")) return json({ state: "upload_only", channelId: "channel-shared", expiresAt: new Date(Date.now() + 60_000).toISOString(), maxFiles: 20, maxBytes: 1024 });
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    const field = await screen.findByLabelText("Drop code");
    expect(field).toHaveProperty("value", "");
    expect(field.getAttribute("placeholder")).toBe("Code...");
    expect(screen.getByText(/drop point code/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Enter" })).toHaveProperty("disabled", false);
    expect(screen.getByRole("status", { name: "Service Reachability: Available" })).toBeTruthy();
    fireEvent.change(field, { target: { value: "ABCD-EFGH" } });
    fireEvent.click(screen.getByRole("button", { name: "Enter" }));
    expect(await screen.findByRole("heading", { name: "saturn drop point" })).toBeTruthy();
    expect(screen.getByText("Upload only Gateway")).toBeTruthy();
    expect(screen.getByText("This page cannot list Saturn contents. Files uploaded through this Drop code appear here on every connected device.")).toBeTruthy();
    expect(screen.getByText("Drop code status:").parentElement?.textContent).toMatch(/\d{2}:\d{2}/);
    expect(screen.getByRole("button", { name: /Drop and drag files here/i })).toBeTruthy();
    expect(screen.getByRole("status", { name: "Service Reachability: Available" })).toBeTruthy();
    const redeemCall = fetchMock.mock.calls.find((call) => requestUrl(call[0]).endsWith("/drop/redeem"));
    expect(redeemCall?.[1]?.body).toBe(JSON.stringify({ code: "ABCD-EFGH" }));
    expect(window.localStorage.length + window.sessionStorage.length).toBe(0);
    expect(window.history.state).toMatchObject({ saturnDropChannelId: "channel-shared" });
  });

  it("uses the Storage drag overlay and marks stored upload rows as successful", async () => {
    window.history.replaceState({}, "", "/drop");
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === "/health/ready") return json({ status: "ok" });
      if (url.endsWith("/drop/session")) return json({ state: "upload_only", channelId: "channel-live", expiresAt, maxFiles: 20, maxBytes: 100 * 1024 ** 3, buffer: { state: "available", reservedBytes: 100, maxBytes: 110 * 1024 ** 3, freeBytes: 200 * 1024 ** 3, ratio: 0.1 } });
      if (url.endsWith("/drop/uploads")) return json([
        { id: "stored-upload", filename: "stored.bin", state: "stored", expectedSize: 100, receivedSize: 100, expiresAt, completed: true },
        { id: "active-upload", filename: "active.bin", state: "uploading", expectedSize: 100, receivedSize: 50, expiresAt, completed: false },
      ]);
      return json({});
    }));
    render(<App />);

    const storedName = await screen.findByText("stored.bin");
    const storedRow = storedName.closest(".drop-job");
    expect(storedRow?.classList.contains("drop-job--stored")).toBe(true);
    expect(storedRow?.querySelector("progress")).toHaveProperty("value", 1);
    expect(storedRow?.querySelector("strong")?.textContent).toBe("stored");
    expect(screen.getByText("active.bin").closest(".drop-job")?.classList.contains("drop-job--stored")).toBe(false);

    const dropView = document.querySelector(".drop-view");
    if (dropView === null) throw new Error("Drop view is missing");
    fireEvent.dragEnter(dropView, { dataTransfer: { types: ["Files"] } });
    expect(screen.getByText("UPLOAD HERE").closest(".storage-drop-overlay")).toBeTruthy();
    fireEvent.dragLeave(dropView, { dataTransfer: { types: ["Files"] } });
    expect(screen.queryByText("UPLOAD HERE")).toBeNull();
  });

  it("applies real-time upload snapshots from another client in the same channel", async () => {
    window.history.replaceState({}, "", "/drop");
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    class FakeEventSource {
      static latest: FakeEventSource | undefined;
      readonly listeners = new Map<string, Array<EventListenerOrEventListenerObject>>();
      readonly close = vi.fn();
      constructor(readonly url: string) { FakeEventSource.latest = this; }
      addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]);
      }
      emit(type: string, data: unknown) {
        const event = { data: JSON.stringify(data) } as MessageEvent<string>;
        for (const listener of this.listeners.get(type) ?? []) {
          if (typeof listener === "function") listener(event);
          else listener.handleEvent(event);
        }
      }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === "/health/ready") return json({ status: "ok" });
      if (url.endsWith("/drop/session")) return json({ state: "upload_only", channelId: "channel-realtime", expiresAt, maxFiles: 20, maxBytes: 1024 });
      if (url.endsWith("/drop/uploads")) return json([]);
      return json({});
    }));
    render(<App />);

    expect(await screen.findByRole("heading", { name: "saturn drop point" })).toBeTruthy();
    await waitFor(() => expect(FakeEventSource.latest?.url).toBe("/api/v1/drop/events?channelId=channel-realtime"));
    act(() => FakeEventSource.latest?.emit("uploads", [
      { id: "peer-upload", filename: "from-other-device.bin", state: "uploading", expectedSize: 100, receivedSize: 40, expiresAt, completed: false },
    ]));
    expect(await screen.findByText("from-other-device.bin")).toBeTruthy();
    expect(screen.getByText("from-other-device.bin").closest(".drop-job")?.querySelector("progress")).toHaveProperty("value", 0.4);
  });

  it("does not adopt another Drop channel from a cookie shared by a different tab", async () => {
    window.history.replaceState({ saturnDropChannelId: "channel-for-this-tab" }, "", "/drop");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const url = requestUrl(input);
      if (url === "/health/ready") return json({ status: "ok" });
      if (url.endsWith("/drop/session")) return json({ state: "upload_only", channelId: "channel-from-another-tab", expiresAt: new Date(Date.now() + 60_000).toISOString(), maxFiles: 20, maxBytes: 1024 });
      if (url.endsWith("/drop/uploads")) return json([]);
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    expect(await screen.findByLabelText("Drop code")).toBeTruthy();
    expect(screen.getByText(/This tab's Drop session has expired/i)).toBeTruthy();
    expect(fetchMock.mock.calls.some((call) => requestUrl(call[0]).endsWith("/drop/uploads"))).toBe(false);
    const sessionCall = fetchMock.mock.calls.find((call) => requestUrl(call[0]).endsWith("/drop/session"));
    expect(new Headers(sessionCall?.[1]?.headers).get("X-Saturn-Drop-Channel")).toBe("channel-for-this-tab");
  });
});

describe("public Share UI", () => {
  it("renders the opened shared-file template without browser persistence", async () => {
    const token = "A".repeat(43);
    window.history.replaceState({}, "", `/s/${token}`);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === "/health/ready") return json({ status: "ok", checks: { storage: { state: "pass" } } });
      if (url.includes("/public/shares/")) return json({ id: "share", resourceId: "file", resourceType: "file", resourceName: "report.pdf", resourceSize: 1024, resourceMimeType: "application/pdf", mode: "view", state: "active", locked: false, downloadCount: 0, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" });
      return json({});
    }));
    render(<App />);
    expect(await screen.findByRole("heading", { name: "saturn shared link" })).toBeTruthy();
    expect(screen.getByText("View only Gateway")).toBeTruthy();
    expect(screen.getByText(/can still be copied/i)).toBeTruthy();
    expect(screen.getByText("Shared link expires:").parentElement?.textContent).toContain("none");
    expect(screen.getByRole("status", { name: "Service Reachability: Available" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open report.pdf" }).getAttribute("href")).toContain(token);
    expect(screen.getByRole("link", { name: /Open file - 1.00 KiB/i }).getAttribute("href")).toContain(token);
    expect(window.localStorage.length + window.sessionStorage.length).toBe(0);
  });

  it("renders the compact closed template and unlocks only with its share password", async () => {
    const token = "B".repeat(43);
    window.history.replaceState({}, "", `/s/${token}`);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url === "/health/ready") return json({ status: "ok" });
      if (url.endsWith("/unlock") && init?.method === "POST") return json({ id: "share", resourceId: "file", resourceType: "file", resourceName: "secure.zip", resourceSize: 2048, mode: "download", state: "active", locked: false, downloadCount: 0, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" });
      if (url.includes("/public/shares/")) return json({ id: "share", resourceId: "file", resourceType: "file", resourceName: "secure.zip", resourceSize: 2048, mode: "download", state: "active", locked: true, downloadCount: 0, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" });
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    expect(await screen.findByText(/Please enter/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "saturn shared link" })).toBeNull();
    expect(screen.getByRole("status", { name: "Service Reachability: Available" })).toBeTruthy();
    const password = screen.getByLabelText("Shared link password");
    expect(password.getAttribute("placeholder")).toBe("Password...");
    fireEvent.change(password, { target: { value: "correct-share-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Enter" }));

    expect(await screen.findByRole("heading", { name: "saturn shared link" })).toBeTruthy();
    const unlockCall = fetchMock.mock.calls.find((call) => requestUrl(call[0]).endsWith("/unlock"));
    expect(jsonRequestBody(unlockCall?.[1])).toEqual({ password: "correct-share-password" });
    expect(window.localStorage.length + window.sessionStorage.length).toBe(0);
  });

  it("lists cached folder sizes and prepares then downloads a package with one click", async () => {
    const token = "C".repeat(43);
    window.history.replaceState({}, "", `/s/${token}`);
    let downloadedHref = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloadedHref = this.getAttribute("href") ?? "";
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url === "/health/ready") return json({ status: "ok" });
      if (url.endsWith("/package") && init?.method === "POST") return json({ state: "ready", sizeBytes: 2304 });
      if (url.includes("/children")) return json([
        { id: "folder-1", type: "folder", name: "folder_1", sizeBytes: 2048, updatedAt: "2026-09-01T00:00:00.000Z" },
        { id: "file-1", type: "file", name: "notes.txt", sizeBytes: 256, updatedAt: "2026-09-01T00:00:00.000Z" },
      ]);
      if (url.includes("/public/shares/")) return json({ id: "share", resourceId: "folder-root", resourceType: "folder", resourceName: "archive", resourceSize: 2304, mode: "download_folder", state: "active", locked: false, downloadCount: 0, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" });
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    expect(await screen.findByRole("button", { name: "folder_1" })).toBeTruthy();
    expect(screen.getByText("2.00 KiB")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Download notes.txt" }).getAttribute("href")).toContain("file-1");
    fireEvent.click(screen.getByRole("button", { name: /Download all - 2.25 KiB/i }));
    await waitFor(() => expect(downloadedHref).toBe(`/api/v1/public/shares/${token}/package`));
    expect(screen.getByRole("button", { name: /Download all - 2.25 KiB/i })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Download all - 2.25 KiB/i })).toBeNull();
    expect(fetchMock.mock.calls.filter((call) => requestUrl(call[0]).endsWith("/package") && call[1]?.method === "POST")).toHaveLength(1);
  });

  it("blocks all downloads in browse mode while keeping folder navigation available", async () => {
    const token = "D".repeat(43);
    window.history.replaceState({}, "", `/s/${token}`);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === "/health/ready") return json({ status: "ok" });
      if (url.includes("/children")) return json([
        { id: "file-2", type: "file", name: "readme.txt", sizeBytes: 512, updatedAt: "2026-09-01T00:00:00.000Z" },
      ]);
      if (url.includes("/public/shares/")) return json({ id: "share", resourceId: "folder-root", resourceType: "folder", resourceName: "archive", resourceSize: 512, mode: "browse", state: "active", locked: false, downloadCount: 0, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" });
      return json({});
    }));
    render(<App />);

    expect(await screen.findByText("readme.txt")).toBeTruthy();
    expect(document.querySelector(".share-public-notice p")?.textContent).toContain("Download permission is not granted for this link.");
    expect(screen.queryByRole("link", { name: "Download readme.txt" })).toBeNull();
    const downloadAll = screen.getByRole("button", { name: "Download all - 512 B" });
    expect(downloadAll).toHaveProperty("disabled", true);
    expect(screen.queryByRole("link", { name: /Download all/i })).toBeNull();
  });
});
