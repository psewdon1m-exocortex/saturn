import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import process from "node:process";

const target = process.env.KERNEL_TOKEN_FILE ?? "/run/secrets/kernel_service_token";
const token = process.env.KERNEL_SERVICE_TOKEN?.replace(/[\r\n]+$/, "") ?? "";

if (process.getuid?.() !== 0 || target !== "/run/secrets/kernel_service_token") {
  throw new Error("Production runtime-secret migration must run as root with the fixed Kernel token path");
}
if (token.length < 24 || token.length > 8192 || /[\r\n]/.test(token) || /change[-_ ]?me|replace|example-token/i.test(token)) {
  throw new Error("KERNEL_SERVICE_TOKEN is missing or malformed");
}

const temporary = `/run/secrets/.kernel_service_token.${randomUUID()}.new`;
const handle = await fs.open(temporary, "wx", 0o600);
try {
  await handle.writeFile(`${token}\n`, "utf8");
  await handle.sync();
} finally {
  await handle.close();
}
try {
  await fs.chmod(temporary, 0o400);
  await fs.chown(temporary, 1000, 1000);
  await fs.rename(temporary, target);
} catch (error) {
  await fs.rm(temporary, { force: true });
  throw error;
}

delete process.env.KERNEL_SERVICE_TOKEN;
process.setgroups?.([]);
process.setgid?.(1000);
process.setuid?.(1000);

await import("./migrate-runtime.mjs");
