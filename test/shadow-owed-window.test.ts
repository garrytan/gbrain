/**
 * OWC: the owed record's flush window (supervisor.ts `OWED_WINDOW_MS`): an open marker (`v: 2`, `open_until`) on the first sample, ONE full record (`v: 1`) at the close; a crash inside a window is a named, visible loss
 * (`write_window_lost`), never read as measured. Real supervisors over fake workers; the combined-tree schedule with S2d's keeper is gates/combined/owc-combined.test.ts of the plan directory.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { spawn as spawnChild, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFollowStatus } from '../src/shadow/follow-status.ts';
import { runShadowChild } from '../src/shadow/child.ts';
import { encodeArgs } from '../src/shadow/codec.ts';
import { ensureEpoch, readEpoch } from '../src/shadow/evidence-epoch.ts';
import { writeSeedRecord } from '../src/shadow/seed.ts';
import { withEnv } from './helpers/with-env.ts';
import { closeAllOwedAtExit, OWED_WINDOW_MS, OWED_WINDOW_SAMPLES, ShadowSupervisor } from '../src/shadow/supervisor.ts';
import { evaluateReadiness, type ShadowStatus } from '../src/core/engine-swap/readiness.ts';
import { carriesKnownLoss, owedPath, readOwed, readWriteTally, WINDOW_LOST_REASON, writeOwed, writeTallyPath, WriteTally, type OwedRecord } from '../src/shadow/write-compare.ts';
import { tallyOn } from './helpers/shadow-write-compare-scenarios.ts';

const NOW = new Date('2026-12-01T00:00:00Z');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'gbrain-owed-window-')); dirs.push(d); return d; };

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const gone = async (...pids: number[]): Promise<void> => { const until = Date.now() + 10_000; while (pids.some(alive) && Date.now() < until) await new Promise((r) => setTimeout(r, 10)); };
const SUPERVISOR = join(import.meta.dir, '..', 'src', 'shadow', 'supervisor.ts');
/** A serving process of its own: the real supervisor with a window of one minute, a `sleep` for a worker, 5 samples sent, then it waits to be killed. Resolves with its pid and the worker's. */
async function servingProcess(dir: string, windowMs: number): Promise<{ pid: number; workerPid: number; kill: () => Promise<void>; killServing: () => Promise<void>; killWorker: () => Promise<void> }> {
  const script = `import { spawn } from 'node:child_process'; import { ShadowSupervisor } from ${JSON.stringify(SUPERVISOR)};
    const dir = process.env.OWC_DIR; let worker;
    const sup = new ShadowSupervisor({ dir, argv: ['x'], recordFault() {}, stillEnabled: () => true, maxBufferedBytes: 1_000_000, owedWindowMs: Number(process.env.OWC_WINDOW_MS),
      spawn: () => (worker = spawn('sleep', ['60'], { stdio: ['pipe', 'pipe', 'ignore'] })) });
    for (let i = 0; i < 5; i++) if (!sup.send('{"t":"write","op":"putPage","i":' + i + '}\\n')) throw new Error('refused');
    setImmediate(() => setImmediate(() => { console.log('READY ' + worker.pid); setInterval(() => {}, 1000); }));`;
  const child = spawnChild(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, OWC_DIR: dir, OWC_WINDOW_MS: String(windowMs) } });
  const workerPid = await new Promise<number>((resolve, reject) => { let out = ''; child.stdout!.on('data', (d: Buffer) => { out += d; const m = /READY (\d+)/.exec(out); if (m) resolve(Number(m[1])); }); child.on('exit', () => reject(new Error(`the serving process exited early: ${out}`))); });
  return { pid: child.pid!, workerPid, killServing: async () => { process.kill(child.pid!, 'SIGKILL'); await gone(child.pid!); }, killWorker: async () => { try { process.kill(workerPid, 'SIGKILL'); } catch { /* gone */ } await gone(workerPid); }, kill: async () => { try { process.kill(child.pid!, 'SIGKILL'); } catch { /* gone */ } try { process.kill(workerPid, 'SIGKILL'); } catch { /* gone */ } await gone(child.pid!, workerPid); } };
}


// ---- OWC: the owed record is written twice per window (an open marker, then the full record); a crash inside a window is a named, visible loss ----
describe('OWC: a window of owed samples (design C: open marker, full record at close)', () => {
  const STATE = { sample_rate: 0.1 } as never;
  const stat = (dir: string) => buildFollowStatus(dir, STATE, NOW).write_comparisons;
  const passing = (dir: string, epoch: string): void => writeFileSync(writeTallyPath(dir), JSON.stringify({ version: 1, epoch_id: epoch, updated_at: '', comparable: 1000, unexplained_difference: 0, uncomparable: 0, capability_missing: 0, capability_missing_by_family: {}, uncomparable_by_reason: {}, in_flight: [] }) + '\n');
  const line = (i: number): string => `{"t":"write","op":"putPage","i":${i}}\n`;
  test('kill -9 inside a window: after the orphan pass the session is booked as a named loss (write_window_lost, once), status reads not measured with the count, and the write bar (comparable, unexplained) is untouched', async () => {
    const dir = tmp(); const { epoch } = tallyOn(dir); passing(dir, epoch);
    expect(stat(dir)).toMatchObject({ state: 'measured', comparable: 1000 });
    const serving = await servingProcess(dir, 60_000); await serving.kill(); // a hard kill with the window open: no exit hook ran
    expect(stat(dir)).toMatchObject({ state: 'capability_missing' }); // before the pass: unsettled (owed above settled), never measured
    const owner = new WriteTally(dir, () => epoch, () => true, process.pid); owner.recover(); owner.save();
    expect(readWriteTally(dir, epoch)!.uncomparable_by_reason).toEqual({ write_window_lost: 1 }); // was receipt_orphaned: 5 (samples the window held are booked under the old, silent-count reason)
    expect(stat(dir)).toMatchObject({ state: 'capability_missing', comparable: 1000, unexplained_difference: 0, write_windows_lost: 1 }); // not measured for the rest of the epoch; was measured
    const files = readdirSync(dir).filter((n) => n.startsWith('write-owed.')); expect(files).toHaveLength(1); // settled, and kept: a v:2 tombstone naming this epoch (an older reader cannot read it, so it keeps reading the epoch as unresolved)
    expect(parseTomb(dir, files[0]!)).toMatchObject({ v: 2, booked_epoch: epoch });
    const again = new WriteTally(dir, () => epoch, () => true, process.pid); again.recover(); again.save();
    expect(readWriteTally(dir, epoch)!.uncomparable_by_reason).toEqual({ write_window_lost: 1 }); // once
  }, 60_000);

  test('status during an open window reads unsettled, never measured: from the moment send() returns, through the close, until the worker has settled everything', async () => {
    const dir = tmp(); const { epoch } = tallyOn(dir); passing(dir, epoch);
    let worker: ReturnType<typeof spawnChild> | undefined;
    const sup = new ShadowSupervisor({ dir, argv: ['x'], recordFault: () => {}, stillEnabled: () => true, maxBufferedBytes: 1_000_000, owedWindowMs: 60_000, spawn: (() => (worker = spawnChild('sleep', ['60'], { stdio: ['pipe', 'pipe', 'ignore'] }))) as never } as never);
    try {
      expect(stat(dir)).toMatchObject({ state: 'measured' });
      expect(sup.send(line(0))).toBe(true); expect(sup.send(line(1))).toBe(true); expect(sup.send(line(2))).toBe(true);
      expect(stat(dir)).toMatchObject({ state: 'capability_missing', unresolved_replays: 1 }); // before any turn: the open marker is already durable (was measured: nothing was on disk until the next turn)
      expect(stat(dir).outstanding_sessions).toHaveLength(1);
      await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
      expect(stat(dir)).toMatchObject({ state: 'capability_missing', unresolved_replays: 1 }); // still open: nothing has been sent
      sup.closeOwed(); // the window closes: the full record, then the lines
      const key = readdirSync(dir).flatMap((n) => /^write-owed\.(.+)\.json$/.exec(n)?.[1] ?? [])[0]!;
      expect(readOwed(dir, key)).toMatchObject({ owed: 3, closed: true });
      expect(stat(dir)).toMatchObject({ state: 'capability_missing', unresolved_replays: 1 }); // closed, but the worker has settled none of the 3
      const w = new WriteTally(dir, () => epoch, () => true, process.pid, key); w.note('comparable', undefined, 3, false, 3); w.save();
      expect(stat(dir)).toMatchObject({ state: 'measured' }); // settled: measured again, no window was lost
      expect(stat(dir).write_windows_lost).toBeUndefined();
    } finally { sup.stop(); try { worker?.kill('SIGKILL'); } catch { /* gone */ } }
  }, 60_000);
});

