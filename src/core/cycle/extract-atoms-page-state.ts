import type { SqlEngine } from '../persistence/model.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { stableJson } from '../persistence/digest.ts';
import type { BrainEngine } from '../engine.ts';
import { rethrowCapabilityRefusal } from '../engine-capability-refusal.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import { withTrustKeep } from '../persistence/context.ts';
import { throwIfAborted } from '../abort-check.ts';
import { pageSnapshotKey } from '../page-snapshot-batch.ts';

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
  /** GST-4020: database time just before discovery read this input; a completed scan is stamped at it, not after inference. */
  readAt?: string;
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

export async function readAtomPageIdentity(engine: Pick<BrainEngine, 'readAtomPageIdentity'>, sourceId: string, item: AtomPageInput): Promise<AtomPageIdentity | undefined> {
  const row = await engine.readAtomPageIdentity(sourceId, item.slug, item.contentHash); // engine-sql/extract-atoms-state.ts
  return row ? { pageId: row.id, sourceIncarnation: row.incarnation, revision: row.knowledge_revision } : undefined;
}

/**
 * Record a scan of the page's current content. `inputSha256` (a successful complete scan only) is the digest of the
 * model input it read (atomInputDigest); a later content hash whose input digests the same reuses its atoms
 * (reusableAtomScan). GST-4020: a failure clears the row's completion and keeps its time, so a page offered again on
 * content it had completed (a newer world withdrawal, a revert) stays retryable instead of reading as done.
 */
export async function writeAtomPageState(
  engine: Pick<BrainEngine, 'writeAtomPageState'>, sourceId: string, item: AtomPageInput, outcome: 'complete' | 'failure', inputSha256?: string,
): Promise<number> {
  if (!item.identity) throw new AtomPageStateError('unpinned');
  const { pageId, sourceIncarnation, revision } = item.identity;
  const count = await engine.writeAtomPageState( // engine-sql/extract-atoms-state.ts
    { pageId, sourceIncarnation, sourceId, slug: item.slug, contentHash: item.contentHash, revision },
    outcome === 'failure' ? 1 : 0, outcome === 'complete', outcome === 'complete' ? inputSha256 ?? null : null, item.readAt ?? null).catch((error: unknown) => {
    rethrowCapabilityRefusal(error); // an engine that cannot keep the row refuses by name, never "storage"
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    throw new AtomPageStateError(code === '42P01' ? 'schema' : code === '42501' ? 'denied' : 'storage');
  });
  if (count === null) throw new AtomPageStateError('changed');
  return count;
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
  const atoms = await engine.executeRaw<{ slug: string; source_slug: string; visibility: string | null; date: string | null; source_hash: string | null;
    predates_withdrawal: boolean }>(
    `SELECT a.slug, a.frontmatter->>'source_slug' AS source_slug, a.frontmatter->>'visibility' AS visibility,
       a.frontmatter->>'date' AS date, a.frontmatter->>'source_hash' AS source_hash,
       EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id=$1 AND w.visibility='world' AND w.subject IN ('*', $2)
         AND w.withdrawn_at > a.updated_at) AS predates_withdrawal
      FROM pages a
      WHERE a.source_id=$1 AND a.type='atom' AND a.deleted_at IS NULL
        AND COALESCE(a.frontmatter->>'managed_extraction', '') <> 'true'
        AND (a.frontmatter->>'source_slug' = ANY(ARRAY[$2::text] || ARRAY(${renamedFromSql}))
          OR a.id IN (SELECT l.to_page_id FROM links l WHERE l.from_page_id=$3 AND l.link_source='atom-provenance'))
      FOR UPDATE OF a`,
    [sourceId, item.slug, item.identity.pageId]);
  const scanned = scan.content_hash.slice(0, 16), current = item.contentHash.slice(0, 16);
  const fits = atoms.every(atom => atom.source_slug === item.slug && (atom.source_hash === scanned || atom.source_hash === current)
    && sameInstant(atom.date, page.date) && (page.visibility === 'world') === (atom.visibility === 'world') && !atom.predates_withdrawal);
  return fits ? atoms.map(atom => atom.slug) : null;
}

/** Two stored dates name the same instant (a YAML date read back as a timestamp included); both absent counts. */
const sameInstant = (a: string | null, b: string | null) => {
  const at = Date.parse(a ?? ''), bt = Date.parse(b ?? '');
  return Number.isNaN(at) || Number.isNaN(bt) ? (a ?? null) === (b ?? null) : at === bt;
};

