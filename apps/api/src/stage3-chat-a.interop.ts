import type { SyncRootBinding } from "../../../packages/contracts/src/sync-protocol.js";
import { requireDefined } from "../../../packages/contracts/src/require-defined.js";
import "reflect-metadata";
import fs from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { expect } from "vitest";
import { PlutoController } from "./pluto.controller.js";
import { DEVICE_SERVICE } from "./tokens.js";
import { guardedSyncFolderHttp } from "./guarded-sync-folder-http.js";
import { guardedSyncUploadHttp, GUARDED_UPLOAD_FRAME_TYPE } from "./guarded-sync-upload-http.js";
import { catalogUploadPublicationIntentHash, parseCatalogUploadPrepareInput } from "../../../packages/file-core/src/catalog-upload-intent.js";
import { parseStorageVerifyRequest, parseStorageVerifyResult } from "../../../packages/contracts/src/storage-verifier.js";
import { activeFixture, evidence, sha, uid } from "./stage3-chat-a.fixture.js";

type Fixture = Awaited<ReturnType<typeof activeFixture>>;
type FolderInput = Parameters<Fixture["files"]["ensureCatalogFolderV2"]>[0];
type FolderOutcome = Awaited<ReturnType<Fixture["files"]["ensureCatalogFolderV2"]>>;
interface DirectoryArtifact { examples: { request: { binding: SyncRootBinding; items: { input: FolderInput }[] } }[] }
interface DirectoryResponse { items: { outcome: FolderOutcome }[] }
interface PublicationResponse { result: { status: string; intentHash: string } }

/** Consume saved production-caller bytes. Binding transplantation is explicit;
 * original operation IDs and names are retained, foreign authority is refused. */
