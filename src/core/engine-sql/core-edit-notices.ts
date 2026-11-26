/**
 * The core edit notice table (`core_edit_notices`): the rows a remote edit of a core page leaves for its owner to
 * review (core-guard.ts `record`), and the three statements `gbrain core diff`, `core ack` and `core remove` made
 * through `executeRaw`. SQL once for both engines, so a store that is not SQL serves the same members
 * (rust/docs/store/core-edit-notices.md). The pending list (`listPendingCoreEditNotices`) is in trust-tier-reads.ts
 * and the purge blank (`blankPurgeCoreEditNotices`) in facts-purge.ts.
 *
 * - `insertCoreEditNotice`: records one notice, unacknowledged, stamped now.
 * - `readOldestPendingCoreEditNotice`: the first pending notice of a page (the base text `core diff` compares to).
 * - `findCoreEditNoticeIdByRevision`: the newest notice of a page for a revision token, acknowledged or not.
 * - `ackCoreEditNotices`: closes a page's pending notices (up to a ceiling id when given); how many.
 *
 * Ids come back as numbers; `created_at` comes back as the `timestamptz::text` form.
 */

import type { BrainEngine } from '../engine.ts';
import { renderFragment, sqlFragment } from './fragment.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** One notice to record: the page, the revision the edit wrote, the revision and rendered text before it, and who edited. */
export interface CoreEditNoticeInput {
  sourceId: string;
  slug: string;
  pageId: number | null;
  revision: string | null;
  baseRevision: string | null;
  baseText: string | null;
  actor: string;
}

/** The oldest pending notice of a page, as `core diff` reads it. */
export interface PendingCoreEditNotice { base_text: string | null; actor: string; created_at: string }

/** Records one unacknowledged notice (`created_at` is the database clock) and answers its id. Writes core_edit_notices; run it in the edit's transaction. */
export async function insertCoreEditNotice(tx: Raw, row: CoreEditNoticeInput): Promise<{ id: number }> {
  const [made] = await tx.executeRaw<{ id: string | number }>(`INSERT INTO core_edit_notices (source_id, slug, page_id, revision, base_revision, base_text, actor) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [row.sourceId, row.slug, row.pageId, row.revision, row.baseRevision, row.baseText, row.actor]);
  return { id: Number(made!.id) };
}

/** The pending notice with the lowest id for the page, or null. */
export async function readOldestPendingCoreEditNotice(tx: Raw, sourceId: string, slug: string): Promise<PendingCoreEditNotice | null> {
  const [row] = await tx.executeRaw<PendingCoreEditNotice>(
    `SELECT base_text, actor, created_at::text AS created_at FROM core_edit_notices WHERE source_id = $1 AND slug = $2 AND acked_at IS NULL ORDER BY id LIMIT 1`, [sourceId, slug]);
  return row ?? null;
}

/** The highest id among the page's notices (pending or acknowledged) that name the revision, or null. */
export async function findCoreEditNoticeIdByRevision(tx: Raw, sourceId: string, slug: string, revision: string): Promise<number | null> {
  const [row] = await tx.executeRaw<{ id: number | string }>(
    'SELECT id FROM core_edit_notices WHERE source_id = $1 AND slug = $2 AND revision = $3 ORDER BY id DESC LIMIT 1', [sourceId, slug, revision]);
  return row ? Number(row.id) : null;
}

/** Acknowledges the page's pending notices (those with id <= `maxId` when it is not null); how many. Writes core_edit_notices. */
export async function ackCoreEditNotices(tx: Raw, sourceId: string, slug: string, maxId: number | null): Promise<number> {
  const upTo = maxId === null ? sqlFragment`` : sqlFragment` AND id <= ${maxId}`;
  const { text, params } = renderFragment(sqlFragment`WITH a AS (UPDATE core_edit_notices SET acked_at = now() WHERE source_id = ${sourceId} AND slug = ${slug} AND acked_at IS NULL${upTo} RETURNING 1) SELECT count(*)::int AS n FROM a`);
  const rows = await tx.executeRaw<{ n: number }>(text, params);
  return rows[0]?.n ?? 0;
}
