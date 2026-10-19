import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { loadConfig } from '../config.ts';
import type { OperationContext } from '../ops/contract.ts';
import { requireConsent, type ConsentRequest } from '../consent.ts';
import { managedPersistenceEnabled } from './ownership.ts';
import { requestPrincipalForContext, submitPageMutation } from './page-mutations.ts';
import { readOutstandingRoom } from './journal.ts';
import { isWriteCapacityWait } from './admission-retry.ts';
import { readBackgroundPauseShare, resolveAdmissionOrigin } from './admission-origin.ts';
import { withBeliefBatch } from '../belief/ledger.ts';
import { markBeliefCommits } from '../belief/append.ts';
import { linkStreamSlugs } from './page-purge.ts';
import { identityDowngradePurgeHold } from '../sync-identity-downgrades.ts';
import { atomRetirementPurgeHold } from './atom-retirement-hold.ts';
import { writerOnboardingPreflight } from './onboarding.ts';
import { clearPurgePark, notePurgeSourceWriter, PURGE_PARK_LIMIT, purgeParkKey, prunePurgeParks, readPurgeParks, recordPurgeFailure, type PurgePark } from './purge-parks.ts';
import { ItemRun, type ItemFailure } from '../item-failure.ts';

/** A tombstone that moved under a concurrent writer; the next run retries it. */
const DEFERRAL_CODES = new Set(['revision_conflict', 'page_not_found', 'page_identity_changed']);

export interface DeletedPagePurge {
  slugs: string[];
  count: number;
  /** Every expired tombstone not purged this run, with its reason. On an unmanaged brain: the belief-ledger expiry's failed and parked tombstones. */
  blocked: Array<{ source_id: string; slug: string; reason: string; code: string | null; binding_state?: string }>;
  /** Tombstones restored, changed or removed by a concurrent writer; retried next run. */
  deferred: number;
  /** Operational failures (owner, binding, storage, protocol); on an unmanaged brain, recorded tombstones whose delete failed (retried next run). */
  failed: number;
  /** #6741 C: tombstones not submitted because their source's writer is not active (in `blocked`, code `writer_not_active`). */
  inactive: number;
  /** #6741 C: tombstones not submitted after PURGE_PARK_LIMIT failures (in `blocked`, code `purge_parked`); doctor purge_parked_pages names them. */
  parked: number;
  /**
   * #6884: tombstones not submitted because the writer's outstanding-request capacity was in use (in `blocked`, code
   * `write_capacity_deferred`); the next run submits them. Never a failure and never a park.
   */
  capacity_deferred: number;
  /** Present when `failed > 0`, so the caller cannot report success. */
  error?: { class: string; code: string; message: string };
}

/**
 * D6 (#6114): the one consent request for a manual hard purge, used by
 * `gbrain pages purge-deleted` and by the `purge_deleted_pages` op (reached
 * through `gbrain call`), so no manual entry point purges without it. The
 * approved command is always the gated `pages purge-deleted --yes`. The
 * autopilot purge phase calls `purgeDeletedPagesCoordinated` directly.
 */
export function purgeConsentRequest(count: number, olderThanHours: number, json: boolean, args: readonly string[], retryParked = false, parked = 0): ConsentRequest {
  const retry = retryParked ? ['--retry-parked'] : [];
  const retried = retryParked && parked > 0 ? `, including ${parked} parked page(s) retried once more` : '';
  return {
    command: 'pages purge-deleted', effects: ['destructive'], actor: 'agent',
    what: `Permanently purge ${count} soft-deleted page(s)${retried}`,
    why: 'A hard purge removes soft-deleted pages, their chunks and links, from every source of this brain.',
    risk: 'Purged pages cannot be restored with `gbrain restore`.',
    user_message: `Permanently delete ${count} page(s) soft-deleted more than ${olderThanHours}h ago${retried}, across every source in this brain? They cannot be restored afterwards.`,
    argv: ['gbrain', 'pages', 'purge-deleted', '--older-than', `${olderThanHours}h`, ...retry, ...(json ? ['--json'] : []), '--yes'],
    preview_argv: ['gbrain', 'pages', 'purge-deleted', '--older-than', `${olderThanHours}h`, ...retry, '--dry-run', '--json'],
    args,
  };
}

