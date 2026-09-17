import { installFixtureChunks } from './helpers/page-projection.ts';
/**
 * Chunkless-page safety net for `embed --stale`.
 *
 * `embedAllStale` (and the underlying `listStaleChunks`/`countStaleChunks`)
 * only ever scan `content_chunks` rows where `embedding IS NULL`. A page
 * written directly via `putPage` that never went through chunking (e.g. an
 * enrichment-generated entity stub — the dogfooding case this fix targets)
 * has NO `content_chunks` row at all, so it is invisible to that scan
 * forever: there is no row to go stale, no matter how many times
 * `embed --stale` runs.
 *
 * Two layers tested here:
 *   1. The detection primitive itself (`countChunklessPagesWithContent` /
 *      `listChunklessPagesWithContent`) — including that quarantined and
 *      `embed_skip` pages are excluded, since BOTH are intentionally
 *      chunkless by design (content-quality gate), not drift to repair.
 *   2. The end-to-end `embed --stale` wiring — a chunkless page gets
 *      chunked AND embedded in the SAME pass, while pre-existing stale
 *      chunks and intentionally-chunkless pages are unaffected.
 *
 * Named `.serial.test.ts` (mirrors v0_37_gap_fill.serial.test.ts Lane D.2):
 * configures the AI gateway + a fake embed transport for its whole
 * lifecycle, which withEnv() can't wrap.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { runEmbedCore } from '../src/commands/embed.ts';
import { EMBED_SKIP_KEY, buildEmbedSkipMarker } from '../src/core/embed-skip.ts';
import { QUARANTINE_KEY, buildQuarantineMarker } from '../src/core/quarantine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { recordFactWithdrawal } from '../src/core/facts/withdrawal.ts';
import { installPageEmbeddings, readProjectionSnapshot, type ProjectionSnapshot } from '../src/core/page-state/projections.ts';

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

describe('countChunklessPagesWithContent / listChunklessPagesWithContent', () => {
  test('detects a page written via putPage that was never chunked', async () => {
    await engine.putPage('stub/entity-a', {
      type: 'person',
      title: 'Entity A',
      compiled_truth: 'Entity A is a stub written directly via putPage.',
    });

    expect(await engine.countChunklessPagesWithContent()).toBe(1);
    const rows = await engine.listChunklessPagesWithContent();
    expect(rows).toHaveLength(1);
    expect(rows[0].slug).toBe('stub/entity-a');
    expect(rows[0].compiled_truth).toContain('stub written directly');
  });

  test('excludes pages that already have chunk rows', async () => {
    await engine.putPage('normal/page', { type: 'note', title: 'Normal', compiled_truth: 'hello world' });
    await installFixtureChunks(engine, 'normal/page', [
      { chunk_index: 0, chunk_text: 'hello world', chunk_source: 'compiled_truth' },
    ]);

    expect(await engine.countChunklessPagesWithContent()).toBe(0);
    expect(await engine.listChunklessPagesWithContent()).toEqual([]);
  });

  test('excludes pages with empty content', async () => {
    // Matches pages.compiled_truth's schema DEFAULT '' — the #2822 empty-put
    // case. Empty content has nothing to chunk; it is not this bug class.
    await engine.putPage('empty/page', { type: 'note', title: 'Empty', compiled_truth: '' });

    expect(await engine.countChunklessPagesWithContent()).toBe(0);
  });

  test('detects a timeline-only page (empty compiled_truth, non-empty timeline)', async () => {
    // healChunklessPages chunks compiled_truth AND timeline independently
    // (mirrors embedPage) — the SQL predicate must not require
    // compiled_truth alone or this class of page is never even detected.
    await engine.putPage('timeline-only/page', {
      type: 'note',
      title: 'Timeline Only',
      compiled_truth: '',
      timeline: '2026-01-01: something happened',
    });

    expect(await engine.countChunklessPagesWithContent()).toBe(1);
    const rows = await engine.listChunklessPagesWithContent();
    expect(rows.map(r => r.slug)).toEqual(['timeline-only/page']);
  });

  test('excludes quarantined pages (intentionally chunkless by design)', async () => {
    await engine.putPage('junk/page', {
      type: 'note',
      title: 'Junk',
      compiled_truth: 'Cloudflare interstitial junk content',
      frontmatter: { [QUARANTINE_KEY]: buildQuarantineMarker('junk_pattern', 'test fixture') },
    });

    expect(await engine.countChunklessPagesWithContent()).toBe(0);
  });

  test('excludes embed_skip pages (intentionally chunkless by design)', async () => {
    await engine.putPage('oversized/page', {
      type: 'note',
      title: 'Oversized',
      compiled_truth: 'x'.repeat(1000),
      frontmatter: { [EMBED_SKIP_KEY]: buildEmbedSkipMarker(1000) },
    });

    expect(await engine.countChunklessPagesWithContent()).toBe(0);
  });

});

describe('embed --stale chunkless-page safety net (end-to-end)', () => {
  test('a putPage-only page gets chunked AND embedded in the same --stale pass', async () => {
    await engine.putPage('stub/heal-me', {
      type: 'person',
      title: 'Heal Me',
      compiled_truth: 'This entity stub was written directly via putPage and never chunked.',
    });
    expect(await engine.getChunks('stub/heal-me')).toEqual([]);

    const result = await runEmbedCore(engine, { stale: true, quiet: true });

    expect(result.chunkless_pages_healed).toBe(1);
    const chunks = await engine.getChunks('stub/heal-me');
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(c.embedded_at).not.toBeNull();
    }
  });

  test('pre-existing NULL-embedding chunks on other pages still get embedded (no regression)', async () => {
    await engine.putPage('normal/pre-chunked', { type: 'note', title: 'Pre-chunked', compiled_truth: 'hello world' });
    await installFixtureChunks(engine, 'normal/pre-chunked', [
      { chunk_index: 0, chunk_text: 'hello world', chunk_source: 'compiled_truth' },
    ]);
    await engine.putPage('stub/heal-me-2', {
      type: 'person',
      title: 'Heal Me Two',
      compiled_truth: 'Another chunkless stub.',
    });

    const result = await runEmbedCore(engine, { stale: true, quiet: true });

    expect(result.chunkless_pages_healed).toBe(1);
    expect(result.embedded).toBeGreaterThanOrEqual(2); // 1 pre-existing + >=1 healed
    const preChunked = await engine.getChunks('normal/pre-chunked');
    expect(preChunked[0]?.embedded_at).not.toBeNull();
  });

  test('healing sanitizes active, withdrawn and private fences before chunking either body column', async () => {
    const slug = 'stub/fenced-history';
    const fence = (column: string) => `<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|---|---|---|---|---|---|---|---|---|
| 1 | activeworld${column} remains searchable | fact | 1.0 | world | medium | 2026-01-01 | | test | |
| 2 | withdrawnsentinel${column} retained history | fact | 1.0 | world | medium | 2026-01-01 | | test | |
| 3 | privatesentinel${column} hidden detail | fact | 1.0 | private | medium | 2026-01-01 | | test | |
<!--- gbrain:facts:end -->`;
    await engine.putPage(slug, { type: 'note', title: 'Fenced history',
      compiled_truth: `Safe body prose.\n${fence('body')}`, timeline: `Safe timeline prose.\n${fence('timeline')}` });
    for (const column of ['body', 'timeline']) {
      const fact = await engine.insertFact({ fact: `withdrawnsentinel${column} retained history`, source: 'test', visibility: 'world' }, { source_id: 'default' });
      expect((await recordFactWithdrawal(engine, fact.id, 'default', true)).withdrawn).toBe(true);
    }
    expect(await engine.getChunks(slug, { includeUnsealed: true })).toEqual([]);
    const historical = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
    expect(historical.page.compiled_truth).toContain('~~withdrawnsentinelbody retained history~~');
    expect(historical.page.timeline).toContain('~~withdrawnsentineltimeline retained history~~');

    const result = await runEmbedCore(engine, { stale: true, quiet: true });

    expect(result.chunkless_pages_healed).toBe(1);
    const chunks = await engine.getChunks(slug);
    for (const [field, column] of [['compiled_truth', 'body'], ['timeline', 'timeline']]) {
      const text = chunks.filter(c => c.chunk_source === field).map(c => c.chunk_text).join('\n');
      expect(text).toContain(`activeworld${column}`);
      expect(text).not.toContain(`withdrawnsentinel${column}`);
      expect(text).not.toContain(`privatesentinel${column}`);
      expect(await engine.searchKeyword(`withdrawnsentinel${column}`)).toEqual([]);
    }
    expect(chunks.every(c => c.embedded_at !== null)).toBe(true);
    const after = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
    expect(after.revision).toBe(historical.revision);
    expect(after.page.compiled_truth).toBe(historical.page.compiled_truth);
    expect(after.page.timeline).toBe(historical.page.timeline);
    expect(after.page.text_projection_revision).toBe(after.revision);
  });

  test('quarantined and embed_skip pages stay chunkless — the safety net does not touch them', async () => {
    await engine.putPage('junk/quarantined', {
      type: 'note',
      title: 'Junk',
      compiled_truth: 'junk content',
      frontmatter: { [QUARANTINE_KEY]: buildQuarantineMarker('junk_pattern', 'test fixture') },
    });
    await engine.putPage('oversized/skipped', {
      type: 'note',
      title: 'Oversized',
      compiled_truth: 'x'.repeat(1000),
      frontmatter: { [EMBED_SKIP_KEY]: buildEmbedSkipMarker(1000) },
    });

    const result = await runEmbedCore(engine, { stale: true, quiet: true });

    expect(result.chunkless_pages_healed).toBe(0);
    expect(await engine.getChunks('junk/quarantined')).toEqual([]);
    expect(await engine.getChunks('oversized/skipped')).toEqual([]);
  });

  test('dry-run reports the would-be-healed count without writing any chunks', async () => {
    await engine.putPage('stub/dry-run-only', {
      type: 'person',
      title: 'Dry Run Only',
      compiled_truth: 'This stub must NOT be chunked by a dry run.',
    });

    const result = await runEmbedCore(engine, { stale: true, dryRun: true, quiet: true });

    expect(result.chunkless_pages_healed).toBe(1);
    expect(result.would_embed).toBeGreaterThan(0);
    expect(await engine.getChunks('stub/dry-run-only')).toEqual([]); // no mutation
  });

  test('healthy brain (no chunkless pages) pays no extra cost and behaves exactly as before', async () => {
    await engine.putPage('normal/only-page', { type: 'note', title: 'Only', compiled_truth: 'hello' });
    await installFixtureChunks(engine, 'normal/only-page', [
      { chunk_index: 0, chunk_text: 'hello', chunk_source: 'compiled_truth' },
    ]);

    const result = await runEmbedCore(engine, { stale: true, quiet: true });

    expect(result.chunkless_pages_healed).toBe(0);
    expect(result.embedded).toBe(1);
  });

  test('race mitigation: a page chunked by a concurrent writer between list and write is not clobbered', async () => {
    // Review catch: healChunklessPages lists chunkless pages, chunks them
    // in memory, then writes. If a concurrent writer (sync, another
    // put_page/embed) chunks the SAME page in between, a naive write would
    // overwrite the concurrent writer's (newer) chunks with this sweep's
    // stale-content snapshot. Simulate that race by injecting a write
    // immediately after listChunklessPagesWithContent returns — i.e. AFTER
    // the sweep has decided to heal this page but BEFORE its own write.
    await engine.putPage('stub/raced', {
      type: 'person',
      title: 'Raced',
      compiled_truth: 'Original content the sweep read.',
    });

    let injected = false;
    const realList = engine.listChunklessPagesWithContent.bind(engine);
    const raceEngine = new Proxy(engine, {
      get(target, prop, receiver) {
        if (prop === 'listChunklessPagesWithContent') {
          return async (opts?: Parameters<typeof realList>[0]) => {
            const rows = await realList(opts);
            if (!injected && rows.some(r => r.slug === 'stub/raced')) {
              injected = true;
              // Simulate the concurrent writer: chunks the page with DIFFERENT
              // content than what the sweep just read.
              await installFixtureChunks(engine, 'stub/raced', [
                { chunk_index: 0, chunk_text: 'concurrently-written chunk', chunk_source: 'compiled_truth' },
              ]);
            }
            return rows;
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as BrainEngine;

    const result = await runEmbedCore(raceEngine, { stale: true, quiet: true });

    // The race was detected and the page was skipped this pass (not
    // counted as healed by this sweep) rather than clobbered.
    expect(result.chunkless_pages_healed).toBe(0);
    const chunks = await engine.getChunks('stub/raced');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunk_text).toBe('concurrently-written chunk');
  });

  test('late chunkless healing preserves a projection completed after its guarded capture', async () => {
    const slug = 'stub/late-heal';
    await engine.putPage(slug, { type: 'note', title: 'Late heal', compiled_truth: 'First sentence. Second sentence.' });
    let injected = false;
    let current: Awaited<ReturnType<BrainEngine['getChunks']>> = [];
    const raced = new Proxy(engine, {
      get(target, key) {
        if (key === 'transaction') return async <T>(run: (tx: BrainEngine) => Promise<T>) => {
          const result = await target.transaction(run);
          if (!injected && (result as ProjectionSnapshot | null)?.snapshot?.page.slug === slug) {
            injected = true;
            await installFixtureChunks(engine, slug, ['First sentence.', 'Second sentence.'].map((text, index) => ({
              chunk_index: index, chunk_text: text, chunk_source: 'compiled_truth',
            })));
            const newer = (await readProjectionSnapshot(engine, slug, 'default'))!;
            const vector = new Float32Array(DIMS); vector[0] = 0.75;
            expect(await installPageEmbeddings(engine, newer, newer.chunks.map(c => ({
              chunk_index: c.chunk_index, chunk_source: c.chunk_source, chunk_text: c.chunk_text, embedding: vector,
            })))).toBe(true);
            current = await engine.getChunks(slug, { includeEmbedding: true });
          }
          return result;
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const result = await runEmbedCore(raced, { stale: true, quiet: true });

    expect(injected).toBe(true);
    expect(result.chunkless_pages_healed).toBe(0);
    expect(result.failures).toBe(0);
    expect(await engine.getChunks(slug, { includeEmbedding: true })).toEqual(current);
  });

  test('one broken chunkless page does not abort the whole --stale run (per-page failure isolation)', async () => {
    // Review catch: healChunklessPages must try/catch per page. Before the
    // fix, an exception from getPage/getChunks/upsertChunks for ONE
    // chunkless page propagated out of healChunklessPages entirely,
    // aborting embedAllStale before it even reached the normal
    // NULL-embedding pass — making the safety net worse than the bug.
    await engine.putPage('stub/broken', {
      type: 'person',
      title: 'Broken',
      compiled_truth: 'This page will fail to heal.',
    });
    await engine.putPage('normal/unrelated', { type: 'note', title: 'Unrelated', compiled_truth: 'fine' });
    await installFixtureChunks(engine, 'normal/unrelated', [
      { chunk_index: 0, chunk_text: 'fine', chunk_source: 'compiled_truth' },
    ]);

    const brokenEngine = new Proxy(engine, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          return <T>(run: (tx: BrainEngine) => Promise<T>) => engine.transaction(tx => run(new Proxy(tx, {
            get(inner, key) {
              if (key === 'readPageSnapshot') return async (slug: string, opts?: Parameters<BrainEngine['readPageSnapshot']>[1]) => {
                if (slug === 'stub/broken') throw new Error('simulated page snapshot failure');
                return inner.readPageSnapshot(slug, opts);
              };
              const value = Reflect.get(inner, key, inner);
              return typeof value === 'function' ? value.bind(inner) : value;
            },
          })));
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as BrainEngine;

    const result = await runEmbedCore(brokenEngine, { stale: true, quiet: true });

    // The broken page's failure is recorded, not swallowed silently...
    expect(result.failures).toBeGreaterThanOrEqual(1);
    expect(result.failure_samples.some(s => s.includes('stub/broken'))).toBe(true);
    // ...but did NOT abort the run: the unrelated pre-existing stale chunk
    // still got embedded in the SAME pass.
    expect(result.embedded).toBeGreaterThanOrEqual(1);
    const unrelatedChunks = await engine.getChunks('normal/unrelated');
    expect(unrelatedChunks[0]?.embedded_at).not.toBeNull();
  });
});
