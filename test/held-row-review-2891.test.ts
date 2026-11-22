/**
 * GST-2891 review findings (round 3): held rows on paths the first fix missed. Each test fails without its fix.
 * 1. known_as_of reads at the slug a page had before a rename.  2. get_chunks on a source other than `default`.
 * 3. A row cut at a chunk boundary in a chunk that starts with a fence trust marker.  4. search_exact keeps a page's
 * public hit when an earlier hit in the same chunk is a held row.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { dropHeldFenceRows } from '../src/core/eligibility/stamp.ts';
import { markFenceChunk } from '../src/core/eligibility/fence-overlay.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { renamePageOntoSlug } from '../src/commands/sync/rename-collision.ts';
import { fillCommitMarks } from '../src/core/belief/coverage-report.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { beliefBrain, beliefEngineCase, type BeliefBrain } from './helpers/belief-ledger.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const row = (n: number, claim: string) => ({ rowNum: n, claim, kind: 'fact', confidence: 1, visibility: 'world', notability: 'medium', active: true });
const pageText = (title: string, rows: ReturnType<typeof row>[], prose = 'Profile.', after = '') =>
  '---\ntype: person\ntitle: ' + title + '\n---\n# ' + title + '\n\n' + prose + '\n\n## Facts\n\n' + renderFactsTable(rows as never) + '\n' + after;
/** Stores a row's fact private while the page body keeps its world cell: the held shape a pending widening leaves. */
const hold = (engine: BrainEngine, sourceId: string, slug: string, claim: string) =>
  engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => tx.executeRaw(
    "UPDATE facts SET visibility='private' WHERE source_id=$1 AND source_markdown_slug=$2 AND fact=$3", [sourceId, slug, claim]), TEST_WRITE_ATTRIBUTION));
const text = (r: unknown) => JSON.stringify(r);

for (const engineCase of testBackends().map(beliefEngineCase)) {
  describe('GST-2891 recorded-time reads after a rename (' + engineCase.name + ')', () => {
    const dbNow = async (b: BeliefBrain) => { await new Promise(r => setTimeout(r, 20)); const t = new Date((await b.engine.executeRaw<{ t: string }>("SELECT date_trunc('milliseconds', clock_timestamp()) + interval '1 millisecond' AS t"))[0]!.t).toISOString(); await new Promise(r => setTimeout(r, 20)); return t; };
    test('a held row stays out of known_as_of reads at the slug the page had before the rename', () => beliefBrain(async b => {
      const old = 'people/ida-example', moved = 'people/ida-moved-example', claim = 'Ida keeps bees narwhalheld';
      await b.put(old, pageText('Ida Example', [row(1, 'Ida lives in Turin'), row(2, claim)]));
      await hold(b.engine, b.sourceId, old, claim);
      const before = await dbNow(b);
      await renamePageOntoSlug(b.engine, { sourceId: b.sourceId, oldSlug: old, newSlug: moved, to: moved + '.md' });
      await fillCommitMarks(b.engine, b.sourceId);
      const remote: OperationContext = { ...b.ctx, remote: true };
      const run = (ctx: OperationContext, op: string, params: Record<string, unknown>) => { __resetPrivateVisibilityCacheForTests(); return operationsByName[op]!.handler(ctx, params); };
      expect(text(await run(b.ctx, 'get_page', { slug: old, known_as_of: before }))).toContain('narwhalheld');
      expect(text(await run(remote, 'get_page', { slug: moved }))).not.toContain('narwhalheld');
      const reads: Array<[string, Record<string, unknown>]> = [['get_page', { slug: old, known_as_of: before }],
        ['get_versions', { slug: old, known_as_of: before, include_body: true }], ['get_versions', { slug: old, known_as_of: before, diff: true }]];
      for (const [op, params] of reads) {
        const out = text(await run(remote, op, params));
        expect(out).toContain('Ida lives in Turin');
        expect({ op, params, leaks: out.includes('narwhalheld') }).toEqual({ op, params, leaks: false });
      }
    }, { managed: false, enable: true, databaseUrl: engineCase.databaseUrl }), 180_000);
  });
}

