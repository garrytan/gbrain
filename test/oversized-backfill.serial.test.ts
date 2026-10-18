/**
 * Large pages (Wave A, T15/T23/T34/T52/T16): the oversized-page backfill and
 * the per-page embedding budget.
 *
 * The upgrade fixture is a page an older gbrain stored the old way: written
 * under a 500 KB bytes_block, so it carries the gate's
 * `embed_skip: { reason: oversized }` marker and has zero chunks. With no later
 * content write and embeddings off, `gbrain reindex --oversized` must make a
 * needle in its middle keyword-searchable with zero provider calls, hold a
 * large page for embedding approval, and leave a page still over the block
 * alone.
 *
 * Serial: installs the process-global embedding transport seam.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { isEmbedSkipped } from '../src/core/embed-skip.ts';
import { assessContentSanity } from '../src/core/content-sanity.ts';
import { runOversizedBackfill, formatOversizedBackfillReceipt, BACKFILL_HOLD_REASON } from '../src/core/oversized-backfill.ts';
import { listBudgetLimitedPages, planPageEmbedding } from '../src/core/page-embedding-budget.ts';
import { runEmbedCore } from '../src/commands/embed.ts';
import { __setEmbedTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';

const DIMS = 1536;
const MODEL = 'openai:text-embedding-3-large';
const FRONTMATTER = '---\ntype: note\ntitle: Long conversation\n---\n\n';
const NEEDLE = 'zebracornflowerneedle';

let engine: PGLiteEngine;
let providerCalls = 0;

function body(bytes: number): string {
  const line = 'alice-example and bob-example talked about acme-example plans today.\n';
  const half = line.repeat(Math.floor(bytes / 2 / line.length));
  return `${half}The secret word is ${NEEDLE}.\n${half}`;
}

async function withHome<T>(config: Record<string, unknown> | null, fn: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'oversized-backfill-'));
  if (config) {
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', ...config }));
  }
  try {
    return await withEnv({ GBRAIN_HOME: home, HOME: home, GBRAIN_AUDIT_DIR: home }, fn);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/**
 * Leave a page the way gbrain did before the ceiling: written under a 500 KB block, with the
 * gate's marker and zero chunks. A write today keeps an embed_skip page's chunks (#6722), so
 * the legacy chunkless state is restored by removing them, as an old brain holds it.
 */
async function seedSizeSkipped(slug: string, bytes: number): Promise<void> {
  await engine.setConfig('content_sanity.bytes_block', '500000');
  await importFromContent(engine, slug, FRONTMATTER + body(bytes), { noEmbed: true });
  await engine.unsetConfig('content_sanity.bytes_block');
  const page = await engine.getPage(slug);
  expect(isEmbedSkipped(page!.frontmatter as Record<string, unknown>)).toBe(true);
  await engine.executeRaw('DELETE FROM content_chunks WHERE page_id = $1', [page!.id]);
  expect((await engine.getChunks(slug)).length).toBe(0);
}

async function keywordHits(): Promise<string[]> {
  return (await engine.searchKeyword(NEEDLE, { limit: 10 })).map(hit => hit.slug);
}

beforeAll(async () => {
  configureGateway({ embedding_model: MODEL, embedding_dimensions: DIMS, env: { ...process.env, OPENAI_API_KEY: 'sk-test-fake' } });
  __setEmbedTransportForTests((async (input: { values: string[] }) => {
    providerCalls++;
    return { embeddings: input.values.map(() => new Array(DIMS).fill(0.001)), usage: { tokens: input.values.length * 4 } };
  }) as never);
  engine = new PGLiteEngine();
  await engine.connect({ embedding_dimensions: DIMS } as never);
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  providerCalls = 0;
});

