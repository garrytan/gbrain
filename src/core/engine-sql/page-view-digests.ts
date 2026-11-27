/**
 * The cache of a segmented page's read views: one row per (page, revision, view, audience) holding the view's byte
 * and line totals and, for the markdown view, its SHA-256 (page-window/segmented.ts `readDigest`, `writeDigest`).
 * The statements are the call sites' text, byte for byte, so PGLite and Postgres run what they ran. The cache is
 * only an optimisation: a miss recomputes the digest from the stored segments. A store that keeps no such cache
 * serves the same members as a permanent miss and a write that stores nothing
 * (src/core/rust-engine/store-members/page-view-digests.ts).
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** What identifies one cached view: the page, the revision it was computed at, the view and who it was rendered for. */
export interface PageViewDigestKey {
  pageId: number;
  revision: string;
  view: 'read' | 'markdown';
  audience: string;
}

/** A cached view's totals; `sha256` is null for the read view, which is cached only for its line count. */
export interface PageViewDigest {
  total_bytes: number;
  total_lines: number;
  sha256: string | null;
}

/** The cached digest of one view, or null when none is stored. */
export async function readPageViewDigest(raw: Raw, key: PageViewDigestKey): Promise<PageViewDigest | null> {
  const [row] = await raw.executeRaw<{ total_bytes: unknown; total_lines: unknown; sha256: string | null }>(
    `SELECT total_bytes, total_lines, sha256 FROM page_view_digests WHERE page_id=$1 AND revision=$2 AND view=$3 AND audience=$4`,
    [key.pageId, key.revision, key.view, key.audience]);
  return row ? { total_bytes: Number(row.total_bytes), total_lines: Number(row.total_lines), sha256: row.sha256 } : null;
}

/** Stores the digest of one view and drops the page's rows of every other revision. */
export async function writePageViewDigest(raw: Raw, key: PageViewDigestKey, digest: PageViewDigest): Promise<void> {
  await raw.executeRaw('DELETE FROM page_view_digests WHERE page_id=$1 AND revision<>$2', [key.pageId, key.revision]);
  await raw.executeRaw(`INSERT INTO page_view_digests (page_id, revision, view, audience, total_bytes, total_lines, sha256) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (page_id, revision, view, audience) DO UPDATE SET total_bytes=EXCLUDED.total_bytes, total_lines=EXCLUDED.total_lines, sha256=EXCLUDED.sha256, created_at=now()`,
  [key.pageId, key.revision, key.view, key.audience, digest.total_bytes, digest.total_lines, digest.sha256]);
}
