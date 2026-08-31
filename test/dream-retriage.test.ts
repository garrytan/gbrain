/**
 * `gbrain dream retriage` (#4152) — PGLite-backed tests for the backlog
 * reconciliation matrix, the spend gate, and dispatch/usage errors.
 *
 * No LLM calls anywhere: every discovered transcript gets a pre-seeded
 * triage-v1 verdict (cache hits), or the test runs --dry-run (zero judge
 * calls by contract), or the spend gate aborts before judging.
 *
 * Run: bun test test/dream-retriage.test.ts
 */

import { describe, test, expect, afterEach, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, basename } from 'path';
import { createHash } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { runDreamRetriage } from '../src/commands/dream-retriage.ts';
import { runDream } from '../src/commands/dream.ts';
import { TRIAGE_VERSION, CHARS_PER_TOKEN } from '../src/core/cycle/synthesize.ts';
import { canonicalLookup } from '../src/core/model-pricing.ts';
import { SPEND_CONFIRM_USD } from '../src/commands/dream-retriage-constants.ts';
import { TIER_DEFAULTS } from '../src/core/model-config.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';

// Canonical shared-engine block (check-test-isolation R3/R4).
let sharedEngine: PGLiteEngine;
let schemaVersion: string;

beforeAll(async () => {
  sharedEngine = new PGLiteEngine();
  await sharedEngine.connect({ engine: 'pglite' } as never);
  await sharedEngine.initSchema();
  // resetPgliteState truncates `config`, wiping the `version` row that
  // MinionQueue.ensureSchema checks. Capture it so beforeEach can restore.
  schemaVersion = (await sharedEngine.getConfig('version')) ?? '7';
}, 60_000);

afterAll(async () => {
  await sharedEngine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(sharedEngine);
  await sharedEngine.setConfig('version', schemaVersion);
});

interface Rig {
  engine: PGLiteEngine;
  corpusDir: string;
  cleanup: () => Promise<void>;
}

/** Per-test corpus dir + dream config on the SHARED engine (reset by beforeEach). */
async function setupRig(): Promise<Rig> {
  const corpusDir = mkdtempSync(join(tmpdir(), 'gbrain-retriage-corpus-'));
  await sharedEngine.setConfig('dream.synthesize.enabled', 'true');
  await sharedEngine.setConfig('dream.synthesize.session_corpus_dir', corpusDir);
  return {
    engine: sharedEngine,
    corpusDir,
    cleanup: async () => {
      try { rmSync(corpusDir, { recursive: true, force: true }); } catch { /* */ }
    },
  };
}

function writeTranscript(corpusDir: string, name: string): { filePath: string; content: string; hash: string; hash16: string } {
  const content = `conversation in ${name}\n`.repeat(200);
  const filePath = join(corpusDir, name);
  writeFileSync(filePath, content);
  const hash = createHash('sha256').update(content, 'utf8').digest('hex');
  return { filePath, content, hash, hash16: hash.slice(0, 16) };
}

async function seedScore(rig: Rig, filePath: string, hash: string, score: number): Promise<void> {
  await rig.engine.putDreamVerdict(filePath, hash, {
    worth_processing: score >= 0.5,
    reasons: ['seed'],
    score,
    content_type: null,
    segments: [],
    entities: [],
    model: TIER_DEFAULTS.utility,
    triage_version: TRIAGE_VERSION,
  });
}

/** Seed a raw minion_jobs row (bypasses queue.add validators for full control). */
async function seedJob(rig: Rig, opts: {
  key: string;
  queue?: string;
  status?: string;
  sourceId?: string;
}): Promise<number> {
  const rows = await rig.engine.executeRaw<{ id: number }>(
    `INSERT INTO minion_jobs (name, queue, status, data, idempotency_key)
     VALUES ('subagent', $1, $2, jsonb_build_object('source_id', $3::text), $4)
     RETURNING id`,
    [opts.queue ?? 'dream-inline-1700000000000-deadbeef', opts.status ?? 'waiting', opts.sourceId ?? 'default', opts.key],
  );
  return rows[0].id;
}

function synthKey(sourceId: string, fileBasename: string, hash16: string, chunk?: string): string {
  const base = `dream:synth-v2:${encodeURIComponent(sourceId)}:filename:${encodeURIComponent(fileBasename)}:${hash16}`;
  return chunk ? `${base}:${chunk}` : base;
}

async function jobStatus(rig: Rig, id: number): Promise<string> {
  const rows = await rig.engine.executeRaw<{ status: string }>(`SELECT status FROM minion_jobs WHERE id = $1`, [id]);
  return rows[0].status;
}

async function captureStdout<T>(body: () => Promise<T>): Promise<{ result: T; out: string }> {
  const chunks: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => { chunks.push(args.map(String).join(' ')); };
  try {
    const result = await body();
    return { result, out: chunks.join('\n') };
  } finally {
    console.log = orig;
  }
}

