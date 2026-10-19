/**
 * Synthesis completions are keyed on the transcript body, not the whole file.
 *
 * Before, the synth-v2 key and the page slug suffix carried a sha256 of the
 * whole transcript file, frontmatter included, so an edit that only touched
 * frontmatter (a `type:` stamp, a drift repair) re-synthesized the transcript
 * and wrote a second generation of pages beside the first.
 *
 * Completions recorded before body keying carry the full-file hash. They must
 * keep counting (an upgrade re-synthesizes nothing), and a real run records
 * them under the body hash so a later frontmatter-only edit does not re-arm
 * them either.
 *
 * PGLite, no API key: dry runs use a triage model with no provider recipe, and
 * the real run that submits gets a pre-seeded verdict and auto-cancelled
 * children (the cycle-synthesize-daily-cap harness).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { runPhaseSynthesize, TRIAGE_VERSION } from '../src/core/cycle/synthesize.ts';
import { TIER_DEFAULTS } from '../src/core/model-config.ts';

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
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-bodyhash-brain-'));
  corpusDir = mkdtempSync(join(tmpdir(), 'gbrain-bodyhash-corpus-'));
  await engine.setConfig('dream.synthesize.enabled', 'true');
  await engine.setConfig('dream.synthesize.cooldown_hours', '0');
  await engine.setConfig('dream.synthesize.session_corpus_dir', corpusDir);
});

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const BODY = 'Mentor: what did you trade today?\nMe: nothing, I waited for the setup.\n'.repeat(60);
const NAME = '2026-01-05_mentor-session.md';
const key = (hash: string) => `dream:synth-v2:default:filename:${encodeURIComponent(NAME)}:${hash.slice(0, 16)}`;

function writeTranscript(frontmatter: string, body = BODY): { filePath: string; fileHash: string } {
  const content = `---\n${frontmatter}---\n\n${body}`;
  const filePath = join(corpusDir, NAME);
  writeFileSync(filePath, content);
  return { filePath, fileHash: sha256(content) };
}

async function seedCompleted(idempotencyKey: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO minion_jobs (submission_authority, name, queue, status, data, idempotency_key, finished_at)
     VALUES ('{"version":1,"kind":"application"}'::jsonb, 'subagent', 'dream-inline-done', 'completed',
             jsonb_build_object('source_id', 'default'), $1, now())`,
    [idempotencyKey],
  );
}

async function run(dryRun: boolean): Promise<{ candidates: number; already_synthesized: number } | undefined> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-bodyhash-home-'));
  try {
    const result = await withEnv({ ANTHROPIC_API_KEY: undefined, GBRAIN_HOME: home }, () =>
      runPhaseSynthesize(engine, { brainDir, dryRun }));
    return (result.details as { synthesis_state?: { candidates: number; already_synthesized: number } } | undefined)?.synthesis_state;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

async function seedVerdict(filePath: string, fileHash: string): Promise<void> {
  await engine.putDreamVerdict(filePath, fileHash, {
    worth_processing: true, reasons: ['seed'], score: 0.9, content_type: null, segments: [], entities: [],
    model: TIER_DEFAULTS.utility, triage_version: TRIAGE_VERSION,
  });
}

/** A real run whose children are cancelled as soon as they are queued; returns every subagent job it left. */
async function submit(): Promise<Array<{ idempotency_key: string; suffix: string | null; prompt: string }>> {
  let stopped = false;
  const cancelChildren = (async () => {
    while (!stopped) {
      await new Promise(r => setTimeout(r, 50));
      try {
        await engine.executeRaw(
          `UPDATE minion_jobs SET status = 'cancelled', finished_at = now()
            WHERE name = 'subagent' AND status IN ('waiting', 'active')`);
      } catch { /* race against shutdown is fine */ }
    }
  })();
  try {
    await run(false);
  } finally {
    stopped = true;
    await cancelChildren;
  }
  return engine.executeRaw(
    `SELECT idempotency_key, data->>'oneshot_slug_suffix' AS suffix, data->>'prompt' AS prompt
       FROM minion_jobs WHERE name = 'subagent' ORDER BY idempotency_key`);
}

// 350K-char chunks (the max_prompt_tokens floor), so LONG_BODY splits in three.
const LONG_BODY = Array.from({ length: 16_000 }, (_, i) => `Mentor: line ${i}, what did you trade today?\n`).join('');

afterEach(() => {
  rmSync(brainDir, { recursive: true, force: true });
  rmSync(corpusDir, { recursive: true, force: true });
});

