/**
 * #5145 (fix wave 9) — synthesize checks completed synthesis BEFORE the paid
 * triage pass on classic brains and in dry runs.
 *
 * Pre-fix only the managed real-run path consulted completion keys before
 * triage. A classic brain, or any `--dry-run`, triaged already-synthesized
 * transcripts first (a paid judge call whenever the verdict cache had
 * expired) and skipped them only afterwards; the dry run returned before any
 * completion check at all.
 *
 * The triage model is set to an id with no provider recipe, so the judge
 * resolves to null and no network call is possible: a transcript that
 * reaches triage shows up as `degraded`, one that is screened out first does
 * not reach triage at all.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runPhaseSynthesize } from '../src/core/cycle/synthesize.ts';

let engine: PGLiteEngine;
let schemaVersion: string;
let brainDir: string;
let corpusDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
  schemaVersion = (await engine.getConfig('version')) ?? '7';
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-5145-brain-'));
  corpusDir = mkdtempSync(join(tmpdir(), 'gbrain-5145-corpus-'));
  await engine.setConfig('dream.synthesize.enabled', 'true');
  await engine.setConfig('dream.synthesize.session_corpus_dir', corpusDir);
  await engine.setConfig('models.dream.triage', 'no-such-provider:judge');
});

function writeTranscript(name: string): { filePath: string; hash16: string } {
  const content = `conversation in ${name}\n`.repeat(200);
  const filePath = join(corpusDir, name);
  writeFileSync(filePath, content);
  return { filePath, hash16: createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16) };
}

async function seedCompleted(idempotencyKey: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO minion_jobs (submission_authority, name, queue, status, data, idempotency_key, finished_at)
     VALUES ('{"version":1,"kind":"application"}'::jsonb, 'subagent', 'dream-inline-done', 'completed',
             jsonb_build_object('source_id', 'default'), $1, now())`,
    [idempotencyKey],
  );
}

interface Details {
  triage: { judged: number; degraded: number; cache_hits: number; deferred: number };
  synthesis_state: { candidates: number; already_synthesized: number };
  skips?: Array<{ filePath: string; reason: string }>;
}

describe('#5145 completed synthesis is screened out before triage', () => {
  test('dry run on an unchanged classic brain makes no triage call for a v2-completed transcript', async () => {
    const done = writeTranscript('2026-09-01-done.txt');
    await seedCompleted(`dream:synth-v2:default:filename:${encodeURIComponent('2026-09-01-done.txt')}:${done.hash16}`);
    const result = await runPhaseSynthesize(engine, { brainDir, dryRun: true });
    const d = result.details as unknown as Details;
    expect(d.triage.judged).toBe(0);
    expect(d.triage.degraded).toBe(0);
    expect(d.triage.cache_hits).toBe(0);
    expect(d.synthesis_state).toEqual({ candidates: 0, already_synthesized: 1 });
    expect(result.summary).toContain('0 of 0 transcripts would synthesize; 1 already synthesized');
    rmSync(brainDir, { recursive: true, force: true });
    rmSync(corpusDir, { recursive: true, force: true });
  }, 60_000);

  test('a classic real run skips a legacy-key completion without triaging it; new transcripts are still screened', async () => {
    const done = writeTranscript('2026-09-02-legacy.txt');
    writeTranscript('2026-09-03-new.txt');
    await seedCompleted(`dream:synth:${done.filePath}:${done.hash16}`);
    const result = await runPhaseSynthesize(engine, { brainDir, dryRun: false });
    const d = result.details as unknown as Details;
    expect(d.synthesis_state).toEqual({ candidates: 1, already_synthesized: 1 });
    expect(d.triage.degraded).toBe(1);
    expect(d.skips).toContainEqual({ filePath: done.filePath, reason: 'already_synthesized_legacy_single_chunk' });
    rmSync(brainDir, { recursive: true, force: true });
    rmSync(corpusDir, { recursive: true, force: true });
  }, 60_000);
});
