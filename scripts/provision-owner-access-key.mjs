import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const runtime=process.env.VAULT_RUNTIME_ROOT;
const config=await import(pathToFileURL(runtime?path.join(runtime,'api/node_modules/@saturn/config/dist/index.js'):path.join(root,'packages/config/dist/index.js')));
const deployment=await import(pathToFileURL(runtime?path.join(runtime,'deployment/dist/index.js'):path.join(root,'packages/deployment/dist/index.js')));
const [sourceFile,target]=process.argv.slice(2);
if(!sourceFile||!target)throw Error('Config file and private key destination are required');
const value=deployment.parseEnvironmentFile(await fs.readFile(sourceFile,'utf8')).OWNER_ACCESS_KEY;
if(value===undefined||value.length===0||value==='replace-me-with-owner-access-key')throw Error('Owner access key is not configured');
const temporary=target+'.new-'+randomUUID();
const handle=await fs.open(temporary,'wx',0o600);
try {await handle.writeFile(config.encodeOwnerAccessKey(value),'utf8');await handle.chmod(0o600);await handle.sync();}finally{await handle.close();}
await fs.rename(temporary,target);
const directory=await fs.open(path.dirname(target),'r');try{await directory.sync();}finally{await directory.close();}
