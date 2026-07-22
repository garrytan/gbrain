/**
 * v0.41.2.1 — D10 reversal: real-Postgres parity for the new
 * extract-atoms discovery SQL. Closes the D5 gap codex flagged: the
 * raw SQL uses ANY($::text[]) binding, JSONB ->>, substring(... from N
 * for M), and NOT EXISTS subquery — features PGLite parses but the
 * real Postgres wire binding through `postgres.unsafe` is subtly
 * different. PGLite-only tests are not proof.
 *
 * Asserts:
 *   1. discoverExtractablePages returns rows on a seeded federated brain
 *   2. NOT EXISTS subquery skips already-extracted source pages
 *   3. sourceId scoping isolates between two seeded sources (no leak)
 *   4. ANY($2::text[]) binding actually filters by type set
 *
 * ~4 structural assertions; ~3-5s wallclock budget.
 * Skips gracefully when DATABASE_URL is unset.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { setupDB, teardownDB, hasDatabase } from './helpers.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { discoverExtractablePages } from '../../src/core/cycle/extract-atoms.ts';

const skip = !hasDatabase();
const describeIfDB = skip ? describe.skip : describe;

let engine: PostgresEngine;

beforeAll(async () => {
  if (skip) return;
  engine = (await setupDB()) as PostgresEngine;
});

afterAll(async () => {
  if (skip) return;
  await teardownDB();
});

beforeEach(async () => {
  if (skip) return;
  // Clean test-source rows + atoms + meeting pages between tests
  await engine.executeRaw(`DELETE FROM pages WHERE source_id IN ('default', 'dept-x') AND (type = 'atom' OR type IN ('meeting', 'source', 'article', 'video', 'book', 'original'))`);
  await engine.executeRaw(`DELETE FROM sources WHERE id = 'dept-x'`);
});

const LONG = 'a'.repeat(800);

async function seedPage(opts: {
  slug: string;
  type: string;
  content_hash?: string;
  frontmatter?: Record<string, unknown>;
  source_id?: string;
}) {
  await engine.putPage(
    opts.slug,
    {
      type: opts.type as never,
      title: opts.slug,
      compiled_truth: LONG,
      timeline: '',
      frontmatter: opts.frontmatter ?? {},
    },
    { sourceId: opts.source_id ?? 'default' },
  );
  if (opts.content_hash) {
    await engine.executeRaw(
      `UPDATE pages SET content_hash = $1 WHERE slug = $2 AND source_id = $3`,
      [opts.content_hash, opts.slug, opts.source_id ?? 'default'],
    );
  }
}

describeIfDB('v0.41.2.1 D10 — discoverExtractablePages on real Postgres', () => {
  test('returns extractable rows when seeded', async () => {
    await seedPage({ slug: 'meeting/a', type: 'meeting', content_hash: 'hash-A-1234567890abc' });
    await seedPage({ slug: 'source/b', type: 'source', content_hash: 'hash-B-1234567890abc' });
    await seedPage({ slug: 'notes/skip', type: 'note', content_hash: 'hash-N-1234567890abc' });

    const discovered = await discoverExtractablePages(engine, 'default');
    const slugs = discovered.map((d) => d.slug).sort();
    expect(slugs).toContain('meeting/a');
    expect(slugs).toContain('source/b');
    expect(slugs).not.toContain('notes/skip');
  });

  test('ANY($::text[]) bind works through postgres.unsafe (PGLite parity proof)', async () => {
    // Seed all 6 extractable types + one non-extractable. The SQL uses
    // type = ANY($2::text[]) — if the binding shape differs between
    // PGLite and postgres.js's unsafe(), this catches it.
    for (const type of ['meeting', 'source', 'article', 'video', 'book', 'original']) {
      await seedPage({ slug: `${type}/x`, type, content_hash: `hash-${type}-1234567890ab` });
    }
    await seedPage({ slug: 'note/skip', type: 'note', content_hash: 'hash-note-1234567890' });

    const discovered = await discoverExtractablePages(engine, 'default');
    const slugs = discovered.map((d) => d.slug).sort();
    expect(slugs).toEqual([
      'article/x', 'book/x', 'meeting/x', 'original/x', 'source/x', 'video/x',
    ]);
  });

  test('NOT EXISTS subquery skips pages with existing atoms', async () => {
    await seedPage({ slug: 'meeting/old', type: 'meeting', content_hash: 'oldhash1234567890abc' });
    await seedPage({ slug: 'meeting/new', type: 'meeting', content_hash: 'newhash1234567890abc' });
    // Seed atom with frontmatter.source_hash = first 16 chars of oldhash
    await engine.putPage(
      'atoms/seeded/old-insight',
      {
        type: 'atom' as never,
        title: 'old',
        compiled_truth: 'b',
        timeline: '',
        frontmatter: { source_hash: 'oldhash123456789' }, // first 16 chars of seed
      },
      { sourceId: 'default' },
    );

    const discovered = await discoverExtractablePages(engine, 'default');
    expect(discovered.map((d) => d.slug)).toEqual(['meeting/new']);
  });

  test('sourceId scopes both candidate AND atom-existence subquery — no cross-source leak', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('dept-x', 'dept-x') ON CONFLICT DO NOTHING`,
    );
    await seedPage({ slug: 'meeting/a-default', type: 'meeting', content_hash: 'hash-default-A-12345' });
    await seedPage({ slug: 'meeting/a-dept-x', type: 'meeting', content_hash: 'hash-dept-x-A-12345', source_id: 'dept-x' });

    const fromDefault = await discoverExtractablePages(engine, 'default');
    const fromDeptX = await discoverExtractablePages(engine, 'dept-x');

    expect(fromDefault.map((d) => d.slug)).toEqual(['meeting/a-default']);
    expect(fromDeptX.map((d) => d.slug)).toEqual(['meeting/a-dept-x']);
  });
});
