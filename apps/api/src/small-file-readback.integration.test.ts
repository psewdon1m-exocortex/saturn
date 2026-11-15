import { fixtureValue } from './test-values.fixture.js';
import {expect,it,vi} from 'vitest';
import {activeFixture} from './stage3-chat-a.fixture.js';
import {Readable} from 'node:stream';

it('uses one complete readback for both sealed SHA and MIME without a second prefix read',async()=>{
  const f=await activeFixture('smallfile-readback','windows',74);
  try{
    const data=Buffer.from('%PDF-1.7\n'+ 'verified content '.repeat(200));
    const read=vi.spyOn(f.raw,'openRead');
    const result=await f.upload(f.uploadInput('proof.pdf',data),data);
    expect(result.status.result?.status).toBe('PUBLISHED');
    expect(read).toHaveBeenCalledTimes(1);
    const rows=await f.admin.withSql(sql=>sql`SELECT mime_type FROM resources WHERE parent_id=${f.rootId} AND name='proof.pdf'`);
    expect(rows[0]?.mime_type).toBe('application/pdf');
  }finally{await f.close();}
},60000);

it('refuses corrupted durable bytes before publication even when the MIME prefix is valid',async()=>{
  const f=await activeFixture('smallfile-readback-corrupt','windows',74);
  try{
    const data=Buffer.from('%PDF-1.7\n'+ 'verified content '.repeat(200));
    let upload=await f.files.prepareCatalogUpload(f.uploadInput('corrupt.pdf',data),f.proof);
    upload=await f.files.appendCatalogUpload(upload,f.proof,'0',data);
    const changed=Buffer.from(data);changed[changed.length-1]=fixtureValue(changed[changed.length-1])^1;
    await f.raw.write(upload.execution.tempPath,Readable.from(changed),{offset:0,create:false,truncate:true});
    await expect(f.files.completeCatalogUpload(upload,f.proof)).rejects.toMatchObject({code:'verification_failed'});
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM resources WHERE parent_id=${f.rootId} AND name='corrupt.pdf'`)).toHaveLength(0);
    expect((await f.files.inspectCatalogUpload(upload,f.proof)).status.session.phase).toBe('transport');
  }finally{await f.close();}
},60000);
