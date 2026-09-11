import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".mp4", "video/mp4"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".webm", "video/webm"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

const spaRoute = /^(?:\/$|\/files(?:\/.*)?$|\/inbox(?:\/.*)?$|\/shared(?:\/.*)?$|\/trash(?:\/.*)?$|\/settings(?:\/.*)?$|\/synchronization(?:\/.*)?$|\/drop$|\/s\/[A-Za-z0-9_-]+$)/;
const blockedTopLevel = new Set(["artifacts", "data", "docs", "spool"]);

function securityHeaders(response) {
  response.setHeader("Content-Security-Policy", "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; frame-src 'self' blob:");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
}

function safeAssetPath(root, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return undefined; }
  if (!decoded.startsWith("/assets/") || decoded.includes("\\") || decoded.endsWith(".map")) return undefined;
  const segments = decoded.split("/").filter(Boolean);
  if (segments.some((segment) => segment.startsWith(".") || segment === "..") || blockedTopLevel.has(segments[0] ?? "")) return undefined;
  const candidate = path.resolve(root, `.${decoded}`);
  return candidate.startsWith(`${root}${path.sep}`) ? candidate : undefined;
}

async function sendFile(request, response, filename, cacheControl) {
  let attributes;
  try { attributes = await fs.stat(filename); } catch { response.statusCode = 404; response.end(); return; }
  if (!attributes.isFile()) { response.statusCode = 404; response.end(); return; }
  response.statusCode = 200;
  response.setHeader("Cache-Control", cacheControl);
  response.setHeader("Content-Length", attributes.size);
  response.setHeader("Content-Type", contentTypes.get(path.extname(filename).toLowerCase()) ?? "application/octet-stream");
  if (request.method === "HEAD") { response.end(); return; }
  const stream = createReadStream(filename);
  stream.once("error", () => { if (!response.headersSent) response.statusCode = 500; response.destroy(); });
  stream.pipe(response);
}

export function createStaticServer({ root = "/srv" } = {}) {
  const resolvedRoot = path.resolve(root);
  return http.createServer(async (request, response) => {
    securityHeaders(response);
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.statusCode = 405;
      response.setHeader("Allow", "GET, HEAD");
      response.end();
      return;
    }
    let pathname;
    try { pathname = new URL(request.url ?? "/", "http://localhost").pathname; }
    catch { response.statusCode = 400; response.end(); return; }
    if (pathname === "/health/live") {
      const body = Buffer.from('{"status":"ok"}\n');
      response.statusCode = 200;
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Length", body.length);
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(request.method === "HEAD" ? undefined : body);
      return;
    }
    if (pathname === "/robots.txt") {
      await sendFile(request, response, path.join(resolvedRoot, "robots.txt"), "public, max-age=3600");
      return;
    }
    const asset = safeAssetPath(resolvedRoot, pathname);
    if (asset !== undefined) {
      await sendFile(request, response, asset, "public, max-age=31536000, immutable");
      return;
    }
    if (spaRoute.test(pathname)) {
      await sendFile(request, response, path.join(resolvedRoot, "index.html"), "private, no-store");
      return;
    }
    response.statusCode = 404;
    response.setHeader("Cache-Control", "no-store");
    response.end();
  });
}

async function main() {
  const host = process.env.SATURN_WEB_HOST ?? "0.0.0.0";
  const port = Number(process.env.SATURN_WEB_PORT ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("SATURN_WEB_PORT is invalid");
  const server = createStaticServer({ root: process.env.SATURN_WEB_ROOT ?? "/srv" });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
