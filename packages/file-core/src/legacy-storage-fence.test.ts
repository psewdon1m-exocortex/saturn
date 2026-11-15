import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { StorageAdapter } from "@saturn/storage";
import type { Database } from "@saturn/database";
import { LegacyStorageFence, LegacyStorageFenceError, PostgresLegacyStoragePolicy, type LegacyStoragePolicy } from "./legacy-storage-fence.js";

function fixture() {
  const mutations = { write: vi.fn(async () => 3), truncate: vi.fn(async () => undefined), mkdir: vi.fn(async () => undefined), rename: vi.fn(async () => undefined), copy: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) };
  const reads = { stat: vi.fn(async () => ({ type: "directory" })), list: vi.fn(), openRead: vi.fn(), exists: vi.fn(async () => true), statFs: vi.fn(), close: vi.fn() };
  const storage = { ...mutations, ...reads } as unknown as StorageAdapter;
  const policy = { assertBackend: vi.fn(async () => undefined), assertMutation: vi.fn<LegacyStoragePolicy["assertMutation"]>(async () => { throw new LegacyStorageFenceError("guarded_write_refused"); }) };
  return { mutations, reads, storage, policy, fence: new LegacyStorageFence(storage, policy) };
}
describe("shared legacy physical storage fence", () => {
  it.each(["write", "truncate", "mkdir", "rename", "copy", "delete"] as const)("rejects %s before the underlying physical call", async operation => {
    const { fence, mutations, policy } = fixture();
    const actions = {
      write: () => fence.write("guard/file", Readable.from("abc"), { offset: 0, create: true }),
      truncate: () => fence.truncate("guard/file", 0), mkdir: () => fence.mkdir("guard/folder"),
      rename: () => fence.rename("outside/file", "guard/file"), copy: () => fence.copy("guard/file", "outside/file"), delete: () => fence.delete("guard/file"),
    };
    await expect(actions[operation]()).rejects.toMatchObject({ code: "guarded_write_refused" });
    for (const call of Object.values(mutations)) expect(call).not.toHaveBeenCalled();
    expect(policy.assertMutation).toHaveBeenCalledWith(operation, operation === "rename" ? ["outside/file", "guard/file"] : operation === "copy" ? ["guard/file", "outside/file"] : [operation === "mkdir" ? "guard/folder" : "guard/file"]);
  });
  it("permits an explicitly outside operation and preserves arguments and return value", async () => {
    const { fence, policy, mutations } = fixture(); vi.mocked(policy.assertMutation).mockResolvedValue(undefined);
    const source = Readable.from("abc"), options = { offset: 5, create: false, truncate: false };
    expect(await fence.write("outside/file", source, options)).toBe(3);
    expect(mutations.write).toHaveBeenCalledWith("outside/file", source, options);
  });
  it.each(["stat", "list", "openRead", "exists", "statFs"] as const)("a changed backend generation refuses %s before I/O", async operation => {
    const { fence, reads, policy } = fixture(); vi.mocked(policy.assertBackend).mockRejectedValue(new LegacyStorageFenceError("guard_unavailable"));
    const actions = { stat: () => fence.stat("outside/file"), list: () => fence.list("outside", undefined, 1), openRead: () => fence.openRead("outside/file"), exists: () => fence.exists("outside/file"), statFs: () => fence.statFs() };
    await expect(actions[operation]()).rejects.toMatchObject({ code: "guard_unavailable" });
    for (const call of Object.values(reads)) expect(call).not.toHaveBeenCalled();
  });
  it("refuses an allowed SQL path whose physical ancestor is not a directory", async () => {
    const { fence, policy, reads, mutations } = fixture(); vi.mocked(policy.assertMutation).mockResolvedValue(undefined);
    vi.mocked(reads.stat).mockResolvedValue({ type: "file" });
    await expect(fence.rename("alias/child", "outside/child")).rejects.toMatchObject({ code: "guard_unavailable" });
    expect(mutations.rename).not.toHaveBeenCalled(); expect(mutations.copy).not.toHaveBeenCalled();
  });
  it("rejects overdeep physical paths before storage traversal", async () => {
    const { fence, policy, reads, mutations } = fixture(); vi.mocked(policy.assertMutation).mockResolvedValue(undefined);
    await expect(fence.mkdir(Array(129).fill("node").join("/"))).rejects.toMatchObject({ code: "guard_unavailable" });
    expect(reads.exists).not.toHaveBeenCalled(); expect(mutations.mkdir).not.toHaveBeenCalled();
  });
});

