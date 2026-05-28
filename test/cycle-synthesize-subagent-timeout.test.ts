import { describe, test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseSynthesize } from '../src/core/cycle/synthesize.ts';

async function seedWorthProcessingVerdict(
  engine: PGLiteEngine,
  filePath: string,
  content: string,
): Promise<void> {
  const contentHash = createHash('sha256').update(content, 'utf8').digest('hex');
  await engine.putDreamVerdict(filePath, contentHash, {
    worth_processing: true,
    reasons: ['seeded for timeout config test'],
  });
}

describe('runPhaseSynthesize subagent timeout config', () => {
  test('dream.synthesize.subagent_timeout_ms flows to submitted subagent job', async () => {
    const engine = new PGLiteEngine();
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-synth-timeout-brain-'));
    const corpusDir = mkdtempSync(join(tmpdir(), 'gbrain-synth-timeout-corpus-'));

    try {
      await engine.connect({ engine: 'pglite' } as never);
      await engine.initSchema();

      await engine.setConfig('dream.synthesize.enabled', 'true');
      await engine.setConfig('dream.synthesize.session_corpus_dir', corpusDir);
      await engine.setConfig('dream.synthesize.subagent_timeout_ms', '600000');
      await engine.setConfig('dream.synthesize.subagent_wait_timeout_ms', '1');

      const filePath = join(corpusDir, '2026-05-28-dense-transcript.txt');
      const content = 'dense transcript line\n'.repeat(250);
      writeFileSync(filePath, content);
      await seedWorthProcessingVerdict(engine, filePath, content);

      const result = await runPhaseSynthesize(engine, {
        brainDir,
        dryRun: false,
      });

      expect(result.status).toBe('ok');

      const jobs = await engine.executeRaw<{ timeout_ms: string | number | null }>(
        `SELECT timeout_ms
           FROM minion_jobs
          WHERE name = 'subagent'
          ORDER BY id DESC
          LIMIT 1`,
      );
      expect(jobs).toHaveLength(1);
      expect(Number(jobs[0].timeout_ms)).toBe(600000);
    } finally {
      try { await engine.disconnect(); } catch { /* best-effort */ }
      rmSync(brainDir, { recursive: true, force: true });
      rmSync(corpusDir, { recursive: true, force: true });
    }
  }, 30_000);
});
