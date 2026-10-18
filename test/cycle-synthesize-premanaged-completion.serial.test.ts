/**
 * A brain that turns on managed persistence keeps the synthesis completions
 * its classic runs recorded: legacy `dream:synth:` keys and synth-v2 keys
 * under the bare source id. Before this fix a managed run (and a managed dry
 * run) matched only `<source>/<incarnation>` keys, so every transcript a
 * classic run had already synthesized went back through paid triage and
 * paid synthesis after the cutover.
 *
 * Completions keyed to an older incarnation, classic jobs submitted before
 * the source row was (re)created (even when they finish later), and archived
 * completions (no submission time to prove which source row they belong to)
 * still do not count.
 *
 * The triage model has no provider recipe, so a transcript that reaches
 * triage shows up as `degraded`; one screened out first never reaches it.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

// A real managed run needs a registered writer; stand in for the preflight
// (and the publication it would gate) so the actual partition and fan-out run.
const realMaintenance = await import('../src/core/persistence/prepared-maintenance.ts');
const realPostprocess = await import('../src/core/cycle/synthesize-postprocess.ts');
let incarnation = '';
mock.module('../src/core/persistence/prepared-maintenance.ts', () => ({
  ...realMaintenance,
  maintenancePreflight: async () => ({ writer: { sourceIncarnation: incarnation }, binding: null }),
  publishMaintenancePage: async () => undefined,
}));
mock.module('../src/core/cycle/synthesize-postprocess.ts', () => ({
  ...realPostprocess,
  postprocessManagedSynthesis: async () => ({ writtenRefs: [], finalizedRefs: [], pending: 0, conflicts: [], stats: null }),
}));
const { runPhaseSynthesize } = await import('../src/core/cycle/synthesize.ts');

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
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-premanaged-brain-'));
  corpusDir = mkdtempSync(join(tmpdir(), 'gbrain-premanaged-corpus-'));
  await engine.setConfig('dream.synthesize.enabled', 'true');
  await engine.setConfig('dream.synthesize.session_corpus_dir', corpusDir);
  await engine.setConfig('models.dream.triage', 'no-such-provider:judge');
  // The source row predates the classic completions seeded below.
  await engine.executeRaw(`UPDATE sources SET created_at = now() - interval '30 days' WHERE id = 'default'`);
  await engine.executeRaw('UPDATE persistence_brain SET enabled = true WHERE singleton = 1');
  const [row] = await engine.executeRaw<{ incarnation: string }>(`SELECT incarnation::text AS incarnation FROM sources WHERE id = 'default'`);
  incarnation = row.incarnation;
});

function writeTranscript(name: string): { filePath: string; hash16: string } {
  const content = `conversation in ${name}\n`.repeat(200);
  const filePath = join(corpusDir, name);
  writeFileSync(filePath, content);
  return { filePath, hash16: createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16) };
}

async function seedCompleted(idempotencyKey: string, submittedDaysAgo = 10, finishedDaysAgo = submittedDaysAgo): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO minion_jobs (submission_authority, name, queue, status, data, idempotency_key, created_at, finished_at)
     VALUES ('{"version":1,"kind":"application"}'::jsonb, 'subagent', 'dream-inline-done', 'completed',
             jsonb_build_object('source_id', 'default'), $1,
             now() - make_interval(days => $2::int), now() - make_interval(days => $3::int))`,
    [idempotencyKey, submittedDaysAgo, finishedDaysAgo],
  );
}

async function seedArchived(idempotencyKey: string, completedDaysAgo = 10): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO dream_synthesis_completions (source_id, idempotency_key, completed_at)
     VALUES ('default', $1, now() - make_interval(days => $2::int))`,
    [idempotencyKey, completedDaysAgo],
  );
}

const classicV2 = (name: string, hash16: string) => `dream:synth-v2:default:filename:${encodeURIComponent(name)}:${hash16}`;

interface Details {
  triage: { judged: number; degraded: number };
  synthesis_state: { candidates: number; already_synthesized: number };
  skips?: Array<{ filePath: string; reason: string }>;
}

function cleanup(): void {
  rmSync(brainDir, { recursive: true, force: true });
  rmSync(corpusDir, { recursive: true, force: true });
}

describe('managed synthesis honours classic completions of the same source', () => {
  test('managed dry run: classic synth-v2, chunked and legacy completions skip triage', async () => {
    const v2 = writeTranscript('2026-09-01-v2.txt');
    const chunked = writeTranscript('2026-09-02-chunked.txt');
    const legacy = writeTranscript('2026-09-03-legacy.txt');
    writeTranscript('2026-09-04-new.txt');
    await seedCompleted(classicV2('2026-09-01-v2.txt', v2.hash16));
    await seedCompleted(`${classicV2('2026-09-02-chunked.txt', chunked.hash16)}:c0of2`);
    await seedCompleted(`${classicV2('2026-09-02-chunked.txt', chunked.hash16)}:c1of2`);
    await seedCompleted(`dream:synth:/old/root/2026-09-03-legacy.txt:${legacy.hash16}`);
    const result = await runPhaseSynthesize(engine, { brainDir, dryRun: true });
    const d = result.details as unknown as Details;
    expect(d.synthesis_state).toEqual({ candidates: 1, already_synthesized: 3 });
    expect(d.triage.degraded).toBe(1);
    cleanup();
  }, 60_000);

  test('managed real run skips classic completions in the fan-out and submits nothing for them', async () => {
    const v2 = writeTranscript('2026-09-05-v2.txt');
    const legacy = writeTranscript('2026-09-06-legacy.txt');
    await seedCompleted(classicV2('2026-09-05-v2.txt', v2.hash16));
    await seedCompleted(`dream:synth:${legacy.filePath}:${legacy.hash16}`);
    const result = await runPhaseSynthesize(engine, { brainDir, dryRun: false });
    const d = result.details as unknown as Details;
    expect(d.synthesis_state).toEqual({ candidates: 0, already_synthesized: 2 });
    expect(d.triage.degraded).toBe(0);
    expect(d.skips).toContainEqual({ filePath: v2.filePath, reason: 'already_synthesized_v2_single_chunk' });
    expect(d.skips).toContainEqual({ filePath: legacy.filePath, reason: 'already_synthesized_legacy_single_chunk' });
    const [submitted] = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM minion_jobs WHERE name = 'subagent' AND status <> 'completed'`);
    expect(submitted.n).toBe(0);
    cleanup();
  }, 60_000);

  test('older-incarnation keys, pre-recreation jobs (even finishing late) and archived rows still re-run', async () => {
    const stale = writeTranscript('2026-09-07-stale-incarnation.txt');
    const readded = writeTranscript('2026-09-08-before-readd.txt');
    const late = writeTranscript('2026-09-09-late-finish.txt');
    const archived = writeTranscript('2026-09-10-archived.txt');
    const oldIncarnation = '00000000-0000-4000-8000-000000000001';
    await seedCompleted(`dream:synth-v2:${encodeURIComponent(`default/${oldIncarnation}`)}:filename:${encodeURIComponent('2026-09-07-stale-incarnation.txt')}:${stale.hash16}`);
    await seedCompleted(`dream:synth:${readded.filePath}:${readded.hash16}`, 45);
    // Submitted under the removed source row, finished after the re-add.
    await seedCompleted(classicV2('2026-09-09-late-finish.txt', late.hash16), 45, 10);
    // Prune stamps an unknown finish as now(): the archive cannot prove the row.
    await seedArchived(classicV2('2026-09-10-archived.txt', archived.hash16), 0);
    await seedArchived(`dream:synth:${archived.filePath}:${archived.hash16}`, 0);
    const result = await runPhaseSynthesize(engine, { brainDir, dryRun: true });
    const d = result.details as unknown as Details;
    expect(d.synthesis_state).toEqual({ candidates: 4, already_synthesized: 0 });
    expect(d.triage.degraded).toBe(4);
    cleanup();
  }, 60_000);
});
