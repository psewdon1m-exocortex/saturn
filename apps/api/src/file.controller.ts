import { Readable } from "node:stream";
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
import { ROOT_RESOURCE_ID, type FileService } from "@saturn/file-core";
import type { SaturnConfig } from "@saturn/config";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { OwnerTokenGuard } from "./owner-token.guard.js";
import { OWNER_SESSION, type AuthenticatedOwnerRequest } from "./owner-token.guard.js";
import { APP_CONFIG, FILE_SERVICE } from "./tokens.js";
import { SaturnApiExceptionFilter } from "./saturn-api-exception.filter.js";

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
  constructor(@Inject(FILE_SERVICE) private readonly files: FileService, @Inject(APP_CONFIG) private readonly config: SaturnConfig) {}

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
    reply.send(download.stream);
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
    reply.send(download.stream);
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
