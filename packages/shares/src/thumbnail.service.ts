import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createCanvas, loadImage, type Image } from "@napi-rs/canvas";
import type { Resource } from "@saturn/file-core";
import ffmpegPath from "ffmpeg-static";
import sharp from "sharp";
import type { ShareService } from "./share.service.js";
import type { ShareStorageGateway } from "./types.js";

const width = 640;
const height = 360;
const thumbnailVersion = "v1";
const cacheRoot = `_system/thumbnails/${thumbnailVersion}`;
const imageMaximumBytes = 128 * 1024 * 1024;
const imageMaximumPixels = 40_000_000;
const pdfMaximumBytes = 128 * 1024 * 1024;
const videoMaximumBytes = 4 * 1024 * 1024 * 1024;
const processTimeoutMs = 45_000;
const processOutputMaximumBytes = 32 * 1024 * 1024;
const ffmpegExecutable: string | null = typeof ffmpegPath === "string"
  ? ffmpegPath
  : (ffmpegPath as unknown as { readonly default?: string | null }).default ?? null;

export type ThumbnailKind = "image" | "pdf" | "video";

export class ShareThumbnailError extends Error {
  readonly code: "unsupported" | "too_large" | "generation_failed";

  constructor(code: ShareThumbnailError["code"], cause?: unknown) {
    super(`Share thumbnail ${code}`, { cause });
    this.code = code;
  }
}

function extension(resource: Pick<Resource, "name">): string {
  return path.extname(resource.name).toLocaleLowerCase();
}

export function thumbnailKind(resource: Pick<Resource, "name" | "mimeType">): ThumbnailKind | undefined {
  const mime = resource.mimeType?.toLocaleLowerCase() ?? "";
  const suffix = extension(resource);
  if (mime.startsWith("image/") && mime !== "image/svg+xml") return "image";
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".bmp"].includes(suffix)) return "image";
  if (mime === "application/pdf" || suffix === ".pdf") return "pdf";
  if (mime.startsWith("video/") || [".mp4", ".webm", ".mov", ".m4v", ".ogv", ".mkv"].includes(suffix)) return "video";
  return undefined;
}

function cacheKey(resource: Resource): string {
  const identity = resource.sha256 ?? resource.currentVersionId ?? `${resource.id}:${resource.updatedAt.toISOString()}:${String(resource.sizeBytes)}`;
  return createHash("sha256").update(`${thumbnailVersion}:${identity}:${resource.mimeType ?? ""}`).digest("hex");
}

function maximumBytes(kind: ThumbnailKind): number {
  return kind === "video" ? videoMaximumBytes : kind === "pdf" ? pdfMaximumBytes : imageMaximumBytes;
}

async function drawImage(image: Image, fit: "cover" | "contain"): Promise<Buffer> {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ebe8df";
  context.fillRect(0, 0, width, height);
  const scale = fit === "cover"
    ? Math.max(width / image.width, height / image.height)
    : Math.min(width / image.width, height / image.height);
  const targetWidth = image.width * scale;
  const targetHeight = image.height * scale;
  context.drawImage(image, (width - targetWidth) / 2, (height - targetHeight) / 2, targetWidth, targetHeight);
  return canvas.encode("webp", 82);
}

async function renderImage(inputPath: string): Promise<Buffer> {
  return sharp(inputPath, {
    failOn: "error",
    limitInputPixels: imageMaximumPixels,
    sequentialRead: true,
  })
    .rotate()
    .resize(width, height, { fit: "cover", position: "centre" })
    .webp({ effort: 4, quality: 82 })
    .toBuffer();
}

async function renderPdf(inputPath: string): Promise<Buffer> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const bytes = new Uint8Array(await fs.readFile(inputPath));
  const loading = getDocument({ data: bytes, useSystemFonts: true });
  const document = await loading.promise;
  try {
    const page = await document.getPage(1);
    const natural = page.getViewport({ scale: 1 });
    const scale = Math.min((width - 32) / natural.width, (height - 32) / natural.height);
    const viewport = page.getViewport({ scale });
    const pageCanvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
    const context = pageCanvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
    await page.render({ canvas: pageCanvas, canvasContext: context, viewport }).promise;
    return await drawImage(await loadImage(await pageCanvas.encode("png")), "contain");
  } finally {
    await loading.destroy();
  }
}