// ---- the supervisor's window, on a fake worker whose pipe takes every line at once ----
class Pipe extends EventEmitter {
  writes: string[] = []; ended = false; pid: number; onWrite?: () => void;
  constructor(pid: number) { super(); this.pid = pid; }
  stdin = Object.assign(new EventEmitter(), {
    writable: true, destroyed: false, writableLength: 0, unref() {},
    write: (line: string, cb?: (error?: Error | null) => void): boolean => { this.onWrite?.(); this.writes.push(line); cb?.(null); return true; },
    end: (): void => { this.ended = true; queueMicrotask(() => this.stdin.emit('finish')); },
  });
  stdout = Object.assign(new PassThrough(), { unref() {} });
  unref(): void {}
  kill(): boolean { return true; }
}
const sample = (i: number): string => `{"t":"write","op":"putPage","i":${i}}\n`;
const turn = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
const deadPid = (): number => spawnSync(process.execPath, ['-e', '0']).pid!;
const STATE = { sample_rate: 0.1 } as never;
const stat = (dir: string) => buildFollowStatus(dir, STATE, NOW).write_comparisons;
const passing = (dir: string, epoch: string, extra: Record<string, unknown> = {}): void => writeFileSync(writeTallyPath(dir), JSON.stringify({ version: 1, epoch_id: epoch, updated_at: '', comparable: 1000, unexplained_difference: 0, uncomparable: 0, capability_missing: 0, capability_missing_by_family: {}, uncomparable_by_reason: {}, in_flight: [], ...extra }) + '\n');

/** A supervisor over fake workers (each a `Pipe` with a dead pid, so an owner pass finds its session orphaned), `fault` makes every record write fail ('after-rename': the record is visible, its flush throws). */
function rig(overrides: Record<string, unknown> = {}) {
  const dir = tmp(); const { epoch } = tallyOn(dir); passing(dir, epoch);
  const children: Pipe[] = []; const sessions: string[] = []; const written: OwedRecord[] = [];
  const state = { fault: null as null | 'before-rename' | 'after-rename', onRecord: undefined as undefined | ((rec: OwedRecord) => void) };
  const dead = deadPid();
  const sup = new ShadowSupervisor({
    dir, argv: ['x'], recordFault() {}, stillEnabled: () => true, maxBufferedBytes: 1_000_000, retryMs: 10, minBackoffMs: 0, owedWindowMs: 60_000,
    spawn: ((_c: string, _a: string[], options: { env: Record<string, string> }) => { const c = new Pipe(dead); c.onWrite = () => state.onRecord?.({ marker: 'line' } as never); children.push(c); sessions.push(options.env.GBRAIN_SHADOW_SESSION!); return c; }) as never,
    writeOwed: (d: string, rec: OwedRecord) => {
      if (state.fault === 'before-rename') throw new Error('EIO');
      writeOwed(d, rec); written.push(rec); state.onRecord?.(rec);
      if (state.fault === 'after-rename') throw new Error('EIO: the directory flush failed after the rename');
    },
    ...overrides,
  } as never);
  const internals = sup as unknown as { windowOpen: boolean; closing: boolean; windowTimer: { hasRef(): boolean } | null; flushStaged(): boolean };
  return { dir, epoch, sup, children, sessions, written, state, dead, internals, owed: (i = 0) => readOwed(dir, sessions[i]!), done: () => sup.stop() };
}
const parseTomb = (dir: string, name: string): unknown => JSON.parse(readFileSync(join(dir, name), 'utf8'));
const ownerPass = (dir: string, epoch: string): Record<string, number> => { const o = new WriteTally(dir, () => epoch, () => true, process.pid); o.recover(); o.save(); return readWriteTally(dir, epoch)!.uncomparable_by_reason; };

describe('OWC: the window on the supervisor', () => {
  test('the first plain sample writes the open marker (v:2, open_until, owed = accepted + 1) before it is accepted; the samples wait; the timer closes the window with ONE full record (v:1, no open_until), then the lines go out in order', async () => {
    const r = rig({ owedWindowMs: 40 });
    try {
      expect(r.sup.send(sample(0))).toBe(true); expect(r.sup.send(sample(1))).toBe(true); expect(r.sup.send('{"t":"read","n":1}\n')).toBe(true); expect(r.sup.send(sample(2))).toBe(true);
      expect(r.written).toHaveLength(1);
      expect(r.owed()).toMatchObject({ v: 2, owed: 1, closed: false, child_exited: false }); expect(typeof (r.owed() as OwedRecord).open_until).toBe('number');
      expect(r.children[0]!.writes).toEqual([]); // nothing is sent while the window is open: the record owes it first, and a line that is no sample waits behind the samples (order holds)
      await sleep(120);
      expect(r.written).toHaveLength(2);
      expect(r.owed()).toEqual({ v: 1, session: r.sessions[0]!, serving_pid: process.pid, child_pid: r.dead, owed: 3, closed: false, child_exited: false }); // no open_until: the close is the full record
      expect(r.children[0]!.writes).toEqual([sample(0), sample(1), '{"t":"read","n":1}\n', sample(2)]);
      expect(r.internals.windowOpen).toBe(false); expect(r.internals.windowTimer).toBeNull();
    } finally { r.done(); }
  });

  test('the window closes at OWED_WINDOW_SAMPLES samples at once (in the next turn); one sample fewer leaves it open', async () => {
    const r = rig();
    try {
      for (let i = 0; i < OWED_WINDOW_SAMPLES - 1; i++) expect(r.sup.send(sample(i))).toBe(true);
      await turn(); await turn();
      expect(r.owed()).toMatchObject({ v: 2 }); expect(r.children[0]!.writes).toHaveLength(0);
      expect(r.sup.send(sample(OWED_WINDOW_SAMPLES))).toBe(true);
      await turn(); await turn();
      expect(r.owed()).toMatchObject({ v: 1, owed: OWED_WINDOW_SAMPLES, closed: false }); expect(r.children[0]!.writes).toHaveLength(OWED_WINDOW_SAMPLES);
    } finally { r.done(); }
  });

  test('the window timer never keeps the process alive (unref\'d)', () => {
    const r = rig();
    try { r.sup.send(sample(0)); expect(r.internals.windowTimer).not.toBeNull(); expect(r.internals.windowTimer!.hasRef()).toBe(false); } finally { r.done(); }
  });

  test('with no window (owedWindowMs 0) every turn writes its own full record and no marker, as before', async () => {
    const r = rig({ owedWindowMs: 0 });
    try { r.sup.send(sample(0)); expect(r.written).toHaveLength(0); await turn(); expect(r.written.map((w) => w.v)).toEqual([1]); r.sup.send(sample(1)); await turn(); expect(r.written.map((w) => w.owed)).toEqual([1, 2]); } finally { r.done(); }
  });

  test('the production window is OWED_WINDOW_MS (100 ms): the marker names the moment the window ends', () => {
    expect(OWED_WINDOW_MS).toBe(100);
    const dir = tmp(); const sessions: string[] = [];
    const sup = new ShadowSupervisor({ dir, argv: ['x'], recordFault() {}, stillEnabled: () => true, now: () => 5_000, spawn: ((_c: string, _a: string[], o: { env: Record<string, string> }) => { sessions.push(o.env.GBRAIN_SHADOW_SESSION!); return new Pipe(deadPid()); }) as never } as never);
    try { expect(sup.send(sample(0))).toBe(true); expect(readOwed(dir, sessions[0]!)).toMatchObject({ v: 2, open_until: 5_100 }); } finally { sup.stop(); }
  });

  test('a marker that cannot be made durable refuses the sample (nothing accepted, nothing sent); a marker that was written and then threw is replaced by the closing record, never left standing', async () => {
    const r = rig();
    try {
      r.state.fault = 'before-rename'; expect(r.sup.send(sample(0))).toBe(false); expect(r.children[0]!.writes).toEqual([]); expect(r.owed()).toBeNull();
      r.state.fault = 'after-rename'; expect(r.sup.send(sample(0))).toBe(false); // the marker is on disk (the flush after the rename threw)
      expect(r.owed()).toMatchObject({ v: 2, owed: 1 });
      r.state.fault = null; r.sup.closeOwed(); // stop, drain and the exit hook all close: the stray marker is replaced, so a crash cannot read it as a lost window
      expect(r.owed()).toMatchObject({ v: 1, owed: 0, closed: true });
      expect(ownerPass(r.dir, r.epoch)).toEqual({}); // nothing owed, nothing lost
    } finally { r.done(); }
  });
});