/**
 * Hermeticity: run with ANTHROPIC_API_KEY cleared AND GBRAIN_HOME pointed at a
 * fresh tmpdir (hasAnthropicKey reads BOTH). Any cache MISS then degrades
 * per-file instead of hitting a live provider — a dev machine with a real key
 * must never spend money running this suite.
 */
async function withoutAnthropicKey<T>(body: () => Promise<T>): Promise<T> {
  const tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-retriage-isol-'));
  try {
    return await withEnv({ ANTHROPIC_API_KEY: undefined, GBRAIN_HOME: tmpHome }, body);
  } finally {
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
  }
}

afterEach(() => {
  process.exitCode = 0;
});

describe('dream retriage — dispatch + usage', () => {
  test('runDream dispatches args[0]===retriage; --help prints without engine', async () => {
    const { out } = await captureStdout(() => runDream(null, ['retriage', '--help']));
    expect(out).toContain('reconcile the synth backlog');
    expect(process.exitCode ?? 0).toBe(0);
  });

  test('unknown flag → exit code 2', async () => {
    await runDreamRetriage(null, ['--bogus']);
    expect(process.exitCode).toBe(2);
  });

  test('--threshold out of range → exit code 2; --cancel-unmatched without --reconcile-queue → exit code 2', async () => {
    await runDreamRetriage(null, ['--threshold', '1.5']);
    expect(process.exitCode).toBe(2);
    process.exitCode = 0;
    await runDreamRetriage(null, ['--cancel-unmatched']);
    expect(process.exitCode).toBe(2);
  });

  test('CX2: --cancel-unmatched cannot combine with --limit → exit code 2', async () => {
    await runDreamRetriage(null, ['--reconcile-queue', '--cancel-unmatched', '--limit', '5']);
    expect(process.exitCode).toBe(2);
  });

  test('CX3: --max-usd with an unpriced model → exit code 2, nothing judged', async () => {
    const rig = await setupRig();
    try {
      await rig.engine.setConfig('models.dream.triage', 'ollama:totally-unpriced-model');
      writeTranscript(rig.corpusDir, '2026-08-20-unpriced.txt');
      await withoutAnthropicKey(() => runDreamRetriage(rig.engine, ['--max-usd', '1', '--yes']));
      expect(process.exitCode).toBe(2);
      const rows = await rig.engine.executeRaw<{ n: number }>(`SELECT COUNT(*)::int AS n FROM dream_verdicts`);
      expect(rows[0].n).toBe(0);
    } finally {
      await rig.cleanup();
    }
  }, 30_000);

  test('no engine (non-help) → exit code 1; no corpus config → exit code 1', async () => {
    await runDreamRetriage(null, ['--dry-run']);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    // beforeEach reset the shared engine's config, so no corpus dir is set.
    await runDreamRetriage(sharedEngine, ['--dry-run']);
    expect(process.exitCode).toBe(1);
  });
});

