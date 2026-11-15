import assert from 'node:assert/strict';
import test from 'node:test';
import {accountVitest,redactEvidence,requireFullStage13} from './ci-workspace-accounting.mjs';

const origin=()=>({file:'apps/api/src/contract.test.ts',sha256:'a'.repeat(64),inputHints:['OWN_FIXTURE'],platformConditional:false});
const result=(statuses,extra={})=>({success:!statuses.includes('failed'),numTotalTests:statuses.length,numPassedTests:statuses.filter(x=>x==='passed').length,numFailedTests:statuses.filter(x=>x==='failed').length,numPendingTests:statuses.filter(x=>x==='pending').length,numTodoTests:statuses.filter(x=>x==='todo').length,testResults:[{name:'contract.test.ts',status:statuses.includes('failed')?'failed':'passed',assertionResults:statuses.map((status,n)=>({status,fullName:'case '+n}))}],...extra});

test('ordinary CI success preserves every conditional NOT_RUN and cannot claim complete qualification',()=>{
  const report=accountVitest(result(['passed','pending','todo']),origin);
  assert.equal(report.ordinaryAccepted,true);assert.equal(report.fullQualificationAccepted,false);
  assert.deepEqual(report.counts,{passed:1,failed:0,pending:2,total:3});
  assert(report.cases.filter(x=>x.status==='pending').every(x=>x.pass===false&&x.execution==='NOT_RUN'));
});
test('a failed case and a collection failure cannot disappear behind a green numeric count',()=>{
  assert.equal(accountVitest(result(['passed','failed']),origin).ordinaryAccepted,false);
  const report=result([],{success:false,testResults:[{name:'broken.test.ts',status:'failed',assertionResults:[]}]});
  const outcome=accountVitest(report,origin);assert.equal(outcome.ordinaryAccepted,false);assert.deepEqual(outcome.collectionErrors,['broken.test.ts']);
});
test('missing inventories, unknown statuses and inconsistent PASS counts refuse qualification',()=>{
  assert.throws(()=>accountVitest({success:true,numTotalTests:0},origin),/inventory/);
  assert.throws(()=>accountVitest(result(['invented-success']),origin),/Unrecognized/);
  assert.throws(()=>accountVitest(result(['pending'],{numPassedTests:1}),origin),/PASS count mismatch/);
  assert.throws(()=>accountVitest(result(['passed'],{numTotalTests:8}),origin),/total mismatch/);
});
test('parameterized invocations with identical rendered titles retain distinct identities and statuses',()=>{
  const input=result(['passed','pending']);for(const a of input.testResults[0].assertionResults)a.fullName='same rendered title';
  const report=accountVitest(input,origin);
  assert.equal(report.ordinaryAccepted,true);assert.equal(report.fullQualificationAccepted,false);
  assert.notEqual(report.cases[0].id,report.cases[1].id);
  assert.deepEqual(report.cases.map(x=>x.occurrence),[0,1]);
  assert.deepEqual(report.cases.map(x=>x.status),['passed','pending']);
  const duplicateFile=result(['passed']);duplicateFile.testResults.push(duplicateFile.testResults[0]);
  assert.throws(()=>accountVitest(duplicateFile,origin),/Duplicate test-file collection/);
});
test('redaction removes credentials and private keys while preserving useful failure evidence',()=>{
  const text=redactEvidence('expected 4, got 3; password secret-value-123; Bearer abc.def; Basic YTpi; postgres://u:p@localhost/db; -----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----',['secret-value-123']);
  assert(text.includes('expected 4, got 3'));for(const value of ['secret-value-123','abc.def','YTpi','u:p@','private\n'])assert(!text.includes(value));
});
test('ordinary or diagnostic completion cannot authorize a full release',()=>{
  const report={schema:'vault.stage-verification.v1',stage:13,executionScope:'FULL',fullCiAccepted:true,quality:{accounting:{fullQualificationAccepted:true}},runtimeChecksPassed:true,closure:{status:'CLOSED'}};
  requireFullStage13(report);
  assert.throws(()=>requireFullStage13({...report,fullCiAccepted:false}),/Conditional/);
  assert.throws(()=>requireFullStage13({...report,quality:{accounting:{fullQualificationAccepted:false}}}),/accounting/);
  assert.throws(()=>requireFullStage13({...report,executionScope:'RUNTIME_DIAGNOSTIC'}));
  assert.throws(()=>requireFullStage13({...report,closure:{status:'PENDING'}}));
});
