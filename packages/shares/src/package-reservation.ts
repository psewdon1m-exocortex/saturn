import type { SharePackageEntry } from "./types.js";

/** zlib 1.3.1 deflateBound's conservative fixed/stored-block bounds. Taking
 * their maximum also covers nondefault window/memory settings. The pinned
 * yazl producer uses raw Deflate with NO_FLUSH/FINISH, never extra flushes.
 * https://github.com/madler/zlib/blob/v1.3.1/deflate.c#L772-L830 */
function deflateReservation(bytes: bigint): bigint {
  const fixed = bytes + (bytes >> 3n) + (bytes >> 8n) + (bytes >> 9n) + 4n;
  const stored = bytes + (bytes >> 5n) + (bytes >> 7n) + (bytes >> 11n) + 7n;
  return (fixed > stored ? fixed : stored) + 6n;
}

/** Physical admission bound including independent ZIP64/header allowance and
 * both UTF8 path copies. Custody limits and produced-byte enforcement remain. */
export function packageArchiveReservation(entries: readonly SharePackageEntry[]): number {
  let bytes = 4096n;
  const names = new Set<string>();
  for (const entry of entries) {
    const name = entry.path, parts = name.replace(/\/$/, "").split("/");
    if (!name || name !== name.normalize("NFC") || name.startsWith("/") || name.includes("\\") || Array.from(name).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
      || /^[A-Za-z]:/.test(name) || parts.some(part => !part || part === "." || part === "..") || Buffer.byteLength(name) > 65_535) throw new Error("Package member path is unsafe");
    const key = name.replace(/\/$/, "").toLocaleLowerCase("en-US");
    if (names.has(key)) throw new Error("Package has colliding member paths");
    names.add(key);
    if (!Number.isSafeInteger(entry.resource.sizeBytes) || entry.resource.sizeBytes < 0) throw new Error("Package source size is invalid");
    bytes += BigInt(Buffer.byteLength(name)) * 2n + 1536n;
    if (entry.resource.type === "file") bytes += deflateReservation(BigInt(entry.resource.sizeBytes));
  }
  if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Package reservation exceeds safe size");
  return Number(bytes);
}

export class PackageByteReservation {
  #accepted = 0;
  constructor(private readonly maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error("Invalid package byte reservation");
  }
  accept(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.maximum - this.#accepted) throw new Error("Package byte reservation exceeded");
    this.#accepted += bytes;
  }
}
