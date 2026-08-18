/**
 * E2E for v0.30.2 dream/synthesize chunking. PGLite, no API key required.
 *
 * Pre-seeds verdicts so the Haiku gate is bypassed; submits subagent jobs
 * but never runs them (no worker spawned). Tests inspect minion_jobs to
 * verify submission shape (chunk count, idempotency keys, skip-paths).
 *
 * Coverage:
 *   - D5 cap-hit: chunks > maxChunks → log + skip with no minion_jobs row
 *     and no dream_verdicts cache write (closes the poison-pill class).
 *   - D8 legacy-key migration: a completed old-root job (single-chunk or a
 *     full chunked set) for the same filename + content hash suppresses
 *     duplicate synthesis; partial chunk sets and double-encoded result
 *     rows are covered.
 *   - Chunked path: fat transcript spawns N children with chunk-suffixed
 *     path-independent idempotency keys; single-chunk omits the suffix.
 *
 * Run: bun test test/e2e/dream-synthesize-chunking.test.ts
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseSynthesize, TRIAGE_VERSION } from '../../src/core/cycle/synthesize.ts';
import { TIER_DEFAULTS } from '../../src/core/model-config.ts';

interface TestRig {
  engine: PGLiteEngine;
  brainDir: string;
  corpusDir: string;
  cleanup: () => Promise<void>;
}

async function setupRig(): Promise<TestRig> {
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
  const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-chunk-brain-'));
  const corpusDir = mkdtempSync(join(tmpdir(), 'gbrain-chunk-corpus-'));
  return {
    engine,
    brainDir,
    corpusDir,
    cleanup: async () => {
      try { await engine.disconnect(); } catch { /* best-effort */ }
      try { rmSync(brainDir, { recursive: true, force: true }); } catch { /* */ }
      try { rmSync(corpusDir, { recursive: true, force: true }); } catch { /* */ }
    },
  };
}

async function withoutAnthropicKey<T>(body: () => Promise<T>): Promise<T> {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    return await body();
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
}

/**
 * Run `body` while a background loop force-cancels any subagent jobs the
 * synthesize phase submits. Without a worker, those jobs would sit in
 * `waiting` forever and runPhaseSynthesize's waitForCompletion blocks for
 * 35 minutes. Cancelling moves them to a terminal state so the phase
 * returns and we can inspect submission shape.
 */
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
        // excludeQueue: rows a test seeded deliberately (e.g. the C1
        // stranded-row fixture) must be cancelled by the CODE UNDER TEST,
        // not this poller — otherwise the assertion is vacuous/racy.
        await engine.executeRaw(
          `UPDATE minion_jobs
              SET status = 'cancelled', finished_at = now()
            WHERE name = 'subagent' AND status IN ('waiting', 'active')
              AND ($1::text IS NULL OR queue <> $1)`,
          [opts.excludeQueue ?? null],
        );
      } catch {
        // Race against shutdown is fine; ignore.
      }
    }
  })();
  try {
    return await body();
  } finally {
    stopped = true;
    await loop;
  }
}

/**
 * Pre-seed a `worth_processing=true` verdict so the synthesize phase skips
 * the Haiku call and proceeds directly to fan-out. Computes the hash the
 * same way `discoverTranscripts` does (sha256 of content).
 */
async function seedVerdict(engine: PGLiteEngine, filePath: string, content: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  const contentHash = createHash('sha256').update(content, 'utf8').digest('hex');
  // Triage-v1 cache validity requires score + matching (model, triage_version);
  // TIER_DEFAULTS.utility is what loadSynthConfig resolves in a bare test env.
  await engine.putDreamVerdict(filePath, contentHash, {
    worth_processing: true,
    reasons: ['seeded for chunking E2E test'],
    score: 0.9,
    content_type: null,
    segments: [],
    entities: [],
    model: TIER_DEFAULTS.utility,
    triage_version: TRIAGE_VERSION,
  });
  return contentHash;
}

/**
 * Resolve the absolute path the discover walker will see for a file in the
 * corpus dir, since `discoverTranscripts` joins corpus + name.
 */
