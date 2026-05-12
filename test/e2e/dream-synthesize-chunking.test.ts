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
 *   - D8 legacy single-chunk migration: pre-seed a `completed` legacy job
 *     for the same content hash → next synthesize skips submission.
 *   - Chunked path: fat transcript spawns N children with chunk-suffixed
 *     idempotency keys; single-chunk path keeps the legacy key shape.
 *
 * Run: bun test test/e2e/dream-synthesize-chunking.test.ts
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseSynthesize } from '../../src/core/cycle/synthesize.ts';

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
async function withSubagentAutoCancel<T>(engine: PGLiteEngine, body: () => Promise<T>): Promise<T> {
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      await new Promise(r => setTimeout(r, 50));
      try {
        await engine.executeRaw(
          `UPDATE minion_jobs
              SET status = 'cancelled', finished_at = now()
            WHERE name = 'subagent' AND status IN ('waiting', 'active')`,
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
  await engine.putDreamVerdict(filePath, contentHash, {
    worth_processing: true,
    reasons: ['seeded for chunking E2E test'],
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

describe('E2E synthesize chunking — D8 legacy single-chunk migration', () => {
  test('completed legacy idempotency key → skip submission entirely', async () => {
    const rig = await setupRig();
    try {
      await rig.engine.setConfig('dream.synthesize.enabled', 'true');
      await rig.engine.setConfig('dream.synthesize.session_corpus_dir', rig.corpusDir);

      const basename = '2026-04-25-already-synthesized.txt';
      const filePath = corpusPath(rig.corpusDir, basename);
      const content = 'meaningful conversation lines\n'.repeat(200);
      writeFileSync(filePath, content);
      const contentHash = await seedVerdict(rig.engine, filePath, content);

      // Pre-seed a completed `subagent` job at the legacy idempotency key.
      const legacyKey = `dream:synth:${filePath}:${contentHash.slice(0, 16)}`;
      await rig.engine.executeRaw(
        `INSERT INTO minion_jobs (name, queue, status, idempotency_key, finished_at)
         VALUES ('subagent', 'default', 'completed', $1, now())`,
        [legacyKey],
      );

      await withoutAnthropicKey(async () => {
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

      // No NEW subagent job: still exactly one (the seeded completed row).
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
  test('single-chunk transcript uses legacy idempotency key (parity on upgrade)', async () => {
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

      const expectedKey = `dream:synth:${filePath}:${contentHash.slice(0, 16)}`;
      const rows = await rig.engine.executeRaw<{ idempotency_key: string }>(
        `SELECT idempotency_key FROM minion_jobs WHERE name = 'subagent' ORDER BY id`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].idempotency_key).toBe(expectedKey);
      // Specifically: legacy key shape has NO ":c<idx>of<n>" suffix.
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
      // Every key matches the chunked shape `dream:synth:<path>:<hash16>:c<i>of<N>`.
      for (const r of rows) {
        expect(r.idempotency_key).toMatch(
          new RegExp(`^dream:synth:${escapeRe(filePath)}:${hash16}:c\\d+of\\d+$`),
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
