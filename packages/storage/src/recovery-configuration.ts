import fs from "node:fs/promises";
import { recoveryConfigurationPath, validateRecoveredConfiguration, writeRecoveredConfiguration, type SaturnConfig } from "@saturn/config";
import { SftpStorageAdapter } from "./sftp-storage.adapter.js";
import type { RuntimeStorageManager } from "./runtime-storage.manager.js";

/** Same participant for owner UI and CLI. Credential material never enters the ZIP. */
export async function createStorageRecoveryParticipant(config: SaturnConfig, storage: RuntimeStorageManager) {
  const previousStorage = storage.current();
  const filename = recoveryConfigurationPath(config);
  const previous = await fs.readFile(filename, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  let recovered: SaturnConfig | undefined;
  let publicState: unknown;
  let applied = false;
  return {
    async prepare(value: unknown): Promise<void> {
      recovered = validateRecoveredConfiguration(value, config, {
        ...process.env,
        STORAGE_PASSWORD_FILE: previousStorage.config.passwordFile,
        STORAGE_PRIVATE_KEY_FILE: previousStorage.config.privateKeyFile,
      });
      const probe = new SftpStorageAdapter(recovered.storage);
      try { await probe.stat(""); }
      catch { throw new Error("Archived storage is unavailable with the target host credentials; connect the archived storage before restoring."); }
      finally { await probe.close(); }
      publicState = value;
    },
    async apply(): Promise<void> {
      if (recovered === undefined) throw new Error("Recovery configuration was not prepared");
      applied = true;
      await storage.restore({ ...previousStorage, source: "bootstrap", config: recovered.storage });
      writeRecoveredConfiguration(publicState, config);
    },
    async rollback(): Promise<void> {
      if (!applied) return;
      await storage.restore(previousStorage);
      if (previous === undefined) await fs.rm(filename, { force: true });
      else writeRecoveredConfiguration(JSON.parse(previous) as unknown, config);
    },
  };
}
