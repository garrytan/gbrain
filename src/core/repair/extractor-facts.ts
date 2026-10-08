/**
 * `gbrain repair extractor-facts` (#5731, CEO-A9, ENG-O8, DX-O4, DX-T1):
 * restore conversation-extractor facts that the pre-fix canonical projection
 * expired.
 *
 * Before v0.60.11.0 every managed write to a fenceless conversation page ran
 * the canonical facts projection with an empty fence, which expired every
 * extractor fact of that page and cleared its `row_num` in the publication
 * transaction. The fix stopped new expiries; this kind restores the old ones.
 *
 * Candidates: `source` starts with `cli:extract-conversation-facts`,
 * `expired_at` set, `row_num` NULL (the projection's signature), and not
 * retired by `gbrain repair conversation-labels` (its context marker). Each is
 * classified, in this order:
 *   - excluded (listed, never restored): the page is missing or deleted; the
 *     fact was superseded (`superseded_by`, E-T5); its claim was withdrawn
 *     (`fact_withdrawals`); an active fact with the same text and entity already
 *     sits on the page (a fence row or another extractor row); or another
 *     candidate of the page with the same text and entity is restored instead
 *     (the first evidenced one, else the first ambiguous one).
 *   - ambiguous (restored only with `--include-ambiguous` and the hash of that
 *     preview): an unmanaged brain (no receipts); no committed write receipt of
 *     the page completed at the exact expiry instant (`completed_at =
 *     expired_at`, which holds only when both happened in one transaction); the
 *     receipt's consumer is v0.60.11.0 or newer (a fence takeover, not the
 *     defect); or the page ever carried fence-projected facts (a fence row may
 *     have taken the fact's row number).
 *   - evidenced: everything else, restored by `--apply --expect <hash>`.
 *
 * `writer_version_cutoff` marks when consumers began stamping their version,
 * so a receipt with no `consumer_version` was published by a binary older
 * than the stamps, which shipped together with the fix.
 *
 * The preview lists every candidate with its class and evidence, prints a
 * hash over them, and saves the restorable set (one item per page, each with
 * its request id) through `persistence/preview-approval.ts`. The apply replays
 * exactly that set: a managed brain publishes one database-only
 * `managed_maintenance_restore_extractor_facts` request per page; an unmanaged
 * brain writes directly under the page lock. Each fact is reclassified under
 * the lock and restored only when its class, evidence and expiry are
 * unchanged (`changed_since_preview` otherwise). A restored fact gets a fresh
 * `row_num` above every row of its page, so it never looks like an unfenced
 * legacy row. A resumed apply skips pages whose request already committed (or
 * whose facts are already active), so a crash after publication restores no
 * new candidate. A page already passed by this set's cursor (keyed by its
 * approval hash) is not retried,
 * whatever its outcome, so a `--limit` run always advances.
 */
