/**
 * #6696 C7: the opt-in `storage.keep_db` policy (gbrain.yml). #6712 PR 4b (design v3.2 §4, d1b option C): the policy is
 * an admission of the managed sync pass itself; the separate maintenance worker is retired.
 *
 * A source whose gbrain.yml declares `keep_db:` prefixes asks that a drifted page under them be reconciled with the
 * database copy winning, the resolution `gbrain repair file-drift --prefer database` previews, inside the same reconcile
 * protections. Only the owner host's pass writes it, and only for a path it classified `keep_db` (row 18) or
 * `db_ahead`/`db_only` under a keep_db prefix (row 15) in committed mode with `Dp = clean`:
 *
 * - `freezeKeepDbReconcile` builds the DB-wins artifact (`prepareDriftPage(prefer: database)`) and binds it to the bytes and
 *   page revision the pass froze under its lease: an artifact whose own read differs is refused, so its
 *   `preconditions.raw_file_hash` is the frozen hash and publication refuses any later edit.
 * - `admitKeepDbReconcile` admits it under this installation's own CLI writer registration (never a caller's grant) with a
 *   request id derived from the page revision and frozen bytes, re-reading `sync.admission` and running the pass's
 *   `inTx` fence (the drain lease) inside the admission transaction. It does not wait for publication. The publication
 *   re-reads `sync.admission` (reconcile-prepare.ts) and completes `cancelled` / `admission_paused` when it is not normal.
 *
 * Concept drift skips stay concept-side records; `releaseMatchedDriftSkips` clears the ones of pages the pass classified
 * `matched`. Doctor `maintenance_write_drift` reads `readKeepDbPolicy` and `keepDbReceiptCost`.
 */
