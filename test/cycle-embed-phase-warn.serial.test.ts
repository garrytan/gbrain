/**
 * E-A (wave 0): the cycle's embed phase must not report `ok` when chunks
 * could not be embedded.
 *
 * Protects: `runEmbedCore` counts pages it cannot embed (a blocked image page
 * waiting for its importer, #6223/#6269) in `EmbedResult.failures`; the embed
 * phase turns that into `warn` with the failure samples and the paid
 * `embedBackfillFix` action, so the cycle reports `partial`. A single-flight
 * skip (`lock_skipped`) is another backfill already running, not a failure,
 * and stays `ok`. The autopilot daemon trips its breaker only on `failed`, so
 * a permanently blocked page keeps the daemon cycling.
 * Fails when: the phase ignores `failures` again (master returned `ok`).
 *
 * Named `.serial.test.ts`: configures the AI gateway and a fake embed
 * transport for its whole lifecycle, which withEnv() can't wrap.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { surfaceFileSource } from './helpers/source-surface.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { runCycle } from '../src/core/cycle.ts';
import * as embedModule from '../src/commands/embed.ts';

const DIMS = 1536;
let engine: PGLiteEngine;

beforeAll(async () => {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: DIMS,
    env: { ...process.env, OPENAI_API_KEY: 'sk-test-fake' },
  });
  __setEmbedTransportForTests(async ({ values }: { values: string[] }) => ({
    embeddings: values.map(() => new Array(DIMS).fill(0.001)),
    usage: { tokens: values.length * 4 },
  } as never));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function stalePage(slug: string) {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `Synthetic body for ${slug}.` });
  await installFixtureChunks(engine, slug, [
    { chunk_index: 0, chunk_text: `Synthetic body for ${slug}.`, chunk_source: 'compiled_truth' },
  ]);
}

async function blockedImagePage(slug: string) {
  await stalePage(slug);
  await engine.executeRaw("UPDATE pages SET page_kind='image', text_projection_revision=NULL WHERE slug=$1", [slug]);
}

const embedCycle = () => runCycle(engine, { brainDir: null, phases: ['embed'] });

describe('cycle embed phase reports embed failures (E-A)', () => {
  test('a blocked image page beside stale chunks: phase warn, cycle partial, paid backfill fix', async () => {
    await blockedImagePage('images/scan-0001');
    await stalePage('notes/healthy');
    const report = await embedCycle();
    const phase = report.phases.find(p => p.phase === 'embed')!;
    expect(phase.status).toBe('warn');
    expect(report.status).toBe('partial');
    expect(phase.details.embedded).toBe(1);
    expect(phase.details.failures).toBe(1);
    expect((phase.details.failure_samples as string[]).join(' ')).toContain('default:images/scan-0001');
    expect(phase.summary).toContain('1 chunk(s) could not be embedded this run');
    const fix = phase.details.fix as { argv: string[]; consent: string[]; verify: { argv: string[] } };
    expect(fix.argv).toEqual(['gbrain', 'embed', '--stale', '--catch-up', '--yes']);
    expect(fix.consent).toEqual(['paid']);
    expect(fix.verify.argv).toEqual(['gbrain', 'doctor', '--only', 'embeddings', '--json']);
  });

  test('a clean drain stays ok with no fix', async () => {
    await stalePage('notes/healthy');
    const report = await embedCycle();
    const phase = report.phases.find(p => p.phase === 'embed')!;
    expect(phase.status).toBe('ok');
    expect(phase.details.failures).toBe(0);
    expect(phase.details.fix).toBeUndefined();
  });

  test('the autopilot daemon keeps cycling on partial: only failed trips its breaker', () => {
    const src = surfaceFileSource('autopilot', 'src/commands/autopilot-daemon.ts');
    const inline = src.slice(src.indexOf('const report = await cyclePromise'), src.indexOf("logError('cycle-inline'"));
    expect(inline).toContain("if (report.status === 'failed') {\n        cycleOk = false;");
    expect(inline.match(/cycleOk = false/g)?.length).toBe(1);
    expect(inline).not.toMatch(/status\s*(===|!==)\s*'partial'/);
  });

  // Last in the file: mock.module replaces the embed module for the rest of
  // this process (one Bun process per serial file).
  test('lock_skipped (another backfill holds the source) stays ok', async () => {
    const lockSkipped: embedModule.EmbedResult = { embedded: 0, skipped: 0, would_embed: 0, total_chunks: 0, pages_processed: 0,
      failures: 1, failure_samples: ['another backfill is already running'], dryRun: false, chunkless_pages_healed: 0, lock_skipped: true };
    mock.module('../src/commands/embed.ts', () => ({ ...embedModule, runEmbedCore: async () => lockSkipped }));
    const report = await embedCycle();
    const phase = report.phases.find(p => p.phase === 'embed')!;
    expect(phase.status).toBe('ok');
    expect(phase.details.fix).toBeUndefined();
    expect(phase.details.failure_samples).toBeUndefined();
  });
});
