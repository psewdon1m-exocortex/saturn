import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Test workspace source directly, including in an isolated checkout that has
// not built release bundles. Never accidentally exercise a sibling's dist.
const packages = fileURLToPath(new URL("../../packages/", import.meta.url));
export default defineConfig({
  resolve: { alias: fs.readdirSync(packages).filter(name => fs.existsSync(path.join(packages, name, "src/index.ts")))
    .map(name => ({ find: new RegExp("^@saturn/" + name + "$"), replacement: path.join(packages, name, "src/index.ts") })) },
});
