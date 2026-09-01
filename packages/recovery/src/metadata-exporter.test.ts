import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Database } from "@saturn/database";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseMetadataExporter } from "./metadata-exporter.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("DatabaseMetadataExporter", () => {
  it("serializes a complete row without alias ambiguity", async () => {
    const queries: string[] = [];
    const database = {
      withSql: async (callback: (sql: { unsafe: (query: string) => Promise<readonly unknown[]> }) => Promise<unknown>) =>
        callback({
          unsafe: async (query: string) => {
            queries.push(query);
            return [{
              cursor_value: "00000000-0000-7000-8000-000000000001",
              value: { id: "00000000-0000-7000-8000-000000000001", source: "manual" },
            }];
          },
        }),
    } as unknown as Database;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vault-metadata-export-"));
    roots.push(root);
    await new DatabaseMetadataExporter(database).exportTo(root);

    const resourceLine = await fs.readFile(path.join(root, "resources.jsonl"), "utf8");
    expect(JSON.parse(resourceLine)).toEqual({
      id: "00000000-0000-7000-8000-000000000001",
      source: "manual",
    });
    expect(queries.every((query) => query.includes("to_jsonb(export_row)"))).toBe(true);
  });
});