/** SQL (params $1 source id, $2 slug): every slug a rename moved the page now at $2 away from that no live page holds now. */
const renamedFromSql = `SELECT r.slug FROM (SELECT alias_slug AS slug FROM slug_aliases WHERE source_id=$1 AND canonical_slug=$2 AND notes='rename'
  UNION SELECT old_slug FROM slug_rename_history WHERE source_id=$1 AND new_slug=$2) r
  WHERE NOT EXISTS (SELECT 1 FROM pages occ WHERE occ.source_id=$1 AND occ.slug=r.slug AND occ.deleted_at IS NULL)`;

/**
 * GST-4020: reuse the atoms reusableAtomScan finds, moving them onto the page's current content hash as a completed
 * generation does (atoms adapter completeItems); null when the page has to be extracted. A stop before the move writes nothing.
 */
export async function reuseUnchangedAtoms(engine: BrainEngine, sourceId: string, item: AtomPageInput, inputSha256: string,
  page: { visibility: string; date: string | null }, signal?: AbortSignal): Promise<string[] | null> {
  if (!item.identity || !await reusableAtomScan(engine, sourceId, item, inputSha256, page)) return null;
  throwIfAborted(signal, 'extract_atoms');
  const { pageId, revision } = item.identity;
  return maintenanceTransaction(engine, tx => withTrustKeep(tx, ['pages'], async () => {
    const [origin] = await tx.executeRaw(`SELECT 1 FROM pages WHERE id=$1 AND source_id=$2 AND slug=$3 AND content_hash=$4
      AND knowledge_revision=$5::uuid AND deleted_at IS NULL FOR UPDATE`, [pageId, sourceId, item.slug, item.contentHash, revision]);
    const slugs = origin ? await reusableAtomScan(tx, sourceId, item, inputSha256, page) : null;
    if (!slugs) return null;
    if (slugs.length) await tx.executeRaw(`UPDATE pages SET frontmatter = frontmatter || jsonb_build_object('source_hash', $1::text)
      WHERE source_id=$2 AND type='atom' AND slug = ANY($3::text[]) AND deleted_at IS NULL AND frontmatter->>'source_slug' = $4`,
      [item.contentHash.slice(0, 16), sourceId, slugs, item.slug]);
    await writeAtomPageState(tx, sourceId, item, 'complete', inputSha256);
    return slugs;
  }));
}

/**
 * GST-4020: the slugs a rename moved the page now at `slug` away from that live extractor atoms (unmanaged) still name,
 * where the live generation of that slug was read from this page (`pageId`, in its input pin): a later page that held
 * the slug and moved on is another origin.
 * Their origin is this page, so its complete re-extraction supersedes them; left live they keep the visibility the page
 * had before the rename.
 */
