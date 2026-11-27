import type { SqlEngine } from '../persistence/model.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { stableJson } from '../persistence/digest.ts';
import type { BrainEngine } from '../engine.ts';

/**
 * gbrain#4148: consecutive same-content failures of a content-deterministic
 * class (malformed model output or provider content block) before the page is tombstoned so the
 * backlog floor can clear. A content edit resets the streak. #6325: a managed
 * page or transcript settles held_failed at the same bound.
 */
export const MAX_DETERMINISTIC_FAILURES = 3;

export interface AtomPageIdentity {
  pageId: number;
  sourceIncarnation: string;
  revision: string;
}

export interface AtomPageInput {
  slug: string;
  content: string;
  contentHash: string;
  identity?: AtomPageIdentity;
}

export class AtomPageStateError extends Error {
  constructor(reason: 'changed' | 'unpinned' | 'schema' | 'denied' | 'storage') {
    super({
      changed: 'atom page changed during extraction; scan state was not saved and the page remains retryable',
      unpinned: 'atom page state was not pinned before extraction; page remains retryable',
      schema: 'atom page scan state is unavailable (42P01); check schema migrations. The page remains retryable',
      denied: 'atom page scan state write was denied (42501); check database permissions. The page remains retryable',
      storage: 'atom page scan state could not be saved; check database access and schema migrations. The page remains retryable',
    }[reason]);
    this.name = 'AtomPageStateError';
  }
}

export async function readAtomPageIdentity(engine: SqlEngine, sourceId: string, item: AtomPageInput): Promise<AtomPageIdentity | undefined> {
  const [row] = await engine.executeRaw<{ id: number; incarnation: string; knowledge_revision: string }>(
    `SELECT p.id, s.incarnation, p.knowledge_revision FROM pages p JOIN sources s ON s.id=p.source_id
      WHERE p.source_id=$1 AND p.slug=$2 AND p.content_hash=$3 AND p.deleted_at IS NULL`,
    [sourceId, item.slug, item.contentHash]);
  return row && { pageId: row.id, sourceIncarnation: row.incarnation, revision: row.knowledge_revision };
}

/**
 * Record a scan of the page's current content. `inputSha256` (a successful complete scan only) is the digest of the
 * model input it read (atomInputDigest); a later content hash whose input digests the same reuses its atoms
 * (reusableAtomScan). GST-4020: a failure clears the row's completion, so a page offered again on content it had
 * completed (a newer world withdrawal, a revert) stays retryable instead of reading as done.
 */
export async function writeAtomPageState(
  engine: SqlEngine, sourceId: string, item: AtomPageInput, outcome: 'complete' | 'failure', inputSha256?: string,
): Promise<number> {
  if (!item.identity) throw new AtomPageStateError('unpinned');
  const { pageId, sourceIncarnation, revision } = item.identity;
  const [row] = await engine.executeRaw<{ fail_count: number }>(
    `INSERT INTO extract_atoms_page_state (source_incarnation, page_id, content_hash, fail_count, tombstoned, input_sha256)
      SELECT s.incarnation, p.id, p.content_hash, $7::integer, $8::boolean, $9::text
      FROM pages p JOIN sources s ON s.id=p.source_id
      WHERE p.id=$1 AND s.incarnation=$2::uuid AND p.source_id=$3 AND p.slug=$4
        AND p.content_hash=$5 AND p.knowledge_revision=$6::uuid AND p.deleted_at IS NULL
      FOR SHARE OF p, s
      ON CONFLICT (source_incarnation, page_id, content_hash) DO UPDATE
        SET fail_count=extract_atoms_page_state.fail_count + EXCLUDED.fail_count,
            tombstoned=EXCLUDED.tombstoned, input_sha256=EXCLUDED.input_sha256, updated_at=now()
      RETURNING fail_count`,
    [pageId, sourceIncarnation, sourceId, item.slug, item.contentHash, revision,
      outcome === 'failure' ? 1 : 0, outcome === 'complete', outcome === 'complete' ? inputSha256 ?? null : null]).catch((error: unknown) => {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    throw new AtomPageStateError(code === '42P01' ? 'schema' : code === '42501' ? 'denied' : 'storage');
  });
  if (!row) throw new AtomPageStateError('changed');
  return Number(row.fail_count);
}