/** The `purge_deleted_pages` op (`gbrain call`): the D6 consent first (`yes` is `--yes`); an empty purge set needs none. */
export async function consentedPurgeDeletedPages(engine: BrainEngine, olderThanHours: number, yes: boolean) {
  const preview = await selectPurgeCandidates(engine, olderThanHours);
  if (preview.count === 0) return { status: 'purged', count: 0, slugs: [] };
  await requireConsent(purgeConsentRequest(preview.count, olderThanHours, false, yes ? ['--yes'] : []));
  const result = await purgeDeletedPagesCoordinated(engine, olderThanHours);
  return { status: result.failed ? 'partial' : 'purged', count: result.count, slugs: result.slugs, ...(result.blocked.length ? { blocked: result.blocked } : {}) };
}

/** An expired tombstone of a source the belief ledger records (unmanaged brain), in scan order, with its live failure record. */
interface RecordedTombstone { id: number; source_id: string; slug: string; deleted_us: string; key: string; park?: PurgePark }

async function recordedTombstones(engine: BrainEngine, hours: string): Promise<RecordedTombstone[]> {
  const rows = await engine.executeRaw<{ id: number; source_id: string; slug: string; deleted_us: string }>(`SELECT p.id, p.source_id, p.slug,
      floor(extract(epoch FROM p.deleted_at)*1000000)::bigint::text AS deleted_us FROM pages p
    WHERE p.deleted_at IS NOT NULL AND p.deleted_at < now() - ($1 || ' hours')::interval AND ${identityDowngradePurgeHold('p')} AND ${atomRetirementPurgeHold('p')}
      AND EXISTS (SELECT 1 FROM belief_events e WHERE e.source_id = p.source_id AND e.subject_kind = 'coverage')
    ORDER BY p.deleted_at ASC, p.source_id ASC, p.slug ASC`, [hours]);
  const parks = rows.length ? await readPurgeParks(engine) : new Map<string, PurgePark>();
  return rows.map(row => {
    const key = purgeParkKey(row.source_id, row.slug, row.deleted_us);
    const park = parks.get(key);
    return { ...row, id: Number(row.id), key, ...(park ? { park } : {}) };
  });
}

const parkedReason = (park: PurgePark) =>
  `Parked after ${park.failures} failed purges (last: ${park.code ?? 'error'}: ${park.reason}); retry once with gbrain pages purge-deleted --retry-parked.`;

interface RecordedExpiry { slugs: string[]; exclude: number[]; blocked: DeletedPagePurge['blocked']; failed: number; parked: number }

/**
 * W1 (BELIEF_LEDGER.md 6.5): on an unmanaged brain, each expired tombstone of a source the belief ledger records is
 * removed under its page key inside a belief batch, which appends `page.expired` (retention, never a purge: no
 * tombstone, nothing redacted) and a `link.retracted` for each link the delete cascades away, in its own stream. The bulk delete then takes the rest.
 *
 * GBRA-130 A-49: each tombstone is its own transaction and its own item. A failure stops the run only when it is
 * run-scoped or ItemRun's breaker finds it systemic; otherwise the tombstone is reported and kept out of the bulk
 * delete (`exclude`). A content failure counts toward the shared purge park (purge-parks.ts), so after
 * PURGE_PARK_LIMIT failures it is parked and skipped, like the managed purge's; a transient one is retried next run.
 */
