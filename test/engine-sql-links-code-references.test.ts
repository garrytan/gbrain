/**
 * #6712 PR 3 (L6): `addCodeReferenceLinks` writes the doc↔impl edges of every
 * code path a page cites in one statement, with the semantics of the
 * per-reference addLink pair it replaced.
 *
 * Protects: the edges equal what sequential addLink pairs wrote for the same
 * references (the oracle); endpoints resolve in the page's source only (a
 * same-slug page in another source is never linked); a missing code page skips
 * only its own edges; a re-import updates context and origin_field in place; a
 * repeated edge keeps its last occurrence without a "cannot affect row a second
 * time" error; on Postgres a concurrent delete of a linked endpoint waits for
 * the writing transaction (the endpoints are locked).
 * Fails when: endpoint resolution drops the source qualifier, a missing endpoint
 * fails the batch, a conflict inserts a duplicate or leaves the old context, or
 * duplicates reach one ON CONFLICT DO UPDATE.
 * Seams: none; PGLite always, Postgres through
 * test/e2e/engine-sql-links-code-references-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { addCodeReferenceLinks, type CodeReference } from '../src/core/engine-sql/links.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const SOURCE = 'coderef-src';
const OTHER = 'coderef-other';
const DOC = 'guides/widget-guide';

async function seed(engine: BrainEngine, codeSlugs: string[], opts: { source?: string; doc?: string } = {}) {
  const source = opts.source ?? SOURCE;
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1) ON CONFLICT DO NOTHING', [source]);
  await engine.putPage(opts.doc ?? DOC, { type: 'guide', title: 'Widget guide', compiled_truth: 'Guide body.' }, { sourceId: source });
  for (const slug of codeSlugs) await engine.putPage(slug, { type: 'code', title: slug, compiled_truth: 'code' }, { sourceId: source });
}

type Edge = { from: string; to: string; type: string; context: string; source: string; origin: string | null; field: string | null };
async function edges(engine: BrainEngine, source: string): Promise<Edge[]> {
  return engine.executeRaw<Edge>(`SELECT f.slug AS "from", t.slug AS "to", l.link_type AS type, l.context, l.link_source AS source, o.slug AS origin, l.origin_field AS field
    FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id LEFT JOIN pages o ON o.id=l.origin_page_id
    WHERE f.source_id=$1 ORDER BY 1,2,3`, [source]);
}

/** What the import paths wrote before #6712 L6: one addLink pair per reference, each swallowing its own failure. */
async function sequentialPairs(engine: BrainEngine, slug: string, source: string, refs: CodeReference[]) {
  const opts = { fromSourceId: source, toSourceId: source, originSourceId: source };
  for (const ref of refs) {
    await engine.addLink(slug, ref.codeSlug, ref.line ? `cited at ${ref.path}:${ref.line}` : ref.path, 'documents', 'markdown', slug, 'compiled_truth', opts).catch(() => undefined);
    await engine.addLink(ref.codeSlug, slug, ref.path, 'documented_by', 'markdown', slug, 'compiled_truth', opts).catch(() => undefined);
  }
}

const REFS: CodeReference[] = [
  { codeSlug: 'src-widgets-a-ts', path: 'src/widgets/a.ts', line: 12 },
  { codeSlug: 'src-widgets-missing-ts', path: 'src/widgets/missing.ts', line: 3 },
  { codeSlug: 'src-widgets-b-ts', path: 'src/widgets/b.ts' },
  { codeSlug: 'src-widgets-a-ts', path: 'src/Widgets/a.ts', line: 40 },
];

