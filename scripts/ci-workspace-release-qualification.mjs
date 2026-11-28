import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';

const manifestPath='.release/qualification/package8.json';
const evidencePath='.release/qualification/package8-evidence.json';
const excluded=new Set([manifestPath,evidencePath]);
const baseline='f17f7ef31e9a8a4aa4402b76fbc2c16764aa5340';
const provider='309e4fcef44a912fda720840d750b3e50c745a41c195d3f3edfbe82616534446';
const waived='30356fbb9dde97e09c43c3a789bf16fbbdb7e23ad2a5d42164c921035f694884';
const retainedPredicates=new Set(['6826d6d46a7553c606b4ed2d8ef39de5258d9f053430884e188a0f83d0d6c6dd','3f2f5de9ecb1f5e8990ab74befaa96e27c162ca3c8eef753801bbe1306df9fe5','862659a21bcf492d9e7df3c1bc5185c27d3864fb4db5ba3ed3484221a7795812']);
const digest=b=>createHash('sha256').update(b).digest('hex');
const same=(a,b)=>assert.deepEqual(a,b);
const safe=n=>typeof n==='string'&&n.length>0&&!n.includes(':')&&!n.includes('\\')&&!n.includes('\0')&&!path.posix.isAbsolute(n)&&!n.split('/').some(p=>p===''||p==='.'||p==='..');
const canonical=b=>{let end=b.length;while(end>0&&(b[end-1]===10||b[end-1]===13))end--;return b.subarray(0,end);};
const caseID=c=>digest(c.file+'\n'+c.name+'\n'+c.occurrence);
export function runtimeInput(n){
  if(/^(apps|packages)\//.test(n)&&n.includes('/src/'))return !['.test.','.spec.','.benchmark.','.fixture.','integration-helper','test-values'].some(x=>n.includes(x));
  return n.startsWith('packages/database/migrations/')||n.startsWith('infra/production/')||['scripts/registered-worker-parent.mjs','scripts/supervise-docker-cohort.mjs'].includes(n);
}

/** A reviewed retained qualification is separate from execution accounting.
 * This never changes ordinary NOT_RUN, fullCiAccepted or readyToDeploy.
 * All pending identities must have explicit source-bound evidence/disposition;
 * there is no general skip list, unknown waiver, or ordinary-success fallback. */
export function requireReleaseQualification(report,manifest,evidence,inputs){
  same(report.schema,'vault.stage-verification.v1');same(report.stage,13);same(report.executionScope,'FULL');
  for(const key of ['success','checksComplete','qualityAccepted','ordinaryCiAccepted','runtimeChecksPassed'])same(report[key],true);
  same(report.exitCode,0);same(report.closure?.status,'CLOSED');same(report.candidateRevision,inputs.revision);same(report.version,inputs.version);
  assert(/^[a-f0-9]{40}$/.test(inputs.revision),'Missing current source revision');
  const accounting=report.quality?.accounting;
  same(report.quality?.accepted,true);same(accounting?.ordinaryAccepted,true);same(accounting.collectionErrors,[]);
  same(manifest.schema,'saturn.release-qualification.v1');same(manifest.runtimeBaseline,baseline);
  same(manifest.version,inputs.version);same(manifest.ordinaryCasesAtReview,accounting.counts.total);
  assert(inputs.files.includes(manifestPath)&&inputs.files.includes(evidencePath),'Reviewed qualification must be tracked');
  same(manifest,JSON.parse(inputs.bytes(manifestPath)));
  const tracked=inputs.files.filter(n=>!excluded.has(n)).sort();assert(new Set(tracked).size===tracked.length);
  assert(manifest.sourceFiles.every(r=>safe(r.path)),'Unsafe source binding');
  same(manifest.sourceFiles.map(r=>r.path).sort(),tracked);
  const bound=new Map();
  for(const row of manifest.sourceFiles){
    assert(!bound.has(row.path),'Duplicate source binding');const bytes=inputs.bytes(row.path);
    same(bytes.length,row.bytes);same(digest(bytes),row.sha256);bound.set(row.path,row);
  }
  same(manifest.evidence.path,evidencePath);const publicBytes=inputs.bytes(evidencePath);
  same(publicBytes.length,manifest.evidence.bytes);same(digest(publicBytes),manifest.evidence.sha256);
  same(evidence,JSON.parse(publicBytes));
  same(evidence.schema,'saturn.reviewed-qualification-evidence.v1');
  const families=new Map();
  for(const family of evidence.impactFamilies){
    assert(typeof family.id==='string'&&!families.has(family.id)&&typeof family.review==='string'&&family.review.length>0,'Invalid impact review');
    assert(family.sourceFiles.length>0,'Impact review must bind current inputs');
    for(const input of family.sourceFiles)same(bound.get(input.path)?.sha256,input.sha256);
    families.set(family.id,family);
  }
  const product=tracked.filter(runtimeInput);assert(product.length>0);
  same(manifest.runtimeInputs.map(r=>r.path).sort(),product);
  for(const row of manifest.runtimeInputs){
    const actual=inputs.bytes(row.path),old=inputs.baselineBytes(row.path);
    same(digest(old),row.baselineSha256);same(digest(actual),row.currentSha256);
    same(canonical(actual),canonical(old));
  }
  const unique=new Set(),pending=[];let passed=0;
  for(const row of accounting.cases){
    assert(safe(row.file)&&Number.isSafeInteger(row.occurrence)&&row.occurrence>=0);
    same(caseID(row),row.id);assert(!unique.has(row.id),'Duplicate ordinary assertion');unique.add(row.id);
    same(bound.get(row.file)?.sha256,row.sourceSha256);
    assert(['passed','pending'].includes(row.status),'Failed or unknown ordinary assertion');
    if(row.status==='passed')passed++;else{same(row.execution,'NOT_RUN');same(row.pass,false);pending.push(row);}
  }
  same(accounting.counts,{passed,failed:0,pending:pending.length,total:unique.size});
  same(accounting.fullQualificationAccepted,pending.length===0);same(report.fullCiAccepted,pending.length===0);
  same(manifest.pendingAtReview,pending.length);same(manifest.cases.length,pending.length);
  const decisions=new Map();for(const row of manifest.cases){assert(!decisions.has(row.id),'Duplicate qualification decision');decisions.set(row.id,row);}
  const counts={};const dispositions=[];
  for(const current of pending){
    const row=decisions.get(current.id);assert(row,'Unqualified conditional assertion '+current.id);
    for(const key of ['file','name','occurrence','sourceSha256'])same(row[key],current[key]);
    assert(row.impactReview?.status==='REVIEWED'&&row.impactReview.families.length>0,'Missing current dependency impact review');
    assert(row.impactReview.families.every(id=>families.has(id)),'Unknown dependency impact review');
    const proof=evidence.cases[current.id];assert(proof,'Missing reviewed proof');
    same(proof.caseId,current.id);same(proof.currentTestSha256,current.sourceSha256);
    if(row.disposition==='CURRENT_SCOPED_ASSERTION'){
      same(proof.kind,'CURRENT_SCOPED_ASSERTION');same(proof.actualExit,0);same(proof.caseStatus,'passed');same(proof.joined,true);
      assert(/^[a-f0-9]{64}$/.test(proof.originalReportSha256));
      assert(Array.isArray(proof.executedSourceInputs)&&proof.executedSourceInputs.length>0);
      assert(proof.executedSourceInputs.some(input=>input.path===current.file),'Missing exact executed test source');
      for(const input of proof.executedSourceInputs)same(bound.get(input.path)?.sha256,input.sha256);
    }else if(row.disposition==='RETAINED_ASSERTION'){
      same(proof.kind,'RETAINED_ASSERTION_ATTESTATION');same(proof.originalAssertionStatus,'passed');
      same(proof.originalAssertionName.replaceAll(' > ',' ').trim().replace(/\s+/g,' '),current.name.trim().replace(/\s+/g,' '));
      assert(/^[a-f0-9]{64}$/.test(proof.originalReportSha256));
      same(proof.currentInvocationPass,false);same(proof.sourceImpactReviewed,true);
    }else if(row.disposition==='RETAINED_SCOPED_PREDICATES'){
      assert(retainedPredicates.has(current.id),'Unreviewed historical predicate');
      same(proof.kind,'RETAINED_SCOPED_PREDICATES');same(proof.predicatesVerified,true);same(proof.currentInvocationPass,false);
      assert(['apps/api/src/endurance-retained-retention.integration.test.ts','apps/api/src/small-batch-registry.integration.test.ts'].includes(current.file));
      assert(proof.artifacts.length>0&&proof.artifacts.every(p=>/^[a-f0-9]{64}$/.test(p.sha256)));
      same(proof.numericExitInferred,false);
    }else if(row.disposition==='EXTERNAL_CONTROL_PROVIDER'){
      same(current.id,provider);same(current.file,'apps/api/src/completion-clients.integration.test.ts');
      same(proof.kind,'EXTERNAL_CONTROL_PROVIDER');same(proof.standaloneProductAssertion,false);same(proof.currentInvocationPass,false);
      same(proof.nativeCompositionAccepted,true);same(proof.package8CurrentArtifactJourneyStillRequired,true);
      assert(proof.nativeCompositionArtifacts.length>0&&proof.nativeCompositionArtifacts.every(p=>/^[a-f0-9]{64}$/.test(p.sha256)));
    }else if(row.disposition==='WAIVED_BY_OWNER'){
      same(current.id,waived);same(current.file,'apps/api/src/small-file-throughput.benchmark.test.ts');
      same(proof.kind,'WAIVED_BY_OWNER');same(proof.reason,'PERFORMANCE_TARGET_DEFERRED');
      same(proof.onlySustained50FilesPerSecond,true);same(proof.performancePass,false);same(proof.dataIntegrityWaived,false);
    }else assert.fail('Unsupported release disposition');
    counts[row.disposition]=(counts[row.disposition]??0)+1;
    dispositions.push({id:current.id,file:current.file,name:current.name,ordinaryExecution:'NOT_RUN',ordinaryPass:false,releaseDisposition:row.disposition});
  }
  same(decisions.size,pending.length);
  return {schema:'saturn.release-qualification-result.v1',sourceRevision:inputs.revision,version:inputs.version,
    status:'QUALIFIED_WITH_EXPLICIT_RETAINED_CREDIT_AND_OWNER_DISPOSITIONS',releaseQualified:true,
    ordinaryCounts:accounting.counts,ordinaryFullCiAccepted:report.fullCiAccepted,ordinaryFullQualificationAccepted:accounting.fullQualificationAccepted,
    ordinaryNOTRUNPromotedToPASS:0,dispositionCounts:counts,dispositions,readyToDeploy:false,
    scope:'Source-bound release eligibility. Raw execution accounting is unchanged. Current-artifact package8 integration and production deployment approval remain separate required gates.'};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  assert.equal(process.argv.length,5,'Use <stage13-report.json> <reviewed-manifest.json> <output.json>');
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  same(path.resolve(process.argv[3]),path.join(root,manifestPath));
  const git=args=>{const result=spawnSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:64*1024*1024,windowsHide:true});same(result.status,0);return result.stdout;};
  const files=git(['ls-files','-z']).split('\0').filter(Boolean),revision=git(['rev-parse','HEAD']).trim();
  if(process.env.GITHUB_SHA)same(process.env.GITHUB_SHA,revision);
  const bytes=n=>{assert(safe(n));const absolute=path.join(root,n);assert(fs.lstatSync(absolute).isFile(),'Source must be an ordinary tracked file');return fs.readFileSync(absolute);};
  const manifest=JSON.parse(bytes(manifestPath)),product=files.filter(n=>!excluded.has(n)&&runtimeInput(n)).sort();
  const raw=spawnSync('git',['cat-file','--batch'],{cwd:root,input:product.map(n=>baseline+':'+n+'\n').join(''),maxBuffer:64*1024*1024,windowsHide:true});same(raw.status,0);
  const historical=new Map();let offset=0;
  for(const name of product){const end=raw.stdout.indexOf(10,offset);assert(end>=0);const header=raw.stdout.subarray(offset,end).toString().split(' ');same(header[1],'blob');const length=Number(header[2]);assert(Number.isSafeInteger(length)&&length>=0);historical.set(name,raw.stdout.subarray(end+1,end+1+length));offset=end+length+2;}
  same(offset,raw.stdout.length);
  const report=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
  const result=requireReleaseQualification(report,manifest,JSON.parse(bytes(evidencePath)),{files,revision,version:JSON.parse(bytes('package.json')).version,bytes,baselineBytes:n=>{assert(historical.has(n));return historical.get(n);}});
  fs.writeFileSync(process.argv[4],JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({status:result.status,sourceRevision:result.sourceRevision,ordinaryCounts:result.ordinaryCounts,dispositionCounts:result.dispositionCounts,ordinaryNOTRUNPromotedToPASS:0}));
}
