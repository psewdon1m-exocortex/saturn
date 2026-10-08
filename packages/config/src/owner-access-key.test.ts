import { expect, it } from "vitest";
import { decodeOwnerAccessKey, encodeOwnerAccessKey } from "./owner-access-key.js";

it.each(["a", "  ", " x\n\r\tключ!? ", "x".repeat(2048), "$(never-execute) `opaque` # !", "tail\n\n"])("round-trips explicitly supplied opaque key %j", value => {
  expect(decodeOwnerAccessKey(encodeOwnerAccessKey(value))).toBe(value);
});
it("reads the previous provisioner's line framing without trimming spaces", () => {
  expect(decodeOwnerAccessKey(" legacy key \r\n")).toBe(" legacy key ");
  expect(() => encodeOwnerAccessKey("")).toThrow("not configured");
  expect(() => decodeOwnerAccessKey('SATURN_OWNER_ACCESS_KEY_V1\n{}')).toThrow("not configured");
});
