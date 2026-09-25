/**
 * Bounded extract_atoms drain — the window is a hard wall-clock deadline.
 *
 * Before: `--window` was checked only between items, and the CLI passes no
 * job signal, so one in-flight provider call ran to the gateway's own
 * timeout (300s) past the window. Now the drain loop derives an AbortSignal
 * from the window, combined with the external job signal, and hands it to
 * every provider call:
 *
 *  W1: the window alone (no caller signal) kills the claude-cli child, defers
 *      the interrupted item without a failure strike, releases the cycle
 *      lock and reports `stopped: 'window'` — never 'aborted'.
 *  W2: the real Minion handler, driven through the configured claude-cli
 *      model, finishes one item, is cut mid-call by its window, and queues
 *      the ordinary bounded continuation.
 *  W3: the `gbrain dream --drain` CLI prints the incomplete receipt and exits 3.
 *  W4: an external cancel still wins: `stopped: 'aborted'`, no continuation.
 *  W5: a continuation that meets a busy cycle lock under a REAL worker goes
 *      back to `delayed` without burning an attempt.
 *  W6: `dream --drain --dry-run` exits 3 on transcript-only backlog and on a
 *      failed (null) transcript count.
 *
 * Hermetic: PGLite, temp dirs, a stub `claude` binary; no provider spend.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import { tryAcquireDbLock } from '../src/core/db-lock.ts';
import { cycleLockIdFor } from '../src/core/cycle.ts';
import * as extractAtoms from '../src/core/cycle/extract-atoms.ts';
import { countExtractAtomsBacklog } from '../src/core/cycle/extract-atoms.ts';
import { DRAIN_WINDOW_ELAPSED, runExtractAtomsDrainForSource } from '../src/core/cycle/extract-atoms-drain.ts';
import { configureGateway, resetGateway, type ChatOpts, type ChatResult } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;
let root: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  queue = new MinionQueue(engine);
  configureGateway({ env: {} }); // keyless: only the claude-cli recipe can run
}, 60_000);

afterAll(async () => { resetGateway(); await engine.disconnect(); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

beforeEach(async () => {
  for (const sql of [
    'DELETE FROM minion_jobs', 'DELETE FROM pages', 'DELETE FROM extract_atoms_page_state',
    'DELETE FROM extract_atoms_transcript_state',
    "DELETE FROM config WHERE key LIKE 'autopilot.auto_drain.%' OR key LIKE 'dream.%' OR key = 'models.dream.extract_atoms'",
  ]) await engine.executeRaw(sql);
  root = mkdtempSync(join(tmpdir(), 'gbrain-drain-window-'));
});

const FILLER = (label: string) => `Synthetic evidence for ${label} with enough source detail for extraction. `.repeat(20);

async function seedPages(n: number): Promise<void> {
  for (let i = 1; i <= n; i++) {
    const slug = `meetings/window-example-${i}`;
    await engine.putPage(slug, { title: slug, type: 'meeting', compiled_truth: FILLER(slug), timeline: '' });
  }
}

/**
 * Stub `claude` binary. The first `succeed` invocations print a success
 * envelope carrying one atom; every later one records its pid and `exec`s a
 * 30s sleep, so the recorded pid IS the process the adapter must kill.
 */
function stubClaude(succeed: number): { bin: string; pidFile: string } {
  const bin = join(root, 'claude');
  const pidFile = join(root, 'child.pid');
  const counter = join(root, 'calls');
  const atoms = JSON.stringify([{ title: 'Window lesson', atom_type: 'insight', body: 'A generic lesson.' }]);
  const envelope = JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, result: atoms, stop_reason: 'end_turn', session_id: 's', num_turns: 1,
  });
  writeFileSync(bin, [
    '#!/bin/sh',
    'cat > /dev/null',
    `echo x >> "${counter}"`,
    `if [ "$(wc -l < "${counter}")" -le ${succeed} ]; then printf '%s\\n' '${envelope}'; exit 0; fi`,
    `echo $$ > "${pidFile}"`,
    'exec sleep 30',
  ].join('\n'));
  chmodSync(bin, 0o755);
  return { bin, pidFile };
}

async function childGone(pidFile: string): Promise<boolean> {
  if (!existsSync(pidFile)) return false;
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  for (let i = 0; i < 50; i++) {
    try { process.kill(pid, 0); } catch { return true; }
    await new Promise(r => setTimeout(r, 40));
  }
  return false;
}