describe('dream retriage — reconcile matrix', () => {
  test('full matrix: below-threshold cancelled; above in stale queue converted; unmatched kept; legacy untouched; completed untouched', async () => {
    const rig = await setupRig();
    try {
      const below = writeTranscript(rig.corpusDir, '2026-08-01-logistics.txt');
      const above = writeTranscript(rig.corpusDir, '2026-08-02-thesis.txt');
      const unscored = writeTranscript(rig.corpusDir, '2026-08-03-new.txt');
      await seedScore(rig, below.filePath, below.hash, 0.2);
      await seedScore(rig, above.filePath, above.hash, 0.9);
      // `unscored` gets NO verdict → dry-run-style needs_triage; matched-but-unscored is kept.

      const belowJob = await seedJob(rig, { key: synthKey('default', basename(below.filePath), below.hash16) });
      const aboveStale = await seedJob(rig, { key: synthKey('default', basename(above.filePath), above.hash16) });
      const unscoredJob = await seedJob(rig, { key: synthKey('default', basename(unscored.filePath), unscored.hash16) });
      const unmatchedJob = await seedJob(rig, { key: synthKey('default', 'deleted-file.txt', 'aaaaaaaaaaaaaaaa') });
      const legacyJob = await seedJob(rig, { key: 'dream:synth:/old/path.txt:0123456789abcdef' });
      const completedJob = await seedJob(rig, { key: synthKey('default', basename(below.filePath), below.hash16, 'c0of2'), status: 'completed' });

      // All verdicts are cache hits → zero judge calls even without --dry-run.
      const { out } = await captureStdout(() => withoutAnthropicKey(() => runDreamRetriage(rig.engine, ['--reconcile-queue', '--json'])));
      const summary = JSON.parse(out) as { queue: Record<string, unknown>; retriaged: number };

      expect(summary.retriaged).toBe(0); // hits only — the third file degrades (no provider), never judged
      expect(await jobStatus(rig, belowJob)).toBe('cancelled');
      expect(await jobStatus(rig, aboveStale)).toBe('cancelled'); // converted_for_resubmit
      expect(await jobStatus(rig, unscoredJob)).toBe('waiting');
      expect(await jobStatus(rig, unmatchedJob)).toBe('waiting');
      // #4250: a legacy-grammar row stranded in a provably-DEAD inline queue
      // is exactly the never-claimable orphan class doctor now flags — it
      // converts for resubmit instead of being invisibly stranded (pre-fix it
      // wasn't even selected). Legacy rows in live/non-inline queues stay out
      // of scope (the SELECT's queue arm only adds dream-inline rows).
      expect(await jobStatus(rig, legacyJob)).toBe('cancelled');
      expect(await jobStatus(rig, completedJob)).toBe('completed'); // terminal rows never selected

      expect(summary.queue.cancelled).toBe(1);
      expect(summary.queue.converted_for_resubmit).toBe(2); // aboveStale + legacy dead-queue row
      expect(summary.queue.kept_unscored).toBe(1);
      expect(summary.queue.unmatched).toBe(1); // deleted-file synth-v2 key with no corpus match
      expect(summary.queue.candidates).toBe(5); // completed row is status-excluded
      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      await rig.cleanup();
    }
  }, 30_000);

  test('above-threshold in a LIVE (non dream-inline) queue is kept', async () => {
    const rig = await setupRig();
    try {
      const above = writeTranscript(rig.corpusDir, '2026-08-04-keeper.txt');
      await seedScore(rig, above.filePath, above.hash, 0.8);
      const liveJob = await seedJob(rig, {
        key: synthKey('default', basename(above.filePath), above.hash16),
        queue: 'default',
      });
      const { out } = await captureStdout(() => withoutAnthropicKey(() => runDreamRetriage(rig.engine, ['--reconcile-queue', '--json'])));
      const summary = JSON.parse(out) as { queue: { kept_above_threshold: number } };
      expect(await jobStatus(rig, liveJob)).toBe('waiting');
      expect(summary.queue.kept_above_threshold).toBe(1);
    } finally {
      await rig.cleanup();
    }
  }, 30_000);

  test('F2: a rescued-band job SURVIVES reconcile (the one-gate rule); the same score without segments cancels', async () => {
    const rig = await setupRig();
    try {
      const buried = writeTranscript(rig.corpusDir, '2026-08-05-buried.txt');
      const plain = writeTranscript(rig.corpusDir, '2026-08-06-plain.txt');
      // Verified segments: verbatim (normalized) substrings of the transcript,
      // each over the 40-normalized-char substantive bar and DISTINCT after
      // normalization (duplicates count once).
      const n = '2026-08-05-buried.txt';
      await rig.engine.putDreamVerdict(buried.filePath, buried.hash, {
        worth_processing: false,
        reasons: ['seed'],
        score: 0.35,
        content_type: 'mixed',
        segments: [
          { quote: `conversation in ${n}\nconversation in ${n}` },
          { quote: `in ${n} conversation in ${n} conversation` },
        ],
        entities: [],
        model: TIER_DEFAULTS.utility,
        triage_version: TRIAGE_VERSION,
      });
      await seedScore(rig, plain.filePath, plain.hash, 0.35); // same band, NO segments
      const rescuedJob = await seedJob(rig, { key: synthKey('default', basename(buried.filePath), buried.hash16), queue: 'default' });
      const plainJob = await seedJob(rig, { key: synthKey('default', basename(plain.filePath), plain.hash16), queue: 'default' });

      const { out } = await captureStdout(() => withoutAnthropicKey(() => runDreamRetriage(rig.engine, ['--reconcile-queue', '--json'])));
      const summary = JSON.parse(out) as { queue: { cancelled: number; kept_above_threshold: number }; reports?: Array<{ filePath: string; rescued?: boolean }> };

      expect(await jobStatus(rig, rescuedJob)).toBe('waiting');   // rescue admitted it — sweep must not cancel
      expect(await jobStatus(rig, plainJob)).toBe('cancelled');   // genuine reject
      expect(summary.queue.cancelled).toBe(1);
      expect(summary.queue.kept_above_threshold).toBe(1);
    } finally {
      await rig.cleanup();
    }
  }, 30_000);

  test('C9: key-source vs data.source_id mismatch is skipped, never cancelled', async () => {
    const rig = await setupRig();
    try {
      const below = writeTranscript(rig.corpusDir, '2026-08-05-mismatch.txt');
      await seedScore(rig, below.filePath, below.hash, 0.1);
      const mismatched = await seedJob(rig, {
        key: synthKey('other-source', basename(below.filePath), below.hash16),
        sourceId: 'default', // payload disagrees with the key's encoded source
      });
      const { out } = await captureStdout(() => withoutAnthropicKey(() => runDreamRetriage(rig.engine, ['--reconcile-queue', '--json'])));
      const summary = JSON.parse(out) as { queue: { source_mismatch: number } };
      expect(await jobStatus(rig, mismatched)).toBe('waiting');
      expect(summary.queue.source_mismatch).toBe(1);
    } finally {
      await rig.cleanup();
    }
  }, 30_000);

  test('--source scopes cancels: other sources counted as other_source, untouched', async () => {
    const rig = await setupRig();
    try {
      const below = writeTranscript(rig.corpusDir, '2026-08-06-scoped.txt');
      await seedScore(rig, below.filePath, below.hash, 0.1);
      const mine = await seedJob(rig, { key: synthKey('work', basename(below.filePath), below.hash16), sourceId: 'work' });
      const theirs = await seedJob(rig, { key: synthKey('personal', basename(below.filePath), below.hash16), sourceId: 'personal' });
      const { out } = await captureStdout(() =>
        withoutAnthropicKey(() => runDreamRetriage(rig.engine, ['--reconcile-queue', '--source', 'work', '--json'])));
      const summary = JSON.parse(out) as { queue: { cancelled: number; other_source: number } };
      expect(await jobStatus(rig, mine)).toBe('cancelled');
      expect(await jobStatus(rig, theirs)).toBe('waiting');
      expect(summary.queue.cancelled).toBe(1);
      expect(summary.queue.other_source).toBe(1);
    } finally {
      await rig.cleanup();
    }
  }, 30_000);

  test('--cancel-unmatched cancels jobs whose file no longer exists (corpus still reachable)', async () => {
    const rig = await setupRig();
    try {
      // CX2 guard requires a non-empty discovery result — seed one real file
      // so "the corpus is reachable" and only the ghost job is unmatched.
      const real = writeTranscript(rig.corpusDir, '2026-08-25-still-here.txt');
      await seedScore(rig, real.filePath, real.hash, 0.9);
      const gone = await seedJob(rig, { key: synthKey('default', 'vanished.txt', 'bbbbbbbbbbbbbbbb') });
      const { out } = await captureStdout(() =>
        withoutAnthropicKey(() => runDreamRetriage(rig.engine, ['--reconcile-queue', '--cancel-unmatched', '--json'])));
      const summary = JSON.parse(out) as { queue: { unmatched_cancelled: number } };
      expect(await jobStatus(rig, gone)).toBe('cancelled');
      expect(summary.queue.unmatched_cancelled).toBe(1);
    } finally {
      await rig.cleanup();
    }
  }, 30_000);

  test('--dry-run: reports would-cancel counts, performs ZERO cancels and zero judge calls', async () => {
    const rig = await setupRig();
    try {
      const below = writeTranscript(rig.corpusDir, '2026-08-07-dry.txt');
      const fresh = writeTranscript(rig.corpusDir, '2026-08-08-fresh.txt'); // no verdict → needs_triage
      await seedScore(rig, below.filePath, below.hash, 0.1);
      const belowJob = await seedJob(rig, { key: synthKey('default', basename(below.filePath), below.hash16) });
      const freshJob = await seedJob(rig, { key: synthKey('default', basename(fresh.filePath), fresh.hash16) });
      const { out } = await captureStdout(() =>
        withoutAnthropicKey(() => runDreamRetriage(rig.engine, ['--reconcile-queue', '--dry-run', '--json'])));
      const summary = JSON.parse(out) as { retriaged: number; needs_triage: number; queue: { cancelled: number } };
      expect(summary.retriaged).toBe(0);        // dry-run judges nothing
      expect(summary.needs_triage).toBe(1);
      expect(summary.queue.cancelled).toBe(1);  // would-cancel
      expect(await jobStatus(rig, belowJob)).toBe('waiting'); // ...but nothing actually cancelled
      expect(await jobStatus(rig, freshJob)).toBe('waiting');
    } finally {
      await rig.cleanup();
    }
  }, 30_000);

  test('cancelled row releases its idempotency slot: a later add with the same key creates a fresh row', async () => {
    const rig = await setupRig();
    try {
      const below = writeTranscript(rig.corpusDir, '2026-08-09-resubmit.txt');
      await seedScore(rig, below.filePath, below.hash, 0.1);
      const key = synthKey('default', basename(below.filePath), below.hash16);
      const oldId = await seedJob(rig, { key });
      await captureStdout(() => withoutAnthropicKey(() => runDreamRetriage(rig.engine, ['--reconcile-queue', '--json'])));
      expect(await jobStatus(rig, oldId)).toBe('cancelled');
      // Threshold lowered later → the same key must be re-submittable.
      const queue = new MinionQueue(rig.engine);
      const fresh = await queue.add('subagent', {
        prompt: 'x',
        model: 'anthropic:claude-sonnet-4-6',
        max_turns: 1,
      }, { idempotency_key: key }, { allowProtectedSubmit: true });
      expect(fresh.id).not.toBe(oldId);
      expect(fresh.status).toBe('waiting');
    } finally {
      await rig.cleanup();
    }
  }, 30_000);

  test('SR-P1: --max-usd + --audit-rejects with an unpriced SYNTHESIS model → exit 2', async () => {
    const rig = await setupRig();
    try {
      // Triage model priced; synthesis (audit) model unpriced — the audit's
      // budget share would be silently un-metered without the guard.
      await rig.engine.setConfig('models.dream.synthesize', 'ollama:unpriced-frontier');
      writeTranscript(rig.corpusDir, '2026-08-26-audit-unpriced.txt');
      await withoutAnthropicKey(() =>
        runDreamRetriage(rig.engine, ['--max-usd', '1', '--audit-rejects', '2', '--yes']));
      expect(process.exitCode).toBe(2);
    } finally {
      await rig.cleanup();
    }
  }, 30_000);

  test('SR-P2: a DELAYED job in a provably-dead inline queue converts for resubmit', async () => {
    const rig = await setupRig();
    try {
      const above = writeTranscript(rig.corpusDir, '2026-08-27-delayed.txt');
      await seedScore(rig, above.filePath, above.hash, 0.9);
      const delayedJob = await seedJob(rig, {
        key: synthKey('default', basename(above.filePath), above.hash16),
        status: 'delayed',
      });
      const { out } = await captureStdout(() => withoutAnthropicKey(() =>
        runDreamRetriage(rig.engine, ['--reconcile-queue', '--json'])));
      const summary = JSON.parse(out) as { queue: { converted_for_resubmit: number } };
      expect(await jobStatus(rig, delayedJob)).toBe('cancelled');
      expect(summary.queue.converted_for_resubmit).toBe(1);
    } finally {
      await rig.cleanup();
    }
  }, 30_000);

  test('SR3-P1: dream --reconcile-queue without the retriage positional fails loud (exit code 2)', async () => {
    // The flag registry unions retriage flags into `dream`, so the strict
    // pre-dispatch validator accepts them — the guard in runDream must reject
    // instead of silently running the full paid maintenance cycle.
    for (const stray of ['--reconcile-queue', '--cancel-unmatched', '--audit-rejects']) {
      process.exitCode = 0;
      const result = await runDream(null, [stray]);
      expect(result).toBeUndefined(); // no cycle ran
      expect(process.exitCode).toBe(2);
    }
  });

  test('SR3-P2: gbrain models reports models.dream.triage as the effective triage route', async () => {
    const rig = await setupRig();
    try {
      await rig.engine.setConfig('models.dream.triage', 'anthropic:claude-sonnet-4-6');
      const { runModels } = await import('../src/commands/models.ts');
      // runModels writes through process.stdout.write; capture that stream.
      const chunks: string[] = [];
      const orig = process.stdout.write.bind(process.stdout);
      (process.stdout as unknown as { write: (c: unknown) => boolean }).write = (c: unknown) => {
        chunks.push(String(c));
        return true;
      };
      try {
        await captureStdout(() => runModels(rig.engine as never, ['--json']));
      } finally {
        (process.stdout as unknown as { write: typeof orig }).write = orig;
      }
      const raw = chunks.join('');
      const jsonStart = raw.indexOf('{');
      const report = JSON.parse(raw.slice(jsonStart)) as { per_task: Array<{ key: string; resolved: string; source: string }> };
      const row = report.per_task.find(r => r.key === 'models.dream.synthesize_verdict')!;
      expect(row.resolved).toBe('anthropic:claude-sonnet-4-6');
      expect(row.source).toBe('config: models.dream.triage');
    } finally {
      await rig.cleanup();
    }
  }, 30_000);

  test('SR2-P1: unpriced TRIAGE model + priced audit still confirms on the audit dollars', async () => {
    const rig = await setupRig();
    try {
      // Triage unpriced (file-count gate alone would NOT trigger for 1 file),
      // synthesis model priced by default — a large --audit-rejects must gate
      // on its own estimated dollars.
      await rig.engine.setConfig('models.dream.triage', 'ollama:totally-unpriced-model');
      const reject = writeTranscript(rig.corpusDir, '2026-08-30-audit-gate.txt');
      // Seed a below-threshold verdict UNDER THE UNPRICED MODEL so it is a
      // cache hit (missCount 0) and the audit is the only spend.
      await rig.engine.putDreamVerdict(reject.filePath, reject.hash, {
        worth_processing: false, reasons: ['seed'], score: 0.1, content_type: null,
        segments: [], entities: [], model: 'ollama:totally-unpriced-model', triage_version: TRIAGE_VERSION,
      });
      await withoutAnthropicKey(() =>
        runDreamRetriage(rig.engine, ['--audit-rejects', '100000', '--json']));
      expect(process.exitCode).toBe(2); // gate fired without --yes
      const rows = await rig.engine.executeRaw<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM dream_verdicts WHERE model <> 'ollama:totally-unpriced-model'`);
      expect(rows[0].n).toBe(0); // nothing audited
    } finally {
      await rig.cleanup();
    }
  }, 30_000);

  test('SR2-P2: a live lock for ANOTHER source does not suppress this source\'s conversions', async () => {
    const rig = await setupRig();
    try {
      const above = writeTranscript(rig.corpusDir, '2026-08-31-other-lock.txt');
      await seedScore(rig, above.filePath, above.hash, 0.9);
      const job = await seedJob(rig, { key: synthKey('default', basename(above.filePath), above.hash16) });
      await rig.engine.executeRaw(
        `INSERT INTO gbrain_cycle_locks (id, holder_pid, ttl_expires_at)
         VALUES ('gbrain-cycle:some-other-source', 12345, NOW() + interval '10 minutes')`,
      );
      const { out } = await captureStdout(() => withoutAnthropicKey(() =>
        runDreamRetriage(rig.engine, ['--reconcile-queue', '--json'])));
      const summary = JSON.parse(out) as { queue: { converted_for_resubmit: number; kept_live_queue: number } };
      expect(await jobStatus(rig, job)).toBe('cancelled'); // converted despite the foreign lock
      expect(summary.queue.converted_for_resubmit).toBe(1);
      expect(summary.queue.kept_live_queue).toBe(0);
    } finally {
      await rig.cleanup();
    }
  }, 30_000);

  test('SR-P2/#4250: a live lock that could OWN the queue (acquired before its birth) keeps it possibly-live', async () => {
    const rig = await setupRig();
    try {
      const above = writeTranscript(rig.corpusDir, '2026-08-28-locked.txt');
      await seedScore(rig, above.filePath, above.hash, 0.9);
      // Queue born 2h ago (past the liveness grace); the running cycle's lock
      // was acquired BEFORE that, so it could own the queue — never convert.
      const queue = `dream-inline-${Date.now() - 2 * 3600_000}-deadbee1`;
      const job = await seedJob(rig, { key: synthKey('default', basename(above.filePath), above.hash16), queue });
      await rig.engine.executeRaw(
        `INSERT INTO gbrain_cycle_locks (id, holder_pid, acquired_at, ttl_expires_at)
         VALUES ('gbrain-cycle:default', 12345, NOW() - interval '3 hours', NOW() + interval '10 minutes')`,
      );
      const { out } = await captureStdout(() => withoutAnthropicKey(() =>
        runDreamRetriage(rig.engine, ['--reconcile-queue', '--json'])));
      const summary = JSON.parse(out) as { queue: { kept_live_queue: number; converted_for_resubmit: number } };
      expect(await jobStatus(rig, job)).toBe('waiting');
      expect(summary.queue.kept_live_queue).toBe(1);
      expect(summary.queue.converted_for_resubmit).toBe(0);
    } finally {
      await rig.cleanup();
    }
  }, 30_000);

  test('#4250: a live lock acquired AFTER the queue was born cannot own it — the old orphan converts', async () => {
    // The doctor↔retriage alignment fix: doctor flags a pre-lock orphan, so
    // retriage must be able to repair it even while a NEW cycle runs.
    const rig = await setupRig();
    try {
      const above = writeTranscript(rig.corpusDir, '2026-08-28-prelock.txt');
      await seedScore(rig, above.filePath, above.hash, 0.9);
      const queue = `dream-inline-${Date.now() - 2 * 3600_000}-deadbee2`;
      const job = await seedJob(rig, { key: synthKey('default', basename(above.filePath), above.hash16), queue });
      await rig.engine.executeRaw(
        `INSERT INTO gbrain_cycle_locks (id, holder_pid, acquired_at, ttl_expires_at)
         VALUES ('gbrain-cycle:default', 12345, NOW() - interval '30 minutes', NOW() + interval '10 minutes')`,
      );
      const { out } = await captureStdout(() => withoutAnthropicKey(() =>
        runDreamRetriage(rig.engine, ['--reconcile-queue', '--json'])));
      const summary = JSON.parse(out) as { queue: { kept_live_queue: number; converted_for_resubmit: number } };
      expect(await jobStatus(rig, job)).toBe('cancelled');
      expect(summary.queue.converted_for_resubmit).toBe(1);
      expect(summary.queue.kept_live_queue).toBe(0);
    } finally {
      await rig.cleanup();
    }
  }, 30_000);

  test('#4250: a NON-synth child (patterns-style key) in a provably-dead inline queue converts for resubmit', async () => {
    // Doctor's orphaned_private_queue check flags patterns queues too; the
    // advertised retriage repair must select and convert them, not report
    // unmatched.
    const rig = await setupRig();
    try {
      const queue = `dream-inline-${Date.now() - 2 * 3600_000}-deadbee3`;
      const job = await seedJob(rig, { key: 'patterns:child:not-a-synth-key', queue });
      const { out } = await captureStdout(() => withoutAnthropicKey(() =>
        runDreamRetriage(rig.engine, ['--reconcile-queue', '--json'])));
      const summary = JSON.parse(out) as { queue: { converted_for_resubmit: number; unmatched: number } };
      expect(await jobStatus(rig, job)).toBe('cancelled');
      expect(summary.queue.converted_for_resubmit).toBe(1);
      expect(summary.queue.unmatched).toBe(0);
    } finally {
      await rig.cleanup();
    }
  }, 30_000);

  test('SR-P2: dry-run counts would-cancel unmatched rows instead of understating the preview', async () => {
    const rig = await setupRig();
    try {
      const real = writeTranscript(rig.corpusDir, '2026-08-29-anchor.txt');
      await seedScore(rig, real.filePath, real.hash, 0.9);
      const ghost = await seedJob(rig, { key: synthKey('default', 'ghost-preview.txt', 'dddddddddddddddd') });
      const { out } = await captureStdout(() => withoutAnthropicKey(() =>
        runDreamRetriage(rig.engine, ['--reconcile-queue', '--cancel-unmatched', '--dry-run', '--json'])));
      const summary = JSON.parse(out) as { queue: { unmatched_cancelled: number } };
      expect(summary.queue.unmatched_cancelled).toBe(1); // would cancel
      expect(await jobStatus(rig, ghost)).toBe('waiting'); // but did not
    } finally {
      await rig.cleanup();
    }
  }, 30_000);

  test('CX1: rows in a YOUNG dream-inline-* queue are kept as possibly-live, never cancelled', async () => {
    const rig = await setupRig();
    try {
      const below = writeTranscript(rig.corpusDir, '2026-08-21-live.txt');
      await seedScore(rig, below.filePath, below.hash, 0.1); // below threshold — would cancel in a dead queue
      const liveQueue = `dream-inline-${Date.now()}-abcdef01`; // younger than the 1h grace
      const liveJob = await seedJob(rig, {
        key: synthKey('default', basename(below.filePath), below.hash16),
        queue: liveQueue,
      });
      const { out } = await captureStdout(() => withoutAnthropicKey(() => runDreamRetriage(rig.engine, ['--reconcile-queue', '--json'])));
      const summary = JSON.parse(out) as { queue: { kept_live_queue: number; cancelled: number } };
      expect(await jobStatus(rig, liveJob)).toBe('waiting');
      expect(summary.queue.kept_live_queue).toBe(1);
      expect(summary.queue.cancelled).toBe(0);
    } finally {
      await rig.cleanup();
    }
  }, 30_000);

  test('CX2: zero discovered transcripts + queued jobs → --cancel-unmatched refused with exit 2', async () => {
    const rig = await setupRig(); // corpus dir exists but is EMPTY
    try {
      const job = await seedJob(rig, { key: synthKey('default', 'ghost.txt', 'cccccccccccccccc') });
      await withoutAnthropicKey(() => runDreamRetriage(rig.engine, ['--reconcile-queue', '--cancel-unmatched', '--json', '--yes']));
      expect(process.exitCode).toBe(2);
      expect(await jobStatus(rig, job)).toBe('waiting'); // retry frontier preserved
    } finally {
      await rig.cleanup();
    }
  }, 30_000);

  test('--audit-rejects: frontier second opinion via stubbed transport, disagreement rate reported', async () => {
    const rig = await setupRig();
    try {
      const { __setChatTransportForTests, resetGateway } = await import('../src/core/ai/gateway.ts');
      const rejectA = writeTranscript(rig.corpusDir, '2026-08-22-reject-a.txt');
      const rejectB = writeTranscript(rig.corpusDir, '2026-08-23-reject-b.txt');
      await seedScore(rig, rejectA.filePath, rejectA.hash, 0.1);
      await seedScore(rig, rejectB.filePath, rejectB.hash, 0.2);
      // Frontier stub: always scores HIGH → disagrees with both rejects.
      __setChatTransportForTests(async () => ({
        text: '{"score": 0.9, "content_type": "idea", "segments": [], "entities": [], "reasons": ["frontier disagrees"]}',
        blocks: [],
        stopReason: 'end',
        usage: { input_tokens: 10, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'test:stub',
        providerId: 'test',
      }));
      try {
        // Fake key so makeJudgeClient constructs; the transport stub prevents network.
        const { out } = await captureStdout(() => withEnv({ ANTHROPIC_API_KEY: 'sk-test-audit' }, () =>
          runDreamRetriage(rig.engine, ['--audit-rejects', '2', '--yes', '--json'])));
        const summary = JSON.parse(out) as { audit: { sampled: number; disagreements: number; disagreement_rate: number | null } };
        expect(summary.audit.sampled).toBe(2);
        expect(summary.audit.disagreements).toBe(2);
        expect(summary.audit.disagreement_rate).toBe(1);
      } finally {
        __setChatTransportForTests(null);
        resetGateway();
      }
    } finally {
      await rig.cleanup();
    }
  }, 30_000);

  test('F2 regression: --audit-rejects samples only NON-rescued rejects (rescued band files are accepted, not rejects)', async () => {
    const rig = await setupRig();
    try {
      const { __setChatTransportForTests, resetGateway } = await import('../src/core/ai/gateway.ts');
      const rescued = writeTranscript(rig.corpusDir, '2026-08-25-rescued.txt');
      const plain = writeTranscript(rig.corpusDir, '2026-08-26-plain-reject.txt');
      const n = '2026-08-25-rescued.txt';
      await rig.engine.putDreamVerdict(rescued.filePath, rescued.hash, {
        worth_processing: false,
        reasons: ['seed'],
        score: 0.35,
        content_type: 'mixed',
        segments: [
          { quote: `conversation in ${n}\nconversation in ${n}` },
          { quote: `in ${n} conversation in ${n} conversation` },
        ],
        entities: [],
        model: TIER_DEFAULTS.utility,
        triage_version: TRIAGE_VERSION,
      });
      await seedScore(rig, plain.filePath, plain.hash, 0.35); // same band, no segments → true reject
      __setChatTransportForTests(async () => ({
        text: '{"score": 0.9, "content_type": "idea", "segments": [], "entities": [], "reasons": ["frontier disagrees"]}',
        blocks: [],
        stopReason: 'end',
        usage: { input_tokens: 10, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'test:stub',
        providerId: 'test',
      }));
      try {
        const { out } = await captureStdout(() => withEnv({ ANTHROPIC_API_KEY: 'sk-test-audit' }, () =>
          runDreamRetriage(rig.engine, ['--audit-rejects', '5', '--yes', '--json'])));
        const summary = JSON.parse(out) as { audit: { sampled: number } };
        expect(summary.audit.sampled).toBe(1); // the plain reject only — never the rescued file
      } finally {
        __setChatTransportForTests(null);
        resetGateway();
      }
    } finally {
      await rig.cleanup();
    }
  }, 30_000);

  test('--audit-rejects under --dry-run is a loud no-op (audit null, notice printed)', async () => {
    const rig = await setupRig();
    try {
      const below = writeTranscript(rig.corpusDir, '2026-08-24-noop.txt');
      await seedScore(rig, below.filePath, below.hash, 0.1);
      const { out } = await captureStdout(() => withoutAnthropicKey(() =>
        runDreamRetriage(rig.engine, ['--audit-rejects', '1', '--dry-run', '--json'])));
      const summary = JSON.parse(out) as { audit: unknown };
      expect(summary.audit).toBeNull();
    } finally {
      await rig.cleanup();
    }
  }, 30_000);

  test('--threshold override wins over config for the gate', async () => {
    const rig = await setupRig();
    try {
      const mid = writeTranscript(rig.corpusDir, '2026-08-10-mid.txt');
      await seedScore(rig, mid.filePath, mid.hash, 0.6);
      const job = await seedJob(rig, { key: synthKey('default', basename(mid.filePath), mid.hash16) });
      // 0.6 passes the default 0.5 gate — but a 0.7 override cancels it.
      await captureStdout(() => withoutAnthropicKey(() => runDreamRetriage(rig.engine, ['--reconcile-queue', '--threshold', '0.7', '--json'])));
      expect(await jobStatus(rig, job)).toBe('cancelled');
    } finally {
      await rig.cleanup();
    }
  }, 30_000);
});

describe('dream retriage — spend gate (C12)', () => {
  /**
   * Force the confirmation gate robustly: derive the sample window from LIVE
   * canonical pricing so a single un-cached file's estimate exceeds
   * SPEND_CONFIRM_USD regardless of future price updates in model-pricing.ts
   * (a hardcoded char count silently flips the gate when prices drift).
   */
  async function forceSpendGate(rig: Rig): Promise<void> {
    const model = 'anthropic:claude-fable-5';
    const price = canonicalLookup(model)!;
    const charsForGate = Math.ceil(((SPEND_CONFIRM_USD * 1.5) / price.input) * 1_000_000 * CHARS_PER_TOKEN);
    await rig.engine.setConfig('models.dream.triage', model);
    await rig.engine.setConfig('dream.triage.max_chars', String(charsForGate));
  }

  test('non-interactive gate: un-triaged files + --json without --yes → exit 2, nothing judged', async () => {
    const rig = await setupRig();
    try {
      // Two un-cached files × a priced frontier model × a pricing-derived
      // sample window pushes the estimate past the gate.
      await forceSpendGate(rig);
      writeTranscript(rig.corpusDir, '2026-08-11-a.txt');
      writeTranscript(rig.corpusDir, '2026-08-12-b.txt');
      await withoutAnthropicKey(() => runDreamRetriage(rig.engine, ['--json']));
      expect(process.exitCode).toBe(2);
      // Nothing was judged or cached.
      const rows = await rig.engine.executeRaw<{ n: number }>(`SELECT COUNT(*)::int AS n FROM dream_verdicts`);
      expect(rows[0].n).toBe(0);
    } finally {
      await rig.cleanup();
    }
  }, 30_000);

  test('--yes skips the gate (files degrade with no provider rather than aborting)', async () => {
    const rig = await setupRig();
    try {
      await forceSpendGate(rig);
      writeTranscript(rig.corpusDir, '2026-08-13-c.txt');
      // withoutAnthropicKey → judge client null → per-file degrade, no spend.
      const { out } = await captureStdout(() => withoutAnthropicKey(() => runDreamRetriage(rig.engine, ['--json', '--yes'])));
      const summary = JSON.parse(out) as { discovered: number; retriaged: number };
      expect(summary.discovered).toBe(1);
      expect(summary.retriaged).toBe(0); // degraded, not judged
      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      await rig.cleanup();
    }
  }, 30_000);
});