describe("backup incoming namespace ownership", () => {
  const service = "00000000-0000-7000-8000-000000000031";
  const run = "00000000-0000-7000-8000-000000000032";
  const stored = `_system/incoming/backups/${service}/${run}.part`;
  function policy(known = true) {
    const sql = vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const query = parts.join("?");
      if (query.includes("FROM public.catalog_guard_roots")) return [{ root_id: service, storage_path: "sync/root", controls: [], valid: true }];
      if (query.includes("FROM public.backup_services")) return [{ found: known && values[0] === service }];
      if (query.includes("FROM public.service_backup_runs")) return known && values[0] === run && values[1] === service ? [{ temp_path: stored }] : [];
      return [];
    });
    return new PostgresLegacyStoragePolicy({ transaction: (fn: (sql: unknown) => Promise<unknown>) => fn(sql) } as unknown as Database, async () => undefined);
  }
  it("creates the neutral backup parent, then permits only registered service/run paths", async () => {
    await expect(policy().assertMutation("mkdir", ["_system/incoming/backups"])).resolves.toBeUndefined();
    await expect(policy().assertMutation("mkdir", [`_system/incoming/backups/${service}`])).resolves.toBeUndefined();
    await expect(policy().assertMutation("write", [stored])).resolves.toBeUndefined();
  });
  it.each(["write", "truncate", "delete", "rename", "copy"] as const)("refuses %s of the shared parent before physical mutation", async operation => {
    const f = fixture(), fence = new LegacyStorageFence(f.storage, policy());
    const parent = "_system/incoming/backups";
    const actions = { write: () => fence.write(parent, Readable.from("bytes"), { offset: 0, create: true }), truncate: () => fence.truncate(parent, 0), delete: () => fence.delete(parent), rename: () => fence.rename(parent, "outside"), copy: () => fence.copy(parent, "outside") };
    await expect(actions[operation]()).rejects.toMatchObject({ code: "private_owner_unknown" });
    for (const call of Object.values(f.mutations)) expect(call).not.toHaveBeenCalled();
  });
  it.each(["_system/incoming/backups-other", `_system/incoming/backups/${service}`, stored, stored + "/child"])("rejects an unknown private owner: %s", async path => {
    await expect(policy(false).assertMutation(path.endsWith(service) ? "mkdir" : "write", [path])).rejects.toMatchObject({ code: "private_owner_unknown" });
  });
});

describe("private package generation ownership", () => {
  const share = "00000000-0000-7000-8000-000000000011";
  const pack = "00000000-0000-7000-8000-000000000012";
  const generation = "00000000-0000-7000-8000-000000000013";
  const stored = `_system/packages/${share}/${pack}-${generation}.zip`;
  function policy(registeredPath = stored) {
    const sql = vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const query = parts.join("?");
      if (query.includes("FROM public.catalog_guard_roots")) return [{ root_id: share, storage_path: "sync/root", controls: [], valid: true }];
      if (query.includes("FROM public.share_package_generations g")) {
        expect(query).toContain("JOIN public.share_packages p ON p.id=g.package_id");
        return values[0] === generation && values[1] === pack && values[2] === share ? [{ storage_path: registeredPath }] : [];
      }
      return [];
    });
    const database = { transaction: (fn: (sql: unknown) => Promise<unknown>) => fn(sql) } as unknown as Database;
    return new PostgresLegacyStoragePolicy(database, async () => undefined);
  }
  it.each(["write", "delete"] as const)("permits %s of an exact owned generation, including retained cleanup paths", async operation => {
    await expect(policy().assertMutation(operation, [stored])).resolves.toBeUndefined();
  });
  it.each([
    stored.replace(share, "00000000-0000-7000-8000-000000000021"),
    stored.replace(pack, "00000000-0000-7000-8000-000000000022"),
    stored.replace(generation, "00000000-0000-7000-8000-000000000023"),
    stored + ".part", stored + "/child",
  ])("rejects an unregistered path %s before physical I/O", async path => {
    const f = fixture(), fence = new LegacyStorageFence(f.storage, policy());
    await expect(fence.write(path, Readable.from("abc"), { offset: 0, create: true })).rejects.toMatchObject({ code: "private_owner_unknown" });
    expect(f.mutations.write).not.toHaveBeenCalled();
  });
  it("refuses a matching identifier whose recorded physical path differs", async () => {
    await expect(policy(stored + ".other").assertMutation("write", [stored])).rejects.toMatchObject({ code: "private_owner_unknown" });
  });
});