import type { BrainEngine } from '../engine.ts';
import type { PreparedMutation } from '../persistence/coordinator.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { VERSION } from '../../version.ts';
import { opError, OperationError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { parseFactsFence } from '../facts-fence.ts';
import { digest } from '../persistence/digest.ts';
import { isTerminal } from '../persistence/model.ts';
import { getWriteRequest } from '../persistence/journal.ts';
import { authorizeStoredRequest, authorizeWrite } from '../persistence/authority.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import { waitForWrite, writeResponse } from '../persistence/service.ts';
import { maintenancePreflight, submitDatabaseMaintenanceIntent } from '../persistence/prepared-maintenance.ts';
import { compareWriterVersions, recentWriterVersions, writerVersionLabel } from '../persistence/writer-versions.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { afterCursor, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairListing, type RepairPlan, type RepairScope } from './core.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';

export const EXTRACTOR_FACTS_INTENT = 'managed_maintenance_restore_extractor_facts';
export const EXTRACTOR_FACTS_SOURCE_PREFIX = 'cli:extract-conversation-facts';
const extractorPreviewFix = (sourceId: string) => readFix('Previews the extractor-facts repair without changing anything.',
  { argv: ['gbrain', 'repair', 'extractor-facts', '--source', sourceId, '--json'] });

/** The first release whose canonical projection leaves fenceless extractor facts alone. */
export const EXTRACTOR_FACTS_FIX_VERSION = '0.60.11.0';

export type ExtractorFactClass = 'evidenced' | 'ambiguous' | 'excluded';

/**
 * The exact expiry instant as text (UTC, microseconds). Compared as text in
 * SQL: a bound timestamp parameter can lose its microseconds on the way in.
 */
const EXPIRY_TEXT = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** One candidate as the preview showed it; the apply rechecks every field. */
export interface ExtractorFactCandidate {
  id: number;
  source_id: string;
  slug: string;
  class: ExtractorFactClass;
  reason: string;
  /** UTC, microseconds: the exact instant the projection expired it. */
  expired_at: string;
  /** The committed request whose publication expired it, if any. */
  receipt: string | null;
  receipt_consumer: string | null;
  /** Digest of the row's claim, visibility and entity, so an edited row is not restored. */
  fact_hash: string;
}

/** One approved page: its restorable facts and the request id its managed restore uses. */
export interface ExtractorFactsPage {
  source_id: string;
  slug: string;
  page_id: number;
  request_id: string;
  include_ambiguous: boolean;
  /** The preview's source scope; an apply under another scope refuses. */
  scope: string[];
  facts: ExtractorFactCandidate[];
}

interface PageItem extends RepairItem { page: ExtractorFactsPage; hash: string; last: boolean }

interface CandidateRow {
  id: number | string; source_id: string; slug: string; fact: string; visibility: string; entity_slug: string | null;
  superseded: boolean; expired_at: string; page_id: number | string | null; page_deleted: boolean | null;
  withdrawn: boolean; active_duplicate: boolean; fence_history: boolean; fingerprint: string;
  receipt: string | null; receipt_consumer: string | null;
}

/**
 * Every candidate of these sources (or of one page), classified, in (source,
 * page, id) order. Read-only; `managed` is the brain's persistence mode.
 */
export async function classifyExtractorFacts(db: BrainEngine, sourceIds: string[], opts: { managed: boolean; slug?: string }): Promise<ExtractorFactCandidate[]> {
  const rows = await db.executeRaw<CandidateRow>(`
    WITH cand AS (
      SELECT f.id, f.source_id, f.source_markdown_slug AS slug, f.fact, f.visibility, f.entity_slug, f.expired_at AS expired,
             f.superseded_by IS NOT NULL AS superseded, gbrain_fact_fingerprint(f.fact) AS fingerprint
        FROM facts f
       WHERE f.source_id=ANY($1::text[]) AND f.source LIKE '${EXTRACTOR_FACTS_SOURCE_PREFIX}%'
         AND f.expired_at IS NOT NULL AND f.row_num IS NULL AND f.source_markdown_slug IS NOT NULL
         AND COALESCE(f.context, '') NOT LIKE '%retired: conversation-labels%'
         AND ($2::text IS NULL OR f.source_markdown_slug=$2::text)
    ), receipts AS (
      SELECT DISTINCT ON (r.source_id, r.slug, r.completed_at) r.source_id, r.slug, r.completed_at,
             r.request_id::text AS request_id, r.consumer_version
        FROM persistence_requests r
        JOIN (SELECT DISTINCT source_id, slug, expired FROM cand) k
          ON k.source_id=r.source_id AND k.slug=r.slug AND k.expired=r.completed_at
       WHERE r.state='committed'
       ORDER BY r.source_id, r.slug, r.completed_at, r.sequence
    ), fenced AS (
      SELECT DISTINCT g.source_id, g.source_markdown_slug AS slug FROM facts g
        JOIN (SELECT DISTINCT source_id, slug FROM cand) k ON k.source_id=g.source_id AND k.slug=g.source_markdown_slug
       WHERE COALESCE(g.source,'') NOT LIKE '${EXTRACTOR_FACTS_SOURCE_PREFIX}%'
    )
    SELECT c.id, c.source_id, c.slug, c.fact, c.visibility, c.entity_slug, c.superseded, c.fingerprint,
           ${EXPIRY_TEXT('c.expired')} AS expired_at,
           p.id AS page_id, p.deleted_at IS NOT NULL AS page_deleted,
           EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id=c.source_id AND w.visibility=c.visibility
             AND w.fact_hash IN (gbrain_fact_fingerprint(c.fact), gbrain_fact_fingerprint_v1(c.fact))
             AND (w.subject='*' OR w.subject=c.entity_slug)) AS withdrawn,
           EXISTS (SELECT 1 FROM facts a WHERE a.source_id=c.source_id AND a.visibility=c.visibility
             AND gbrain_fact_fingerprint(a.fact)=c.fingerprint AND a.source_markdown_slug=c.slug AND a.expired_at IS NULL
             AND a.entity_slug IS NOT DISTINCT FROM c.entity_slug) AS active_duplicate,
           fenced.slug IS NOT NULL AS fence_history,
           r.request_id AS receipt, r.consumer_version AS receipt_consumer
      FROM cand c
      LEFT JOIN pages p ON p.source_id=c.source_id AND p.slug=c.slug
      LEFT JOIN receipts r ON r.source_id=c.source_id AND r.slug=c.slug AND r.completed_at=c.expired
      LEFT JOIN fenced ON fenced.source_id=c.source_id AND fenced.slug=c.slug
     ORDER BY c.source_id, c.slug, c.id`, [sourceIds, opts.slug ?? null]);
  // One representative per (page, visibility, entity, text): the first evidenced row, else the first ambiguous one.
  const key = (row: CandidateRow) => JSON.stringify([row.source_id, row.slug, row.visibility, row.entity_slug, row.fingerprint]);
  const base = rows.map(row => classify(row, false, opts.managed));
  const representative = new Map<string, number>();
  for (const klass of ['evidenced', 'ambiguous'] as const) {
    rows.forEach((row, i) => { if (base[i][0] === klass && !representative.has(key(row))) representative.set(key(row), i); });
  }
  return rows.map((row, i) => {
    const id = Number(row.id);
    const duplicate = base[i][0] !== 'excluded' && representative.get(key(row)) !== i;
    const [klass, reason] = duplicate ? classify(row, true, opts.managed) : base[i];
    return { id, source_id: row.source_id, slug: row.slug, class: klass, reason, expired_at: row.expired_at,
      receipt: row.receipt, receipt_consumer: row.receipt === null ? null : row.receipt_consumer,
      fact_hash: digest([row.fact, row.visibility, row.entity_slug]) };
  });
}

function classify(row: CandidateRow, duplicate: boolean, managed: boolean): [ExtractorFactClass, string] {
  if (row.page_id === null || row.page_deleted) return ['excluded', 'page_missing'];
  if (row.superseded) return ['excluded', 'superseded'];
  if (row.withdrawn) return ['excluded', 'withdrawn'];
  if (row.active_duplicate) return ['excluded', 'active_duplicate'];
  if (duplicate) return ['excluded', 'duplicate_candidate'];
  if (!managed) return ['ambiguous', 'unmanaged_brain'];
  if (row.receipt === null) return ['ambiguous', 'no_same_transaction_receipt'];
  const order = row.receipt_consumer === null ? -1 : compareWriterVersions(row.receipt_consumer, EXTRACTOR_FACTS_FIX_VERSION);
  if (order === null || order >= 0) return ['ambiguous', 'post_fix_consumer'];
  if (row.fence_history) return ['ambiguous', 'fence_takeover_possible'];
  return ['evidenced', 'pre_fix_projection'];
}

const DETAILS: Record<string, string> = {
  page_missing: 'its conversation page is missing or deleted',
  superseded: 'a newer fact superseded it',
  withdrawn: 'its claim was withdrawn (forget)',
  active_duplicate: 'an active fact with the same text and entity is already on the page',
  duplicate_candidate: 'another candidate of the page with the same text and entity is restored instead',
  unmanaged_brain: 'unmanaged brain: no write receipt can prove the expiry',
  no_same_transaction_receipt: 'no committed write of the page completed at the exact expiry instant',
  post_fix_consumer: 'expired by a write published by a fixed consumer (a fence row may have taken its position)',
  fence_takeover_possible: 'the page has carried fence facts, so a fence row may have taken its position',
};

function detail(fact: ExtractorFactCandidate): string {
  if (fact.class !== 'evidenced') return DETAILS[fact.reason] ?? fact.reason;
  return `expired at ${fact.expired_at} by the pre-fix projection in write ${fact.receipt}, published by ${writerVersionLabel(fact.receipt_consumer)}`;
}

/** The preview command for this scope: `--source` only when the scope is one source of several (what the operator passed). */
async function previewCommand(engine: BrainEngine, scope: RepairScope, includeAmbiguous: boolean): Promise<string> {
  const [{ n }] = await engine.executeRaw<{ n: number | string }>('SELECT count(*)::int AS n FROM sources WHERE archived IS NOT TRUE');
  const narrowed = scope.source_ids.length === 1 && Number(n) > 1;
  return `gbrain repair extractor-facts${narrowed ? ` --source ${scope.source_ids[0]}` : ''}${includeAmbiguous ? ' --include-ambiguous' : ''}`;
}

function requestIdFor(hash: string, page: Pick<ExtractorFactsPage, 'source_id' | 'slug'>, attempt: number): string {
  const h = digest(['extractor-facts-request-v1', hash, page.source_id, page.slug, attempt]);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Hosts whose latest consumer since `writer_version_cutoff` is older than this
 * release: a pre-fix consumer there can expire restored facts again.
 */
async function mixedVersionWarnings(engine: BrainEngine): Promise<string[]> {
  const rows = await recentWriterVersions(engine, 30).catch(() => []);
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows.filter(r => r.role === 'consumer')) {
    const key = `${row.host_id}|${row.principal}`;
    const prior = latest.get(key);
    if (!prior || (row.last_seen ?? '') > (prior.last_seen ?? '')) latest.set(key, row);
  }
  const hosts = new Map<string, string>();
  for (const row of latest.values()) {
    const order = row.version === null ? -1 : compareWriterVersions(row.version, VERSION);
    if (order !== null && order >= 0) continue;
    const host = row.host_id ?? 'unknown (not recorded)';
    if (!hosts.has(host)) hosts.set(host, `${row.version_label}, last seen ${row.last_seen}`);
  }
  return [...hosts].map(([host, seen]) => `host ${host} still published writes with a consumer older than this release (${seen}); `
    + `a consumer older than v${EXTRACTOR_FACTS_FIX_VERSION} expires restored extractor facts again. Upgrade and restart gbrain on that host before applying.`);
}

async function hashParts(engine: BrainEngine, scope: RepairScope, includeAmbiguous: boolean, facts: ExtractorFactCandidate[]) {
  const sources = await engine.executeRaw<{ id: string; incarnation: string }>(
    'SELECT id, incarnation::text AS incarnation FROM sources WHERE id=ANY($1::text[]) ORDER BY id', [scope.source_ids]);
  return { kind: 'extractor-facts-v1', brain_id: scope.brain_id, sources, selection: { source_ids: scope.source_ids, include_ambiguous: includeAmbiguous }, facts };
}

function pageItem(page: ExtractorFactsPage, hash: string, index: number, last: boolean): PageItem {
  return { cursor: { phase: 0, id: index + 1 }, source_id: page.source_id, slug: page.slug, chars: 0,
    action: `restore ${page.facts.length} extractor fact(s)`, page, hash, last };
}

/** Pages of an approved set whose restore already finished (a committed request, or every fact active again). */
async function finishedPages(engine: BrainEngine, hash: string, pages: ExtractorFactsPage[]): Promise<Set<string>> {
  if (!pages.length) return new Set();
  const committed = await engine.executeRaw<{ source_id: string; slug: string }>(`SELECT DISTINCT source_id, slug FROM persistence_requests
    WHERE state='committed' AND operation='submit_job' AND source_id=ANY($1::text[]) AND slug=ANY($2::text[])
      AND (intent->>'preview_hash'=$3 OR request_id=ANY($4::uuid[]))`,
  [[...new Set(pages.map(p => p.source_id))], [...new Set(pages.map(p => p.slug))], hash, pages.map(p => p.request_id)]);
  const active = await engine.executeRaw<{ id: number | string }>(
    'SELECT id FROM facts WHERE id=ANY($1::bigint[]) AND expired_at IS NULL AND row_num IS NOT NULL', [pages.flatMap(p => p.facts.map(f => f.id))]);
  const restored = new Set(active.map(row => Number(row.id)));
  const done = new Set(committed.map(row => `${row.source_id}\u0000${row.slug}`));
  for (const page of pages) if (page.facts.every(f => restored.has(f.id))) done.add(`${page.source_id}\u0000${page.slug}`);
  return done;
}

export const extractorFactsRepair: RepairHandler = {
  kind: 'extractor-facts',
  embeds: false,
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    const includeAmbiguous = opts?.includeAmbiguous === true;
    if (!opts?.apply) {
      const managed = await managedPersistenceEnabled(engine);
      const facts = await classifyExtractorFacts(engine, scope.source_ids, { managed });
      const hash = previewHash(await hashParts(engine, scope, includeAmbiguous, facts));
      const pageIds = new Map((await engine.executeRaw<{ id: number | string; source_id: string; slug: string }>(
        'SELECT id, source_id, slug FROM pages WHERE source_id=ANY($1::text[]) AND slug=ANY($2::text[]) AND deleted_at IS NULL',
        [scope.source_ids, [...new Set(facts.map(f => f.slug))]])).map(row => [`${row.source_id}\u0000${row.slug}`, Number(row.id)]));
      const pages = new Map<string, ExtractorFactsPage>();
      for (const fact of facts) {
        if (fact.class === 'excluded' || fact.class === 'ambiguous' && !includeAmbiguous) continue;
        const key = `${fact.source_id}\u0000${fact.slug}`;
        const page = pages.get(key) ?? { source_id: fact.source_id, slug: fact.slug, page_id: pageIds.get(key)!,
          request_id: requestIdFor(hash, fact, 0), include_ambiguous: includeAmbiguous, scope: scope.source_ids, facts: [] };
        page.facts.push(fact);
        pages.set(key, page);
      }
      const approved = [...pages.values()];
      if (approved.length) await saveApprovedSet(engine, { command: 'extractor-facts', hash }, approved);
      const count = (klass: ExtractorFactClass) => facts.filter(f => f.class === klass).length;
      const listing: RepairListing[] = facts.map(fact => ({ item: `${fact.source_id}:${fact.slug}#${fact.id}`,
        class: fact.class === 'excluded' ? `excluded:${fact.reason}` : fact.class, detail: detail(fact) }));
      return { items: approved.map((page, index) => pageItem(page, hash, index, index === approved.length - 1)), preview_hash: hash,
        residuals: { evidenced: count('evidenced'), ambiguous: count('ambiguous'), excluded: count('excluded') },
        listing, warnings: await mixedVersionWarnings(engine) };
    }
    const command = await previewCommand(engine, scope, includeAmbiguous);
    if (!opts.expect) {
      throw new OperationError('invalid_params', 'gbrain repair extractor-facts --apply restores only the set a preview printed.',
        `Preview first: ${command} — then run the apply command it prints: ${command} --apply --expect <preview-hash>`,
        'docs/guides/repair.md#explicit-only-repair-kinds');
    }
    const approved = await loadApprovedSet<ExtractorFactsPage>(engine, { command: 'extractor-facts', hash: opts.expect, previewCommand: command });
    const scopeKey = JSON.stringify(scope.source_ids);
    if (approved.items.some(page => page.include_ambiguous !== includeAmbiguous || JSON.stringify(page.scope) !== scopeKey)) {
      throw previewChangedError(opts.expect, command);
    }
    // Resume: skip pages the set's cursor (keyed by its approval hash in runRepair) already passed,
    // whatever their outcome, and pages whose restore already finished.
    const done = await finishedPages(engine, opts.expect, approved.items);
    const items = approved.items.map((page, index) => pageItem(page, opts.expect!, index, index === approved.items.length - 1))
      .filter(item => afterCursor(item.cursor, after) && !done.has(`${item.source_id}\u0000${item.slug}`));
    if (!items.length) await clearApprovedSet(engine, { command: 'extractor-facts', hash: opts.expect });
    return { items, preview_hash: opts.expect, residuals: { already_restored_pages: approved.items.length - items.length } };
  },
  async apply(ctx, entry): Promise<RepairItemOutcome> {
    const { page, hash, last } = entry as PageItem;
    const result = await managedPersistenceEnabled(ctx.engine)
      ? await restoreManaged(ctx.engine, ctx.config, page, hash, ctx.writeWaitMs)
      : await maintenanceTransaction(ctx.engine, async tx => {
        await tx.lockPageKeys([{ sourceId: page.source_id, slug: page.slug }]);
        return restorePageFacts(tx, page, false);
      });
    if (last) await clearApprovedSet(ctx.engine, { command: 'extractor-facts', hash });
    const changed = page.facts.length - result.restored.length;
    return { applied: result.restored.length > 0, outcome: !changed ? 'restored' : result.restored.length ? 'partially_restored' : 'changed_since_preview',
      ...(changed ? { reason: `${result.restored.length} of ${page.facts.length} restored; changed since the preview: ${result.changed.join(', ')}` } : {}) };
  },
};

