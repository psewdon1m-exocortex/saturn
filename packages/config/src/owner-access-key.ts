import fs from "node:fs";

const marker = "SATURN_OWNER_ACCESS_KEY_V1\n";

/** Explicit keys are encoded as a JSON string so all UTF-8 text round-trips. */
export function encodeOwnerAccessKey(value: string): string {
  if (value.length === 0) throw new Error("Owner access key is not configured");
  return marker + JSON.stringify(value);
}

export function decodeOwnerAccessKey(source: string): string {
  let value: unknown;
  if (source.startsWith(marker)) value = JSON.parse(source.slice(marker.length)) as unknown;
  else {
    // Pre-v1 files have one line terminator written by the old provisioner.
    // This is legacy file framing only; new keys always use the exact encoding.
    value = source.replace(/\r?\n$/, "");
  }
  if (typeof value !== "string" || value.length === 0) throw new Error("Owner access key is not configured");
  return value;
}

export function readOwnerAccessKey(filename: string): string {
  return decodeOwnerAccessKey(fs.readFileSync(filename,"utf8"));
}
