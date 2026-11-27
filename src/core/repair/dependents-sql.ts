/**
 * The dependents statement of the privacy label repairs (private-labels.ts) and of the derived-origin carry
 * (origin-carry.ts, through engine-sql/label-door.ts `listOriginDependents`): which pages a clear or a removal opens.
 * A leaf module, so the engines can splice it without the repair's write paths in their import graph.
 */
import { privacyPartSql } from '../search/private-visibility.ts';

/**
 * The pages of a source in `from` (source_id, slug) whose frontmatter can name one of its slugs: `event.depth` alone with
 * `depthOnly`, else also `source_slug` and a `derived_from` string or array entry, with or without `.md`. Each source's
 * slugs, 100 at a time, make one jsonpath filter that idx_pages_frontmatter answers in a single scan (every GIN scan reads
 * the index's whole pending list, so a scan per slug and shape cost more than the full read it replaced on a brain with
 * recent writes). A slug that reads as a JSON number or boolean is also matched as that scalar, since `->>` and
 * jsonb_array_elements_text read one as its text; a number with an exponent over three digits is matched as text only,
 * since the jsonpath cast of one (`1e999999`) overflows numeric and would fail the whole lookup.
 */
function namingSql(from: string, depthOnly = false): string {
  const test = depthOnly ? `'@.event.depth == ' || f.v`
    : `'@.source_slug == ' || f.v || ' || @.event.depth == ' || f.v || ' || @.derived_from == ' || f.v || ' || @.derived_from == ' || to_jsonb(n.slug || '.md')::text`;
  return `SELECT p.id, p.source_id, p.slug, p.frontmatter ? 'derived_from' AS declares FROM (
      SELECT n.source_id, ('$ ? (' || string_agg(${test}, ' || ') || ')')::jsonpath AS path
        FROM (SELECT DISTINCT source_id, slug, (dense_rank() OVER (PARTITION BY source_id ORDER BY slug) - 1) / 100 AS part FROM ${from} r) n
        CROSS JOIN LATERAL (SELECT to_jsonb(n.slug)::text AS v UNION ALL SELECT n.slug WHERE n.slug ~ '^(-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]{1,3})?|true|false)$') f
        GROUP BY n.source_id, n.part) q
      JOIN LATERAL (SELECT p.id, p.source_id, p.slug, p.frontmatter FROM pages p WHERE p.frontmatter @? q.path AND p.source_id = q.source_id OFFSET 0) p ON true`;
}

/**
 * The windowDependents statement: (id, cleared_id, category) for each exposed page and the cleared page it is tied to, from
 * the cleared pages ($1 ids, $2 source ids, $3 slugs, $4 comma-joined label keys). It never pairs every page with every
 * cleared page: one scan of the window's sources lists each page's references (source_slug, event.depth, each
 * derived_from slug without `.md`), and every tie is an equality join of those references, or of concept-provenance
 * links through idx_links_to, to the cleared pages. The postimage is the pages table shadowed with the window's keys
 * removed; its privacy rules read only candidate pages and the pages they name.
 *
 * GST-2689 `remove`: the postimage is the pages table with the cleared pages removed instead (their rows, so the links to
 * them go too), `keys` is unused, an atom also ties to the page a rename moved its `source_slug` to (slug_aliases and
 * slug_rename_history, read before a purge scrubs them). Its references are read only from the pages that can name a
 * cleared page, found through idx_pages_frontmatter (a containment probe per reference shape, for each cleared slug and
 * each slug a rename moved to it), and from the events whose `event.depth` names one of those pages, so the statement
 * costs the same on a large source as on a small one; the probes find a superset and `refs` keeps only exact matches.
 * A page that names readers is judged by the same privacy rules, since readable_by never relaxes them: it is returned
 * when the removal would open it to its listed readers. A soft-deleted page is a candidate too, since a restore brings it
 * back with the origin row gone, and so is a removed page tied to another removed page (judged on its own row, against
 * the postimage), since another hold may keep it from the purge.
 */