interface RestoreResult { restored: number[]; changed: number[] }

async function restoreManaged(engine: BrainEngine, config: Parameters<typeof waitForWrite>[2], page: ExtractorFactsPage, hash: string,
  writeWaitMs: number | undefined): Promise<RestoreResult> {
  const unchanged: RestoreResult = { restored: [], changed: page.facts.map(f => f.id) };
  const authority = (await maintenancePreflight(engine, page.source_id))!;
  for (let attempt = 0; ; attempt++) {
    const requestId = attempt === 0 ? page.request_id : requestIdFor(hash, page, attempt);
    const prior = await getWriteRequest(engine, authority.writer.principal, requestId);
    if (prior && isTerminal(prior) && prior.state !== 'committed') continue;
    try {
      let receipt: Record<string, unknown>;
      if (prior) {
        await authorizeStoredRequest(engine, prior);
        // #6185: a pending restore replayed by a resumed apply waits like the apply's own writes.
        receipt = writeResponse(await waitForWrite(engine, prior, config, writeWaitMs));
      } else {
        const snapshot = await engine.readPageSnapshot(page.slug, { sourceId: page.source_id });
        if (!snapshot || snapshot.page.id !== page.page_id) return unchanged;
        receipt = await submitDatabaseMaintenanceIntent(engine, authority, page.slug,
          { kind: EXTRACTOR_FACTS_INTENT, expected_revision: snapshot.revision, preview_hash: hash, page }, requestId);
      }
      return { restored: (receipt.restored as number[] | undefined) ?? [], changed: (receipt.changed_since_preview as number[] | undefined) ?? [] };
    } catch (error) {
      if (error instanceof OperationError && ['revision_conflict', 'page_not_found', 'page_identity_changed'].includes(error.code)) return unchanged;
      throw error;
    }
  }
}

