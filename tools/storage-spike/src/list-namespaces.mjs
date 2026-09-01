import { loadConfig } from "./config.mjs";
import { callSftp, connectSftp } from "./ssh.mjs";

const config = await loadConfig({
  configPath: process.env.VAULT_STORAGE_CONFIG,
  passwordFile: process.env.VAULT_STORAGE_PASSWORD_FILE,
});
const connection = await connectSftp(config);
try {
  const entries = await callSftp(connection.sftp, "readdir", config.root);
  const names = entries
    .map((entry) => entry.filename)
    .filter((name) => /^\.vault-qualification-[0-9a-f-]{36}$/.test(name));
  process.stdout.write(`${JSON.stringify(names)}\n`);
} finally {
  await connection.close();
}