async function expireRecordedTombstones(engine: BrainEngine, olderThanHours: number, retryParked: boolean): Promise<RecordedExpiry> {
  const hours = String(Math.max(0, Math.floor(olderThanHours)));
  await prunePurgeParks(engine);
  const run = new ItemRun('purge.recorded_tombstones');
  const out: RecordedExpiry = { slugs: [], exclude: [], blocked: [], failed: 0, parked: 0 };
  const failures: Array<{ row: RecordedTombstone; failure: ItemFailure }> = [];
  for (const row of await recordedTombstones(engine, hours)) {
    if (row.park && row.park.failures >= PURGE_PARK_LIMIT && !retryParked) {
      out.parked++;
      out.exclude.push(row.id);
      out.blocked.push({ source_id: row.source_id, slug: row.slug, code: 'purge_parked', reason: parkedReason(row.park) });
      continue;
    }
    try {
      const publicationId = randomUUID(), report = { appended: 0 };
      const deleted = await engine.transaction(async tx => {
        const slugs = [...new Set([row.slug, ...await linkStreamSlugs(tx, row.source_id, row.id)])].sort();
        await tx.lockPageKeys(slugs.map(slug => ({ sourceId: row.source_id, slug })));
        return withBeliefBatch(tx, { sourceId: row.source_id, slugs, publicationId, op: 'purge_deleted_pages', hardDeleteEvent: 'page.expired', report },
          async () => (await tx.executeRaw(`DELETE FROM pages WHERE id = $1 AND deleted_at IS NOT NULL AND deleted_at < now() - ($2 || ' hours')::interval AND ${identityDowngradePurgeHold('pages')} AND ${atomRetirementPurgeHold('pages')} RETURNING id`,
            [row.id, hours])).length > 0);
      });
      run.succeed();
      if (report.appended) await markBeliefCommits(engine, [publicationId]).catch(() => undefined);
      if (deleted) out.slugs.push(row.slug);
      if (row.park) await clearPurgePark(engine, row.key);
    } catch (error) {
      const failure = run.fail(`${row.source_id}/${row.slug}`, error);
      failures.push({ row, failure });
      out.failed++;
      out.exclude.push(row.id);
      out.blocked.push({ source_id: row.source_id, slug: row.slug, code: failure.code,
        reason: `${failure.message}; ${failure.class === 'content'
          ? `parked after ${PURGE_PARK_LIMIT} failed purges (gbrain doctor: purge_parked_pages), then retried once with gbrain pages purge-deleted --retry-parked`
          : 'retried on the next run'}` });
    }
  }
  if (!run.systemic()) {
    for (const { row, failure } of failures) {
      if (failure.class === 'content') await recordPurgeFailure(engine, { source_id: row.source_id, slug: row.slug, deleted_us: row.deleted_us, code: failure.code, reason: failure.message });
    }
  }
  return out;
}

/** One expired tombstone a managed purge submits, in scan order; `park` is its live failure record, if any. */
export interface PurgeCandidate { source_id: string; slug: string; cutoff: string; deleted_us: string; key: string; park?: PurgePark }

/**
 * #6741 C: what a purge with these options would do, read-only. The one eligibility selector behind the
 * `pages purge-deleted` dry-run preview, its consent request, the `purge_deleted_pages` op and the real purge (the
 * CLI, the cycle phase and the Minion job), so the preview, the consent and the run cannot disagree. The
 * `--older-than` cutoff, the #6729 rename-recovery hold (identityDowngradePurgeHold) and the #7013 restorable-atom hold
 * (atomRetirementPurgeHold) apply to every page, parked
 * or not, so `retryParked` retries only parked pages the cutoff selects and never a held page.
 */
export interface PurgeSelection {
  managed: boolean;
  count: number;
  slugs: string[];
  /** Unmanaged only: the engine's preview rows. */
  pages?: Array<{ slug: string; deleted_at: Date }>;
  candidates: PurgeCandidate[];
  /** Tombstones not submitted: their source's writer needs recovery (`writer_not_active`) or they are parked (`purge_parked`). */
  blocked: DeletedPagePurge['blocked'];
  /** Every parked tombstone the cutoff selects; `retried` when `retryParked` puts it back among the candidates. */
  parked: Array<{ source_id: string; slug: string; failures: number; code: string | null; retried: boolean }>;
  inactive: number;
  /** Per source in the scan: whether its writer passed the owner verification (the park rearm reads it). */
  writers: Record<string, boolean>;
}

