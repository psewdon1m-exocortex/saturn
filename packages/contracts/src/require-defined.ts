/** Narrow a required internal value and fail explicitly if its invariant broke. */
export function requireDefined<T>(value: T): NonNullable<T> {
  if (value === null || value === undefined) throw new Error("Required value is missing");
  return value;
}