function corpusPath(corpusDir: string, basename: string): string {
  return join(corpusDir, basename);
}

describe('E2E synthesize chunking — D5 cap hit', () => {
  test('chunks > max_chunks_per_transcript → skipped with no jobs and no verdict-cache write', async () => {
    const rig = await setupRig();
    try {
      // Tiny chunk budget (forces N chunks) + tiny cap (forces cap hit).
      // 100K is the floor; even at the floor, 350K-char tester content
      // chunks to ~1 chunk... we need budget below floor to force many
      // chunks. Use the chunks_per_transcript cap instead.
      await rig.engine.setConfig('dream.synthesize.enabled', 'true');
      await rig.engine.setConfig('dream.synthesize.session_corpus_dir', rig.corpusDir);
      await rig.engine.setConfig('dream.synthesize.max_prompt_tokens', '100000'); // floor → 350K char budget
      await rig.engine.setConfig('dream.synthesize.max_chunks_per_transcript', '2');

      // 1.5M chars → 5 chunks at 350K-char budget → exceeds cap=2.
      const basename = '2026-05-08-fat-transcript.txt';
      const filePath = corpusPath(rig.corpusDir, basename);
      const content = 'fat transcript line\n'.repeat(75_000); // ~1.5M chars
      writeFileSync(filePath, content);
      await seedVerdict(rig.engine, filePath, content);

      await withoutAnthropicKey(async () => {
        const result = await runPhaseSynthesize(rig.engine, {
          brainDir: rig.brainDir,
          dryRun: false,
        });

        expect(result.status).toBe('ok');
        const details = result.details as {
          children_submitted: number;
          skips: Array<{ filePath: string; reason: string }>;
        };
        expect(details.children_submitted).toBe(0);
        expect(details.skips).toHaveLength(1);
        expect(details.skips[0].filePath).toBe(filePath);
        expect(details.skips[0].reason).toMatch(/oversize_after_split/);
      });

      // No subagent jobs submitted.
      const jobs = await rig.engine.executeRaw<{ cnt: string | number }>(
        `SELECT count(*) AS cnt FROM minion_jobs WHERE name = 'subagent'`,
      );
      expect(Number(jobs[0].cnt)).toBe(0);

      // D5: dream_verdicts NOT written for the cap-hit path.
      // Verify by re-reading the verdict — our seeded row is the ONLY entry.
      const verdicts = await rig.engine.executeRaw<{ cnt: string | number }>(
        `SELECT count(*) AS cnt FROM dream_verdicts`,
      );
      expect(Number(verdicts[0].cnt)).toBe(1); // only the seed; no cap-hit row added
    } finally {
      await rig.cleanup();
    }
  }, 30_000);
});

