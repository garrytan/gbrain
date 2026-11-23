/**
 * The page rows commands/access.ts whoCanRead read through executeRaw, as a typed member: PGLite and Postgres send the
 * same statement as before, and a Rust brain answers from its page records (rust/docs/store/page_ops.md). The statement
 * carries the owner-only test in the form the brain's schema version names (access/owner-only.ts ownerOnlyPageSql);
 * each form's text is written out here, pinned against ownerOnlyPageSql by test/engine-sql-caller-raw-sql-pins.test.ts.
 */
import type { BrainEngine } from '../engine.ts';
import type { OwnerOnlyForm } from '../access/owner-only.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** What who-can-read reads of a page: its type, frontmatter, the folder rules stamped on it, and whether it is owner-only. */
export interface PageAccessRow {
  slug: string;
  source_id: string;
  type: string | null;
  frontmatter: unknown;
  folder_rule_ids: string[] | null;
  owner_only: boolean;
}

const HEAD = 'SELECT p.slug, p.source_id, p.type, p.frontmatter, p.folder_rule_ids,';
const TAIL_ANY = `
       FROM pages p WHERE p.slug = $1 ORDER BY p.source_id COLLATE "C"`;
const TAIL_ONE = `
       FROM pages p WHERE p.slug = $1 AND p.source_id = $2 ORDER BY p.source_id COLLATE "C"`;
const OWNER_ONLY = {
  closed: `(EXISTS (SELECT 1 FROM sources read_source WHERE read_source.id >= '' AND (read_source.config->>'kind' IN ('imessage') OR read_source.config->>'owner_only' = 'true')) OR EXISTS (SELECT 1 FROM pg_catalog.pg_description held
  WHERE held.objoid = pg_catalog.to_regclass('public.owner_only_marks') AND held.classoid = 'pg_catalog.pg_class'::pg_catalog.regclass
    AND held.objsubid = 0 AND held.description = 'gbrain:owner_only_held (GST-3032): this brain has held owner-only data, so owner-only lineage stays guarded'))`,
  fn: `((SELECT gbrain_owner_only_lineage()) AND gbrain_owner_only_lineage('pages', p.id))`,
  mode: `((SELECT gbrain_owner_only_lineage()) AND gbrain_owner_only_lineage('pages', p.id, (SELECT gbrain_owner_only_read_mode())))`,
} as const;

/** The statements commands/access.ts whoCanRead ran: every source's page of the slug, or the one in a source, per owner-only form. */
export const PAGE_ACCESS_ROWS_SQL = {
  closed_any: `${HEAD} ${OWNER_ONLY.closed} AS owner_only${TAIL_ANY}`,
  closed_one: `${HEAD} ${OWNER_ONLY.closed} AS owner_only${TAIL_ONE}`,
  fn_any: `${HEAD} ${OWNER_ONLY.fn} AS owner_only${TAIL_ANY}`,
  fn_one: `${HEAD} ${OWNER_ONLY.fn} AS owner_only${TAIL_ONE}`,
  mode_any: `${HEAD} ${OWNER_ONLY.mode} AS owner_only${TAIL_ANY}`,
  mode_one: `${HEAD} ${OWNER_ONLY.mode} AS owner_only${TAIL_ONE}`,
} as const;

/** The page rows named `slug` (soft-deleted ones too), in one source when `sourceId` is given, else in every source by byte of source id. */
export function readPageAccessRows(raw: Raw, slug: string, sourceId: string | undefined, form: OwnerOnlyForm): Promise<PageAccessRow[]> {
  if (form === 'closed') return sourceId ? raw.executeRaw<PageAccessRow>(PAGE_ACCESS_ROWS_SQL.closed_one, [slug, sourceId]) : raw.executeRaw<PageAccessRow>(PAGE_ACCESS_ROWS_SQL.closed_any, [slug]);
  if (form === 'fn') return sourceId ? raw.executeRaw<PageAccessRow>(PAGE_ACCESS_ROWS_SQL.fn_one, [slug, sourceId]) : raw.executeRaw<PageAccessRow>(PAGE_ACCESS_ROWS_SQL.fn_any, [slug]);
  return sourceId ? raw.executeRaw<PageAccessRow>(PAGE_ACCESS_ROWS_SQL.mode_one, [slug, sourceId]) : raw.executeRaw<PageAccessRow>(PAGE_ACCESS_ROWS_SQL.mode_any, [slug]);
}
