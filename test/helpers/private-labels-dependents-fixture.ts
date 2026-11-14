/**
 * GST-2374: shared fixture and pre-change oracle for the private-labels dependents statement (dependentsSql), run by
 * test/repair-private-labels-dependents.test.ts (PGLite) and test/e2e/repair-private-labels-dependents-postgres.test.ts.
 *
 * The fixture holds every tie the remote privacy rules follow from a cleared page, in two sources with no checkout
 * (a repo-less brain): derived_from as a string and as an array, each with and without `.md`; an atom's source_slug; a
 * life-chronicle event's event.depth; an event naming a page whose derived_from holds the cleared slug; a
 * concept-provenance link to a cleared page and to an atom of a cleared origin; deleted origins, atoms and dependents; a
 * cleared page that is itself another clear's dependent; the same slug cleared in a second source; and near misses
 * (another link type, a non-object event, an origin that stays private).
 */
import type { BrainEngine } from '../../src/core/engine.ts';
import { privacyPartSql } from '../../src/core/search/private-visibility.ts';

export type DependentRow = { id: number; cleared_id: number; category: string };

/** The statement windowDependents ran before GST-2374, verbatim: every page paired with every cleared page of its source. */
export function preChangeDependentsSql(): string {
  return `WITH cleared AS (
      SELECT * FROM unnest($1::integer[], $2::text[], $3::text[], $4::text[]) AS c(id, source_id, slug, keys)),
    candidates AS (SELECT DISTINCT p.id, c.id AS cleared_id FROM pages p JOIN cleared c ON c.source_id = p.source_id
      WHERE p.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM cleared x WHERE x.id = p.id) AND (
        p.frontmatter->>'source_slug' = c.slug OR p.frontmatter->'event'->>'depth' = c.slug
        OR (jsonb_typeof(p.frontmatter->'derived_from') IN ('array', 'string') AND c.slug = ANY(ARRAY(SELECT regexp_replace(declared.slug, '\\.md$', '')
          FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p.frontmatter->'derived_from') = 'array' THEN p.frontmatter->'derived_from'
            ELSE jsonb_build_array(p.frontmatter->'derived_from') END) AS declared(slug))))
        OR EXISTS (SELECT 1 FROM pages o WHERE o.source_id = c.source_id AND o.slug = p.frontmatter->'event'->>'depth'
          AND jsonb_typeof(o.frontmatter->'derived_from') IN ('array', 'string') AND c.slug = ANY(ARRAY(SELECT regexp_replace(declared.slug, '\\.md$', '')
            FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(o.frontmatter->'derived_from') = 'array' THEN o.frontmatter->'derived_from'
              ELSE jsonb_build_array(o.frontmatter->'derived_from') END) AS declared(slug))))
        OR EXISTS (SELECT 1 FROM links l JOIN pages a ON a.id = l.to_page_id WHERE l.from_page_id = p.id AND l.link_source = 'concept-provenance'
          AND l.link_type = 'synthesized_from' AND (a.id = c.id OR (a.source_id = c.source_id AND a.frontmatter->>'source_slug' = c.slug)))))
    SELECT cand.id, cand.cleared_id, CASE WHEN p.type = 'event' AND p.frontmatter->>'captured_via' LIKE 'life-chronicle:%' THEN 'life_chronicle'
        WHEN p.type = 'atom' THEN 'atom' WHEN p.type = 'concept' AND p.frontmatter->>'synthesized_by' IS NOT NULL THEN 'concept' ELSE 'derived_from' END AS category
      FROM candidates cand JOIN pages p ON p.id = cand.id
      WHERE NOT ${privacyPartSql('p')} AND cand.id IN (
        WITH pages AS NOT MATERIALIZED (SELECT pg.id, pg.source_id, pg.slug, pg.type, pg.deleted_at,
            CASE WHEN c.id IS NULL THEN pg.frontmatter ELSE pg.frontmatter - string_to_array(c.keys, ',') END AS frontmatter
          FROM pages pg LEFT JOIN cleared c ON c.id = pg.id)
        SELECT after_clear.id FROM pages after_clear WHERE after_clear.id IN (SELECT id FROM candidates) AND ${privacyPartSql('after_clear', true)})
      ORDER BY cand.id`;
}

