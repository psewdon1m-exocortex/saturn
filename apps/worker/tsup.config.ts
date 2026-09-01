import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  target: "node24",
  platform: "node",
  sourcemap: process.env.VAULT_RELEASE_BUILD !== "true",
  clean: true,
});
