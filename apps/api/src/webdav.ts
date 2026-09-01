import { Readable } from "node:stream";
import type { SaturnConfig } from "@saturn/config";
import { DeviceServiceError, resourceEtag, type DavEntry, type DeviceService } from "@saturn/sync";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function href(path: string, collection: boolean): string {
  const encoded = path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `/dav/${encoded}${collection && encoded ? "/" : ""}`;
}

function responseXml(entry: DavEntry): string {
  const resource = entry.resource;
  return `<d:response><d:href>${xml(href(entry.path, resource.type === "folder"))}</d:href><d:propstat><d:prop><d:displayname>${xml(resource.name)}</d:displayname><d:resourcetype>${resource.type === "folder" ? "<d:collection/>" : ""}</d:resourcetype><d:getcontentlength>${String(resource.sizeBytes)}</d:getcontentlength><d:getlastmodified>${xml(resource.updatedAt.toUTCString())}</d:getlastmodified><d:getetag>${xml(resourceEtag(resource))}</d:getetag>${resource.mimeType === undefined ? "" : `<d:getcontenttype>${xml(resource.mimeType)}</d:getcontenttype>`}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}

function multistatus(entries: readonly DavEntry[], includeVirtualRoot: boolean): string {
  const root = includeVirtualRoot ? "<d:response><d:href>/dav/</d:href><d:propstat><d:prop><d:displayname>Saturn</d:displayname><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>" : "";
  return `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${root}${entries.map(responseXml).join("")}</d:multistatus>`;
}

function range(value: string | undefined, size: number): { readonly offset: number; readonly length?: number } | undefined {
  if (value === undefined) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (match === null || (match[1] === "" && match[2] === "") || size === 0) throw new DeviceServiceError("precondition_failed");
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) throw new DeviceServiceError("precondition_failed");
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const offset = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Number(match[2]);
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || offset < 0 || end < offset || end >= size) throw new DeviceServiceError("precondition_failed");
  return { offset, length: end - offset + 1 };
}

function status(error: unknown): number {
  if (!(error instanceof DeviceServiceError)) return 400;
  return error.code === "unauthorized" ? 401 : error.code === "forbidden" ? 403 : error.code === "not_found" ? 404
    : error.code === "precondition_required" ? 428 : error.code === "precondition_failed" ? 412
      : error.code === "rate_limited" ? 429 : error.code === "limit" ? 507 : 409;
}

function destinationPath(request: FastifyRequest, raw: string | undefined, config: SaturnConfig): string {
  if (raw === undefined) throw new DeviceServiceError("invalid_path");
  let value: URL;
  try { value = new URL(raw, `${request.protocol}://${request.headers.host ?? request.hostname}`); } catch { throw new DeviceServiceError("invalid_path"); }
  const requestHost = (request.headers.host ?? request.hostname).toLowerCase();
  const configuredHost = new URL(config.publicOrigin).host.toLowerCase();
  if (value.host.toLowerCase() !== requestHost && value.host.toLowerCase() !== configuredHost) throw new DeviceServiceError("forbidden");
  if (!value.pathname.startsWith("/dav/")) throw new DeviceServiceError("invalid_path");
  return value.pathname.slice(5);
}

