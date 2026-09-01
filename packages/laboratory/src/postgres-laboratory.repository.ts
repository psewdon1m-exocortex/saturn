import type { Database } from "@saturn/database";
import type { LaboratoryAsset, LaboratoryClient, LaboratoryRepository } from "./types.js";

interface ClientRow {
  id: string; name: string; token_hash: string; previous_token_hash: string | null; previous_token_expires_at: Date | null;
  state: LaboratoryClient["state"]; last_used_at: Date | null; created_at: Date; updated_at: Date; revoked_at: Date | null;
}
interface AssetRow {
  id: string; resource_id: string; mode: LaboratoryAsset["mode"]; pinned_version_id: string | null; public_filename: string;
  label: string; disposition: LaboratoryAsset["disposition"]; state: LaboratoryAsset["state"]; created_at: Date; updated_at: Date; disabled_at: Date | null;
}
function client(row: ClientRow): LaboratoryClient {
  return { id: row.id, name: row.name, tokenHash: row.token_hash,
    ...(row.previous_token_hash === null ? {} : { previousTokenHash: row.previous_token_hash }),
    ...(row.previous_token_expires_at === null ? {} : { previousTokenExpiresAt: row.previous_token_expires_at }),
    state: row.state, ...(row.last_used_at === null ? {} : { lastUsedAt: row.last_used_at }), createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }) };
}
function asset(row: AssetRow): LaboratoryAsset {
  return { id: row.id, resourceId: row.resource_id, mode: row.mode,
    ...(row.pinned_version_id === null ? {} : { pinnedVersionId: row.pinned_version_id }), publicFilename: row.public_filename,
    label: row.label, disposition: row.disposition, state: row.state, createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.disabled_at === null ? {} : { disabledAt: row.disabled_at }) };
}

export class PostgresLaboratoryRepository implements LaboratoryRepository {
  constructor(private readonly database: Database) {}
  createClient(value: LaboratoryClient): Promise<void> { return this.database.withSql(async (sql) => { await sql`INSERT INTO laboratory_clients(id,name,token_hash,state,created_at,updated_at) VALUES (${value.id},${value.name},${value.tokenHash},${value.state},${value.createdAt},${value.updatedAt})`; }); }
  listClients(offset: number, limit: number): Promise<readonly LaboratoryClient[]> { return this.database.withSql(async (sql) => (await sql<ClientRow[]>`SELECT * FROM laboratory_clients ORDER BY created_at DESC,id DESC OFFSET ${offset} LIMIT ${limit}`).map(client)); }
  rotateClientToken(id: string, tokenHash: string, previousTokenExpiresAt: Date, now: Date): Promise<LaboratoryClient> { return this.database.withSql(async (sql) => { const rows=await sql<ClientRow[]>`UPDATE laboratory_clients SET previous_token_hash=token_hash,previous_token_expires_at=${previousTokenExpiresAt},token_hash=${tokenHash},updated_at=${now} WHERE id=${id} AND state='active' RETURNING *`; if(!rows[0])throw new Error("Laboratory client not found or not active");return client(rows[0]); }); }
  revokeClient(id: string, now: Date): Promise<LaboratoryClient> { return this.database.withSql(async (sql) => { const rows=await sql<ClientRow[]>`UPDATE laboratory_clients SET state='revoked',previous_token_hash=NULL,previous_token_expires_at=NULL,revoked_at=${now},updated_at=${now} WHERE id=${id} RETURNING *`;if(!rows[0])throw new Error("Laboratory client not found");return client(rows[0]); }); }
  authenticateClient(tokenHash: string, now: Date): Promise<{ readonly client: LaboratoryClient; readonly usedPreviousToken: boolean } | undefined> { return this.database.transaction(async (sql) => { const rows=await sql<ClientRow[]>`SELECT * FROM laboratory_clients WHERE state='active' AND (token_hash=${tokenHash} OR (previous_token_hash=${tokenHash} AND previous_token_expires_at>${now})) LIMIT 1 FOR UPDATE`;const row=rows[0];if(!row)return undefined;await sql`UPDATE laboratory_clients SET last_used_at=${now} WHERE id=${row.id}`;return{client:client({...row,last_used_at:now}),usedPreviousToken:row.token_hash!==tokenHash}; }); }
  createAsset(value: LaboratoryAsset): Promise<LaboratoryAsset> { return this.database.withSql(async (sql) => { const rows=await sql<AssetRow[]>`INSERT INTO laboratory_assets(id,resource_id,mode,pinned_version_id,public_filename,label,disposition,state,created_at,updated_at) VALUES (${value.id},${value.resourceId},${value.mode},${value.pinnedVersionId??null},${value.publicFilename},${value.label},${value.disposition},${value.state},${value.createdAt},${value.updatedAt}) RETURNING *`;if(!rows[0])throw new Error("Laboratory asset create failed");return asset(rows[0]); }); }
  getAsset(id: string): Promise<LaboratoryAsset | undefined> { return this.database.withSql(async (sql) => { const rows=await sql<AssetRow[]>`SELECT * FROM laboratory_assets WHERE id=${id} LIMIT 1`;return rows[0]===undefined?undefined:asset(rows[0]); }); }
  listAssets(offset: number, limit: number): Promise<readonly LaboratoryAsset[]> { return this.database.withSql(async (sql) => (await sql<AssetRow[]>`SELECT * FROM laboratory_assets ORDER BY created_at DESC,id DESC OFFSET ${offset} LIMIT ${limit}`).map(asset)); }
  updateAsset(id: string, input: Parameters<LaboratoryRepository["updateAsset"]>[1], now: Date): Promise<LaboratoryAsset> { return this.database.transaction(async (sql) => { const rows=await sql<AssetRow[]>`SELECT * FROM laboratory_assets WHERE id=${id} FOR UPDATE`;const currentRow=rows[0];if(!currentRow)throw new Error("Laboratory asset not found");const current=asset(currentRow);if(current.state!=="active")throw new Error("Laboratory asset is disabled");const updated=await sql<AssetRow[]>`UPDATE laboratory_assets SET mode=${input.mode??current.mode},pinned_version_id=${input.pinnedVersionId===undefined?current.pinnedVersionId??null:input.pinnedVersionId},label=${input.label??current.label},disposition=${input.disposition??current.disposition},updated_at=${now} WHERE id=${id} RETURNING *`;if(!updated[0])throw new Error("Laboratory asset update failed");return asset(updated[0]); }); }
  disableAsset(id: string, now: Date): Promise<LaboratoryAsset> { return this.database.withSql(async (sql) => { const rows=await sql<AssetRow[]>`UPDATE laboratory_assets SET state='disabled',disabled_at=${now},updated_at=${now} WHERE id=${id} RETURNING *`;if(!rows[0])throw new Error("Laboratory asset not found");return asset(rows[0]); }); }
}
