/**
 * #7492: the projection_pending coverage count matched query words as
 * substrings (a digit run "412" matched an image frame named t004120), counted
 * image pages that a text-only search can never return, and told agents every
 * pending page was "recently written" and being indexed, although images in the
 * sealable and reimport classes wait for an operator. Coverage now matches
 * whole tokens, counts an image page only when an image arm ran or it was
 * returned, and the notice is worded by class.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { degradedRecallNotice } from '../../src/core/interop-notices.ts';
import { countPendingProjections, coverageRelevance } from '../../src/core/search/retrieval-coverage.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';

const search = operations.find(op => op.name === 'search')!;
const home = mkdtempSync(join(tmpdir(), 'gbrain-coverage-7492-'));
const env = { GBRAIN_HOME: home, GBRAIN_PROJECTION_READINESS_CACHE: '0' };

afterAll(() => rmSync(home, { recursive: true, force: true }));

function call(engine: BrainEngine) {
  const meta: Record<string, any> = {};
  const ctx = {
    engine, config: { engine: 'pglite', embedding_disabled: true }, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: 'default',
    emitNotice: () => {}, emitResponseMeta: (key: string, value: unknown) => { meta[key] = value; },
  } as unknown as OperationContext;
  return { ctx, meta };
}

for (const kind of testBackends()) {
  describe('projection_pending coverage by token and class (' + kind + ')', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    async function page(slug: string, type: string, title: string, text: string) {
      await engine.putPage(slug, { type, title, compiled_truth: text, frontmatter: {} } as never);
      await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: text, chunk_source: 'compiled_truth' }]);
    }
    /** An unrelated image page left unsealed (the reimport class: no importer chunk). */
    async function pendingImage(slug: string, title: string) {
      await page(slug, 'image', title, title);
      await engine.executeRaw("UPDATE pages SET page_kind = 'image', text_projection_revision = NULL WHERE slug = $1", [slug]);
    }
    const coverageFor = (query: string) => withEnv(env, async () => {
      const c = call(engine);
      const results = await search.handler(c.ctx, { query }) as Array<{ slug: string }>;
      return { results, coverage: c.meta.retrieval.coverage, degraded: c.meta.retrieval.degraded };
    });

    beforeAll(async () => {
      if (kind === 'postgres') {
        ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      } else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.setConfig('search.mcp_keyword_only', 'true');
      await page('digests/weekly-digest-412', 'note', 'Weekly digest (#412)', 'Weekly digest #412: channel summary for the week.');
      await pendingImage('media/frames/t004120', 'Frame t004120');
    }, 120_000);

    afterAll(async () => {
      await close?.();
    });

    test('a digit run inside a longer number does not make an image page count', async () => {
      const r = await coverageFor('weekly digest 412');
      expect(r.results.map(x => x.slug)).toContain('digests/weekly-digest-412');
      expect(r.degraded).toContainEqual({ stage: 'projection_pending' });
      expect(r.coverage).toEqual({ pending_projection: 1, could_affect: { pending_projection: 0 } });
    });

    test('an image page whose title holds the query words does not count for a text-only search', async () => {
      await pendingImage('media/frames/weekly-digest-412-cover', 'Weekly digest 412 cover');
      try {
        const r = await coverageFor('weekly digest 412');
        expect(r.coverage).toEqual({ pending_projection: 2, could_affect: { pending_projection: 0 } });
      } finally {
        await engine.executeRaw("UPDATE pages SET deleted_at = now() WHERE slug = 'media/frames/weekly-digest-412-cover'");
      }
    });

    test('a pending text page holding the query word as a token still counts', async () => {
      await page('notes/digest-412-draft', 'concept', 'Digest 412 draft', 'unrelated body');
      await engine.executeRaw("UPDATE pages SET text_projection_revision = NULL WHERE slug = 'notes/digest-412-draft'");
      try {
        const r = await coverageFor('weekly digest 412');
        expect(r.coverage).toEqual({ pending_projection: 2, could_affect: { pending_projection: 1 } });
      } finally {
        await engine.executeRaw("UPDATE pages SET deleted_at = now() WHERE slug = 'notes/digest-412-draft'");
      }
    });

    test('a short word does not match inside a longer word', async () => {
      // Another type than the results' (a result type counts every pending page of that type).
      await page('notes/digestion', 'concept', 'Digestion', 'unrelated body');
      await engine.executeRaw("UPDATE pages SET text_projection_revision = NULL WHERE slug = 'notes/digestion'");
      try {
        const r = await coverageFor('weekly digest');
        expect(r.results.length).toBeGreaterThan(0);
        expect(r.coverage.could_affect.pending_projection).toBe(0);
      } finally {
        await engine.executeRaw("UPDATE pages SET deleted_at = now() WHERE slug = 'notes/digestion'");
      }
    });

    test('when an image arm ran, a matching pending image counts and is classed as waiting for an operator', async () => {
      await pendingImage('media/frames/weekly-digest-412-cover-2', 'Weekly digest 412 cover');
      try {
        const scope = { sourceId: 'default' };
        const textOnly = await countPendingProjections(engine, scope, coverageRelevance([], 'weekly digest 412 cover', undefined, new Set(), false));
        const withImages = await countPendingProjections(engine, scope, coverageRelevance([{ page_id: -1 }], 'weekly digest 412 cover', undefined, new Set(), true));
        expect(textOnly).toMatchObject({ total: 2, could_affect: 0, could_affect_images: 0 });
        expect(withImages).toMatchObject({ total: 2, could_affect: 1, could_affect_images: 1 });
      } finally {
        await engine.executeRaw("UPDATE pages SET deleted_at = now() WHERE slug = 'media/frames/weekly-digest-412-cover-2'");
      }
    });
  });
}

describe('the projection_pending notice is worded by class', () => {
  const notice = (could: number, images?: number) => degradedRecallNotice([{ stage: 'projection_pending' }], {
    transport: 'stdio', coverage: { pending_projection: 40, could_affect: { pending_projection: could, ...(images ? { pending_images: images } : {}) } },
  })!;

  test('text pages are being indexed', () => {
    const n = notice(2);
    expect(n.code).toBe('degraded_recall');
    expect(n.why).toContain('recently written pages are being indexed');
    expect(n.why).toContain('(2 of 40 pending page(s) could match this query)');
    expect(n.why).not.toContain('projections drain');
    expect(n.fix?.argv).toEqual(['gbrain', 'doctor', '--json']);
  });

  test('image pages wait for a drain or a paid re-import and name the doctor check', () => {
    const n = notice(3, 3);
    expect(n.code).toBe('degraded_recall');
    expect(n.why).not.toContain('being indexed');
    expect(n.why).toContain('will not be indexed on their own');
    expect(n.why).toContain('gbrain projections drain');
    expect(n.why).toContain('paid re-import');
    expect(n.why).toContain('text_projection_readiness');
    expect(n.why).toContain('(3 of 40 pending page(s) could match this query)');
    expect(n.fix?.argv).toEqual(['gbrain', 'doctor', '--only', 'text_projection_readiness', '--json']);
    expect(n.fix?.verify?.argv).toEqual(['gbrain', 'doctor', '--only', 'text_projection_readiness', '--json']);
    expect(n.fix?.consent).toEqual([]);
  });

  test('a mix names both waits', () => {
    const n = notice(5, 2);
    expect(n.why).toContain('2 image page(s)');
    expect(n.why).toContain('3 recently written page(s) are being indexed');
  });
});