export async function renamedOriginSlugs(engine: SqlEngine, sourceId: string, slug: string, pageId: number): Promise<string[]> {
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT DISTINCT a.frontmatter->>'source_slug' AS slug FROM pages a
      WHERE a.source_id=$1 AND a.type='atom' AND a.deleted_at IS NULL
        AND COALESCE(a.frontmatter->>'managed_extraction', '') <> 'true'
        AND COALESCE(a.frontmatter->>'extracted_by', '') LIKE 'extract\\_atoms%'
        AND a.frontmatter->>'source_slug' = ANY(ARRAY(${renamedFromSql}))
        AND EXISTS (SELECT 1 FROM derived_generations dg WHERE dg.source_id=$1 AND dg.kind='atom' AND dg.state='live'
          AND dg.owner_key = 'source_slug:' || (a.frontmatter->>'source_slug') AND split_part(dg.input_pin, ':', 2) = $3::text)`,
    [sourceId, slug, String(pageId)]);
  return rows.map(row => row.slug);
}

// GST-4020: a page's state row for its current content settles it only while it is the page's newest row (a revert to
// content scanned before a newer extraction is extracted again: the atoms live now are the newer content's) and no
// world withdrawal of the page's claims (subject the page or '*') was recorded after it (the extraction read the claim).
export const scanStillCurrentSql = (scan: string) => `NOT EXISTS (
    SELECT 1 FROM extract_atoms_page_state newer
    WHERE newer.source_incarnation=${scan}.source_incarnation AND newer.page_id=${scan}.page_id AND newer.updated_at > ${scan}.updated_at)
  AND NOT EXISTS (
    SELECT 1 FROM fact_withdrawals w
    WHERE w.source_id=p.source_id AND w.visibility='world' AND w.subject IN ('*', p.slug) AND w.withdrawn_at > ${scan}.updated_at)`;

// An unmanaged atom on the page's current content hash settles it, unless the page's newest scan read other content (a
// revert after a newer, possibly partial, extraction) or a world withdrawal recorded after the page's completed scan of
// that content means the extraction read a claim since withdrawn (GST-4020, #10332).
export const PAGE_ATOMS_CURRENT_EXCLUSION_SQL = `AND (NOT EXISTS (
    SELECT 1 FROM pages atom
    WHERE atom.type = 'atom' AND atom.source_id = p.source_id
      AND atom.frontmatter->>'source_hash' = substring(p.content_hash from 1 for 16)
      AND COALESCE(atom.frontmatter->>'managed_extraction', '') <> 'true'
      AND atom.deleted_at IS NULL
  ) OR EXISTS (
    SELECT 1 FROM extract_atoms_page_state newer
    WHERE newer.source_incarnation=(SELECT s.incarnation FROM sources s WHERE s.id=p.source_id)
      AND newer.page_id=p.id AND newer.content_hash<>p.content_hash
      AND newer.updated_at > COALESCE((SELECT max(cur.updated_at) FROM extract_atoms_page_state cur
        WHERE cur.source_incarnation=newer.source_incarnation AND cur.page_id=p.id AND cur.content_hash=p.content_hash), '-infinity'::timestamptz)
  ) OR EXISTS (
    SELECT 1 FROM extract_atoms_page_state done
    JOIN fact_withdrawals w ON w.source_id=p.source_id AND w.visibility='world' AND w.subject IN ('*', p.slug) AND w.withdrawn_at > done.updated_at
    WHERE done.source_incarnation=(SELECT s.incarnation FROM sources s WHERE s.id=p.source_id)
      AND done.page_id=p.id AND done.content_hash=p.content_hash
  ))`;

/** Canonical page snapshots discovery reads per statement. */
const PAGE_SNAPSHOT_BATCH = 50;

/**
 * GST-4020 (#10332): the extraction input of each page discovery found: its canonical body (withdrawn claims marked,
 * as a read of the page sees them) at the row discovery read; a page that moved since waits for the next run. A stop
 * between batches returns what was read.
 */
export async function canonicalPageInputs(engine: BrainEngine, sourceId: string,
  rows: ReadonlyArray<{ id: number; knowledge_revision: string; source_incarnation: string; slug: string; content_hash: string }>,
  opts: { signal?: AbortSignal; stopSignal?: AbortSignal }): Promise<AtomPageInput[]> {
  const pages: AtomPageInput[] = [];
  const stopped = () => opts.signal?.aborted || opts.stopSignal?.aborted;
  const unreadable = (what: string) => (error: unknown) => {
    console.error(`[extract_atoms] ${what}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  };
  for (let start = 0; start < rows.length;) {
    if (stopped()) break;
    const [clock] = await engine.executeRaw<{ at: string }>(`SELECT clock_timestamp()::text AS at`);
    const accept = (r: typeof rows[number], snapshot: PageSnapshot | undefined) => {
      if (!snapshot || Number(snapshot.page.id) !== Number(r.id) || snapshot.revision !== r.knowledge_revision
        || snapshot.sourceIncarnation !== r.source_incarnation || snapshot.page.content_hash !== r.content_hash) return;
      pages.push({ slug: r.slug, content: snapshot.page.compiled_truth, contentHash: r.content_hash,
        identity: { pageId: r.id, sourceIncarnation: r.source_incarnation, revision: r.knowledge_revision }, readAt: clock?.at });
    };
    const batch = rows.slice(start, start + PAGE_SNAPSHOT_BATCH);
    const read = await engine.readPageSnapshotsBatch(batch.map(row => ({ slug: row.slug, sourceId })))
      .catch(unreadable('snapshot batch read failed, reading its pages one by one'));
    if (read) {
      const step = Math.max(read.covered, 1);
      for (const r of rows.slice(start, start + step)) accept(r, read.snapshots.get(pageSnapshotKey(sourceId, r.slug)));
      start += step;
      continue;
    }
    // A snapshot the batch cannot read (withdrawal_capacity on one fence) is read page by page: only that page waits.
    for (const r of batch) {
      if (stopped()) return pages;
      const one = await engine.readPageSnapshotsBatch([{ slug: r.slug, sourceId }]).catch(unreadable(`${r.slug}: snapshot read failed, page left pending`));
      accept(r, one?.snapshots.get(pageSnapshotKey(sourceId, r.slug)));
    }
    start += batch.length;
  }
  return pages;
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
