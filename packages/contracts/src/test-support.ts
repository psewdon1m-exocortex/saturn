/** Fail at the fixture boundary when a test requires an observed value. */
export function requireTestValue<T>(value: T): NonNullable<T> {
  if (value === undefined || value === null) throw new Error("Required test fixture value is missing");
  return value;
}