describe('gbrain reindex --oversized (keyless upgrade path)', () => {
  test('a zero-chunk size-skipped page becomes keyword-searchable with zero provider calls, and a rerun is a no-op', async () => {
    await withHome({ embedding_disabled: true }, async () => {
      await seedSizeSkipped('chats/small-large', 700_000);
      expect(await keywordHits()).toEqual([]);

      const receipt = await runOversizedBackfill(engine);
      expect(receipt).toMatchObject({ candidates: 1, reindexed: 1, remaining: 0, held_for_approval: 0, embedding_enabled: false, estimated_usd: null });
      expect(receipt.chunks_pending_embedding).toBeGreaterThan(100);
      const page = await engine.getPage('chats/small-large');
      expect(isEmbedSkipped(page!.frontmatter as Record<string, unknown>)).toBe(false);
      expect((page!.frontmatter as Record<string, unknown>).content_flag).toBeUndefined();
      expect(await keywordHits()).toEqual(['chats/small-large']);
      expect(providerCalls).toBe(0);

      expect(await runOversizedBackfill(engine)).toMatchObject({ candidates: 0, reindexed: 0 });
    });
  }, 120_000);

  test('the time budget stops after the page in flight and the same command continues', async () => {
    await withHome({ embedding_disabled: true }, async () => {
      for (const slug of ['chats/a', 'chats/b', 'chats/c']) await seedSizeSkipped(slug, 600_000);
      let clock = 0;
      const first = await runOversizedBackfill(engine, { deadlineMs: 1_000, now: () => clock, onPage: () => { clock += 1_000; } });
      expect(first).toMatchObject({ candidates: 3, reindexed: 1, remaining: 2 });
      expect(first.commands.finish).toEqual(['gbrain', 'reindex', '--oversized']);
      expect(await runOversizedBackfill(engine)).toMatchObject({ candidates: 2, reindexed: 2, remaining: 0 });
    });
  }, 120_000);

  test('a page over 1 MiB is re-indexed and held for embedding approval: the stale sweep skips it until the user approves', async () => {
    await withHome(null, async () => {
      await seedSizeSkipped('chats/big', 1_500_000);
      const receipt = await runOversizedBackfill(engine);
      expect(receipt).toMatchObject({ reindexed: 1, held_for_approval: 1, embedding_enabled: true });
      expect(receipt.estimated_usd).toBeGreaterThan(0);
      expect(receipt.commands.approve).toEqual(['gbrain', 'embed', '--held', '--source', 'default', '--max-usd', expect.stringMatching(/^\d+\.\d{2}$/)]);
      expect(Number(receipt.commands.approve![6])).toBeGreaterThanOrEqual(receipt.estimated_usd!);
      expect(formatOversizedBackfillReceipt(receipt).join('\n')).toContain(`approve one source at a time: ${receipt.commands.approve!.join(' ')}`);
      expect(formatOversizedBackfillReceipt(receipt).join('\n')).not.toContain('<N>');
      expect(await keywordHits()).toEqual(['chats/big']);
      expect(await listBudgetLimitedPages(engine)).toEqual([expect.objectContaining({ slug: 'chats/big', state: 'held', reason: BACKFILL_HOLD_REASON })]);
      expect(await engine.countStaleChunks({ sourceId: 'default' })).toBe(0);

      await runEmbedCore(engine, { stale: true, quiet: true });
      expect(providerCalls).toBe(0);

      const approved = await runEmbedCore(engine, { slugs: ['chats/big'], quiet: true, approvedPageCapUsd: 5 });
      expect(approved.embedded).toBe(receipt.chunks_pending_embedding);
      expect(providerCalls).toBeGreaterThan(0);
      expect(await listBudgetLimitedPages(engine)).toEqual([]);
    });
  }, 120_000);

  test('a page still over the operator bytes_block keeps its marker and is re-chunked for keyword search (#6722)', async () => {
    await withHome({ embedding_disabled: true }, async () => {
      await seedSizeSkipped('chats/operator-limit', 700_000);
      await engine.setConfig('content_sanity.bytes_block', '500000');
      try {
        expect(await keywordHits()).toEqual([]);
        const receipt = await runOversizedBackfill(engine);
        expect(receipt).toMatchObject({ candidates: 1, reindexed: 1, rechunked_over_block: 1, over_block: 1, held_for_approval: 0,
          chunks_pending_embedding: 0, remaining: 0, block_bytes: 500_000 });
        expect(isEmbedSkipped((await engine.getPage('chats/operator-limit'))!.frontmatter as Record<string, unknown>)).toBe(true);
        expect(await keywordHits()).toEqual(['chats/operator-limit']);
        const chunks = await engine.getChunks('chats/operator-limit');
        expect(chunks.length).toBeGreaterThan(100);
        expect(chunks.every(c => c.embedded_at == null)).toBe(true);
        expect(await engine.countStaleChunks({ sourceId: 'default' })).toBe(0);
        expect(providerCalls).toBe(0);
        expect(await runOversizedBackfill(engine)).toMatchObject({ candidates: 0, reindexed: 0, over_block: 1 });
      } finally {
        await engine.unsetConfig('content_sanity.bytes_block');
      }
    });
  }, 120_000);
});