import { join, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { OperationError, type OperationContext } from '../ops/contract.ts';
import { trustedCliRequired } from '../ops/op-fix.ts';
import { isKeepDbSlug, loadStorageConfig } from '../storage-config.ts';
import { getWorktreeBinding } from '../persistence/ownership.ts';
import { readDriftSkips, releaseDriftSkip } from '../persistence/drift-conflicts.ts';
import { localHostId, readLocalWriter, withVerifiedLocalRegistration } from '../persistence/identity.ts';
import { getWriteRequest } from '../persistence/journal.ts';
import { admitReconcileArtifact, authorizeReconcile, type ReconcileArtifact } from '../persistence/reconcile.ts';
import { reconcileBackupRetained } from '../persistence/reconcile-backup.ts';
import { digest, sha256 } from '../persistence/digest.ts';
import type { Principal, WriteRequest } from '../persistence/model.ts';
import { sourceMirrorReadOnly } from '../persistence/mirror-read-only.ts';
import { admissionAllows, readSyncAdmission } from '../persistence/sync-admission.ts';
import type { SyncClassified, SyncDirtiness, SyncPathState } from '../persistence/sync-classify.ts';
import { capacity } from './core.ts';
import { RECEIPT_RESERVATION_FLOOR } from '../persistence/receipt-bytes.ts';
import { readBackgroundPauseShare, withAdmissionOrigin } from '../persistence/admission-origin.ts';
import { prepareDriftPage } from './file-drift.ts';

export interface KeepDbPolicy { source_id: string; keep_db: string[] }

/**
 * The admission seam for this background producer: a stop reason when it must not admit now. The default stops at
 * the repair core's 90% stop line on lifetime ids and receipt bytes (`capacity`) and, before that, at the background
 * pause line (`persistence.capacity.background_pause_pct`, 80%) where admission would refuse this background request
 * `write_capacity_backpressure`. Checking first keeps a refused attempt from retaining a reconcile backup under the
 * page's deterministic request id.
 */
export type KeepDbAdmission = (engine: BrainEngine) => Promise<'capacity' | 'write_capacity_backpressure' | null>;

export const keepDbHeadroom: KeepDbAdmission = async engine => {
  const rows = await capacity({ engine, remote: false } as OperationContext);
  const need = (resource: string) => resource === 'lifetime_ids' ? 1 : RECEIPT_RESERVATION_FLOOR;
  if (rows.some(c => c.used + need(c.resource) > c.stop_at)) return 'capacity';
  const share = await readBackgroundPauseShare(engine);
  return rows.some(c => c.used + need(c.resource) > Math.floor(c.limit * share)) ? 'write_capacity_backpressure' : null;
};

/** One request's receipt cost, as doctor `maintenance_write_drift` reports it for the matched pages. */
export const keepDbReceiptCost = (pages: number) => ({ lifetime_ids: pages, receipt_bytes: pages * RECEIPT_RESERVATION_FLOOR });

/**
 * The effective policy of one source on this host: the `keep_db` prefixes of its canonical checkout's gbrain.yml,
 * read only when `hostId` owns the source's active binding (null otherwise, or when none are declared).
 * Throws `StorageConfigError` for a gbrain.yml whose tiers overlap.
 */
export async function readKeepDbPolicy(engine: BrainEngine, sourceId: string, hostId: string | null): Promise<KeepDbPolicy | null> {
  const binding = hostId ? await getWorktreeBinding(engine, sourceId, hostId) : null;
  if (!binding?.local_path || binding.owner_host_id !== hostId || binding.state !== 'active') return null;
  const keepDb = loadStorageConfig(join(binding.local_path, binding.relative_path))?.keep_db ?? [];
  return keepDb.length ? { source_id: sourceId, keep_db: keepDb } : null;
}

/** What the pass froze for one path under its lease, and how it classified it. */
export interface KeepDbFreeze {
  sourceId: string;
  slug: string;
  pageId: number;
  /** The page revision the pass classified. */
  revision: string;
  /** The source-relative origin `p`, with forward slashes. */
  path: string;
  /** The bytes the pass read: committed mode with `Dp = clean`, so `T[p]`. */
  frozenBytes: Uint8Array;
  classified: Pick<SyncClassified, 'cls' | 'sub' | 'keepDbWrite'>;
  mode: SyncPathState['mode'];
  dirty: SyncDirtiness | null;
}

/** A DB-wins reconcile artifact bound to the frozen bytes and revision (`preview.preconditions`). */
export interface KeepDbArtifact { source_id: string; slug: string; page_id: number; path: string; preview: ReconcileArtifact }

/**
 * Why a frozen path gets no keep_db write: `not_keep_db` (another class), `not_committed_clean` (working mode, or `Dp` not
 * `clean`), `outside_keep_db` (no owner-host policy covers the slug), `storage_config_error`, `mirror_read_only`,
 * `page_changed`, `revision_changed`, `bytes_changed` or `path_changed` (the artifact's own read differs from the freeze),
 * or the code `prepareDriftPage` refused with.
 */
export type KeepDbFreezeResult = { artifact: KeepDbArtifact } | { refused: string };

/**
 * Builds the keep_db DB-wins artifact for one frozen path (design v3.2 §4). Refuses anything but a committed, clean
 * `keep_db` or `db_ahead`/`db_only` keep_db path under this host's policy on a source that is not mirror-read-only, and
 * fails closed when its own read of the page or file differs from what the pass froze.
 */
export async function freezeKeepDbReconcile(engine: BrainEngine, input: KeepDbFreeze): Promise<KeepDbFreezeResult> {
  const { cls, sub, keepDbWrite } = input.classified;
  if (!(cls === 'keep_db' || (cls === 'db_ahead' && sub === 'db_only' && keepDbWrite))) return { refused: 'not_keep_db' };
  if (input.mode !== 'committed' || input.dirty !== 'clean') return { refused: 'not_committed_clean' };
  let policy: KeepDbPolicy | null;
  try { policy = await readKeepDbPolicy(engine, input.sourceId, localHostId()); } catch { return { refused: 'storage_config_error' }; }
  if (!policy || !isKeepDbSlug(input.slug, policy.keep_db)) return { refused: 'outside_keep_db' };
  if (await sourceMirrorReadOnly(engine, input.sourceId)) return { refused: 'mirror_read_only' };
  let preview: ReconcileArtifact;
  try { preview = (await prepareDriftPage(engine, input.sourceId, input.slug, 'database', new Date().toISOString())).preview; }
  catch (error) { if (error instanceof OperationError) return { refused: error.code }; throw error; }
  const pins = preview.preconditions;
  if (pins.page_id !== input.pageId) return { refused: 'page_changed' };
  if (pins.revision !== input.revision) return { refused: 'revision_changed' };
  if (pins.raw_file_hash !== sha256(Buffer.from(input.frozenBytes))) return { refused: 'bytes_changed' };
  if (pins.relative_path.split(sep).join('/') !== input.path) return { refused: 'path_changed' };
  return { artifact: { source_id: input.sourceId, slug: input.slug, page_id: input.pageId, path: input.path, preview } };
}

/**
 * The request id of an artifact: derived from the page revision and the frozen bytes, so one drift is submitted once
 * whatever its outcome. Two ids leave the path a candidate again, and the next admission takes the next id in the
 * sequence: a request `sync.admission` cancelled at publication (`admission_paused`), and an id with a retained backup but
 * no request (an admission refused after retention, such as a lost lease or a paused `sync.admission`), whose backup
 * would refuse a fresh artifact `idempotency_conflict`.
 */
async function keepDbRequestId(engine: BrainEngine, principal: Principal, artifact: KeepDbArtifact): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const h = digest(['keep-db-policy-v1', artifact.source_id, artifact.slug, artifact.preview.preconditions.revision, artifact.preview.preconditions.raw_file_hash,
      ...(attempt ? [attempt] : [])]);
    const requestId = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
    const prior = await getWriteRequest(engine, principal, requestId);
    if (prior ? prior.state !== 'cancelled' || prior.error_code !== 'admission_paused'
      : !reconcileBackupRetained(artifact.preview.preconditions.brain_id, principal, requestId)) return requestId;
  }
}

