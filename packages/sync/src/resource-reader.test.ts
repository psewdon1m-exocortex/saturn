import {ROOT_RESOURCE_ID,type FileService,type Resource} from "@saturn/file-core";
import {describe,expect,it,vi} from "vitest";
import {DeviceService,resourceEtag} from "./device.service.js";
import {logicalResourcePath,readerRange} from "./resource-reader.js";
import {MASTERMIND_RESOURCE_ID,type DeviceRecord,type DeviceRepository} from "./types.js";

const now=new Date("2026-09-15T00:00:00Z");
const root:Resource={id:ROOT_RESOURCE_ID,name:"root",type:"folder",storagePath:"",sizeBytes:0,status:"active",createdAt:now,updatedAt:now};
const file:Resource={...root,id:"file",name:"video.mp4",type:"file",storagePath:"video.mp4",sizeBytes:100,sha256:"a".repeat(64)};
const readOnly={read:true,write:false,move:false,delete:false};

function fixture(){
  const records:DeviceRecord[]=[];
  const repository={
    create:async(input:Omit<DeviceRecord,"state"|"updatedAt">)=>{const value={...input,state:"active" as const,updatedAt:now};records.push(value);return value;},
    getById:async(id:string)=>records.find(value=>value.id===id),
    authenticate:async(hash:string)=>records.find(value=>value.tokenHash===hash&&value.state==="active"),
  } as unknown as DeviceRepository;
  const listChildren=vi.fn(async(_id:string,offset:number,limit:number)=>Array.from({length:250},(_,index)=>({...file,id:String(index),name:"File "+String(index)})).slice(offset,offset+limit));
  const files={getResource:async()=>root,resolveResourcePath:async()=>root,listChildren} as unknown as FileService;
  const service=new DeviceService({repository,files,pepper:"test-only-device-pepper-at-least-32-bytes",options:{enabled:true,publicOrigin:"https://saturn.test",uploadChunkMaxBytes:1024,propfindMaxItems:100,deleteMaxItems:5,deleteWindowMs:1000}});
  return {service,listChildren,records};
}

describe("scoped resource reader",()=>{
  it.each(["root/../private","root/%2e%2e/private","root/%252e%252e/private","/root/file","root\\file","root//file","root/file\0"])("rejects noncanonical path %s",path=>{
    expect(()=>logicalResourcePath(path)).toThrow();
  });
  it("keeps exact Unicode and ordinary spaces",()=>expect(logicalResourcePath("root/Folder with spaces/Заметка.md")).toEqual(["root","Folder with spaces","Заметка.md"]));
  it("does not grant root mutation rights",async()=>{
    const {service}=fixture();
    await expect(service.createDevice({name:"Wrong root",scopeIds:[ROOT_RESOURCE_ID],rights:{...readOnly,write:true}})).rejects.toThrow("read-only");
    const created=await service.createDevice({name:"Reader",scopeIds:[ROOT_RESOURCE_ID],rights:readOnly});
    await expect(service.updateDevice(created.device.id,{rights:{...readOnly,delete:true}})).rejects.toThrow("read-only");
    const context=await service.authenticate("Bearer "+created.token);
    await expect(service.createCollection(context,"root/new")).rejects.toMatchObject({code:"forbidden"});
  });
  it("fetches one page and binds the next cursor to device and directory",async()=>{
    const {service,listChildren}=fixture();
    const first=await service.createDevice({name:"First",scopeIds:[ROOT_RESOURCE_ID],rights:readOnly});
    const second=await service.createDevice({name:"Second",scopeIds:[ROOT_RESOURCE_ID],rights:readOnly});
    const context=await service.authenticate("Bearer "+first.token),other=await service.authenticate("Bearer "+second.token);
    const page=await service.readerPage(context,"root",undefined,100);
    expect(page.entries).toHaveLength(100);expect(listChildren).toHaveBeenCalledTimes(1);expect(listChildren).toHaveBeenCalledWith(ROOT_RESOURCE_ID,0,101);
    if(page.next_cursor===null)throw new Error("Expected another page");
    const next=await service.readerPage(context,"root",page.next_cursor,100);
    expect(next.entries[0]?.path).toBe("root/File 100");
    await expect(service.readerPage(other,"root",page.next_cursor,100)).rejects.toThrow();
    await expect(service.readerPage(context,"root/other",page.next_cursor,100)).rejects.toThrow();
    await expect(service.readerPage(context,"root",page.next_cursor+"x",100)).rejects.toThrow();
    await expect(service.readerPage(context,"root",undefined,101)).rejects.toThrow();
  });
  it("does not reuse a writer capability for owner resource reads",async()=>{
    const {service}=fixture();
    const created=await service.createDevice({name:"Mirror",scopeIds:[MASTERMIND_RESOURCE_ID],rights:{...readOnly,write:true}});
    await expect(service.readerResolve(await service.authenticate("Bearer "+created.token),"root/mastermind")).rejects.toMatchObject({code:"forbidden"});
  });
});

describe("reader single-range semantics",()=>{
  it("uses the opened revision for suffix, open-ended, clipped and conditional ranges",()=>{
    expect(readerRange(file,"bytes=-10")).toEqual({offset:90,length:10});
    expect(readerRange(file,"bytes=80-")).toEqual({offset:80,length:20});
    expect(readerRange(file,"bytes=90-999")).toEqual({offset:90,length:10});
    expect(readerRange(file,"bytes=0-9",resourceEtag(file))).toEqual({offset:0,length:10});
    expect(readerRange(file,"bytes=0-9",'"older-revision"')).toBeUndefined();
    expect(readerRange(file,"bytes=0-9",now.toUTCString())).toEqual({offset:0,length:10});
  });
  it.each(["bytes=0-1,2-3","bytes=100-","bytes=-0","bytes=10-1","bytes=-","bytes=0-9\n"])("rejects %s",range=>expect(()=>readerRange(file,range)).toThrow());
});
