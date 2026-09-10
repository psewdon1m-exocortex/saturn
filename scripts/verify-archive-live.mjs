import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const base = "http://127.0.0.1:3000/api/v1";
const projectRoot = path.resolve(import.meta.dirname, "..");
const ownerTokenPath = process.env.OWNER_BOOTSTRAP_TOKEN_FILE;
if (!ownerTokenPath) throw new Error("OWNER_BOOTSTRAP_TOKEN_FILE is required");
const ownerToken = (await fs.readFile(ownerTokenPath, "utf8")).trim();

const login = await fetch(`${base}/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ accessKey: ownerToken }),
});
if (!login.ok) throw new Error(`Owner login failed: ${String(login.status)}`);
const cookies = login.headers.getSetCookie().map((header) => header.split(";", 1)[0] ?? "");
const csrfPair = cookies.find((cookie) => cookie.startsWith("vault_csrf_dev=") || cookie.startsWith("__Host-vault_csrf="));
if (!csrfPair) throw new Error("CSRF cookie is missing");
const csrf = decodeURIComponent(csrfPair.slice(csrfPair.indexOf("=") + 1));
const cookie = cookies.join("; ");

async function request(relativePath, options = {}) {
  const headers = new Headers(options.headers);
  headers.set("Cookie", cookie);
  const method = options.method?.toUpperCase() ?? "GET";
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    headers.set("X-Vault-CSRF", csrf);
    headers.set("Origin", process.env.PUBLIC_ORIGIN ?? "http://127.0.0.1:5173");
  }
  const response = await fetch(`${base}${relativePath}`, { ...options, headers });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${method} ${relativePath} failed (${String(response.status)}): ${body.slice(0, 1_000)}`);
  }
  return response;
}

async function json(relativePath, options) {
  return await (await request(relativePath, options)).json();
}

