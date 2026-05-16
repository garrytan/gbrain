import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  runMergePhantomsCore,
  listPhantomEntityPages,
  formatMergePhantomsText,
  type MergePhantomsResult,
} from '../src/commands/merge-phantoms.ts';

/**
 * v0.34.5 — operator cleanup of pre-fix phantom unprefixed entity pages.
 *
 * `gbrain merge-phantoms` walks the pile of pre-v0.34.5 phantom slugs
 * (unprefixed person/company/deal/topic/concept pages spawned by the
 * old resolver fallthrough), runs the new prefix-expansion resolver on
 * each, repoints facts to the canonical slug, and soft-deletes the
 * phantom.
 *
 * Coverage matrix per plan mossy-popping-crown.md D7:
 *   - dry-run reports without mutating
 *   - phantom with single canonical → merge + soft-delete
 *   - phantom with NO canonical → skip
 *   - phantom whose canonical doesn't exist → skip
 *   - fact dedup at the entity_slug repoint
 *   - source-id scoping
 *   - --json envelope shape stable (covered indirectly via the result shape)
 */

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

// Wipe the test surface between cases. We don't use the shared
// resetPgliteState helper here because this file's tests need very
// specific seed shapes — clearing the relevant tables directly is
// simpler.
beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM facts`, []);
  await engine.executeRaw(`DELETE FROM content_chunks`, []);
  await engine.executeRaw(`DELETE FROM links`, []);
  await engine.executeRaw(`DELETE FROM pages`, []);
  await engine.executeRaw(`DELETE FROM sources WHERE id != 'default'`, []);
});

async function seedPage(slug: string, type: string, sourceId = 'default'): Promise<number> {
  await engine.putPage(
    slug,
    {
      type: type as any,
      title: slug,
      compiled_truth: `# ${slug}`,
      frontmatter: { type, title: slug, slug },
    },
    { sourceId },
  );
  const rows = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM pages WHERE slug = $1 AND source_id = $2`,
    [slug, sourceId],
  );
  return rows[0].id;
}

async function seedChunks(slug: string, count: number, sourceId = 'default'): Promise<void> {
  const rows = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM pages WHERE slug = $1 AND source_id = $2`,
    [slug, sourceId],
  );
  if (rows.length === 0) return;
  const pid = rows[0].id;
  for (let i = 0; i < count; i++) {
    await engine.executeRaw(
      `INSERT INTO content_chunks (page_id, chunk_index, chunk_text)
       VALUES ($1, $2, $3) ON CONFLICT (page_id, chunk_index) DO NOTHING`,
      [pid, i, `Chunk ${i} about ${slug}`],
    );
  }
}

async function seedFact(entitySlug: string, body: string, sourceId = 'default'): Promise<number> {
  const result = await (engine as unknown as BrainEngine).insertFact(
    {
      fact: body,
      kind: 'fact' as const,
      entity_slug: entitySlug,
      visibility: 'private' as const,
      notability: 'medium' as const,
      source: 'test:merge-phantoms',
      source_session: null,
      embedding: null,
    },
    { source_id: sourceId },
  );
  return result.id;
}

describe('merge-phantoms — listPhantomEntityPages', () => {
  it('returns unprefixed entity-type rows only', async () => {
    await seedPage('alice', 'person');
    await seedPage('people/alice-example', 'person');
    await seedPage('docs/notes', 'concept'); // prefixed → excluded
    await seedPage('random', 'guide');       // wrong type → excluded
    await seedPage('bob', 'company');        // unprefixed company → included

    const phantoms = await listPhantomEntityPages(engine as unknown as BrainEngine, 'default');
    expect(phantoms.map(p => p.slug).sort()).toEqual(['alice', 'bob']);
  });
});

