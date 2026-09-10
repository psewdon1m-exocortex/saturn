import { describe, expect, it } from "vitest";
import { detectContentType } from "./content-type.js";

describe("detectContentType", () => {
  it("recognizes safe Markdown text by extension", async () => {
    await expect(detectContentType("notes.md", Buffer.from("# Saturn\n\nHello."))).resolves.toBe("text/markdown");
  });

  it("does not label binary data as Markdown", async () => {
    await expect(detectContentType("notes.md", Buffer.from([0, 1, 2, 3]))).resolves.toBe("application/octet-stream");
  });

  it("recognizes textual SVG without trusting the extension alone", async () => {
    await expect(detectContentType("planet.svg", Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"))).resolves.toBe("image/svg+xml");
    await expect(detectContentType("planet.svg", Buffer.from("not an svg"))).resolves.toBe("application/octet-stream");
  });
});
