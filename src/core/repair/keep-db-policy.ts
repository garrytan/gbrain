/**
 * #6696 C7: the opt-in `storage.keep_db` policy (gbrain.yml), consumed only by
 * the trusted local maintenance worker on the canonical owner host.
 *
 * A source whose gbrain.yml declares `keep_db:` prefixes asks that a drifted
 * page under them (its canonical file differs from the database copy, so every
 * coordinated write refuses `source_changed` / `file_database_drift`) be
 * reconciled with the database copy winning, the resolution
 * `gbrain repair file-drift --prefer database` previews, inside the same
 * reconcile protections. Nothing else reads the policy: remote and caller
 * writes to those pages keep refusing until the worker (or an operator)
 * reconciles them.
 *
 * `runKeepDbPolicy` runs only for a source whose active binding this host
 * owns. Candidates are the slugs under the prefixes with a drift conflict
 * receipt in the newest `CONFLICT_WINDOW_DEFAULT` request sequences, plus the
 * recorded concept drift skips; each is checked live before anything is
 * prepared. Each drifted page gets one reconcile request (`runReconcileApply`)
 * whose id is derived from the page revision and file bytes, so the same drift
 * is never submitted twice, whatever its outcome. A run submits at most `limit`
 * requests (`KEEP_DB_BATCH`; the consumer runs it at most every 10 minutes) and
 * stops before an admission the `admission` gate refuses, or at the first
 * `write_capacity_backpressure` refusal (it submits as a background producer).
 */
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { OperationError, type OperationContext } from '../ops/contract.ts';
import { isKeepDbSlug, loadStorageConfig } from '../storage-config.ts';
import { getWorktreeBinding } from '../persistence/ownership.ts';
import { CONFLICT_WINDOW_DEFAULT, FILE_DRIFT_MESSAGE, liveFileDrift, readDriftSkips } from '../persistence/drift-conflicts.ts';
import { readLocalWriter, withVerifiedLocalRegistration } from '../persistence/identity.ts';
import { getWriteRequest } from '../persistence/journal.ts';
import { runReconcileApply } from '../persistence/reconcile.ts';
import { acceptedPendingReceipt } from '../persistence/accepted-pending.ts';
import { digest } from '../persistence/digest.ts';
import { capacity } from './core.ts';
import { RECEIPT_RESERVATION_FLOOR } from '../persistence/receipt-bytes.ts';
import { readBackgroundPauseShare, withAdmissionOrigin } from '../persistence/admission-origin.ts';
import { prepareDriftPage } from './file-drift.ts';

/** Reconcile requests one policy run submits at most. */
export const KEEP_DB_BATCH = 10;
/** Candidate slugs one source contributes to a run. */
const CANDIDATE_LIMIT = 1000;

export interface KeepDbPolicy { source_id: string; keep_db: string[] }

export interface KeepDbRun {
  submitted: number;
  skipped_by_reason: Record<string, number>;
  /**
   * `rate_limit`: candidates remain past `limit`; `capacity`: the admission gate refused the next request;
   * `write_capacity_backpressure`: admission refused this background producer past the pause line, with no receipt.
   */
  stopped?: 'rate_limit' | 'capacity' | 'write_capacity_backpressure';
  sources: Array<KeepDbPolicy & { submitted: number }>;
}

/**
 * The admission seam for this background producer: a stop reason when it must not admit now. The default stops at
 * the repair core's 90% stop line on lifetime ids and receipt bytes (`capacity`) and, before that, at the background
 * pause line (`persistence.capacity.background_pause_pct`, 80%) where admission would refuse this background request
 * `write_capacity_backpressure`. Checking first keeps a refused attempt from retaining a reconcile backup under the
 * page's deterministic request id; an admission-time refusal (another writer crossed the line meanwhile) also stops the run.
 */
export type KeepDbAdmission = (engine: BrainEngine) => Promise<'capacity' | 'write_capacity_backpressure' | null>;

