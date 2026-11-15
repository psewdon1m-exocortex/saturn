import { requiredValue } from "./required-value.js";
import type {Database} from '@saturn/database';

interface Request {command:string;input:unknown;credential:unknown;payload:unknown;resolve:(v:unknown)=>void;reject:(e:unknown)=>void}
/** Coalesces already concurrent originals for one SQL round trip. No timer,
 * shared retry deadline or aggregate publication receipt is introduced. */
export class CatalogCommandBatcher {
  #pending=new Map<string,Request[]>();
  constructor(private readonly writer:Database){}
  run(command:string,input:unknown,credential:unknown,payload:unknown):Promise<unknown>{
    const key=JSON.stringify(credential);
    return new Promise((resolve,reject)=>{
      let batch=this.#pending.get(key);
      if(!batch){batch=[];this.#pending.set(key,batch);const original=batch;queueMicrotask(()=>{if(this.#pending.get(key)===original)this.#pending.delete(key);void this.#flush(original);});}
      batch.push({command,input,credential,payload,resolve,reject});
      if(batch.length===16)this.#pending.delete(key);
    });
  }
  async #flush(batch:Request[]):Promise<void>{
    if(!batch.length)return;
    try{
      const values=await this.writer.catalogUploadBatch('batch',requiredValue(batch[0]).credential,
        batch.map(r=>({command:r.command,input:r.input,payload:r.payload})));
      if(!Array.isArray(values)||values.length!==batch.length)throw Error('projection_mismatch');
      for(const [i,r] of batch.entries()){
        const v:unknown=values[i];
        if(v===null||typeof v!=='object'||Object.keys(v).length!==1||(!Object.hasOwn(v,'value')&&(!('error'in v)||typeof v.error!=='string')))r.reject(Error('projection_mismatch'));
        else if('error'in v&&typeof v.error==='string')r.reject(Error(v.error));else r.resolve('value'in v?v.value:undefined);
      }
    }catch(error){for(const r of batch)r.reject(error);}
  }
}
