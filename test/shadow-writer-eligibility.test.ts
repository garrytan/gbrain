/**
 * Swap eligibility's writer observations (src/shadow/writer-observations.ts, writer-coverage.ts, eligibility.ts).
 *
 * Protects: a wrapped process notes its committed writes in engine_writer_observations (one row per process, refreshed
 * at most every 10 minutes, nothing for a rolled-back transaction), independently of the follower and the child's
 * health; a brain with no shadow wrapper gets no row; a lost observation leaves a fault the coverage source counts;
 * the eligibility builder reads one SELECT, leaves the writer fields out with no engine or a failed SELECT, and names a
 * failure by code only; the window keeps the refresh slack; preview_target follows the release addon targets; the
 * start plan declares the new write. Regression it catches: an observation that depends on the follower or a healthy
 * child, a throttle that drops a writer early, a failed read reported as zero hosts, an error message or SQL leaking
 * into the status document, or a start plan that still says it never writes the brain database.
 * Postgres: test/e2e/shadow-writer-eligibility.test.ts. Readiness criterion 11: test/shadow-eligibility-readiness.test.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { drainBackgroundWorkBeforeDisconnect } from '../src/core/background-work.ts';
import { gbrainApplicationName } from '../src/core/db.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { wrapShadowEngine, type ShadowSink } from '../src/shadow/wrapper.ts';
import { newMirrorCounters } from '../src/shadow/mirror.ts';
import { OBSERVATION_REFRESH_MS, WriterObserver, readWriterEvidence } from '../src/shadow/writer-observations.ts';
import { WRITER_EVIDENCE_TABLES, WRITER_HOOK_TRIGGER } from '../src/shadow/writer-hooks.ts';
import { IGNORED_MEMBERS, IGNORED_WRITE_MEMBERS } from '../src/shadow/write-map.ts';
import { planAsWrittenSource } from '../src/shadow/writer-coverage.ts';
import { buildEligibilityStatus, eligibilityWindowStart, isPreviewTarget, ELIGIBILITY_WINDOW_MS } from '../src/shadow/eligibility.ts';
import { writerIdentity } from '../src/shadow/attach.ts';
import { runEngineShadow, shadowPlan } from '../src/commands/engine-shadow.ts';
import { shadowBrainKey, shadowDirFor, writeShadowState } from '../src/shadow/state.ts';
import { withEnv } from './helpers/with-env.ts';
import { SHADOW_STATE_VERSION, type ShadowState } from '../src/shadow/state.ts';

const HOST_A = '11111111-1111-4111-8111-111111111111';
const HOST_B = '22222222-2222-4222-8222-222222222222';

let primary: PGLiteEngine;
const dirs: string[] = [];
const observers: WriterObserver[] = [];

beforeAll(async () => {
  primary = new PGLiteEngine();
  await primary.connect({});
  await primary.initSchema();
});

afterAll(async () => {
  await primary.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(primary);
  await primary.executeRaw('DELETE FROM engine_writer_observations');
});

afterEach(() => {
  for (const o of observers.splice(0)) o.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'gbrain-writer-elig-'));
  dirs.push(d);
  return d;
}

function sink(active: boolean): ShadowSink {
  return { counters: newMirrorCounters(), offer: () => undefined, active: () => active };
}

function observer(dir: string, opts: { host?: string; app?: string; now?: () => number; on?: BrainEngine } = {}): WriterObserver {
  const o = new WriterObserver({
    primary: opts.on ?? primary, dir, now: opts.now,
    identity: () => ({ hostId: opts.host ?? HOST_A, applicationName: opts.app ?? 'gbrain cli:1:abcdef01', processKind: 'cli', gbrainVersion: 'test' }),
  });
  observers.push(o);
  return o;
}

async function rows(): Promise<Array<{ host_id: string; application_name: string }>> {
  return primary.executeRaw('SELECT host_id, application_name FROM engine_writer_observations ORDER BY host_id, application_name');
}

async function settle(o: WriterObserver): Promise<void> {
  while (o.inFlight) await o.inFlight;
}

async function putPage(engine: BrainEngine, slug: string): Promise<void> {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `body of ${slug}` } as never);
}

function state(startedAt: string): ShadowState {
  return { version: SHADOW_STATE_VERSION, enabled: true, started_at: startedAt, sample_rate: 1, queue_bound: 8, plan_hash: 'x', brain: 'pglite-test', primary_engine: 'pglite' };
}

describe('writer observations', () => {
  test('a brain with no shadow wrapper gets no row (the observer exists only inside the wrapper)', async () => {
    await putPage(primary, 'notes/plain');
    await primary.executeRaw(`INSERT INTO config (key, value) VALUES ('writer-test', '1') ON CONFLICT (key) DO NOTHING`);
    expect(await rows()).toEqual([]);
    const unobserved = wrapShadowEngine(primary, sink(true), { sampleRate: 0 });
    await putPage(unobserved, 'notes/wrapped-no-observer');
    expect(await rows()).toEqual([]);
  });

  test('ten committed writes from one process give one row; a rolled-back transaction gives none', async () => {
    const dir = tempDir();
    const o = observer(dir);
    const engine = wrapShadowEngine(primary, sink(true), { sampleRate: 0, onCommittedWrite: () => o.note() });
    await expect(engine.transaction(async (tx) => { await putPage(tx, 'notes/rolled-back'); throw new Error('roll back'); })).rejects.toThrow('roll back');
    await settle(o);
    expect(await rows()).toEqual([]);
    for (let i = 0; i < 10; i++) await putPage(engine, `notes/w${i}`);
    await settle(o);
    expect(await rows()).toEqual([{ host_id: HOST_A, application_name: 'gbrain cli:1:abcdef01' }]);
  });

  test('a committed transaction notes once; reads never note', async () => {
    const o = observer(tempDir());
    let notes = 0;
    const engine = wrapShadowEngine(primary, sink(true), { sampleRate: 0, onCommittedWrite: () => { notes++; o.note(); } });
    await engine.getPage('notes/missing');
    await engine.executeRaw('SELECT 1');
    expect(notes).toBe(0);
    await engine.transaction(async (tx) => { await putPage(tx, 'notes/t1'); await putPage(tx, 'notes/t2'); });
    expect(notes).toBe(1);
    await settle(o);
    expect((await rows()).length).toBe(1);
  });

  test('writes are noted when shadow is on but the brain is unseeded or the child is disabled (no follow, inactive sink)', async () => {
    const o = observer(tempDir());
    const engine = wrapShadowEngine(primary, sink(false), { sampleRate: 1, onCommittedWrite: () => o.note() });
    await putPage(engine, 'notes/child-down');
    await settle(o);
    expect((await rows()).length).toBe(1);
  });

  test('the refresh interval throttles writes, and the next interval refreshes last_seen', async () => {
    let t = 1_000_000;
    const o = observer(tempDir(), { now: () => t });
    o.note();
    await settle(o);
    await primary.executeRaw(`UPDATE engine_writer_observations SET last_seen = now() - interval '11 minutes'`);
    const [before] = await primary.executeRaw<{ age: number }>(`SELECT extract(epoch FROM now() - last_seen)::int AS age FROM engine_writer_observations`);
    t += OBSERVATION_REFRESH_MS - 1;
    o.note();
    await settle(o);
    const [held] = await primary.executeRaw<{ age: number }>(`SELECT extract(epoch FROM now() - last_seen)::int AS age FROM engine_writer_observations`);
    expect(held!.age).toBe(before!.age);
    t += 2;
    o.note();
    await settle(o);
    const [after] = await primary.executeRaw<{ age: number }>(`SELECT extract(epoch FROM now() - last_seen)::int AS age FROM engine_writer_observations`);
    expect(after!.age).toBeLessThan(60);
  });

  test('a disconnect right after the first write still lands the row (background-work drain)', async () => {
    const o = observer(tempDir());
    o.note();
    expect(o.inFlight).not.toBeNull();
    await drainBackgroundWorkBeforeDisconnect({ timeoutMs: 5_000 });
    expect(o.inFlight).toBeNull();
    expect((await rows()).length).toBe(1);
  });

  test('a lost observation leaves a fault with its code only, and the coverage source counts it', async () => {
    const dir = tempDir();
    const broken = { transaction: async () => { throw Object.assign(new Error('relation engine_writer_observations does not exist SECRET'), { code: '42P01' }); } } as unknown as BrainEngine;
    const o = observer(dir, { on: broken });
    o.note();
    await settle(o);
    const faults = readFileSync(join(dir, 'faults.jsonl'), 'utf8');
    expect(faults).toContain('"kind":"writer_observation_failed"');
    expect(faults).toContain('code=42P01');
    expect(faults).not.toContain('SECRET');
    expect(planAsWrittenSource(dir).unknownPaths(new Date(Date.now() - 60_000))).toBe(1);
    expect(planAsWrittenSource(dir).unknownPaths(new Date(Date.now() + 60_000))).toBe(0);
  });

  test('a stopped shadow neither notes nor repairs hooks, and a process notes again once shadow mode is on', async () => {
    let on = false;
    let repairs = 0;
    const o = new WriterObserver({
      primary, dir: tempDir(), now: () => 5_000_000,
      identity: () => ({ hostId: HOST_A, applicationName: 'gbrain cli:1:abcdef01', processKind: 'cli', gbrainVersion: 'test' }),
      enabled: () => on, beforeFirstNote: async () => { repairs++; },
    });
    observers.push(o);
    o.note();
    await settle(o);
    expect([repairs, (await rows()).length]).toEqual([0, 0]);
    on = true;
    // The throttle interval has not passed for the stopped attempt, so the process notes at its next interval.
    const later = new WriterObserver({
      primary, dir: tempDir(), identity: () => ({ hostId: HOST_A, applicationName: 'gbrain cli:2:abcdef02', processKind: 'cli', gbrainVersion: 'test' }),
      enabled: () => on, beforeFirstNote: async () => { repairs++; },
    });
    observers.push(later);
    later.note();
    await settle(later);
    expect([repairs, (await rows()).length]).toEqual([1, 1]);
    // An unreadable state file reads as off.
    const broken = new WriterObserver({ primary, dir: tempDir(), identity: () => ({ hostId: HOST_B, applicationName: 'x', processKind: 'cli', gbrainVersion: 'test' }), enabled: () => { throw new Error('torn'); } });
    observers.push(broken);
    broken.note();
    await settle(broken);
    expect((await rows()).length).toBe(1);
  });

  test('a failed note is retried by the next write, and a failed hook repair is recorded without stopping the note', async () => {
    const dir = tempDir();
    let failures = 1;
    const flaky = Object.create(primary) as BrainEngine;
    flaky.transaction = (async (fn: (tx: BrainEngine) => Promise<unknown>) => {
      if (failures-- > 0) throw Object.assign(new Error('boom'), { code: '40001' });
      return primary.transaction(fn as never);
    }) as never;
    const faults: string[] = [];
    const o = new WriterObserver({
      primary: flaky, dir, recordFailure: (c) => faults.push(c),
      identity: () => ({ hostId: HOST_A, applicationName: 'gbrain cli:3:abcdef03', processKind: 'cli', gbrainVersion: 'test' }),
      beforeFirstNote: async () => { throw Object.assign(new Error('no rights'), { code: '42501' }); },
    });
    observers.push(o);
    o.note();
    await settle(o);
    expect(faults).toEqual(['hooks_42501', '40001']);
    expect((await rows()).length).toBe(0);
    // No waiting for the refresh interval: a failure clears the throttle, so the very next write retries.
    o.note();
    await settle(o);
    expect((await rows()).length).toBe(1);
    expect(faults).toEqual(['hooks_42501', '40001']);
  });

  test('which calls note: raw writes and ignored members that write (locks, logs) do; raw reads, a rejected write and a throwing observer never change the call', async () => {
    let notes = 0;
    const engine = wrapShadowEngine(primary, sink(true), { sampleRate: 0, onCommittedWrite: () => { notes++; } });
    await engine.executeRaw('SELECT 1');
    expect(notes).toBe(0);
    await engine.executeRaw(`INSERT INTO config (key, value) VALUES ('writer-raw', '1') ON CONFLICT (key) DO NOTHING`);
    expect(notes).toBe(1);
    // logIngest is ignored by the follower (not copied) but is a database write: it must note.
    await engine.logIngest({ source_type: 'test', source_ref: 'writer-elig', pages_updated: [], summary: 'x' });
    expect(notes).toBe(2);
    await expect(engine.executeRaw('INSERT INTO table_that_does_not_exist VALUES (1)')).rejects.toThrow();
    expect(notes).toBe(2);
    const noisy = wrapShadowEngine(primary, sink(true), { sampleRate: 0, onCommittedWrite: () => { throw new Error('observer broke'); } });
    expect(await noisy.executeRaw(`SELECT 7 AS n`)).toEqual([{ n: 7 }]);
    await noisy.executeRaw(`INSERT INTO config (key, value) VALUES ('writer-raw-2', '1') ON CONFLICT (key) DO NOTHING`);
    // Lifecycle members never note.
    await engine.holdsDatastoreLock?.();
    expect(notes).toBe(2);
  });

  test('every ignored member that writes the database is an ignored member', () => {
    for (const name of IGNORED_WRITE_MEMBERS) expect([name, IGNORED_MEMBERS.has(name)]).toEqual([name, true]);
  });

  test('a write that a caught inner rollback undid does not make the outer transaction a writer; an inner commit does', async () => {
    let notes = 0;
    const engine = wrapShadowEngine(primary, sink(true), { sampleRate: 0, onCommittedWrite: () => { notes++; } });
    await engine.transaction(async (tx) => {
      await tx.transaction(async (inner) => { await putPage(inner, 'notes/inner-rolled-back'); throw new Error('undo'); }).catch(() => undefined);
    });
    expect(notes).toBe(0);
    await engine.transaction(async (tx) => {
      await tx.transaction(async (inner) => { await putPage(inner, 'notes/inner-commits'); });
    });
    expect(notes).toBe(1);
  });

  test('the observer identity names connections the way the pools do', () => {
    expect(writerIdentity(primary).applicationName).toBe(gbrainApplicationName());
  });
});

describe('coverage source (plan as written)', () => {
  function pass(dir: string, finished: string, repaired: number, misses: number): void {
    mkdirSync(join(dir, 'reconcile'), { recursive: true });
    appendFileSync(join(dir, 'reconcile', 'passes.jsonl'), JSON.stringify({ id: `p-${finished}`, kind: 'full', started_at: finished, finished_at: finished, repaired_rows: repaired, repaired_by_relation: {}, follower_misses: misses }) + '\n');
  }

  test('follower misses and repairs made with an invalid watermark count; clean passes and old passes do not', () => {
    const dir = tempDir();
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    pass(dir, iso(now - 10 * 86_400_000), 5, 5); // before the window
    pass(dir, iso(now - 3_600_000), 0, 0); // clean
    pass(dir, iso(now - 1_800_000), 4, 4); // follower misses
    pass(dir, iso(now - 900_000), 3, 0); // repaired while the watermark was invalid
    expect(planAsWrittenSource(dir).unknownPaths(new Date(now - ELIGIBILITY_WINDOW_MS))).toBe(2);
  });

  test('a record that parses to a non-object, and a record file that cannot be read, count as incomplete evidence', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'reconcile'), { recursive: true });
    appendFileSync(join(dir, 'reconcile', 'passes.jsonl'), 'null\n17\n[1]\n"x"\n');
    expect(planAsWrittenSource(dir).unknownPaths(new Date(0))).toBe(4);
    // A directory where the faults file should be: reading it fails, which is incomplete evidence, never a crash.
    const other = tempDir();
    mkdirSync(join(other, 'faults.jsonl'), { recursive: true });
    expect(planAsWrittenSource(other).unknownPaths(new Date(0))).toBe(1);
  });

  test('a record that parses but lacks its time, or carries counts of the wrong type, is incomplete evidence and counts', () => {
    const fault = (rec: unknown): string => { const d = tempDir(); appendFileSync(join(d, 'faults.jsonl'), JSON.stringify(rec) + '\n'); return d; };
    const passFile = (rec: unknown): string => { const d = tempDir(); mkdirSync(join(d, 'reconcile'), { recursive: true }); appendFileSync(join(d, 'reconcile', 'passes.jsonl'), JSON.stringify(rec) + '\n'); return d; };
    const far = new Date(Date.now() + 3_600_000); // a window that starts after every valid record here
    // A writer failure with no time is not old: it counts.
    expect(planAsWrittenSource(fault({ kind: 'writer_observation_failed' })).unknownPaths(far)).toBe(1);
    expect(planAsWrittenSource(fault({ kind: 'writer_observation_failed', ts: 'yesterday' })).unknownPaths(far)).toBe(1);
    expect(planAsWrittenSource(fault({ ts: new Date().toISOString() })).unknownPaths(far)).toBe(1);
    expect(planAsWrittenSource(fault({ kind: 7, ts: new Date().toISOString() })).unknownPaths(far)).toBe(1);
    // A pass missing either count counts: absent is incomplete evidence, never zero.
    expect(planAsWrittenSource(passFile({ id: 'p', finished_at: new Date().toISOString() })).unknownPaths(new Date(0))).toBe(1);
    expect(planAsWrittenSource(passFile({ id: 'p', finished_at: new Date().toISOString(), follower_misses: 0 })).unknownPaths(new Date(0))).toBe(1);
    expect(planAsWrittenSource(passFile({ id: 'p', finished_at: new Date().toISOString(), repaired_rows: 0 })).unknownPaths(new Date(0))).toBe(1);
    // A pass with no finish time, or with counts of the wrong type, counts too.
    expect(planAsWrittenSource(passFile({ id: 'p', follower_misses: 0, repaired_rows: 0 })).unknownPaths(far)).toBe(1);
    expect(planAsWrittenSource(passFile({ id: 'p', finished_at: 'soon', follower_misses: 0, repaired_rows: 0 })).unknownPaths(far)).toBe(1);
    expect(planAsWrittenSource(passFile({ id: 'p', finished_at: new Date().toISOString(), follower_misses: '3', repaired_rows: 0 })).unknownPaths(far)).toBe(1);
    expect(planAsWrittenSource(passFile({ id: 'p', finished_at: new Date().toISOString(), follower_misses: 0, repaired_rows: -1 })).unknownPaths(far)).toBe(1);
    // Well-formed old records, an unrelated fault kind and a clean pass do not count.
    expect(planAsWrittenSource(fault({ kind: 'something_else', ts: new Date().toISOString() })).unknownPaths(far)).toBe(0);
    expect(planAsWrittenSource(passFile({ id: 'p', finished_at: new Date().toISOString(), follower_misses: 0, repaired_rows: 0 })).unknownPaths(far)).toBe(0);
  });

  test('a torn record is incomplete evidence and counts', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'reconcile'), { recursive: true });
    appendFileSync(join(dir, 'reconcile', 'passes.jsonl'), '{"id":"torn"');
    expect(planAsWrittenSource(dir).unknownPaths(new Date(0))).toBe(1);
  });
});

describe('eligibility builder', () => {
  const noUnknown = { name: 'test', unknownPaths: () => 0 };

  test('one host: writer_hosts_7d 1 and unknown 0; a second host is counted', async () => {
    const dir = tempDir();
    observer(dir).note();
    await settle(observers[0]!);
    const one = await buildEligibilityStatus({ dir, state: state(new Date(Date.now() - 86_400_000).toISOString()), engine: primary, source: noUnknown, brainId: () => 'host', addonTarget: () => 'linux-x64-glibc' });
    expect(one).toEqual({ eligibility: { writer_hosts_7d: 1, unknown_writer_paths: 0, team_brain: false, preview_target: true } });
    observer(dir, { host: HOST_B, app: 'gbrain serve:2:abcdef02' }).note();
    await settle(observers[1]!);
    const two = await buildEligibilityStatus({ dir, state: null, engine: primary, source: noUnknown, brainId: () => 'host', addonTarget: () => 'linux-x64-glibc' });
    expect(two.eligibility.writer_hosts_7d).toBe(2);
  });

  test('no engine: the writer fields are left out, never zero', async () => {
    const out = await buildEligibilityStatus({ dir: tempDir(), state: null, brainId: () => 'host', addonTarget: () => 'darwin-arm64' });
    expect(out).toEqual({ eligibility: { team_brain: false, preview_target: true } });
    expect('writer_hosts_7d' in out.eligibility).toBe(false);
  });

  test('a failed SELECT leaves the writer fields out and names the failure by code, never message or SQL', async () => {
    const failing = { executeRaw: async () => { throw Object.assign(new Error('could not connect to server at db.example SECRET SELECT host_id'), { code: 'ECONNREFUSED' }); } } as unknown as BrainEngine;
    const out = await buildEligibilityStatus({ dir: tempDir(), state: null, engine: failing, brainId: () => 'host', addonTarget: () => 'linux-x64-glibc' });
    expect(out).toEqual({ eligibility: { team_brain: false, preview_target: true }, eligibility_evidence: { state: 'read_failed', code: 'ECONNREFUSED' } });
    expect(JSON.stringify(out)).not.toContain('SECRET');
    const noCode = await buildEligibilityStatus({ dir: tempDir(), state: null, engine: { executeRaw: async () => { throw new Error('x'); } } as unknown as BrainEngine, brainId: () => 'host', addonTarget: () => null });
    expect(noCode.eligibility_evidence).toEqual({ state: 'read_failed', code: 'unknown' });
  });

  test('malformed counts from the SELECT leave the writer fields out and name writer_evidence_malformed', async () => {
    const answers: unknown[][] = [
      [], [{ hosts: null, unresolved: 0, gaps: 0, unhooked: 0, uncovered_roles: 0 }], [{ hosts: 1, unresolved: -1, gaps: 0, unhooked: 0, uncovered_roles: 0 }],
      [{ hosts: 1, unresolved: 0, gaps: 'x', unhooked: 0, uncovered_roles: 0 }], [{ hosts: 1.5, unresolved: 0, gaps: 0, unhooked: 0, uncovered_roles: 0 }],
      [{ hosts: 1, unresolved: 0, gaps: 0, unhooked: 0 }],
    ];
    for (const rowsBack of answers) {
      const engine = { executeRaw: async () => rowsBack } as unknown as BrainEngine;
      const out = await buildEligibilityStatus({ dir: tempDir(), state: null, engine, brainId: () => 'host', addonTarget: () => null });
      expect(out).toEqual({ eligibility: { team_brain: false, preview_target: false }, eligibility_evidence: { state: 'read_failed', code: 'writer_evidence_malformed' } });
    }
  });

  test('a mounted brain is a team brain; an unresolvable brain is never called personal', async () => {
    expect((await buildEligibilityStatus({ dir: tempDir(), state: null, brainId: () => 'team-a', addonTarget: () => null })).eligibility.team_brain).toBe(true);
    expect((await buildEligibilityStatus({ dir: tempDir(), state: null, brainId: () => { throw new Error('bad mounts'); }, addonTarget: () => null })).eligibility.team_brain).toBe(true);
  });

  test('the window binds to the evidence epoch, not to the latest start: a restart does not move it', () => {
    const now = new Date('2026-12-01T12:00:00.000Z');
    const restarted = { ...state('2026-11-30T23:00:00.000Z'), writer_evidence_since: '2026-11-29T00:00:00.000Z' };
    expect(eligibilityWindowStart(restarted, now).toISOString()).toBe(new Date(Date.parse('2026-11-29T00:00:00.000Z') - OBSERVATION_REFRESH_MS).toISOString());
    // The epoch is still capped at 7 days.
    const old = { ...state('2026-11-30T23:00:00.000Z'), writer_evidence_since: '2026-11-01T00:00:00.000Z' };
    expect(eligibilityWindowStart(old, now).toISOString()).toBe(new Date(now.getTime() - ELIGIBILITY_WINDOW_MS - OBSERVATION_REFRESH_MS).toISOString());
  });

  test('window: the later of shadow start and 7 days ago, minus the refresh slack', () => {
    const now = new Date('2026-12-01T12:00:00.000Z');
    expect(eligibilityWindowStart(null, now).toISOString()).toBe(new Date(now.getTime() - ELIGIBILITY_WINDOW_MS - OBSERVATION_REFRESH_MS).toISOString());
    expect(eligibilityWindowStart(state('2026-11-30T00:00:00.000Z'), now).toISOString()).toBe(new Date(Date.parse('2026-11-30T00:00:00.000Z') - OBSERVATION_REFRESH_MS).toISOString());
  });

  test('a host whose last write is inside the slack still counts, and drops out after it', async () => {
    const dir = tempDir();
    observer(dir).note();
    await settle(observers[0]!);
    await primary.executeRaw(`UPDATE engine_writer_observations SET last_seen = now() - interval '7 days' - interval '5 minutes'`);
    expect((await readWriterEvidence(primary, eligibilityWindowStart(null, new Date()), false, WRITER_HOOK_TRIGGER, WRITER_EVIDENCE_TABLES)).hosts).toBe(1);
    await primary.executeRaw(`UPDATE engine_writer_observations SET last_seen = now() - interval '7 days' - interval '11 minutes'`);
    expect((await readWriterEvidence(primary, eligibilityWindowStart(null, new Date()), false, WRITER_HOOK_TRIGGER, WRITER_EVIDENCE_TABLES)).hosts).toBe(0);
  });

  test('preview_target: release targets only; musl, unknown libc and other targets are false', () => {
    expect(isPreviewTarget(detectAddonTarget('linux', 'x64', () => 'glibc'))).toBe(true);
    expect(isPreviewTarget(detectAddonTarget('darwin', 'arm64', () => null))).toBe(true);
    expect(isPreviewTarget(detectAddonTarget('linux', 'x64', () => 'musl'))).toBe(false);
    expect(isPreviewTarget(detectAddonTarget('linux', 'x64', () => null))).toBe(false);
    expect(isPreviewTarget(detectAddonTarget('linux', 'arm64', () => 'glibc'))).toBe(false);
    expect(isPreviewTarget(detectAddonTarget('darwin', 'x64', () => null))).toBe(false);
  });
});

describe('start plan', () => {
  test('declares the observation write and no longer says it never writes the brain database', () => {
    const { plan, hash } = shadowPlan('pglite-test', 'pglite', '/tmp/x', { sampleRate: 0.1, queueBound: 256 });
    expect(plan.writes.some(w => w.includes('engine_writer_observations'))).toBe(true);
    expect(plan.never_writes).not.toContain('the brain database');
    const old = { ...plan, writes: plan.writes.filter(w => !w.includes('engine_writer_observations')), never_writes: ['the brain database', 'the brain config table', 'the brain repo'] };
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    expect(createHash('sha256').update(JSON.stringify(old)).digest('hex').slice(0, 16)).not.toBe(hash);
  });
});

describe('status --json', () => {
  test('never opens the database: it exits 0 with team_brain and preview_target and no writer fields', async () => {
    const home = tempDir();
    const out: string[] = [];
    await withEnv({ GBRAIN_HOME: home }, async () => {
      // The brain file does not exist: a status that tried to open it would fail.
      const config = { engine: 'pglite' as const, database_path: join(home, 'missing', 'brain.pglite') };
      const dir = shadowDirFor(shadowBrainKey(config)!);
      mkdirSync(dir, { recursive: true });
      writeShadowState(dir, state('2026-11-20T00:00:00.000Z'));
      expect(await runEngineShadow(['status', '--json'], { config: () => config, out: (l) => out.push(l) })).toBe(0);
    });
    const doc = JSON.parse(out.join('\n')) as { eligibility: Record<string, unknown>; eligibility_evidence?: unknown };
    expect(Object.keys(doc.eligibility).sort()).toEqual(['preview_target', 'team_brain']);
    expect(doc.eligibility_evidence).toBeUndefined();
  });
});
