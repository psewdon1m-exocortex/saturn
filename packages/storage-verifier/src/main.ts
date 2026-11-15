import { requireDefined } from "../../contracts/src/require-defined.js";
import { parseHostConfig } from "./authority.js";
import { readProtected } from "./secure-files.js";
import { createVerifierServer } from "./server.js";

async function main(): Promise<void> {
  if (process.argv.length !== 3 || process.platform !== "linux") throw new Error("usage: storage-verifier /absolute/protected/config.json (Linux only)");
  const config = parseHostConfig(JSON.parse((await readProtected(requireDefined(process.argv[2]), 262144)).bytes.toString("utf8")));
  const host = await createVerifierServer(config);
  await new Promise<void>((resolve, reject) => { host.server.once("error", reject); host.server.listen(config.port, config.listenHost, resolve); });
  let stopping = false;
  const stop = (): void => { if (stopping) return; stopping = true; void host.shutdown().catch(() => { process.exitCode = 1; }); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
}
void main().catch(() => { process.stderr.write("storage-verifier startup failed; inspect protected host configuration\n"); process.exitCode = 1; });