/**
 * GST-4020 (#10435): the atoms an unmanaged page's earlier extraction left, when they are exactly what extracting its
 * current content would produce, so the page needs no model call; null otherwise. That holds when the page's newest
 * scan is a complete read (not partial, not a failure tombstone) of the same model input (`inputSha256`, the digest
 * stored with the scan; a scan written before digests existed never matches), and every atom it left still fits the
 * page as it stands: none is pending, none carries another date, none is world while the page is now private, no
 * extractor atom still names a slug the page was renamed from, and every atom the page links to as its provenance is
 * one of its own (a transcript's atom, or one bound to another page, is not). A page that fails any of these is
 * extracted again.
 */
export async function reusableAtomScan(engine: SqlEngine, sourceId: string, item: AtomPageInput, inputSha256: string,
  page: { visibility: string; date: string | null }): Promise<string[] | null> {
  if (!item.identity) return null;
  const [scan] = await engine.executeRaw<{ content_hash: string; tombstoned: boolean; fail_count: number; partial_input_chars: number | null;
    input_sha256: string | null; withdrawn_since: boolean }>(
    `SELECT scan.content_hash, scan.tombstoned, scan.fail_count, scan.partial_input_chars, scan.input_sha256,
       EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id=$3 AND w.visibility='world' AND w.subject IN ('*', $4)
         AND w.withdrawn_at > scan.updated_at) AS withdrawn_since
      FROM extract_atoms_page_state scan
      WHERE scan.source_incarnation=$1::uuid AND scan.page_id=$2 ORDER BY scan.updated_at DESC LIMIT 1`,
    [item.identity.sourceIncarnation, item.identity.pageId, sourceId, item.slug]);
  // The same content offered again with nothing withdrawn since its scan is an explicit re-run: it extracts as before.
  if (!scan?.tombstoned || scan.partial_input_chars !== null || Number(scan.fail_count) >= MAX_DETERMINISTIC_FAILURES
    || scan.input_sha256 !== inputSha256 || (scan.content_hash === item.contentHash && !scan.withdrawn_since)) return null;
  const atoms = await engine.executeRaw<{ slug: string; source_slug: string; visibility: string | null; date: string | null; source_hash: string | null }>(
    `SELECT a.slug, a.frontmatter->>'source_slug' AS source_slug, a.frontmatter->>'visibility' AS visibility,
       a.frontmatter->>'date' AS date, a.frontmatter->>'source_hash' AS source_hash
      FROM pages a
      WHERE a.source_id=$1 AND a.type='atom' AND a.deleted_at IS NULL
        AND COALESCE(a.frontmatter->>'managed_extraction', '') <> 'true'
        AND (a.frontmatter->>'source_slug' = ANY(ARRAY[$2::text] || ARRAY(${renamedFromSql}))
          OR a.id IN (SELECT l.to_page_id FROM links l WHERE l.from_page_id=$3 AND l.link_source='atom-provenance'))`,
    [sourceId, item.slug, item.identity.pageId]);
  const scanned = scan.content_hash.slice(0, 16), current = item.contentHash.slice(0, 16);
  const fits = atoms.every(atom => atom.source_slug === item.slug && (atom.source_hash === scanned || atom.source_hash === current)
    && (atom.date ?? '').slice(0, 10) === (page.date ?? '').slice(0, 10) && !(page.visibility === 'private' && atom.visibility !== 'private'));
  return fits ? atoms.map(atom => atom.slug) : null;
}

/** SQL (params $1 source id, $2 slug): every slug a rename moved the page now at $2 away from. */
const renamedFromSql = `SELECT alias_slug FROM slug_aliases WHERE source_id=$1 AND canonical_slug=$2 AND notes='rename'
  UNION SELECT old_slug FROM slug_rename_history WHERE source_id=$1 AND new_slug=$2`;

/** GST-4020: move reused atoms onto the page's current content hash, as a completed generation does (atoms adapter completeItems). */
export async function moveReusedAtoms(engine: SqlEngine, sourceId: string, slugs: readonly string[], contentHash: string): Promise<void> {
  if (!slugs.length) return;
  await engine.executeRaw(`UPDATE pages SET frontmatter = frontmatter || jsonb_build_object('source_hash', $1::text)
    WHERE source_id=$2 AND type='atom' AND slug = ANY($3::text[]) AND deleted_at IS NULL`, [contentHash.slice(0, 16), sourceId, [...slugs]]);
}

