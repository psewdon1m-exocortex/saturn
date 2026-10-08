// @vitest-environment node
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPipelineMockMiddleware, createPipelineMockState, pipelineMocks } from "../dev/pipeline-mocks.js";

const csrf = "a".repeat(43);
const cookie = `vault_session_dev=test; vault_csrf_dev=${csrf}`;
const headers = { Cookie: cookie, Origin: "http://127.0.0.1:5173", "X-Vault-CSRF": csrf };
let upstream: Server, stand: Server, url: string;
let enabled = true;
const forwarded: string[] = [];

async function listen(server: Server) {
  await new Promise<void>(resolve => { server.listen(0, "127.0.0.1", resolve); });
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

beforeAll(async () => {
  upstream = createServer((request, response) => {
    forwarded.push(`${request.method ?? "GET"} ${request.url ?? "/"}`);
    response.setHeader("Content-Type", "application/json");
    if (request.headers.cookie !== cookie) { response.writeHead(401); response.end("{}"); return; }
    response.end(request.url === "/api/v1/auth/session" ? '{"state":"authenticated"}' : '[{"id":"real-service"}]');
  });
  const middleware = createPipelineMockMiddleware({ enabled: () => enabled, apiOrigin: await listen(upstream) });
  stand = createServer((request, response) => {
    void middleware(request, response, () => { response.writeHead(418); response.end("real-api-fallback"); });
  });
  url = await listen(stand);
});
afterEach(() => { enabled = true; vi.unstubAllEnvs(); });
afterAll(async () => {
  for (const server of [stand, upstream]) await new Promise<void>((resolve, reject) => {
    server.close(error => { if (error) reject(error); else resolve(); });
    server.closeAllConnections();
  });
});

describe("development pipeline preview", () => {
  it("has all pipeline groups, capability choices, offline and pending agents, and isolated Windows folders", () => {
    const state = createPipelineMockState();
    expect(state.services.filter(service => service.pipelineKind === "host_service")).toHaveLength(4);
    expect(state.services.find(service => service.pipelineKind === "volt")).toMatchObject({ archivePipeline: true, mirrorRoot: "volt" });
    expect(state.services.find(service => service.pipelineKind === "mastermind")).toMatchObject({ archivePipeline: false, mirrorRoot: "mastermind" });
    expect(state.agents().filter(agent => agent.observed.online)).toHaveLength(6);
    expect(state.agents().some(agent => agent.observed.appliedRevision < agent.desired.revision)).toBe(true);
    for (const device of state.windows()) expect(device.scopeIds).toEqual([device.syncRootId]);
    expect(state.connectedDevices().find(device => device.deviceKind === "pluto")).toMatchObject({ rights: { move: false, delete: false }, plutoStatus: { enabled: true } });
    const mastermind = state.services.find(service => service.pipelineKind === "mastermind");
    if (!mastermind) throw new Error("Mastermind mock missing");
    expect(state.runs(mastermind)).toEqual([]);
  });

  it("requires the real owner session and preserves real identities in merged lists", async () => {
    expect((await fetch(`${url}/api/v1/backup-services`)).status).toBe(401);
    const response = await fetch(`${url}/api/v1/backup-services`, { headers });
    expect(response.headers.get("X-Saturn-Dev-Mock")).toBe("pipelines");
    const services = await response.json() as { id: string; name?: string }[];
    expect(services[0]?.id).toBe("real-service");
    expect(services.filter(service => service.name?.startsWith("MOCK ·"))).toHaveLength(7);
  });

  it("requires CSRF for mock mutations and never forwards them to the real control plane", async () => {
    const id = createPipelineMockState().services[0]?.id;
    if (!id) throw new Error("Host mock missing");
    expect((await fetch(`${url}/api/v1/backup-services/${id}/enrollment`, { method: "POST", headers: { Cookie: cookie } })).status).toBe(403);
    const response = await fetch(`${url}/api/v1/backup-services/${id}/enrollment`, { method: "POST", headers });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ code: "MOCK_PREVIEW_NOT_REDEEMABLE" });
    expect((await fetch(`${url}/api/v1/backup-services/${id}/rotate-token`, { method: "POST", headers })).status).toBe(409);
    expect(forwarded.some(value => value.startsWith("POST ") || value.startsWith("DELETE "))).toBe(false);
  });

  it("keeps mock revoke state across reads without revoking real identities", async () => {
    const id = createPipelineMockState().devices[0]?.id;
    if (!id) throw new Error("Windows mock missing");
    expect((await fetch(`${url}/api/v1/devices/${id}`, { method: "DELETE", headers })).status).toBe(200);
    const response = await fetch(`${url}/api/v1/devices`, { headers });
    expect(await response.json()).toContainEqual(expect.objectContaining({ id, state: "revoked" }));
    expect((await fetch(`${url}/api/v1/devices/real-device`, { method: "DELETE", headers })).status).toBe(418);
  });

  it("passes through when disabled and is excluded from build, preview and production", async () => {
    enabled = false;
    expect((await fetch(`${url}/api/v1/backup-services`, { headers })).status).toBe(418);
    const apply = pipelineMocks().apply;
    if (typeof apply !== "function") throw new Error("Expected explicit development gate");
    expect(apply({}, { command: "build", mode: "development" })).toBe(false);
    expect(apply({}, { command: "serve", mode: "production" })).toBe(false);
    vi.stubEnv("NODE_ENV", "production");
    expect(apply({}, { command: "serve", mode: "development" })).toBe(false);
    vi.stubEnv("NODE_ENV", "development");
    expect(apply({}, { command: "serve", mode: "development" })).toBe(true);
  });
});
