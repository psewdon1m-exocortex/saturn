import { requireTestValue } from "../../contracts/src/test-support.js";
import { randomUUID } from "node:crypto";
import type { Database } from "@saturn/database";
import type { BackendCommand, BackendExecutorIdentity } from "../../storage/src/durable-backend-executor.js";
import type { TransactionSql } from "postgres";
import { describe, expect, it, vi } from "vitest";
import { assertBrowserNamespaceCatalogPermit, PostgresBrowserNamespaceCoordinator, withBrowserNamespaceBackendContext, type BrowserNamespacePermit } from "./browser-upload-namespace-context.js";

// These are trusted-context tests only. They cannot prove SQL locks, physical
// writer death or registry durability; real two-producer SQL0110 tests follow.
function fixture() {
  const commands: string[] = [], epoch = randomUUID();
  let finishState = "RELEASED", catalogAllowed = true, loseFinishReply=false;
  const sql = (async (parts: TemplateStringsArray) => {
    const command = parts.join("?"); commands.push(command);
    if (command.includes("browser_namespace_acquire")) return [{ epoch, state: "HELD" }];
    if (command.includes("browser_namespace_finish")) { if(loseFinishReply){loseFinishReply=false;throw Error("finish reply lost");}return [{ state: finishState }]; }
    if (command.includes("browser_namespace_catalog_admit")) return [{ allowed: catalogAllowed }];
    return [];
  }) as unknown as TransactionSql;
  Object.assign(sql, {json: vi.fn((value: unknown) => value)});
  const database = { withSql: async (action: (sql: TransactionSql) => Promise<unknown>) => action(sql), transaction: async (action: (sql: TransactionSql) => Promise<unknown>) => action(sql) } as unknown as Database;
  const binding = { backendIdentity: "owned-backend", generation: randomUUID() };
  const coordinator = new PostgresBrowserNamespaceCoordinator(database, binding);
  const identity: BackendExecutorIdentity = { ...binding, ownerId: randomUUID(), fencingToken: randomUUID() };
  return { commands, epoch, sql, database, binding, coordinator, identity, setFinish: (state: string) => { finishState = state; }, denyCatalog: () => { catalogAllowed = false; },loseFinishReply:()=>{loseFinishReply=true;} };
}
const intent = () => ({ operationId: randomUUID(), kind: "create-folder" as const, parentId: randomUUID(), name: "child" });
describe("trusted browser namespace context (SQL integration pending)", () => {
  it("requires the exact live original for fixed tree database boundaries",async()=>{
    const f=fixture(),original=intent();
    await expect(assertBrowserNamespaceCatalogPermit(f.sql,original.operationId)).rejects.toThrow("namespace_permit_invalid");
    await f.coordinator.run(original,async()=>{
      await expect(assertBrowserNamespaceCatalogPermit(f.sql,randomUUID())).rejects.toThrow("namespace_permit_invalid");
      await expect(assertBrowserNamespaceCatalogPermit(f.sql,original.operationId)).resolves.toBeUndefined();
    });
  });
  it("binds producer submissions and catalog checks to a private acquired epoch", async () => {
    const f = fixture(), send = vi.fn<BackendCommand>(async () => ({ state: "DONE" })), wrapped = withBrowserNamespaceBackendContext(send), request = intent();
    let saved: BrowserNamespacePermit | undefined;
    await f.coordinator.run(request, async permit => {
      saved = permit; await f.coordinator.assertHeld(permit);
      await assertBrowserNamespaceCatalogPermit(f.sql);
      await wrapped("submit-once", f.identity, { id: randomUUID(), command: "mkdir" });
      await expect(f.coordinator.assertHeld({} as BrowserNamespacePermit)).rejects.toThrow("namespace_permit_invalid");
      return "complete";
    });
    expect(send.mock.calls[0]?.[2].namespace).toMatchObject({ schema: "saturn.namespace-permit.v1", operationId: request.operationId, epoch: f.epoch });
    await expect(f.coordinator.assertHeld(requireTestValue(saved))).rejects.toThrow("namespace_permit_invalid");
    expect(f.commands.filter(value => value.includes("browser_namespace_finish"))).toHaveLength(1);
  });
  it("refuses a different backend, forged wire context and a foreign issuer", async () => {
    const f = fixture(), other = fixture(), send = vi.fn<BackendCommand>(), wrapped = withBrowserNamespaceBackendContext(send);
    await expect(wrapped("submit", f.identity, { namespace: {} })).rejects.toThrow("namespace_payload_forged");
    await f.coordinator.run(intent(), async permit => {
      await expect(other.coordinator.assertHeld(permit)).rejects.toThrow("namespace_permit_invalid");
      await expect(wrapped("submit", { ...f.identity, generation: randomUUID() }, {})).rejects.toThrow("namespace_backend_mismatch");
    });
    expect(send).not.toHaveBeenCalled();
  });
  it("keeps ambiguous callback/finish failures as originals instead of granting release", async () => {
    const f = fixture();
    await expect(f.coordinator.run(intent(), async () => { throw new Error("physical response lost"); })).rejects.toThrow("physical response lost");
    expect(f.commands.some(value => value.includes("browser_namespace_finish"))).toBe(false);
    expect(f.commands.filter(value => value.includes("browser_namespace_unknown"))).toHaveLength(1);
    f.setFinish("UNKNOWN");
    await expect(f.coordinator.run(intent(), async () => "already published?")).rejects.toThrow("namespace_reconciliation_required");
    expect(f.commands.filter(value => value.includes("browser_namespace_unknown"))).toHaveLength(2);
  });
  it("denies an unjoined old producer continuation after closing but does not bind worker pumps", async () => {
    const f = fixture(), send = vi.fn<BackendCommand>(async () => null), wrapped = withBrowserNamespaceBackendContext(send);
    let resume!: () => void, late!: Promise<void>;
    const later = new Promise<void>(resolve => { resume = resolve; });
    await f.coordinator.run(intent(), async () => {
      late = (async () => {
        await later;
        await expect(wrapped("submit", f.identity, {})).rejects.toThrow("namespace_permit_closed");
        await expect(assertBrowserNamespaceCatalogPermit(f.sql)).rejects.toThrow("namespace_permit_closed");
        await wrapped("claim", f.identity, {});
      })();
    });
    resume(); await late;
    expect(send).toHaveBeenCalledTimes(1); expect(send.mock.calls[0]?.[0]).toBe("claim"); expect(send.mock.calls[0]?.[2]).toEqual({});
  });
  it("rejects duplicate/nested original execution and current SQL authority refusal", async () => {
    const f = fixture(), request = intent();
    await f.coordinator.run(request, async () => {
      await expect(f.coordinator.run(request, async () => undefined)).rejects.toThrow("namespace_operation_already_running");
      await expect(f.coordinator.run(intent(), async () => undefined)).rejects.toThrow("namespace_operation_already_running");
      f.denyCatalog(); await expect(assertBrowserNamespaceCatalogPermit(f.sql)).rejects.toThrow("namespace_catalog_denied");
    });
  });
  it("performs no SQL acquisition after cancellation or malformed identity", async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    await expect(f.coordinator.run(intent(), vi.fn(), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(f.coordinator.run({ ...intent(), operationId: "forged" }, vi.fn())).rejects.toThrow("namespace_intent_invalid");
    expect(f.commands).toHaveLength(0);
  });
  it("retries only the fixed finish receipt after a lost reply, never physical work",async()=>{
    const f=fixture(),action=vi.fn(async()=>"published");f.loseFinishReply();
    await expect(f.coordinator.run(intent(),action)).resolves.toBe("published");
    expect(action).toHaveBeenCalledTimes(1);expect(f.commands.filter(value=>value.includes("browser_namespace_finish"))).toHaveLength(2);
    expect(f.commands.some(value=>value.includes("browser_namespace_unknown"))).toBe(false);
  });
});