describe('E2E synthesize chunking — D8 legacy-key migration', () => {
  test('successful legacy synthesis survives a corpus-root move', async () => {
    const rig = await setupRig();
    const oldCorpusDir = mkdtempSync(join(tmpdir(), 'gbrain-chunk-old-corpus-'));
    try {
      await rig.engine.setConfig('dream.synthesize.enabled', 'true');
      await rig.engine.setConfig('dream.synthesize.session_corpus_dir', rig.corpusDir);

      const basename = '2026-04-25-already-synthesized.txt';
      const filePath = corpusPath(rig.corpusDir, basename);
      const content = 'meaningful conversation lines\n'.repeat(200);
      writeFileSync(filePath, content);
      const contentHash = await seedVerdict(rig.engine, filePath, content);

      // The successful historical job used a different corpus root.
      const oldFilePath = corpusPath(oldCorpusDir, basename);
      const legacyKey = `dream:synth:${oldFilePath}:${contentHash.slice(0, 16)}`;
      await rig.engine.executeRaw(
        `INSERT INTO minion_jobs
           (name, queue, status, data, result, idempotency_key, finished_at)
         VALUES
           ('subagent', 'default', 'completed', '{}'::jsonb,
            '{"stop_reason":"end_turn"}'::jsonb, $1, now())`,
        [legacyKey],
      );

      await withoutAnthropicKey(async () => {
        await withSubagentAutoCancel(rig.engine, async () => {
          const result = await runPhaseSynthesize(rig.engine, {
            brainDir: rig.brainDir,
            dryRun: false,
          });
          const details = result.details as {
            children_submitted: number;
            skips: Array<{ reason: string }>;
          };
          expect(details.children_submitted).toBe(0);
          expect(details.skips).toHaveLength(1);
          expect(details.skips[0].reason).toBe('already_synthesized_legacy_single_chunk');
        });
      });

      // No new subagent job: still exactly one historical success.
      const jobs = await rig.engine.executeRaw<{ cnt: string | number }>(
        `SELECT count(*) AS cnt FROM minion_jobs WHERE name = 'subagent'`,
      );
      expect(Number(jobs[0].cnt)).toBe(1);
    } finally {
      rmSync(oldCorpusDir, { recursive: true, force: true });
      await rig.cleanup();
    }
  }, 30_000);

  test('legacy CHUNKED completion suppresses v2 resubmission; partial chunk set does not', async () => {
    const rig = await setupRig();
    const oldCorpusDir = mkdtempSync(join(tmpdir(), 'gbrain-chunk-old-corpus-'));
    try {
      await rig.engine.setConfig('dream.synthesize.enabled', 'true');
      await rig.engine.setConfig('dream.synthesize.session_corpus_dir', rig.corpusDir);

      // Transcript A: previously synthesized as a FULL 2-chunk legacy run.
      const fullName = '2026-04-26-chunked-complete.txt';
      const fullPath = corpusPath(rig.corpusDir, fullName);
      const fullContent = 'fully chunk-synthesized lines\n'.repeat(200);
      writeFileSync(fullPath, fullContent);
      const fullHash16 = (await seedVerdict(rig.engine, fullPath, fullContent)).slice(0, 16);

      // Transcript B: legacy run completed only chunk 0 of 3 (partial).
      const partialName = '2026-04-27-chunked-partial.txt';
      const partialPath = corpusPath(rig.corpusDir, partialName);
      const partialContent = 'partially chunk-synthesized lines\n'.repeat(200);
      writeFileSync(partialPath, partialContent);
      const partialHash16 = (await seedVerdict(rig.engine, partialPath, partialContent)).slice(0, 16);

      // All legacy rows lived under a different (moved-away) corpus root.
      const legacyKeys = [
        `dream:synth:${corpusPath(oldCorpusDir, fullName)}:${fullHash16}:c0of2`,
        `dream:synth:${corpusPath(oldCorpusDir, fullName)}:${fullHash16}:c1of2`,
        `dream:synth:${corpusPath(oldCorpusDir, partialName)}:${partialHash16}:c0of3`,
      ];
      for (const key of legacyKeys) {
        await rig.engine.executeRaw(
          `INSERT INTO minion_jobs
             (name, queue, status, data, result, idempotency_key, finished_at)
           VALUES
             ('subagent', 'default', 'completed', '{}'::jsonb,
              '{"stop_reason":"end_turn"}'::jsonb, $1, now())`,
          [key],
        );
      }

      await withoutAnthropicKey(async () => {
        await withSubagentAutoCancel(rig.engine, async () => {
          const result = await runPhaseSynthesize(rig.engine, {
            brainDir: rig.brainDir,
            dryRun: false,
          });
          const details = result.details as {
            children_submitted: number;
            skips: Array<{ filePath: string; reason: string }>;
          };
          // A skipped (full legacy chunk set); B resubmitted (partial set).
          expect(details.children_submitted).toBe(1);
          expect(details.skips).toHaveLength(1);
          expect(details.skips[0].filePath).toBe(fullPath);
          expect(details.skips[0].reason).toBe('already_synthesized_legacy_chunked');
        });
      });

      // 3 seeded legacy rows + exactly 1 new v2 job for the partial transcript.
      const rows = await rig.engine.executeRaw<{ idempotency_key: string }>(
        `SELECT idempotency_key FROM minion_jobs
          WHERE name = 'subagent' AND idempotency_key LIKE 'dream:synth-v2:%'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].idempotency_key).toContain(encodeURIComponent(partialName));
    } finally {
      rmSync(oldCorpusDir, { recursive: true, force: true });
      await rig.cleanup();
    }
  }, 30_000);

  test('legacy completed row with double-encoded jsonb result still suppresses', async () => {
    const rig = await setupRig();
    try {
      await rig.engine.setConfig('dream.synthesize.enabled', 'true');
      await rig.engine.setConfig('dream.synthesize.session_corpus_dir', rig.corpusDir);

      const basename = '2026-04-28-double-encoded.txt';
      const filePath = corpusPath(rig.corpusDir, basename);
      const content = 'double-encoded result lines\n'.repeat(200);
      writeFileSync(filePath, content);
      const contentHash = await seedVerdict(rig.engine, filePath, content);

      // Historical row whose `result` was double-encoded (jsonb string
      // scalar — the #2339 class). `result->>'stop_reason'` yields NULL on
      // this row; a completed legacy job must suppress regardless.
      const legacyKey = `dream:synth:${filePath}:${contentHash.slice(0, 16)}`;
      await rig.engine.executeRaw(
        `INSERT INTO minion_jobs
           (name, queue, status, data, result, idempotency_key, finished_at)
         VALUES
           ('subagent', 'default', 'completed', '{}'::jsonb,
            to_jsonb('{"stop_reason":"end_turn"}'::text), $1, now())`,
        [legacyKey],
      );

      await withoutAnthropicKey(async () => {
        await withSubagentAutoCancel(rig.engine, async () => {
          const result = await runPhaseSynthesize(rig.engine, {
            brainDir: rig.brainDir,
            dryRun: false,
          });
          const details = result.details as {
            children_submitted: number;
            skips: Array<{ reason: string }>;
          };
          expect(details.children_submitted).toBe(0);
          expect(details.skips).toHaveLength(1);
          expect(details.skips[0].reason).toBe('already_synthesized_legacy_single_chunk');
        });
      });

      const jobs = await rig.engine.executeRaw<{ cnt: string | number }>(
        `SELECT count(*) AS cnt FROM minion_jobs WHERE name = 'subagent'`,
      );
      expect(Number(jobs[0].cnt)).toBe(1);
    } finally {
      await rig.cleanup();
    }
  }, 30_000);
});

describe('E2E synthesize chunking — fan-out shape', () => {
  test('single-chunk transcript key excludes the corpus root', async () => {
    const rig = await setupRig();
    try {
      await rig.engine.setConfig('dream.synthesize.enabled', 'true');
      await rig.engine.setConfig('dream.synthesize.session_corpus_dir', rig.corpusDir);
      // Default budget is plenty for 5KB content.

      const basename = '2026-04-25-small.txt';
      const filePath = corpusPath(rig.corpusDir, basename);
      const content = 'small transcript content\n'.repeat(100); // ~2.5KB
      writeFileSync(filePath, content);
      const contentHash = await seedVerdict(rig.engine, filePath, content);

      await withoutAnthropicKey(async () => {
        await withSubagentAutoCancel(rig.engine, async () => {
          const result = await runPhaseSynthesize(rig.engine, {
            brainDir: rig.brainDir,
            dryRun: false,
          });
          const details = result.details as { children_submitted: number };
          expect(details.children_submitted).toBe(1);
        });
      });

      const expectedKey =
        `dream:synth-v2:default:filename:${encodeURIComponent(basename)}:${contentHash.slice(0, 16)}`;
      const rows = await rig.engine.executeRaw<{ idempotency_key: string }>(
        `SELECT idempotency_key FROM minion_jobs WHERE name = 'subagent' ORDER BY id`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].idempotency_key).toBe(expectedKey);
      // Single-chunk keys have no ":c<idx>of<n>" suffix.
      expect(rows[0].idempotency_key).not.toMatch(/:c\d+of\d+$/);
    } finally {
      await rig.cleanup();
    }
  }, 30_000);

  test('multi-chunk transcript spawns N children with chunk-suffixed idempotency keys', async () => {
    const rig = await setupRig();
    try {
      await rig.engine.setConfig('dream.synthesize.enabled', 'true');
      await rig.engine.setConfig('dream.synthesize.session_corpus_dir', rig.corpusDir);
      // Floor at 100K tokens → 350K-char chunk budget. A 1.5M-char transcript
      // chunks to ~5 chunks. Default cap is 24, so submission proceeds.
      await rig.engine.setConfig('dream.synthesize.max_prompt_tokens', '100000');

      const basename = '2026-05-08-fat.txt';
      const filePath = corpusPath(rig.corpusDir, basename);
      const content = 'fat transcript line with newline\n'.repeat(50_000); // ~1.65M chars
      writeFileSync(filePath, content);
      const contentHash = await seedVerdict(rig.engine, filePath, content);
      const hash16 = contentHash.slice(0, 16);

      await withoutAnthropicKey(async () => {
        await withSubagentAutoCancel(rig.engine, async () => {
          const result = await runPhaseSynthesize(rig.engine, {
            brainDir: rig.brainDir,
            dryRun: false,
          });
          const details = result.details as { children_submitted: number };
          expect(details.children_submitted).toBeGreaterThan(1);
        });
      });

      const rows = await rig.engine.executeRaw<{ idempotency_key: string }>(
        `SELECT idempotency_key FROM minion_jobs WHERE name = 'subagent' ORDER BY id`,
      );
      expect(rows.length).toBeGreaterThan(1);
      const baseKey =
        `dream:synth-v2:default:filename:${encodeURIComponent(basename)}:${hash16}`;
      for (const r of rows) {
        expect(r.idempotency_key).toMatch(
          new RegExp(`^${escapeRe(baseKey)}:c\\d+of\\d+$`),
        );
      }
      // Chunk indices are unique 0..N-1.
      const indices = rows
        .map(r => /:c(\d+)of/.exec(r.idempotency_key)?.[1])
        .map(s => Number(s))
        .sort((a, b) => a - b);
      const expected = Array.from({ length: rows.length }, (_, i) => i);
      expect(indices).toEqual(expected);
    } finally {
      await rig.cleanup();
    }
  }, 30_000);
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('E2E synthesize — max_turns (#4152 REGRESSION pin) + triage map injection', () => {
  // IRON-RULE REGRESSION TEST: the default turn budget dropped 30 → 16 with
  // the two-stage cascade. Pin BOTH the new default AND the config path that
  // restores the old behavior.
  test('submitted subagent jobs carry max_turns=16 by default; dream.synthesize.max_turns=30 restores 30', async () => {
    const rig = await setupRig();
    try {
      await rig.engine.setConfig('dream.synthesize.enabled', 'true');
      await rig.engine.setConfig('dream.synthesize.session_corpus_dir', rig.corpusDir);
      // Two back-to-back runs in this test — disable the cooldown so the
      // second run isn't skipped (configured 0 is honored).
      await rig.engine.setConfig('dream.synthesize.cooldown_hours', '0');
      const basename = '2026-08-14-turns.txt';
      const filePath = corpusPath(rig.corpusDir, basename);
      const content = 'a substantive conversation line\n'.repeat(200);
      writeFileSync(filePath, content);
      await seedVerdict(rig.engine, filePath, content);

      await withoutAnthropicKey(async () => {
        await withSubagentAutoCancel(rig.engine, async () => {
          await runPhaseSynthesize(rig.engine, { brainDir: rig.brainDir, dryRun: false });
        });
      });
      let rows = await rig.engine.executeRaw<{ data: { max_turns?: number; prompt?: string } }>(
        `SELECT data FROM minion_jobs WHERE name = 'subagent' ORDER BY id DESC LIMIT 1`,
      );
      expect(rows[0].data.max_turns).toBe(16);

      // Restore path: config override back to the pre-#4152 value. Cancelled
      // rows release the idempotency key, so a re-run resubmits fresh.
      await rig.engine.setConfig('dream.synthesize.max_turns', '30');
      await withoutAnthropicKey(async () => {
        await withSubagentAutoCancel(rig.engine, async () => {
          await runPhaseSynthesize(rig.engine, { brainDir: rig.brainDir, dryRun: false });
        });
      });
      rows = await rig.engine.executeRaw<{ data: { max_turns?: number } }>(
        `SELECT data FROM minion_jobs WHERE name = 'subagent' ORDER BY id DESC LIMIT 1`,
      );
      expect(rows[0].data.max_turns).toBe(30);
    } finally {
      await rig.cleanup();
    }
  }, 60_000);

  test('TRIAGE MAP block rides in the synthesis prompt when the verdict carries segments', async () => {
    const rig = await setupRig();
    try {
      await rig.engine.setConfig('dream.synthesize.enabled', 'true');
      await rig.engine.setConfig('dream.synthesize.session_corpus_dir', rig.corpusDir);
      const basename = '2026-08-15-mapped.txt';
      const filePath = corpusPath(rig.corpusDir, basename);
      const content = 'the future of memory is a database that dreams\n'.repeat(100);
      writeFileSync(filePath, content);
      const { createHash } = await import('node:crypto');
      const contentHash = createHash('sha256').update(content, 'utf8').digest('hex');
      await rig.engine.putDreamVerdict(filePath, contentHash, {
        worth_processing: true,
        reasons: ['seeded'],
        score: 0.91,
        content_type: 'idea',
        segments: [{ quote: 'the future of memory is a database that dreams', note: 'thesis' }],
        entities: ['acme-example'],
        model: TIER_DEFAULTS.utility,
        triage_version: TRIAGE_VERSION,
      });
      await withoutAnthropicKey(async () => {
        await withSubagentAutoCancel(rig.engine, async () => {
          await runPhaseSynthesize(rig.engine, { brainDir: rig.brainDir, dryRun: false });
        });
      });
      const rows = await rig.engine.executeRaw<{ data: { prompt?: string } }>(
        `SELECT data FROM minion_jobs WHERE name = 'subagent' ORDER BY id DESC LIMIT 1`,
      );
      const prompt = rows[0].data.prompt ?? '';
      expect(prompt).toContain('TRIAGE MAP');
      expect(prompt).toContain('signal score: 0.91');
      expect(prompt).toContain('content type: idea');
      expect(prompt).toContain('acme-example');
      expect(prompt).toContain('database that dreams');
    } finally {
      await rig.cleanup();
    }
  }, 30_000);
});

describe('E2E synthesize — fan-out self-heal for stranded coalesced rows (#4152 C1)', () => {
  test('a waiting row in a FOREIGN dream-inline-* queue is cancelled + re-added into the live run', async () => {
    const rig = await setupRig();
    try {
      await rig.engine.setConfig('dream.synthesize.enabled', 'true');
      await rig.engine.setConfig('dream.synthesize.session_corpus_dir', rig.corpusDir);
      const basename = '2026-08-16-stranded.txt';
      const filePath = corpusPath(rig.corpusDir, basename);
      const content = 'stranded conversation line\n'.repeat(200);
      writeFileSync(filePath, content);
      const contentHash = await seedVerdict(rig.engine, filePath, content);
      const key = `dream:synth-v2:default:filename:${encodeURIComponent(basename)}:${contentHash.slice(0, 16)}`;

      // Simulate a previously-killed run: its child sits waiting in a dead
      // per-run private queue no worker will ever claim. The queue timestamp
      // (Nov 2023) is far past the CX1 liveness grace, so the self-heal may
      // legally cancel it.
      const stranded = await rig.engine.executeRaw<{ id: number }>(
        `INSERT INTO minion_jobs (name, queue, status, data, idempotency_key)
         VALUES ('subagent', 'dream-inline-1700000000000-deadbeef', 'waiting', '{}'::jsonb, $1)
         RETURNING id`,
        [key],
      );
      const strandedId = stranded[0].id;

      await withoutAnthropicKey(async () => {
        // Testing-specialist race fix: the auto-cancel poller must NOT touch
        // the seeded stranded row — if it cancels it first, queue.add's own
        // dead/cancelled key-release path produces the asserted end-state
        // WITHOUT the self-heal branch ever running (vacuous pass), and a
        // poller firing between coalesce and cancelJob hard-fails the test.
        await withSubagentAutoCancel(rig.engine, async () => {
          const result = await runPhaseSynthesize(rig.engine, { brainDir: rig.brainDir, dryRun: false });
          // CDX-4: the re-added child dies in this keyless harness, and an
          // all-children-dead run is now an honest phase failure. The
          // self-heal subject (cancel + re-add) is asserted on the rows below.
          expect(result.error?.code ?? result.status).toBe('SYNTH_ALL_CHILDREN_DEAD');
          const details = result.details as { children_submitted: number };
          expect(details.children_submitted).toBe(1);
        }, { excludeQueue: 'dream-inline-1700000000000-deadbeef' });
      });

      // The stranded row was cancelled (key released) and a FRESH row with the
      // same key was created in the live run's queue.
      const rows = await rig.engine.executeRaw<{ id: number; status: string; queue: string; idempotency_key: string | null }>(
        `SELECT id, status, queue, idempotency_key FROM minion_jobs WHERE name = 'subagent' ORDER BY id`,
      );
      const old = rows.find(r => r.id === strandedId)!;
      expect(old.status).toBe('cancelled');
      expect(old.idempotency_key).toBeNull(); // slot released on re-add
      const fresh = rows.find(r => r.id !== strandedId)!;
      expect(fresh.idempotency_key).toBe(key);
      expect(fresh.queue).not.toBe('dream-inline-1700000000000-deadbeef');
      expect(fresh.queue.startsWith('dream-inline-')).toBe(true);
    } finally {
      await rig.cleanup();
    }
  }, 30_000);

  test('CX1 guard: a coalesced row in a YOUNG (possibly-live) dream-inline queue is NOT healed', async () => {
    const rig = await setupRig();
    try {
      await rig.engine.setConfig('dream.synthesize.enabled', 'true');
      await rig.engine.setConfig('dream.synthesize.session_corpus_dir', rig.corpusDir);
      // Keep the phase's wait short: the un-healed foreign row never goes
      // terminal (the poller excludes it), so waitForCompletion must time out
      // fast instead of the 35-min default.
      await rig.engine.setConfig('dream.synthesize.subagent_wait_timeout_ms', '2000');
      const basename = '2026-08-17-live-queue.txt';
      const filePath = corpusPath(rig.corpusDir, basename);
      const content = 'possibly live conversation line\n'.repeat(200);
      writeFileSync(filePath, content);
      const contentHash = await seedVerdict(rig.engine, filePath, content);
      const key = `dream:synth-v2:default:filename:${encodeURIComponent(basename)}:${contentHash.slice(0, 16)}`;
      // A FRESH foreign queue — inside the liveness grace, may belong to a
      // concurrently running cycle. The self-heal must leave it alone.
      const liveQueue = `dream-inline-${Date.now()}-0abc1234`;
      const seeded = await rig.engine.executeRaw<{ id: number }>(
        `INSERT INTO minion_jobs (name, queue, status, data, idempotency_key)
         VALUES ('subagent', $2, 'waiting', '{}'::jsonb, $1)
         RETURNING id`,
        [key, liveQueue],
      );
      await withoutAnthropicKey(async () => {
        await withSubagentAutoCancel(rig.engine, async () => {
          const result = await runPhaseSynthesize(rig.engine, { brainDir: rig.brainDir, dryRun: false });
          expect(result.status).toBe('ok'); // child outcome is 'timeout', phase still completes
        }, { excludeQueue: liveQueue });
      });
      const rows = await rig.engine.executeRaw<{ id: number; status: string; queue: string }>(
        `SELECT id, status, queue FROM minion_jobs WHERE name = 'subagent'`,
      );
      // Exactly the seeded row exists, untouched: no cancel, no re-add.
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(seeded[0].id);
      expect(rows[0].status).toBe('waiting');
      expect(rows[0].queue).toBe(liveQueue);
    } finally {
      await rig.cleanup();
    }
  }, 30_000);
});
