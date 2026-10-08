import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { pipelineMocks } from "./dev/pipeline-mocks.js";
import { shareMocks } from "./dev/share-mocks.js";

export default defineConfig({
  plugins: [react(), shareMocks(), pipelineMocks()],
  server: {
    port: 5_173,
    strictPort: true,
    proxy: {
      "/health": "http://127.0.0.1:3000",
      "/api": "http://127.0.0.1:3000",
      "/a/": "http://127.0.0.1:3000",
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4_173,
    strictPort: true,
    proxy: {
      "/health": "http://127.0.0.1:3000",
      "/api": "http://127.0.0.1:3000",
      "/a/": "http://127.0.0.1:3000",
    },
  },
  build: {
    outDir: "dist",
    sourcemap: process.env.VAULT_RELEASE_BUILD !== "true",
    assetsInlineLimit: 4_096,
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: [],
  },
});
