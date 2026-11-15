import test from 'node:test';
import assert from 'node:assert/strict';
import { CampaignPolicy, preparedCampaign, DURATION_MS } from './campaign-policy.mjs';

const T0 = Date.UTC(2026, 9, 15);
const clock = delta => ({wallMs: T0 + delta, monotonicMs: 1000 + delta});
const plan = id => ({cycleId: id, cohort: 'N0', seed: 'deterministic-42', lanes: [
  {id: 'SYNC', scenarios: ['SYNC-04', 'DUP-01']},
  {id: 'PRODUCT', scenarios: ['SAT-02', 'SHARE-02', 'DROP-03']},
  {id: 'RECOVERY', scenarios: ['RES-01']},
]});
const started = () => { const p = new CampaignPolicy(preparedCampaign('owned-run'), clock(0)); p.start(clock(0), true); return p; };

test('preparation cannot establish T0 or launch admission', () => {
  const p = new CampaignPolicy(preparedCampaign('owned-run'), clock(0));
  assert.throws(() => p.admit(plan('one'), clock(1)), /not started/);
  assert.throws(() => p.start(clock(1)), /explicit operator/);
  assert.equal(p.snapshot().startedAtMs, null);
});
test('exact six-hour boundary rejects a new cycle', () => {
  const p = started(); assert.throws(() => p.admit(plan('late'), clock(DURATION_MS)), /admission closed/);
  assert.equal(p.snapshot().active, null);
});
test('three parallel lanes admitted before boundary all drain afterwards', () => {
  const p = started(); const supplied = plan('last'); p.admit(supplied, clock(DURATION_MS - 1));
  supplied.lanes[0].scenarios.push('UNADMITTED');
  assert.equal(p.snapshot().active.lanes[0].scenarios.length, 2);
  p.finishLane('last', 'PRODUCT', 0, 'PASS', 'browser-results', clock(DURATION_MS + 1));
  assert.throws(() => p.closeCycle('last', clock(DURATION_MS + 2)), /active lanes/);
  p.finishLane('last', 'RECOVERY', 0, 'PASS', 'network-results', clock(DURATION_MS + 3));
  p.finishLane('last', 'SYNC', 0, 'PASS', 'manifest-readback', clock(DURATION_MS + 4));
  assert.equal(p.closeCycle('last', clock(DURATION_MS + 5)).status, 'PASS');
  assert.throws(() => p.admit(plan('extra'), clock(DURATION_MS + 6)), /admission closed/);
});
test('repair of last admitted lane is allowed after six hours without new scenarios', () => {
  const p = started(); p.admit(plan('last'), clock(DURATION_MS - 1));
  p.finishLane('last', 'SYNC', 0, 'FAIL', 'duplicate-file-evidence', clock(DURATION_MS + 1));
  p.repairLane('last', 'SYNC', {diagnosis: 'original reminted', cohort: 'N1'}, clock(DURATION_MS + 2));
  assert.deepEqual(p.snapshot().active.lanes[0].scenarios, ['SYNC-04', 'DUP-01']);
  p.finishLane('last', 'SYNC', 1, 'PASS', 'same-seed-readback', clock(DURATION_MS + 3));
  assert.equal(p.snapshot().active.lanes[0].attempts[0].status, 'FAIL');
  assert.throws(() => p.repairLane('other', 'SYNC', {diagnosis: 'x', cohort: 'N1'}, clock(DURATION_MS + 4)), /identity/);
});
test('resume includes downtime and cannot create a new six-hour window', () => {
  const p = started(); p.admit(plan('one'), clock(5)); p.observe(clock(10));
  const resumed = new CampaignPolicy(p.snapshot(), {wallMs: T0 + DURATION_MS + 500, monotonicMs: 20});
  assert.equal(resumed.snapshot().deadlineMs, T0 + DURATION_MS);
  assert.equal(resumed.snapshot().status, 'DRAINING');
  assert.throws(() => resumed.start({wallMs: T0 + DURATION_MS + 501, monotonicMs: 21}, true), /already started/);
});
test('wall clock or monotonic reversal blocks further mutation', () => {
  const p = started(); p.observe(clock(100));
  assert.throws(() => p.admit(plan('one'), {wallMs: T0 + 99, monotonicMs: 1101}), /reversal/);
  assert.throws(() => p.admit(plan('one'), {wallMs: T0 + 101, monotonicMs: 1099}), /reversal/);
});
test('persisted deadline tampering and invented late active cycle are refused', () => {
  const s = started().snapshot(); s.deadlineMs++;
  assert.throws(() => new CampaignPolicy(s, clock(1)), /saved window/);
  const p = started(); p.admit(plan('one'), clock(1)); const late = p.snapshot(); late.active.startedElapsedMs = DURATION_MS;
  assert.throws(() => new CampaignPolicy(late, clock(DURATION_MS)), /admitted cycle/);
});
test('unresolved failure cannot be reported as successful cycle', () => {
  const p = started(); p.admit(plan('one'), clock(1));
  for (const [i, lane] of ['SYNC', 'PRODUCT', 'RECOVERY'].entries()) p.finishLane('one', lane, 0, i === 0 ? 'BLOCKED' : 'PASS', 'primary-evidence', clock(i + 2));
  assert.equal(p.closeCycle('one', clock(5)).status, 'FAIL');
});
test('identical repair failures stop blind retries and retain their evidence', () => {
  const p = started(); p.admit(plan('one'), clock(1)); p.finishLane('one', 'SYNC', 0, 'FAIL', 'initial', clock(2));
  for (let i = 0; i < 3; i++) {
    p.repairLane('one', 'SYNC', {diagnosis: 'same', cohort: 'N1'}, clock(3 + i * 2));
    p.finishLane('one', 'SYNC', i + 1, 'FAIL', 'failure-' + i, clock(4 + i * 2));
  }
  assert.throws(() => p.repairLane('one', 'SYNC', {diagnosis: 'same', cohort: 'N1'}, clock(10)), /repeated failure/);
  assert.equal(p.snapshot().active.lanes[0].attempts.length, 4);
});

test('a delayed completion from the failed process cannot pass its replacement', () => {
  const p = started(); p.admit(plan('one'), clock(1));
  p.finishLane('one', 'SYNC', 0, 'FAIL', 'process-failed', clock(2));
  p.repairLane('one', 'SYNC', {diagnosis: 'fixed-recovery', cohort: 'N1'}, clock(3));
  assert.throws(() => p.finishLane('one', 'SYNC', 0, 'PASS', 'late-old-output', clock(4)), /stale attempt/);
  assert.equal(p.snapshot().active.lanes[0].status, 'RUNNING');
  p.finishLane('one', 'SYNC', 1, 'PASS', 'new-process-evidence', clock(5));
});

test('invalid persisted cycle times and finished-but-running states fail closed', () => {
  const p = started(); p.admit(plan('one'), clock(1));
  for (const change of [
    s => { s.active.startedElapsedMs = -1; },
    s => { s.active.startedAtMs = T0 - 1; },
    s => { s.active.startedAtMs = T0 + 2; },
    s => { s.status = 'FINISHED'; },
  ]) {
    const saved = p.snapshot(); change(saved);
    assert.throws(() => new CampaignPolicy(saved, clock(2)), /admitted cycle/);
  }
});

