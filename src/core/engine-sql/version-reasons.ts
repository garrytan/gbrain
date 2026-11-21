/**
 * Page version change reasons: the statements a write that gives a reason ran through `executeRaw` to stamp
 * `page_versions.change_reason` on the snapshots it archived (persistence/change-reason.ts withChangeReason and
 * persistence/file-repair.ts's adopted-edit reason). SQL once for both engines, so a store that is not SQL serves the
 * same members (rust/docs/store/pages.md).
 *
 * - `readLatestVersionId`: the page's newest version id before the write runs.
 * - `stampVersionChangeReason`: the reason on every version the write added after that id.
 * - `readLatestVersionIdAtTier`: the page's newest version stamped with a tier, which a page-lowering proposal names
 *   as the edit its revert restores (trust/page-write.ts).
 *
 * - `listVersionsByChangeReason` / `replaceVersionChangeReasons`: `gbrain repair purged-change-reasons` lists the
 *   source's versions that still hold a purged reason text, and its apply replaces each approved one only while it
 *   holds the text the apply found (rust/crates/gbrain-store/src/repair_versions.rs).
 *
 * - `readArchivedVersionBody`: `gbrain repair accepted-takes` reads the newest version a request archived.
 * - `listRetainedVersionBodies`: `gbrain repair redacted-facts` reads a page's newest retained inline bodies.
 *
 * The purge's own bulk rewrite of stored reasons (facts/purge.ts) stays raw SQL: it matches a needle across a whole
 * source, not an approved id list. A Rust brain refuses that rewrite, so a purge there stops on the typed refusal
 * rather than leave a reason unredacted.
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** The page's newest version id (`max(page_versions.id)`), or null when it keeps no version. */
export async function readLatestVersionId(tx: Raw, pageId: number): Promise<number | null> {
  const [r] = await tx.executeRaw<{ last: number | string | null }>('SELECT max(id) AS last FROM page_versions WHERE page_id = $1', [pageId]);
  return r?.last == null ? null : Number(r.last);
}

/** The page's newest version whose snapshot tier is `tier` (trust/page-write.ts: the edit a page-lowering proposal
 * reverts to), or null when none was stamped with it. */
export async function readLatestVersionIdAtTier(tx: Raw, pageId: number, tier: string): Promise<number | null> {
  const [r] = await tx.executeRaw<{ id: number | string }>(
    'SELECT id FROM page_versions WHERE page_id = $1 AND trust_tier = $2 ORDER BY id DESC LIMIT 1', [pageId, tier]);
  return r ? Number(r.id) : null;
}

/** Sets the reason on the page's versions with an id over `afterVersionId`; answers how many took it. */
export async function stampVersionChangeReason(tx: Raw, spec: { pageId: number; afterVersionId: number; reason: string }): Promise<number> {
  const stamped = await tx.executeRaw<{ id: number }>(
    'UPDATE page_versions SET change_reason = $2 WHERE page_id = $1 AND id > $3 RETURNING id', [spec.pageId, spec.reason, spec.afterVersionId]);
  return stamped.length;
}

/** One version of a source's page whose stored change reason is one of the listed texts. */
export interface VersionReasonRow { id: number; slug: string; source_path: string | null; reason: string }

/** The versions of `sourceId`'s pages (live or deleted) whose change reason is one of `reasons`, by version id. */
export async function listVersionsByChangeReason(tx: Raw, sourceId: string, reasons: readonly string[]): Promise<VersionReasonRow[]> {
  const rows = await tx.executeRaw<{ id: number | string; slug: string; source_path: string | null; reason: string }>(
    `SELECT v.id, p.slug, v.source_path, v.change_reason AS reason FROM page_versions v JOIN pages p ON p.id = v.page_id
      WHERE p.source_id = $1 AND v.change_reason = ANY($2::text[]) ORDER BY v.id`, [sourceId, [...reasons]]);
  return rows.map(row => ({ ...row, id: Number(row.id) }));
}

/**
 * Sets `replacement` on each named version of `sourceId`'s pages only while it holds the reason it is named with;
 * answers the ids that took it, by id.
 */
export async function replaceVersionChangeReasons(tx: Raw, sourceId: string, rows: ReadonlyArray<{ id: number; reason: string }>, replacement: string): Promise<number[]> {
  if (!rows.length) return [];
  const set = await tx.executeRaw<{ id: number | string }>(
    `UPDATE page_versions v SET change_reason = $1 FROM pages p, unnest($3::bigint[], $4::text[]) AS t(id, reason)
      WHERE p.id = v.page_id AND p.source_id = $2 AND v.id = t.id AND v.change_reason = t.reason RETURNING v.id`,
    [replacement, sourceId, rows.map(row => row.id), rows.map(row => row.reason)]);
  return set.map(row => Number(row.id)).sort((a, b) => a - b);
}

/** The page's versions whose body is stored inline (a segmented snapshot keeps no copy), newest first, at most `limit`. */
export async function listRetainedVersionBodies(tx: Raw, pageId: number, limit: number): Promise<Array<{ id: number; compiled_truth: string }>> {
  const rows = await tx.executeRaw<{ id: number | string; compiled_truth: string }>(`SELECT id, compiled_truth FROM page_versions
    WHERE page_id=$1 AND compiled_truth IS NOT NULL ORDER BY id DESC LIMIT $2`, [pageId, limit]);
  return rows.map(row => ({ id: Number(row.id), compiled_truth: row.compiled_truth }));
}

/** The newest version of page `pageId` that request `receiptId` archived, or null. */
export async function readArchivedVersionBody(tx: Raw, pageId: number, receiptId: string): Promise<{ id: number; body_storage: string | null; compiled_truth: string | null; timeline: string | null } | null> {
  const [row] = await tx.executeRaw<{ id: number; body_storage: string | null; compiled_truth: string | null; timeline: string | null }>(
    `SELECT id::int AS id, body_storage, compiled_truth, timeline FROM page_versions
      WHERE page_id = $1 AND archived_write_request_id::text = $2 ORDER BY id DESC LIMIT 1`, [pageId, receiptId]);
  return row ?? null;
}