/**
 * GST-4020: the live extractor atoms of an unmanaged page that still name a slug the page was renamed from. Their
 * origin is this page, so a re-extraction of it supersedes them; left live they keep the visibility of the page as it
 * was before the rename.
 */
export async function renamedOriginAtoms(engine: SqlEngine, sourceId: string, slug: string): Promise<string[]> {
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT a.slug FROM pages a
      WHERE a.source_id=$1 AND a.type='atom' AND a.deleted_at IS NULL
        AND COALESCE(a.frontmatter->>'managed_extraction', '') <> 'true'
        AND COALESCE(a.frontmatter->>'extracted_by', '') LIKE 'extract\\_atoms%'
        AND a.frontmatter->>'source_slug' = ANY(ARRAY(${renamedFromSql}))`,
    [sourceId, slug]);
  return rows.map(row => row.slug);
}

const LEGACY_KEYS = ['atoms_scan_hash', 'atoms_fail_hash', 'atoms_fail_count'];

export function matchingLegacyAtomPageState(frontmatter: Record<string, unknown>, contentHash: string): { fail_count: number; tombstoned: boolean } | null {
  if (!/^[0-9a-f]{64}$/.test(contentHash)) return null;
  const hash = contentHash.slice(0, 16);
  const hasFailure = LEGACY_KEYS.slice(1).some(key => Object.hasOwn(frontmatter, key));
  const count = frontmatter.atoms_fail_count;
  if (hasFailure && (frontmatter.atoms_fail_hash !== hash || typeof count !== 'number'
    || !Number.isInteger(count) || count < 1 || count > 2147483647)) return null;
  if (Object.hasOwn(frontmatter, 'atoms_scan_hash') && frontmatter.atoms_scan_hash !== hash) return null;
  const tombstoned = frontmatter.atoms_scan_hash === hash;
  return tombstoned || hasFailure ? { fail_count: hasFailure ? count as number : 0, tombstoned } : null;
}

export async function transferLegacyAtomPageState(engine: SqlEngine, before: PageSnapshot, after: PageSnapshot): Promise<boolean> {
  if (before.page.id !== after.page.id || before.sourceIncarnation !== after.sourceIncarnation
    || !before.page.content_hash || !after.page.content_hash || before.page.deleted_at || after.page.deleted_at) return false;
  const canonical = (snapshot: PageSnapshot) => {
    const frontmatter = { ...snapshot.page.frontmatter };
    for (const key of LEGACY_KEYS) delete frontmatter[key];
    return { sourceId: snapshot.page.source_id, slug: snapshot.page.slug, type: snapshot.page.type,
      title: snapshot.page.title, body: snapshot.page.compiled_truth,
      timeline: snapshot.page.timeline, frontmatter, tags: [...snapshot.tags].sort(), withdrawals: snapshot.withdrawals,
      global_purges: snapshot.globalPurges ?? null };
  };
  if (stableJson(canonical(before)) !== stableJson(canonical(after))) return false;
  const [existing] = await engine.executeRaw<{ fail_count: number; tombstoned: boolean }>(
    `SELECT fail_count, tombstoned FROM extract_atoms_page_state
      WHERE source_incarnation=$1::uuid AND page_id=$2 AND content_hash=$3`,
    [before.sourceIncarnation, before.page.id, before.page.content_hash]);
  const state = existing ?? matchingLegacyAtomPageState(before.page.frontmatter, before.page.content_hash);
  if (!state) return false;
  const rows = await engine.executeRaw(
    `INSERT INTO extract_atoms_page_state (source_incarnation, page_id, content_hash, fail_count, tombstoned)
      SELECT s.incarnation, p.id, p.content_hash, $5::integer, $6::boolean
      FROM pages p JOIN sources s ON s.id=p.source_id
      WHERE p.id=$1 AND s.incarnation=$2::uuid AND p.content_hash=$3 AND p.knowledge_revision=$4::uuid AND p.deleted_at IS NULL
      FOR SHARE OF p, s
      ON CONFLICT (source_incarnation, page_id, content_hash) DO UPDATE
        SET fail_count=GREATEST(extract_atoms_page_state.fail_count, EXCLUDED.fail_count),
            tombstoned=extract_atoms_page_state.tombstoned OR EXCLUDED.tombstoned, updated_at=now()
      RETURNING page_id`,
    [after.page.id, after.sourceIncarnation, after.page.content_hash, after.revision, state.fail_count, state.tombstoned]);
  return rows.length > 0;
}
