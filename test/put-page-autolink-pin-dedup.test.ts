/**
 * Issue #1493 (codex P2, round 2) — put_page auto-link must not double-count
 * (or double-insert) when a page contains BOTH the pinned and unpinned form
 * of the same wikilink, e.g. `[[default:people/alice]]` and
 * `[[people/alice]]` on a default-source page. The pin is part of
 * extractPageLinks' within-page dedup key (correct for the extract paths,
 * where the two can resolve to different to_source_id rows), but inside
 * put_page's single-source write scope both resolve to the SAME edge row —
 * runAutoLink re-dedupes by the resolved edge key before writing/counting.
 *
 * Hermetic PGLite; embed transport stubbed (same pattern as
 * test/put-page-provenance.test.ts).
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';

const putPageOp = operations.find((o) => o.name === 'put_page')!;

let engine: PGLiteEngine;

beforeAll(async () => {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { ...process.env, OPENAI_API_KEY: process.env.OPENAI_API_KEY || 'sk-test-stub' },
  });
  __setEmbedTransportForTests(async ({ values }: any) => ({
    embeddings: values.map(() => new Array(1536).fill(0)),
    usage: { tokens: 0 },
  }) as any);

  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  __setEmbedTransportForTests(null);
  resetGateway();
});

beforeEach(async () => {
  for (const t of ['content_chunks', 'links', 'tags', 'timeline_entries', 'page_versions', 'pages']) {
    await engine.executeRaw(`DELETE FROM ${t}`, []);
  }
});

function makeCtx(): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' as const },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
  };
}

describe('put_page auto-link — pinned + unpinned same-target dedup (#1493)', () => {
  test('own-source pin + unpinned form create ONE edge and count created=1', async () => {
    const ctx = makeCtx();
    await putPageOp.handler(ctx, {
      slug: 'people/alice',
      content: '---\ntype: person\ntitle: Alice\n---\n\nAlice.',
    });

    const res = await putPageOp.handler(ctx, {
      slug: 'concepts/note',
      content: '---\ntype: concept\ntitle: Note\n---\n\nSee [[default:people/alice]] and [[people/alice]].',
    }) as { auto_links?: { created: number; errors: number } };

    const links = (await engine.getLinks('concepts/note')).filter(l => l.to_slug === 'people/alice');
    expect(links.length).toBe(1);
    expect(res.auto_links).toBeDefined();
    expect(res.auto_links!.created).toBe(1);
    expect(res.auto_links!.errors).toBe(0);
  });

  test('foreign-pinned form is skipped, unpinned form still links (no misdirection)', async () => {
    const ctx = makeCtx();
    await putPageOp.handler(ctx, {
      slug: 'people/alice',
      content: '---\ntype: person\ntitle: Alice\n---\n\nAlice.',
    });

    const res = await putPageOp.handler(ctx, {
      slug: 'concepts/note',
      content: '---\ntype: concept\ntitle: Note\n---\n\nSee [[somewhere-else:people/alice]] and [[people/alice]].',
    }) as { auto_links?: { created: number } };

    const links = (await engine.getLinks('concepts/note')).filter(l => l.to_slug === 'people/alice');
    expect(links.length).toBe(1);
    expect(res.auto_links!.created).toBe(1);
  });
});
