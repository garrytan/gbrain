/**
 * W3 (GBRA-224, #5848): a synthesize window with zero candidates returns before
 * triage, the manifest context and the fan-out: no model call, no embedding
 * call, no job row. Every discovered transcript already synthesized is the
 * real-world shape (a collector outage leaves only old files in the corpus).
 * The status stays ok so outputs an earlier pass deferred still finish (#6757).
 * The brain dir here is a plain directory with no git repository (repo-less).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runPhaseSynthesize } from '../src/core/cycle/synthesize.ts';
import { __setChatTransportForTests, __setEmbedTransportForTests, __setGenerateObjectTransportForTests, __setGenerateTextTransportForTests } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let schemaVersion: string;
let brainDir: string;
let corpusDir: string;
let providerCalls: string[];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
  schemaVersion = (await engine.getConfig('version')) ?? '7';
}, 60_000);

afterAll(async () => { await engine.disconnect(); });

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-w3-nocand-brain-'));
  corpusDir = mkdtempSync(join(tmpdir(), 'gbrain-w3-nocand-corpus-'));
  await engine.setConfig('dream.synthesize.enabled', 'true');
  await engine.setConfig('dream.synthesize.session_corpus_dir', corpusDir);
  providerCalls = [];
  const refuse = (kind: string) => async () => { providerCalls.push(kind); throw new Error(`no provider call expected (${kind})`); };
  __setChatTransportForTests(refuse('chat') as never);
  __setEmbedTransportForTests(refuse('embed') as never);
  __setGenerateObjectTransportForTests(refuse('object') as never);
  __setGenerateTextTransportForTests(refuse('text') as never);
});

afterEach(() => {
  __setChatTransportForTests(null as never);
  __setEmbedTransportForTests(null);
  __setGenerateObjectTransportForTests(null);
  __setGenerateTextTransportForTests(null);
  rmSync(brainDir, { recursive: true, force: true });
  rmSync(corpusDir, { recursive: true, force: true });
});

function writeTranscript(name: string): string {
  const content = `conversation in ${name}\n`.repeat(200);
  writeFileSync(join(corpusDir, name), content);
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

async function seedCompleted(key: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO minion_jobs (submission_authority, name, queue, status, data, idempotency_key, finished_at)
     VALUES ('{"version":1,"kind":"application"}'::jsonb, 'subagent', 'dream-inline-done', 'completed', jsonb_build_object('source_id', 'default'), $1, now())`,
    [key]);
}

const jobRows = async () => (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM minion_jobs'))[0]!.n;
const run = () => withEnv({ ANTHROPIC_API_KEY: 'sk-test-not-used', OPENAI_API_KEY: 'sk-test-not-used' },
  () => runPhaseSynthesize(engine, { brainDir, dryRun: false }));

describe('#5848 zero-candidate synthesize windows are free', () => {
  test('every transcript already synthesized: returns before triage with reason no_candidates, no provider call, no job row', async () => {
    for (const name of ['2026-09-10-old.txt', '2026-09-11-old.txt']) {
      await seedCompleted(`dream:synth-v2:default:filename:${encodeURIComponent(name)}:${writeTranscript(name)}`);
    }
    const before = await jobRows();
    const result = await run();
    expect(result.status).toBe('ok');
    expect(result.details).toMatchObject({ reason: 'no_candidates', transcripts_processed: 0, pages_written: 0,
      synthesis_state: { candidates: 0, already_synthesized: 2 } });
    expect(result.details).not.toHaveProperty('triage');
    expect((result.details as { skips: Array<{ reason: string }> }).skips.map(s => s.reason)).toEqual(['already_synthesized_v2_single_chunk', 'already_synthesized_v2_single_chunk']);
    expect(providerCalls).toEqual([]);
    expect(await jobRows()).toBe(before);
    expect(await engine.getConfig('dream.synthesize.last_completion_ts')).toBeTruthy();
  }, 60_000);

  test('an empty window returns no_candidates without a provider call', async () => {
    const result = await run();
    expect(result.status).toBe('ok');
    expect(result.summary).toBe('no transcripts to process');
    expect(result.details).toMatchObject({ reason: 'no_candidates', transcripts_discovered: 0 });
    expect(providerCalls).toEqual([]);
    expect(await jobRows()).toBe(0);
  }, 60_000);

  test('one new transcript next to synthesized ones still goes to triage', async () => {
    const name = '2026-09-12-done.txt';
    await seedCompleted(`dream:synth-v2:default:filename:${encodeURIComponent(name)}:${writeTranscript(name)}`);
    writeTranscript('2026-09-13-new.txt');
    await engine.setConfig('models.dream.triage', 'no-such-provider:judge');
    const result = await run();
    expect(result.details).not.toHaveProperty('reason', 'no_candidates');
    expect(result.details).toMatchObject({ synthesis_state: { candidates: 1, already_synthesized: 1 } });
  }, 60_000);
});