describe('OWC ship-p1 R2: a first marker that was renamed and then threw is replaced without waiting for another sample or a shutdown', () => {
  test('the worker exits after the disk recovers: the exit-time record replaces the marker (v:1, nothing owed), so the next owner books no window and status stays measured', () => {
    const r = rig();
    try {
      r.state.fault = 'after-rename'; expect(r.sup.send(sample(0))).toBe(false);
      expect(r.owed()).toMatchObject({ v: 2, owed: 1 });
      r.state.fault = null; r.children[0]!.emit('exit', 1, null);
      expect(r.owed()).toMatchObject({ v: 1, owed: 0, child_exited: true });
      expect(ownerPass(r.dir, r.epoch)).toEqual({}); expect(stat(r.dir).state).toBe('measured');
    } finally { r.done(); }
  });

  test('a quiet process (no further sample, no exit, no stop): the retry timer replaces the marker by itself, and keeps trying while the disk keeps failing', async () => {
    const r = rig();
    try {
      r.state.fault = 'after-rename'; expect(r.sup.send(sample(0))).toBe(false);
      r.state.fault = 'before-rename'; await sleep(60); expect(r.owed()).toMatchObject({ v: 2 }); // the disk still fails: the marker stands, the retry goes on
      r.state.fault = null; await sleep(60);
      expect(r.owed()).toMatchObject({ v: 1, owed: 0 }); expect(r.internals.windowOpen).toBe(false);
      expect(ownerPass(r.dir, r.epoch)).toEqual({}); expect(stat(r.dir).state).toBe('measured');
    } finally { r.done(); }
  });

  test('R3: the second window\'s marker renamed and then threw, after a window closed normally: the repair replaces it (the cached close record must not stand in for it)', async () => {
    const r = rig({ owedWindowMs: 20 });
    try {
      expect(r.sup.send(sample(0))).toBe(true); await sleep(80); expect(r.owed()).toMatchObject({ v: 1, owed: 1 }); // a window closed: its record is cached as written
      r.state.fault = 'after-rename'; expect(r.sup.send(sample(1))).toBe(false); expect(r.owed()).toMatchObject({ v: 2, owed: 2 });
      r.state.fault = null; await sleep(80);
      expect(r.owed()).toMatchObject({ v: 1, owed: 1 }); // was still v:2 owing 2: the repair wrote nothing and cleared its own flag
      expect(ownerPass(r.dir, r.epoch)[WINDOW_LOST_REASON]).toBeUndefined(); // no phantom window
    } finally { r.done(); }
  });

  // The lesson of R3: a repair path must not trust what an EARLIER window left in the cache. Each path again, after a window that closed normally (its record cached as written), with the next marker renamed and then thrown.
  const afterNormalWindow = async (r: ReturnType<typeof rig>): Promise<void> => {
    expect(r.sup.send(sample(0))).toBe(true); await sleep(80); expect(r.owed()).toMatchObject({ v: 1, owed: 1 });
    r.state.fault = 'after-rename'; expect(r.sup.send(sample(1))).toBe(false); expect(r.owed()).toMatchObject({ v: 2, owed: 2 });
  };
  test('R3 lesson: after a normal window, the worker exits once the disk recovers: the exit-time record replaces the stray marker, and nothing is booked as a lost window', async () => {
    const r = rig({ owedWindowMs: 20 });
    try {
      await afterNormalWindow(r); r.state.fault = null; r.children[0]!.emit('exit', 1, null);
      expect(r.owed()).toMatchObject({ v: 1, owed: 1, child_exited: true });
      expect(ownerPass(r.dir, r.epoch)[WINDOW_LOST_REASON]).toBeUndefined();
    } finally { r.done(); }
  });
  test('R3 lesson: after a normal window, stop/drain/exit-hook (closeOwed) replaces the stray marker with the close record of what was accepted', async () => {
    const r = rig({ owedWindowMs: 20 });
    try {
      await afterNormalWindow(r); r.state.fault = null; r.sup.closeOwed();
      expect(r.owed()).toMatchObject({ v: 1, owed: 1, closed: true });
      expect(ownerPass(r.dir, r.epoch)[WINDOW_LOST_REASON]).toBeUndefined();
    } finally { r.done(); }
  });
  test('R3 lesson: after a normal window, a pending retry (the disk failing for a while) still replaces the stray marker when the disk recovers', async () => {
    const r = rig({ owedWindowMs: 20 });
    try {
      await afterNormalWindow(r); r.state.fault = 'before-rename'; await sleep(60); expect(r.owed()).toMatchObject({ v: 2, owed: 2 });
      r.state.fault = null; await sleep(60);
      expect(r.owed()).toMatchObject({ v: 1, owed: 1 }); expect(ownerPass(r.dir, r.epoch)[WINDOW_LOST_REASON]).toBeUndefined();
    } finally { r.done(); }
  });
  test('R3 lesson: after a normal window, the next sample opens a fresh marker over the stray one and the window closes with exactly what was accepted', async () => {
    const r = rig({ owedWindowMs: 20 });
    try {
      await afterNormalWindow(r); r.state.fault = null;
      expect(r.sup.send(sample(2))).toBe(true); expect(r.owed()).toMatchObject({ v: 2, owed: 2 }); await sleep(80);
      expect(r.owed()).toMatchObject({ v: 1, owed: 2 }); expect(r.children[0]!.writes).toEqual([sample(0), sample(2)]);
    } finally { r.done(); }
  });
  test('R3 lesson: after a normal window, a close record that renamed and then threw (a half-finished save) owes exactly what was accepted; the retry no-ops on it, and a kill books that, not a window', async () => {
    const r = rig({ owedWindowMs: 20 });
    try {
      expect(r.sup.send(sample(0))).toBe(true); await sleep(80); expect(r.owed()).toMatchObject({ v: 1, owed: 1 });
      expect(r.sup.send(sample(1))).toBe(true); r.state.fault = 'after-rename'; await sleep(60);
      expect(r.owed()).toMatchObject({ v: 1, owed: 2 }); expect(r.children[0]!.writes).toEqual([sample(0)]); // the close is in doubt: the second sample was not sent
      cpSync(r.dir, r.dir + '-killed', { recursive: true }); dirs.push(r.dir + '-killed');
      recoveredExactlyOrHeld(r.dir + '-killed', r.epoch, 2); expect(ownerPass(r.dir + '-killed', r.epoch)[WINDOW_LOST_REASON]).toBeUndefined();
      r.state.fault = null; await sleep(60); expect(r.children[0]!.writes).toEqual([sample(0), sample(1)]);
    } finally { r.done(); }
  });
  test('the exit-time write fails as well: nothing is hidden, the marker stands and reads as the one lost window (fail closed), never as measured', () => {
    const r = rig();
    try {
      r.state.fault = 'after-rename'; expect(r.sup.send(sample(0))).toBe(false);
      r.state.fault = 'before-rename'; r.children[0]!.emit('exit', 1, null); // the exit-time record cannot be written: the marker stands
      expect(r.owed()).toMatchObject({ v: 2 });
      expect(stat(r.dir).state).not.toBe('measured');
    } finally { r.done(); }
  });
});