export function dependentsSql(mode: 'clear' | 'remove' = 'clear'): string {
  const remove = mode === 'remove';
  const live = (sql: string) => remove ? '' : sql;
  return `WITH cleared AS MATERIALIZED (
      SELECT * FROM unnest($1::integer[], $2::text[], $3::text[], $4::text[]) AS c(id, source_id, slug, keys)),${remove ? `
    named AS MATERIALIZED (SELECT c.source_id, c.slug FROM cleared c
      UNION SELECT a.source_id, a.alias_slug FROM cleared c JOIN slug_aliases a ON a.source_id = c.source_id AND a.canonical_slug = c.slug AND a.notes = 'rename'
      UNION SELECT m.source_id, m.old_slug FROM cleared c JOIN slug_rename_history m ON m.source_id = c.source_id AND m.new_slug = c.slug),
    naming AS MATERIALIZED (${namingSql('named')}),
    depth_naming AS MATERIALIZED (${namingSql('(SELECT DISTINCT source_id, slug FROM naming WHERE declares)', true)}),` : ''}
    refs AS MATERIALIZED (SELECT p.id, p.source_id, p.slug, p.deleted_at, r.kind, r.ref FROM ${remove ? `(SELECT id FROM naming UNION SELECT id FROM depth_naming) k
      JOIN LATERAL (SELECT pages.id, pages.source_id, pages.slug, pages.deleted_at, pages.frontmatter FROM pages WHERE pages.id = k.id OFFSET 0) p ON true` : 'pages p'}
      CROSS JOIN LATERAL (SELECT 'source_slug' AS kind, p.frontmatter->>'source_slug' AS ref
        UNION ALL SELECT 'depth', p.frontmatter->'event'->>'depth'
        UNION ALL SELECT 'declared', regexp_replace(declared.slug, '\\.md$', '') FROM jsonb_array_elements_text(
          CASE jsonb_typeof(p.frontmatter->'derived_from') WHEN 'array' THEN p.frontmatter->'derived_from'
            WHEN 'string' THEN jsonb_build_array(p.frontmatter->'derived_from') ELSE '[]'::jsonb END) AS declared(slug)${remove ? `
        UNION ALL SELECT 'source_slug', renamed.canonical_slug FROM slug_aliases renamed WHERE renamed.source_id = p.source_id
          AND renamed.alias_slug = p.frontmatter->>'source_slug' AND renamed.notes = 'rename'
        UNION ALL SELECT 'source_slug', moved.new_slug FROM slug_rename_history moved WHERE moved.source_id = p.source_id
          AND moved.old_slug = p.frontmatter->>'source_slug'` : ''}) r
      WHERE p.source_id = ANY($2::text[]) AND r.ref IS NOT NULL),
    hits AS MATERIALIZED (SELECT r.id, r.source_id, r.slug, r.deleted_at, r.kind, c.id AS cleared_id
      FROM refs r JOIN cleared c ON c.source_id = r.source_id AND c.slug = r.ref),
    provenance AS MATERIALIZED (SELECT l.from_page_id, x.cleared_id, x.source_id
      FROM (SELECT c.id, c.id AS cleared_id, c.source_id FROM cleared c UNION ALL SELECT h.id, h.cleared_id, h.source_id FROM hits h WHERE h.kind = 'source_slug') x
      JOIN links l ON l.to_page_id = x.id WHERE l.link_source = 'concept-provenance' AND l.link_type = 'synthesized_from'),
    ties AS (SELECT h.id, h.cleared_id FROM hits h${live(' WHERE h.deleted_at IS NULL')}
      UNION ALL SELECT r.id, h.cleared_id FROM hits h JOIN refs r ON r.source_id = h.source_id AND r.kind = 'depth' AND r.ref = h.slug
        WHERE h.kind = 'declared'${live(' AND r.deleted_at IS NULL')}
      UNION ALL SELECT p.id, t.cleared_id FROM provenance t JOIN pages p ON p.id = t.from_page_id AND p.source_id = t.source_id${live(' AND p.deleted_at IS NULL')}),
    candidates AS MATERIALIZED (SELECT DISTINCT t.id, t.cleared_id FROM ties t WHERE ${remove ? 't.id <> t.cleared_id' : 'NOT EXISTS (SELECT 1 FROM cleared x WHERE x.id = t.id)'}),${remove ? `
    candidate_rows AS MATERIALIZED (SELECT a.id, a.source_id, a.slug, a.type, a.frontmatter FROM (SELECT DISTINCT id FROM candidates) k
      JOIN LATERAL (SELECT pages.id, pages.source_id, pages.slug, pages.type, pages.frontmatter FROM pages WHERE pages.id = k.id OFFSET 0) a ON true),` : ''}
    public_after AS MATERIALIZED (WITH pages AS NOT MATERIALIZED (${remove ? `SELECT pg.id, pg.source_id, pg.slug, pg.type, pg.deleted_at, pg.frontmatter
        FROM pages pg WHERE pg.id <> ALL($1::integer[])` : `SELECT pg.id, pg.source_id, pg.slug, pg.type, pg.deleted_at,
          CASE WHEN c.id IS NULL THEN pg.frontmatter ELSE pg.frontmatter - string_to_array(c.keys, ',') END AS frontmatter
        FROM pages pg LEFT JOIN cleared c ON c.id = pg.id`})
      SELECT after_clear.id FROM (${remove ? 'SELECT * FROM candidate_rows' : `SELECT a.id, a.source_id, a.slug, a.type, a.frontmatter FROM (SELECT DISTINCT id FROM candidates) k
        JOIN pages a ON a.id = k.id`} OFFSET 0) after_clear WHERE ${privacyPartSql('after_clear', true)})
    SELECT cand.id, cand.cleared_id, CASE WHEN p.type = 'event' AND p.frontmatter->>'captured_via' LIKE 'life-chronicle:%' THEN 'life_chronicle'
        WHEN p.type = 'atom' THEN 'atom' WHEN p.type = 'concept' AND p.frontmatter->>'synthesized_by' IS NOT NULL THEN 'concept' ELSE 'derived_from' END AS category
      FROM candidates cand JOIN ${remove ? 'candidate_rows' : 'pages'} p ON p.id = cand.id
      WHERE cand.id IN (SELECT id FROM public_after) AND NOT ${privacyPartSql('p')}
      ORDER BY cand.id, cand.cleared_id`;
}
