/**
 * #6278: the claim-phase stamp gains the preparation step, what it waits on
 * and the owner process (claim-phase.ts). Protects: `enterClaimStep` names the
 * step, keeps the step start across repeated boundaries, resets on a phase
 * change and throws the preparation's abort reason once cut off (with or
 * without a clock); `claimStateOf` reads step, step age, waiting_on and owner
 * only from the current claim's stamp and reads an older owner's stamp as
 * null/unknown, never inferred; `claimStall` is the `preparation_overdue`
 * verdict for a preparing claim past its budget and nothing else. Fails when
 * the stamp drops a field, when an old stamp is misread as a known cause, or
 * when a publishing or lapsed claim is reported as overdue preparation.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { claimOwner, claimPhaseStamp, claimStall, claimStateOf, enterClaimPhase, enterClaimStep, setClaimOwnerForTest, startClaimPhase } from '../src/core/persistence/claim-phase.ts';
import { VERSION } from '../src/version.ts';

afterEach(() => setClaimOwnerForTest(undefined));

describe('enterClaimStep', () => {
  test('names the step and what it waits on, keeps the step start while the step repeats, and the phase change clears it', () => {
    const clock = startClaimPhase(1_000);
    expect(clock).toMatchObject({ phase: 'preparing', step: null, waitingOn: 'unknown', stepSince: 1_000 });
    enterClaimStep(clock, 'authority', undefined, 'db', 1_500);
    expect(clock).toMatchObject({ step: 'authority', stepSince: 1_500, waitingOn: 'db' });
    enterClaimStep(clock, 'authority', undefined, 'pool', 2_000);
    expect(clock).toMatchObject({ step: 'authority', stepSince: 1_500, waitingOn: 'pool' });
    enterClaimStep(clock, 'git_rev_parse', undefined, 'git', 2_500);
    expect(clock).toMatchObject({ step: 'git_rev_parse', stepSince: 2_500, waitingOn: 'git' });
    enterClaimPhase(clock, 'publishing', 3_000);
    expect(clock).toMatchObject({ phase: 'publishing', since: 3_000, step: null, stepSince: 3_000, waitingOn: 'unknown' });
  });
  test('throws the preparation\'s abort reason at the boundary, with or without a clock, and leaves the clock unchanged', () => {
    const abort = new AbortController();
    abort.abort({ code: 'preparation_deadline' });
    const clock = startClaimPhase(1_000);
    enterClaimStep(clock, 'authority', undefined, 'db', 1_200);
    expect(() => enterClaimStep(clock, 'binding', abort.signal, 'db', 1_300)).toThrow();
    try { enterClaimStep(clock, 'binding', abort.signal); } catch (error) { expect(error).toMatchObject({ code: 'preparation_deadline' }); }
    expect(clock.step).toBe('authority');
    expect(() => enterClaimStep(undefined, 'origin_check', abort.signal)).toThrow();
    expect(() => enterClaimStep(undefined, 'origin_check', new AbortController().signal)).not.toThrow();
  });
});

describe('claimPhaseStamp and claimStateOf', () => {
  test('the stamp carries phase, ages, token, step, step start, waiting_on and the owner process', () => {
    setClaimOwnerForTest({ kind: 'sync', pid: 4242, version: '0.60.200.0' });
    const clock = startClaimPhase(Date.parse('2026-10-08T03:00:00Z'));
    enterClaimStep(clock, 'origin_check', undefined, 'db', Date.parse('2026-10-08T03:01:00Z'));
    expect(JSON.parse(claimPhaseStamp(clock, 'tok-1'))).toEqual({ phase: 'preparing', claimed_at: '2026-10-08T03:00:00.000Z', since: '2026-10-08T03:00:00.000Z', token: 'tok-1',
      step: 'origin_check', step_since: '2026-10-08T03:01:00.000Z', waiting_on: 'db', owner: { kind: 'sync', pid: 4242, version: '0.60.200.0' } });
  });
  test('the default owner is this process: the gbrain command (cli when none), pid and build', () => {
    const owner = claimOwner();
    expect(owner).toEqual({ kind: expect.any(String), pid: process.pid, version: VERSION });
  });
  test('claimStateOf reads step, step age, waiting_on and owner from the current claim\'s stamp', () => {
    const now = Date.parse('2026-10-08T03:12:00Z');
    const stamp = { phase: 'preparing', claimed_at: '2026-10-08T03:00:00Z', since: '2026-10-08T03:00:00Z', token: 't1',
      step: 'link_resolution', step_since: '2026-10-08T03:02:00Z', waiting_on: 'db', owner: { kind: 'sync', pid: 7, version: '0.60.200.0' } };
    const state = claimStateOf({ state: 'running', claim_phase: stamp, execution_token: 't1' }, now);
    expect(state).toMatchObject({ phase: 'preparing', claim_age_ms: 12 * 60_000, phase_age_ms: 12 * 60_000, step: 'link_resolution', step_age_ms: 10 * 60_000,
      waiting_on: 'db', owner: { kind: 'sync', pid: 7, version: '0.60.200.0' } });
    expect(state?.why).toContain('step link_resolution, waiting on db');
    // Another claim's stamp: nothing of it is attributed to the current token.
    expect(claimStateOf({ state: 'running', claim_phase: stamp, execution_token: 't2' }, now)).toMatchObject({ phase: 'unrecorded', step: null, step_age_ms: null, waiting_on: 'unknown', owner: null });
  });
  test('an older owner\'s stamp (no step fields) reads as step null and waiting_on unknown, never inferred', () => {
    const now = Date.parse('2026-10-08T03:12:00Z');
    const old = { phase: 'preparing', claimed_at: '2026-10-08T03:00:00Z', since: '2026-10-08T03:00:00Z', token: 't1' };
    const state = claimStateOf({ state: 'running', claim_phase: JSON.stringify(old), execution_token: 't1' }, now);
    expect(state).toMatchObject({ phase: 'preparing', step: null, step_age_ms: null, waiting_on: 'unknown', owner: null });
    const odd = { ...old, step: 'x', step_since: 'not a date', waiting_on: 'lock', owner: { kind: 'sync' } };
    expect(claimStateOf({ state: 'running', claim_phase: odd, execution_token: 't1' }, now)).toMatchObject({ step: 'x', step_age_ms: null, waiting_on: 'unknown', owner: null });
  });
});

describe('claimStall', () => {
  const now = Date.parse('2026-10-08T03:12:00Z');
  const preparing = { phase: 'preparing', claimed_at: '2026-10-08T03:00:00Z', since: '2026-10-08T03:00:00Z', token: 't1', step: 'raw_hash', step_since: '2026-10-08T03:05:00Z', waiting_on: 'fs' };
  test('a preparing claim past its budget is preparation_overdue with the step, its age, waiting_on and the budget', () => {
    const state = claimStateOf({ state: 'running', claim_phase: preparing, execution_token: 't1' }, now);
    expect(claimStall(state, 120_000)).toEqual({ reason: 'preparation_overdue', step: 'raw_hash', step_age_ms: 7 * 60_000, waiting_on: 'fs', budget_ms: 120_000 });
    expect(claimStall(state, 13 * 60_000)).toBeNull();
  });
  test('publishing, lapsed, file-publication, unrecorded and non-running claims are never overdue preparation', () => {
    expect(claimStall(claimStateOf({ state: 'running', claim_phase: { ...preparing, phase: 'publishing' }, execution_token: 't1' }, now), 1)).toBeNull();
    expect(claimStall(claimStateOf({ state: 'running', claim_phase: preparing, execution_token: 't1', claim_lapsed: true }, now), 1)).toBeNull();
    expect(claimStall(claimStateOf({ state: 'running', claim_phase: preparing, execution_token: 't1', publication_started: true }, now), 1)).toBeNull();
    expect(claimStall(claimStateOf({ state: 'running', claim_phase: preparing, execution_token: 'other' }, now), 1)).toBeNull();
    expect(claimStall(claimStateOf({ state: 'queued', claim_phase: preparing, execution_token: 't1' }, now), 1)).toBeNull();
  });
});