/**
 * Restores the page's approved facts that are still exactly as previewed,
 * under the page lock: each gets a fresh row number above every fact and
 * fence row of the page. Runs inside the managed publication or the unmanaged
 * transaction.
 */
async function restorePageFacts(tx: BrainEngine, page: ExtractorFactsPage, managed: boolean): Promise<RestoreResult> {
  const ids = page.facts.map(f => f.id);
  await tx.executeRaw('SELECT id FROM facts WHERE source_id=$1 AND id=ANY($2::bigint[]) FOR UPDATE', [page.source_id, ids]);
  const live = new Map((await classifyExtractorFacts(tx, [page.source_id], { managed, slug: page.slug })).map(f => [f.id, f]));
  const [live_page] = await tx.executeRaw<{ id: number | string; compiled_truth: string | null; max_row: number | string | null }>(
    `SELECT p.id, p.compiled_truth, (SELECT MAX(row_num) FROM facts WHERE source_id=$1 AND source_markdown_slug=$2) AS max_row
       FROM pages p WHERE p.source_id=$1 AND p.slug=$2 AND p.deleted_at IS NULL`, [page.source_id, page.slug]);
  // A page deleted and recreated at the same slug since the preview is another page.
  const snapshot = live_page && Number(live_page.id) === page.page_id ? live_page : undefined;
  const fenceRows = parseFactsFence(snapshot?.compiled_truth ?? '').facts.map(f => f.rowNum);
  let next = Math.max(Number(snapshot?.max_row ?? 0), ...fenceRows, 0) + 1;
  const result: RestoreResult = { restored: [], changed: [] };
  for (const approved of page.facts) {
    const current = live.get(approved.id);
    const same = !!snapshot && !!current && (['class', 'reason', 'expired_at', 'receipt', 'receipt_consumer', 'fact_hash'] as const)
      .every(field => current[field] === approved[field]);
    const updated = same ? await tx.executeRaw(`UPDATE facts SET expired_at=NULL, row_num=$3
      WHERE source_id=$1 AND id=$2 AND row_num IS NULL AND superseded_by IS NULL AND ${EXPIRY_TEXT('expired_at')}=$4 RETURNING id`,
    [page.source_id, approved.id, next, approved.expired_at]) : [];
    if (updated.length) { result.restored.push(approved.id); next++; } else result.changed.push(approved.id);
  }
  return result;
}

