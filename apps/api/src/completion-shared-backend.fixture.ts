import { parseFixtureContainer } from "./docker-container.fixture.js";
import { z } from "zod";
import { requireDefined } from "../../../packages/contracts/src/require-defined.js";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { loadEnvironment } from "@saturn/config";
import { SftpStorageAdapter } from "@saturn/storage";
import { exec, type FixtureStorageFactory } from "./stage3-chat-a.fixture.js";

// Opt-in only: independently admitted clients can share the same disposable
// physical SFTP service as owner upload, Drop and sharing. Never infer custody
// from a hostname or silently switch an ordinary fixture's backend.
export async function sharedBackendFactory(): Promise<FixtureStorageFactory | undefined> {
  const manifest = process.env.COMPLETION_SHARED_BACKEND;
  if (!manifest) return;
  const m = z.object({containerId:z.string(),created:z.string(),runId:z.string(),prefix:z.string(),environmentFile:z.string()}).parse(JSON.parse((await fs.readFile(manifest, "utf8")).replace(/^\uFEFF/, "")));
  const c = parseFixtureContainer((await exec("docker", ["inspect", m.containerId], { windowsHide: true })).stdout);
  assert.equal(c.Id, m.containerId); assert.equal(c.Created, m.created);
  assert.equal(c.Config.Labels["exocortex.endurance.run"], m.runId);
  assert.equal(c.Config.Labels["com.docker.compose.service"], "sftp");
  assert(c.State.Running && !c.State.Paused);
  const environment = z.record(z.string(),z.string()).parse(JSON.parse((await fs.readFile(m.environmentFile, "utf8")).replace(/^\uFEFF/, "")));
  const config = loadEnvironment(environment, process.cwd(), false).storage;
  assert.equal(config.host, "127.0.0.1");
  assert.equal(String(config.port), requireDefined(requireDefined(c.NetworkSettings.Ports["22/tcp"])[0]).HostPort);
  assert(/^acceptance-[a-f0-9]{32}$/.test(m.prefix));
  return async (directory, suffix) => {
    const parent = new SftpStorageAdapter(config);
    try {
      if (!await parent.exists(m.prefix)) await parent.mkdir(m.prefix);
      await parent.mkdir(path.posix.join(m.prefix, suffix));
    } finally { await parent.close(); }
    const storage = new SftpStorageAdapter({ ...config, root: path.posix.join(config.root, m.prefix, suffix) });
    await fs.writeFile(path.join(directory, "shared-backend.json"), JSON.stringify({
      containerId: c.Id, created: c.Created, runId: m.runId, root: path.posix.join(config.root, m.prefix, suffix),
      kind: "physical-sftp", port: config.port,
    }, null, 2));
    return storage;
  };
}