for (const kind of testBackends()) {
  describe('GST-2891 held rows on chunk reads (' + kind + ')', () => {
    let engine: BrainEngine; let close: () => Promise<void>;
    const call = async (remote: boolean, sourceId: string, op: string, params: Record<string, unknown>) => {
      __resetPrivateVisibilityCacheForTests();
      return (await dispatchToolCall(engine, op, { ...params }, { remote, sourceId })).content.map(c => c.text).join('\n');
    };
    const OTHER = { slug: 'people/ola-example', claim: 'Ola keeps bees tapirheld' };
    const MIXED = { slug: 'people/pia-example', claim: 'Pia keeps bees lynxheld secretly' };
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await registerLocalWriter(engine, 'cli');
      await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('source-a', 'source-a') ON CONFLICT (id) DO NOTHING");
      await call(false, 'source-a', 'put_page', { slug: OTHER.slug, content: pageText('Ola Example', [row(1, 'Ola lives in Turin'), row(2, OTHER.claim)]), request_id: randomUUID() });
      await hold(engine, 'source-a', OTHER.slug, OTHER.claim);
      const filler = Array.from({ length: 6 }, (_, i) => 'Line ' + i + ' of plain notes about the garden and the weather this spring.').join(' ');
      await call(false, 'default', 'put_page', { slug: MIXED.slug, content: pageText('Pia Example', [row(1, 'Pia lives in Turin'), row(2, MIXED.claim)], 'Profile.',
        filler + ' The museum keeps bees lynxheld in glass cases.\n'), request_id: randomUUID() });
      await hold(engine, 'default', MIXED.slug, MIXED.claim);
    }, 300_000);
    afterAll(async () => { await disposePersistenceConsumer(engine); await close(); }, 60_000);

    test('get_chunks on a source other than default leaves the held row out', async () => {
      expect(await call(false, 'source-a', 'get_chunks', { slug: OTHER.slug })).toContain('tapirheld');
      const out = await call(true, 'source-a', 'get_chunks', { slug: OTHER.slug });
      expect(out).toContain('Ola lives in Turin');
      expect(out).not.toContain('tapirheld');
    }, 120_000);

    test('a row cut at a chunk boundary after a fence trust marker leaves none of its text behind', async () => {
      const tail = ' | fact | 1.0 | world | medium |  |  |  |  |\nProfile prose.';
      const kept = await dropHeldFenceRows(engine, [
        { slug: MIXED.slug, source_id: 'default', chunk_text: markFenceChunk('agent_written', 'bees lynxheld secretly' + tail) },
        { slug: MIXED.slug, source_id: 'default', chunk_text: markFenceChunk('agent_written', '2 | Pia keeps bees lynxheld secretly' + tail) },
        { slug: MIXED.slug, source_id: 'default', chunk_text: markFenceChunk('agent_written', '| Pia keeps bees lynxheld secretly' + tail) },
      ] as never) as Array<{ chunk_text: string }>;
      for (const k of kept) expect(k.chunk_text).not.toContain('lynxheld');
      expect(kept.map(k => k.chunk_text.includes('Profile prose.'))).toEqual([true, true, true]);
    }, 60_000);

    test('search_exact keeps the public hit of a page whose earlier hit is a held row', async () => {
      const chunks = await engine.executeRaw<{ chunk_text: string }>('SELECT cc.chunk_text FROM content_chunks cc JOIN pages p ON p.id=cc.page_id WHERE p.slug=$1 ORDER BY cc.chunk_index', [MIXED.slug]);
      const both = chunks.find(c => c.chunk_text.includes(MIXED.claim) && c.chunk_text.includes('museum keeps bees'));
      expect(both && both.chunk_text.indexOf(MIXED.claim) < both.chunk_text.indexOf('museum keeps bees')).toBe(true);
      expect(await call(false, 'default', 'search_exact', { phrase: 'keeps bees lynxheld' })).toContain('secretly');
      const out = JSON.parse(await call(true, 'default', 'search_exact', { phrase: 'keeps bees lynxheld' }));
      expect(JSON.stringify(out.matches)).toContain('museum keeps bees lynxheld');
      expect(JSON.stringify(out.matches)).not.toContain('secretly');
      expect(out.complete).toBe(true);
    }, 120_000);
  });
}