/**
 * Preparer for `managed_maintenance_restore_extractor_facts`: a database-only
 * publication on the page key that reclassifies and restores the approved
 * facts of one page, reporting the rest as `changed_since_preview`.
 */
export async function prepareExtractorFactsRestore(engine: BrainEngine, row: WriteRequest): Promise<PreparedMutation> {
  const intent = row.intent as { page?: ExtractorFactsPage; preview_hash?: unknown } | null;
  const page = intent?.page;
  if (!page || page.source_id !== row.source_id || page.slug !== row.slug || typeof intent?.preview_hash !== 'string' || !Array.isArray(page.facts)) {
    throw opError('invalid_params', 'The extractor facts restore intent does not name its page.',
      `Request ${row.request_id} for ${row.slug} in source ${row.source_id} does not name the page and preview it restores, so nothing changed. Preview the repair again and apply the new preview after the user approves.`,
      { fix: extractorPreviewFix(row.source_id) });
  }
  const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id });
  if (!snapshot || snapshot.page.id !== Number(row.page_id)) {
    throw opError('page_identity_changed', 'The conversation page was deleted or replaced before its facts were restored.',
      `Conversation page ${row.slug} in source ${row.source_id} was deleted or replaced after the preview, so request ${row.request_id} restored nothing. Preview the repair again; it reflects the current pages.`,
      { fix: extractorPreviewFix(row.source_id) });
  }
  await authorizeWrite(engine, row.authority, 'submit_job', row.slug);
  return { observedRevision: snapshot.revision, noop: true,
    validate: async tx => { await authorizeWrite(tx, row.authority, 'submit_job', row.slug); },
    apply: async tx => {
      const result = await restorePageFacts(tx, page, true);
      return { status: 'completed', preview_hash: intent!.preview_hash, restored: result.restored, changed_since_preview: result.changed };
    } };
}