/**
 * The admitted request (`replayed`: the same drift was admitted before, under the same id), or why nothing was admitted:
 * `admission_paused` (`sync.admission` is not normal inside the admission transaction), `capacity` /
 * `write_capacity_backpressure`, or the code the reconcile admission refused with.
 */
export type KeepDbAdmitResult = { request: WriteRequest; replayed: boolean } | { refused: string };

/**
 * Admits a frozen keep_db artifact for the sync pass `passId` (`intent.keepDb.passId`). `inTx` runs inside the admission
 * transaction after the request row is inserted (the pass runs `assertDrainLease` there); whatever it throws rolls the
 * admission back and is rethrown as is. Only a trusted local pass (`remote: false`) admits keep_db writes.
 */
export async function admitKeepDbReconcile(engine: BrainEngine, artifact: KeepDbArtifact,
  opts: { passId: string; remote: boolean; inTx: (tx: BrainEngine) => Promise<void>; admission?: KeepDbAdmission }): Promise<KeepDbAdmitResult> {
  if (opts.remote !== false) throw trustedCliRequired("keep_db writes are admitted only by the owner host's own sync pass.");
  return withVerifiedLocalRegistration(engine, await readLocalWriter(engine, 'cli'), async writer => {
    const requestId = await keepDbRequestId(engine, writer.principal, artifact);
    const prior = await getWriteRequest(engine, writer.principal, requestId);
    if (prior) return { request: prior, replayed: true };
    const stop = await (opts.admission ?? keepDbHeadroom)(engine);
    if (stop) return { refused: stop };
    let fenced: { error: unknown } | undefined;
    let paused = false;
    const transaction = <T>(fn: (tx: BrainEngine) => Promise<T>) => engine.transaction(async tx => {
      const row = await fn(tx);
      if (!admissionAllows(await readSyncAdmission(tx), 'destructive')) {
        paused = true;
        throw new OperationError('admission_paused', 'sync.admission paused keep_db writes.', 'Nothing was admitted; the next pass admits this page once sync.admission is normal.');
      }
      try { await opts.inTx(tx); } catch (error) { fenced = { error }; throw error; }
      return row;
    });
    try {
      const { authority } = await authorizeReconcile(engine, artifact.source_id, artifact.slug);
      // #6696 A5: a background producer, so near-cap backpressure refuses it before any receipt and interactive writes keep the rest.
      return await withAdmissionOrigin('background', () => admitReconcileArtifact(engine, { sourceId: artifact.source_id, slug: artifact.slug, authority,
        artifact: artifact.preview, requestId, intentExtra: { keepDb: { passId: opts.passId } }, transaction },
        async (request, replayed): Promise<KeepDbAdmitResult> => ({ request, replayed })));
    } catch (error) {
      if (fenced) throw fenced.error;
      if (paused) return { refused: 'admission_paused' };
      if (!(error instanceof OperationError)) throw error;
      const raced = await getWriteRequest(engine, writer.principal, requestId);
      return raced ? { request: raced, replayed: true } : { refused: error.code };
    }
  });
}

/** The slugs of the source's pages the concept side skipped for file drift. */
export async function driftSkippedSlugs(engine: BrainEngine, sourceId: string): Promise<Set<string>> {
  const prefix = `${sourceId}:`;
  return new Set(Object.keys(await readDriftSkips(engine)).filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length)));
}

/**
 * Releases the concept drift skips (`dream.concepts.drift_skips`) of pages the pass classified `matched` in `sourceId`:
 * one read of the skips, and one release per matched page that has one. It walks the source's skips, not the matched
 * slugs, so a 600k-page pass with no skip does no per-page work.
 */
export async function releaseMatchedDriftSkips(engine: BrainEngine, sourceId: string, matchedSlugs: Iterable<string>): Promise<number> {
  const skipped = await driftSkippedSlugs(engine, sourceId);
  if (!skipped.size) return 0;
  const matched = matchedSlugs instanceof Set ? matchedSlugs as Set<string> : new Set(matchedSlugs);
  let released = 0;
  for (const slug of skipped) {
    if (!matched.has(slug)) continue;
    await releaseDriftSkip(engine, sourceId, slug);
    released++;
  }
  return released;
}
