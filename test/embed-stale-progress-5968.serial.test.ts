/**
 * #5968 (wave 15 P2.6, [R28]): `embed --stale` progress is exact chunk
 * accounting, never an estimate that overshoots 100%.
 *
 * Before: the callback reported distinct pages processed against
 * `ceil(census / batchSize) × keys-in-this-batch`, so a batch with fewer keys
 * shrank the denominator while the numerator kept climbing (the reporter's
 * 529/176), and the CLI froze the first batch's total while ticking per page.
 *
 * Now the unit is stale chunks: total starts at the census, grows by the heal
 * delta when one oversized stored chunk splits into several BEFORE the
 * callback that reports that page, and `done <= total` at every callback.
 *
 * Serial: sets GBRAIN_MAX_CHUNK_TOKENS and installs the process-global gateway
 * transport seam; the CLI arm swaps the process-global CLI options.
 */
import { installFixtureChunks } from './helpers/page-projection.ts';
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { runEmbed, runEmbedCore } from '../src/commands/embed.ts';
import { __setEmbedTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { getCliOptions, setCliOptions } from '../src/core/cli-options.ts';
import { estimateEmbedTokens } from '../src/core/chunkers/token-estimate.ts';
import { EMBED_PROBE_TEXT } from '../src/core/embed-stale.ts';
import { resolveMaxChunkTokens } from '../src/core/embedding-input-limit.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const DIMS = 1536;
const MODEL = 'openai:text-embedding-3-large';
const CAP = 128;
const OVERSIZED = 'A stored pre-cap chunk that the heal must split into several pieces before any embed call is made. '.repeat(40);
const SINGLE_PAGES = 8;

let engine: PGLiteEngine;

async function seedCensus(): Promise<number> {
  for (let i = 0; i < SINGLE_PAGES; i++) {
    const slug = `notes/stale-${String(i).padStart(2, '0')}`;
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}` });
    await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: `${slug} body`, chunk_source: 'compiled_truth', token_count: 4 }]);
  }
  await engine.putPage('notes/oversized', { type: 'note', title: 'oversized', compiled_truth: '# oversized' });
  await installFixtureChunks(engine, 'notes/oversized', [{ chunk_index: 0, chunk_text: OVERSIZED, chunk_source: 'compiled_truth', token_count: 5000 }]);
  const census = await engine.countStaleChunks({ sourceId: 'default' });
  expect(census).toBe(SINGLE_PAGES + 1);
  return census;
}

beforeAll(async () => {
  process.env.GBRAIN_MAX_CHUNK_TOKENS = String(CAP);
  expect(resolveMaxChunkTokens()).toBe(CAP);
  expect(estimateEmbedTokens(OVERSIZED)).toBeGreaterThan(4 * CAP);
  configureGateway({ embedding_model: MODEL, embedding_dimensions: DIMS, env: { ...process.env, OPENAI_API_KEY: 'sk-test-fake' } });
  __setEmbedTransportForTests((async (input: { values: string[] }) => ({
    embeddings: input.values.map(() => new Array(DIMS).fill(0.001)), usage: { tokens: input.values.length * 4 },
  })) as never);
  engine = new PGLiteEngine();
  await engine.connect({ embedding_dimensions: DIMS } as never);
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  delete process.env.GBRAIN_MAX_CHUNK_TOKENS;
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

beforeEach(async () => { await resetPgliteState(engine); });

describe('#5968 embed --stale progress counts chunks exactly', () => {
  test('two-row batches over single-chunk pages plus one oversized chunk: done <= total at every callback, total grows by the heal delta, and the run ends at 100%', async () => {
    const census = await seedCensus();
    const events: Array<{ done: number; total: number }> = [];
    const result = await runEmbedCore(engine, {
      stale: true, quiet: true, batchSize: 2,
      onProgress: (done, total) => events.push({ done, total }),
    });
    expect(result.failures).toBe(0);
    expect(result.healed_splits ?? 0).toBeGreaterThanOrEqual(1);
    const pieces = (await engine.getChunks('notes/oversized')).length;
    expect(pieces).toBeGreaterThanOrEqual(4);
    expect(events.length).toBeGreaterThanOrEqual(SINGLE_PAGES + 1);
    for (const e of events) {
      expect(e.done).toBeLessThanOrEqual(e.total);
      expect(e.total).toBeGreaterThanOrEqual(census);
    }
    const last = events.at(-1)!;
    expect(last.total).toBe(census + pieces - 1);
    expect(last.done).toBe(last.total);
    expect(await engine.countStaleChunks({ sourceId: 'default' })).toBe(0);
  });

  test('the CLI reporter ticks by chunk delta and carries the grown total: every emitted tick has done <= total and the last one is complete', async () => {
    const census = await seedCensus();
    const before = getCliOptions();
    const lines: string[] = [];
    const errSpy = spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => { lines.push(String(chunk)); return true; }) as never);
    setCliOptions({ ...before, progressJson: true, progressInterval: 0 });
    try {
      await runEmbed(engine, ['--stale', '--batch-size', '2']);
    } finally {
      setCliOptions(before);
      errSpy.mockRestore();
    }
    const ticks = lines.join('').split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter((e): e is { event: string; phase: string; done: number; total?: number } => !!e && e.phase === 'embed.pages' && e.event === 'tick');
    expect(ticks.length).toBeGreaterThan(0);
    for (const t of ticks) {
      expect(typeof t.total).toBe('number');
      expect(t.done).toBeLessThanOrEqual(t.total!);
    }
    const pieces = (await engine.getChunks('notes/oversized')).length;
    const last = ticks.at(-1)!;
    expect(last.total).toBe(census + pieces - 1);
    expect(last.done).toBe(last.total!);
  });
});

describe('#5968 StaleChunkProgress tally', () => {
  test('census, listed rows, heal delta, skipped keys and a re-entry never let done pass total', async () => {
    const { StaleChunkProgress } = await import('../src/core/embed-stale-progress.ts');
    const p = new StaleChunkProgress(10);
    p.listed(10);
    expect(p.pageDone(1, 1)).toEqual({ done: 1, total: 10 });
    // One oversized stored chunk healed into four: the total grows with the page that reports it.
    expect(p.pageDone(1, 4)).toEqual({ done: 5, total: 13 });
    // A key whose rows were filtered out after the read still counts its listed rows.
    expect(p.pageDone(2, 0)).toEqual({ done: 7, total: 13 });
    expect(p.pageDone(3, 3)).toEqual({ done: 10, total: 13 });
    expect(p.pageDone(3, 3)).toEqual({ done: 13, total: 13 });
    // Rows a writer added behind the cursor within the pass raise the total as they are listed.
    p.listed(3);
    expect(p.snapshot()).toEqual({ done: 13, total: 16 });
    expect(p.pageDone(3, 3)).toEqual({ done: 16, total: 16 });
    // A paced re-entry announces what is still stale; listing it again does not double count.
    p.reentered(2);
    expect(p.snapshot()).toEqual({ done: 16, total: 18 });
    p.listed(2);
    expect(p.pageDone(2, 2)).toEqual({ done: 18, total: 18 });
    // More rows than the re-entry announced: the total follows the listing.
    p.listed(1);
    expect(p.pageDone(1, 1)).toEqual({ done: 19, total: 19 });
  });
});