describe('synthesis completions keyed on the transcript body', () => {
  test('a frontmatter-only edit does not re-arm a synthesized transcript', async () => {
    await engine.setConfig('models.dream.triage', 'no-such-provider:judge');
    writeTranscript('title: Mentor session\n');
    await seedCompleted(key(sha256(BODY)));
    writeTranscript('title: Mentor session\ntype: conversation\n');
    expect(await run(true)).toEqual({ candidates: 0, already_synthesized: 1 });
  }, 60_000);

  test('a body edit re-arms it', async () => {
    await engine.setConfig('models.dream.triage', 'no-such-provider:judge');
    await seedCompleted(key(sha256(BODY)));
    writeTranscript('title: Mentor session\n', `${BODY}Me: one more line.\n`);
    expect(await run(true)).toEqual({ candidates: 1, already_synthesized: 0 });
  }, 60_000);

  test('a completion keyed on the full-file hash still counts and survives a later frontmatter-only edit', async () => {
    await engine.setConfig('models.dream.triage', 'no-such-provider:judge');
    const { fileHash } = writeTranscript('title: Mentor session\n');
    await seedCompleted(key(fileHash));
    expect(await run(false)).toEqual({ candidates: 0, already_synthesized: 1 });
    writeTranscript('title: Mentor session\ntype: conversation\n');
    expect(await run(true)).toEqual({ candidates: 0, already_synthesized: 1 });
  }, 60_000);

  test('a new synthesis is keyed and slugged on the body hash', async () => {
    const { filePath, fileHash } = writeTranscript('title: Mentor session\n');
    await seedVerdict(filePath, fileHash);
    const jobs = await submit();
    expect(jobs.map(({ idempotency_key, suffix }) => ({ idempotency_key, suffix })))
      .toEqual([{ idempotency_key: key(sha256(BODY)), suffix: sha256(BODY).slice(0, 6) }]);
  }, 60_000);

  test('a frontmatter edit leaves chunk bounds where they were', async () => {
    await engine.setConfig('dream.synthesize.max_prompt_tokens', '100000');
    const before = writeTranscript('title: Mentor session\n', LONG_BODY);
    await seedVerdict(before.filePath, before.fileHash);
    const first = await submit();
    await engine.executeRaw(`DELETE FROM minion_jobs WHERE name = 'subagent'`);
    const after = writeTranscript(`title: Mentor session\ndescription: ${'long '.repeat(400)}\n`, LONG_BODY);
    await seedVerdict(after.filePath, after.fileHash);
    const second = await submit();
    expect(first.map(j => j.idempotency_key)).toEqual([0, 1, 2].map(i => `${key(sha256(LONG_BODY))}:c${i}of3`));
    expect(second.map(j => j.idempotency_key)).toEqual(first.map(j => j.idempotency_key));
    // Only the first chunk carries the frontmatter; the others are the same body text.
    expect(second.slice(1).map(j => j.prompt)).toEqual(first.slice(1).map(j => j.prompt));
  }, 120_000);

  test('a chunk set started under the full-file hash finishes under its own keys', async () => {
    await engine.setConfig('dream.synthesize.max_prompt_tokens', '100000');
    const { filePath, fileHash } = writeTranscript('title: Mentor session\n', LONG_BODY);
    await seedVerdict(filePath, fileHash);
    await seedCompleted(`${key(fileHash)}:c0of3`);
    const jobs = await submit();
    expect(jobs.map(({ idempotency_key, suffix }) => ({ idempotency_key, suffix }))).toEqual([
      { idempotency_key: `${key(fileHash)}:c0of3`, suffix: null },
      { idempotency_key: `${key(fileHash)}:c1of3`, suffix: `${fileHash.slice(0, 6)}-c1` },
      { idempotency_key: `${key(fileHash)}:c2of3`, suffix: `${fileHash.slice(0, 6)}-c2` },
    ]);
  }, 120_000);

  test('a legacy completion keyed on the full-file hash survives a later frontmatter-only edit', async () => {
    await engine.setConfig('models.dream.triage', 'no-such-provider:judge');
    const { filePath, fileHash } = writeTranscript('title: Mentor session\n');
    await seedCompleted(`dream:synth:${filePath}:${fileHash.slice(0, 16)}`);
    expect(await run(false)).toEqual({ candidates: 0, already_synthesized: 1 });
    writeTranscript('title: Mentor session\ntype: conversation\n');
    expect(await run(true)).toEqual({ candidates: 0, already_synthesized: 1 });
  }, 60_000);

  test('prose between two horizontal rules is part of the hashed text', async () => {
    const filePath = join(corpusDir, NAME);
    const original = `---\nWe keep the customer contract.\n---\n\n${BODY}`;
    writeFileSync(filePath, original);
    await seedVerdict(filePath, sha256(original));
    await submit();
    await engine.executeRaw(`UPDATE minion_jobs SET status = 'completed' WHERE name = 'subagent'`);
    writeFileSync(filePath, `---\nWe cancel the customer contract.\n---\n\n${BODY}`);
    await engine.setConfig('models.dream.triage', 'no-such-provider:judge');
    expect(await run(true)).toEqual({ candidates: 1, already_synthesized: 0 });
  }, 60_000);
});