describe('OWC: a crash at each step of a window books exactly what it should', () => {
  test('killed after the marker: one window (unknown size); after the close record, before its lines: exactly the accepted count, as orphaned; after the lines: the same (the child settles what it read, the rest is booked once)', () => {
    const r = rig(); const snaps: Array<{ at: string; dir: string }> = [];
    const snap = (at: string): void => { const d = tmp(); cpSync(r.dir, d, { recursive: true, filter: (s) => !s.endsWith('.lock') }); snaps.push({ at, dir: d }); };
    r.state.onRecord = (rec) => { if ((rec as { marker?: string }).marker === 'line') { if (!snaps.some((s) => s.at === 'first line')) snap('first line'); } else snap(rec.v === 2 ? 'marker' : 'close'); };
    try {
      r.sup.send(sample(0)); r.sup.send(sample(1)); r.sup.send(sample(2)); r.sup.closeOwed();
      expect(snaps.map((s) => s.at)).toEqual(['marker', 'close', 'first line']);
      const expected: Record<string, Record<string, number>> = { marker: { [WINDOW_LOST_REASON]: 1 }, close: { receipt_orphaned: 3 }, 'first line': { receipt_orphaned: 3 } };
      for (const s of snaps) expect({ at: s.at, booked: ownerPass(s.dir, r.epoch) }).toEqual({ at: s.at, booked: expected[s.at]! });
    } finally { r.done(); }
  });
});

describe('OWC: what closes a window at once (nothing waits for the timer)', () => {
  const lines = {
    readback_failed: '{"t":"write","op":"putPage","outcome":"uncomparable","reason":"readback_failed"}\n',
    primary_write_failed: '{"t":"write","op":"deletePage","outcome":"uncomparable","reason":"primary_write_failed"}\n',
    preimage_timeout: '{"t":"write","op":"putPage","outcome":"uncomparable","reason":"preimage_timeout"}\n',
    dropped: '{"t":"write","op":"putPage","i":9,"dropped":3}\n',
  };
  for (const [name, line] of Object.entries(lines)) {
    test(`a known loss (${name}) is never held in a window: the next turn writes the full record that owes it and sends the lines`, async () => {
      expect(carriesKnownLoss(line)).toBe(true);
      const r = rig();
      try {
        r.sup.send(sample(0)); expect(r.owed()).toMatchObject({ v: 2 });
        expect(r.sup.send(line)).toBe(true);
        await turn(); await turn();
        expect(r.owed()).toMatchObject({ v: 1, owed: name === 'dropped' ? 5 : 2, closed: false }); expect(r.children[0]!.writes).toEqual([sample(0), line]);
      } finally { r.done(); }
    });
  }
  test('a plain sample is not a known loss, whatever its page content says', () => {
    expect(carriesKnownLoss('{"t":"write","op":"putPage","args":["x"],"body":"\\"outcome\\":\\"uncomparable\\""}\n')).toBe(false);
    expect(carriesKnownLoss(sample(1))).toBe(false);
    expect(carriesKnownLoss('{"t":"write","op":"addTag","outcome":"capability_missing","family":"tags"}\n')).toBe(false);
  });

  test('owe() (samples with no line behind them) is written in the next turn like a known loss: the window closes', async () => {
    const r = rig();
    try { r.sup.send(sample(0)); expect(r.sup.owe(2)).toBe(true); await turn(); await turn(); expect(r.owed()).toMatchObject({ v: 1, owed: 3 }); expect(r.children[0]!.writes).toEqual([sample(0)]); } finally { r.done(); }
  });

  test('drain() sends what the window holds before it waits (the lines can then drain), and the record that covers them is the full one', async () => {
    const r = rig();
    try {
      r.sup.send(sample(0)); r.sup.send(sample(1)); r.sup.send(sample(2));
      const done = r.sup.drain(50);
      expect(r.children[0]!.writes).toEqual([sample(0), sample(1), sample(2)]); // synchronously: not after the window
      expect(r.owed()).toMatchObject({ v: 1, owed: 3 });
      await done;
    } finally { r.done(); }
  });

  test('stop() closes the record of an open window with everything accepted (closed: true, v:1) before the input ends', () => {
    const r = rig();
    try { r.sup.send(sample(0)); r.sup.send(sample(1)); r.sup.stop(); expect(r.owed()).toMatchObject({ v: 1, owed: 2, closed: true }); expect(r.children[0]!.writes).toHaveLength(2); } finally { r.done(); }
  });

  test('the process-exit hook (closeAllOwedAtExit) closes an open window synchronously', () => {
    const r = rig();
    try { r.sup.send(sample(0)); r.sup.send(sample(1)); expect(r.owed()).toMatchObject({ v: 2 }); closeAllOwedAtExit(); expect(r.owed()).toMatchObject({ v: 1, owed: 2, closed: true }); } finally { r.done(); }
  });

  test('a worker that exits with samples staged: the exit-time record states them (v:1, child_exited), the window and its timer are gone, and the next session opens its own marker', async () => {
    const r = rig({ owedWindowMs: 40 });
    try {
      r.sup.send(sample(0)); r.sup.send(sample(1));
      r.children[0]!.emit('exit', 1, null);
      expect(r.owed()).toMatchObject({ v: 1, owed: 2, child_exited: true }); expect(r.internals.windowOpen).toBe(false); expect(r.internals.windowTimer).toBeNull();
      await sleep(20);
      expect(r.sup.send(sample(2))).toBe(true); // a new worker, a new session
      expect(r.sessions).toHaveLength(2); expect(r.owed(1)).toMatchObject({ v: 2, owed: 1 }); // its own marker (the stale window did not stand in for it)
      await sleep(100);
      expect(r.owed(1)).toMatchObject({ v: 1, owed: 1 }); expect(r.children[1]!.writes).toEqual([sample(2)]);
    } finally { r.done(); }
  });

  test('a close write that fails keeps the lines and the window; the retry closes it, and the lines are sent only after the record that owes them', async () => {
    const r = rig({ owedWindowMs: 30 });
    try {
      r.sup.send(sample(0)); r.sup.send(sample(1));
      r.state.fault = 'before-rename'; await sleep(60);
      expect(r.children[0]!.writes).toEqual([]); expect(r.owed()).toMatchObject({ v: 2 });
      r.state.fault = null; await sleep(60);
      expect(r.owed()).toMatchObject({ v: 1, owed: 2 }); expect(r.children[0]!.writes).toHaveLength(2);
    } finally { r.done(); }
  });
});

