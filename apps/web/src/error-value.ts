/** Keep an Error supplied by the caller and retain any other thrown value as its cause. */
export function errorValue(value: unknown, message = "The operation failed"): Error {
  return value instanceof Error ? value : new Error(message, { cause: value });
}
