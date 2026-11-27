import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { agentFix, checkError } from '../check-fix.ts';
import { listSuppressedWrites, type SuppressedWrite } from '../../../core/persistence/refusal-breaker.ts';
import { auditConflictsCommand, FILE_DRIFT_MESSAGE, fileDriftRepairCommand, liveFileDrift, readDriftSkips } from '../../../core/persistence/drift-conflicts.ts';
import { existingLocalHostId } from '../../../core/persistence/identity.ts';
import { isKeepDbSlug } from '../../../core/storage-config.ts';
import { keepDbReceiptCost, readKeepDbPolicy } from '../../../core/repair/keep-db-policy.ts';
import { isStatementTimeout } from '../../../core/persistence/bounded-reads.ts';
import { boundUnknownDetails } from '../bounded-unknown.ts';
import { sortSourcesById } from '../../../core/source-rows.ts';

/** Newest request sequences scanned for drift conflicts (one range read of the unique sequence index). */
const WINDOW = 20_000;
/** Distinct slugs checked live per source; the rest are reported as unchecked. */
const LIVE_LIMIT = 100;
/** #7145: time the read of drift receipts older than the window may take before the check reports them unread. */
const OLDER_READ_MS = 3_000;

/**
 * #6643 (B3): pages whose canonical file differs from the database right now,
 * found from the drift conflict receipts of the newest 20,000 request sequences
 * and checked live on the canonical owner host (at most 100 slugs per source),
 * plus the concept synthesis skips recorded in `dream.concepts.drift_skips`.
 * It measures the drift itself, not conflict-row growth: producers back off
 * before admission, so a drifted page stops adding receipts. Names the
 * read-only audit and the explicit-only `gbrain repair file-drift` preview.
 * #6696 C7: on the owner host it also echoes each source's effective
 * `storage.keep_db` policy (`keep_db_policy`, present only when one is
 * declared): its prefixes, how many of the drifted pages checked here it
 * matches, and their receipt cost (one request each).
 * #6696 (A12): also lists the maintenance writes the refusal breaker holds
 * back (`suppressed`, each with the action that releases it).
 */