/** A recovery pass after a kill: with no S2d keeper marker it books exactly `n` (`receipt_orphaned`); once S2d is merged a session whose record is kept for retry has a `write-pending.*` marker, which is the serving process's to publish, so the pass books nothing, the marker stands and status reads no evidence. Both are fail-closed: never fewer than `n` booked and read as measured. */
function recoveredExactlyOrHeld(dir: string, epoch: string, n: number): void {
  const marked = readdirSync(dir).some((f) => f.startsWith('write-pending.'));
  const booked = ownerPass(dir, epoch);
  if (marked) { expect(booked).toEqual({}); expect(stat(dir).state).not.toBe('measured'); } else expect(booked).toEqual({ receipt_orphaned: n });
}
describe('OWC F1: no sample is accepted while a close is in doubt', () => {
  test('(a) the close renames its record and the directory flush fails: a further sample, and a loss-carrying line, are refused; the record owes exactly what was accepted; status stays unsettled; a kill and recovery book exactly that', async () => {
    const r = rig();
    try {
      r.sup.send(sample(0)); r.sup.send(sample(1)); r.sup.send(sample(2));
      r.state.fault = 'after-rename'; expect(r.internals.flushStaged()).toBe(false); expect(r.internals.closing).toBe(true);
      expect(r.owed()).toMatchObject({ v: 1, owed: 3 }); // visible, but nobody knows it
      expect(r.sup.send(sample(3))).toBe(false); expect(r.sup.send('{"t":"write","op":"putPage","i":4,"dropped":2}\n')).toBe(false); // refused: the caller counts them send_shed
      expect(r.owed()).toMatchObject({ v: 1, owed: 3 }); // the count is fixed
      expect(r.children[0]!.writes).toEqual([]);
      expect(stat(r.dir)).toMatchObject({ state: 'capability_missing' });
      cpSync(r.dir, r.dir + '-killed', { recursive: true }); dirs.push(r.dir + '-killed'); // the serving process is killed here
      recoveredExactlyOrHeld(r.dir + '-killed', r.epoch, 3); // exactly what was accepted, none of the refused
      r.state.fault = null; await sleep(60); // the disk recovers: the retry closes, the lines go out
      expect(r.children[0]!.writes).toEqual([sample(0), sample(1), sample(2)]); expect(r.internals.closing).toBe(false);
      expect(r.sup.send(sample(5))).toBe(true); // accepted again
    } finally { r.done(); }
  });

  test('owe() while the close is in doubt returns true and publishes the larger count with the close (it is never held apart): the first record that can state it does', async () => {
    const r = rig();
    try {
      r.sup.send(sample(0)); r.sup.send(sample(1)); r.sup.send(sample(2));
      r.state.fault = 'before-rename'; expect(r.internals.flushStaged()).toBe(false);
      expect(r.sup.owe(1)).toBe(true);
      r.state.fault = null; await sleep(60);
      expect(r.owed()).toMatchObject({ owed: 4 }); expect(r.children[0]!.writes).toHaveLength(3); // the record said 4 before the first of the three lines
    } finally { r.done(); }
  });

  test('a worker that exits while the close is in doubt: the exit-time record states everything accepted, including what owe() added', () => {
    const r = rig();
    try {
      r.sup.send(sample(0)); r.sup.send(sample(1)); r.sup.send(sample(2));
      r.state.fault = 'before-rename'; r.internals.flushStaged(); r.sup.owe(1); r.state.fault = null;
      r.children[0]!.emit('exit', 1, null);
      expect(r.owed()).toMatchObject({ owed: 4, child_exited: true });
      recoveredExactlyOrHeld(r.dir, r.epoch, 4);
    } finally { r.done(); }
  });
});

/** The reader of commit 692d2614c9, frozen: the parser of an owed record (it knows `v: 1` only) and the owner pass that books what it can read (an unreadable record is skipped, never booked or removed). */
const MAX_OWED_OLD = 1_000_000_000_000;
function oldParseOwed(path: string): OwedRecord | null | 'unreadable' {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'unreadable'; }
  try {
    const f = JSON.parse(text) as Partial<OwedRecord>;
    if (f?.v !== 1 || typeof f.session !== 'string' || !Number.isSafeInteger(f.owed) || f.owed! < 0 || f.owed! > MAX_OWED_OLD || !Number.isSafeInteger(f.serving_pid) || typeof f.closed !== 'boolean' || typeof f.child_exited !== 'boolean' || (f.child_pid !== undefined && !Number.isSafeInteger(f.child_pid))) return 'unreadable';
    return { v: 1, session: f.session, serving_pid: f.serving_pid!, ...(f.child_pid !== undefined ? { child_pid: f.child_pid } : {}), owed: f.owed!, closed: f.closed, child_exited: f.child_exited };
  } catch { return 'unreadable'; }
}
/** What the old owner pass does with one file: nothing for a record it cannot read; for a readable one, the count it would book. */
const oldBooks = (dir: string, key: string): number | 'skips' => { const rec = oldParseOwed(owedPath(dir, key)); return rec === null || rec === 'unreadable' ? 'skips' : rec.owed; };

describe('OWC F2: the marker is v:2 and the close record is v:1, so every older reader fails closed', () => {
  const raw = (dir: string, key: string, over: Record<string, unknown>): void => writeFileSync(owedPath(dir, key), JSON.stringify({ v: 1, session: key, serving_pid: 1, owed: 1, closed: false, child_exited: false, ...over }));
  test('the parser takes both versions and rejects a marker without open_until, a v:1 record with one, and an open_until that is not a non-negative integer', () => {
    const dir = tmp();
    raw(dir, 'a', { v: 1 }); expect(readOwed(dir, 'a')).toMatchObject({ v: 1 });
    raw(dir, 'b', { v: 2, open_until: 5 }); expect(readOwed(dir, 'b')).toMatchObject({ v: 2, open_until: 5 });
    raw(dir, 'c', { v: 2 }); expect(readOwed(dir, 'c')).toBe('unreadable');
    raw(dir, 'd', { v: 1, open_until: 5 }); expect(readOwed(dir, 'd')).toBe('unreadable');
    raw(dir, 'e', { v: 2, open_until: -1 }); expect(readOwed(dir, 'e')).toBe('unreadable');
    raw(dir, 'f', { v: 2, open_until: 1.5 }); expect(readOwed(dir, 'f')).toBe('unreadable');
    raw(dir, 'g', { v: 3 }); expect(readOwed(dir, 'g')).toBe('unreadable');
  });

  test('the frozen 692d2614c9 reader cannot read the marker the real supervisor writes (it skips it: books nothing, removes nothing) and reads the close record exactly as before', async () => {
    const r = rig({ owedWindowMs: 40 });
    try {
      r.sup.send(sample(0)); r.sup.send(sample(1));
      expect(readOwed(r.dir, r.sessions[0]!)).toMatchObject({ v: 2 }); expect(oldBooks(r.dir, r.sessions[0]!)).toBe('skips');
      await sleep(100);
      expect(oldBooks(r.dir, r.sessions[0]!)).toBe(2); expect(oldParseOwed(owedPath(r.dir, r.sessions[0]!))).toEqual(readOwed(r.dir, r.sessions[0]!) as OwedRecord);
    } finally { r.done(); }
  });

  test('an old owner already running when a newer serving process opens a window and dies: the old pass books nothing and removes nothing; the new pass then books the one window', async () => {
    const dir = tmp(); const { epoch } = tallyOn(dir); passing(dir, epoch);
    const serving = await servingProcess(dir, 60_000); await serving.kill();
    const key = readdirSync(dir).flatMap((n) => /^write-owed\.(.+)\.json$/.exec(n)?.[1] ?? [])[0]!;
    expect(oldBooks(dir, key)).toBe('skips'); expect(readOwed(dir, key)).toMatchObject({ v: 2 }); // the file stays: the old reader read no evidence
    expect(stat(dir)).toMatchObject({ state: 'capability_missing' });
    expect(ownerPass(dir, epoch)).toEqual({ write_window_lost: 1 });
  }, 60_000);
});

