/**
 * #1594 — dream synthesize subagent timeouts are config keys, not hardcoded
 * 30/35-minute constants. Approach ported from PR #1596 (@ai920wisco).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runPhaseSynthesize, TRIAGE_VERSION } from '../src/core/cycle/synthesize.ts';
import { TIER_DEFAULTS } from '../src/core/model-config.ts';

let engine: PGLiteEngine;
let schemaVersion: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
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

async function seedWorthProcessingVerdict(
  filePath: string,
  content: string,
): Promise<void> {
  const contentHash = createHash('sha256').update(content, 'utf8').digest('hex');
  // Triage-v1 cache validity requires score + matching (model, triage_version);
  // TIER_DEFAULTS.utility is what loadSynthConfig resolves in a bare test env.
  await engine.putDreamVerdict(filePath, contentHash, {
    worth_processing: true,
    reasons: ['seeded for timeout config test'],
    score: 0.9,
    content_type: null,
    segments: [],
    entities: [],
    model: TIER_DEFAULTS.utility,
    triage_version: TRIAGE_VERSION,
  });
}

describe('runPhaseSynthesize subagent timeout config', () => {
  test('dream.synthesize.subagent_timeout_ms flows to submitted subagent job', async () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-synth-timeout-brain-'));
    const corpusDir = mkdtempSync(join(tmpdir(), 'gbrain-synth-timeout-corpus-'));

    try {
      await engine.setConfig('dream.synthesize.enabled', 'true');
      await engine.setConfig('dream.synthesize.session_corpus_dir', corpusDir);
      await engine.setConfig('dream.synthesize.subagent_timeout_ms', '600000');
      await engine.setConfig('dream.synthesize.subagent_wait_timeout_ms', '1');

      const filePath = join(corpusDir, '2026-05-28-dense-transcript.txt');
      const content = 'dense transcript line\n'.repeat(250);
      writeFileSync(filePath, content);
      await seedWorthProcessingVerdict(filePath, content);

      const result = await runPhaseSynthesize(engine, {
        brainDir,
        dryRun: false,
      });

      // CDX-4 (#4217 family): the child dies in this keyless harness, and a
      // run whose EVERY child died is now an honest phase failure instead of
      // 'ok'. This test's subject — the timeout config flowing onto the job
      // row — is asserted below regardless.
      expect(result.status).toBe('fail');
      expect(result.error?.code).toBe('SYNTH_ALL_CHILDREN_DEAD');

      const jobs = await engine.executeRaw<{ timeout_ms: string | number | null }>(
        `SELECT timeout_ms
           FROM minion_jobs
          WHERE name = 'subagent'
          ORDER BY id DESC
          LIMIT 1`,
      );
      expect(jobs).toHaveLength(1);
      expect(Number(jobs[0]!.timeout_ms)).toBe(600000);
    } finally {
      rmSync(brainDir, { recursive: true, force: true });
      rmSync(corpusDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('#4168 sibling — child budgets clamp to the remaining job deadline', () => {
  test('a tight deadlineAtMs clamps the submitted child timeout_ms below the configured default', async () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-synth-clamp-brain-'));
    const corpusDir = mkdtempSync(join(tmpdir(), 'gbrain-synth-clamp-corpus-'));
    try {
      await engine.setConfig('dream.synthesize.enabled', 'true');
      await engine.setConfig('dream.synthesize.session_corpus_dir', corpusDir);
      await engine.setConfig('dream.synthesize.subagent_timeout_ms', '600000'); // 10min configured
      await engine.setConfig('dream.synthesize.subagent_wait_timeout_ms', '1');

      const filePath = join(corpusDir, '2026-05-29-clamped-transcript.txt');
      const content = 'clamped transcript line\n'.repeat(250);
      writeFileSync(filePath, content);
      await seedWorthProcessingVerdict(filePath, content);

      // ~5.5min of job budget left: after the 60s reserve the child budget is
      // ~4.5min — under the 10min config, so the clamp must bind.
      const result = await runPhaseSynthesize(engine, {
        brainDir,
        dryRun: false,
        deadlineAtMs: Date.now() + 5.5 * 60 * 1000,
      });
      // CDX-4 (#4217 family): the keyless child dies, and a run whose EVERY
      // child died is an honest phase failure. This test's subject — the
      // #4168 clamp on the submitted job row — is asserted below regardless.
      expect(result.status).toBe('fail');
      expect(result.error?.code).toBe('SYNTH_ALL_CHILDREN_DEAD');

      const jobs = await engine.executeRaw<{ timeout_ms: string | number | null }>(
        `SELECT timeout_ms FROM minion_jobs WHERE name = 'subagent' ORDER BY id DESC LIMIT 1`,
      );
      expect(jobs).toHaveLength(1);
      const clamped = Number(jobs[0]!.timeout_ms);
      expect(clamped).toBeLessThan(600000); // pre-fix: raw 600000 submitted
      expect(clamped).toBeGreaterThan(2 * 60 * 1000); // above the MIN floor
    } finally {
      rmSync(brainDir, { recursive: true, force: true });
      rmSync(corpusDir, { recursive: true, force: true });
    }
  }, 30_000);

  test('an exhausted job budget skips honestly (insufficient_cycle_budget) without submitting a child', async () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-synth-skip-brain-'));
    const corpusDir = mkdtempSync(join(tmpdir(), 'gbrain-synth-skip-corpus-'));
    try {
      await engine.setConfig('dream.synthesize.enabled', 'true');
      await engine.setConfig('dream.synthesize.session_corpus_dir', corpusDir);

      const before = await engine.executeRaw<{ n: number }>(
        `SELECT count(*)::int AS n FROM minion_jobs WHERE name = 'subagent'`,
      );
      const result = await runPhaseSynthesize(engine, {
        brainDir,
        dryRun: false,
        deadlineAtMs: Date.now() + 30 * 1000, // 30s left — far under reserve+MIN
      });
      expect(result.status).toBe('skipped');
      expect((result.details as Record<string, unknown>).reason).toBe('insufficient_cycle_budget');
      const after = await engine.executeRaw<{ n: number }>(
        `SELECT count(*)::int AS n FROM minion_jobs WHERE name = 'subagent'`,
      );
      expect(after[0]!.n).toBe(before[0]!.n); // no guaranteed-timeout child submitted
    } finally {
      rmSync(brainDir, { recursive: true, force: true });
      rmSync(corpusDir, { recursive: true, force: true });
    }
  }, 30_000);

  test('no deadlineAtMs (gbrain dream CLI) keeps the configured defaults untouched', async () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-synth-nodl-brain-'));
    const corpusDir = mkdtempSync(join(tmpdir(), 'gbrain-synth-nodl-corpus-'));
    try {
      await engine.setConfig('dream.synthesize.enabled', 'true');
      await engine.setConfig('dream.synthesize.session_corpus_dir', corpusDir);
      await engine.setConfig('dream.synthesize.subagent_timeout_ms', '600000');
      await engine.setConfig('dream.synthesize.subagent_wait_timeout_ms', '1');

      const filePath = join(corpusDir, '2026-05-30-unclamped-transcript.txt');
      const content = 'unclamped transcript line\n'.repeat(250);
      writeFileSync(filePath, content);
      await seedWorthProcessingVerdict(filePath, content);

      const result = await runPhaseSynthesize(engine, { brainDir, dryRun: false });
      // CDX-4: keyless child dies → honest phase failure; the unclamped
      // timeout on the submitted row is the subject and asserts regardless.
      expect(result.status).toBe('fail');
      expect(result.error?.code).toBe('SYNTH_ALL_CHILDREN_DEAD');
      const jobs = await engine.executeRaw<{ timeout_ms: string | number | null }>(
        `SELECT timeout_ms FROM minion_jobs WHERE name = 'subagent' ORDER BY id DESC LIMIT 1`,
      );
      expect(Number(jobs[0]!.timeout_ms)).toBe(600000);
    } finally {
      rmSync(brainDir, { recursive: true, force: true });
      rmSync(corpusDir, { recursive: true, force: true });
    }
  }, 30_000);
});
