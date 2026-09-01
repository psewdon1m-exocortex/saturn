import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = process.env.VAULT_RUNTIME_ROOT;
const configEntry = runtimeRoot
  ? path.join(runtimeRoot, "api", "node_modules", "@saturn", "config", "dist", "index.js")
  : path.join(repositoryRoot, "packages", "config", "dist", "index.js");
const databaseEntry = runtimeRoot
  ? path.join(runtimeRoot, "api", "node_modules", "@saturn", "database", "dist", "index.js")
  : path.join(repositoryRoot, "packages", "database", "dist", "index.js");
const storageEntry = runtimeRoot
  ? path.join(runtimeRoot, "api", "node_modules", "@saturn", "storage", "dist", "index.js")
  : path.join(repositoryRoot, "packages", "storage", "dist", "index.js");
const migrationsDirectory = runtimeRoot
  ? path.join(runtimeRoot, "api", "node_modules", "@saturn", "database", "migrations")
  : path.join(repositoryRoot, "packages", "database", "migrations");

const [{ loadEnvironment }, { migrate }, { migrateStorageLayout, SftpStorageAdapter }] = await Promise.all([
  import(pathToFileURL(configEntry)),
  import(pathToFileURL(databaseEntry)),
  import(pathToFileURL(storageEntry)),
]);
const config = loadEnvironment(process.env, runtimeRoot ?? repositoryRoot);
const storage = new SftpStorageAdapter(config.storage);
let storageLayout;
try {
  storageLayout = await migrateStorageLayout(storage, "up");
} finally {
  await storage.close().catch(() => undefined);
}
const applied = await migrate(config.databaseUrl, migrationsDirectory);
process.stdout.write(`${JSON.stringify({ direction: "up", applied, storageLayout })}\n`);
