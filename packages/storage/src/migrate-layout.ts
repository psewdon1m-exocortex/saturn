import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadEnvironment } from "@saturn/config";
import { migrateStorageLayout } from "./layout.js";
import { SftpStorageAdapter } from "./sftp-storage.adapter.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const directionArgument = process.argv.slice(2).find((argument) => argument === "up" || argument === "down");
const direction = directionArgument === "down" ? "down" : directionArgument === "up" ? "up" : undefined;
if (direction === undefined) throw new Error("Storage layout migration direction must be 'up' or 'down'");
const config = loadEnvironment(process.env, repositoryRoot);
const storage = new SftpStorageAdapter(config.storage);
try {
  process.stdout.write(`${JSON.stringify(await migrateStorageLayout(storage, direction))}\n`);
} finally {
  await storage.close().catch(() => undefined);
}
