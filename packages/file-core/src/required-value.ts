/** An internal collection or receipt invariant must fail before using a missing value. */
export function requiredValue<T>(value: T): NonNullable<T> {
  if (value === undefined || value === null) throw new Error("catalog_original_value_missing");
  return value;
}
