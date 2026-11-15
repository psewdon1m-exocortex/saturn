import {expect,it,vi} from 'vitest';
import {PostgresDeviceRepository} from '@saturn/sync';
import {databaseFixture,barrier,sha,uid} from './stage3-chat-a.fixture.js';

async function fixture(name:string){
  const f=await databaseFixture(name,88),repository=new PostgresDeviceRepository(f.db),now=new Date('2026-10-18T12:00:00Z');
  const id=uid(),tokenHash=sha(id),scopeIds=['00000000-0000-7000-8000-000000000004'];
  await repository.create({id,tokenHash,name:'activity test',deviceKind:'generic',scopeIds,rights:{read:true,write:true,move:false,delete:false},createdAt:now});
  return {...f,repository,now,id,tokenHash};
}

it('recent activity authenticates concurrent requests without rewriting the device tuple and refreshes after one minute',async()=>{
  const f=await fixture('smallfile-device-activity');
  try{
    expect((await f.repository.authenticate(f.tokenHash,f.now))?.lastUsedAt).toEqual(f.now);
    const tuple=()=>f.db.withSql(sql=>sql`SELECT xmin::text AS revision,last_used_at,updated_at FROM devices WHERE id=${f.id}`);
    const before=await tuple();
    const results=await Promise.all(Array.from({length:24},()=>f.repository.authenticate(f.tokenHash,new Date(+f.now+2000))));
    expect(results.every(r=>r?.id===f.id&&r.rights.write)).toBe(true);
    expect(await tuple()).toEqual(before);
    const later=new Date(+f.now+60000);
    expect((await f.repository.authenticate(f.tokenHash,later))?.lastUsedAt).toEqual(later);
    expect((await tuple())[0]?.revision).not.toBe(before[0]?.revision);
  }finally{await f.close();}
},60000);

it('recent activity never caches permissions, token rotation, revocation or expiry',async()=>{
  const f=await fixture('smallfile-device-authority');
  try{
    await f.repository.authenticate(f.tokenHash,f.now);const next=new Date(+f.now+2000);
    await f.repository.update(f.id,{rights:{read:true,write:false,move:false,delete:false}},next);
    expect((await f.repository.authenticate(f.tokenHash,next))?.rights.write).toBe(false);
    const rotated=sha('rotated-'+f.id);await f.repository.update(f.id,{tokenHash:rotated},next);
    expect(await f.repository.authenticate(f.tokenHash,next)).toBeUndefined();
    expect((await f.repository.authenticate(rotated,next))?.id).toBe(f.id);
    await f.repository.update(f.id,{expiresAt:next},next);
    expect(await f.repository.authenticate(rotated,next)).toBeUndefined();
    expect((await f.repository.getById(f.id))?.state).toBe('expired');
    await f.db.withSql(sql=>sql`UPDATE devices SET state='active',expires_at=NULL WHERE id=${f.id}`);
    await f.repository.revoke(f.id,next);
    expect(await f.repository.authenticate(rotated,next)).toBeUndefined();
    expect(await f.repository.authenticate(sha('unknown'),next)).toBeUndefined();
  }finally{await f.close();}
},60000);

it('a due activity write racing committed revocation cannot authenticate the old row',async()=>{
  const f=await fixture('smallfile-device-revoke-race'),locked=barrier(),release=barrier();let owner:Promise<void>|undefined;
  try{
    owner=f.db.transaction(async sql=>{
      await sql`SELECT id FROM devices WHERE id=${f.id} FOR UPDATE`;locked.release();await release.entered;
      await sql`UPDATE devices SET state='revoked',revoked_at=${f.now} WHERE id=${f.id}`;
    });
    await locked.entered;const authentication=f.repository.authenticate(f.tokenHash,f.now);
    await vi.waitFor(async()=>expect((await f.db.withSql(sql=>sql`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%UPDATE devices SET last_used_at%'`)).length).toBeGreaterThan(0),{timeout:10000});
    release.release();await owner;expect(await authentication).toBeUndefined();
  }finally{release.release();await owner;await f.close();}
},60000);
