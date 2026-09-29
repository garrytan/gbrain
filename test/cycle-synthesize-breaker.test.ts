/**
 * Paid-loop breaker at the synthesize phase: a transcript key whose
 * submissions died 3 times in 24h is refused before any job row is inserted,
 * with the reset command in the cycle's skip report. Same keyless PGLite rig
 * as cycle-synthesize-daily-cap.test.ts.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { runPhaseSynthesize, TRIAGE_VERSION } from '../src/core/cycle/synthesize.ts';
import { TIER_DEFAULTS } from '../src/core/model-config.ts';

// Canonical shared-engine block (check-test-isolation R3/R4).
let engine: PGLiteEngine;
let schemaVersion: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
  // resetPgliteState truncates `config`, wiping the `version` row that
  // MinionQueue.ensureSchema checks. Capture it so beforeEach can restore.
  schemaVersion = (await engine.getConfig('version')) ?? '7';
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
});

interface Rig {
  engine: PGLiteEngine;
  brainDir: string;
  corpusDir: string;
  cleanup: () => Promise<void>;
}

/** Per-test dirs + dream config on the SHARED engine (reset by beforeEach). */
async function setupRig(): Promise<Rig> {
  const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-breaker-brain-'));
  const corpusDir = mkdtempSync(join(tmpdir(), 'gbrain-breaker-corpus-'));
  await engine.setConfig('dream.synthesize.enabled', 'true');
  await engine.setConfig('dream.synthesize.session_corpus_dir', corpusDir);
  return {
    engine,
    brainDir,
    corpusDir,
    cleanup: async () => {
      try { rmSync(brainDir, { recursive: true, force: true }); } catch { /* */ }
      try { rmSync(corpusDir, { recursive: true, force: true }); } catch { /* */ }
    },
  };
}

async function withSubagentAutoCancel<T>(
  engine: PGLiteEngine,
  body: () => Promise<T>,
  opts: { excludeQueue?: string } = {},
): Promise<T> {
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      await new Promise(r => setTimeout(r, 50));
      try {
        // excludeQueue: deliberately-seeded fixture rows must be handled by
        // the code under test, not this poller (a poller cancel changes the
        // row's coalescibility and races the assertion).
        await engine.executeRaw(
          `UPDATE minion_jobs
              SET status = 'cancelled', finished_at = now()
            WHERE name = 'subagent' AND status IN ('waiting', 'active')
              AND ($1::text IS NULL OR queue <> $1)`,
          [opts.excludeQueue ?? null],
        );
      } catch { /* race against shutdown is fine */ }
    }
  })();
  try {
    return await body();
  } finally {
    stopped = true;
    await loop;
  }
}

/** Write a small transcript + seed a passing triage-v1 verdict for it. */
async function seedPassingFile(rig: Rig, name: string): Promise<string> {
  const content = `conversation in ${name}\n`.repeat(200);
  const filePath = join(rig.corpusDir, name);
  writeFileSync(filePath, content);
  const hash = createHash('sha256').update(content, 'utf8').digest('hex');
  await rig.engine.putDreamVerdict(filePath, hash, {
    worth_processing: true,
    reasons: ['seed'],
    score: 0.9,
    content_type: null,
    segments: [],
    entities: [],
    model: TIER_DEFAULTS.utility,
    triage_version: TRIAGE_VERSION,
  });
  return filePath;
}

/** Seed a recent (or old) synth-v2 submission row for the cap counter. */
async function seedSubmissionRow(rig: Rig, opts: { ageHours?: number; status?: string; sourceId?: string; tag: string }): Promise<void> {
  await rig.engine.executeRaw(
    `INSERT INTO minion_jobs (submission_authority, name, queue, status, data, idempotency_key, created_at)
     VALUES ('{"version":1,"kind":"application"}'::jsonb, 'subagent', 'dream-inline-old-run', $1,
             jsonb_build_object('source_id', $2::text),
             $3,
             now() - ($4 || ' hours')::interval)`,
    [opts.status ?? 'waiting', opts.sourceId ?? 'default',
     `dream:synth-v2:default:filename:${opts.tag}:0123456789abcdef`,
     String(opts.ageHours ?? 1)],
  );
}

interface CapDetails {
  children_submitted: number;
  skips: Array<{ filePath: string; reason: string }>;
}

