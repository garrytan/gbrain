/**
 * Bounded extract_atoms drain — review-blocker regressions (PGLite).
 *
 *  R1: the Minion job's AbortSignal (timeout / cancel / pause) reaches the
 *      drain loop, every item checkpoint and the in-flight provider call —
 *      a claude-cli child is killed, the interrupted item stays due with no
 *      failure strike, the cycle lock is released, and a stopped parent
 *      never queues a continuation.
 *  R2: provider-failure truth is whole-run. A lone failing transcript after
 *      real progress is incomplete work (status ok, no_progress), not an
 *      outage; a run that completed nothing and failed every attempt stays
 *      provider_failure, even when the window defers the unattempted rest.
 *  R3: a continuation that meets a busy source cycle lock is requeued (no
 *      attempt burned), not completed `skipped` until the next UTC day.
 *  R4: same-source suppression ignores managed-atom retries and paused jobs.
 *  R5: autopilot's due check does not read the transcript corpus on a
 *      healthy tick, stays quiet, and still sees transcript-only backlog.
 *
 * Hermetic: generic fixtures, temp dirs, stubbed chat / stub claude binary.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { LanguageModelV2CallOptions } from '@ai-sdk/provider';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { RateLeaseUnavailableError } from '../src/core/minions/rate-leases.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import { tryAcquireDbLock } from '../src/core/db-lock.ts';
import { cycleLockIdFor } from '../src/core/cycle.ts';
import { countExtractAtomsBacklog } from '../src/core/cycle/extract-atoms.ts';
import {
  queueDrainContinuation,
  runExtractAtomsDrainForSource,
  type ExtractAtomsDrainResult,
} from '../src/core/cycle/extract-atoms-drain.ts';
import {
  dispatchAutoDrains,
  inFlightDrainId,
  pendingTranscriptsForDueCheck,
  TRANSCRIPT_BACKLOG_KEY,
} from '../src/core/cycle/extract-atoms-auto-drain.ts';
import * as discovery from '../src/core/cycle/transcript-discovery.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;
let root: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  queue = new MinionQueue(engine);
}, 60_000);

afterAll(async () => { await engine.disconnect(); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

beforeEach(async () => {
  for (const sql of [
    'DELETE FROM minion_jobs', 'DELETE FROM pages', 'DELETE FROM extract_atoms_page_state',
    'DELETE FROM extract_atoms_transcript_state', "DELETE FROM sources WHERE id <> 'default'",
    "UPDATE sources SET local_path = NULL WHERE id = 'default'",
    "DELETE FROM config WHERE key LIKE 'autopilot.auto_drain.%' OR key LIKE 'dream.%'",
  ]) await engine.executeRaw(sql);
  root = mkdtempSync(join(tmpdir(), 'gbrain-drain-fixes-'));
});

const FILLER = (label: string) => `Synthetic evidence for ${label} with enough source detail for extraction. `.repeat(20);

async function seedPages(n: number, prefix = 'meetings/fix-example'): Promise<string[]> {
  const slugs: string[] = [];
  for (let i = 1; i <= n; i++) {
    const slug = `${prefix}-${i}`;
    await engine.putPage(slug, { title: slug, type: 'meeting', compiled_truth: FILLER(slug), timeline: '' });
    slugs.push(slug);
  }
  return slugs;
}

function okResult(label: string): ChatResult {
  const text = JSON.stringify([{ title: `Fix lesson ${label.split('/').pop()}`, atom_type: 'insight', body: 'A generic lesson.' }]);
  return {
    text, blocks: [{ type: 'text', text }], stopReason: 'end', model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic',
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
  };
}
const labelOf = (o: ChatOpts) => /^Source: (\S+)/.exec(String((o.messages[0] as { content: unknown }).content))?.[1] ?? 'x';

async function atomCount(): Promise<number> {
  const [r] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE type = 'atom' AND deleted_at IS NULL");
  return Number(r.n);
}

async function lockIsFree(id: string): Promise<boolean> {
  const h = await tryAcquireDbLock(engine, id, 1);
  if (!h) return false;
  await h.release();
  return true;
}

function drainHandler() {
  const worker = new MinionWorker(engine);
  return registerBuiltinHandlers(worker, engine, { quiet: true }).then(() => worker.getHandler('extract-atoms-drain')!);
}

const windowCut = (over: Partial<ExtractAtomsDrainResult> = {}): ExtractAtomsDrainResult => ({
  phase: 'extract_atoms', status: 'ok', extracted: 2, skipped: 0, remaining: 3, transcripts_remaining: 0,
  batches: 1, items_completed: 2, items_deferred: 1, stopped: 'window', failure_count: 0, failures: [],
  omitted_failure_count: 0, last_error: null, ...over,
});

async function drainJob(data: Record<string, unknown> = { sourceId: 'default', window: 120 }) {
  return queue.add('extract-atoms-drain', data, { queue: 'default', max_attempts: 3 }, { allowProtectedSubmit: true });
}

describe('R1: cancellation reaches the checkpoint, the provider child and the chain', () => {
  test('aborting mid-call kills the claude-cli child, defers the item, releases the lock, strikes nothing', async () => {
    await seedPages(3);
    const bin = join(root, 'claude');
    const pidFile = join(root, 'child.pid');
    // `exec` so the recorded pid IS the process the adapter spawned and must kill.
    writeFileSync(bin, ['#!/bin/sh', `echo $$ > "${pidFile}"`, 'exec sleep 30'].join('\n'));
    chmodSync(bin, 0o755);
    const ac = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const result = await withEnv({ GBRAIN_CLAUDE_CLI_BIN: bin }, async () => {
      const { ClaudeCliLanguageModel } = await import('../src/core/ai/providers/claude-cli-language-model.ts');
      const model = new ClaudeCliLanguageModel('claude-haiku-4-5');
      const chat = async (o: ChatOpts): Promise<ChatResult> => {
        seen.push(o.abortSignal);
        await model.doGenerate({
          prompt: [{ role: 'user', content: [{ type: 'text', text: 'slow' }] }], abortSignal: o.abortSignal,
        } as LanguageModelV2CallOptions);
        throw new Error('stub child exited without being aborted');
      };
      // Abort once the child is actually running (the Minion timeout/cancel path).
      const poll = setInterval(() => { if (existsSync(pidFile)) { clearInterval(poll); ac.abort(new Error('timeout')); } }, 20);
      try {
        return await runExtractAtomsDrainForSource(engine, {
          sourceId: undefined, windowSeconds: 3600, signal: ac.signal, _phase: { _chat: chat, _transcripts: [] },
        });
      } finally { clearInterval(poll); }
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.aborted).toBe(true); // the job signal itself reached the provider call
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      try { process.kill(pid, 0); await new Promise(r => setTimeout(r, 40)); } catch { alive = false; }
    }
    expect(alive).toBe(false);
    expect(result).toMatchObject({
      status: 'ok', stopped: 'aborted', items_completed: 0, items_deferred: 3, failure_count: 0, remaining: 3,
    });
    // No ambiguous partial page: no atoms, no failure strike, all three still due.
    expect(await atomCount()).toBe(0);
    const [strikes] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM extract_atoms_page_state');
    expect(Number(strikes.n)).toBe(0);
    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(3);
    expect(await lockIsFree(cycleLockIdFor(undefined))).toBe(true);
  }, 20_000);

  test('an abort between items keeps completed work and stops before the next item', async () => {
    await seedPages(3);
    const ac = new AbortController();
    let calls = 0;
    const chat = async (o: ChatOpts): Promise<ChatResult> => {
      calls++;
      if (calls === 1) ac.abort(new Error('cancel')); // arrives while item 1 finishes
      return okResult(labelOf(o));
    };
    const result = await runExtractAtomsDrainForSource(engine, {
      sourceId: undefined, windowSeconds: 3600, signal: ac.signal, _phase: { _chat: chat, _transcripts: [] },
    });
    expect(calls).toBe(1);
    expect(result).toMatchObject({ stopped: 'aborted', items_completed: 1, items_deferred: 2, remaining: 2 });
    expect(await atomCount()).toBe(1);
  });

  test('the real handler fails an aborted run with a receipt, queues no continuation, and frees the lock', async () => {
    await seedPages(2);
    const job = await drainJob();
    const ac = new AbortController();
    ac.abort(new Error('timeout'));
    const handler = await drainHandler();
    await expect(handler({ id: job.id, data: job.data, signal: ac.signal } as never))
      .rejects.toThrow(/aborted \(timeout\) after 0 item\(s\) completed; .*2 page\(s\)/);
    expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE data ? 'continuation_of'")).toEqual([]);
    expect(await lockIsFree(cycleLockIdFor('default'))).toBe(true);
  }, 20_000);

  test('a stopped parent never chains: aborted signal, or a cancelled / dead / paused row', async () => {
    const aborted = new AbortController();
    aborted.abort(new Error('cancel'));
    const job = await drainJob();
    expect(await queueDrainContinuation(engine, { ...job, signal: aborted.signal }, windowCut()))
      .toEqual({ queued: false, reason: 'aborted' });
    expect(await queueDrainContinuation(engine, job, windowCut({ stopped: 'aborted' })))
      .toEqual({ queued: false, reason: 'aborted' });
    for (const status of ['cancelled', 'dead', 'paused']) {
      const parent = await drainJob();
      await engine.executeRaw('UPDATE minion_jobs SET status = $1 WHERE id = $2', [status, parent.id]);
      expect(await queueDrainContinuation(engine, parent, windowCut()))
        .toEqual({ queued: false, reason: 'aborted', parent_status: status });
    }
    expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE data ? 'continuation_of'")).toEqual([]);
  });
});

describe('R2: provider-failure truth is whole-run', () => {
  const transcript = (n: string) => ({
    filePath: join(tmpdir(), `fix-example-transcript-${n}.txt`),
    content: `Synthetic transcript ${n} with enough detail for extraction. `.repeat(20),
    contentHash: n.repeat(64).slice(0, 64),
  });
  const failingOn = (needle: string, message: string, counter: { calls: number }) =>
    async (o: ChatOpts): Promise<ChatResult> => {
      counter.calls++;
      if (String((o.messages[0] as { content: unknown }).content).includes(needle)) throw new Error(message);
      return okResult(labelOf(o));
    };

  for (const [kind, message] of [
    ['content-class', 'invalid_request_error: prompt is too long'],
    ['provider-class', 'upstream request timed out'],
  ] as const) {
    test(`a lone ${kind} failing transcript after real progress is incomplete, not an outage`, async () => {
      await seedPages(1);
      const c = { calls: 0 };
      const result = await runExtractAtomsDrainForSource(engine, {
        sourceId: undefined, windowSeconds: 3600,
        _phase: { _chat: failingOn('fix-example-transcript-p', message, c), _transcripts: [transcript('p')] },
      });
      expect(result).toMatchObject({
        status: 'ok', stopped: 'no_progress', items_completed: 1, extracted: 1,
        remaining: 0, transcripts_remaining: 1, items_deferred: 0,
      });
      expect(result.failure_count).toBeGreaterThanOrEqual(1);
      expect(c.calls).toBeLessThanOrEqual(3); // no hot loop on the poison item
    });
  }

  test('a run that completes nothing and fails every attempt stays provider_failure, whatever the error class', async () => {
    const c = { calls: 0 };
    const result = await runExtractAtomsDrainForSource(engine, {
      sourceId: undefined, windowSeconds: 3600,
      _phase: { _chat: failingOn('fix-example-transcript-q', 'invalid_request_error: prompt is too long', c), _transcripts: [transcript('q')] },
    });
    expect(result).toMatchObject({ status: 'provider_failure', stopped: 'provider_failure', items_completed: 0, transcripts_remaining: 1, failure_count: 1 });
    expect(c.calls).toBe(1);
  });

  test('an all-failed provider-class run stays provider_failure when the window defers the rest', async () => {
    await seedPages(4);
    const clock = { t: 0 };
    const chat = async (): Promise<ChatResult> => { clock.t += 60_000; throw new Error('upstream request timed out'); };
    const result = await runExtractAtomsDrainForSource(engine, {
      sourceId: undefined, windowSeconds: 90, _now: () => clock.t, _phase: { _chat: chat, _transcripts: [] },
    });
    expect(result).toMatchObject({
      status: 'provider_failure', stopped: 'provider_failure', items_completed: 0, items_deferred: 2, failure_count: 2,
    });
  });
});

describe('R3: a continuation that meets a busy source cycle lock stays due', () => {
  test('continuation → requeue without burning an attempt; a root job keeps the skipped shape', async () => {
    const handler = await drainHandler();
    const held = await tryAcquireDbLock(engine, cycleLockIdFor('default'), 5);
    expect(held).not.toBeNull();
    try {
      const cont = await drainJob({ sourceId: 'default', window: 120, continuation_of: 1, continuation_depth: 1 });
      const err = await handler({ id: cont.id, data: cont.data, signal: new AbortController().signal } as never)
        .then(() => null, (e: unknown) => e);
      // The worker routes this class to releaseLeaseFullJob: delayed, attempts_made unchanged.
      expect(err).toBeInstanceOf(RateLeaseUnavailableError);
      expect((err as RateLeaseUnavailableError).retryInMs).toBe(30_000);
      expect((err as Error).message).toContain('extract-atoms-drain:cycle-lock:default');

      const rootJob = await drainJob();
      expect(await handler({ id: rootJob.id, data: rootJob.data, signal: new AbortController().signal } as never))
        .toEqual({ phase: 'extract_atoms', status: 'skipped', deferred: true, reason: 'cycle_already_running' });
    } finally { await held!.release(); }
  }, 20_000);
});

describe('R4: same-source suppression counts only drains that will run', () => {
  test('managed-atom retries and paused drains do not suppress; a waiting drain does', async () => {
    const parent = await drainJob();
    const retry = await drainJob({ sourceId: 'default', retryRequestId: 'retry-example-1' });
    const paused = await drainJob();
    await engine.executeRaw("UPDATE minion_jobs SET status = 'paused' WHERE id = $1", [paused.id]);
    expect(await inFlightDrainId(engine, 'default', parent.id)).toBeNull();
    const cont = await queueDrainContinuation(engine, parent, windowCut());
    expect(cont).toMatchObject({ queued: true, depth: 1 });
    expect(retry.id).toBeGreaterThan(0);

    // A runnable (waiting) drain for the same source still suppresses: here
    // the first parent, which has not run yet, will do the work.
    const parent2 = await drainJob();
    expect(await queueDrainContinuation(engine, parent2, windowCut()))
      .toEqual({ queued: false, reason: 'already_in_flight', in_flight_job_id: parent.id });
  });
});

describe('R5: the due check does not read the corpus on a healthy tick', () => {
  async function seedCorpus(files: Record<string, string>): Promise<string> {
    const dir = mkdtempSync(join(root, 'sessions-'));
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    await engine.setConfig('dream.synthesize.session_corpus_dir', dir);
    await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
    return dir;
  }
  const session = (n: number) => `Synthetic session ${n} about a generic topic. `.repeat(80);
  const guarded = '---\ndream_generated: true\n---\n' + 'Generated synthesis output. '.repeat(120);

  test('reads once, then reuses the snapshot; a changed file or a new UTC day recounts; never noisy', async () => {
    const dir = await seedCorpus({ '2026-01-01-session.txt': session(1), '2026-01-02-dream.md': guarded });
    const reads = spyOn(discovery, 'discoverTranscripts');
    const stderr = spyOn(process.stderr, 'write');
    try {
      expect(await pendingTranscriptsForDueCheck(engine, root, '2026-09-25')).toBe(1);
      expect(reads.mock.calls.length).toBe(1);
      for (let i = 0; i < 3; i++) expect(await pendingTranscriptsForDueCheck(engine, root, '2026-09-25')).toBe(1);
      expect(reads.mock.calls.length).toBe(1); // healthy ticks: stat-only
      expect(stderr.mock.calls.map(c => String(c[0])).filter(l => l.includes('[dream]'))).toEqual([]);

      const f = join(dir, '2026-01-01-session.txt');
      writeFileSync(f, session(1) + ' More detail.');
      utimesSync(f, new Date(), new Date(Date.now() + 5_000));
      expect(await pendingTranscriptsForDueCheck(engine, root, '2026-09-25')).toBe(1);
      expect(reads.mock.calls.length).toBe(2);
      expect(await pendingTranscriptsForDueCheck(engine, root, '2026-09-26')).toBe(1);
      expect(reads.mock.calls.length).toBe(3);
    } finally {
      reads.mockRestore();
      stderr.mockRestore();
    }
  });

  test('no corpus configured: zero, without any read', async () => {
    const reads = spyOn(discovery, 'discoverTranscripts');
    try {
      expect(await pendingTranscriptsForDueCheck(engine, root, '2026-09-25')).toBe(0);
      expect(reads.mock.calls.length).toBe(0);
    } finally { reads.mockRestore(); }
  });

  test('transcript-only backlog still dispatches; the drain refreshes the snapshot so the next tick is quiet', async () => {
    await seedCorpus({ '2026-01-01-session.txt': session(1), '2026-01-02-session.txt': session(2) });
    const first = await dispatchAutoDrains(engine, queue, {});
    expect(first.dispatched).toHaveLength(1);
    expect(first.dispatched[0]).toMatchObject({ sourceId: 'default', backlog: { pages: 0, transcripts: 2 } });

    const result = await runExtractAtomsDrainForSource(engine, {
      sourceId: undefined, windowSeconds: 3600, brainDir: root, _phase: { _chat: async (o: ChatOpts) => okResult(labelOf(o)) },
    });
    expect(result).toMatchObject({ stopped: 'drained', transcripts_remaining: 0, items_completed: 2 });
    const snap = JSON.parse((await engine.getConfig(TRANSCRIPT_BACKLOG_KEY)) ?? '{}');
    expect(snap).toMatchObject({ pending: 0, day: new Date().toISOString().slice(0, 10) });

    const reads = spyOn(discovery, 'discoverTranscripts');
    try {
      expect(await pendingTranscriptsForDueCheck(engine, root, snap.day)).toBe(0);
      expect(reads.mock.calls.length).toBe(0);
    } finally { reads.mockRestore(); }
  });
});
