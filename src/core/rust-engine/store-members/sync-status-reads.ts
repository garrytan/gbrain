/**
 * The row reads `gbrain sync status` makes (engine-sql/sync-status-reads.ts), answered from the store's sources, cycle
 * locks, config and op checkpoint rows (rust/docs/store/journal.md, "TypeScript journal members").
 *
 * The store keeps write request, effect, worktree, source binding, worktree refresh and derived generation rows, but on
 * this engine nothing yet writes the ones these reads join (readManagedModeRows answers `enabled: false`): managed
 * writes (the worktree-bound and managed-sync requests and their Git effects) are held until the managed-persistence
 * capability flip, and no refresh, request-recovery or derived-generation writer has landed. A source binding can
 * exist (a writer claim stores one), but no unfinished request names its worktree. So every part of these reads that
 * joins those rows answers its empty state: no failed writeback, no open refresh, no committed managed-sync page, no
 * held push or fence, no head request, no recovery record, and no receipt beside a cursor. These parts must become real
 * reads at the capability flip. The parts the store does keep are read as the SQL reads them: the source row, the drain
 * lock, the pass and withheld-delete rows, the admission setting and its pinned probe, and the managed-sync cursor,
 * failure and manifest checkpoint rows.
 *
 * The identity-downgrade records are read with their page join in the store (gbrain-store
 * `persistence::identity_downgrade`; rust/docs/store/persistence.md, "Identity-downgrade read").
 * Checkpoint rows list in byte order, where the SQL orders by the database collation; they agree on ASCII keys.
 */
import { APPLE_CONTACTS_PENDING_DELETES_OP, APPLE_CONTACTS_REVIEW_OP } from '../../apple-contacts/review-status.ts';
import { syncLockId } from '../../db-lock.ts';
import { MANAGED_SYNC_PASS_OP, summaryFingerprint } from '../../engine-sql/sync-hold-store.ts';
import type {
  IdentityDowngradeCarry, IdentityDowngradeOldPage, IdentityRemedySideRow, ManagedSyncFailureRow, SyncHeadRequestRow, SyncRecoveryProbeRow, SyncStatusCommittedRow, SyncStatusProbeOptions, SyncStatusSourceRow,
} from '../../engine-sql/sync-status-reads.ts';
import type { SourceStateRow } from '../../engine-sql/write-misc.ts';
import type { CycleLockRow, SourceDetailRow, SourceRow } from '../../engine.ts';
import { SYNC_ADMISSION_KEY, SYNC_ADMISSION_SETTING_PARAMS } from '../../persistence/sync-admission.ts';
import { SYNC_DELETES_WITHHELD_OP } from '../../persistence/sync-pass-row.ts';
import { IDENTITY_DOWNGRADE_OP } from '../../persistence/sync-status-sql.ts';
import type { StoreBrain } from '../store.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

interface CheckpointRow { fingerprint: string; completed_keys: unknown; updated_at: string }
type JsonObject = Record<string, unknown>;

const MANAGED_SYNC_OP = 'managed-sync';
const MANAGED_SYNC_FAILURE_OP = 'managed-sync-failure';
const MANAGED_SYNC_MANIFEST_OP = 'managed-sync-manifest';

/** `completed_keys->0`, or null. */
const first = (row: CheckpointRow | null | undefined): JsonObject | null => {
  const keys = row?.completed_keys;
  return Array.isArray(keys) && keys[0] !== undefined && keys[0] !== null ? keys[0] as JsonObject : null;
};

/** `x->>'name'`: the text of a JSON value, or null. */
const text = (value: unknown): string | null =>
  value === undefined || value === null ? null : typeof value === 'string' ? value : JSON.stringify(value);

/** `x->'name'`: the JSON value, null when missing. */
const json = (value: unknown): unknown => (value === undefined ? null : value);

/** `COALESCE(x->>'done','false')<>'true'`. */
const unfinished = (record: JsonObject | null): boolean => (text(record?.done) ?? 'false') !== 'true';

const millis = (value: unknown): number => new Date(value as string).getTime();

function readRow(brain: StoreBrain, member: string, op: string, fingerprint: string): Promise<CheckpointRow | null> {
  return storeCall({ member }, () => brain.readOpCheckpointRow(op, fingerprint));
}