async function upload(parentId, filename, bytes) {
  const created = await json("/uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": `archive-live-${crypto.randomUUID()}` },
    body: JSON.stringify({ parentId, filename, expectedSize: bytes.byteLength }),
  });
  await request(`/uploads/${encodeURIComponent(created.id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/offset+octet-stream", "Upload-Offset": "0" },
    body: bytes,
  });
  return await json(`/uploads/${encodeURIComponent(created.id)}/complete`, { method: "POST" });
}

async function awaitJob(id) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const job = await json(`/archives/jobs/${encodeURIComponent(id)}`);
    if (["completed", "failed", "cancelled"].includes(job.state)) return job;
  }
  throw new Error(`Archive job ${id} timed out`);
}

const dropPointId = "00000000-0000-7000-8000-000000000002";
const folder = await json("/folders", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ parentId: dropPointId, name: `archive-e2e-${String(Date.now())}` }),
});
const zipPath = path.resolve(projectRoot, ".tmp", `archive-e2e-${String(Date.now())}.zip`);
const temporaryRoot = path.resolve(projectRoot, ".tmp");
if (!zipPath.startsWith(`${temporaryRoot}${path.sep}`)) throw new Error("Temporary ZIP path is unsafe");
let folderTrashed = false;
try {
  const markdownBytes = Buffer.from("# Saturn archive test\n", "utf8");
  const textBytes = Buffer.from("alpha\nbeta\ngamma\n", "utf8");
  const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const first = await upload(folder.id, "hello.md", markdownBytes);
  const second = await upload(folder.id, "data.txt", textBytes);
  const image = await upload(folder.id, "preview.png", imageBytes);
  if (first.resource.mimeType !== "text/markdown") throw new Error("Markdown MIME detection failed");
  const preview = await request(`/files/${encodeURIComponent(first.resource.id)}/preview`);
  if (preview.headers.get("content-type") !== "text/markdown" || !Buffer.from(await preview.arrayBuffer()).equals(markdownBytes)) {
    throw new Error("Markdown preview response is invalid");
  }
  const imagePreview = await request(`/files/${encodeURIComponent(image.resource.id)}/preview`);
  if (imagePreview.headers.get("content-type") !== "image/png" || !Buffer.from(await imagePreview.arrayBuffer()).equals(imageBytes)) {
    throw new Error("Image preview response is invalid");
  }
  const queuedArchive = await json("/archives/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ destinationParentId: folder.id, sourceResourceIds: [first.resource.id, second.resource.id], outputName: "bundle" }),
  });
  const archive = await awaitJob(queuedArchive.id);
  if (archive.state !== "completed" || !archive.resultResourceId) throw new Error(`Compression failed: ${archive.failureCode ?? archive.state}`);
  const zipResponse = await request(`/files/${encodeURIComponent(archive.resultResourceId)}/content`);
  await fs.writeFile(zipPath, Buffer.from(await zipResponse.arrayBuffer()), { mode: 0o600 });
  const { stdout } = await executeFile(process.env.ARCHIVE_7Z_BIN ?? "7z", ["l", "-ba", zipPath], { windowsHide: true });
  if (!stdout.includes("hello.md") || !stdout.includes("data.txt")) throw new Error("Created ZIP is missing selected files");
  const pauseCandidate = await json("/archives/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ destinationParentId: folder.id, sourceResourceIds: [first.resource.id, second.resource.id], outputName: "paused-bundle" }),
  });
  const paused = await json(`/archives/jobs/${encodeURIComponent(pauseCandidate.id)}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "pause" }),
  });
  if (paused.state !== "paused") throw new Error("Queued archive did not pause immediately");
  await json(`/archives/jobs/${encodeURIComponent(pauseCandidate.id)}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "resume" }),
  });
  const resumed = await awaitJob(pauseCandidate.id);
  if (resumed.state !== "completed") throw new Error(`Resumed archive failed: ${resumed.failureCode ?? resumed.state}`);
  const cancelCandidate = await json("/archives/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ destinationParentId: folder.id, sourceResourceIds: [first.resource.id], outputName: "cancelled-bundle" }),
  });
  const cancelled = await json(`/archives/jobs/${encodeURIComponent(cancelCandidate.id)}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cancel" }),
  });
  if (cancelled.state !== "cancelled") throw new Error("Queued archive did not cancel immediately");
  const queuedExtraction = await json(`/archives/resources/${encodeURIComponent(archive.resultResourceId)}/extract`, { method: "POST" });
  const extraction = await awaitJob(queuedExtraction.id);
  if (extraction.state !== "completed" || !extraction.resultResourceId) throw new Error(`Extraction failed: ${extraction.failureCode ?? extraction.state}`);
  const children = await json(`/folders/${encodeURIComponent(extraction.resultResourceId)}/children?offset=0&limit=100`);
  const extractedMarkdown = children.find((item) => item.name === "hello.md");
  const extractedText = children.find((item) => item.name === "data.txt");
  if (!extractedMarkdown || !extractedText) throw new Error("Extracted resource tree is incomplete");
  const extractedResponse = await request(`/files/${encodeURIComponent(extractedMarkdown.id)}/content`);
  if (!Buffer.from(await extractedResponse.arrayBuffer()).equals(markdownBytes)) throw new Error("Extracted file bytes differ from the source");
  await request(`/resources/${encodeURIComponent(folder.id)}`, {
    method: "DELETE",
    headers: { "Idempotency-Key": `archive-live-trash-${crypto.randomUUID()}` },
  });
  folderTrashed = true;
  process.stdout.write(`${JSON.stringify({ compression: archive.state, extraction: extraction.state, pauseResume: resumed.state, cancellation: cancelled.state, selectedFiles: 2, extractedFiles: children.length, markdownMimeType: first.resource.mimeType, imageMimeType: image.resource.mimeType, cleanup: "test tree moved to trash" })}\n`);
} finally {
  if (!folderTrashed) {
    await request(`/resources/${encodeURIComponent(folder.id)}`, {
      method: "DELETE",
      headers: { "Idempotency-Key": `archive-live-cleanup-${crypto.randomUUID()}` },
    }).catch(() => undefined);
  }
  await fs.rm(zipPath, { force: true });
}
