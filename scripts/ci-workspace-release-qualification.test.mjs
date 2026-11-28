import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {requireReleaseQualification} from './ci-workspace-release-qualification.mjs';

// These are unit fixtures for the qualification verifier, never product,
// historical-reader, native or release-acceptance evidence.
const hash=b=>createHash('sha256').update(b).digest('hex');
const json=v=>Buffer.from(JSON.stringify(v));
const baseline='f17f7ef31e9a8a4aa4402b76fbc2c16764aa5340';
const qa='.release/qualification/package8.json',qe='.release/qualification/package8-evidence.json';
function fixture(file='apps/api/src/unit-fixture.test.ts',name='unit verifier assertion'){
  const runtime='packages/example/src/index.ts';
  const data=new Map([[runtime,Buffer.from('export const answer=42;\n')],[file,Buffer.from('// unit fixture\n')],['package.json',json({version:'0.2.17'})]]);
  const historical=new Map([[runtime,Buffer.from('export const answer=42;\n\n')]]);
  const c={file,name,occurrence:0,status:'pending',execution:'NOT_RUN',pass:false,sourceSha256:hash(data.get(file))};c.id=hash(c.file+'\n'+c.name+'\n0');
  const report={schema:'vault.stage-verification.v1',stage:13,executionScope:'FULL',candidateRevision:'a'.repeat(40),version:'0.2.17',
    success:true,checksComplete:true,qualityAccepted:true,ordinaryCiAccepted:true,runtimeChecksPassed:true,exitCode:0,closure:{status:'CLOSED'},fullCiAccepted:false,
    quality:{accepted:true,accounting:{ordinaryAccepted:true,fullQualificationAccepted:false,collectionErrors:[],counts:{passed:0,failed:0,pending:1,total:1},cases:[c]}}};
  const proof={caseId:c.id,currentTestSha256:c.sourceSha256,kind:'RETAINED_ASSERTION_ATTESTATION',originalAssertionStatus:'passed',originalAssertionName:name,originalReportSha256:'b'.repeat(64),currentInvocationPass:false,sourceImpactReviewed:true};
  const evidence={schema:'saturn.reviewed-qualification-evidence.v1',cases:{[c.id]:proof},impactFamilies:[{id:'review',review:'This unit runtime is unchanged.',sourceFiles:[{path:runtime,sha256:hash(data.get(runtime))}]}]};
  const manifest={schema:'saturn.release-qualification.v1',version:'0.2.17',runtimeBaseline:baseline,ordinaryCasesAtReview:1,pendingAtReview:1,
    cases:[{id:c.id,file,name,occurrence:0,sourceSha256:c.sourceSha256,disposition:'RETAINED_ASSERTION',impactReview:{status:'REVIEWED',families:['review']}}]};
  function refresh(){
    manifest.sourceFiles=[...data].filter(([n])=>n!==qa&&n!==qe).map(([path,b])=>({path,bytes:b.length,sha256:hash(b)})).sort((a,b)=>a.path.localeCompare(b.path));
    manifest.runtimeInputs=[{path:runtime,baselineSha256:hash(historical.get(runtime)),currentSha256:hash(data.get(runtime))}];
    data.set(qe,json(evidence));manifest.evidence={path:qe,bytes:data.get(qe).length,sha256:hash(data.get(qe))};data.set(qa,json(manifest));
  }
  const inputs={revision:'a'.repeat(40),version:'0.2.17',get files(){return [...data.keys()];},bytes:n=>{assert(data.has(n));return data.get(n);},baselineBytes:n=>historical.get(n)};
  const run=()=>requireReleaseQualification(report,manifest,evidence,inputs);refresh();
  return {file,c,report,manifest,evidence,proof,inputs,data,historical,runtime,refresh,run};
}
test('reviewed retained credit leaves raw pending statuses and full CI flags unchanged',()=>{
  const f=fixture(),before=JSON.stringify(f.report),result=f.run();
  assert(result.releaseQualified);assert.equal(result.ordinaryNOTRUNPromotedToPASS,0);assert.equal(result.ordinaryFullCiAccepted,false);
  assert.deepEqual(result.dispositionCounts,{RETAINED_ASSERTION:1});assert.equal(JSON.stringify(f.report),before);assert.equal(result.readyToDeploy,false);
});
test('current scoped credit requires actual successful joined execution and exact executed inputs',()=>{
  const f=fixture();f.manifest.cases[0].disposition='CURRENT_SCOPED_ASSERTION';Object.assign(f.proof,{kind:'CURRENT_SCOPED_ASSERTION',actualExit:0,caseStatus:'passed',joined:true,executedSourceInputs:[{path:f.file,sha256:f.c.sourceSha256}]});f.refresh();assert(f.run().releaseQualified);
  for(const change of [{actualExit:1},{caseStatus:'failed'},{joined:false},{executedSourceInputs:[]}]){
    const before=structuredClone(f.proof);Object.assign(f.proof,change);f.refresh();assert.throws(f.run);Object.assign(f.proof,before);
  }
});
test('failed ordinary assertions, pending closure and diagnostic execution fail closed',()=>{
  for(const mutate of [f=>{f.c.status='failed';},f=>{f.report.closure.status='PENDING';},f=>{f.report.executionScope='RUNTIME_DIAGNOSTIC';},f=>{f.report.runtimeChecksPassed=false;},f=>{f.report.quality.accounting.collectionErrors=['broken.ts'];}]){const f=fixture();mutate(f);assert.throws(f.run);}
});
test('the current source revision, version and every tracked input must match',()=>{
  for(const mutate of [f=>{f.inputs.revision='c'.repeat(40);},f=>{f.report.version='0.2.16';},f=>{f.data.set(f.runtime,Buffer.from('changed'));},f=>{f.data.set('new-runtime.ts',Buffer.from('new'));},f=>{f.data.delete(qe);}]){const f=fixture();mutate(f);assert.throws(f.run);}
});
test('missing or duplicate decisions and a changed ordinary case identity are rejected',()=>{
  for(const mutate of [f=>{f.manifest.cases=[];},f=>{f.manifest.cases.push(f.manifest.cases[0]);},f=>{f.c.id='d'.repeat(64);},f=>{f.c.sourceSha256='d'.repeat(64);},f=>{f.manifest.cases[0].name='other';}]){const f=fixture();mutate(f);f.refresh();assert.throws(f.run);}
});
test('a NOT_RUN case cannot be relabeled PASS through accounting flags',()=>{
  for(const mutate of [f=>{f.c.pass=true;},f=>{f.c.execution='PASS';},f=>{f.report.fullCiAccepted=true;},f=>{f.report.quality.accounting.fullQualificationAccepted=true;},f=>{f.report.quality.accounting.counts.pending=0;}]){const f=fixture();mutate(f);assert.throws(f.run);}
});
test('the reviewed evidence bytes and manifest object cannot be substituted',()=>{
  const f=fixture();f.evidence.cases[f.c.id].originalAssertionStatus='failed';assert.throws(f.run);f.refresh();assert.throws(f.run);
  const g=fixture();g.data.set(qe,json({schema:'other'}));assert.throws(g.run);
  const h=fixture();h.manifest.version='0.2.18';assert.throws(h.run);
});
test('unrecognized proof classes and missing dependency reviews are rejected',()=>{
  for(const mutate of [f=>{f.manifest.cases[0].disposition='JUST_SKIP';},f=>{f.manifest.cases[0].impactReview.families=[];},f=>{f.manifest.cases[0].impactReview.families=['missing'];},f=>{f.evidence.impactFamilies[0].sourceFiles[0].sha256='d'.repeat(64);}]){const f=fixture();mutate(f);f.refresh();assert.throws(f.run);}
});
test('runtime comparison preserves binary bytes and rejects functional changes',()=>{
  const f=fixture();f.data.set(f.runtime,Buffer.from('export const answer=43;\n'));f.refresh();assert.throws(f.run);
  const g=fixture();g.data.set(g.runtime,Buffer.from([0xfe,10]));g.historical.set(g.runtime,Buffer.from([0xff,10]));g.evidence.impactFamilies[0].sourceFiles[0].sha256=hash(g.data.get(g.runtime));g.refresh();assert.throws(g.run);
  const h=fixture();h.manifest.runtimeInputs=[];h.data.set(qa,json(h.manifest));assert.throws(h.run);
});
test('owner waiver is limited to the exact50files/s case and never grants performance PASS',()=>{
  const file='apps/api/src/small-file-throughput.benchmark.test.ts',name='small-file HTTP publication throughput with independent content and replay verification',f=fixture(file,name);
  f.manifest.cases[0].disposition='WAIVED_BY_OWNER';Object.assign(f.proof,{kind:'WAIVED_BY_OWNER',reason:'PERFORMANCE_TARGET_DEFERRED',onlySustained50FilesPerSecond:true,performancePass:false,dataIntegrityWaived:false});f.refresh();assert.deepEqual(f.run().dispositionCounts,{WAIVED_BY_OWNER:1});
  f.proof.performancePass=true;f.refresh();assert.throws(f.run);
  const other=fixture();other.manifest.cases[0].disposition='WAIVED_BY_OWNER';Object.assign(other.proof,f.proof,{performancePass:false});other.refresh();assert.throws(other.run);
});
test('the external receiver remains a non-PASS provider with retained actual native composition',()=>{
  const f=fixture('apps/api/src/completion-clients.integration.test.ts','manual completion receiver fixture through two hops');f.manifest.cases[0].disposition='EXTERNAL_CONTROL_PROVIDER';
  Object.assign(f.proof,{kind:'EXTERNAL_CONTROL_PROVIDER',standaloneProductAssertion:false,currentInvocationPass:false,nativeCompositionAccepted:true,package8CurrentArtifactJourneyStillRequired:true,nativeCompositionArtifacts:[{sha256:'e'.repeat(64)}]});f.refresh();const result=f.run();assert.equal(result.dispositions[0].ordinaryPass,false);
  f.proof.nativeCompositionArtifacts=[];f.refresh();assert.throws(f.run);
  const other=fixture();other.manifest.cases[0].disposition='EXTERNAL_CONTROL_PROVIDER';Object.assign(other.proof,f.proof,{nativeCompositionArtifacts:[{sha256:'e'.repeat(64)}]});other.refresh();assert.throws(other.run);
});
test('historical scoped predicates retain limitations and cannot absorb another case',()=>{
  const f=fixture('apps/api/src/endurance-retained-retention.integration.test.ts','drains the retained cycle9 retention original without migration or identity reset');f.manifest.cases[0].disposition='RETAINED_SCOPED_PREDICATES';
  Object.assign(f.proof,{kind:'RETAINED_SCOPED_PREDICATES',predicatesVerified:true,currentInvocationPass:false,numericExitInferred:false,artifacts:[{sha256:'e'.repeat(64)}]});f.refresh();assert(f.run().releaseQualified);
  f.proof.numericExitInferred=true;f.refresh();assert.throws(f.run);
  const other=fixture('apps/api/src/small-batch-registry.integration.test.ts','a different predicate');other.manifest.cases[0].disposition='RETAINED_SCOPED_PREDICATES';Object.assign(other.proof,f.proof,{numericExitInferred:false});other.refresh();assert.throws(other.run);
});