async function runPhase(
  rig: Rig,
  opts: { date?: string; excludeQueue?: string; now?: () => Date } = {},
): Promise<CapDetails> {
  // No key + isolated GBRAIN_HOME: every seeded verdict is a cache hit, so no
  // judge call happens; the env isolation is belt-and-suspenders against a
  // dev machine whose config file carries a real key.
  const { excludeQueue, ...phaseOpts } = opts;
  const tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-breaker-isol-'));
  try {
    const result = await withEnv({ ANTHROPIC_API_KEY: undefined, GBRAIN_HOME: tmpHome }, () =>
      withSubagentAutoCancel(rig.engine, () =>
        runPhaseSynthesize(rig.engine, { brainDir: rig.brainDir, dryRun: false, ...phaseOpts }),
      { excludeQueue }));
    // CDX-4 (#4217 family): in this keyless harness every submitted child
    // dies, and an all-children-dead run is now an honest phase failure
    // (fan-out details preserved). Zero-submission runs still report 'ok'.
    // This suite's subject is the CAP accounting in details, not the phase
    // verdict.
    if (result.status !== 'ok') {
      expect(result.error?.code).toBe('SYNTH_ALL_CHILDREN_DEAD');
    }
    return result.details as unknown as CapDetails;
  } finally {
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
  }
}


function keyFor(name: string): string {
  const content = `conversation in ${name}\n`.repeat(200);
  const hash16 = createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
  return `dream:synth-v2:default:filename:${name}:${hash16}`;
}

async function seedDead(rig: Rig, key: string, queue: string): Promise<void> {
  await rig.engine.executeRaw(
    `INSERT INTO minion_jobs (submission_authority, name, queue, status, data, idempotency_key, created_at, finished_at)
     VALUES ('{"version":1,"kind":"application"}'::jsonb, 'subagent', $1, 'dead', $2::text::jsonb, NULL, now() - interval '1 hour', now() - interval '1 hour')`,
    [queue, JSON.stringify({ source_id: 'default', __released_idempotency_key: key })],
  );
}

async function liveRows(rig: Rig, key: string): Promise<number> {
  const rows = await rig.engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM minion_jobs WHERE idempotency_key = $1`, [key]);
  return rows[0]!.n;
}

describe('synthesize paid-loop breaker', () => {
  test('after three dead submissions the fourth is refused before any job row is inserted', async () => {
    const rig = await setupRig();
    try {
      const looping = await seedPassingFile(rig, '2026-08-10-loop.txt');
      await seedPassingFile(rig, '2026-08-11-fresh.txt');
      for (const queue of ['dream-inline-1', 'dream-inline-2', 'dream-inline-3']) await seedDead(rig, keyFor('2026-08-10-loop.txt'), queue);
      const details = await runPhase(rig);
      expect(details.children_submitted).toBe(1);
      expect(await liveRows(rig, keyFor('2026-08-10-loop.txt'))).toBe(0);
      const refusal = details.skips.find(s => s.filePath === looping)!;
      expect(refusal.reason).toStartWith('dream_breaker_tripped: 3 dead submissions');
      expect(refusal.reason).toContain(`gbrain dream reset-key '${keyFor('2026-08-10-loop.txt')}'`);
    } finally { await rig.cleanup(); }
  }, 60_000);

  test('two dead submissions still submit; a reset re-enables a tripped key', async () => {
    const rig = await setupRig();
    try {
      await seedPassingFile(rig, '2026-08-12-two.txt');
      for (const queue of ['dream-inline-1', 'dream-inline-2']) await seedDead(rig, keyFor('2026-08-12-two.txt'), queue);
      expect((await runPhase(rig)).children_submitted).toBe(1);
      await rig.engine.executeRaw(`DELETE FROM minion_jobs WHERE status <> 'dead'`);
      await seedDead(rig, keyFor('2026-08-12-two.txt'), 'dream-inline-3');
      expect((await runPhase(rig)).children_submitted).toBe(0);
      const { resetDreamBreakerKey } = await import('../src/core/cycle/dream-breaker.ts');
      await resetDreamBreakerKey(rig.engine, keyFor('2026-08-12-two.txt'));
      expect((await runPhase(rig)).children_submitted).toBe(1);
    } finally { await rig.cleanup(); }
  }, 90_000);

  test('the daily cap counts dead rows whose key the queue released', async () => {
    const rig = await setupRig();
    try {
      await rig.engine.setConfig('dream.synthesize.max_submissions_per_source_per_day', '2');
      await rig.engine.setConfig('dream.breaker.max_dead_submissions', '0');
      await seedPassingFile(rig, '2026-08-13-capped.txt');
      for (const queue of ['dream-inline-1', 'dream-inline-2']) await seedDead(rig, 'dream:synth-v2:default:filename:other.txt:0123456789abcdef', queue);
      const details = await runPhase(rig);
      expect(details.children_submitted).toBe(0);
      expect(details.skips.some(s => s.reason.startsWith('daily_cap_reached: 2/2'))).toBe(true);
    } finally { await rig.cleanup(); }
  }, 60_000);
});
