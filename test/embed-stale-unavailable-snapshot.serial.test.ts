/**
 * #5804: `embed --stale` must not report success for pages it could not embed.
 *
 * Protects: a stale page whose projection snapshot is unavailable when the
 * sweep reaches it (edited or tagged after the readiness gate) is a
 * counted failure, so the CLI exits non-zero, and the run reports ONE batch
 * summary naming how many pages were skipped and which, instead of a
 * `Embedded 0 chunks` success. Pages in a source archived mid-run stay
 * counted once, by the archived-work report, never twice.
 * Fails when: the null-snapshot path returns silently again (failures 0), the
 * summary is replaced by per-page samples, or an archived page is
 * double-counted.
 * Seam: `assertOwned`, which every stale transaction calls before its work;
 * the first call lands after the run-level readiness gate, the window the
 * race opens in.
 *
 * Named `.serial.test.ts`: configures the AI gateway and a fake embed
 * transport for its whole lifecycle, which withEnv() can't wrap.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { runEmbedCore } from '../src/commands/embed.ts';
import type { BrainEngine } from '../src/core/engine.ts';

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

async function stalePage(slug: string, sourceId = 'default') {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `Synthetic body for ${slug}.` }, { sourceId });
  await installFixtureChunks(engine, slug, [
    { chunk_index: 0, chunk_text: `Synthetic body for ${slug}.`, chunk_source: 'compiled_truth' },
  ], { sourceId });
}

/** Runs `change` once, inside the first stale transaction (after readiness). */
function once(change: (tx: BrainEngine) => Promise<void>) {
  let done = false;
  return async (tx?: BrainEngine) => {
    if (done || !tx) return;
    done = true;
    await change(tx);
  };
}

async function nullVectors(slug: string): Promise<number> {
  const [row] = await engine.executeRaw<{ n: number }>(
    'SELECT count(*)::int AS n FROM content_chunks c JOIN pages p ON p.id = c.page_id WHERE p.slug = $1 AND c.embedding IS NULL', [slug]);
  return row.n;
}

describe('embed --stale with a projection snapshot that becomes unavailable mid-run (#5804)', () => {
  test('edited pages are counted failures with one batch summary; untouched pages still embed', async () => {
    await stalePage('notes/tagged-mid-run');
    await stalePage('notes/edited-mid-run');
    await stalePage('notes/untouched');
    const result = await runEmbedCore(engine, {
      stale: true, quiet: true,
      assertOwned: once(async tx => {
        await tx.executeRaw("INSERT INTO tags (page_id, tag) SELECT id, 'added-mid-run' FROM pages WHERE slug = $1", ['notes/tagged-mid-run']);
        await tx.executeRaw("UPDATE pages SET compiled_truth = compiled_truth || ' More text.' WHERE slug = $1", ['notes/edited-mid-run']);
      }),
    });

    expect(result.embedded).toBe(1);
    expect(await nullVectors('notes/untouched')).toBe(0);
    expect(await nullVectors('notes/tagged-mid-run')).toBe(1);
    expect(await nullVectors('notes/edited-mid-run')).toBe(1);
    expect(result.failures).toBe(2);
    expect(result.failure_samples).toHaveLength(1);
    const [summary] = result.failure_samples;
    expect(summary).toStartWith('2 page(s) not embedded:');
    expect(summary).toContain('notes/tagged-mid-run');
    expect(summary).toContain('notes/edited-mid-run');
    expect(summary).toContain('rerun gbrain embed --stale');
  });

  test('the summary names five pages and counts the rest', async () => {
    const slugs = Array.from({ length: 7 }, (_, i) => `notes/edited-${i}`);
    for (const slug of slugs) await stalePage(slug);
    const result = await runEmbedCore(engine, {
      stale: true, quiet: true,
      assertOwned: once(async tx => {
        await tx.executeRaw("UPDATE pages SET compiled_truth = compiled_truth || ' More text.' WHERE slug = ANY($1::text[])", [slugs]);
      }),
    });

    expect(result.embedded).toBe(0);
    expect(result.failures).toBe(7);
    expect(result.failure_samples).toHaveLength(1);
    expect(result.failure_samples[0]).toStartWith('7 page(s) not embedded:');
    expect(result.failure_samples[0]).toContain(' and 2 more)');
  });

  test('a page whose source is archived mid-run is counted once, by the archived-work report', async () => {
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', ['archive-example']);
    await stalePage('notes/archived-mid-run', 'archive-example');
    const result = await runEmbedCore(engine, {
      stale: true, quiet: true,
      assertOwned: once(async tx => {
        await tx.executeRaw('UPDATE sources SET archived = true WHERE id = $1', ['archive-example']);
      }),
    });

    expect(result.embedded).toBe(0);
    expect(result.failures).toBe(1);
    expect(result.failure_samples.join('\n')).toContain('1 archived page(s) have blocked embedding work');
    expect(result.failure_samples.join('\n')).not.toContain('not embedded');
  });
});