export async function maintenanceWriteDriftCheck(engine: BrainEngine, sourceIds?: string[]): Promise<Check> {
  const docs = 'docs/guides/troubleshooting.md#maintenance-write-drift';
  try {
    const sources = sourceIds ?? sortSourcesById(await engine.listAllSources()).map(row => row.id);
    const top = await engine.readMaxRequestSequence();
    const floor = String(Math.max(0, Number(top ?? 0) - WINDOW));
    const skips = await readDriftSkips(engine);
    const hostId = existingLocalHostId();
    const rows = [];
    const policies = [];
    const suppressed: SuppressedWrite[] = [];
    let unchecked = 0;
    const olderUnread: string[] = [];
    for (const sourceId of sources) {
      suppressed.push(...await listSuppressedWrites(engine, sourceId));
      const recent = await engine.listRecentDriftReceiptSlugs(sourceId, floor, FILE_DRIFT_MESSAGE);
      // #7145: a drifted page stops adding receipts, so its only receipts can sit below the window; read them under a time bound.
      let older: Array<{ slug: string }> = [];
      if (floor !== '0') {
        try {
          older = await engine.listOlderDriftReceiptSlugs(sourceId, floor, FILE_DRIFT_MESSAGE, OLDER_READ_MS);
        } catch (error) {
          if (!isStatementTimeout(error)) throw error;
          olderUnread.push(sourceId);
        }
      }
      const candidates = new Set([...recent.map(row => row.slug), ...older.map(row => row.slug)]);
      const candidateCount = Math.max(candidates.size, recent[0]?.total ?? 0) + (older.length > LIVE_LIMIT ? 1 : 0);
      const skipped = Object.keys(skips).filter(key => key.startsWith(`${sourceId}:`)).map(key => key.slice(sourceId.length + 1));
      const drifted = new Set<string>();
      let unknown = 0;
      const live = [...new Set([...candidates, ...skipped])];
      for (const slug of live.slice(0, LIVE_LIMIT)) {
        const state = await liveFileDrift(engine, sourceId, slug);
        if (state.still_present === true) drifted.add(slug);
        else if (state.still_present === null) unknown++;
      }
      const sourceUnchecked = Math.max(0, candidateCount - LIVE_LIMIT, live.length - LIVE_LIMIT);
      unchecked += sourceUnchecked;
      if (drifted.size || skipped.length || unknown || sourceUnchecked) rows.push({ source_id: sourceId, drifted: drifted.size, sample: [...drifted].slice(0, 5),
        concept_skips: skipped.length, unknown, unchecked: sourceUnchecked });
      try {
        const policy = await readKeepDbPolicy(engine, sourceId, hostId);
        const matched = policy ? [...drifted].filter(slug => isKeepDbSlug(slug, policy.keep_db)).length : 0;
        if (policy) policies.push({ ...policy, matched, unchecked: sourceUnchecked, receipt_cost: keepDbReceiptCost(matched) });
      } catch (error) {
        policies.push({ source_id: sourceId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const count = rows.reduce((sum, row) => sum + row.drifted, 0);
    const skipCount = rows.reduce((sum, row) => sum + row.concept_skips, 0);
    const bounded = unchecked > 0 || olderUnread.length > 0;
    const details = { count, concept_skips: skipCount, sources: rows, window_sequences: WINDOW, repair: 'file-drift', docs, suppressed, ...(policies.length ? { keep_db_policy: policies } : {}),
      ...(bounded ? { exact: false, unchecked, live_limit: LIVE_LIMIT, older_unread_sources: olderUnread, older_read_ms: OLDER_READ_MS } : {}) };
    const auditSource = rows.find(row => row.unchecked)?.source_id ?? olderUnread[0] ?? sources[0];
    const boundNote = !bounded ? '' : ` Not every candidate was checked: ${[unchecked ? `${unchecked} slug(s) past the ${LIVE_LIMIT} checked live per source` : '',
      olderUnread.length ? `receipts older than the newest ${WINDOW} request sequences in ${olderUnread.join(', ')} were not read within ${OLDER_READ_MS} ms` : ''].filter(Boolean).join('; ')} (no setting). `
      + `Page through every slug with its live state: ${auditConflictsCommand(auditSource ?? '<id>')} --window 1000000.`;
    const policyNote = policies.map(policy => 'error' in policy ? ` storage.keep_db of ${policy.source_id} could not be read: ${policy.error}`
      : ` storage.keep_db of ${policy.source_id} (${policy.keep_db.join(', ')}) matches ${policy.matched} of them${policy.unchecked ? ` (${policy.unchecked} more not checked here)` : ''}; `
        + `the owner host's managed sync reconciles those whose file is clean and committed with the database copy, one request each (${policy.receipt_cost.lifetime_ids} lifetime id(s), ${policy.receipt_cost.receipt_bytes} receipt bytes).`).join('');
    if (!count && !skipCount && suppressed.length) {
      return { name: 'maintenance_write_drift', status: 'warn', details,
        message: `${suppressed.length} maintenance write(s) are held back after repeated identical refusals (#6696), so they stop adding receipts: `
          + `${suppressed.slice(0, 5).map(row => `${row.source_id}:${row.slug} ${row.error_code} x${row.refusals}${row.cause ? ` (${row.cause})` : ''} -> ${row.exit}`).join('; ')}. `
          + `Each is tried again once its page, planner or write changes, or after a day.${boundNote}`,
        fix: agentFix(['gbrain', 'write-request', '--', suppressed[0]!.last_request_id], 'Read-only: the last refused attempt and what it names.', 'maintenance_write_drift', { docs }) };
    }
    if (!count && !skipCount && bounded) {
      return { name: 'maintenance_write_drift', status: 'warn', details: { ...details, ...boundUnknownDetails(unchecked ? 'rows' : 'time'), limit: unchecked ? LIVE_LIMIT : OLDER_READ_MS },
        message: `Maintenance write drift unknown: no page checked has a canonical file that differs from the database, but the check stopped at its bound.${boundNote}`,
        fix: agentFix(['gbrain', 'sources', 'reconcile', auditSource!, '--brain', 'host', '--audit', '--conflicts', '--window', '1000000', '--json'],
          'Read-only: pages through the conflict receipts grouped by slug, with whether each file still differs.', 'maintenance_write_drift', { docs }) };
    }
    const unknown = rows.reduce((sum, row) => sum + row.unknown, 0);
    if (!count && !skipCount && unknown) {
      return { name: 'maintenance_write_drift', status: 'warn', details: { ...details, health: 'unknown', exact: false }, fix_unavailable_reason: 'operator_judgement',
        message: `Maintenance write drift unknown: no page checked on this host has a canonical file that differs from the database, but ${unknown} could not be checked here (run doctor on the canonical owner host).` };
    }
    if (!count && !skipCount) {
      return { name: 'maintenance_write_drift', status: 'ok', details,
        message: `No page whose writes refuse source_changed still has a canonical file that differs from the database.${policyNote}` };
    }
    const first = rows.find(row => row.drifted || row.concept_skips)!.source_id;
    return { name: 'maintenance_write_drift', status: 'warn', details,
      message: `${bounded ? 'At least ' : ''}${count} page(s) have a canonical file that differs from the database, so every coordinated write to them refuses source_changed `
        + `(${rows.filter(row => row.drifted || row.concept_skips).map(row => `${row.source_id}: ${row.drifted} drifted, ${row.concept_skips} concept skip(s)`).join('; ')}). `
        + `Maintenance now skips them before spending or admitting anything. List them: ${auditConflictsCommand(first)}; preview the resolution: ${fileDriftRepairCommand(first)} (or --prefer database); its apply needs the user's consent (it asks; add --yes only after they agree).${policyNote}${boundNote}`,
      fix: agentFix(['gbrain', 'sources', 'reconcile', first, '--brain', 'host', '--audit', '--conflicts', '--json'],
        'Read-only: lists the conflict receipts grouped by slug, whether each file still differs, its drift class and producer.', 'maintenance_write_drift', { docs }) };
  } catch (error) {
    return checkError('maintenance_write_drift', 'check file/database drift behind conflict receipts', error, { details: { count: 'unknown', docs } });
  }
}