describe('OWC F3: a window is booked once, by whichever pass finds its session orphaned (no early orphan rule)', () => {
  const owedKey = (dir: string): string => readdirSync(dir).flatMap((n) => /^write-owed\.(.+)\.json$/.exec(n)?.[1] ?? [])[0]!;
  test('the serving process alone is killed, its worker lives, the window is past: a worker pass books and removes nothing; once the worker is gone one pass books exactly one window and a second books nothing', async () => {
    const dir = tmp(); const { epoch } = tallyOn(dir); passing(dir, epoch);
    const serving = await servingProcess(dir, 60_000);
    try {
      await serving.killServing();
      const key = owedKey(dir); const rec = readOwed(dir, key) as OwedRecord; expect(rec).toMatchObject({ v: 2, child_pid: serving.workerPid });
      expect(Date.now() + 61_000).toBeGreaterThan(rec.open_until!); // advance past open_until: the rule is not the clock
      const real = Date.now.bind(Date); const clock = spyOn(Date, 'now').mockImplementation(() => real() + 61_000); // the pass runs after the window's open_until
      try { expect(ownerPass(dir, epoch)).toEqual({}); } finally { clock.mockRestore(); }
      expect(readOwed(dir, key)).toMatchObject({ v: 2 }); // the child lives and the record is not closed: not orphaned
      await serving.killWorker();
      expect(ownerPass(dir, epoch)).toEqual({ write_window_lost: 1 });
      expect(readWriteTally(dir, epoch)!.settled?.[key]).toBe(1); expect(readOwed(dir, key)).toMatchObject({ v: 2, booked_epoch: epoch });
      expect(ownerPass(dir, epoch)).toEqual({ write_window_lost: 1 }); // nothing more
    } finally { await serving.kill(); }
  }, 60_000);

  test('kill both: one window, one credit', async () => {
    const dir = tmp(); const { epoch } = tallyOn(dir); passing(dir, epoch);
    const serving = await servingProcess(dir, 60_000); await serving.kill();
    const key = owedKey(dir);
    expect(ownerPass(dir, epoch)).toEqual({ write_window_lost: 1 }); expect(readWriteTally(dir, epoch)!.settled?.[key]).toBe(1);
  }, 60_000);

  test('a live child\'s own end-of-input booking and a later worker pass never credit the same sample twice', async () => {
    const dir = tmp(); const { epoch } = tallyOn(dir); passing(dir, epoch);
    const serving = await servingProcess(dir, 60_000); await serving.killServing();
    const key = owedKey(dir);
    try {
      const child = new WriteTally(dir, () => epoch, () => true, process.pid, key); child.missing(1, 1); child.save(); // the child saw the end of its input: one window (its save is durable; its finish has not removed the file yet)
      expect(readWriteTally(dir, epoch)!.uncomparable_by_reason).toEqual({ write_window_lost: 1 }); expect(readOwed(dir, key)).not.toBeNull();
      await serving.killWorker();
      expect(ownerPass(dir, epoch)).toEqual({ write_window_lost: 1 }); // the pass found nothing left to book
      expect(readWriteTally(dir, epoch)!.settled?.[key]).toBe(1); expect(readOwed(dir, key)).toMatchObject({ v: 2, booked_epoch: epoch });
    } finally { await serving.kill(); }
  }, 60_000);
});

describe('OWC F4: a lost window is always countable, even when the reason map is full', () => {
  test('64 other reasons are already booked (passing evidence): the lost window is still booked under write_window_lost, survives a fold and a later save, and status and readiness name it exactly', () => {
    const dir = tmp(); const { epoch } = tallyOn(dir);
    const others = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`reason_${i}`, 1]));
    passing(dir, epoch, { uncomparable: 64, uncomparable_by_reason: others });
    writeOwed(dir, { v: 2, session: 'w1', serving_pid: deadPid(), child_pid: deadPid(), owed: 1, closed: false, child_exited: false, open_until: 1 });
    const booked = ownerPass(dir, epoch);
    expect(booked[WINDOW_LOST_REASON]).toBe(1); expect(booked.other).toBeUndefined(); expect(Object.keys(booked)).toHaveLength(65);
    expect(readOwed(dir, 'w1')).toMatchObject({ v: 2, booked_epoch: epoch }); // settled, kept as the tombstone
    const again = new WriteTally(dir, () => epoch, () => true, process.pid, 'w2'); again.note('comparable', undefined, 1, false, 0); again.save(); // a later save folds again
    expect(readWriteTally(dir, epoch)!.uncomparable_by_reason[WINDOW_LOST_REASON]).toBe(1);
    const w = stat(dir);
    expect(w).toMatchObject({ state: 'capability_missing', write_windows_lost: 1, comparable: 1001, unexplained_difference: 0 });
    const verdict = evaluateReadiness({ write_comparisons: { ...w } } as unknown as ShadowStatus, NOW);
    const row = verdict.criteria.find((c) => c.n === 5)!;
    expect(row.state).not.toBe('pass'); expect(row.detail).toContain('1 write window(s) lost in a crash');
  });
});

describe('OWC ship-p1 R1: a settled window loss is still a loss to every reader (the tombstone)', () => {
  const orphan = (dir: string, key = 'w1'): void => writeOwed(dir, { v: 2, session: key, serving_pid: deadPid(), child_pid: deadPid(), owed: 3, closed: false, child_exited: false, open_until: 1 });
  test('after the window is booked the v:2 file stays as a tombstone: the frozen 692d2614c9 parser still cannot read it (an older reader keeps reading the epoch as unresolved), this version counts it, and a second pass books nothing', () => {
    const dir = tmp(); const { epoch } = tallyOn(dir); passing(dir, epoch); orphan(dir);
    expect(ownerPass(dir, epoch)).toEqual({ receipt_orphaned: 2, write_window_lost: 1 });
    expect(oldBooks(dir, 'w1')).toBe('skips'); // what the older status and swap reader sees: an unreadable file, no evidence
    expect(oldParseOwed(owedPath(dir, 'w1'))).toBe('unreadable');
    expect(stat(dir)).toMatchObject({ state: 'capability_missing', write_windows_lost: 1 }); expect(stat(dir).outstanding_sessions ?? []).toEqual([]); // booked: nothing is outstanding in this version
    expect(ownerPass(dir, epoch)).toEqual({ receipt_orphaned: 2, write_window_lost: 1 }); expect(readOwed(dir, 'w1')).toMatchObject({ v: 2, booked_epoch: epoch });
  });
  test('an older owner credited the window under another reason (its reason map was full, so the journal line folded into other): the file is the record, and this version still reads one lost window', () => {
    const dir = tmp(); const { epoch } = tallyOn(dir); passing(dir, epoch, { uncomparable: 64, uncomparable_by_reason: Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`reason_${i}`, 1])) });
    orphan(dir);
    const older = new WriteTally(dir, () => epoch, () => true, process.pid, 'w1'); older.note('uncomparable', 'other', 3, false, 3); older.save(); // settles all 3 samples with no write_window_lost anywhere
    expect(readWriteTally(dir, epoch)!.uncomparable_by_reason.write_window_lost).toBeUndefined();
    expect(stat(dir)).toMatchObject({ state: 'capability_missing', write_windows_lost: 1 }); // was measured: the loss was invisible
    const s = stat(dir); expect(s.comparable).toBe(1000); expect(s.unexplained_difference).toBe(0);
    ownerPass(dir, epoch); expect(readOwed(dir, 'w1')).toMatchObject({ v: 2, booked_epoch: epoch }); // the pass keeps it as the tombstone
    expect(stat(dir)).toMatchObject({ state: 'capability_missing', write_windows_lost: 1 });
  });
  test('a tombstone of another epoch counts for nothing in this one, and the next pass removes it; a tombstone parses only as v:2', () => {
    const dir = tmp(); const { epoch } = tallyOn(dir); passing(dir, epoch);
    writeOwed(dir, { v: 2, session: 'w1', serving_pid: 1, owed: 3, closed: false, child_exited: false, open_until: 1, booked_epoch: 'an-earlier-epoch' });
    expect(stat(dir)).toMatchObject({ state: 'measured' }); expect(stat(dir).write_windows_lost).toBeUndefined();
    expect(ownerPass(dir, epoch)).toEqual({}); expect(readOwed(dir, 'w1')).toBeNull();
    writeFileSync(owedPath(dir, 'w2'), JSON.stringify({ v: 1, session: 'w2', serving_pid: 1, owed: 1, closed: true, child_exited: false, booked_epoch: epoch }) + '\n');
    expect(readOwed(dir, 'w2')).toBe('unreadable');
  });
});

