import fs from "node:fs/promises";
import { AuditService } from "@saturn/audit";
import type { SaturnConfig } from "@saturn/config";
import type { Database } from "@saturn/database";

async function readSecret(filePath: string | undefined): Promise<string | undefined> {
  if (filePath === undefined) return undefined;
  const value = (await fs.readFile(filePath, "utf8")).replace(/[\r\n]+$/, "");
  return value || undefined;
}

export async function createAuditService(database: Database, config: SaturnConfig): Promise<AuditService> {
  const databasePassword = (() => {
    try { return decodeURIComponent(new URL(config.databaseUrl).password); }
    catch { return ""; }
  })();
  const values = await Promise.all([
    readSecret(config.ownerBootstrapTokenFile),
    readSecret(config.storage.passwordFile),
  ]);
  return new AuditService(database, [databasePassword, ...values.filter((value): value is string => value !== undefined)]);
}
