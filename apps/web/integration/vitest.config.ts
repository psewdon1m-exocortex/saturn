import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const sourceRoot = process.env.EXOCORTEX_CONSUMER_SOURCE_ROOT;
if (!sourceRoot || !path.isAbsolute(sourceRoot)) {
  throw new Error("Set EXOCORTEX_CONSUMER_SOURCE_ROOT to the absolute directory containing the qualified Volt and Mastermind checkouts");
}
const consumers = {
  "volt-backup-policy": path.join(sourceRoot, "volt/src/backup-policy.js"),
  "mastermind-backup-policy": path.join(sourceRoot, "mastermind/src/mastermind/web/backup-policy.js"),
};
for (const file of Object.values(consumers)) if (!existsSync(file)) throw new Error(`Integration source is missing: ${file}`);

export default defineConfig({
  root: fileURLToPath(new URL("../", import.meta.url)),
  resolve: { alias: consumers },
  test: { environment: "jsdom", include: ["integration/**/*.test.ts"] },
});
