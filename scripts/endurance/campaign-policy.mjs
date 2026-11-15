// Pure admission policy: importing/calling this module never launches a process.
export const DURATION_MS = 6 * 60 * 60 * 1000;
const check = (condition, reason) => { if (!condition) throw new Error(reason); };
const milliseconds = value => Number.isSafeInteger(value) && value >= 0;

export function preparedCampaign(runId) {
  check(typeof runId === 'string' && runId.length > 0, 'run identity required');
  return {schema: 'saturn.endurance-policy.v2', runId, status: 'PREPARED', startedAtMs: null,
    deadlineMs: null, elapsedMs: 0, lastWallMs: null, active: null, completed: []};
}

export class CampaignPolicy {
  constructor(saved, clock) {
    this.state = structuredClone(saved);
    check(saved.schema === 'saturn.endurance-policy.v2' && typeof saved.runId === 'string' && saved.runId.length > 0, 'invalid saved campaign');
    check(['PREPARED', 'RUNNING', 'DRAINING', 'FINISHED'].includes(saved.status) && Array.isArray(saved.completed), 'invalid campaign status');
    check(milliseconds(clock.wallMs) && milliseconds(clock.monotonicMs), 'invalid clock');
    this.anchorMono = clock.monotonicMs;
    this.lastMono = clock.monotonicMs;
    this.anchorElapsed = saved.elapsedMs;
    if (saved.status === 'PREPARED') {
      check(saved.startedAtMs === null && saved.deadlineMs === null && saved.lastWallMs === null && saved.elapsedMs === 0 && saved.active === null && saved.completed.length === 0, 'prepared campaign must have no window');
    } else {
      check(milliseconds(saved.startedAtMs) && milliseconds(saved.lastWallMs) && milliseconds(saved.elapsedMs) && milliseconds(saved.deadlineMs) && saved.deadlineMs === saved.startedAtMs + DURATION_MS && saved.lastWallMs >= saved.startedAtMs && saved.elapsedMs >= saved.lastWallMs - saved.startedAtMs, 'invalid saved window');
      check(clock.wallMs >= saved.lastWallMs, 'clock reversal; admission blocked');
      this.anchorElapsed = Math.max(saved.elapsedMs, clock.wallMs - saved.startedAtMs);
      if (saved.active) {
        check(saved.status !== 'FINISHED' && saved.active.runId === saved.runId && milliseconds(saved.active.startedElapsedMs) && saved.active.startedElapsedMs <= saved.elapsedMs && saved.active.startedElapsedMs < DURATION_MS && milliseconds(saved.active.startedAtMs) && saved.active.startedAtMs >= saved.startedAtMs && saved.active.startedAtMs <= saved.lastWallMs && saved.active.startedAtMs < saved.deadlineMs, 'invalid admitted cycle');
        check(Array.isArray(saved.active.lanes) && saved.active.lanes.length > 0 && saved.active.lanes.length <= 3 && new Set(saved.active.lanes.map(l => l.id)).size === saved.active.lanes.length && saved.active.lanes.every(l => ['RUNNING', 'PASS', 'FAIL', 'BLOCKED'].includes(l.status) && Array.isArray(l.attempts) && l.attempts.length > 0 && l.attempts.at(-1).status === l.status), 'invalid lanes');
      }
      this.observe(clock);
    }
  }
  start(clock, explicitOperatorStart = false) {
    check(explicitOperatorStart === true, 'explicit operator start required');
    check(this.state.status === 'PREPARED', 'campaign already started');
    check(milliseconds(clock.wallMs) && milliseconds(clock.monotonicMs), 'invalid clock');
    Object.assign(this.state, {status: 'RUNNING', startedAtMs: clock.wallMs, deadlineMs: clock.wallMs + DURATION_MS, lastWallMs: clock.wallMs});
    this.anchorMono = this.lastMono = clock.monotonicMs;
    return this.snapshot();
  }
  observe(clock) {
    const s = this.state;
    check(s.status !== 'PREPARED', 'campaign not started');
    check(milliseconds(clock.wallMs) && milliseconds(clock.monotonicMs) && clock.wallMs >= s.lastWallMs && clock.monotonicMs >= this.lastMono, 'clock reversal; admission blocked');
    s.elapsedMs = Math.max(s.elapsedMs, this.anchorElapsed + clock.monotonicMs - this.anchorMono, clock.wallMs - s.startedAtMs);
    s.lastWallMs = clock.wallMs; this.lastMono = clock.monotonicMs;
    if (s.elapsedMs >= DURATION_MS && s.status !== 'FINISHED') s.status = 'DRAINING';
    return s.elapsedMs;
  }
  admit(plan, clock) {
    this.observe(clock);
    const s = this.state;
    check(s.status === 'RUNNING' && s.elapsedMs < DURATION_MS && clock.wallMs < s.deadlineMs, 'six-hour admission closed');
    check(s.active === null, 'previous cycle still active');
    check(typeof plan.cycleId === 'string' && plan.cycleId.length && !s.completed.some(c => c.cycleId === plan.cycleId), 'unique cycle identity required');
    check(typeof plan.cohort === 'string' && plan.cohort.length && typeof plan.seed === 'string', 'frozen cohort and seed required');
    check(Array.isArray(plan.lanes) && plan.lanes.length > 0 && plan.lanes.length <= 3 && new Set(plan.lanes.map(l => l.id)).size === plan.lanes.length, 'one to three distinct lanes required');
    check(plan.lanes.every(l => typeof l.id === 'string' && l.id.length && Array.isArray(l.scenarios) && l.scenarios.length && l.scenarios.every(id => typeof id === 'string' && id.length)), 'explicit scenario set required');
    s.active = {...structuredClone(plan), runId: s.runId, startedAtMs: clock.wallMs, startedElapsedMs: s.elapsedMs,
      lanes: plan.lanes.map(l => ({...structuredClone(l), status: 'RUNNING', attempts: [{cohort: plan.cohort, status: 'RUNNING'}]}))};
    return structuredClone(s.active);
  }
  lane(cycleId, laneId) {
    check(this.state.active?.cycleId === cycleId, 'active cycle identity mismatch');
    const lane = this.state.active.lanes.find(l => l.id === laneId);
    check(lane, 'lane not admitted'); return lane;
  }
  finishLane(cycleId, laneId, attemptIndex, outcome, evidence, clock) {
    this.observe(clock);
    const lane = this.lane(cycleId, laneId);
    check(Number.isSafeInteger(attemptIndex) && attemptIndex === lane.attempts.length - 1, 'stale attempt completion');
    check(lane.status === 'RUNNING' && ['PASS', 'FAIL', 'BLOCKED'].includes(outcome), 'invalid lane completion');
    check(typeof evidence === 'string' && evidence.length > 0, 'evidence required');
    lane.status = outcome;
    Object.assign(lane.attempts.at(-1), {status: outcome, evidence, finishedAtMs: clock.wallMs});
  }
  repairLane(cycleId, laneId, {diagnosis, cohort}, clock) {
    this.observe(clock);
    const lane = this.lane(cycleId, laneId);
    check(lane.status === 'FAIL' && typeof diagnosis === 'string' && diagnosis.length > 0 && typeof cohort === 'string' && cohort.length > 0, 'diagnosed failed lane required');
    // No scenarios/seed/targets argument: a repair cannot expand an admitted cycle.
    const repeated = lane.attempts.filter(a => a.diagnosis === diagnosis && a.cohort === cohort && a.status === 'FAIL').length;
    check(repeated < 3, 'unchanged repeated failure; investigate before retry');
    lane.status = 'RUNNING'; lane.attempts.push({diagnosis, cohort, status: 'RUNNING', startedAtMs: clock.wallMs});
  }
  closeCycle(cycleId, clock) {
    this.observe(clock); const s = this.state;
    check(s.active?.cycleId === cycleId && s.active.lanes.every(l => l.status !== 'RUNNING'), 'cycle has active lanes');
    const complete = {...s.active, finishedAtMs: clock.wallMs, status: s.active.lanes.every(l => l.status === 'PASS') ? 'PASS' : 'FAIL', tailMs: Math.max(0, clock.wallMs - s.deadlineMs)};
    s.completed.push(complete); s.active = null;
    if (s.status === 'DRAINING') s.status = 'FINISHED';
    return structuredClone(complete);
  }
  snapshot() { return structuredClone(this.state); }
}
