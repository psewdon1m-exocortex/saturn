import { describe, expect, it } from "vitest";
import { parseRange } from "./file.controller.js";

describe("file preview byte ranges", () => {
  it("serves bounded and suffix ranges used by browser video players", () => {
    expect(parseRange("bytes=1024-2047", 4096)).toEqual({ offset: 1024, length: 1024, partial: true });
    expect(parseRange("bytes=-512", 4096)).toEqual({ offset: 3584, length: 512, partial: true });
    expect(parseRange(undefined, 4096)).toEqual({ offset: 0, partial: false });
  });

  it("rejects a range outside the stored object", () => {
    expect(() => parseRange("bytes=4096-4097", 4096)).toThrow(/Range is invalid/);
  });
});
