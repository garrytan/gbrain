/**
 * Doctor reads: the statements `gbrain doctor` checks ran through `executeRaw`, each with the same text and parameters,
 * on the engine's own `executeRaw`; only their home moved (src/commands/doctor/**). The Rust engine answers the same
 * members from its store records (rust/crates/gbrain-store/src/cli_reads/doctor.rs, rust/docs/store/cli-reads-doctor.md).
 */
import type { EngineRawRead } from './cli-reads-ops.ts';

export type { EngineRawRead } from './cli-reads-ops.ts';

/**
 * The members of this file. Each replaced a statement doctor ran through its deadline-bound executeRaw, so
 * src/core/statement-deadline.ts keeps that bound on them (BOUNDED_TYPED_READS).
 */
export const DOCTOR_READ_MEMBERS: readonly string[] = ['countPageChildOrphans'];

/**
 * A page-child relation as `<table>.<column>`: every `PAGE_CHILD_FK_TARGETS` entry of src/core/repair/orphan-children.ts
 * except `content_chunks.page_id` (that one is `countOrphanChunks`).
 */
export type PageChildTarget =
  | 'page_versions.page_id' | 'tags.page_id' | 'takes.page_id' | 'raw_data.page_id' | 'timeline_entries.page_id'
  | 'links.from_page_id' | 'links.to_page_id' | 'links.origin_page_id' | 'files.page_id';

/**
 * One constant statement per target, the text doctor's child_table_orphans built from `orphanPredicate` (pinned against
 * it by test/doctor-reads-sql.test.ts), so no table or column name is spliced into SQL.
 */
const PAGE_CHILD_ORPHAN_SQL: Readonly<Record<PageChildTarget, string>> = {
  'page_versions.page_id': 'SELECT COUNT(*)::int AS n FROM page_versions WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = page_versions.page_id)',
  'tags.page_id': 'SELECT COUNT(*)::int AS n FROM tags WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = tags.page_id)',
  'takes.page_id': 'SELECT COUNT(*)::int AS n FROM takes WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = takes.page_id)',
  'raw_data.page_id': 'SELECT COUNT(*)::int AS n FROM raw_data WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = raw_data.page_id)',
  'timeline_entries.page_id': 'SELECT COUNT(*)::int AS n FROM timeline_entries WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = timeline_entries.page_id)',
  'links.from_page_id': 'SELECT COUNT(*)::int AS n FROM links WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = links.from_page_id)',
  'links.to_page_id': 'SELECT COUNT(*)::int AS n FROM links WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = links.to_page_id)',
  'links.origin_page_id': 'SELECT COUNT(*)::int AS n FROM links WHERE links.origin_page_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = links.origin_page_id)',
  'files.page_id': 'SELECT COUNT(*)::int AS n FROM files WHERE files.page_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = files.page_id)',
};

/** The statement for each target, for the test that pins it to `orphanPredicate`. */
export function pageChildOrphanSql(target: PageChildTarget): string {
  const sql = PAGE_CHILD_ORPHAN_SQL[target];
  if (!sql) throw new Error(`countPageChildOrphans: '${String(target)}' is not a page child target`);
  return sql;
}

/** Rows of a page-child relation whose page row is gone (a NULL reference of a SET NULL column is not one). */
export async function countPageChildOrphans(raw: EngineRawRead, target: PageChildTarget): Promise<number> {
  const [row] = await raw<{ n: string | number }>(pageChildOrphanSql(target));
  return Number(row?.n ?? 0);
}
