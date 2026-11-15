// Observe already-started final readbacks; never launch or repair a test.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const root='C:/.projects/exocortex',base=root+'/.audit/2026-10-15/endurance-6h';
const read=async p=>JSON.parse((await fs.readFile(p,'utf8')).replace(/^\uFEFF/,''));
const state=await read(base+'/current.json');
assert.equal(state.status,'FINISHED');assert.equal(state.active,null);
assert.equal(state.runId,'f3f55c75-dcd4-4354-adae-7e781f98cf54');
let previous=0;
for(;;){
  const results=await Promise.all(['product','client'].map(async kind=>{
    const file=base+'/final-'+kind+'-readback.json',r=await read(file),s=await fs.stat(file);
    assert.equal(r.runId,state.runId);
    return {kind,status:r.status,verified:r.verified??r.verifiedReferences,expected:r.expected??r.expectedDatabases,failures:r.failures.length,updatedAt:s.mtime.toISOString()};
  }));
  const ended=results.every(r=>r.status!=='RUNNING');
  if(Date.now()-previous>=300000||ended){
    previous=Date.now();const at=new Date().toISOString();
    const summary=results.map(r=>`${r.kind}: ${r.status}, verified=${r.verified}, failures=${r.failures}, evidence updated=${r.updatedAt}`).join('; ');
    await fs.appendFile(root+'/.history/2026-10-15-six-hour-run.md',`\n## ${at} — Контроль итогового readback\n\n- Причина: контроль уже начатого финального чтения, не новый цикл.\n- До / входной гейт: campaign FINISHED, active=null; исходная шестичасовая граница сохранена.\n- Что и как сделано: прочитаны результаты и время обновления двух readback; никакие тесты/ремонты не запускаются.\n- Выходной гейт / тесты: ${summary}. Полная приёмка и unresolved оцениваются отдельно в итоговом отчёте.\n`);
    await fs.writeFile(base+'/final-readback-monitor.json',JSON.stringify({at,pid:process.pid,status:ended?'FINISHED':'RUNNING',results},null,2));
  }
  if(ended)break;
  await delay(30000);
}
