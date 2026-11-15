import fs from 'node:fs/promises';
const root='C:/.projects/exocortex',base=root+'/.audit/2026-10-15/endurance-6h';
const read=async file=>JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,''));
const policy=await read(base+'/policy.json'),rules=await fs.readFile(root+'/saturn/docs/implementation/ENDURANCE_6H_RUN_RULES_2026-10-15.md','utf8');
const groups=[...rules.matchAll(/^\| ((?:SYNC|DUP|SAT|SHARE|DROP|WIN|PLU|RES)-\d+) \| (.*?) \| (.*?) \|$/gm)].map(m=>({id:m[1],required:m[2],acceptance:m[3],status:'NOT_RUN',coverage:'none',observed:[],evidence:[]}));
const mapping={
 'windows-ui':['WIN-01','SYNC-10'],
 'windows-interop':['SYNC-08','SYNC-11','SYNC-12','RES-01'],
 'windows-service-recovery':['SYNC-08','RES-01','RES-02'],
 'windows-bulk':['SYNC-01','SYNC-02','SYNC-03','DUP-01','DUP-02'],
 'pluto-interop':['SYNC-08','SYNC-12','RES-01'],
 'pluto-native-adoption':['PLU-03'],
 'pluto-backup-boundaries':['PLU-02','SYNC-06'],
 'windows-conflict':['SYNC-07','DUP-01','DUP-02'],
 'concurrent-native-clients':['SYNC-09'],
 'pluto-native-bulk':['SYNC-01','SYNC-02','SYNC-03','SYNC-10','PLU-01','DUP-01','DUP-02'],
 'pluto-native-network-qualification':['RES-01','RES-02','RES-03','DUP-01','DUP-02'],
 'windows-local-save-network':['SYNC-04','DUP-01','DUP-02','WIN-02','WIN-03','RES-01','RES-02'],
 'pluto-daemon-recovery':['RES-01','RES-02','RES-03','PLU-01']
};
const attempts=[];
for(const cycle of [...policy.completed,...(policy.active?[policy.active]:[])]) for(const lane of cycle.lanes) for(let i=0;i<lane.attempts.length;i++) {
 const file=`${base}/cycles/${cycle.cycleId}/${lane.id}/attempt-${i}/result.json`;
 let r;try{r=await read(file);}catch(e){if(e.code==='ENOENT')continue;throw e;}
 attempts.push({cycle:cycle.cycleId,tier:cycle.tier,lane:lane.id,attempt:i,status:r.status,evidence:file,metrics:r.metrics});
 for(const check of r.checks??[]) {const ids=[...(check.id?[check.id]:(mapping[check.name]??[]))];
  if(check.name==='windows-bulk'&&check.status==='PASS'){const detail=await read((check.reusedFrom??file).replace(/result.json$/,'windows-bulk/result.json'));if(detail.namespaceChangesVerified)ids.push('SYNC-05','SYNC-06');}
  if(check.name==='pluto-native-bulk'&&check.status==='PASS'){const detail=await read((check.reusedFrom??file).replace(/result.json$/,'pluto-bulk.json'));if(detail.bulkLostAckCrashRecovery)ids.push('RES-01','RES-02','RES-03');}
  for(const id of ids) {
  const g=groups.find(x=>x.id===id);if(!g)throw Error('Unknown group '+id);
  if(!g.observed.some(x=>x.name===check.name&&x.status===check.status))g.observed.push({name:check.name,status:check.status});
  g.evidence.push({cycle:cycle.cycleId,attempt:i,lane:lane.id,status:check.status,file});g.status='RUNNING';g.coverage='partial';
 }}
}
// A lane PASS is not a whole matrix group PASS. Full closure needs acceptance review.
const uiDirectory=base+'/cycles/cycle-0010/RECOVERY/attempt-0';
let uiBlock,uiResult;
try{uiBlock=await read(uiDirectory+'/windows-ui/observations.json');}catch(e){if(e.code!=='ENOENT')throw e;}
try{uiResult=await read(uiDirectory+'/windows-ui-result.json');}catch(e){if(e.code!=='ENOENT')throw e;}
if(uiBlock?.status==='BLOCKED'&&uiResult?.status!=='PASS'){
 const g=groups.find(x=>x.id==='WIN-01');g.status='BLOCKED';g.coverage='none';
 g.observed.push({name:uiBlock.reason,status:'BLOCKED'});
 g.evidence.push({cycle:'cycle-0010',attempt:0,lane:'RECOVERY',status:'BLOCKED',file:uiDirectory+'/windows-ui/observations.json'});
}
const output={updatedAt:new Date().toISOString(),runId:policy.runId,startedAtMs:policy.startedAtMs,deadlineMs:policy.deadlineMs,
 disclaimer:'RUNNING with coverage=partial means completed subscenarios exist; it does not mean a job is currently executing. No group is automatically promoted to PASS.',groups,attempts};
await fs.writeFile(base+'/coverage-ledger.json',JSON.stringify(output,null,2));
await fs.writeFile(base+'/COVERAGE_REVIEW.md',`# Охват кампании\n\nОбновлено ${output.updatedAt}. Полный PASS группы требует всех критериев правил. RUNNING ниже означает частично проверенную группу; фактические PID находятся в current.json.\n\n| Группа | Статус | Подтверждённые подварианты |\n|---|---|---|\n`+groups.map(g=>`| ${g.id} | ${g.status}${g.coverage==='partial'?' (частично)':''} | ${g.observed.map(x=>`${x.status}: ${x.name}`).join('; ')||'—'} |`).join('\n')+'\n\nНеисполненные критерии каждой группы остаются в coverage-ledger.json (required/acceptance) и канонических правилах. Исторический C01 не закрывается этой таблицей.\n');
console.log(JSON.stringify({groups:groups.length,partial:groups.filter(g=>g.coverage==='partial').length,notRun:groups.filter(g=>g.status==='NOT_RUN').map(g=>g.id),attempts:attempts.length}));
