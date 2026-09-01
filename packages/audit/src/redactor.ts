const SECRET_KEY = /authorization|cookie|password|passwd|secret|token|private.?key|credential|session/i;
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const URI_CREDENTIAL = /([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+@/gi;
const MAX_DEPTH = 20;
const MAX_STRING = 16_384;
const MAX_ARRAY = 1_000;
const MAX_OBJECT_KEYS = 1_000;

export type RedactedValue = null | boolean | number | string | readonly RedactedValue[] | { readonly [key: string]: RedactedValue };

function redactString(raw: string, secrets: readonly string[]): string {
  let value = raw.length > MAX_STRING ? `${raw.slice(0, MAX_STRING)}[TRUNCATED]` : raw;
  value = value.replace(BEARER, "Bearer [REDACTED]").replace(URI_CREDENTIAL, "$1[REDACTED]@");
  for (const secret of secrets) {
    if (secret.length >= 8) value = value.replaceAll(secret, "[REDACTED]");
  }
  return value;
}

export function redact(value: unknown, knownSecrets: readonly string[] = [], depth = 0): RedactedValue {
  if (depth > MAX_DEPTH) return "[MAX_DEPTH]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactString(value, knownSecrets);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    const selected = value.slice(0, MAX_ARRAY).map((item) => redact(item, knownSecrets, depth + 1));
    return value.length > MAX_ARRAY ? [...selected, "[TRUNCATED]"] : selected;
  }
  if (typeof value === "object") {
    const output: Record<string, RedactedValue> = {};
    const entries = Object.entries(value).slice(0, MAX_OBJECT_KEYS);
    for (const [key, item] of entries) {
      output[key] = SECRET_KEY.test(key) ? "[REDACTED]" : redact(item, knownSecrets, depth + 1);
    }
    if (Object.keys(value).length > MAX_OBJECT_KEYS) output.__truncated__ = true;
    return output;
  }
  return `[${typeof value}]`;
}
