import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");const runtimeRoot=process.env.VAULT_RUNTIME_ROOT;const environmentFile=path.resolve(process.argv[2]??path.join(root,"infra","production",".env.production"));
const deployment=await import(pathToFileURL(runtimeRoot===undefined?path.join(root,"packages","deployment","dist","index.js"):path.join(runtimeRoot,"deployment","dist","index.js")));const source=await fs.readFile(environmentFile,"utf8");const environment={...deployment.parseEnvironmentFile(source),...process.env};const result=deployment.validateProductionDeployment(environment,runtimeRoot??root);
process.stdout.write(`${JSON.stringify({state:result.state,releaseVersion:result.releaseVersion,domain:result.domain,storageEnvironment:"production",laboratoryExposure:result.laboratoryExposure,rpoSeconds:result.rpoSeconds,rtoSeconds:result.rtoSeconds,secretFiles:result.secretFiles,immutableImages:result.immutableImages,loopbackListeners:result.loopbackListeners})}\n`);
