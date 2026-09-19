import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const backupLimit = 128 * 1024 * 1024;
export function backupReceipt(archive: Buffer, filename: string, service: string, head: string, version: string, token: string) {
  if (archive.length > backupLimit || archive.subarray(0, 2).toString() !== "PK") throw new Error("A standard ZIP up to 128 MiB is required");
  const receipt = { schema: "exocortex.update-backup.v2", id: randomUUID(), head_id: head, service, version,
    sha256: createHash("sha256").update(archive).digest("hex"), size: archive.length, filename, expires: Math.floor(Date.now() / 1000) + 900 };
  const body = Buffer.from(JSON.stringify(receipt)).toString("base64url");
  return `${body}.${createHmac("sha256", token).update(body).digest("base64url")}`;
}
export function savedBackup(archive: Buffer, signed: string, token: string, service: string, head: string) {
  if (signed.length > 8192) throw new Error("Invalid backup receipt");
  const [body = "", signature = "", extra] = signed.split(".");
  const expected = createHmac("sha256", token).update(body).digest();
  const actual = Buffer.from(signature, "base64url");
  if (extra !== undefined || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("Invalid backup receipt signature");
  const receipt = JSON.parse(Buffer.from(body, "base64url").toString()) as Record<string, unknown>;
  const sha256 = createHash("sha256").update(archive).digest("hex");
  if (receipt.schema !== "exocortex.update-backup.v2" || receipt.service !== service || receipt.head_id !== head || typeof receipt.expires !== "number" || receipt.expires < Date.now() / 1000
      || receipt.sha256 !== sha256 || receipt.size !== archive.length || archive.length > backupLimit) throw new Error("Saved ZIP does not match this installation or has expired");
  return { request_id: receipt.id, head_id: head, service, version: receipt.version, backup_receipt: signed, operator_saved: true,
    backup: { filename: receipt.filename, sha256, data_base64: archive.toString("base64") } };
}
export async function readUpdateBytes(body: unknown): Promise<Buffer> {
  if (!body || typeof body !== "object" || !(Symbol.asyncIterator in body)) throw new Error("Upload the saved ZIP as application/octet-stream");
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of body as AsyncIterable<Buffer>) {
    if (!Buffer.isBuffer(chunk)) throw new Error("Invalid ZIP stream");
    size += chunk.length; if (size > backupLimit) throw new Error("ZIP exceeds 128 MiB"); chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
