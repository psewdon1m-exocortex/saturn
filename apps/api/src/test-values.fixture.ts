/** Fixture requirements are checked at runtime rather than asserted away in types. */
export function fixtureValue<T>(value: T): NonNullable<T> {
  if (value === undefined || value === null) throw new Error("Required fixture value is absent");
  return value;
}

export function fixtureRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Fixture object is invalid");
  return value as Record<string, unknown>;
}

export function fixtureString(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Fixture string is invalid");
  return value;
}

/** Bind an optional fixture capability to its receiver after checking it exists. */
export function fixtureMethod<T, K extends keyof T>(receiver: T, key: K): NonNullable<T[K]> {
  const method: unknown = receiver[key];
  if (typeof method !== "function") throw new Error("Required fixture method is absent");
  const bound = (...args: unknown[]): unknown => {
    const result: unknown = Reflect.apply(method, receiver, args);
    return result;
  };
  return bound as NonNullable<T[K]>;
}

/** Prototype instrumentation forwards the eventual receiver instead of binding the prototype. */
export function fixtureForwardMethod<T, K extends keyof T>(receiver: T, key: K): T[K] {
  const method: unknown = receiver[key];
  if (typeof method !== "function") throw new Error("Required fixture method is absent");
  const forward = function(this: unknown, ...args: unknown[]): unknown {
    const result: unknown = Reflect.apply(method, this, args);
    return result;
  };
  return forward as T[K];
}

/** Binary readback accepts bytes and fails clearly on an invalid stream chunk. */
export async function* fixtureChunks(source: AsyncIterable<unknown>): AsyncGenerator<Buffer> {
  for await (const value of source) {
    if (typeof value === "string") yield Buffer.from(value);
    else if (value instanceof Uint8Array) yield Buffer.from(value);
    else throw new TypeError("Fixture readback yielded a non-byte chunk");
  }
}
