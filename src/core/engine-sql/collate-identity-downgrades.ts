/**
 * Statements `recordIdentityDowngrades` (sync-identity-downgrades.ts) ran through `engine.executeRaw`, now typed members so
 * a Rust brain answers them from its store (rust/docs/store/collate-identity-downgrades.md): the soft-deleted page a
 * renamed file once backed, the live pages at the new file's path, what a carry would move, and the checkpoint row that
 * keeps the record. The statements are the ones the caller ran; the live-pages-at-path read orders its slugs by byte
 * (`COLLATE "C"`), as the page-origin guard's own read of the same pages would on a byte-ordered brain.
 */

/** The engine's `executeRaw` (bound). */
export type IdentityDowngradeRaw = <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<R[]>;

/** A soft-deleted page; `deleted_at` is the column's `::text` form. */
export interface SoftDeletedPageRow { id: number; slug: string; deleted_at: string }

/** The statement sync-identity-downgrades.ts ran for the old page: the latest deletion first, the lowest page id among equals. */
export const SOFT_DELETED_PAGE_AT_ORIGIN_SQL = `SELECT id, slug, deleted_at::text AS deleted_at FROM pages WHERE source_id = $1 AND deleted_at IS NOT NULL
        AND (source_path = $2 OR (source_path IS NULL AND slug = $3)) ORDER BY deleted_at DESC, id LIMIT 1`;

/** The soft-deleted page of a source whose origin is `path`, or whose slug is `slug` when it has no origin. */
export async function readSoftDeletedPageAtOrigin(raw: IdentityDowngradeRaw, sourceId: string, path: string, slug: string): Promise<SoftDeletedPageRow | null> {
  const [row] = await raw<{ id: number | string; slug: string; deleted_at: string }>(SOFT_DELETED_PAGE_AT_ORIGIN_SQL, [sourceId, path, slug]);
  return row ? { id: Number(row.id), slug: row.slug, deleted_at: row.deleted_at } : null;
}

/** A live page at a file path. */
export interface LivePageAtOriginRow { id: number; slug: string }

/** The live pages a file path backs (the page-origin guard's `canonicalOriginPage` read), by slug bytes. */
export const LIVE_PAGES_AT_ORIGIN_SQL = `SELECT id, slug FROM pages WHERE source_id = $1 AND source_path = $2 AND deleted_at IS NULL ORDER BY slug COLLATE "C"`;

/** The live pages of a source whose origin is `sourcePath`, by slug. */
export async function listLivePagesAtOrigin(raw: IdentityDowngradeRaw, sourceId: string, sourcePath: string): Promise<LivePageAtOriginRow[]> {
  const rows = await raw<{ id: number | string; slug: string }>(LIVE_PAGES_AT_ORIGIN_SQL, [sourceId, sourcePath]);
  return rows.map(r => ({ id: Number(r.id), slug: r.slug }));
}

/** What a carry would move off a page. */
export interface PageCarryCounts { facts: number; links: number; aliases: number }

/** The statement sync-identity-downgrades.ts ran for the record's counts. */
export const PAGE_CARRY_COUNTS_SQL = `SELECT
        (SELECT count(*) FROM facts WHERE source_id = $1 AND entity_slug = $2) AS facts,
        (SELECT count(*) FROM links WHERE from_page_id = $3 OR to_page_id = $3) AS links,
        (SELECT count(*) FROM page_aliases WHERE source_id = $1 AND slug = $2) AS aliases`;

/** The facts about a slug, the links of a page and the aliases of a slug. */
export async function countPageCarryRows(raw: IdentityDowngradeRaw, sourceId: string, slug: string, pageId: number): Promise<PageCarryCounts> {
  const [row] = await raw<{ facts: number | string; links: number | string; aliases: number | string }>(PAGE_CARRY_COUNTS_SQL, [sourceId, slug, pageId]);
  return { facts: Number(row?.facts ?? 0), links: Number(row?.links ?? 0), aliases: Number(row?.aliases ?? 0) };
}

/** The statement sync-identity-downgrades.ts ran to keep its record: the parent row's `completed_keys` is the JSON array. */
export const OP_CHECKPOINT_VALUES_SQL = `INSERT INTO op_checkpoints (op, fingerprint, completed_keys, updated_at) VALUES ($1, $2, $3::text::jsonb, now())
      ON CONFLICT (op, fingerprint) DO UPDATE SET completed_keys = EXCLUDED.completed_keys, updated_at = now()`;

/** Replaces a checkpoint's `completed_keys` with the JSON array `values` (the row is created when missing). */
export async function writeOpCheckpointValues(raw: IdentityDowngradeRaw, op: string, fingerprint: string, values: readonly unknown[]): Promise<void> {
  await raw(OP_CHECKPOINT_VALUES_SQL, [op, fingerprint, JSON.stringify(values)]);
}

/** The statement the phantom-redirect rotation read ran: a checkpoint's `completed_keys`. */
export const OP_CHECKPOINT_VALUES_READ_SQL = `SELECT completed_keys FROM op_checkpoints WHERE op = $1 AND fingerprint = $2`;

/** A checkpoint's `completed_keys` as stored, or null when there is no row. */
export async function readOpCheckpointValues(raw: IdentityDowngradeRaw, op: string, fingerprint: string): Promise<unknown[] | null> {
  const [row] = await raw<{ completed_keys: unknown }>(OP_CHECKPOINT_VALUES_READ_SQL, [op, fingerprint]);
  if (!row) return null;
  const value = typeof row.completed_keys === 'string' ? JSON.parse(row.completed_keys) : row.completed_keys;
  return Array.isArray(value) ? value : null;
}
