import assert from 'node:assert/strict';

// Explicitly close a cycle with its failure intact so independent scenarios may
// continue. This narrow gate cannot waive a product failure or a running lane.
export function acceptLockedDesktopDisposition(active,disposition,recovery,proof){
 assert(active&&active.lanes.every(l=>['PASS','FAIL'].includes(l.status)),'all lanes must be terminal');
 assert.equal(disposition.runId,active.runId);assert.equal(disposition.cycleId,active.cycleId);
 assert.equal(disposition.kind,'continue-independent-with-ui-blocked');
 assert.equal(proof.runId,active.runId);assert.equal(proof.cycleId,active.cycleId);
 assert.equal(proof.profile,'endurance-ui-'+active.runId.slice(0,8));
 assert.equal(proof.status,'BLOCKED');assert.equal(proof.reasonCode,'windows-desktop-locked');
 assert(disposition.evidence&&disposition.reason);
 const failed=active.lanes.filter(l=>l.status!=='PASS');
 assert.equal(failed.length,1);assert.equal(failed[0].id,'RECOVERY');assert.equal(failed[0].status,'FAIL');
 assert.equal(recovery.status,'FAIL');assert.equal(recovery.error,'Error: Windows UI gate BLOCKED');
 const required=['native-profile-pause','native-profile-inspect','native-profile-checkpoint','native-profile-resume','windows-local-save-network','pluto-daemon-recovery'];
 for(const name of required)assert(recovery.checks.some(c=>c.name===name&&c.status==='PASS'));
 assert.deepEqual(recovery.checks.filter(c=>c.status!=='PASS').map(c=>[c.name,c.status]),[['windows-ui','BLOCKED']]);
 return {...disposition,acceptedAt:new Date().toISOString(),cycleOutcome:'FAIL',unresolvedGroup:'WIN-01',unresolvedStatus:'BLOCKED'};
}