describe('per-page embedding budget (embed.max_usd_per_page)', () => {
  const stale = (n: number) => Array.from({ length: n }, (_, i) => ({ chunk_index: i, chunk_text: 'x'.repeat(4000) }));
  const page = (id: number) => ({ id, compiled_truth: 'y'.repeat(1_100_000), timeline: '' });

  /** The stored page matches the size planPageEmbedding is given: a budget row applies only while the page is large. */
  async function pageId(slug: string, compiled_truth = 'short'): Promise<number> {
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth });
    return (await engine.getPage(slug))!.id;
  }

  test('grants the newest chunks that fit the cap, marks the page capped, and never re-grants spent budget', async () => {
    await withHome(null, async () => {
      const id = await pageId('notes/capped', page(0).compiled_truth);
      await engine.setConfig('embed.max_usd_per_page', '0.0003');
      const first = await planPageEmbedding(engine, page(id), stale(10), { signature: `${MODEL}:${DIMS}` });
      if (first.kind !== 'grant') throw new Error(`expected a grant, got ${first.kind}`);
      expect(first.grant.deferred).toBeGreaterThan(0);
      expect([...first.grant.chunkIndexes].sort((a, b) => a - b)).toEqual(Array.from({ length: 10 - first.grant.deferred }, (_, i) => i + first.grant.deferred));
      await first.grant.settle({ ok: true });
      expect(await listBudgetLimitedPages(engine)).toEqual([expect.objectContaining({ slug: 'notes/capped', state: 'capped' })]);

      const second = await planPageEmbedding(engine, page(id), stale(first.grant.deferred), { signature: `${MODEL}:${DIMS}` });
      if (second.kind !== 'grant') throw new Error(`expected a grant, got ${second.kind}`);
      expect(second.grant.chunkIndexes.size).toBe(0);
      await engine.unsetConfig('embed.max_usd_per_page');
    });
  });

  test('a page at or under the inline cap is unmetered', async () => {
    await withHome(null, async () => {
      const id = await pageId('notes/small');
      expect((await planPageEmbedding(engine, { id, compiled_truth: 'small page' }, stale(3))).kind).toBe('unmetered');
    });
  });

  const navRow = '| [x](http://a) | [y](http://b) | [z](http://c) | [w](http://d) |\n';

  test('the 890K boilerplate case on current code: flagged markup_heavy, searchable, not skipped (under the inline cap it costs cents)', () => {
    const r = assessContentSanity({ compiled_truth: navRow.repeat(Math.ceil(890_000 / navRow.length)), timeline: '', title: 'Scraped page' });
    expect(r).toMatchObject({ shouldQuarantine: false, shouldSkipEmbed: false, shouldFlag: true, flag_reason: 'markup_heavy' });
  });

  test('a large page whose head, middle and tail windows are all boilerplate is held instead of embedded', async () => {
    await withHome(null, async () => {
      const body = navRow.repeat(Math.ceil(1_100_000 / navRow.length));
      const id = await pageId('notes/boilerplate', body);
      const decision = await planPageEmbedding(engine, { id, compiled_truth: body }, stale(3));
      expect(decision).toEqual({ kind: 'held', reason: 'sampled_markup_heavy' });
      expect(await listBudgetLimitedPages(engine)).toEqual([expect.objectContaining({ slug: 'notes/boilerplate', state: 'held' })]);
    });
  });

  test('a large page of prose with a boilerplate head is granted (only the head is markup)', async () => {
    await withHome(null, async () => {
      const id = await pageId('notes/prose-with-nav');
      const prose = 'alice-example wrote a long letter about the acme-example harvest. '.repeat(Math.ceil(1_100_000 / 66));
      const decision = await planPageEmbedding(engine, { id, compiled_truth: navRow.repeat(2000) + prose }, stale(3));
      expect(decision.kind).toBe('grant');
    });
  });
});