const PRIVATE = { access: 'private', visibility: 'private' };
const EVENT = (depth: unknown) => ({ captured_via: 'life-chronicle:test', event: depth });
/** [source, slug, type, frontmatter, deleted]; the cleared pages are the ones CLEARED names. */
const PAGES: Array<[string, string, string, Record<string, unknown>, boolean?]> = [
  ['dep-a', 'notes/o1', 'note', PRIVATE],
  ['dep-a', 'notes/o2', 'note', PRIVATE],
  ['dep-a', 'notes/o3', 'note', PRIVATE],
  ['dep-a', 'notes/o4', 'note', PRIVATE],
  ['dep-a', 'notes/o5', 'note', { ...PRIVATE, derived_from: 'notes/o1' }],
  ['dep-a', 'meetings/m6', 'note', { access: 'private' }],
  ['dep-a', 'notes/still-private', 'note', { visibility: 'private' }],
  ['dep-a', 'notes/d-str', 'note', { derived_from: 'notes/o1' }],
  ['dep-a', 'notes/d-str-md', 'note', { derived_from: 'notes/o1.md' }],
  ['dep-a', 'notes/d-arr', 'note', { derived_from: ['notes/o2', 'notes/missing'] }],
  ['dep-a', 'notes/d-arr-md', 'concept', { derived_from: ['notes/o2.md'] }],
  ['dep-a', 'notes/d-arr-two', 'note', { derived_from: ['notes/o1', 'notes/o2'] }],
  ['dep-a', 'notes/d-arr-mixed', 'note', { derived_from: ['notes/o3', 'notes/still-private'] }],
  ['dep-a', 'notes/d-num', 'note', { derived_from: [5, null, 'notes/o4'] }],
  ['dep-a', 'notes/d-own', 'note', { derived_from: 'notes/o4', visibility: 'private' }],
  ['dep-a', 'notes/d-deleted', 'note', { derived_from: 'notes/o1' }, true],
  ['dep-a', 'notes/d-del', 'note', { derived_from: 'notes/o2' }, true],
  ['dep-a', 'atoms/a3', 'atom', { source_slug: 'notes/o3', visibility: 'world' }],
  ['dep-a', 'atoms/a3-del', 'atom', { source_slug: 'notes/o3', visibility: 'world' }, true],
  ['dep-a', 'events/e6', 'event', EVENT({ depth: 'meetings/m6' })],
  ['dep-a', 'events/e-chain', 'event', EVENT({ depth: 'notes/d-str' })],
  ['dep-a', 'events/e-del-chain', 'event', EVENT({ depth: 'notes/d-del' })],
  ['dep-a', 'events/e-flat', 'event', EVENT('notes/o4')],
  ['dep-a', 'concepts/s4', 'concept', { synthesized_by: 'test', visibility: 'world' }],
  ['dep-a', 'concepts/s3', 'concept', { synthesized_by: 'test', visibility: 'world' }],
  ['dep-a', 'concepts/s3-del', 'concept', { synthesized_by: 'test', visibility: 'world' }],
  ['dep-a', 'concepts/s-mention', 'concept', { synthesized_by: 'test', visibility: 'world' }],
  ['dep-a', 'notes/unrelated', 'note', { tags: ['x'] }],
  ['dep-b', 'notes/o1', 'note', PRIVATE],
  ['dep-b', 'notes/d-other', 'note', { derived_from: 'notes/o1' }],
];
/** [source, from slug, to slug, link_type, link_source]. */
const LINKS: Array<[string, string, string, string, string]> = [
  ['dep-a', 'concepts/s4', 'notes/o4', 'synthesized_from', 'concept-provenance'],
  ['dep-a', 'concepts/s3', 'atoms/a3', 'synthesized_from', 'concept-provenance'],
  ['dep-a', 'concepts/s3-del', 'atoms/a3-del', 'synthesized_from', 'concept-provenance'],
  ['dep-a', 'concepts/s-mention', 'notes/o4', 'mentions', 'markdown'],
];
const CLEARED: Array<[string, string]> = [['dep-a', 'notes/o1'], ['dep-a', 'notes/o2'], ['dep-a', 'notes/o3'], ['dep-a', 'notes/o4'],
  ['dep-a', 'notes/o5'], ['dep-a', 'meetings/m6'], ['dep-b', 'notes/o1']];