const headroom: KeepDbAdmission = async engine => {
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

const likeEscape = (value: string) => value.replace(/[\\%_]/g, char => `\\${char}`);

async function candidates(engine: BrainEngine, policy: KeepDbPolicy): Promise<string[]> {
  const [bounds] = await engine.executeRaw<{ top: string | null }>('SELECT max(sequence)::text AS top FROM persistence_requests');
  const floor = String(Math.max(0, Number(bounds?.top ?? 0) - CONFLICT_WINDOW_DEFAULT));
  const prefixes = policy.keep_db.map(dir => `${likeEscape(dir.toLowerCase())}%`);
  const rows = await engine.executeRaw<{ slug: string }>(`SELECT DISTINCT r.slug FROM persistence_requests r
    WHERE r.sequence > $2::bigint AND r.source_id=$1 AND r.state='conflict' AND r.error_code='source_changed' AND r.error_message=$3
      AND lower(r.slug) LIKE ANY($4::text[]) ORDER BY r.slug LIMIT ${CANDIDATE_LIMIT}`, [policy.source_id, floor, FILE_DRIFT_MESSAGE, prefixes]);
  const skipped = Object.keys(await readDriftSkips(engine)).filter(key => key.startsWith(`${policy.source_id}:`)).map(key => key.slice(policy.source_id.length + 1));
  return [...new Set([...rows.map(row => row.slug), ...skipped])].filter(slug => isKeepDbSlug(slug, policy.keep_db)).sort();
}

/**
 * One drifted page: submitted, the capacity stop, or the reason it was skipped. It always runs as this
 * installation's own CLI writer registration, never as whatever caller context the worker's timer inherited:
 * the policy is the owner host's declaration, so no remote caller's grant applies to it or is widened by it.
 */
async function reconcileWithDatabase(engine: BrainEngine, sourceId: string, slug: string, admission: KeepDbAdmission): Promise<string> {
  return withVerifiedLocalRegistration(engine, await readLocalWriter(engine, 'cli'), async writer => {
    const live = await liveFileDrift(engine, sourceId, slug);
    if (live.still_present !== true) return live.still_present === false ? 'no_drift' : live.reason;
    let page;
    try { page = await prepareDriftPage(engine, sourceId, slug, 'database', new Date().toISOString()); }
    catch (error) { if (error instanceof OperationError) return error.code; throw error; }
    const h = digest(['keep-db-policy-v1', sourceId, slug, page.preview.preconditions.revision, page.preview.preconditions.raw_file_hash]);
    const requestId = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
    if (await getWriteRequest(engine, writer.principal, requestId)) return 'already_submitted';
    const stop = await admission(engine);
    if (stop) return stop;
    try {
      // #6696 A5: a background producer, so near-cap backpressure refuses it before any receipt and interactive writes keep the rest.
      await withAdmissionOrigin('background', () => runReconcileApply(engine, { source_id: sourceId, slug, preview: page.preview, request_id: requestId }));
    } catch (error) {
      if (acceptedPendingReceipt(error)) return 'submitted';
      if (!(error instanceof OperationError)) throw error;
      if (error.code === 'write_capacity_backpressure') return error.code;
      return await getWriteRequest(engine, writer.principal, requestId) ? 'submitted' : error.code;
    }
    return 'submitted';
  });
}

/**
 * One rate-limited pass of the keep_db policy over `sourceIds` (default: every active source) for the owner host
 * `hostId`. Sources this host does not own, or that declare no policy, are skipped without a read of their pages.
 */
export async function runKeepDbPolicy(engine: BrainEngine, opts: { hostId: string; sourceIds?: string[]; limit?: number; admission?: KeepDbAdmission }): Promise<KeepDbRun> {
  const limit = opts.limit ?? KEEP_DB_BATCH;
  const run: KeepDbRun = { submitted: 0, skipped_by_reason: {}, sources: [] };
  const skip = (reason: string) => { run.skipped_by_reason[reason] = (run.skipped_by_reason[reason] ?? 0) + 1; };
  const sourceIds = opts.sourceIds ?? (await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS NOT TRUE ORDER BY id')).map(row => row.id);
  for (const sourceId of sourceIds) {
    let policy: KeepDbPolicy | null;
    try { policy = await readKeepDbPolicy(engine, sourceId, opts.hostId); } catch { skip('storage_config_error'); continue; }
    if (!policy) continue;
    const entry = { ...policy, submitted: 0 };
    run.sources.push(entry);
    for (const slug of await candidates(engine, policy)) {
      if (run.submitted >= limit) { run.stopped = 'rate_limit'; return run; }
      let outcome: string;
      try { outcome = await reconcileWithDatabase(engine, sourceId, slug, opts.admission ?? headroom); }
      catch (error) { if (!(error instanceof OperationError)) throw error; outcome = error.code; }
      if (outcome === 'capacity' || outcome === 'write_capacity_backpressure') { run.stopped = outcome; return run; }
      if (outcome !== 'submitted') { skip(outcome); continue; }
      run.submitted++;
      entry.submitted++;
    }
  }
  return run;
}