describe('OWC: the child books a window the serving process never closed', () => {
  const ADDON = async () => ({ ok: true as const, addon: { target: 'linux-x64-glibc', engineAbi: 1, engineBuild: 'b1', catalogVersion: 3 } as never });
  const BASE = { loadAddon: ADDON, capabilities: () => ['search', 'pages'], readinessPolicyHash: () => 'p1', heartbeatMs: 60_000, childId: 'c1' };
  const run = async (record: Partial<OwedRecord>, lines: string): Promise<{ by: Record<string, number>; settled: unknown; fileLeft: boolean; after: Record<string, number>; gone: boolean }> => withEnv({ GBRAIN_HOME: tmp() }, async () => {
    const dir = tmp();
    writeSeedRecord(dir, { version: 1, seed_id: 'seed-1', started_at: '2026-01-01T00:00:00.000Z', finished_at: '2026-01-01T00:01:00.000Z', unseeded_gap_rows_total: 0, unseeded_gap_rows: {}, relations: {}, digests: true } as never);
    writeOwed(dir, { v: 1, session: 'sess-1', serving_pid: process.pid, owed: 1, closed: false, child_exited: false, ...record });
    const input = new PassThrough();
    const done = runShadowChild(dir, { input, writeControl: () => {}, ...BASE, session: 'sess-1', addonSha256: () => 'a'.repeat(64), openEngine: () => ({ ownerRole: 'owner', async connect() {}, async disconnect() {} }) as never });
    if (lines) input.write(lines);
    input.end(); await done;
    const tally = readWriteTally(dir, readEpoch(dir)!.epoch_id)!;
    const fileLeft = readOwed(dir, 'sess-1') !== null; const after = ownerPass(dir, readEpoch(dir)!.epoch_id); // the next owner pass: settled already, so it books nothing more and removes what is left
    return { by: tally.uncomparable_by_reason, settled: tally.settled, fileLeft, after, gone: readOwed(dir, 'sess-1') === null };
  });
  test('an open marker (v:2) at the end of the input: the child books ONE write_window_lost (not pipe_unflushed) and settles the session; the owner pass then books nothing more', async () => {
    expect(await run({ v: 2, owed: 1, serving_pid: deadPid(), child_pid: deadPid(), open_until: Date.now() + 60_000 }, '')).toEqual({ by: { [WINDOW_LOST_REASON]: 1 }, settled: { 'sess-1': 1 }, fileLeft: true, after: { [WINDOW_LOST_REASON]: 1 }, gone: false }); // the child leaves an unclosed record; the owner pass books nothing twice and keeps it as the tombstone
  }, 30_000);
  test('R4: an open marker owing 2 at the end of input, and only the FIRST booking of the child lands (its next save fails and it dies): the next owner books exactly one write_window_lost, and the whole credit', () => {
    const dir = tmp(); const { epoch } = tallyOn(dir); passing(dir, epoch);
    writeOwed(dir, { v: 2, session: 'w1', serving_pid: deadPid(), child_pid: deadPid(), owed: 2, closed: false, child_exited: false, open_until: 1 });
    const child = new WriteTally(dir, () => epoch, () => true, process.pid, 'w1');
    const real = WriteTally.prototype.note; let calls = 0;
    const spy = spyOn(WriteTally.prototype, 'note').mockImplementation(function (this: WriteTally, ...args: Parameters<typeof real>) { if (calls++ === 0) return real.apply(this, args); }); // only the first booking is durable
    try { child.missing(2, 1); } finally { spy.mockRestore(); }
    const owner = ownerPass(dir, epoch);
    expect(owner[WINDOW_LOST_REASON]).toBe(1); // was 2: the sentinel landed first, and the owner booked the rest as a second window
    expect(readWriteTally(dir, epoch)!.settled?.w1).toBe(2); expect(stat(dir)).toMatchObject({ state: 'capability_missing', write_windows_lost: 1 });
  });
  test('R4: the client child (no epoch) journals the plain samples before the window sentinel', () => {
    const dir = tmp(); const order: string[] = [];
    const child = new WriteTally(dir, () => null, () => true, process.pid, 'w1');
    const spy = spyOn(child as unknown as { addJournal(reason: string, settles: boolean, n: number): void }, 'addJournal').mockImplementation((reason: string) => { order.push(reason); });
    try { child.missing(3, 1); } finally { spy.mockRestore(); }
    expect(order.filter((r, i) => order.indexOf(r) === i)).toEqual(['pipe_unflushed', WINDOW_LOST_REASON]);
  });
  test('a full record (v:1) the child did not get everything of is booked pipe_unflushed, as before (no window was lost)', async () => {
    expect(await run({ v: 1, owed: 1, closed: true }, '')).toEqual({ by: { pipe_unflushed: 1 }, settled: { 'sess-1': 1 }, fileLeft: false, after: { pipe_unflushed: 1 }, gone: true });
  }, 30_000);
});