async function atomCount(): Promise<number> {
  const [r] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE type = 'atom' AND deleted_at IS NULL");
  return Number(r.n);
}

/** Failure strikes (a completed page's stamp is `tombstoned` with fail_count 0, not a strike). */
async function strikeCount(): Promise<number> {
  const [r] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM extract_atoms_page_state WHERE fail_count > 0');
  return Number(r.n);
}

async function lockIsFree(id: string): Promise<boolean> {
  const h = await tryAcquireDbLock(engine, id, 1);
  if (!h) return false;
  await h.release();
  return true;
}

async function drainHandler() {
  const worker = new MinionWorker(engine);
  await registerBuiltinHandlers(worker, engine, { quiet: true });
  return worker.getHandler('extract-atoms-drain')!;
}

/** Run `gbrain dream <args>` in-process, capturing stdout lines and the exit code. */
async function runDreamCaptured(args: string[], env: Record<string, string> = {}): Promise<{ out: string[]; exitCode: number | undefined }> {
  const { runDream } = await import('../src/commands/dream.ts');
  const out: string[] = [];
  let exitCode: number | undefined;
  const logSpy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  const errSpy = spyOn(console, 'error').mockImplementation(() => {});
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => { exitCode = code; throw new Error('__exit__'); }) as never);
  try {
    await withEnv(env, () => runDream(engine, args)).catch((e: Error) => { if (e.message !== '__exit__') throw e; });
  } finally { exitSpy.mockRestore(); logSpy.mockRestore(); errSpy.mockRestore(); }
  return { out, exitCode };
}

/** A chat seam that runs every call through the real claude-cli adapter. */
async function cliChat(seen: Array<AbortSignal | undefined>) {
  const { ClaudeCliLanguageModel } = await import('../src/core/ai/providers/claude-cli-language-model.ts');
  const model = new ClaudeCliLanguageModel('claude-haiku-4-5');
  return async (o: ChatOpts): Promise<ChatResult> => {
    seen.push(o.abortSignal);
    await model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'slow' }] }], abortSignal: o.abortSignal } as never);
    throw new Error('stub child exited without being aborted');
  };
}

describe('W1: the window alone interrupts the in-flight provider call', () => {
  test('kills the child, defers the item without a strike, frees the lock, reports window', async () => {
    await seedPages(3);
    const { bin, pidFile } = stubClaude(0);
    const seen: Array<AbortSignal | undefined> = [];
    const started = Date.now();
    const result = await withEnv({ GBRAIN_CLAUDE_CLI_BIN: bin }, async () =>
      runExtractAtomsDrainForSource(engine, {
        // No `signal`: exactly the CLI's situation.
        sourceId: undefined, windowSeconds: 1, _phase: { _chat: await cliChat(seen), _transcripts: [] },
      }));
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(10_000); // the child sleeps 30s; the window is 1s
    expect(seen).toHaveLength(1);
    expect(seen[0]?.aborted).toBe(true);
    expect((seen[0]?.reason as Error).message).toBe(DRAIN_WINDOW_ELAPSED);
    expect(await childGone(pidFile)).toBe(true);
    expect(result).toMatchObject({
      status: 'ok', stopped: 'window', items_completed: 0, items_deferred: 3, failure_count: 0, remaining: 3,
    });
    expect(await atomCount()).toBe(0);
    expect(await strikeCount()).toBe(0);
    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(3);
    expect(await lockIsFree(cycleLockIdFor(undefined))).toBe(true);
  }, 20_000);

  test('an external cancel mid-call still reports aborted, not window', async () => {
    await seedPages(2);
    const { bin, pidFile } = stubClaude(0);
    const seen: Array<AbortSignal | undefined> = [];
    const ac = new AbortController();
    const poll = setInterval(() => { if (existsSync(pidFile)) { clearInterval(poll); ac.abort(new Error('cancel')); } }, 20);
    try {
      const result = await withEnv({ GBRAIN_CLAUDE_CLI_BIN: bin }, async () =>
        runExtractAtomsDrainForSource(engine, {
          sourceId: undefined, windowSeconds: 3600, signal: ac.signal, _phase: { _chat: await cliChat(seen), _transcripts: [] },
        }));
      expect((seen[0]?.reason as Error).message).toBe('cancel');
      expect(await childGone(pidFile)).toBe(true);
      expect(result).toMatchObject({ stopped: 'aborted', items_completed: 0, items_deferred: 2, failure_count: 0 });
    } finally { clearInterval(poll); }
  }, 20_000);
});

