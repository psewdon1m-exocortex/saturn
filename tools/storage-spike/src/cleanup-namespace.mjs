import { loadConfig } from "./config.mjs";
import { callSftp, connectSftp } from "./ssh.mjs";

const namespaceName = process.env.VAULT_STORAGE_NAMESPACE;
if (!/^\.vault-qualification-[0-9a-f-]{36}$/.test(namespaceName ?? "")) {
  throw new Error("VAULT_STORAGE_NAMESPACE must be one exact qualification namespace");
}

const config = await loadConfig({
  configPath: process.env.VAULT_STORAGE_CONFIG,
  passwordFile: process.env.VAULT_STORAGE_PASSWORD_FILE,
});
const root = config.root === "." ? "" : config.root.replace(/^\/+|\/+$/g, "");
const namespace = root ? `${root}/${namespaceName}` : namespaceName;
const connection = await connectSftp(config);
try {
  const entries = await callSftp(connection.sftp, "readdir", namespace);
  for (const entry of entries) {
    if (entry.filename === "." || entry.filename === "..") continue;
    const remotePath = `${namespace}/${entry.filename}`;
    if (entry.attrs.isDirectory()) {
      throw new Error(`Refusing recursive cleanup of unexpected directory: ${remotePath}`);
    }
    await callSftp(connection.sftp, "unlink", remotePath);
  }
  await callSftp(connection.sftp, "rmdir", namespace);
  process.stdout.write(`${JSON.stringify({ namespace, cleanup: "complete" })}\n`);
} finally {
  await connection.close();
}