async function runFfmpeg(inputPath: string): Promise<Buffer> {
  if (ffmpegExecutable === null) throw new ShareThumbnailError("generation_failed", new Error("FFmpeg binary is unavailable"));
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(ffmpegExecutable, [
      "-hide_banner", "-loglevel", "error", "-i", inputPath,
      "-frames:v", "1", "-an", "-sn", "-vf", `scale=${String(width)}:${String(height)}:force_original_aspect_ratio=increase,crop=${String(width)}:${String(height)}`,
      "-f", "image2pipe", "-vcodec", "png", "pipe:1",
    ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let outputBytes = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), processTimeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > processOutputMaximumBytes) child.kill("SIGKILL");
      else output.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { if (errors.reduce((sum, value) => sum + value.length, 0) < 8_192) errors.push(chunk); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      const value = Buffer.concat(output);
      if (code === 0 && value.length > 0 && value.length <= processOutputMaximumBytes) resolve(value);
      else reject(new Error(`FFmpeg thumbnail failed (${String(code)}): ${Buffer.concat(errors).toString("utf8").slice(-2_000)}`));
    });
  });
}

async function renderVideo(inputPath: string): Promise<Buffer> {
  return sharp(await runFfmpeg(inputPath), {
    failOn: "error",
    limitInputPixels: imageMaximumPixels,
  })
    .webp({ effort: 4, quality: 82 })
    .toBuffer();
}

export type ThumbnailRenderer = (kind: ThumbnailKind, inputPath: string) => Promise<Buffer>;

export async function renderThumbnail(kind: ThumbnailKind, inputPath: string): Promise<Buffer> {
  return kind === "image" ? renderImage(inputPath) : kind === "pdf" ? renderPdf(inputPath) : renderVideo(inputPath);
}

async function ensureDirectory(storage: ShareStorageGateway, storagePath: string): Promise<void> {
  if (await storage.exists(storagePath).catch(() => false)) return;
  await storage.mkdir(storagePath).catch(async (error: unknown) => {
    if (!(await storage.exists(storagePath).catch(() => false))) throw error;
  });
}

export class ShareThumbnailService {
  readonly #shares: ShareService;
  readonly #storage: ShareStorageGateway;
  readonly #renderer: ThumbnailRenderer;
  readonly #pending = new Map<string, Promise<Buffer>>();

  constructor(input: { readonly shares: ShareService; readonly storage: ShareStorageGateway; readonly renderer?: ThumbnailRenderer }) {
    this.#shares = input.shares;
    this.#storage = input.storage;
    this.#renderer = input.renderer ?? renderThumbnail;
  }

  async open(token: string, resourceId: string, input: { readonly sourceIp: string; readonly userAgent: string; readonly sessionToken?: string }) {
    const source = await this.#shares.thumbnailSource(token, resourceId, input);
    const kind = thumbnailKind(source.resource);
    if (kind === undefined) throw new ShareThumbnailError("unsupported");
    if (source.resource.sizeBytes > maximumBytes(kind)) throw new ShareThumbnailError("too_large");
    const key = cacheKey(source.resource);
    const directory = `${cacheRoot}/${key.slice(0, 2)}`;
    const storagePath = `${directory}/${key}.webp`;
    if (await this.#storage.exists(storagePath).catch(() => false)) {
      const stat = await this.#storage.stat(storagePath);
      return { stream: await this.#storage.openRead(storagePath), sizeBytes: stat.size, etag: key, session: source.session };
    }

    let generating = this.#pending.get(key);
    if (generating === undefined) {
      generating = this.#generate(kind, source.resource, source.open, directory, storagePath);
      this.#pending.set(key, generating);
      void generating.finally(() => this.#pending.delete(key)).catch(() => undefined);
    }
    const buffer = await generating;
    return { stream: Readable.from(buffer), sizeBytes: buffer.length, etag: key, session: source.session };
  }

  async #generate(kind: ThumbnailKind, resource: Resource, open: () => Promise<Readable>, directory: string, storagePath: string): Promise<Buffer> {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "saturn-thumbnail-"));
    const suffix = extension(resource).replace(/[^a-z0-9.]/g, "").slice(0, 12) || ".bin";
    const inputPath = path.join(temporary, `source${suffix}`);
    try {
      await pipeline(await open(), createWriteStream(inputPath, { flags: "wx", mode: 0o600 }));
      const buffer = await this.#renderer(kind, inputPath).catch((error: unknown) => { throw new ShareThumbnailError("generation_failed", error); });
      if (buffer.length < 1 || buffer.length > processOutputMaximumBytes) throw new ShareThumbnailError("generation_failed");
      await ensureDirectory(this.#storage, "_system/thumbnails");
      await ensureDirectory(this.#storage, cacheRoot);
      await ensureDirectory(this.#storage, directory);
      await this.#storage.write(storagePath, Readable.from(buffer), { offset: 0, create: true, exclusive: true, truncate: true }).catch(async (error: unknown) => {
        if (!(await this.#storage.exists(storagePath).catch(() => false))) throw error;
      });
      return buffer;
    } finally {
      await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
