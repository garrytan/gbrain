/**
 * #4152 — opt-in per-source daily synthesis submission cap
 * (dream.synthesize.max_submissions_per_source_per_day, default 0 = disabled).
 *
 * PGLite, no API key required: verdicts are pre-seeded so the triage pass is
 * all cache hits, and submitted subagent jobs are auto-cancelled so the
 * phase's inline wait returns immediately.
 *
 * Run: bun test test/cycle-synthesize-daily-cap.test.ts
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
    `INSERT INTO minion_jobs (name, queue, status, data, idempotency_key, created_at)
     VALUES ('subagent', 'dream-inline-old-run', $1,
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
    return result.details as unknown as CapDetails;
  } finally {
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
  }
}

describe('cycle summary date (#4348)', () => {
  test('the phase buckets a UTC-evening run into the configured local day', async () => {
    const rig = await setupRig();
    try {
      await rig.engine.setConfig('cycle.timezone', 'Asia/Kolkata');
      await seedPassingFile(rig, '2026-08-19-boundary.txt');

      await runPhase(rig, {
        now: () => new Date('2026-08-19T21:30:00.000Z'),
      });

      expect(await rig.engine.getPage('dream-cycle-summaries/2026-08-20')).not.toBeNull();
      expect(await rig.engine.getPage('dream-cycle-summaries/2026-08-19')).toBeNull();
    } finally {
      await rig.cleanup();
    }
  }, 60_000);
});

describe('daily cap — default off (D2D)', () => {
  test('unset cap: every passing file submits, zero daily_cap skips', async () => {
    const rig = await setupRig();
    try {
      await seedPassingFile(rig, '2026-08-01-a.txt');
      await seedPassingFile(rig, '2026-08-02-b.txt');
      const details = await runPhase(rig);
      expect(details.children_submitted).toBe(2);
      expect(details.skips.filter(s => s.reason.startsWith('daily_cap'))).toHaveLength(0);
    } finally {
      await rig.cleanup();
    }
  }, 60_000);
});

describe('daily cap — engaged', () => {
  test('cap=1 with two passing files: one submits, one skips whole with daily_cap_reached', async () => {
    const rig = await setupRig();
    try {
      await rig.engine.setConfig('dream.synthesize.max_submissions_per_source_per_day', '1');
      await seedPassingFile(rig, '2026-08-01-a.txt');
      await seedPassingFile(rig, '2026-08-02-b.txt');
      const details = await runPhase(rig);
      expect(details.children_submitted).toBe(1);
      const capSkips = details.skips.filter(s => s.reason.startsWith('daily_cap_reached'));
      expect(capSkips).toHaveLength(1);
      expect(capSkips[0].reason).toMatch(/daily_cap_reached: 1\/1/);
    } finally {
      await rig.cleanup();
    }
  }, 60_000);

  test('24h window: a >24h-old submission row does not eat the budget', async () => {
    const rig = await setupRig();
    try {
      await rig.engine.setConfig('dream.synthesize.max_submissions_per_source_per_day', '1');
      await seedSubmissionRow(rig, { ageHours: 30, tag: 'old.txt' });
      await seedPassingFile(rig, '2026-08-03-c.txt');
      const details = await runPhase(rig);
      expect(details.children_submitted).toBe(1);
    } finally {
      await rig.cleanup();
    }
  }, 60_000);

  test('recent row within the window exhausts cap=1 → file skipped, cooldown NOT stamped (CX8)', async () => {
    const rig = await setupRig();
    try {
      await rig.engine.setConfig('dream.synthesize.max_submissions_per_source_per_day', '1');
      await seedSubmissionRow(rig, { ageHours: 1, tag: 'recent.txt' });
      await seedPassingFile(rig, '2026-08-04-d.txt');
      const details = await runPhase(rig);
      expect(details.children_submitted).toBe(0);
      expect(details.skips[0].reason).toMatch(/daily_cap_reached/);
      // CX8: a run that submitted nothing must not start the cooldown window —
      // that would suppress the retry that picks the capped files up.
      const ts = await rig.engine.getConfig('dream.synthesize.last_completion_ts');
      expect(ts ?? null).toBeNull();
    } finally {
      await rig.cleanup();
    }
  }, 60_000);

  test('cancelled rows are excluded from the count (retriage-cancelled jobs return budget)', async () => {
    const rig = await setupRig();
    try {
      await rig.engine.setConfig('dream.synthesize.max_submissions_per_source_per_day', '1');
      await seedSubmissionRow(rig, { ageHours: 1, status: 'cancelled', tag: 'cxl.txt' });
      await seedPassingFile(rig, '2026-08-05-e.txt');
      const details = await runPhase(rig);
      expect(details.children_submitted).toBe(1);
    } finally {
      await rig.cleanup();
    }
  }, 60_000);

  test('per-source scoping: another source’s recent rows do not count', async () => {
    const rig = await setupRig();
    try {
      await rig.engine.setConfig('dream.synthesize.max_submissions_per_source_per_day', '1');
      await seedSubmissionRow(rig, { ageHours: 1, sourceId: 'other-brain', tag: 'other.txt' });
      await seedPassingFile(rig, '2026-08-06-f.txt');
      const details = await runPhase(rig); // runs as source 'default'
      expect(details.children_submitted).toBe(1);
    } finally {
      await rig.cleanup();
    }
  }, 60_000);

  test('explicit-target bypass: --date runs ignore the cap (same rule as cooldown)', async () => {
    const rig = await setupRig();
    try {
      await rig.engine.setConfig('dream.synthesize.max_submissions_per_source_per_day', '1');
      await rig.engine.setConfig('cycle.timezone', 'America/Los_Angeles');
      await seedSubmissionRow(rig, { ageHours: 1, tag: 'recent.txt' }); // cap exhausted
      await seedPassingFile(rig, '2026-08-07-g.txt');
      const details = await runPhase(rig, {
        date: '2026-08-07',
        now: () => new Date('2040-01-02T12:00:00.000Z'),
      });
      expect(details.children_submitted).toBe(1);
      expect(details.skips.filter(s => s.reason.startsWith('daily_cap'))).toHaveLength(0);
      // #4348: explicit --date beats both the clock and the configured zone.
      expect(await rig.engine.getPage('dream-cycle-summaries/2026-08-07')).not.toBeNull();
      expect(await rig.engine.getPage('dream-cycle-summaries/2040-01-02')).toBeNull();
    } finally {
      await rig.cleanup();
    }
  }, 60_000);

  test('SR-P2: an exhausted cap does NOT strand a file whose keys already exist (idempotent retry)', async () => {
    const rig = await setupRig();
    try {
      await rig.engine.setConfig('dream.synthesize.max_submissions_per_source_per_day', '1');
      // Cap fully consumed by an unrelated recent submission…
      await seedSubmissionRow(rig, { ageHours: 1, tag: 'consumed.txt' });
      // …but THIS file's job already exists from a prior run that died
      // mid-drain (stranded in a dead inline queue). Re-running must reach
      // queue.add so coalesce/self-heal recovers it — zero NEW spend.
      const filePath = await seedPassingFile(rig, '2026-08-09-retry.txt');
      const content = `conversation in 2026-08-09-retry.txt\n`.repeat(200);
      const hash16 = createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
      const key = `dream:synth-v2:default:filename:${encodeURIComponent('2026-08-09-retry.txt')}:${hash16}`;
      await rig.engine.executeRaw(
        `INSERT INTO minion_jobs (name, queue, status, data, idempotency_key)
         VALUES ('subagent', 'dream-inline-1700000000000-deadbeef', 'waiting', '{}'::jsonb, $1)`,
        [key],
      );
      const details = await runPhase(rig, { excludeQueue: 'dream-inline-1700000000000-deadbeef' });
      // The file was NOT daily-cap skipped: self-heal cancelled the stranded
      // row and re-added into the live run's queue.
      expect(details.skips.filter(s => s.reason.startsWith('daily_cap'))).toHaveLength(0);
      expect(details.children_submitted).toBe(1);
      expect(filePath).toContain('2026-08-09-retry.txt');
    } finally {
      await rig.cleanup();
    }
  }, 60_000);

  test('fail-open: a throwing count query warns to stderr and skips the cap for the run', async () => {
    const rig = await setupRig();
    try {
      await rig.engine.setConfig('dream.synthesize.max_submissions_per_source_per_day', '1');
      await seedPassingFile(rig, '2026-08-08-h.txt');
      // Monkey-patch executeRaw to throw ONLY for the cap-count query.
      // MUST be a `function` delegating to the PROTOTYPE method with dynamic
      // `this`: PGLiteEngine.transaction builds its tx engine via
      // Object.create(this), which inherits own-property patches — a patch
      // closed over the OUTER engine would route tx queries to the main
      // connection and deadlock PGLite.
      const protoExecuteRaw = PGLiteEngine.prototype.executeRaw;
      (rig.engine as unknown as { executeRaw: unknown }).executeRaw =
        async function (this: PGLiteEngine, sql: string, params?: unknown[], opts?: never) {
          if (sql.includes(`idempotency_key LIKE 'dream:synth-v2:%'`) && sql.includes('COUNT(*)')) {
            throw new Error('simulated pool reap');
          }
          return protoExecuteRaw.call(this, sql, params, opts);
        };
      const stderrChunks: string[] = [];
      const origWrite = process.stderr.write.bind(process.stderr);
      // Spy with passthrough — swallowing stderr here hides real hang
      // diagnostics when the phase misbehaves.
      (process.stderr as unknown as { write: (c: unknown) => boolean }).write = (chunk: unknown) => {
        stderrChunks.push(String(chunk));
        return origWrite(chunk as never);
      };
      try {
        const details = await runPhase(rig);
        expect(details.children_submitted).toBe(1); // cap skipped, phase proceeded
      } finally {
        (process.stderr as unknown as { write: typeof origWrite }).write = origWrite;
        // Remove the own-property patch so the SHARED engine's prototype
        // method is restored for subsequent tests in this file.
        delete (rig.engine as unknown as { executeRaw?: unknown }).executeRaw;
      }
      expect(stderrChunks.join('')).toMatch(/daily-cap count query failed.*skipping the cap/s);
    } finally {
      await rig.cleanup();
    }
  }, 60_000);
});