export async function selectPurgeCandidates(engine: BrainEngine, olderThanHours: number, opts: { retryParked?: boolean } = {}): Promise<PurgeSelection> {
  if (!await managedPersistenceEnabled(engine)) {
    const parked = (await recordedTombstones(engine, String(Math.max(0, Math.floor(olderThanHours)))))
      .filter((row): row is RecordedTombstone & { park: PurgePark } => !!row.park && row.park.failures >= PURGE_PARK_LIMIT);
    const preview = await engine.purgeDeletedPages(olderThanHours, { dryRun: true, ...(opts.retryParked ? {} : { excludeIds: parked.map(row => row.id) }) });
    return { managed: false, count: preview.count, slugs: preview.slugs, pages: preview.pages, candidates: [],
      blocked: opts.retryParked ? [] : parked.map(row => ({ source_id: row.source_id, slug: row.slug, code: 'purge_parked', reason: parkedReason(row.park) })),
      parked: parked.map(row => ({ source_id: row.source_id, slug: row.slug, failures: row.park.failures, code: row.park.code, retried: opts.retryParked === true })),
      inactive: 0, writers: {} };
  }
  const hours = Math.max(0, Math.floor(olderThanHours));
  const rows = await engine.executeRaw<{ source_id: string; slug: string; cutoff: string; deleted_us: string }>(
    `SELECT p.source_id, p.slug, (now() - ($1 || ' hours')::interval)::text AS cutoff,
      floor(extract(epoch FROM p.deleted_at)*1000000)::bigint::text AS deleted_us FROM pages p JOIN sources s ON s.id = p.source_id
      WHERE p.deleted_at IS NOT NULL AND p.deleted_at < now() - ($1 || ' hours')::interval AND NOT s.archived AND ${identityDowngradePurgeHold('p')} AND ${atomRetirementPurgeHold('p')}
      ORDER BY p.deleted_at ASC, p.source_id ASC, p.slug ASC`, [String(hours)]);
  const states = new Map<string, { state: string; physical_error?: string }>();
  if (rows.length) for (const source of (await writerOnboardingPreflight(engine)).sources) states.set(source.source_id, source);
  const parks = rows.length ? await readPurgeParks(engine) : new Map<string, PurgePark>();
  const selection: PurgeSelection = { managed: true, count: 0, slugs: [], candidates: [], blocked: [], parked: [], inactive: 0, writers: {} };
  for (const row of rows) {
    const writer = states.get(row.source_id);
    const active = writer?.state !== 'recovery_required';
    selection.writers[row.source_id] = active;
    if (!active) {
      selection.inactive++;
      selection.blocked.push({ source_id: row.source_id, slug: row.slug, code: 'writer_not_active', binding_state: writer!.state,
        reason: `Source ${row.source_id}'s writer is ${writer!.state}${writer!.physical_error ? ` (${writer!.physical_error})` : ''}, so the purge submitted nothing; it resumes once gbrain sources writer status --source ${row.source_id} shows the writer ready.` });
      continue;
    }
    const key = purgeParkKey(row.source_id, row.slug, row.deleted_us);
    // A record marked while the writer was not active is dropped by this run (the rearm), so it does not count here.
    const park = parks.get(key)?.inactive_seen ? undefined : parks.get(key);
    if (park && park.failures >= PURGE_PARK_LIMIT) {
      selection.parked.push({ source_id: row.source_id, slug: row.slug, failures: park.failures, code: park.code, retried: opts.retryParked === true });
      if (!opts.retryParked) {
        selection.blocked.push({ source_id: row.source_id, slug: row.slug, code: 'purge_parked', reason: parkedReason(park) });
        continue;
      }
    }
    selection.candidates.push({ ...row, key, ...(park ? { park } : {}) });
  }
  selection.count = selection.candidates.length;
  selection.slugs = selection.candidates.map(candidate => candidate.slug);
  return selection;
}

/**
 * #6741 C: the cycle purge phase's status: a coordinator failure fails it; a source in recovery, a parked page or a capacity deferral (#6884) warns,
 * and so does an unmanaged recorded tombstone whose delete failed (GBRA-130 A-49: `failed` without `error`).
 */
export function purgePhaseStatus(result: DeletedPagePurge): 'ok' | 'warn' | 'fail' {
  return result.error ? 'fail' : result.inactive || result.parked || result.capacity_deferred || result.failed ? 'warn' : 'ok';
}

