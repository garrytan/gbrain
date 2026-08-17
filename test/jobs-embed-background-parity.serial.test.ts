/**
 * Background payload parity (D7): `gbrain embed --stale --catch-up
 * --include-null-signature --batch-size N --background` used to silently
 * DEGRADE — the CLI payload builder dropped all four flags and the `embed`
 * handler read none of them, so the documented migration-recovery command ran
 * as a plain 30-minute-budget stale pass with the NULL-signature grandfather
 * clause intact. Same class as the dryRun wiring bug this file's sibling
 * (jobs-embed-background-dryrun) pinned.
 *
 *   1. Behavioral: the `embed` handler honors includeNullSignature — an
 *      embedded page with NO recorded signature is re-embedded when the job
 *      data widens, and stays grandfathered when it doesn't.
 *   2. Source pins: the payload builder serializes all four flags and the
 *      handler reads them back (the wiring the dryRun bug taught us to pin).
 */
import { describe, it, expect, beforeAll, afterAll, mock } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let embedCalls = 0;
mock.module('../src/core/embedding.ts', () => ({
  embedBatch: async (texts: string[]) => {
    embedCalls++;
    return texts.map(() => new Float32Array(1536));
  },
  currentEmbeddingSignature: () => 'test:model:1536',
  embedQuery: async () => new Float32Array(1536),
}));
import { MinionWorker } from '../src/core/minions/worker.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
const savedKey = process.env.OPENAI_API_KEY;

beforeAll(async () => {
  // The live (non-dryRun) handler path runs the embed-creds preflight —
  // configure a fake-keyed gateway (embedBatch itself is mocked above).
  process.env.OPENAI_API_KEY = 'sk-parity-test-fake';
  resetGateway();
  configureGateway({
    embedding_model: 'openai:text-embedding-3-small',
    embedding_dimensions: 1536,
    env: { OPENAI_API_KEY: 'sk-parity-test-fake' },
  });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedKey;
});

async function embedHandler() {
  const worker = new MinionWorker(engine, { concurrency: 1 });
  await registerBuiltinHandlers(worker, engine);
  const handler = (worker as unknown as {
    handlers: Map<string, (j: unknown) => Promise<unknown>>;
  }).handlers.get('embed');
  if (!handler) throw new Error('embed handler not registered');
  return handler;
}

function fakeJob(data: Record<string, unknown>) {
  return {
    id: 'job-parity-test',
    data,
    signal: new AbortController().signal,
    updateProgress: async () => {},
  };
}

describe('embed job background parity (D7)', () => {
  it('includeNullSignature in job data widens the stale pass; absent keeps the grandfather clause', async () => {
    // A page embedded (vectors present) with NO recorded signature — the
    // pre-v108 cohort the grandfather clause protects.
    await engine.putPage('parity-page', { type: 'note', title: 'parity', compiled_truth: '# p\n\nbody' });
    await engine.upsertChunks('parity-page', [
      { chunk_index: 0, chunk_text: 'parity chunk text', chunk_source: 'compiled_truth', token_count: 4, embedding: new Float32Array(1536) },
    ]);
    await engine.executeRaw(`UPDATE content_chunks SET embedded_at = now()`);
    await engine.executeRaw(`UPDATE pages SET embedding_signature = NULL WHERE slug = 'parity-page'`);

    const handler = await embedHandler();

    // Without widening: grandfathered — nothing embeds.
    embedCalls = 0;
    await handler(fakeJob({ stale: true }));
    expect(embedCalls).toBe(0);

    // With widening: the cohort is invalidated + re-embedded.
    embedCalls = 0;
    await handler(fakeJob({ stale: true, includeNullSignature: true }));
    expect(embedCalls).toBeGreaterThan(0);
  }, 30000);

  it('payload builder serializes catchUp/includeNullSignature/batchSize/priority; handler reads them', () => {
    const embedSrc = readFileSync(join(import.meta.dir, '..', 'src', 'commands', 'embed.ts'), 'utf-8');
    // The builder must carry all four (the dryRun bug: serialized but unread;
    // this class: not even serialized).
    expect(embedSrc).toContain("catchUp: cleanArgs.includes('--catch-up')");
    expect(embedSrc).toContain("includeNullSignature: cleanArgs.includes('--include-null-signature')");
    expect(embedSrc).toMatch(/paramBuilder[\s\S]{0,2500}batchSize/);
    expect(embedSrc).toMatch(/paramBuilder[\s\S]{0,2500}priority/);

    const jobsSrc = readFileSync(join(import.meta.dir, '..', 'src', 'commands', 'jobs.ts'), 'utf-8');
    expect(jobsSrc).toContain('catchUp: !!job.data.catchUp');
    expect(jobsSrc).toContain('includeNullSignature: !!job.data.includeNullSignature');
    expect(jobsSrc).toMatch(/'embed-catch-up'[\s\S]{0,900}includeNullSignature/);
  });
});
