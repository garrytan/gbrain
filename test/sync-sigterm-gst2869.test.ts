/**
 * GST-2869: `gbrain sync` stopped by SIGTERM or SIGHUP in the middle of a managed pass recorded nothing: process-cleanup's
 * generic handler released the locks and exited 143, the pass row stayed open and status could only guess `pass_interrupted`.
 * The CLI now owns those signals while a managed pass is live: the pass ends its row `resumable` / `terminated`, the drain
 * stops `terminated`, status reads `pass_terminated`, the run exits 128 + n, and a terminated pass that committed nothing
 * still builds the abandoned streak in every reader. A worker's sync job, or a run without the CLI opt-in, keeps today's path.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performSync, runSync } from '../src/commands/sync.ts';
import { currentExitCode, setCliExitVerdict } from '../src/core/cli-force-exit.ts';
import * as processCleanup from '../src/core/process-cleanup.ts';
import { _resetForTests, CLEANUP_DEADLINE_MS, hasSignalOwner, installSignalHandlers, registerSignalOwner } from '../src/core/process-cleanup.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { readBlockedManagedSyncs } from '../src/core/persistence/sync-blocked.ts';
import { abandonedPasses, passStatusNext, passStatusState } from '../src/core/persistence/sync-pass-status.ts';
import * as passRowModule from '../src/core/persistence/sync-pass-row.ts';
import * as watermarkModule from '../src/core/persistence/applied-watermark.ts';
import { MANAGED_SYNC_PASS_OP, readPassRow, transientEnding, type PassRow } from '../src/core/persistence/sync-pass-row.ts';
import { abortStop, SyncTerminated } from '../src/core/persistence/sync-stop-class.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { waitFor } from './helpers/wait-for.ts';

const git = (root: string, args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', '-c', 'commit.gpgsign=false', ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const now = Date.parse('2026-11-17T12:00:00Z');
const row = (outcome: string, stop: string | null, streak?: number): PassRow => ({ updated_at: new Date(now - 10_000).toISOString(),
  value: { source_id: 's', incarnation: 'i', lease_token: 't', obligations: { baseline_commit: null, mismatch: {}, not_converged_streak: 0, faults: {}, ...(streak ? { abandoned_streak: streak } : {}) },
    telemetry: { pass_id: 'p', target: 'h', started_at: '', ended_at: null, kind: 'full', round: 0, outcome, stop_reason: stop, candidates: 0, settled: 0, remaining: 0, counts: {}, duration_ms: null } } } as never);

afterEach(() => { installFaultHook(undefined); _resetForTests(); setCliExitVerdict(0); });

describe('GST-2869: a terminated pass', () => {
  test('reads pass_terminated with the plain sync next, and counts toward the abandoned streak unless it banked work', () => {
    const terminated = row('resumable', 'terminated');
    expect(transientEnding(terminated.value.telemetry)).toBe(true);
    expect(passStatusState(terminated, null, null, now, true)).toEqual(['resumable', 'pass_terminated']);
    const next = passStatusNext('s', 'pass_terminated', terminated, ['--source', 's'], null, true);
    expect(next.argv).toEqual(['gbrain', 'sync', '--source', 's']);
    expect(next.why).toContain('termination signal');
    expect(abandonedPasses(terminated, now, true)).toBe(1);
    expect(abandonedPasses(terminated, now, true, true)).toBe(0);
    expect(passStatusState(row('resumable', 'terminated', 1), null, null, now, true)).toEqual(['blocked', 'pass_abandoned']);
    // A deadline or SIGINT stop keeps resetting the streak, as before.
    expect(transientEnding(row('resumable', 'timeout').value.telemetry)).toBe(false);
    expect(passStatusState(row('resumable', 'timeout'), null, null, now, true)).toEqual(['resumable', 'pass_unfinished']);
  });

  test('the first abort decides the stop reason: a deadline that fired first stays a timeout', () => {
    const deadline = new AbortController(), signal = new AbortController();
    const both = AbortSignal.any([deadline.signal, signal.signal]);
    deadline.abort(new Error('deadline'));
    signal.abort(new SyncTerminated('SIGTERM'));
    expect(abortStop(both)).toBe('timeout');
    const first = new AbortController(), later = new AbortController();
    const other = AbortSignal.any([first.signal, later.signal]);
    first.abort(new SyncTerminated('SIGHUP'));
    later.abort(new Error('deadline'));
    expect(abortStop(other)).toBe('terminated');
    expect(abortStop(undefined)).toBe('timeout');
  });

  test('a signal owner can claim only some signals; the rest take the generic path', async () => {
    const exit = spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      installSignalHandlers();
      const seen: string[] = [];
      const release = registerSignalOwner('t', signal => { seen.push(signal); }, ['SIGTERM', 'SIGHUP']);
      expect(hasSignalOwner()).toBe(true);
      process.emit('SIGTERM');
      process.emit('SIGHUP');
      expect(seen).toEqual(['SIGTERM', 'SIGHUP']);
      process.emit('SIGPIPE' as never);
      expect(seen).toEqual(['SIGTERM', 'SIGHUP']);
      // The generic path ran: its cleanup pass then exits 141.
      await Bun.sleep(50);
      expect(exit).toHaveBeenCalledWith(141);
      release();
      expect(hasSignalOwner()).toBe(false);
    } finally { exit.mockRestore(); }
  });
});

const SYNC = ['--source', 'default', '--no-pull', '--no-embed', '--json'];
const page = (i: number, tag: string) => `---\ntype: concept\ntitle: p${i}\n---\n\nNote ${i}${tag}.\n`;
const seed = ({ root }: { root: string }) => {
  git(root, ['init', '-q']);
  for (let i = 0; i < 40; i++) { mkdirSync(join(root, `d${i % 4}`), { recursive: true }); writeFileSync(join(root, `d${i % 4}/p${i}.md`), page(i, '')); }
  git(root, ['add', '-A']); git(root, ['commit', '-qm', 'init']);
};
const editAll = (root: string, tag: string) => {
  for (let i = 0; i < 40; i++) writeFileSync(join(root, `d${i % 4}/p${i}.md`), page(i, `, ${tag}`));
  git(root, ['commit', '-qam', tag]);
};
const quiet = async <T>(run: () => Promise<T>): Promise<T> => {
  const out = spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
  try { return await run(); } finally { out.mockRestore(); }
};
/** Emits `signal` the first time the next pass reaches `at`, as a supervisor's kill lands mid-pass. */
const signalAtRound = (signal: NodeJS.Signals, at = 'sync:round_start') => {
  let sent = false;
  installFaultHook(point => { if (point === at && !sent) { sent = true; process.emit(signal as never); } });
};
const passRow = async (engine: BrainEngine) => {
  const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
  return (await readPassRow(engine, 'default', incarnation))!.value;
};

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test(`GST-2869 [${backend}]: SIGTERM mid-pass records terminated, exits 143, and the next sync resumes`, () => managedBrain(async ({ engine, root }) => {
    const exit = spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const kill = spyOn(process, 'kill').mockImplementation((() => true) as never);
    try {
      installSignalHandlers();
      await quiet(() => runSync(engine, SYNC, { ownSignals: true }));
      expect(currentExitCode()).toBe(0);
      editAll(root, 'one');
      signalAtRound('SIGTERM');
      await quiet(() => runSync(engine, SYNC, { ownSignals: true }));
      installFaultHook(undefined);
      expect(currentExitCode()).toBe(143);
      expect(exit).not.toHaveBeenCalled();
      expect(kill).not.toHaveBeenCalled();
      expect(hasSignalOwner()).toBe(false);
      const ended = await passRow(engine);
      expect([ended.telemetry.outcome, ended.telemetry.stop_reason]).toEqual(['resumable', 'terminated']);
      const status = await readSyncStatus(engine, 'default', { detail: false });
      expect([status.state, status.reason]).toEqual(['resumable', 'pass_terminated']);
      expect(status.next?.argv?.slice(0, 4)).toEqual(['gbrain', 'sync', '--source', 'default']);

      setCliExitVerdict(0);
      await quiet(() => runSync(engine, SYNC, { ownSignals: true }));
      expect(currentExitCode()).toBe(0);
      expect((await passRow(engine)).telemetry.outcome).toBe('synced');
    } finally { exit.mockRestore(); kill.mockRestore(); }
  }, { databaseUrl, setup: seed }), 120_000);

  test(`GST-2869 [${backend}]: SIGTERM inside a batch records terminated, not the batch's timeout`, () => managedBrain(async ({ engine, root }) => {
    const exit = spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const kill = spyOn(process, 'kill').mockImplementation((() => true) as never);
    try {
      installSignalHandlers();
      await quiet(() => runSync(engine, SYNC, { ownSignals: true }));
      editAll(root, 'batch');
      signalAtRound('SIGTERM', 'sync:batch_entries');
      await quiet(() => runSync(engine, SYNC, { ownSignals: true }));
      installFaultHook(undefined);
      expect(currentExitCode()).toBe(143);
      const ended = await passRow(engine);
      expect([ended.telemetry.outcome, ended.telemetry.stop_reason]).toEqual(['resumable', 'terminated']);
    } finally { exit.mockRestore(); kill.mockRestore(); }
  }, { databaseUrl, setup: seed }), 120_000);

  test(`GST-2869 [${backend}]: two terminated passes that committed nothing carry the streak through the pin and read pass_abandoned`, () => managedBrain(async ({ engine, root }) => {
    const exit = spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const kill = spyOn(process, 'kill').mockImplementation((() => true) as never);
    try {
      installSignalHandlers();
      await quiet(() => runSync(engine, SYNC, { ownSignals: true }));
      editAll(root, 'two');
      for (const signal of ['SIGTERM', 'SIGHUP'] as const) {
        setCliExitVerdict(0);
        signalAtRound(signal);
        await quiet(() => runSync(engine, SYNC, { ownSignals: true }));
        installFaultHook(undefined);
        expect(currentExitCode()).toBe(signal === 'SIGHUP' ? 129 : 143);
      }
      expect((await passRow(engine)).obligations.abandoned_streak).toBe(1);
      const status = await readSyncStatus(engine, 'default', { detail: false });
      expect([status.state, status.reason]).toEqual(['blocked', 'pass_abandoned']);
      expect((await readBlockedManagedSyncs(engine, ['default'])).filter(entry => entry.source_id === 'default'))
        .toEqual([expect.objectContaining({ code: 'pass_abandoned' })]);
    } finally { exit.mockRestore(); kill.mockRestore(); }
  }, { databaseUrl, setup: seed }), 120_000);

  test(`GST-2869 [${backend}]: under another owner (a worker) or without the CLI opt-in, sync claims no signal`, () => managedBrain(async ({ engine, root }) => {
    const exit = spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      installSignalHandlers();
      await quiet(() => runSync(engine, SYNC, { ownSignals: true }));
      const seen: string[] = [];
      const releaseWorker = registerSignalOwner('jobs-work', signal => { seen.push(signal); });
      editAll(root, 'three');
      signalAtRound('SIGTERM');
      await quiet(() => runSync(engine, SYNC, { ownSignals: true }));
      installFaultHook(undefined);
      releaseWorker();
      expect(seen).toEqual(['SIGTERM']);
      expect(currentExitCode()).toBe(0);
      expect((await passRow(engine)).telemetry.outcome).toBe('synced');
      let ownedDuringPass: boolean | undefined;
      editAll(root, 'four');
      installFaultHook(point => { if (point === 'sync:round_start') ownedDuringPass ??= hasSignalOwner(); });
      await quiet(() => runSync(engine, SYNC));
      expect(ownedDuringPass).toBe(false);
      expect((await passRow(engine)).telemetry.outcome).toBe('synced');
    } finally { exit.mockRestore(); }
  }, { databaseUrl, setup: seed }), 120_000);

  // Value: protects=a second SIGTERM while the pass saves exits now through the generic path (release + re-raise);
  //   fails_when=the interrupt.signal.aborted guard in the sync signal owner is dropped; why_new=no test sends a second signal;
  //   seam=none; no_claim=the real process death (process.kill mocked; pglite unit only)
  test(`GST-2869 [${backend}]: a second SIGTERM while the pass saves re-raises it through the generic path`, () => managedBrain(async ({ engine, root }) => {
    const exit = spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const kill = spyOn(process, 'kill').mockImplementation((() => true) as never);
    try {
      installSignalHandlers();
      await quiet(() => runSync(engine, SYNC, { ownSignals: true }));
      editAll(root, 'twice');
      let sent = false;
      installFaultHook(point => { if (point === 'sync:round_start' && !sent) { sent = true; process.emit('SIGTERM' as never); process.emit('SIGTERM' as never); } });
      await quiet(() => runSync(engine, SYNC, { ownSignals: true }));
      installFaultHook(undefined);
      expect(kill).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
      expect(hasSignalOwner()).toBe(false);
      expect(currentExitCode()).toBe(143);
    } finally { exit.mockRestore(); kill.mockRestore(); }
  }, { databaseUrl, setup: seed }), 120_000);

  // Value: protects=a SIGTERM before any managed pass is live takes the generic path and records no terminated pass;
  //   fails_when=the !managedPassLive() guard is dropped, so a pre-pass signal aborts the run instead of exiting;
  //   why_new=existing arms signal only mid-pass; seam=none; no_claim=the real process death (process.kill mocked; pglite unit only)
  test(`GST-2869 [${backend}]: a SIGTERM with no live managed pass takes the generic path and records nothing`, () => managedBrain(async ({ engine, root }) => {
    const exit = spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const kill = spyOn(process, 'kill').mockImplementation((() => true) as never);
    try {
      installSignalHandlers();
      await quiet(() => runSync(engine, SYNC, { ownSignals: true }));
      editAll(root, 'early');
      signalAtRound('SIGTERM', 'sync:lease_acquired');
      await quiet(() => runSync(engine, SYNC, { ownSignals: true }));
      installFaultHook(undefined);
      expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
      expect(currentExitCode()).toBe(0);
      const ended = await passRow(engine);
      expect([ended.telemetry.outcome, ended.telemetry.stop_reason]).toEqual(['synced', null]);
    } finally { exit.mockRestore(); kill.mockRestore(); }
  }, { databaseUrl, setup: seed }), 120_000);

  // Value: protects=a save that outlasts the cleanup window still exits 128 + n through triggerCleanupAndExit (143 SIGTERM, 129 SIGHUP);
  //   fails_when=the fallback timer is dropped, uses another delay, or exits with a fixed or wrong code; why_new=no arm reaches the fallback;
  //   seam=none; no_claim=a real 3 s wall-clock wait (the timer callback is captured and fired by hand; cleanup exit spied)
  test(`GST-2869 [${backend}]: a save that outlasts the cleanup window exits 128 + n through the generic cleanup`, () => managedBrain(async ({ engine, root }) => {
    const exit = spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const kill = spyOn(process, 'kill').mockImplementation((() => true) as never);
    const trigger = spyOn(processCleanup, 'triggerCleanupAndExit').mockImplementation((async () => undefined) as never);
    try {
      installSignalHandlers();
      await quiet(() => runSync(engine, SYNC, { ownSignals: true }));
      for (const [signal, code] of [['SIGTERM', 143], ['SIGHUP', 129]] as const) {
        setCliExitVerdict(0);
        editAll(root, `late-${signal}`);
        const fallbacks: Array<() => void> = [];
        let sent = false;
        installFaultHook(point => {
          if (point !== 'sync:round_start' || sent) return;
          sent = true;
          const realSetTimeout = globalThis.setTimeout;
          globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
            if (ms === CLEANUP_DEADLINE_MS) fallbacks.push(fn);
            return realSetTimeout(fn, ms, ...rest);
          }) as typeof setTimeout;
          try { process.emit(signal as never); } finally { globalThis.setTimeout = realSetTimeout; }
        });
        await quiet(() => runSync(engine, SYNC, { ownSignals: true }));
        installFaultHook(undefined);
        expect(currentExitCode()).toBe(code);
        expect(trigger).not.toHaveBeenCalled();
        expect(fallbacks).toHaveLength(1);
        fallbacks[0]();
        expect(trigger).toHaveBeenCalledWith(code);
        trigger.mockClear();
      }
    } finally { exit.mockRestore(); kill.mockRestore(); trigger.mockRestore(); }
  }, { databaseUrl, setup: seed }), 120_000);

  // Value: protects=a terminated run keeps the cleanup fallback armed until its result is out, so a stalled read after the save still exits;
  //   fails_when=the fallback is cleared when the pass returns, before the watermark read and the JSON result; why_new=other arms finish fast;
  //   seam=none; no_claim=a real stalled database (the watermark read is held by a spy)
  test(`GST-2869 [${backend}]: a terminated run keeps the fallback armed until its result is out`, () => managedBrain(async ({ engine, root }) => {
    const exit = spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const kill = spyOn(process, 'kill').mockImplementation((() => true) as never);
    let release: (value: null) => void = () => undefined;
    const stalled = new Promise<null>(resolve => { release = resolve; });
    const watermark = spyOn(watermarkModule, 'readAppliedWatermark');
    const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
    const fallbacks: unknown[] = [], cleared = new Set<unknown>();
    try {
      installSignalHandlers();
      await quiet(() => runSync(engine, SYNC, { ownSignals: true }));
      editAll(root, 'stalled-tail');
      let sent = false;
      installFaultHook(point => {
        if (point !== 'sync:round_start' || sent) return;
        sent = true;
        globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
          const handle = realSetTimeout(fn, ms, ...rest);
          if (ms === CLEANUP_DEADLINE_MS) fallbacks.push(handle);
          return handle;
        }) as typeof setTimeout;
        try { process.emit('SIGTERM' as never); } finally { globalThis.setTimeout = realSetTimeout; }
      });
      globalThis.clearTimeout = ((handle?: Parameters<typeof clearTimeout>[0]) => { cleared.add(handle); realClearTimeout(handle); }) as typeof clearTimeout;
      watermark.mockClear();
      watermark.mockImplementation((() => stalled) as never);
      const running = quiet(() => runSync(engine, SYNC, { ownSignals: true }));
      await waitFor(() => watermark.mock.calls.length > 0, { timeoutMs: 60_000 });
      expect(fallbacks).toHaveLength(1);
      expect(cleared.has(fallbacks[0])).toBe(false);
      release(null);
      await running;
      installFaultHook(undefined);
      expect(cleared.has(fallbacks[0])).toBe(true);
      expect(currentExitCode()).toBe(143);
      expect((await passRow(engine)).telemetry.stop_reason).toBe('terminated');
    } finally { globalThis.clearTimeout = realClearTimeout; watermark.mockRestore(); exit.mockRestore(); kill.mockRestore(); }
  }, { databaseUrl, setup: seed }), 120_000);

  // Value: protects=gbrain sync --all stopped by SIGTERM records the pass terminated and exits 143;
  //   fails_when=runSyncAll stops wrapping dispatch in the signal owner or drops the terminated exit verdict;
  //   why_new=existing arms run single-source only; seam=none; no_claim=the skipped extraction and backup extras (not observed; pglite unit only)
  test(`GST-2869 [${backend}]: sync --all stopped by SIGTERM records terminated and exits 143`, () => managedBrain(async ({ engine, root }) => {
    const exit = spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const kill = spyOn(process, 'kill').mockImplementation((() => true) as never);
    const ALL = ['--all', '--no-pull', '--no-embed', '--json'];
    try {
      installSignalHandlers();
      await quiet(() => runSync(engine, ALL, { ownSignals: true }));
      expect(currentExitCode()).toBe(0);
      editAll(root, 'all');
      signalAtRound('SIGTERM');
      await quiet(() => runSync(engine, ALL, { ownSignals: true }));
      installFaultHook(undefined);
      expect(currentExitCode()).toBe(143);
      expect(exit).not.toHaveBeenCalled();
      expect(kill).not.toHaveBeenCalled();
      expect(hasSignalOwner()).toBe(false);
      const ended = await passRow(engine);
      expect([ended.telemetry.outcome, ended.telemetry.stop_reason]).toEqual(['resumable', 'terminated']);
    } finally { exit.mockRestore(); kill.mockRestore(); }
  }, { databaseUrl, setup: seed }), 120_000);

  // Value: protects=an abort the sync took as a termination, landing while the pass row is pinned, saves stop_reason terminated;
  //   fails_when=the pin-site save goes back to a fixed 'timeout'; why_new=existing arms abort after the pin; seam=none;
  //   no_claim=a real signal at the pin (managedPassLive is false there); a writePassRow spy aborts right after the pin write
  test(`GST-2869 [${backend}]: a termination abort while the pass is pinned records terminated, not timeout`, () => managedBrain(async ({ engine, root }) => {
    await quiet(() => performSync(engine, { repoPath: root, sourceId: 'default', noPull: true, noEmbed: true }));
    editAll(root, 'pin');
    const controller = new AbortController();
    const realWrite = passRowModule.writePassRow;
    const write = spyOn(passRowModule, 'writePassRow').mockImplementation(async (tx, value, opts = {}) => {
      const written = await realWrite(tx, value, opts);
      if (opts.pin && !opts.clock && value.telemetry.outcome === 'open' && !controller.signal.aborted) controller.abort(new SyncTerminated('SIGTERM'));
      return written;
    });
    try {
      await quiet(() => performSync(engine, { repoPath: root, sourceId: 'default', noPull: true, noEmbed: true, drain: true, signal: controller.signal }));
    } finally { write.mockRestore(); }
    expect(controller.signal.aborted).toBe(true);
    const ended = await passRow(engine);
    expect([ended.telemetry.outcome, ended.telemetry.stop_reason, ended.telemetry.round]).toEqual(['resumable', 'terminated', 0]);
  }, { databaseUrl, setup: seed }), 120_000);
}

/**
 * Measured on a generated 24,000-hold PGLite mirror: a real SIGTERM reached the sync handler 19-33 s after the signal while
 * the pass's progress timers kept firing, and master's generic handler waits as long. Once the handler runs, the row is
 * saved within milliseconds, which the pglite arms above pin. This names the wait so a fix has a test to turn green.
 */
test.todo('GST-2869 follow-up [pglite]: a real SIGTERM reaches the sync handler within the 3 s window while a managed pass writes pages', () => {});