describe('W2/W4: the real handler under the configured claude-cli model', () => {
  test('one item completes, the window cuts the next mid-call, and a bounded continuation is queued', async () => {
    await seedPages(3);
    await engine.setConfig('models.dream.extract_atoms', 'claude-cli:claude-haiku-4-5');
    const { bin, pidFile } = stubClaude(1);
    const job = await queue.add('extract-atoms-drain', { sourceId: 'default', window: 2 },
      { queue: 'default', max_attempts: 3 }, { allowProtectedSubmit: true });
    const handler = await drainHandler();
    const started = Date.now();
    const result = await withEnv({ GBRAIN_CLAUDE_CLI_BIN: bin }, () =>
      handler({ id: job.id, data: job.data, signal: new AbortController().signal } as never)) as Record<string, unknown>;
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(await childGone(pidFile)).toBe(true);
    expect(result).toMatchObject({
      status: 'ok', stopped: 'window', items_completed: 1, items_deferred: 2, failure_count: 0, remaining: 2,
    });
    expect(result.continuation).toMatchObject({ queued: true, depth: 1 });
    const rows = await engine.executeRaw<{ id: number; data: unknown }>(
      "SELECT id, data FROM minion_jobs WHERE data ? 'continuation_of'");
    expect(rows).toHaveLength(1);
    const data = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
    expect(data).toMatchObject({ continuation_of: job.id, continuation_depth: 1, sourceId: 'default' });
    expect(Number(rows[0].id)).toBe((result.continuation as { job_id: number }).job_id);
    expect(await atomCount()).toBe(1);
    // The finished page carries its completion stamp; nothing else was touched.
    expect(await engine.executeRaw('SELECT fail_count FROM extract_atoms_page_state')).toEqual([{ fail_count: 0 }]);
    expect(await strikeCount()).toBe(0);
    expect(await lockIsFree(cycleLockIdFor('default'))).toBe(true);
  }, 30_000);

  test('an external cancel mid-call fails the job with the receipt and queues nothing', async () => {
    await seedPages(2);
    await engine.setConfig('models.dream.extract_atoms', 'claude-cli:claude-haiku-4-5');
    const { bin, pidFile } = stubClaude(0);
    const job = await queue.add('extract-atoms-drain', { sourceId: 'default', window: 3600 },
      { queue: 'default', max_attempts: 3 }, { allowProtectedSubmit: true });
    const handler = await drainHandler();
    const ac = new AbortController();
    const poll = setInterval(() => { if (existsSync(pidFile)) { clearInterval(poll); ac.abort(new Error('timeout')); } }, 20);
    try {
      await withEnv({ GBRAIN_CLAUDE_CLI_BIN: bin }, () =>
        expect(handler({ id: job.id, data: job.data, signal: ac.signal } as never))
          .rejects.toThrow(/aborted \(timeout\) after 0 item\(s\) completed; 2 deferred/));
    } finally { clearInterval(poll); }
    expect(await childGone(pidFile)).toBe(true);
    expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE data ? 'continuation_of'")).toEqual([]);
    expect(await lockIsFree(cycleLockIdFor('default'))).toBe(true);
  }, 30_000);
});

describe('W3: the CLI prints the truthful incomplete receipt', () => {
  test('dream --drain --window 1 --json: window, deferred, exit 3', async () => {
    await seedPages(2);
    await engine.setConfig('models.dream.extract_atoms', 'claude-cli:claude-haiku-4-5');
    const { bin, pidFile } = stubClaude(0);
    const started = Date.now();
    const { out, exitCode } = await runDreamCaptured(['--drain', '--window', '1', '--json'], { GBRAIN_CLAUDE_CLI_BIN: bin });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(exitCode).toBe(3);
    expect(await childGone(pidFile)).toBe(true);
    const receipt = JSON.parse(out.join('\n'));
    expect(receipt).toMatchObject({
      status: 'ok', stopped: 'window', items_completed: 0, items_deferred: 2, failure_count: 0, remaining: 2,
    });
    expect(await lockIsFree(cycleLockIdFor(undefined))).toBe(true);
    expect(await lockIsFree(cycleLockIdFor('default'))).toBe(true);
  }, 30_000);
});

