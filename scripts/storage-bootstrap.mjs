import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");const runtimeRoot=process.env.VAULT_RUNTIME_ROOT;const configModule=await import(pathToFileURL(runtimeRoot===undefined?path.join(root,"packages","config","dist","index.js"):path.join(runtimeRoot,"api","node_modules","@saturn","config","dist","index.js")));const storageModule=await import(pathToFileURL(runtimeRoot===undefined?path.join(root,"packages","storage","dist","index.js"):path.join(runtimeRoot,"api","node_modules","@saturn","storage","dist","index.js")));const config=configModule.loadEnvironment(process.env,runtimeRoot??root);
if(config.environment!=="production"&&process.env.VAULT_VALIDATION_PROFILE!=="verification")throw new Error("Storage bootstrap requires production configuration");if(process.env.VAULT_STORAGE_ENVIRONMENT!=="production")throw new Error("Storage bootstrap refuses a non-production storage identity");
const storage=new storageModule.SftpStorageAdapter(config.storage);try{const layout=await storageModule.migrateStorageLayout(storage,"up");process.stdout.write(`${JSON.stringify({state:"ready",layout})}\n`);}finally{await storage.close().catch(()=>undefined);}
