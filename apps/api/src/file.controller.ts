import { Readable } from "node:stream";
import archiver from "archiver";
import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Head,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import { ROOT_RESOURCE_ID, type FileService, type Resource } from "@saturn/file-core";
import type { SaturnConfig } from "@saturn/config";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { OwnerTokenGuard } from "./owner-token.guard.js";
import { OWNER_SESSION, type AuthenticatedOwnerRequest } from "./owner-token.guard.js";
import { APP_CONFIG, FILE_SERVICE } from "./tokens.js";
import { SaturnApiExceptionFilter } from "./saturn-api-exception.filter.js";
import { TransferMonitorService } from "./transfer-monitor.service.js";

const folderSchema = z.object({
  parentId: z.uuid().optional(),
  name: z.string().min(1).max(255),
}).strict();
const uploadSchema = z.object({
  parentId: z.uuid().optional(),
  filename: z.string().min(1).max(255),
  expectedSize: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  expectedSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  overwriteResourceId: z.uuid().optional(),
}).strict();
const moveSchema = z.object({ parentId: z.uuid(), name: z.string().min(1).max(255).optional() }).strict();
const copySchema = moveSchema;
const resolveFolderSchema = z.object({
  rootId: z.uuid().default(ROOT_RESOURCE_ID),
  path: z.string().max(4_096).default(""),
}).strict();

function requiredHeader(value: string | undefined, name: string): string {
  if (value === undefined || !value.trim()) throw new Error(`${name} is invalid`);
  return value;
}

