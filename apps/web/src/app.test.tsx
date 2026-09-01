import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./app.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState({}, "", "/"); });

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("owner Saturn UI", () => {
  it("renders an empty credential field and exchanges it for a session", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === "/health/ready") return json({ status: "ok" });
      if (url.endsWith("/auth/session")) return json({ code: "unauthorized" }, 401);
      if (url.endsWith("/auth/login")) return json({ state: "authenticated" });
      if (url.endsWith("/auth/preferences")) return json({ darkColor: "#000000", lightColor: "#ffffff", accentColor: "#00a8ff", updatedAt: new Date().toISOString() });
      if (url.includes("/resources/")) return json({ id: "00000000-0000-7000-8000-000000000001", type: "folder", name: "root", storagePath: "", sizeBytes: 0, status: "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      if (url.includes("/children")) return json([]);
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    const field = await screen.findByLabelText("Owner access key");
    expect(field).toHaveProperty("value", "");
    fireEvent.change(field, { target: { value: "temporary-owner-proof" } });
    fireEvent.click(screen.getByRole("button", { name: "Enter Saturn" }));
    expect(await screen.findByRole("heading", { name: "Files" })).toBeTruthy();
    const loginCall = fetchMock.mock.calls.find((call) => requestUrl(call[0]).endsWith("/auth/login"));
    expect(loginCall).toBeDefined();
    expect(window.localStorage.length).toBe(0);
  });

  it("renders the authenticated collection toolbar and empty recovery state", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === "/health/ready") return json({ status: "ok" });
      if (url.endsWith("/auth/session")) return json({ state: "authenticated" });
      if (url.endsWith("/auth/preferences")) return json({ darkColor: "#000000", lightColor: "#ffffff", accentColor: "#00a8ff", updatedAt: new Date().toISOString() });
      if (url.includes("/resources/")) return json({ id: "00000000-0000-7000-8000-000000000001", type: "folder", name: "root", storagePath: "", sizeBytes: 0, status: "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      if (url.includes("/children")) return json([]);
      return json({});
    }));
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Files" })).toBeTruthy();
    expect(screen.getByRole("search", { name: "Collection controls" })).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/Create arbitrary folders here/i)).toBeTruthy());
    expect(screen.getByRole("button", { name: "New folder" })).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: "Upload" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Quick upload" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Primary" }).querySelectorAll("button")).toHaveLength(7);
  });

  it("keeps preinstalled roots rename-only and ordinary root folders fully manageable", async () => {
    const now = new Date().toISOString();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === "/health/ready") return json({ status: "ok" });
      if (url.endsWith("/auth/session")) return json({ state: "authenticated" });
      if (url.endsWith("/auth/preferences")) return json({ darkColor: "#000000", lightColor: "#ffffff", accentColor: "#00a8ff", updatedAt: now });
      if (url.includes("/folders/") && url.includes("/children")) return json([
        { id: "00000000-0000-7000-8000-000000000004", parentId: "00000000-0000-7000-8000-000000000001", type: "folder", name: "sync", storagePath: "sync", sizeBytes: 0, status: "active", createdAt: now, updatedAt: now },
        { id: "01900000-0000-7000-8000-000000000001", parentId: "00000000-0000-7000-8000-000000000001", type: "folder", name: "ordinary", storagePath: "ordinary", sizeBytes: 0, status: "active", createdAt: now, updatedAt: now },
      ]);
      if (url.includes("/resources/")) return json({ id: "00000000-0000-7000-8000-000000000001", type: "folder", name: "root", storagePath: "", sizeBytes: 0, status: "active", createdAt: now, updatedAt: now });
      return json({});
    }));
    render(<App />);

    fireEvent.click(await screen.findByLabelText("Select sync"));
    const trashAction = screen.getAllByRole("button", { name: "Trash" }).find((button) => button.classList.contains("danger-link"));
    if (trashAction === undefined) throw new Error("Selection trash action is missing");
    expect(screen.getByRole("button", { name: "Rename" })).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: "Move" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Copy" })).toHaveProperty("disabled", true);
    expect(trashAction).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByLabelText("Select sync"));
    fireEvent.click(screen.getByLabelText("Select ordinary"));
    expect(screen.getByRole("button", { name: "Move" })).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: "Copy" })).toHaveProperty("disabled", false);
    expect(trashAction).toHaveProperty("disabled", false);
  });
});

describe("public Drop UI", () => {
  it("redeems a body-only code into an upload-only workspace without browser storage", async () => {
    window.history.replaceState({}, "", "/drop");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const url = requestUrl(input);
      if (url === "/health/ready") return json({ status: "ok" });
      if (url.endsWith("/drop/session")) return json({ code: "unauthorized" }, 401);
      if (url.endsWith("/drop/redeem")) return json({ state: "upload_only", expiresAt: new Date(Date.now() + 60_000).toISOString(), maxFiles: 20, maxBytes: 1024 });
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    const field = await screen.findByLabelText("Drop code");
    expect(field).toHaveProperty("value", "");
    fireEvent.change(field, { target: { value: "ABCD-EFGH" } });
    fireEvent.click(screen.getByRole("button", { name: "Open upload session" }));
    expect(await screen.findByText("UPLOAD ONLY")).toBeTruthy();
    expect(screen.queryByText(/Saturn contents/i)).toBeTruthy();
    const redeemCall = fetchMock.mock.calls.find((call) => requestUrl(call[0]).endsWith("/drop/redeem"));
    expect(redeemCall?.[1]?.body).toBe(JSON.stringify({ code: "ABCD-EFGH" }));
    expect(window.localStorage.length + window.sessionStorage.length).toBe(0);
  });
});

describe("public Share UI", () => {
  it("renders a non-indexable honest view-only capability without browser persistence", async () => {
    const token = "A".repeat(43);
    window.history.replaceState({}, "", `/s/${token}`);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === "/health/ready") return json({ status: "ok" });
      if (url.includes("/public/shares/")) return json({ id: "share", resourceId: "file", resourceType: "file", resourceName: "report.pdf", resourceSize: 1024, resourceMimeType: "application/pdf", mode: "view", state: "active", locked: false, downloadCount: 0 });
      return json({});
    }));
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Saturn Share" })).toBeTruthy();
    expect(screen.getByText(/can still be copied/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open view" }).getAttribute("href")).toContain(token);
    expect(window.localStorage.length + window.sessionStorage.length).toBe(0);
  });
});