/** The purge phase summary's note on the pages it did not submit (empty when there are none). */
export function purgePhaseNote(result: DeletedPagePurge): string {
  const parts = [result.inactive ? `${result.inactive} waiting on a writer in recovery` : '', !result.error && result.failed ? `${result.failed} failed (see details)` : '',
    result.parked ? `${result.parked} parked (gbrain doctor: purge_parked_pages)` : '',
    result.capacity_deferred ? `${result.capacity_deferred} deferred to the next run (write capacity in use)` : ''].filter(Boolean);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

/**
 * #5405: hard-delete tombstones older than the recovery window. An unmanaged
 * brain keeps the engine's bulk delete. A managed brain refuses that bulk
 * delete, so each expired tombstone is purged through the coordinator with the
 * trusted-local `delete_page --purge` protocol, bound to the tombstone's
 * revision. Pages in archived sources are left to the source-lifecycle purge.
 * A tombstone that cannot be purged is reported, never forced.
 *
 * #6741 C: each attempt is a new permanent request id, so the selection
 * (selectPurgeCandidates) submits nothing for a source whose writer needs
 * recovery and skips a tombstone that failed PURGE_PARK_LIMIT times (parked,
 * purge-parks.ts); `retryParked` (`gbrain pages purge-deleted --retry-parked`)
 * gives each parked tombstone the cutoff selects one more attempt.
 *
 * #6884: the run submits only while the writer has outstanding-request room
 * (at the background pause line for a background run), so a large backlog
 * no longer turns into thousands of `queue_capacity` failures and parks
 * ahead of interactive writes; the rest is `capacity_deferred` to the next run.
 */
export async function purgeDeletedPagesCoordinated(engine: BrainEngine, olderThanHours: number, opts: { retryParked?: boolean } = {}): Promise<DeletedPagePurge> {
  if (!await managedPersistenceEnabled(engine)) {
    const recorded = await expireRecordedTombstones(engine, olderThanHours, opts.retryParked === true);
    const result = await engine.purgeDeletedPages(olderThanHours, recorded.exclude.length ? { excludeIds: recorded.exclude } : undefined);
    return { slugs: [...recorded.slugs, ...result.slugs], count: recorded.slugs.length + result.count, blocked: recorded.blocked, deferred: 0,
      failed: recorded.failed, inactive: 0, parked: recorded.parked, capacity_deferred: 0 };
  }
  const selection = await selectPurgeCandidates(engine, olderThanHours, opts);
  for (const [sourceId, active] of Object.entries(selection.writers)) await notePurgeSourceWriter(engine, sourceId, active);
  await prunePurgeParks(engine);
  const config = loadConfig() ?? { engine: engine.kind };
  const slugs: string[] = [];
  const blocked: DeletedPagePurge['blocked'] = [...selection.blocked];
  let deferred = 0, failed = 0, capacityDeferred = 0;
  const share = resolveAdmissionOrigin() === 'background' ? await readBackgroundPauseShare(engine) : 1;
  let principal: Awaited<ReturnType<typeof requestPrincipalForContext>> | undefined;
  for (const [index, row] of selection.candidates.entries()) {
    const deferRest = (reason: string) => {
      for (const rest of selection.candidates.slice(index)) blocked.push({ source_id: rest.source_id, slug: rest.slug, code: 'write_capacity_deferred', reason });
      capacityDeferred = selection.candidates.length - index;
    };
    try {
      const ctx: OperationContext = { engine, config, remote: false, sourceId: row.source_id, dryRun: false,
        logger: { info() {}, warn() {}, error() {} } };
      principal ??= await requestPrincipalForContext(ctx);
      const room = await readOutstandingRoom(engine, principal, share);
      if (room.room <= 0) {
        deferRest(`Not submitted: ${room.used} ${room.scope} outstanding write requests are in use, and this run submits only below ${room.limit}${share < 1 ? ` (a background run stops at ${Math.round(share * 100)}% of the cap, persistence.capacity.background_pause_pct)` : ''}; the next run submits it.`);
        break;
      }
      const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id, includeDeleted: true });
      if (!snapshot?.page.deleted_at) continue;
      // Restored and deleted again since the scan: its recovery window restarted.
      if (new Date(snapshot.page.deleted_at).getTime() >= new Date(row.cutoff).getTime()) { deferred++; continue; }
      await submitPageMutation(ctx, { operation: 'delete_page', params: { slug: row.slug, source_id: row.source_id,
        purge: true, retention: true, expected_revision: snapshot.revision, request_id: randomUUID() } });
      slugs.push(row.slug);
      if (row.park) await clearPurgePark(engine, row.key);
    } catch (error) {
      if (isWriteCapacityWait(error)) { deferRest(`Not submitted: ${error.message}; the next run submits it.`); break; }
      const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : null;
      const reason = error instanceof Error ? error.message : String(error);
      if (code && DEFERRAL_CODES.has(code)) deferred++;
      else { failed++; await recordPurgeFailure(engine, { source_id: row.source_id, slug: row.slug, deleted_us: row.deleted_us, code, reason }); }
      blocked.push({ source_id: row.source_id, slug: row.slug, code, reason });
    }
  }
  const failures = blocked.filter(b => !b.code || !DEFERRAL_CODES.has(b.code) && b.code !== 'writer_not_active' && b.code !== 'purge_parked' && b.code !== 'write_capacity_deferred');
  const error = failed > 0 ? { class: 'ManagedPurgeFailed', code: 'managed_purge_failed',
    message: `${failed} expired page(s) could not be purged through the coordinator: ${failures.slice(0, 3)
      .map(b => `${b.source_id}/${b.slug}: ${b.reason}`).join('; ')}` } : undefined;
  const parked = selection.parked.filter(park => !park.retried).length;
  return { slugs, count: slugs.length, blocked, deferred, failed, inactive: selection.inactive, parked, capacity_deferred: capacityDeferred, ...(error ? { error } : {}) };
}
