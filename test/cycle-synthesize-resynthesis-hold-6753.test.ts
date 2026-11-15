/**
 * #6753: a growing transcript (a live session) has a new content hash on every pass, so it was synthesized again in
 * full each time, and under a standing backlog the phase cooldown is never stamped, so nothing bounded it. Now a
 * transcript whose earlier version completed within dream.synthesize.cooldown_hours waits (`resynthesis_cooldown` in
 * skips and in the summary) and synthesizes once, whole, when the hold ends. A failed or partial earlier attempt
 * starts no hold.
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
  const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-cap-brain-'));
  const corpusDir = mkdtempSync(join(tmpdir(), 'gbrain-cap-corpus-'));
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
): Promise<CapDetails & { summary: string }> {
  // No key + isolated GBRAIN_HOME: every seeded verdict is a cache hit, so no
  // judge call happens; the env isolation is belt-and-suspenders against a
  // dev machine whose config file carries a real key.
  const { excludeQueue, ...phaseOpts } = opts;
  const tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-cap-isol-'));
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
    return { ...(result.details as unknown as CapDetails), summary: String(result.summary ?? '') };
  } finally {
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
  }
}


const NAME = '2026-08-01-live-session.txt';
const EARLIER = 'conversation turn\n'.repeat(200);
const earlierHash = createHash('sha256').update(EARLIER, 'utf8').digest('hex').slice(0, 16);

async function earlierAttempt(rig: Rig, opts: { status: string; finishedHoursAgo: number; suffix?: string }) {
  await rig.engine.executeRaw(`INSERT INTO minion_jobs (submission_authority, name, queue, status, data, idempotency_key, created_at, finished_at)
    VALUES ('{"version":1,"kind":"application"}'::jsonb, 'subagent', 'dream-inline-old-run', $1, jsonb_build_object('source_id','default'), $2,
      now() - (($3::numeric + 0.1) || ' hours')::interval, now() - ($3 || ' hours')::interval)`,
  [opts.status, `dream:synth-v2:default:filename:${NAME}:${earlierHash}${opts.suffix ?? ''}`, String(opts.finishedHoursAgo)]);
}
const held = (d: CapDetails) => d.skips.filter(s => s.reason.startsWith('resynthesis_cooldown'));

describe('#6753 per-transcript re-synthesis hold', () => {
  test('a grown transcript whose earlier version completed minutes ago waits, and the summary says so', async () => {
    const rig = await setupRig();
    try {
      await earlierAttempt(rig, { status: 'completed', finishedHoursAgo: 0.1 });
      await seedPassingFile(rig, NAME);
      const details = await runPhase(rig);
      expect(details.children_submitted).toBe(0);
      expect(held(details)).toHaveLength(1);
      expect(details.summary).toContain('held by resynthesis_cooldown');
    } finally { await rig.cleanup(); }
  }, 60_000);

  test('once the hold ends the current version is synthesized', async () => {
    const rig = await setupRig();
    try {
      await earlierAttempt(rig, { status: 'completed', finishedHoursAgo: 13 });
      await seedPassingFile(rig, NAME);
      const details = await runPhase(rig);
      expect(held(details)).toHaveLength(0);
      expect(details.children_submitted).toBe(1);
    } finally { await rig.cleanup(); }
  }, 60_000);

  test('a failed earlier attempt starts no hold', async () => {
    const rig = await setupRig();
    try {
      await earlierAttempt(rig, { status: 'failed', finishedHoursAgo: 0.1 });
      await seedPassingFile(rig, NAME);
      const details = await runPhase(rig);
      expect(held(details)).toHaveLength(0);
      expect(details.children_submitted).toBe(1);
    } finally { await rig.cleanup(); }
  }, 60_000);

  test('a partial chunk set starts no hold', async () => {
    const rig = await setupRig();
    try {
      await earlierAttempt(rig, { status: 'completed', finishedHoursAgo: 0.1, suffix: ':c0of2' });
      await seedPassingFile(rig, NAME);
      const details = await runPhase(rig);
      expect(held(details)).toHaveLength(0);
      expect(details.children_submitted).toBe(1);
    } finally { await rig.cleanup(); }
  }, 60_000);

  test('a cooldown of 0 turns the hold off', async () => {
    const rig = await setupRig();
    try {
      await rig.engine.setConfig('dream.synthesize.cooldown_hours', '0');
      await earlierAttempt(rig, { status: 'completed', finishedHoursAgo: 0.1 });
      await seedPassingFile(rig, NAME);
      const details = await runPhase(rig);
      expect(held(details)).toHaveLength(0);
      expect(details.children_submitted).toBe(1);
    } finally { await rig.cleanup(); }
  }, 60_000);
});