async function handler(request: FastifyRequest, reply: FastifyReply, devices: DeviceService, config: SaturnConfig): Promise<unknown> {
  reply.header("DAV", "1, 2").header("MS-Author-Via", "DAV").header("Cache-Control", "no-store");
  if (request.method === "OPTIONS") { reply.status(204).header("Allow", "OPTIONS, PROPFIND, GET, HEAD, PUT, MKCOL, MOVE, COPY, DELETE").send(); return; }
  try {
    const context = await devices.authenticate(request.headers.authorization);
    const rawUrl = request.url.split("?", 1)[0] ?? "/dav/";
    const rawPath = rawUrl.replace(/^\/dav\/?/, "");
    if (request.method === "PROPFIND") {
      const depthHeader = request.headers.depth ?? "1";
      if (depthHeader !== "0" && depthHeader !== "1") { reply.status(403).send(); return; }
      const entries = await devices.propfind(context, rawPath, depthHeader === "0" ? 0 : 1);
      return await reply.status(207).type("application/xml; charset=utf-8").send(multistatus(entries, rawPath === ""));
    }
    if (request.method === "GET" || request.method === "HEAD") {
      const entries = await devices.propfind(context, rawPath, 0);
      const resource = entries[0]?.resource;
      if (resource === undefined || resource.type !== "file") throw new DeviceServiceError("not_found");
      let selected: ReturnType<typeof range>;
      try { selected = range(request.headers.range, resource.sizeBytes); }
      catch { reply.status(416).header("Content-Range", `bytes */${String(resource.sizeBytes)}`).send(); return; }
      const length = selected?.length ?? resource.sizeBytes;
      reply.header("Accept-Ranges", "bytes").header("Content-Length", length).header("ETag", resourceEtag(resource)).header("Last-Modified", resource.updatedAt.toUTCString()).type(resource.mimeType ?? "application/octet-stream");
      if (selected !== undefined) reply.status(206).header("Content-Range", `bytes ${String(selected.offset)}-${String(selected.offset + length - 1)}/${String(resource.sizeBytes)}`);
      if (request.method === "HEAD") { reply.send(); return; }
      return await reply.send((await devices.openRead(context, rawPath, selected)).stream);
    }
    if (request.method === "PUT") {
      const size = Number(request.headers["content-length"]);
      if (!Number.isSafeInteger(size) || size < 0) { reply.status(411).send(); return; }
      let body: Readable;
      if (request.body instanceof Readable) body = request.body;
      else if (Buffer.isBuffer(request.body)) body = Readable.from(request.body);
      else if (typeof request.body === "string") body = Readable.from(Buffer.from(request.body));
      else if (request.body === undefined && size === 0) body = Readable.from([]);
      else throw new DeviceServiceError("limit");
      const result = await devices.put(context, rawPath, body, size, { ...(request.headers["if-match"] === undefined ? {} : { ifMatch: request.headers["if-match"] }), ...(request.headers["if-none-match"] === undefined ? {} : { ifNoneMatch: request.headers["if-none-match"] }) });
      reply.header("ETag", resourceEtag(result.resource)).header("Location", href([...rawPath.split("/").slice(0, -1), result.resource.name].join("/"), false));
      if (result.conflict) reply.status(409).header("X-Vault-Conflict-Resource", result.resource.id).send(); else reply.status(result.created ? 201 : 204).send();
      return;
    }
    if (request.method === "MKCOL") { await devices.createCollection(context, rawPath); reply.status(201).send(); return; }
    if (request.method === "MOVE" || request.method === "COPY") {
      const destination = request.headers.destination;
      await devices.move(context, rawPath, destinationPath(request, Array.isArray(destination) ? destination[0] : destination, config), request.method === "COPY", String(request.headers.overwrite ?? "T").toUpperCase() !== "F");
      reply.status(201).send(); return;
    }
    if (request.method === "DELETE") { await devices.remove(context, rawPath); reply.status(204).send(); return; }
    reply.status(405).send();
  } catch (error) {
    const code = status(error);
    if (code === 401) reply.header("WWW-Authenticate", 'Basic realm="Saturn WebDAV", charset="UTF-8"');
    reply.status(code).send();
  }
}

export function registerWebDav(instance: FastifyInstance, devices: DeviceService, config: SaturnConfig): void {
  const method = ["OPTIONS", "PROPFIND", "GET", "HEAD", "PUT", "MKCOL", "MOVE", "COPY", "DELETE"] as const;
  for (const url of ["/dav", "/dav/*"]) instance.route({ method: method as never, url, handler: (request, reply) => handler(request, reply, devices, config) });
}
