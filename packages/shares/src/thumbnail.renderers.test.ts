import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCanvas, loadImage, PDFDocument } from "@napi-rs/canvas";
import ffmpegPath from "ffmpeg-static";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderThumbnail } from "./thumbnail.service.js";

const ffmpegExecutable: string | null = typeof ffmpegPath === "string"
  ? ffmpegPath
  : (ffmpegPath as unknown as { readonly default?: string | null }).default ?? null;

let directory = "";
let imagePath = "";
let oversizedImagePath = "";
let pdfPath = "";
let videoPath = "";

beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "saturn-thumbnail-renderers-"));
  imagePath = path.join(directory, "image.png");
  oversizedImagePath = path.join(directory, "oversized-image.svg");
  pdfPath = path.join(directory, "document.pdf");
  videoPath = path.join(directory, "video.mp4");

  const image = createCanvas(160, 90);
  const imageContext = image.getContext("2d");
  imageContext.fillStyle = "#4c705e";
  imageContext.fillRect(0, 0, 160, 90);
  imageContext.fillStyle = "#fffdf4";
  imageContext.fillRect(30, 25, 100, 40);
  await fs.writeFile(imagePath, await image.encode("png"));
  await fs.writeFile(oversizedImagePath, '<svg xmlns="http://www.w3.org/2000/svg" width="7000" height="7000"><rect width="100%" height="100%" fill="black"/></svg>');

  const pdf = new PDFDocument({ title: "Saturn thumbnail fixture" });
  const pdfContext = pdf.beginPage(612, 792);
  pdfContext.fillStyle = "#fffdf4";
  pdfContext.fillRect(0, 0, 612, 792);
  pdfContext.fillStyle = "#11110f";
  pdfContext.font = "36px sans-serif";
  pdfContext.fillText("Saturn PDF preview", 72, 120);
  pdf.endPage();
  await fs.writeFile(pdfPath, pdf.close());

  if (ffmpegExecutable === null) throw new Error("FFmpeg fixture generator is unavailable");
  const generated = spawnSync(ffmpegExecutable, ["-y", "-hide_banner", "-loglevel", "error", "-loop", "1", "-framerate", "1", "-i", imagePath, "-t", "1", "-c:v", "mpeg4", "-pix_fmt", "yuv420p", videoPath], { windowsHide: true, timeout: 30_000 });
  if (generated.status !== 0) throw new Error(`Video fixture failed: ${generated.stderr.toString()}`);
}, 45_000);

afterAll(async () => {
  if (directory !== "") await fs.rm(directory, { recursive: true, force: true });
});

describe("thumbnail renderers", () => {
  for (const [kind, inputPathValue] of [["image", () => imagePath], ["pdf", () => pdfPath], ["video", () => videoPath]] as const) {
    it(`renders ${kind} as a bounded WebP derivative`, async () => {
      const output = await renderThumbnail(kind, inputPathValue());
      expect(output.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(output.subarray(8, 12).toString("ascii")).toBe("WEBP");
      const decoded = await loadImage(output);
      expect({ width: decoded.width, height: decoded.height }).toEqual({ width: 640, height: 360 });
      expect(output.length).toBeLessThan(2 * 1024 * 1024);
    }, 45_000);
  }

  it("rejects a compressed image whose decoded pixel count exceeds the safety limit", async () => {
    await expect(renderThumbnail("image", oversizedImagePath)).rejects.toThrow(/pixel limit/i);
  });
});