function listRows(brain: StoreBrain, member: string, op: string): Promise<CheckpointRow[]> {
  return storeCall({ member }, () => brain.listOpCheckpointRows(op, ''));
}

/** Every source, archived ones too (the SQL joins `sources` without an archived filter), with its incarnation as text. */
async function sourceIncarnations(brain: StoreBrain, member: string): Promise<Map<string, string>> {
  const rows: SourceRow[] = await storeCall({ member }, () => brain.listAllSources({ includeArchived: true }));
  const out = new Map<string, string>();
  for (const row of rows) {
    const state: SourceStateRow | null = await storeCall({ member, sourceId: row.id }, () => brain.readSourceState(row.id));
    if (state) out.set(row.id, String(state.incarnation));
  }
  return out;
}

/** `COALESCE(btrim(value), '') NOT IN ('', 'normal')`: btrim strips spaces only. */
const restricted = (stored: string | null): boolean => !['', 'normal'].includes((stored ?? '').replace(/^ +| +$/g, ''));

/**
 * The source row. The admission probes run as the SQL's do: null while the stored value reads as normal; otherwise
 * `pinned` is whether the pass row is `open`, holds the live drain lease's token and started before `set_at` (when
 * the dating row matches the stored value), and `destructive` is false (no managed delete or keep_db reconcile request
 * is admitted while managed writes are held).
 */
export const readSyncStatusSourceRow: StoreMember<[sourceId: string], SyncStatusSourceRow<never, never, never> | null> = async (brain, sourceId) => {
  const member = 'readSyncStatusSourceRow';
  const state: SourceStateRow | null = await storeCall({ member, sourceId }, () => brain.readSourceState(sourceId));
  if (!state || state.archived === true) return null;
  const detail: SourceDetailRow | null = await storeCall({ member, sourceId }, () => brain.getSource(sourceId));
  if (!detail) return null;
  const incarnation = String(state.incarnation);
  const key = summaryFingerprint(sourceId, incarnation);
  const locks: CycleLockRow[] = await storeCall({ member }, () => brain.readCycleLocks({ by: 'id', lockId: syncLockId(sourceId) }));
  const pass = await readRow(brain, member, MANAGED_SYNC_PASS_OP, key);
  const withheld = await readRow(brain, member, SYNC_DELETES_WITHHELD_OP, key);
  const [, setOp, setFingerprint] = SYNC_ADMISSION_SETTING_PARAMS;
  const stored: string | null = await storeCall({ member }, () => brain.getConfig(SYNC_ADMISSION_KEY));
  const dating = first(await readRow(brain, member, setOp, setFingerprint));
  const rowValue = text(dating?.value);
  let pinned: boolean | null = null;
  let destructive: boolean | null = null;
  if (restricted(stored)) {
    const setAt = rowValue !== null && rowValue === stored ? text(dating?.set_at) : null;
    const value = first(pass);
    const telemetry = value?.telemetry as JsonObject | undefined;
    const lease = locks.find(lock => millis(lock.ttl_expires_at) > millis(lock.db_now));
    pinned = !!value && !!lease && String(lease.acquisition_token) === text(value.lease_token) && text(telemetry?.outcome) === 'open'
      && (setAt === null || millis(text(telemetry?.started_at)) < millis(setAt));
    destructive = false;
  }
  const reviews = await readRow(brain, member, APPLE_CONTACTS_REVIEW_OP, sourceId);
  const heldDeletes = await readRow(brain, member, APPLE_CONTACTS_PENDING_DELETES_OP, sourceId);
  return {
    incarnation, last_commit: detail.last_commit, last_sync_at: detail.last_sync_at, drain_lock: locks.length > 0,
    pass_value: first(pass) as never, pass_updated_at: pass?.updated_at ?? null, pass_read_at: new Date().toISOString(), withheld: first(withheld) as never,
    admission_stored: stored, admission_row_value: rowValue, admission_set_at: text(dating?.set_at), admission_pinned: pinned, admission_destructive: destructive,
    writeback_failed: null, refresh: null, identity_reviews: reviews?.completed_keys ?? null, held_deletes: heldDeletes?.completed_keys ?? null,
    config: detail.config,
  };
};

/** No managed-sync request commits, and no Git effect or fence generation is written, while managed writes are held. */
export const readSyncStatusCommittedRow: StoreMember<[sourceId: string], SyncStatusCommittedRow> = async () =>
  ({ n: 0, git_push_held: false, fence_held: false, last_committed_at: null });

