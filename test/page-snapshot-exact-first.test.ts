/**
 * An alias-resolving page read runs the exact-slug statement first and the
 * alias statement only on a miss (src/core/page-state/snapshot.ts). An exact
 * match outranks every alias match in the alias statement's ORDER BY, so the
 * two-step read returns the same row; an ambiguity check still counts alias
 * matches, so it runs the alias statement alone.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { readPageSnapshot } from '../src/core/page-state/snapshot.ts';
import { PageSnapshotAmbiguousError, type PageSnapshotOptions } from '../src/core/page-state/types.ts';

let engine: PGLiteEngine;

/** Reads through the canonical snapshot function and records each statement it sends. */
async function read(slug: string, opts: PageSnapshotOptions) {
  const statements: string[] = [];
  const snapshot = await readPageSnapshot(async (sql, params) => {
    statements.push(sql);
    return engine.executeRaw(sql, params) as never;
  }, slug, opts);
  return { snapshot, statements, aliasStatements: statements.filter(sql => sql.includes('slug_aliases')).length };
}

const page = (body: string, frontmatter: Record<string, unknown> = {}) => ({ type: 'note' as const, title: body, compiled_truth: body, frontmatter });

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const id of ['alpha', 'beta']) {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`, [id]);
  }
  await engine.putPage('notes/canonical', page('alpha canonical'), { sourceId: 'alpha' });
  await engine.putPage('notes/old-name', page('beta page at the alias slug'), { sourceId: 'beta' });
  await engine.putPage('notes/gone', page('deleted exact'), { sourceId: 'alpha' });
  await engine.putPage('notes/gone-canonical', page('live canonical'), { sourceId: 'alpha' });
  await engine.putPage('notes/private-exact', page('private exact', { visibility: 'private' }), { sourceId: 'alpha' });
  await engine.putPage('notes/world-canonical', page('world canonical'), { sourceId: 'alpha' });
  await engine.executeRaw(`UPDATE pages SET deleted_at = now() WHERE slug = 'notes/gone'`);
  await engine.executeRaw(`INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug, notes) VALUES
    ('alpha', 'notes/old-name', 'notes/canonical', 'test'),
    ('alpha', 'legacy/canonical', 'notes/canonical', 'test'),
    ('alpha', 'notes/gone', 'notes/gone-canonical', 'test'),
    ('alpha', 'notes/private-exact', 'notes/world-canonical', 'test')`);
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
}, 60_000);

describe('alias-resolving page read: exact slug first', () => {
  test('an exact hit is one statement and skips the alias lookup', async () => {
    const { snapshot, statements, aliasStatements } = await read('notes/canonical', { resolveAlias: true });
    expect(snapshot?.page.slug).toBe('notes/canonical');
    expect(statements).toHaveLength(1);
    expect(aliasStatements).toBe(0);
  });

  test('an alias-only slug falls back to the alias statement and returns the canonical page', async () => {
    const { snapshot, statements, aliasStatements } = await read('legacy/canonical', { resolveAlias: true });
    expect(snapshot?.page.slug).toBe('notes/canonical');
    expect(snapshot?.page.source_id).toBe('alpha');
    expect(statements).toHaveLength(2);
    expect(aliasStatements).toBe(1);
  });

  test('an exact page in another source still outranks an alias in this one, as the alias statement orders it', async () => {
    const both = await read('notes/old-name', { resolveAlias: true });
    expect([both.snapshot?.page.slug, both.snapshot?.page.source_id]).toEqual(['notes/old-name', 'beta']);
    expect(both.aliasStatements).toBe(0);
    const scoped = await read('notes/old-name', { resolveAlias: true, sourceId: 'alpha' });
    expect([scoped.snapshot?.page.slug, scoped.snapshot?.page.source_id]).toEqual(['notes/canonical', 'alpha']);
  });

  test('filters apply to the exact lookup: a deleted or private exact page misses and the alias resolves', async () => {
    expect((await read('notes/gone', { resolveAlias: true })).snapshot?.page.slug).toBe('notes/gone-canonical');
    expect((await read('notes/gone', { resolveAlias: true, includeDeleted: true })).snapshot?.page.slug).toBe('notes/gone');
    expect((await read('notes/private-exact', { resolveAlias: true, excludePrivate: true })).snapshot?.page.slug).toBe('notes/world-canonical');
    expect((await read('notes/private-exact', { resolveAlias: true })).snapshot?.page.slug).toBe('notes/private-exact');
  });

  test('an ambiguity check runs the alias statement alone and still sees alias matches', async () => {
    const run = read('notes/old-name', { resolveAlias: true, requireUnambiguous: true });
    await expect(run).rejects.toBeInstanceOf(PageSnapshotAmbiguousError);
    const single = await read('notes/canonical', { resolveAlias: true, requireUnambiguous: true });
    expect(single.snapshot?.page.slug).toBe('notes/canonical');
    expect(single.statements).toHaveLength(1);
    expect(single.aliasStatements).toBe(1);
  });

  test('a missing slug returns null after both statements', async () => {
    const { snapshot, statements } = await read('notes/never', { resolveAlias: true });
    expect(snapshot).toBeNull();
    expect(statements).toHaveLength(2);
  });
});