/** Every row both statements must return: [dependent, cleared page, category], by source:slug. */
export const EXPECTED: string[][] = [
  ['dep-a:notes/d-str', 'dep-a:notes/o1', 'derived_from'],
  ['dep-a:notes/d-str-md', 'dep-a:notes/o1', 'derived_from'],
  ['dep-a:notes/d-arr', 'dep-a:notes/o2', 'derived_from'],
  ['dep-a:notes/d-arr-md', 'dep-a:notes/o2', 'derived_from'],
  ['dep-a:notes/d-arr-two', 'dep-a:notes/o1', 'derived_from'],
  ['dep-a:notes/d-arr-two', 'dep-a:notes/o2', 'derived_from'],
  ['dep-a:notes/d-num', 'dep-a:notes/o4', 'derived_from'],
  ['dep-a:atoms/a3', 'dep-a:notes/o3', 'atom'],
  ['dep-a:events/e6', 'dep-a:meetings/m6', 'life_chronicle'],
  ['dep-a:events/e-chain', 'dep-a:notes/o1', 'life_chronicle'],
  ['dep-a:events/e-del-chain', 'dep-a:notes/o2', 'life_chronicle'],
  ['dep-a:concepts/s4', 'dep-a:notes/o4', 'concept'],
  ['dep-a:concepts/s3', 'dep-a:notes/o3', 'concept'],
  ['dep-a:concepts/s3-del', 'dep-a:notes/o3', 'concept'],
  ['dep-b:notes/d-other', 'dep-b:notes/o1', 'derived_from'],
];

export interface DependentsFixture { params: unknown[]; name: Map<number, string> }

/** Writes the fixture and returns the statement parameters for its cleared pages and each page id's source:slug. */
export async function seedDependentsFixture(engine: BrainEngine): Promise<DependentsFixture> {
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('dep-a', 'dep-a'), ('dep-b', 'dep-b') ON CONFLICT (id) DO NOTHING`);
  for (const [source, slug, type, frontmatter, deleted] of PAGES) {
    await engine.executeRaw(`INSERT INTO pages (slug, source_id, type, title, compiled_truth, frontmatter, deleted_at)
      VALUES ($1, $2, $3, $1, 'body', $4::text::jsonb, CASE WHEN $5 THEN now() END)`, [slug, source, type, JSON.stringify(frontmatter), !!deleted]);
  }
  for (const [source, from, to, type, linkSource] of LINKS) {
    await engine.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type, link_source)
      SELECT f.id, t.id, $4, $5 FROM pages f, pages t WHERE f.source_id = $1 AND t.source_id = $1 AND f.slug = $2 AND t.slug = $3`, [source, from, to, type, linkSource]);
  }
  const rows = await engine.executeRaw<{ id: number; source_id: string; slug: string; frontmatter: Record<string, unknown> }>(
    `SELECT id, source_id, slug, frontmatter FROM pages WHERE source_id IN ('dep-a', 'dep-b')`);
  const name = new Map(rows.map(row => [Number(row.id), row.source_id + ':' + row.slug] as const));
  const cleared = CLEARED.map(([source, slug]) => rows.find(row => row.source_id === source && row.slug === slug)!);
  const keys = (fm: Record<string, unknown>) => Object.keys(fm).filter(key => key === 'access' || key === 'visibility').sort().join(',');
  return { name, params: [cleared.map(row => Number(row.id)), cleared.map(row => row.source_id), cleared.map(row => row.slug), cleared.map(row => keys(typeof row.frontmatter === 'string' ? JSON.parse(row.frontmatter) : row.frontmatter))] };
}