for (const backend of testBackends()) {
  describe(`addCodeReferenceLinks (${backend})`, () => {
    let engine: BrainEngine;
    beforeAll(async () => {
      if (backend === 'pglite') { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite; }
      else { const pg = new PostgresEngine(); await pg.connect({ database_url: requirePostgresTestDatabase(), poolSize: 4 }); await pg.initSchema(); engine = pg; }
    }, 120_000);
    afterAll(async () => {
      if (backend === 'postgres') for (const id of [SOURCE, OTHER, `${SOURCE}-oracle`]) await engine.executeRaw('DELETE FROM sources WHERE id=$1', [id]);
      await engine.disconnect();
    });

    test('writes exactly the edges sequential addLink pairs wrote: missing endpoints skipped alone, a repeated edge keeps its last context', async () => {
      const oracle = `${SOURCE}-oracle`;
      await seed(engine, ['src-widgets-a-ts', 'src-widgets-b-ts']);
      await seed(engine, ['src-widgets-a-ts', 'src-widgets-b-ts'], { source: oracle });
      await sequentialPairs(engine, DOC, oracle, REFS);
      const written = await addCodeReferenceLinks(engine, DOC, SOURCE, REFS);
      const got = await edges(engine, SOURCE);
      expect(got).toEqual(await edges(engine, oracle));
      expect(got).toEqual([
        { from: DOC, to: 'src-widgets-a-ts', type: 'documents', context: 'cited at src/Widgets/a.ts:40', source: 'markdown', origin: DOC, field: 'compiled_truth' },
        { from: DOC, to: 'src-widgets-b-ts', type: 'documents', context: 'src/widgets/b.ts', source: 'markdown', origin: DOC, field: 'compiled_truth' },
        { from: 'src-widgets-a-ts', to: DOC, type: 'documented_by', context: 'src/Widgets/a.ts', source: 'markdown', origin: DOC, field: 'compiled_truth' },
        { from: 'src-widgets-b-ts', to: DOC, type: 'documented_by', context: 'src/widgets/b.ts', source: 'markdown', origin: DOC, field: 'compiled_truth' },
      ]);
      expect(written).toBe(4);
    });

    test('endpoints resolve in the page source only: a same-slug code page in another source is never linked', async () => {
      await seed(engine, ['src-widgets-c-ts'], { source: OTHER, doc: 'guides/other-guide' });
      await seed(engine, []);
      expect(await addCodeReferenceLinks(engine, DOC, SOURCE, [{ codeSlug: 'src-widgets-c-ts', path: 'src/widgets/c.ts' }])).toBe(0);
      const crossing = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
        WHERE f.source_id <> t.source_id AND $1 IN (f.source_id, t.source_id)`, [OTHER]);
      expect(crossing[0]!.n).toBe(0);
    });

    test('a re-import updates context and origin_field of the existing edges in place', async () => {
      await seed(engine, ['src-widgets-a-ts']);
      await engine.executeRaw(`UPDATE links SET origin_field='frontmatter' FROM pages f WHERE f.id=links.from_page_id AND f.source_id=$1`, [SOURCE]);
      const before = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM links');
      await addCodeReferenceLinks(engine, DOC, SOURCE, [{ codeSlug: 'src-widgets-a-ts', path: 'src/widgets/a.ts', line: 99 }]);
      const after = await edges(engine, SOURCE);
      expect(after.filter(e => e.from === DOC && e.to === 'src-widgets-a-ts')).toEqual([
        { from: DOC, to: 'src-widgets-a-ts', type: 'documents', context: 'cited at src/widgets/a.ts:99', source: 'markdown', origin: DOC, field: 'compiled_truth' }]);
      expect(after.filter(e => e.from === 'src-widgets-a-ts')).toEqual([
        { from: 'src-widgets-a-ts', to: DOC, type: 'documented_by', context: 'src/widgets/a.ts', source: 'markdown', origin: DOC, field: 'compiled_truth' }]);
      expect(await engine.executeRaw('SELECT count(*)::int AS n FROM links')).toEqual(before);
    });

    test('no references write nothing and send no statement', async () => {
      const calls: string[] = [];
      const counting = { executeRaw: <R,>(sql: string, params?: unknown[]) => { calls.push(sql); return engine.executeRaw<R>(sql, params); } };
      expect(await addCodeReferenceLinks(counting, DOC, SOURCE, [])).toBe(0);
      expect(calls).toEqual([]);
      expect(await addCodeReferenceLinks(counting, DOC, SOURCE, REFS)).toBeGreaterThan(0);
      expect(calls).toHaveLength(1);
    });

    if (backend === 'postgres') test('a concurrent delete of a linked endpoint waits for the writing transaction', async () => {
      await seed(engine, ['src-widgets-d-ts']);
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      let wrote!: () => void;
      const written = new Promise<void>(resolve => { wrote = resolve; });
      const writer = engine.transaction(async tx => {
        await addCodeReferenceLinks(tx, DOC, SOURCE, [{ codeSlug: 'src-widgets-d-ts', path: 'src/widgets/d.ts' }]);
        wrote();
        await held;
      });
      await written;
      try {
        await expect(engine.transaction(async tx => {
          await tx.executeRaw("SET LOCAL lock_timeout = '300ms'");
          await tx.executeRaw('DELETE FROM pages WHERE source_id=$1 AND slug=$2', [SOURCE, 'src-widgets-d-ts']);
        })).rejects.toMatchObject({ code: '55P03' });
      } finally { release(); await writer; }
    });
  });
}