/** The source incarnation's newest managed-sync cursor, the one keyed `failedKey` first. */
export const readManagedSyncCursorHeader: StoreMember<[sourceId: string, incarnation: string, failedKey: string], { header: never; key: string } | null> =
  async (brain, sourceId, incarnation, failedKey) => {
    const rows = (await listRows(brain, 'readManagedSyncCursorHeader', MANAGED_SYNC_OP)).filter(row => {
      const record = first(row);
      return text(record?.sourceId) === sourceId && text(record?.incarnation) === incarnation;
    });
    rows.sort((a, b) => Number(b.fingerprint === failedKey) - Number(a.fingerprint === failedKey) || millis(b.updated_at) - millis(a.updated_at));
    return rows[0] ? { header: json(first(rows[0])) as never, key: rows[0].fingerprint } : null;
  };

/** The oldest unfinished managed-sync cursor of the source under another incarnation, its last write in UTC ms. */
export const readRetiredManagedSyncCursor: StoreMember<[sourceId: string, incarnation: string], { first_seen: string } | null> = async (brain, sourceId, incarnation) => {
  const rows = (await listRows(brain, 'readRetiredManagedSyncCursor', MANAGED_SYNC_OP)).filter(row => {
    const record = first(row);
    const recorded = text(record?.incarnation);
    return text(record?.sourceId) === sourceId && recorded !== null && recorded !== incarnation && unfinished(record);
  });
  rows.sort((a, b) => millis(a.updated_at) - millis(b.updated_at));
  return rows[0] ? { first_seen: new Date(rows[0].updated_at).toISOString() } : null;
};

/** `m.completed_keys->(index::int)->>'path'`: a negative index counts from the end, as jsonb's does. */
function manifestPath(manifest: CheckpointRow | undefined, index: unknown): string | null {
  const keys = manifest?.completed_keys;
  const at = Number(text(index));
  if (!Array.isArray(keys) || text(index) === null || !Number.isInteger(at)) return null;
  const entry = keys[at < 0 ? keys.length + at : at] as JsonObject | undefined;
  return entry && typeof entry === 'object' ? text(entry.path) : null;
}

/** The unfinished cursors of live source incarnations, each with its failure row and manifest path (no receipt: no request exists). */
export const readManagedSyncFailureRows: StoreMember<[sourceIds: readonly string[] | null], Array<ManagedSyncFailureRow<never, never, never>>> = async (brain, sourceIds) => {
  const member = 'readManagedSyncFailureRows';
  const sources = await sourceIncarnations(brain, member);
  const wanted = sourceIds ? new Set(sourceIds) : null;
  const failures = new Map((await listRows(brain, member, MANAGED_SYNC_FAILURE_OP)).map(row => [row.fingerprint, row]));
  const manifests = new Map((await listRows(brain, member, MANAGED_SYNC_MANIFEST_OP)).map(row => [row.fingerprint, row]));
  const out: Array<ManagedSyncFailureRow<never, never, never>> = [];
  for (const row of await listRows(brain, member, MANAGED_SYNC_OP)) {
    const c = first(row);
    const sourceId = text(c?.sourceId);
    if (!c || sourceId === null || !unfinished(c) || (wanted && !wanted.has(sourceId))) continue;
    const incarnation = sources.get(sourceId);
    if (incarnation === undefined || incarnation !== text(c.incarnation)) continue;
    const pending = c.pending as JsonObject | undefined;
    const runId = text(c.runId);
    out.push({
      cursor_key: row.fingerprint,
      value: { sourceId, incarnation, runId, index: json(c.index), target: text(c.target), syncOptions: json(c.syncOptions), processingOptions: json(c.processingOptions),
        pending: { requestId: text(pending?.requestId) } } as never,
      receipt: null, failure: first(failures.get(row.fingerprint)) as never,
      path: manifestPath(runId === null ? undefined : manifests.get(runId), c.index), updated_at: row.updated_at,
    });
  }
  return out;
};