describe('merge-phantoms — runMergePhantomsCore', () => {
  it('dry-run reports merges without mutating', async () => {
    await seedPage('alice', 'person');
    await seedPage('people/alice-example', 'person');
    await seedChunks('people/alice-example', 5);
    await seedFact('alice', 'Alice likes integration tests.');

    const result = await runMergePhantomsCore(engine as unknown as BrainEngine, {
      sourceId: 'default',
      dryRun: true,
    });

    expect(result.dry_run).toBe(true);
    expect(result.merged.length).toBe(1);
    expect(result.merged[0]).toEqual({
      phantom: 'alice',
      canonical: 'people/alice-example',
      facts_moved: 1,
    });

    // Confirm nothing actually moved.
    const stillPhantom = await engine.executeRaw<{ entity_slug: string }>(
      `SELECT entity_slug FROM facts WHERE entity_slug = $1`,
      ['alice'],
    );
    expect(stillPhantom.length).toBe(1);

    const phantomPage = await engine.executeRaw<{ id: number; deleted_at: Date | null }>(
      `SELECT id, deleted_at FROM pages WHERE slug = $1 AND source_id = 'default'`,
      ['alice'],
    );
    expect(phantomPage[0].deleted_at).toBeNull();
  });

  it('merges facts and soft-deletes the phantom when a canonical exists', async () => {
    await seedPage('alice', 'person');
    await seedPage('people/alice-example', 'person');
    await seedChunks('people/alice-example', 5);
    await seedFact('alice', 'Fact one about Alice.');
    await seedFact('alice', 'Fact two about Alice.');

    const result = await runMergePhantomsCore(engine as unknown as BrainEngine, {
      sourceId: 'default',
      dryRun: false,
    });

    expect(result.merged.length).toBe(1);
    expect(result.merged[0].facts_moved).toBe(2);

    // Facts repointed.
    const onPhantom = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM facts WHERE entity_slug = 'alice'`,
      [],
    );
    expect(onPhantom[0].n).toBe(0);
    const onCanonical = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM facts WHERE entity_slug = 'people/alice-example'`,
      [],
    );
    expect(onCanonical[0].n).toBe(2);

    // Phantom soft-deleted.
    const phantomPage = await engine.executeRaw<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM pages WHERE slug = 'alice' AND source_id = 'default'`,
      [],
    );
    expect(phantomPage[0].deleted_at).not.toBeNull();
  });

  it('skips a phantom with no matching canonical (prefix expansion finds nothing)', async () => {
    // "Zoolander" has no matching people/zoolander-* or companies/zoolander-* page.
    // tryPrefixExpansion returns null → skip with no_canonical.
    await seedPage('zoolander', 'person');
    await seedFact('zoolander', 'Sample fact about Zoolander.');

    const result = await runMergePhantomsCore(engine as unknown as BrainEngine, {
      sourceId: 'default',
      dryRun: false,
    });

    expect(result.merged.length).toBe(0);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0].skipped).toBe('no_canonical');

    // Phantom still alive, fact still on phantom.
    const phantomPage = await engine.executeRaw<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM pages WHERE slug = 'zoolander' AND source_id = 'default'`,
      [],
    );
    expect(phantomPage[0].deleted_at).toBeNull();
    const factRow = await engine.executeRaw<{ entity_slug: string }>(
      `SELECT entity_slug FROM facts`,
      [],
    );
    expect(factRow[0].entity_slug).toBe('zoolander');
  });

  it('skips a phantom whose canonical target is soft-deleted', async () => {
    // The prefix-expansion SQL filters `WHERE p.deleted_at IS NULL`. If
    // the only candidate is soft-deleted, the resolver returns null and
    // the merge skips with `no_canonical`. This pins that soft-deleted
    // pages don't act as live merge targets.
    await seedPage('beth', 'person');
    await seedPage('people/beth-example', 'person');
    await seedChunks('people/beth-example', 3);
    await seedFact('beth', 'Beth fact pre-delete.');
    await engine.softDeletePage('people/beth-example', { sourceId: 'default' });

    const result = await runMergePhantomsCore(engine as unknown as BrainEngine, {
      sourceId: 'default',
      dryRun: false,
    });

    expect(result.merged.length).toBe(0);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0].skipped).toBe('no_canonical');

    // Phantom still alive.
    const phantomPage = await engine.executeRaw<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM pages WHERE slug = 'beth' AND source_id = 'default'`,
      [],
    );
    expect(phantomPage[0].deleted_at).toBeNull();
  });

  it('fact entity_slug repoint does not multiply rows', async () => {
    // Verify the UPDATE statement repoints in place — two facts on the
    // phantom, both move to canonical, no duplication, no row loss.
    await seedPage('alice', 'person');
    await seedPage('people/alice-example', 'person');
    await seedChunks('people/alice-example', 5);
    const f1 = await seedFact('alice', 'Fact A about Alice.');
    const f2 = await seedFact('alice', 'Fact B about Alice.');

    await runMergePhantomsCore(engine as unknown as BrainEngine, {
      sourceId: 'default',
      dryRun: false,
    });

    // Both fact ids still exist with the new entity_slug; no extra rows.
    const all = await engine.executeRaw<{ id: number; entity_slug: string }>(
      `SELECT id, entity_slug FROM facts ORDER BY id ASC`,
      [],
    );
    expect(all.length).toBe(2);
    expect(all[0].id).toBe(f1);
    expect(all[1].id).toBe(f2);
    expect(all[0].entity_slug).toBe('people/alice-example');
    expect(all[1].entity_slug).toBe('people/alice-example');
  });

  it('scopes merge to the requested source_id', async () => {
    // Seed phantom 'alice' + canonical in TWO sources. The merge should
    // touch only the requested source's rows.
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('src-a', 'src-a', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`,
      [],
    );
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('src-b', 'src-b', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`,
      [],
    );
    await seedPage('alice', 'person', 'src-a');
    await seedPage('people/alice-example', 'person', 'src-a');
    await seedChunks('people/alice-example', 5, 'src-a');
    await seedFact('alice', 'Fact in src-a.', 'src-a');

    await seedPage('alice', 'person', 'src-b');
    await seedPage('people/alice-example', 'person', 'src-b');
    await seedChunks('people/alice-example', 5, 'src-b');
    await seedFact('alice', 'Fact in src-b (should NOT move).', 'src-b');

    const result = await runMergePhantomsCore(engine as unknown as BrainEngine, {
      sourceId: 'src-a',
      dryRun: false,
    });

    expect(result.source_id).toBe('src-a');
    expect(result.merged.length).toBe(1);

    // src-a phantom soft-deleted, src-b phantom intact.
    const aDel = await engine.executeRaw<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM pages WHERE slug = 'alice' AND source_id = 'src-a'`,
      [],
    );
    expect(aDel[0].deleted_at).not.toBeNull();
    const bDel = await engine.executeRaw<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM pages WHERE slug = 'alice' AND source_id = 'src-b'`,
      [],
    );
    expect(bDel[0].deleted_at).toBeNull();

    // src-a fact repointed, src-b fact still on the phantom.
    const aFacts = await engine.executeRaw<{ entity_slug: string }>(
      `SELECT entity_slug FROM facts WHERE source_id = 'src-a'`,
      [],
    );
    expect(aFacts[0].entity_slug).toBe('people/alice-example');
    const bFacts = await engine.executeRaw<{ entity_slug: string }>(
      `SELECT entity_slug FROM facts WHERE source_id = 'src-b'`,
      [],
    );
    expect(bFacts[0].entity_slug).toBe('alice');
  });

  it('is idempotent — second run produces zero merges', async () => {
    await seedPage('alice', 'person');
    await seedPage('people/alice-example', 'person');
    await seedChunks('people/alice-example', 5);
    await seedFact('alice', 'One fact about Alice.');

    const first = await runMergePhantomsCore(engine as unknown as BrainEngine, {
      sourceId: 'default',
      dryRun: false,
    });
    expect(first.merged.length).toBe(1);

    const second = await runMergePhantomsCore(engine as unknown as BrainEngine, {
      sourceId: 'default',
      dryRun: false,
    });
    expect(second.merged.length).toBe(0);
    expect(second.total_scanned).toBe(0);
  });
});

describe('merge-phantoms — output shape', () => {
  it('returns a stable result envelope (suitable for --json)', async () => {
    await seedPage('alice', 'person');
    await seedPage('people/alice-example', 'person');
    await seedChunks('people/alice-example', 5);
    await seedFact('alice', 'Stable envelope test.');

    const result: MergePhantomsResult = await runMergePhantomsCore(
      engine as unknown as BrainEngine,
      { sourceId: 'default', dryRun: true },
    );

    expect(result).toMatchObject({
      dry_run: true,
      source_id: 'default',
      total_scanned: 1,
    });
    expect(Array.isArray(result.merged)).toBe(true);
    expect(Array.isArray(result.skipped)).toBe(true);
    // Each merged entry has phantom + canonical + facts_moved keys.
    for (const m of result.merged) {
      expect(typeof m.phantom).toBe('string');
      expect(typeof m.canonical).toBe('string');
      expect(typeof m.facts_moved).toBe('number');
    }
  });

  it('formats text output with merged + skipped sections', async () => {
    const result: MergePhantomsResult = {
      merged: [{ phantom: 'alice', canonical: 'people/alice-example', facts_moved: 2 }],
      skipped: [{ phantom: 'beth', canonical: 'beth', skipped: 'canonical_equals_phantom' }],
      total_scanned: 2,
      dry_run: false,
      source_id: 'default',
    };
    const out = formatMergePhantomsText(result);
    expect(out).toContain('scanned 2');
    expect(out).toContain('MERGED:');
    expect(out).toContain('alice  →  people/alice-example');
    expect(out).toContain('SKIPPED:');
    expect(out).toContain('canonical_equals_phantom');
  });
});
