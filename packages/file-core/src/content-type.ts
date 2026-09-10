import { fileTypeFromBuffer } from "file-type";

const textMimeByExtension = new Map([
  ["md", "text/markdown"],
  ["markdown", "text/markdown"],
  ["txt", "text/plain"],
  ["log", "text/plain"],
  ["csv", "text/csv"],
  ["json", "application/json"],
  ["yaml", "application/yaml"],
  ["yml", "application/yaml"],
]);

function looksLikeText(buffer: Buffer): boolean {
  if (buffer.includes(0)) return false;
  let controls = 0;
  for (const byte of buffer) if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) controls += 1;
  return buffer.length === 0 || controls / buffer.length < 0.01;
}

function looksLikeSvg(buffer: Buffer): boolean {
  if (!looksLikeText(buffer)) return false;
  const start = buffer.toString("utf8", 0, Math.min(buffer.length, 4_096)).replace(/^\uFEFF/, "").trimStart();
  return /^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(start);
}

export async function detectContentType(filename: string, probe: Buffer): Promise<string> {
  const detected = await fileTypeFromBuffer(probe);
  if (detected !== undefined) return detected.mime;
  const extension = filename.split(".").pop()?.toLocaleLowerCase() ?? "";
  if (extension === "svg" && looksLikeSvg(probe)) return "image/svg+xml";
  const textMime = textMimeByExtension.get(extension);
  return textMime !== undefined && looksLikeText(probe) ? textMime : "application/octet-stream";
}