describe('W5: a lock-busy continuation under a real worker keeps its attempts', () => {
  test('the worker returns it to delayed with attempts_made unchanged', async () => {
    await engine.executeRaw('DELETE FROM minion_lease_pressure_log');
    const held = await tryAcquireDbLock(engine, cycleLockIdFor('default'), 5);
    expect(held).not.toBeNull();
    const worker = new MinionWorker(engine, { pollInterval: 10, healthCheckInterval: 0, stalledInterval: 60_000 });
    try {
      await registerBuiltinHandlers(worker, engine, { quiet: true });
      const cont = await queue.add('extract-atoms-drain',
        { sourceId: 'default', window: 60, continuation_of: 1, continuation_depth: 1 },
        { queue: 'default', max_attempts: 3 }, { allowProtectedSubmit: true });
      const running = worker.start();
      let row: { status: string; attempts_made: number; attempts_started: number } | undefined;
      for (let i = 0; i < 300; i++) {
        [row] = await engine.executeRaw<{ status: string; attempts_made: number; attempts_started: number }>(
          'SELECT status, attempts_made, attempts_started FROM minion_jobs WHERE id = $1', [cont.id]);
        if (row && row.attempts_started > 0 && row.status === 'delayed') break;
        await new Promise(r => setTimeout(r, 20));
      }
      await worker.stop(); await running;
      expect(row).toMatchObject({ status: 'delayed', attempts_made: 0 });
      expect(Number(row!.attempts_started)).toBeGreaterThanOrEqual(1);
      // A scheduling deferral (JobDeferredError), not a failure or lease
      // pressure: the caller's 30s delay, no stacktrace growth, no audit row.
      const [detail] = await engine.executeRaw<{ stacktrace: unknown; error_text: string; delay_ms: number }>(
        `SELECT stacktrace, error_text, (EXTRACT(EPOCH FROM (delay_until - now())) * 1000)::float8 AS delay_ms
           FROM minion_jobs WHERE id = $1`, [cont.id]);
      expect(detail.stacktrace === null || (Array.isArray(detail.stacktrace) && detail.stacktrace.length === 0)).toBe(true);
      expect(detail.error_text).toContain('cycle lock busy');
      expect(detail.delay_ms).toBeGreaterThan(25_000);
      const [pressure] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM minion_lease_pressure_log');
      expect(Number(pressure.n)).toBe(0);
    } finally { await held!.release(); }
  }, 30_000);
});

describe('W6: dream --drain --dry-run never reports a transcript backlog as clear', () => {
  async function seedCorpus(): Promise<void> {
    const dir = mkdtempSync(join(root, 'sessions-'));
    writeFileSync(join(dir, '2026-01-01-session.txt'), 'Synthetic session about a generic topic. '.repeat(80));
    await engine.setConfig('dream.synthesize.session_corpus_dir', dir);
  }

  test('transcript-only backlog: exit 3 with transcripts_remaining in the payload', async () => {
    await seedCorpus();
    const { out, exitCode } = await runDreamCaptured(['--drain', '--dry-run', '--json', '--dir', root]);
    expect(exitCode).toBe(3);
    expect(JSON.parse(out.join('\n'))).toMatchObject({
      dry_run: true, remaining: 0, transcripts_remaining: 1, items_completed: 0, items_deferred: 0,
    });
    expect(await engine.executeRaw('SELECT id FROM minion_jobs')).toEqual([]);
  }, 20_000);

  test('a failed transcript count (null) is incomplete, never drained', async () => {
    const count = spyOn(extractAtoms, 'countPendingTranscripts').mockResolvedValue(null);
    try {
      const { out, exitCode } = await runDreamCaptured(['--drain', '--dry-run', '--dir', root]);
      expect(exitCode).toBe(3);
      expect(out.join('\n')).toContain('[drain] dry-run: 0 page(s) + ? transcript(s) eligible');
    } finally { count.mockRestore(); }
  }, 20_000);

  test('an empty brain and corpus exits 0', async () => {
    const { exitCode } = await runDreamCaptured(['--drain', '--dry-run', '--dir', root]);
    expect(exitCode).toBeUndefined();
  }, 20_000);
});