describe('OWC ship-p4: the stale-tombstone cleanup, the child stamp and the child booking order', () => {
  test('B: a stale tombstone of an earlier epoch is replaced by a locked higher obligation between the listing and the cleanup: the cleanup reads it again under the lock and leaves the replacement alone', () => {
    const dir = tmp(); const { epoch } = tallyOn(dir); passing(dir, epoch);
    writeOwed(dir, { v: 2, session: 'w1', serving_pid: process.pid, owed: 3, closed: false, child_exited: false, open_until: 1, booked_epoch: 'an-earlier-epoch' });
    writeOwed(dir, { v: 1, session: 'w2', serving_pid: deadPid(), child_pid: deadPid(), owed: 2, closed: false, child_exited: false }); // an orphan to book, so the pass takes its cleanup path
    const proto = WriteTally.prototype as unknown as { update(...args: unknown[]): boolean }; const real = proto.update; let replaced = false;
    const spy = spyOn(proto, 'update').mockImplementation(function (this: WriteTally, ...args: unknown[]) {
      const ok = real.apply(this, args);
      if (!replaced) { replaced = true; writeOwed(dir, { v: 1, session: 'w1', serving_pid: process.pid, owed: 3, closed: false, child_exited: false }); } // the serving process publishes a higher obligation for the same session, after the listing
      return ok;
    });
    try { ownerPass(dir, epoch); } finally { spy.mockRestore(); }
    expect(replaced).toBe(true);
    expect(readOwed(dir, 'w1')).toMatchObject({ v: 1, owed: 3 }); // was removed: the unlink had no lock and no re-read
  });
  test('B: a stale tombstone nobody replaced is still removed by the next pass', () => {
    const dir = tmp(); const { epoch } = tallyOn(dir); passing(dir, epoch);
    writeOwed(dir, { v: 2, session: 'w1', serving_pid: 1, owed: 3, closed: false, child_exited: false, open_until: 1, booked_epoch: 'an-earlier-epoch' });
    ownerPass(dir, epoch); expect(readOwed(dir, 'w1')).toBeNull();
  });

  describe('child', () => {
    const ADDON = async () => ({ ok: true as const, addon: { target: 'linux-x64-glibc', engineAbi: 1, engineBuild: 'b1', catalogVersion: 3 } as never });
    const BASE = { loadAddon: ADDON, capabilities: () => ['search', 'pages'], readinessPolicyHash: () => 'p1', heartbeatMs: 60_000, childId: 'c1' };
    const seed = (dir: string): void => { writeSeedRecord(dir, { version: 1, seed_id: 'seed-1', started_at: '2026-01-01T00:00:00.000Z', finished_at: '2026-01-01T00:01:00.000Z', unseeded_gap_rows_total: 0, unseeded_gap_rows: {}, relations: {}, digests: true } as never); };
    const replay = (n: number): string => JSON.stringify({ t: 'write', op: 'putPage', args: encodeArgs([`people/p4-${n}-example`, { type: 'person', title: `P ${n}`, compiled_truth: 'P.', timeline: '' }]) as unknown[], pre: { sources: [], pages: [], links: [] }, post: { pages: [null], links: [] } }) + '\n';
    test('C: a child that books the window at the end of its input stamps its own epoch on the marker it leaves, so a later epoch\'s owner pass never reads that window as its own', async () => {
      await withEnv({ GBRAIN_HOME: tmp() }, async () => {
        const dir = tmp(); seed(dir);
        writeOwed(dir, { v: 2, session: 'sess-1', serving_pid: deadPid(), child_pid: deadPid(), owed: 1, closed: false, child_exited: false, open_until: Date.now() + 60_000 });
        const input = new PassThrough();
        const done = runShadowChild(dir, { input, writeControl: () => {}, ...BASE, session: 'sess-1', addonSha256: () => 'a'.repeat(64), openEngine: () => ({ ownerRole: 'owner', async connect() {}, async disconnect() {} }) as never });
        input.end(); await done;
        const e1 = readEpoch(dir)!;
        expect(readOwed(dir, 'sess-1')).toMatchObject({ v: 2, booked_epoch: e1.epoch_id }); // was unstamped: finish() refuses an unclosed record
        const e2 = ensureEpoch(dir, { ...e1.inputs, rust_addon_sha256: 'b'.repeat(64) }, NOW.getTime() + 60_000).epoch_id; expect(e2).not.toBe(e1.epoch_id);
        passing(dir, e2); ownerPass(dir, e2);
        expect(stat(dir)).toMatchObject({ state: 'measured' }); expect(stat(dir).write_windows_lost).toBeUndefined(); // was capability_missing with 1 window lost: the next epoch stamped it
        expect(readOwed(dir, 'sess-1')).toBeNull(); // the old epoch's tombstone goes with its epoch
      });
    }, 30_000);
    test('D: a child that dies in the drain (its replays still unsettled) has booked no window yet: the next owner books the whole deficit, ONE write_window_lost for the one window', async () => {
      await withEnv({ GBRAIN_HOME: tmp() }, async () => {
        const dir = tmp(); seed(dir);
        writeOwed(dir, { v: 2, session: 'sess-1', serving_pid: deadPid(), child_pid: deadPid(), owed: 3, closed: false, child_exited: false, open_until: Date.now() + 60_000 });
        const input = new PassThrough(); let exitCode = null as number | null; const seen: { v?: { before: number | undefined; after: number | undefined } } = {};
        const died = (code: number): void => { // the process ends here (the real `exit`): what the tally holds at this moment is all a dead child leaves, and the next owner pass books the rest
          exitCode = code; const epoch = readEpoch(dir)!.epoch_id;
          seen.v = { before: readWriteTally(dir, epoch)!.uncomparable_by_reason[WINDOW_LOST_REASON], after: ownerPass(dir, epoch)[WINDOW_LOST_REASON] };
        };
        void runShadowChild(dir, { input, writeControl: () => {}, ...BASE, session: 'sess-1', addonSha256: () => 'a'.repeat(64), exitDeadlineMs: 300, exit: died,
          openEngine: () => ({ ownerRole: 'owner', async connect() {}, async disconnect() {}, storeFor: () => new Promise(() => {}) }) as never }); // the first replay never finishes
        input.write(replay(0) + replay(1)); input.end(); // 2 of the 3 owed samples arrive; the third was dropped in the pipe
        const until = Date.now() + 10_000; while (exitCode === null && Date.now() < until) await sleep(25);
        expect(exitCode).toBe(0);
        expect(seen.v).toEqual({ before: undefined, after: 1 }); // was { before: 1, after: 2 }: booked before the drain (durable at once), then again by the owner
      });
    }, 30_000);
  });
});

describe('OWC ship-p5 A: the supervisor\'s late exit publication must not erase a booked tombstone', () => {
  test('a worker dies inside a window, another owner books it (the tombstone), THEN the supervisor sees the exit and publishes its v:1 record: the tombstone stays, so an older reader still reads the epoch as unresolved', () => {
    const r = rig();
    try {
      for (let i = 0; i < 3; i++) expect(r.sup.send(sample(i))).toBe(true); // the window is open: marker owed 1, three samples accepted
      const key = r.sessions[0]!;
      expect(ownerPass(r.dir, r.epoch)).toEqual({ write_window_lost: 1 }); // another serving process's owner worker books the dead worker's window
      expect(readOwed(r.dir, key)).toMatchObject({ v: 2, booked_epoch: r.epoch });
      r.children[0]!.emit('exit', 1, null); // the exit reaches the supervisor late: it writes v:1, owed 3, child_exited, under the lock
      ownerPass(r.dir, r.epoch);
      expect(readOwed(r.dir, key)).toMatchObject({ v: 2, booked_epoch: r.epoch }); // was removed: the v:1 record replaced the tombstone, and the pass booked 2 receipt_orphaned and deleted it
      expect(oldBooks(r.dir, key)).toBe('skips'); // an older reader must still see an unreadable file
    } finally { r.done(); }
  });
  test('the same when the exit-time record could not be written and is kept: the keeper\'s later publication leaves the tombstone v:2 as well, and the pass books the rest once', async () => {
    const r = rig();
    try {
      for (let i = 0; i < 3; i++) expect(r.sup.send(sample(i))).toBe(true);
      const key = r.sessions[0]!;
      expect(ownerPass(r.dir, r.epoch)).toEqual({ write_window_lost: 1 });
      r.state.fault = 'before-rename'; r.children[0]!.emit('exit', 1, null); // the exit-time record fails: kept and marked
      r.state.fault = null; await sleep(150); // the keeper publishes it (the retry timer) under the lock
      expect(ownerPass(r.dir, r.epoch)).toEqual({ receipt_orphaned: 2, write_window_lost: 1 });
      expect(readOwed(r.dir, key)).toMatchObject({ v: 2, owed: 3, booked_epoch: r.epoch }); expect(oldBooks(r.dir, key)).toBe('skips');
      expect(ownerPass(r.dir, r.epoch)).toEqual({ receipt_orphaned: 2, write_window_lost: 1 }); // once
    } finally { r.done(); }
  });
});