/** Rows as [dependent, cleared, category], each page by its source:slug in `name` or else its id, sorted. */
export function named(rows: DependentRow[], name: Map<number, string>): string[][] {
  const label = (id: number) => name.get(Number(id)) ?? String(Number(id));
  return rows.map(row => [label(row.id), label(row.cleared_id), row.category]).sort((a, b) => (a.join('|') < b.join('|') ? -1 : 1));
}

/**
 * A generated source of `pages` pages shaped like a large brain: every 8th page labelled (every other one also
 * `visibility: private`), and ties from later pages by source_slug, event.depth, derived_from (string and array with
 * `.md`), an event naming a derived_from page, and concept-provenance links. Returns the parameters for the first
 * `clears` labelled pages.
 */
export async function seedGeneratedSource(engine: BrainEngine, source: string, pages: number, clears: number): Promise<unknown[]> {
  await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [source]);
  await engine.executeRaw(`INSERT INTO pages (slug, source_id, type, title, compiled_truth, frontmatter)
    SELECT 'notes/n-' || i, $1,
      CASE WHEN i % 128 = 9 THEN 'atom' WHEN i % 128 = 11 OR i % 16 = 5 THEN 'concept' WHEN i % 16 IN (2, 10) THEN 'event' ELSE 'note' END,
      'Note ' || i, 'body',
      CASE
        WHEN i % 16 = 0 THEN '{"access": "private"}'::jsonb
        WHEN i % 16 = 8 THEN '{"access": "private", "visibility": "private"}'::jsonb
        WHEN i % 128 = 9 THEN jsonb_build_object('source_slug', 'notes/n-' || (i - 1), 'visibility', 'world')
        WHEN i % 128 = 11 OR i % 16 = 5 THEN '{"synthesized_by": "dream", "visibility": "world"}'::jsonb
        WHEN i % 16 = 2 THEN jsonb_build_object('captured_via', 'life-chronicle:meeting', 'event', jsonb_build_object('depth', 'notes/n-' || (i - 2)))
        WHEN i % 16 = 14 THEN jsonb_build_object('derived_from', 'notes/n-' || (i - 6))
        WHEN i % 16 = 15 THEN jsonb_build_object('derived_from', jsonb_build_array('notes/n-' || (i - 7) || '.md', 'notes/n-' || (i - 15)))
        WHEN i % 16 = 10 THEN jsonb_build_object('captured_via', 'life-chronicle:meeting', 'event', jsonb_build_object('depth', 'notes/n-' || (i + 4)))
        ELSE '{}'::jsonb
      END
    FROM generate_series(0, ${pages - 1}) i`, [source]);
  await engine.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type, link_source)
    SELECT c.id, a.id, 'synthesized_from', 'concept-provenance' FROM pages c
    JOIN pages a ON a.source_id = c.source_id AND a.slug = 'notes/n-' || (substring(c.slug from 9)::int - CASE WHEN substring(c.slug from 9)::int % 128 = 11 THEN 2 ELSE 13 END)
    WHERE c.source_id = $1 AND c.type = 'concept'`, [source]);
  const cleared = await engine.executeRaw<{ id: number; slug: string; frontmatter: unknown }>(
    `SELECT id, slug, frontmatter FROM pages WHERE source_id = $1 AND frontmatter ? 'access' ORDER BY id LIMIT ${clears}`, [source]);
  const keys = (fm: unknown) => Object.keys(typeof fm === 'string' ? JSON.parse(fm) : fm as object).sort().join(',');
  return [cleared.map(row => Number(row.id)), cleared.map(() => source), cleared.map(row => row.slug), cleared.map(row => keys(row.frontmatter))];
}
