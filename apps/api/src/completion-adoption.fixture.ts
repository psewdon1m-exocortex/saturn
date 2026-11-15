import { fixtureValue } from './test-values.fixture.js';
import type { SyncRootBinding } from "../../../packages/contracts/src/sync-protocol.js";
interface AdoptionArtifact { binding: SyncRootBinding; runtimeManifestFile: string }
import fs from "node:fs/promises";
import path from "node:path";
import type { activeFixture} from "./stage3-chat-a.fixture.js";
import { sha } from "./stage3-chat-a.fixture.js";
import { CompletionCommandOwner, completionCommandPaths, validateCompletionCommandPaths } from "./completion-command.fixture.js";
import { GuardedRuntime, guardedApprovedFunctionsSha256, guardedStorageConfigSha256 } from "../../../packages/sync/src/guarded-runtime.js";
import { LocalStorageAdapter, RuntimeStorageManager, SftpStorageAdapter } from "@saturn/storage";
import { loadEnvironment } from "@saturn/config";

// Test-only operator boundary. Uses the real reviewed plan/adopt CLI and runtime;
// no client-visible artifact or catalog binding is synthesized by this fixture.
export async function completionAdopt(f: Awaited<ReturnType<typeof activeFixture>>, options:{scaleTransfer?:boolean;executionJobs?:boolean}={}) {
  const paths = completionCommandPaths();
  await validateCompletionCommandPaths(paths);
  const directory = path.join(f.directory, "operator");
  const commands = new CompletionCommandOwner(paths, directory);
  await f.executor.close();
  await fs.mkdir(directory);
  const save = async (name: string, value: unknown, raw = false) => {
    const file = path.join(directory, name); await fs.writeFile(file, raw ? String(value) : JSON.stringify(value), { mode: 0o600 }); return file;
  };
  const features = ["namespace-mutations-v1", "stream-upload-v1", "clone-content-v1", "folder-batch-v1", "changes-wait-v1", "metadata-gzip-v1", ...(options.scaleTransfer?["scale-transfer-v2"]:[]),...(options.executionJobs?['small-execution-job-v1']:[])];
  const credential = "completion-operator-canary", credentialFile = await save("credential.txt", credential, true);
  const localConfig = { host: "127.0.0.1", port: 22, username: "fixture", root: "fixture", hostFingerprint: "SHA256:" + "a".repeat(43), authMode: "password_file" as const, passwordFile: credentialFile, operationTimeoutMs: 30000, healthTimeoutMs: 2000, maxConnections: 4, requireFsync: true };
  let storageConfig: ReturnType<typeof loadEnvironment>["storage"] = localConfig;
  let physicalSftp = false;
  if (process.env.COMPLETION_SHARED_BACKEND) {
    const shared = JSON.parse(await fs.readFile(process.env.COMPLETION_SHARED_BACKEND, "utf8")) as { environmentFile:string;containerId:string;created:string;runId:string };
    const owned = JSON.parse(await fs.readFile(path.join(f.directory,"shared-backend.json"),"utf8")) as {root:string;containerId:string;created:string;runId:string;kind:string};
    if(owned.kind!=="physical-sftp"||owned.containerId!==shared.containerId||owned.created!==shared.created||owned.runId!==shared.runId)throw Error("Adoption fixture backend custody changed");
    storageConfig={...loadEnvironment(JSON.parse(await fs.readFile(shared.environmentFile,"utf8")) as Record<string,string>,process.cwd(),false).storage,root:owned.root};
    physicalSftp=true;
  }
  const qualificationFile = await save("qualification.json", { schema: "saturn.guarded-qualification.v3", coverage: "namespace-mutations-v1", approvedFunctionsSha256: guardedApprovedFunctionsSha256(f.approvedFunctions), supportedWritersVerified: true, unsupportedWritersBlockedBeforeIo: true, privateLifecycleVerified: true, singleBackendWriterVerified: true, handoffVerified: true, smallBatchTransport: "saturn.small-file-batch.v1", features });
  const actualCredential=physicalSftp?await fs.readFile(storageConfig.authMode==="password_file"?fixtureValue(storageConfig.passwordFile):fixtureValue(storageConfig.privateKeyFile)):Buffer.from(credential);
  const fenceFile = await save("fence.json", { schema: "saturn.backend-fence.v1", backendIdentity: f.backendIdentity, profileId: "bootstrap", profileRevision: 1, generation: f.generation, storageConfigSha256: guardedStorageConfigSha256({ profileId: "bootstrap", revision: 1, activatedAt: "", source: "bootstrap", config: storageConfig }), credentialSha256: sha(actualCredential), oldExecutorsDrained: true, oldCredentialsRevoked: true, protectedAncestorsVerified: true });
  const wu = new URL(f.url); wu.username = f.roles.writerLogin;
  const storageRoot = path.join(f.directory, "storage"), fenceSha = sha(await fs.readFile(fenceFile));
  let custodyFile="";
  if(!physicalSftp){const stat=await fs.lstat(storageRoot,{bigint:true});custodyFile=await save("custody.json", { schema: "saturn.local-backend-custody.v1", backendIdentity: f.backendIdentity, backendGeneration: f.generation, fenceReceiptSha256: fenceSha, root: storageRoot, device: stat.dev.toString(), inode: stat.ino.toString() });}
  const manifest = { schema: "saturn.guarded-runtime.v3", extensions: { features, verifier: null, ...(options.scaleTransfer?{payloadDirectory:path.join(directory,"payloads")}:{} ) }, serverIdentity: f.wireBinding.server_identity, policyVersion: "stage3", qualificationReceiptFile: qualificationFile, qualificationReceiptSha256: sha(await fs.readFile(qualificationFile)), writerDatabaseUrlFile: await save("writer.url", wu.toString(), true), cursorKeyFile: await save("cursor.key", "x".repeat(32), true), cursorKeyId: "fixture", maximumFileBytes: "1073741824", roles: f.roles, approvedFunctions: f.approvedFunctions, backend: { identity: f.backendIdentity, profileId: "bootstrap", profileRevision: 1, generation: f.generation, fenceReceiptFile: fenceFile, fenceReceiptSha256: fenceSha, caseSensitive: false }, roots: [] };
  const storage=physicalSftp?{kind:"sftp",configFile:await save("storage.json",storageConfig)}:{kind:"local",root:storageRoot,custodyFile};
  const config = { schema: "saturn.sync-lifecycle.v1", rootId: f.rootId, databaseUrlFile: await save("admin.url", f.url, true), manifestFile: await save("manifest.json", manifest), outputDirectory: path.join(directory, "output"), codec: f.namespace.codec, policyHash: f.namespace.policyHash, storage };
  const file = await save("config.json", config);
  const command = async <T>(action: string, artifact?: string): Promise<T> => {
    return commands.lifecycle<T>(action, file, artifact);
  };
  const plan = await command<{blockers:unknown[];file:string}>("migrate-plan");
  if (plan.blockers.length) throw Error("completion adoption plan blocked");
  const artifact = await command<AdoptionArtifact>("adopt", plan.file);
  if (artifact.binding.binding_version === f.wireBinding.binding_version) throw Error("binding did not advance");
  const replay = await command<AdoptionArtifact>("adopt", plan.file);
  if (JSON.stringify(replay.binding) !== JSON.stringify(artifact.binding)) throw Error("adoption replay changed binding");
  const manager = new RuntimeStorageManager(storageConfig, path.join(directory, "runtime-profile"), () => physicalSftp?new SftpStorageAdapter(storageConfig):new LocalStorageAdapter(storageRoot)); await manager.initialize();
  const runtime = await GuardedRuntime.create({ database: f.runtime, storage: manager, manifestFile: artifact.runtimeManifestFile, device: { pepper: "stage3-disposable-pepper-123456789012345678", options: { enabled: true, publicOrigin: "https://fixture.invalid", uploadChunkMaxBytes: 8388608, propfindMaxItems: 100, deleteMaxItems: 500, deleteWindowMs: 10000 } } });
  return { artifact, runtime };
}