export async function runChatAInterop() {
  const dir = path.join(requireDefined(process.env.STAGE3_CHAT_A_EVIDENCE), "A15", "interop-input");
  const manifest = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8")) as Record<string,{sha256:string}>;
  const read = async <T>(name: string): Promise<T> => { const bytes = await fs.readFile(path.join(dir, name)); expect(sha(bytes)).toBe(requireDefined(manifest[name]).sha256); return JSON.parse(bytes.toString()) as T; };
  const codec = await read<{count:number;fixtureSha256:string}>("b-codec.json"), codecBytes = await fs.readFile(new URL("../../../packages/contracts/fixtures/name-codec-v1.json", import.meta.url));
  expect(codec.count).toBe(28); expect(codec.fixtureSha256).toBe(sha(codecBytes));
  const artifact = await read<DirectoryArtifact>("b-directories.json"), example = requireDefined(artifact.examples[0]), f = await activeFixture("A15-B-wire"), app = Fastify();
  try {
    await app.register(guardedSyncFolderHttp, { root: id => Promise.resolve(id === f.rootId ? { binding: f.wireBinding, authority: f.issuer, files: f.files, extensions: ["folder-batch-v1"] } : undefined) });
    const request = (body: object) => app.inject({ method: "POST", url: `/sync/v1/roots/${f.rootId}/directories/batch`, headers: { authorization: f.authorization }, payload: body });
    expect((await request(example.request)).statusCode).toBe(409);
    expect(await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id FROM operation_journal WHERE sync_root_id=${f.rootId}`)).toHaveLength(0);
    const rootName = requireDefined((await f.admin.withSql(sql => sql<{name:string}[]>`SELECT name FROM resources WHERE id=${f.rootId}`))[0]).name;
    const oldBinding = example.request.binding;
    const mapping: Record<string, string> = { [oldBinding.root_id]: f.rootId, [oldBinding.server_epoch]: f.binding.epoch, [oldBinding.binding_version]: f.binding.bindingVersion };
    const items = example.request.items.map(item => ({ ...item, input: { ...item.input, rootId: f.rootId, epoch: f.binding.epoch, bindingVersion: f.binding.bindingVersion, parentId: mapping[item.input.parentId] ?? item.input.parentId, parentTopology: item.input.parentTopology.map(p => ({ ...p, nodeId: mapping[p.nodeId] ?? p.nodeId, parentId: p.parentId===null?null:mapping[p.parentId] ?? p.parentId, name: p.nodeId === oldBinding.root_id ? rootName : p.name })) } }));
    const body = { binding: f.wireBinding, items }, first = await request(body); expect(first.statusCode).toBe(200);
    const outcomes = first.json<DirectoryResponse>().items; expect(outcomes).toHaveLength(items.length); expect(outcomes.every(o => o.outcome.result.status === "CREATED")).toBe(true);
    const replay = await request(body); expect(replay.statusCode).toBe(200);
    expect(replay.json<DirectoryResponse>().items.map(o => o.outcome.result)).toEqual(outcomes.map(o => o.outcome.result));
    const originals = await f.admin.withSql(sql => sql<{id:string;sync_result:unknown}[]>`SELECT id,sync_result FROM operation_journal WHERE sync_root_id=${f.rootId} ORDER BY id`);
    expect(originals).toHaveLength(items.length); expect(originals.map(o => o.id).sort()).toEqual(items.map(i => i.input.operationId).sort());
    await evidence("A15", "B-directory-interop", { artifact: manifest["b-directories.json"], mapping, originalBinding: oldBinding, fixtureBinding: f.wireBinding, request: body, response: first.json<DirectoryResponse>(), originalCount: originals.length, replayExact: true });
  } finally { await app.close(); await f.close(); }

  const c = await activeFixture("A15-C-wire", "pluto"), checkIn = await read<Record<string,unknown>>("c-checkin.json");
  @Module({ controllers: [PlutoController], providers: [{ provide: DEVICE_SERVICE, useValue: c.devices }] })
  class InteropModule { readonly fixture = "stage3-chat-a-interop"; }
  const adapter = new FastifyAdapter({ logger: false }), nest = await NestFactory.create<NestFastifyApplication>(InteropModule, adapter, { logger: false });
  nest.setGlobalPrefix("api/v1");
  try {
    await nest.init(); await adapter.getInstance().ready();
    const response = await adapter.getInstance().inject({ method: "POST", url: "/api/v1/pluto/check-in", headers: { authorization: c.authorization }, payload: checkIn });
    expect(response.statusCode).toBe(201);
    await evidence("A15", "C-K3-interop", { artifact: manifest["c-checkin.json"], request: checkIn, response: response.json<unknown>(), rootId: c.rootId });
    const k4 = await read<{request:unknown;response:unknown}>("c-k4.json"), parsed = parseStorageVerifyRequest(k4.request);
    expect(parseStorageVerifyResult(k4.response, parsed)).toEqual(k4.response);
    await evidence("A15", "C-K4-interop", { artifact: manifest["c-k4.json"], request: parsed, response: k4.response });
    const caller = await read<{catalogInput:unknown;catalogStatus:PublicationResponse}>("c-catalog.json"), original = parseCatalogUploadPrepareInput(caller.catalogInput);
    expect(catalogUploadPublicationIntentHash(original.intent)).toBe(caller.catalogStatus.result.intentHash);
    if (original.intent.schema !== "saturn.upload-intent.v2") throw Error("C v2 wire required");
    const fixtureIntent = c.uploadInput("unused", Buffer.alloc(0)).intent;
    const mapping: Record<string, string> = { [original.intent.rootId]: c.rootId, [original.intent.deviceId]: fixtureIntent.deviceId };
    let topology = [...fixtureIntent.parentTopology], parentId = c.rootId;
    for (const ancestor of [...original.intent.parentTopology].reverse().slice(1)) {
      const created = await c.files.ensureCatalogFolderV2({ operationId: uid(), idempotencyKey: uid(), rootId: c.rootId, epoch: c.binding.epoch, bindingVersion: c.binding.bindingVersion, parentId, parentTopology: topology, name: ancestor.name, mode: "ensure" }, c.proof);
      mapping[ancestor.nodeId] = created.result.description.node_id; parentId = created.result.description.node_id;
      topology = [{ nodeId: parentId, parentId: created.result.description.parent_id, name: ancestor.name }, ...topology];
    }
    const input = parseCatalogUploadPrepareInput({ ...original, epoch: c.binding.epoch, bindingVersion: c.binding.bindingVersion, backendIdentity: c.backendIdentity, intent: { ...original.intent, rootId: c.rootId, deviceId: fixtureIntent.deviceId, parentId, parentTopology: topology } });
    const bytes = Buffer.from("safe fixture"); // Exact fixture bytes in C TestStage3C13ConcurrentStatusShutdownAndCheckinWire.
    expect(sha(bytes)).toBe(input.intent.sha256); expect(String(bytes.length)).toBe(input.intent.sizeBytes);
    const catalog = Fastify();
    try {
      await catalog.register(guardedSyncUploadHttp, { root: () => Promise.resolve({ binding: c.wireBinding, authority: c.issuer, files: c.files }) });
      const request = (command: string, payload: object | Buffer, binary = false) => catalog.inject({ method: binary ? "PATCH" : "POST", url: `/sync/v1/roots/${c.rootId}/catalog-uploads/` + command, headers: { authorization: c.authorization, "content-type": binary ? GUARDED_UPLOAD_FRAME_TYPE : "application/json" }, payload });
      const prepared = await request("prepare", { binding: c.wireBinding, input }); expect(prepared.statusCode).toBe(200);
      const upload_id = prepared.json<{session:{uploadId:string}}>().session.uploadId, body = { binding: c.wireBinding, input, upload_id }, metadata = Buffer.from(JSON.stringify({ ...body, offset: "0" })), length = Buffer.alloc(4); length.writeUInt32BE(metadata.length);
      expect((await request("append", Buffer.concat([length, metadata, bytes]), true)).statusCode).toBe(200);
      const terminal = await request("complete", body); expect(terminal.statusCode).toBe(200); expect(terminal.json<PublicationResponse>().result.status).toBe("PUBLISHED");
      expect(terminal.json<PublicationResponse>().result.intentHash).toBe(catalogUploadPublicationIntentHash(input.intent));
      expect((await request("complete", body)).json<PublicationResponse>().result).toEqual(terminal.json<PublicationResponse>().result);
      expect(await c.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id FROM operation_journal WHERE id=${upload_id} AND sync_result IS NOT NULL`)).toHaveLength(1);
      await evidence("A15", "C-catalog-interop", { artifact: manifest["c-catalog.json"], mapping, originalIntentHash: caller.catalogStatus.result.intentHash, request: body, response: terminal.json<unknown>(), originalIdempotencyKeyPreserved: input.intent.idempotencyKey });
    } finally { await catalog.close(); }
  } finally { await nest.close(); await c.close(); }
  await evidence("A15", "interop-coverage", { accepted: ["B actual directory request with documented fixture binding map", "C actual K3 check-in through native Nest HTTP controller", "C actual K4 request/result strict contract", "C actual catalog input: Go/TS canonical hash agreement and own HTTP upload/receipt replay"], unavailable: ["B/C metadata batch wire", "B/C stream wire", "B/C adoption wire", "C directory wire"], complete: false });
}
