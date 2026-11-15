/** Fail at the fixture boundary instead of hiding a missing value from TypeScript. */
export function requiredValue<T>(value: T, message = "Required test fixture value is missing"): NonNullable<T> {
  if (value === undefined || value === null) throw new Error(message);
  return value;
}

/** Build a corrupted reply without mutating the original fixture or casting it to any. */
export function withReceiptFields<T extends { readonly items: readonly { readonly receipt: unknown }[] }>(value: T, index: number, fields: Readonly<Record<string, unknown>>) {
  const receipt = requiredValue(value.items[index]).receipt;
  if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) throw new Error("Fixture receipt must be an object");
  return { ...value, items: value.items.map((item, position) => position === index ? { ...item, receipt: { ...receipt, ...fields } } : item) };
}