/** The commit targets of a worktree's freshness samples, from the store's request records (gbrain-store `persistence::freshness`). */
export const listFreshnessTargets: StoreMember<[worktreeId: string, incarnation: string, windowHours: number, limit: number], string[]> =
  (brain, worktreeId, incarnation, windowHours, limit) =>
    storeCall({ member: 'listFreshnessTargets' }, () => brain.listFreshnessTargets(worktreeId, incarnation, windowHours, Math.max(1, Math.floor(limit))));

/** The failure rows of live source incarnations whose cursor row is gone. */
export const readOrphanedManagedSyncFailureRows: StoreMember<[sourceIds: readonly string[] | null], Array<{ failure: never }>> = async (brain, sourceIds) => {
  const member = 'readOrphanedManagedSyncFailureRows';
  const sources = await sourceIncarnations(brain, member);
  const wanted = sourceIds ? new Set(sourceIds) : null;
  const cursors = new Set((await listRows(brain, member, MANAGED_SYNC_OP)).map(row => row.fingerprint));
  const out: Array<{ failure: never }> = [];
  for (const row of await listRows(brain, member, MANAGED_SYNC_FAILURE_OP)) {
    const f = first(row);
    const sourceId = text(f?.source_id);
    if (sourceId === null || (wanted && !wanted.has(sourceId)) || cursors.has(row.fingerprint)) continue;
    if (sources.get(sourceId) !== text(f?.source_incarnation)) continue;
    out.push({ failure: f as never });
  }
  return out;
};

/** No unfinished request names a bound worktree while managed writes are held, so there is no head request. */
export const readSyncHeadRequestRow: StoreMember<[sourceId: string, opts?: SyncStatusProbeOptions], SyncHeadRequestRow | null> = async (_brain, _sourceId, opts) => {
  opts?.signal?.throwIfAborted();
  return null;
};

/** No request-recovery writer has landed, so no request holds a recovery record. */
export const readSyncRecoveryProbeRow: StoreMember<[sourceId: string, opts?: SyncStatusProbeOptions], SyncRecoveryProbeRow> = async (_brain, _sourceId, opts) => {
  opts?.signal?.throwIfAborted();
  return { n: 0, request_id: null, slug: null, blocked: null };
};

/** The soft-deleted page a downgrade record names (gbrain-store `persistence::identity_downgrade`), or null. */
export const readIdentityDowngradeOldPage: StoreMember<[sourceId: string, path: string, slug: string], IdentityDowngradeOldPage | null> = (brain, sourceId, path, slug) =>
  storeCall({ member: 'readIdentityDowngradeOldPage', sourceId }, () => brain.readIdentityDowngradeOldPage(sourceId, path, slug));

/** What an old page carries into a downgrade record (the store's facts, links and alias rows). */
export const countIdentityDowngradeCarry: StoreMember<[sourceId: string, slug: string, pageId: number], IdentityDowngradeCarry> = (brain, sourceId, slug, pageId) => {
  if (!Number.isSafeInteger(pageId) || pageId < 1) refuseMember('countIdentityDowngradeCarry', 'a page id that is not a positive integer');
  return storeCall({ member: 'countIdentityDowngradeCarry', sourceId }, () => brain.countIdentityDowngradeCarry(sourceId, slug, pageId));
};

/** One page of the source by id or slug, deleted or not, as the identity remedy binds it, or null. */
export const readIdentityRemedySide: StoreMember<[sourceId: string, by: { pageId: number } | { slug: string }], IdentityRemedySideRow | null> = (brain, sourceId, by) => {
  if ('pageId' in by && (!Number.isSafeInteger(by.pageId) || by.pageId < 1)) refuseMember('readIdentityRemedySide', 'a page id that is not a positive integer');
  return storeCall({ member: 'readIdentityRemedySide', sourceId }, () =>
    brain.readIdentityRemedySide(sourceId, 'pageId' in by ? by.pageId : null, 'slug' in by ? by.slug : null));
};

/** The open identity-downgrade records, oldest first, each with the live slugs at its new path (null when none). */
export const readIdentityDowngradeRows: StoreMember<[sourceIds: readonly string[] | null], Array<{ record: never; new_slugs: string[] | null }>> = async (brain, sourceIds) =>
  await storeCall({ member: 'readIdentityDowngradeRows' },
    () => brain.readIdentityDowngradeRows({ op: IDENTITY_DOWNGRADE_OP, sourceIds: sourceIds ? [...sourceIds] : null })) as Array<{ record: never; new_slugs: string[] | null }>;
