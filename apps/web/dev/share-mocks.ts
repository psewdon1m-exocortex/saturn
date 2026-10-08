import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import type { ShareChild, ShareInfo } from "../src/types.js";

// Public share capabilities are 43-character base64url values; keep the preview
// token shape identical so the production route parser is exercised as well.
export const sharedFolderMockToken = "mock-shared-folder-000000000000000000000000";
export const sharedFolderPasswordMockToken = "mock-shared-password-0000000000000000000000";
export const sharedFolderReadonlyMockToken = "mock-shared-readonly-0000000000000000000000";

const gib = 1024 ** 3;
const mib = 1024 ** 2;
const updatedAt = "2026-10-05T16:30:00.000Z";

const share: ShareInfo = {
  id: "mock-share-project-materials",
  resourceId: "mock-folder-project-materials",
  resourceType: "folder",
  resourceName: "Project materials",
  resourceSize: Math.round(185.12 * gib),
  mode: "download_folder",
  state: "active",
  locked: false,
  expiresAt: "2030-10-05T16:30:00.000Z",
  downloadCount: 0,
  createdAt: "2026-10-01T12:00:00.000Z",
  updatedAt,
};

const rootChildren: readonly ShareChild[] = [
  { id: "mock-folder-photos", type: "folder", name: "Photos", sizeBytes: Math.round(184.6 * gib), updatedAt },
  { id: "mock-file-cover", type: "file", name: "Saturn cover.jpg", sizeBytes: Math.round(8.4 * mib), mimeType: "image/jpeg", updatedAt },
  { id: "mock-file-video", type: "file", name: "Project walkthrough.mp4", sizeBytes: Math.round(394.4 * mib), mimeType: "video/mp4", updatedAt },
  { id: "mock-file-pdf", type: "file", name: "Architecture.pdf", sizeBytes: Math.round(2.8 * mib), mimeType: "application/pdf", updatedAt },
  { id: "mock-file-readme", type: "file", name: "README.md", sizeBytes: 28 * 1024, mimeType: "text/markdown", updatedAt },
  { id: "mock-file-archive", type: "file", name: "assets.zip", sizeBytes: Math.round(124 * mib), mimeType: "application/zip", updatedAt },
];

const photoChildren: readonly ShareChild[] = [
  { id: "mock-file-photo-one", parentId: "mock-folder-photos", type: "file", name: "saturn-orbit-01.jpg", sizeBytes: Math.round(12.2 * mib), mimeType: "image/jpeg", updatedAt },
  { id: "mock-file-photo-two", parentId: "mock-folder-photos", type: "file", name: "saturn-orbit-02.png", sizeBytes: Math.round(18.7 * mib), mimeType: "image/png", updatedAt },
];

type Next = (error?: unknown) => void;

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Saturn-Dev-Mock": "shared-folder",
  });
  response.end(JSON.stringify(body));
}

export function createShareMockMiddleware() {
  return (request: IncomingMessage, response: ServerResponse, next: Next) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const prefix = "/api/v1/public/shares/";
    if (!url.pathname.startsWith(prefix)) {
      next();
      return;
    }
    const token = url.pathname.slice(prefix.length).split("/")[0] ?? "";
    const variant = token === sharedFolderMockToken
      ? "download"
      : token === sharedFolderPasswordMockToken
        ? "password"
        : token === sharedFolderReadonlyMockToken
          ? "readonly"
          : undefined;
    if (variant === undefined) {
      next();
      return;
    }
    const basePath = `${prefix}${token}`;
    const variantShare: ShareInfo = variant === "password"
      ? { ...share, id: "mock-share-project-materials-password", locked: true }
      : variant === "readonly"
        ? { ...share, id: "mock-share-project-materials-readonly", mode: "browse" }
        : share;

    const method = request.method ?? "GET";
    if (method === "GET" && url.pathname === basePath) {
      sendJson(response, 200, variantShare);
      return;
    }
    if (method === "POST" && url.pathname === `${basePath}/unlock` && variant === "password") {
      sendJson(response, 200, { ...variantShare, locked: false });
      return;
    }
    if (method === "GET" && url.pathname === `${basePath}/children`) {
      sendJson(response, 200, url.searchParams.get("parentId") === "mock-folder-photos" ? photoChildren : rootChildren);
      return;
    }
    if (method === "GET" && url.pathname.startsWith(`${basePath}/thumbnail/`)) {
      const resourceId = decodeURIComponent(url.pathname.slice(`${basePath}/thumbnail/`.length));
      const palette: readonly [string, string] = resourceId.includes("pdf") ? ["#f0e1de", "#9a3e36"] : resourceId.includes("video") ? ["#e9e2ed", "#6a517c"] : ["#dfe9e2", "#4c705e"];
      const label = resourceId.includes("pdf") ? "PDF PREVIEW" : resourceId.includes("video") ? "VIDEO POSTER" : "IMAGE PREVIEW";
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="${palette[0]}"/><circle cx="510" cy="92" r="96" fill="${palette[1]}" opacity=".12"/><path d="M0 310 180 142l105 92 76-67 279 193H0z" fill="${palette[1]}" opacity=".34"/><text x="32" y="58" fill="${palette[1]}" font-family="monospace" font-size="22" font-weight="700">${label}</text></svg>`;
      response.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store", "X-Saturn-Dev-Mock": "shared-folder-thumbnail" });
      response.end(svg);
      return;
    }
    if (method === "POST" && url.pathname === `${basePath}/package`) {
      if (variant === "readonly") {
        sendJson(response, 403, { code: "share_download_forbidden" });
        return;
      }
      sendJson(response, 200, { state: "ready", sizeBytes: share.resourceSize });
      return;
    }
    if (method === "GET" && (url.pathname === `${basePath}/package` || url.pathname.startsWith(`${basePath}/content`))) {
      if (variant === "readonly") {
        sendJson(response, 403, { code: "share_download_forbidden" });
        return;
      }
      response.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": "attachment; filename=SATURN-MOCK.txt",
        "Cache-Control": "no-store",
        "X-Saturn-Dev-Mock": "shared-folder",
      });
      response.end("Saturn development preview: no real storage bytes were downloaded.\n");
      return;
    }
    sendJson(response, 405, { code: "mock_method_not_allowed" });
  };
}

export function shareMocks(): Plugin {
  return {
    name: "saturn-development-share-mocks",
    apply: (_config, environment) => environment.command === "serve" && environment.mode === "development" && process.env.NODE_ENV !== "production",
    configureServer(server) {
      const middleware = createShareMockMiddleware();
      server.middlewares.use((request, response, next) => middleware(request, response, next));
    },
  };
}