function integerHeader(value: string | undefined, name: string): number {
  const parsed = Number(requiredHeader(value, name));
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} is invalid`);
  return parsed;
}

function parseRange(value: string | undefined, size: number): { readonly offset: number; readonly length?: number; readonly partial: boolean } {
  if (value === undefined) return { offset: 0, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (match === null || (match[1] === "" && match[2] === "") || size === 0) throw new Error("Range is invalid");
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) throw new Error("Range is invalid");
    const length = Math.min(suffix, size);
    return { offset: size - length, length, partial: true };
  }
  const offset = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Number(match[2]);
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || offset < 0 || end < offset || end >= size) {
    throw new Error("Range is invalid");
  }
  return { offset, length: end - offset + 1, partial: true };
}

const previewMimeTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "video/mp4",
  "video/webm",
]);

function contentDisposition(disposition: "attachment" | "inline", filename: string): string {
  const fallback = filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180) || "download";
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

@Controller()
@UseGuards(OwnerTokenGuard)
@UseFilters(SaturnApiExceptionFilter)
export class FileController {
  constructor(
    @Inject(FILE_SERVICE) private readonly files: FileService,
    @Inject(APP_CONFIG) private readonly config: SaturnConfig,
    @Inject(TransferMonitorService) private readonly transfers: TransferMonitorService,
  ) {}

  #isVolt(resource: { readonly storagePath: string }): boolean {
    return resource.storagePath === "volt" || resource.storagePath.startsWith("volt/");
  }

  #requireRecentProof(resource: { readonly storagePath: string }, request: AuthenticatedOwnerRequest): void {
    if (!this.#isVolt(resource)) return;
    const session = request[OWNER_SESSION];
    if (session !== undefined && session.reauthenticatedAt.getTime() < Date.now() - this.config.auth.reauthTtlMs) {
      throw new ForbiddenException({ code: "reauth_required" });
    }
  }

  async #folderArchiveEntries(folder: Resource): Promise<{ readonly entries: readonly { readonly resource: Resource; readonly path: string }[]; readonly totalBytes: number }> {
    const entries: Array<{ readonly resource: Resource; readonly path: string }> = [];
    let totalBytes = 0;
    const visit = async (parentId: string, prefix: string): Promise<void> => {
      for (let offset = 0; ; offset += 500) {
        const page = await this.files.listChildren(parentId, offset, 500);
        for (const resource of page) {
          const archivePath = `${prefix}${resource.name}${resource.type === "folder" ? "/" : ""}`;
          entries.push({ resource, path: archivePath });
          if (entries.length > this.config.share.packageMaxFiles) throw new Error("Folder archive exceeds the configured item limit");
          if (resource.type === "file") {
            totalBytes += resource.sizeBytes;
            if (totalBytes > this.config.share.packageMaxBytes) throw new Error("Folder archive exceeds the configured size limit");
          } else {
            await visit(resource.id, archivePath);
          }
        }
        if (page.length < 500) return;
      }
    };
    await visit(folder.id, `${folder.name}/`);
    return { entries, totalBytes };
  }

  @Get("resources/:id")
  getResource(@Param("id") id: string) {
    return this.files.getResource(id);
  }

  @Get("folders/:id/children")
  listChildren(
    @Param("id") id: string,
    @Query("offset") rawOffset?: string,
    @Query("limit") rawLimit?: string,
  ) {
    const offset = rawOffset === undefined ? 0 : Number(rawOffset);
    const limit = rawLimit === undefined ? 100 : Number(rawLimit);
    return this.files.listChildren(id, offset, limit);
  }

  @Get("folders/resolve")
  resolveFolder(@Query() query: unknown) {
    const input = resolveFolderSchema.parse(query);
    const segments = input.path === "" ? [] : input.path.split("/");
    return this.files.resolveFolderPath(segments, input.rootId);
  }

  @Get("trash")
  listTrash(@Query("offset") rawOffset?: string, @Query("limit") rawLimit?: string) {
    return this.files.listTrash(rawOffset === undefined ? 0 : Number(rawOffset), rawLimit === undefined ? 100 : Number(rawLimit));
  }

  @Post("folders")
  createFolder(@Body() body: unknown) {
    const input = folderSchema.parse(body);
    return this.files.createFolder(input.parentId ?? ROOT_RESOURCE_ID, input.name);
  }

  @Post("uploads")
  async createUpload(
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Req() request: AuthenticatedOwnerRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = uploadSchema.parse(body);
    const policyResource = input.overwriteResourceId === undefined
      ? await this.files.getResource(input.parentId ?? ROOT_RESOURCE_ID)
      : await this.files.getResource(input.overwriteResourceId);
    this.#requireRecentProof(policyResource, request);
    const upload = await this.files.createUpload({
      filename: input.filename,
      expectedSize: input.expectedSize,
      ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
      ...(input.expectedSha256 === undefined ? {} : { expectedSha256: input.expectedSha256 }),
      ...(input.overwriteResourceId === undefined ? {} : { overwriteResourceId: input.overwriteResourceId }),
      idempotencyKey: requiredHeader(idempotencyKey, "Idempotency-Key"),
    });
    reply.status(201).header("Location", `/api/v1/uploads/${upload.id}`);
    return upload;
  }

  @Head("uploads/:id")
  async inspectUpload(@Param("id") id: string, @Res() reply: FastifyReply): Promise<void> {
    const upload = await this.files.getUpload(id);
    reply
      .header("Upload-Offset", upload.receivedSize)
      .header("Upload-Length", upload.expectedSize)
      .header("Upload-Status", upload.status)
      .status(204)
      .send();
  }

  @Patch("uploads/:id")
  @HttpCode(204)
  async appendUpload(
    @Param("id") id: string,
    @Headers("upload-offset") rawOffset: string | undefined,
    @Headers("content-length") rawLength: string | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (!(request.body instanceof Readable)) throw new Error("Upload body is invalid");
    const upload = await this.files.appendUpload(
      id,
      integerHeader(rawOffset, "Upload-Offset"),
      integerHeader(rawLength, "Content-Length"),
      request.body,
    );
    reply.header("Upload-Offset", upload.receivedSize).status(204).send();
  }

  @Post("uploads/:id/complete")
  completeUpload(@Param("id") id: string) {
    return this.files.completeUpload(id);
  }

  @Delete("uploads/:id")
  abandonUpload(@Param("id") id: string) {
    return this.files.abandonUpload(id);
  }

  @Get("files/:id/content")
  async download(
    @Param("id") id: string,
    @Headers("range") rawRange: string | undefined,
    @Req() request: AuthenticatedOwnerRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const resource = await this.files.getResource(id);
    this.#requireRecentProof(resource, request);
    const range = parseRange(rawRange, resource.sizeBytes);
    const download = await this.files.openDownload(id, range.offset, range.length);
    const contentLength = range.length ?? resource.sizeBytes;
    reply
      .header("Accept-Ranges", "bytes")
      .header("Content-Length", contentLength)
      .header("Content-Type", resource.mimeType ?? "application/octet-stream")
      .header("Content-Disposition", contentDisposition("attachment", resource.name))
      .header("ETag", `"sha256-${resource.sha256 ?? "unknown"}"`);
    if (range.partial) {
      reply.status(206).header(
        "Content-Range",
        `bytes ${String(range.offset)}-${String(range.offset + contentLength - 1)}/${String(resource.sizeBytes)}`,
      );
    }
    reply.send(this.transfers.trackDownload(download.stream, { filename: resource.name, totalBytes: contentLength }));
  }

  @Get("folders/:id/archive")
  async downloadFolder(
    @Param("id") id: string,
    @Req() request: AuthenticatedOwnerRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const folder = await this.files.getResource(id);
    if (folder.type !== "folder" || folder.status !== "active") throw new Error("Resource is not an active folder");
    this.#requireRecentProof(folder, request);
    const prepared = await this.#folderArchiveEntries(folder);
    const archive = archiver("zip", { zlib: { level: 6 } });
    reply
      .header("Content-Type", "application/zip")
      .header("Cache-Control", "no-store, private")
      .header("Pragma", "no-cache")
      .header("Content-Disposition", contentDisposition("attachment", `${folder.name}.zip`))
      .send(this.transfers.trackDownload(archive, { filename: `${folder.name}.zip`, totalBytes: prepared.totalBytes }));
    if (prepared.entries.length === 0) archive.append("", { name: `${folder.name}/` });
    for (const entry of prepared.entries) {
      if (entry.resource.type === "folder") {
        archive.append("", { name: entry.path });
        continue;
      }
      const files = this.files;
      archive.append(Readable.from((async function* () {
        const opened = await files.openDownload(entry.resource.id);
        for await (const chunk of opened.stream) yield chunk;
      })()), { name: entry.path });
    }
    await archive.finalize();
  }

  @Get("files/:id/preview")
  async preview(
    @Param("id") id: string,
    @Headers("range") rawRange: string | undefined,
    @Req() request: AuthenticatedOwnerRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const resource = await this.files.getResource(id);
    if (this.#isVolt(resource)) throw new ForbiddenException({ code: "preview_forbidden" });
    this.#requireRecentProof(resource, request);
    const mimeType = resource.mimeType ?? "application/octet-stream";
    if (!previewMimeTypes.has(mimeType)) throw new Error("File type is not eligible for inline preview");
    const range = parseRange(rawRange, resource.sizeBytes);
    const download = await this.files.openDownload(id, range.offset, range.length);
    const contentLength = range.length ?? resource.sizeBytes;
    reply
      .header("Accept-Ranges", "bytes")
      .header("Content-Length", contentLength)
      .header("Content-Type", mimeType)
      .header("Content-Disposition", contentDisposition("inline", resource.name))
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "default-src 'none'; sandbox; frame-ancestors 'none'")
      .header("ETag", `"sha256-${resource.sha256 ?? "unknown"}"`);
    if (range.partial) {
      reply.status(206).header(
        "Content-Range",
        `bytes ${String(range.offset)}-${String(range.offset + contentLength - 1)}/${String(resource.sizeBytes)}`,
      );
    }
    reply.send(this.transfers.trackDownload(download.stream, { filename: resource.name, totalBytes: contentLength }));
  }

  @Post("resources/:id/move")
  moveResource(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
  ) {
    const input = moveSchema.parse(body);
    return this.files.moveResource(id, {
      parentId: input.parentId,
      ...(input.name === undefined ? {} : { name: input.name }),
      idempotencyKey: requiredHeader(idempotencyKey, "Idempotency-Key"),
    });
  }

  @Post("resources/:id/copy")
  copyResource(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
  ) {
    const input = copySchema.parse(body);
    return this.files.copyResource(id, {
      parentId: input.parentId,
      ...(input.name === undefined ? {} : { name: input.name }),
      idempotencyKey: requiredHeader(idempotencyKey, "Idempotency-Key"),
    });
  }

  @Delete("resources/:id")
  trashResource(
    @Param("id") id: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
  ) {
    return this.files.trashResource(id, { idempotencyKey: requiredHeader(idempotencyKey, "Idempotency-Key") });
  }

  @Post("resources/:id/restore")
  restoreResource(
    @Param("id") id: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
  ) {
    return this.files.restoreResource(id, { idempotencyKey: requiredHeader(idempotencyKey, "Idempotency-Key") });
  }

  @Delete("trash/:id")
  purgeTrashFile(
    @Param("id") id: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
  ) {
    return this.files.purgeTrashFile(id, { idempotencyKey: requiredHeader(idempotencyKey, "Idempotency-Key") });
  }

  @Get("files/:id/versions")
  listVersions(
    @Param("id") id: string,
    @Query("offset") rawOffset?: string,
    @Query("limit") rawLimit?: string,
  ) {
    const offset = rawOffset === undefined ? 0 : Number(rawOffset);
    const limit = rawLimit === undefined ? 100 : Number(rawLimit);
    return this.files.listVersions(id, offset, limit);
  }

  @Post("files/:id/versions/:versionId/restore")
  restoreVersion(
    @Param("id") id: string,
    @Param("versionId") versionId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Req() request: AuthenticatedOwnerRequest,
  ) {
    return this.files.getResource(id).then((resource) => {
      this.#requireRecentProof(resource, request);
      return this.files.restoreVersion(id, versionId, {
      idempotencyKey: requiredHeader(idempotencyKey, "Idempotency-Key"),
      });
    });
  }
}
