/**
 * `gbrain repair purged-page-facts` (#8859 follow-up): retire facts left active by purges that ran before the #8859 fix.
 *
 * A page-extraction fact filed on no page (`source_markdown_slug` NULL, the page slug as the head of `context`,
 * extractedFromPageSql) used to outlive its page: neither a direct purge nor the retention expiry of a soft-deleted page
 * took it. Those purges are fixed; the rows they left behind stay active and recallable until this repair retires them.
 *
 * Candidates: active page-extraction facts filed on no page whose context head is a page slug (recordedPageSlug) that no
 * page row of the source holds, live or soft-deleted. Each is classified:
 *   - excluded (listed, never retired): the claim was withdrawn, the row is superseded, another fact's `superseded_by`
 *     or an open loop references it;
 *   - evidenced: the page purge ledger (`page_purges`) records a purge of that slug in the source;
 *   - ambiguous: no purge record (a retention purge of a soft-deleted page leaves none, and neither does a rename that
 *     did not carry the facts); retired only with `--include-ambiguous` and that preview's hash.
 *
 * The preview lists every candidate, prints a hash over all of it and saves the approved set. The apply, bound to that
 * hash and the user's consent, expires exactly the approved rows that are still active, unchanged, of the same class
 * and still without a page (expired_at set, row_num cleared, as the fixed purge does); anything else is reported
 * changed_since_preview and kept. Rows are expired, never deleted. A managed brain publishes one database-only
 * request per batch; an unmanaged brain writes under the page keys. Never automatic.
 */
import type { BrainEngine } from '../engine.ts';
import type { PreparedMutation } from '../persistence/coordinator.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { opError, OperationError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { digest } from '../persistence/digest.ts';
import { isTerminal } from '../persistence/model.ts';
import { getWriteRequest } from '../persistence/journal.ts';
import { authorizeStoredRequest, authorizeWrite } from '../persistence/authority.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import { waitForWrite, writeResponse } from '../persistence/service.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import { maintenancePreflight, submitDatabaseMaintenanceIntent } from '../persistence/prepared-maintenance.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { PAGE_EXTRACTION_SOURCE_LIST, contextHeadSql } from '../facts/gone-page-facts.ts';
import { afterCursor, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairListing, type RepairPlan } from './core.ts';

export const PURGED_PAGE_FACTS_INTENT = 'managed_maintenance_expire_purged_page_facts';
/** The request slug of every batch: a dot-led segment, which no page slug may have. */
export const PURGED_PAGE_FACTS_ANCHOR_SLUG = '.maintenance/purged-page-facts';
const BATCH_FACTS = 200;
const COMMAND = 'purged-page-facts' as const;
const DOCS = 'docs/guides/repair.md#purged-page-facts';
const previewFix = (sourceId: string) => readFix('Previews the purged-page-facts repair without changing anything.',
  { argv: ['gbrain', 'repair', COMMAND, '--source', sourceId, '--json'] });

export type PurgedPageFactClass = 'evidenced' | 'ambiguous' | 'excluded';

export interface PurgedPageFact {
  id: number;
  source_id: string;
  /** The gone page's slug (the context head). */
  slug: string;
  class: PurgedPageFactClass;
  reason: string;
  /** Digest of the row's claim, context, entity, visibility and source, so an edited row is not retired. */
  fact_hash: string;
}

interface Approved { source_id: string; include_ambiguous: boolean; scope: string[]; facts: PurgedPageFact[] }
interface BatchItem extends RepairItem { batch: Approved; request_id: string; hash: string; last: boolean }

const HEAD = contextHeadSql('f');
const SOURCES = PAGE_EXTRACTION_SOURCE_LIST.map(s => `'${s}'`).join(', ');
const CANDIDATE_WHERE = `f.source_id = ANY($1::text[]) AND f.expired_at IS NULL AND f.source_markdown_slug IS NULL AND f.source IN (${SOURCES})
     AND strpos(${HEAD}, '/') > 0 AND ${HEAD} !~ '[[:space:]]'
     AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id = f.source_id AND p.slug = ${HEAD})`;
const EXCLUDED_SQL = {
  withdrawn: `EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id = f.source_id AND w.visibility = f.visibility
    AND w.fact_hash IN (gbrain_fact_fingerprint(f.fact), gbrain_fact_fingerprint_v1(f.fact)) AND (w.subject = '*' OR w.subject = f.entity_slug))`,
  superseded: 'f.superseded_by IS NOT NULL',
  referenced: 'EXISTS (SELECT 1 FROM facts g WHERE g.superseded_by = f.id)',
  open_loop: 'EXISTS (SELECT 1 FROM open_loops o WHERE o.fact_id = f.id)',
};
const PURGED_SQL = `EXISTS (SELECT 1 FROM page_purges pp WHERE pp.source_id = f.source_id AND pp.slug = ${HEAD})`;

interface CandidateRow {
  id: number | string; source_id: string; slug: string; fact: string; context: string; entity_slug: string | null; visibility: string; source: string;
  withdrawn: boolean; superseded: boolean; referenced: boolean; open_loop: boolean; purged: boolean;
}

/** Every candidate of these sources (or only these ids), classified, in (source, slug, id) order. Read-only. */
export async function classifyPurgedPageFacts(db: BrainEngine, sourceIds: string[], opts: { ids?: number[] } = {}): Promise<PurgedPageFact[]> {
  const rows = await db.executeRaw<CandidateRow>(`
    SELECT f.id, f.source_id, ${HEAD} AS slug, f.fact, f.context, f.entity_slug, f.visibility, f.source,
           ${EXCLUDED_SQL.withdrawn} AS withdrawn, ${EXCLUDED_SQL.superseded} AS superseded, ${EXCLUDED_SQL.referenced} AS referenced,
           ${EXCLUDED_SQL.open_loop} AS open_loop, ${PURGED_SQL} AS purged
      FROM facts f
     WHERE ${CANDIDATE_WHERE} AND ($2::bigint[] IS NULL OR f.id = ANY($2::bigint[]))
     ORDER BY f.source_id, ${HEAD}, f.id`, [sourceIds, opts.ids ?? null]);
  return rows.map(row => {
    const [klass, reason]: [PurgedPageFactClass, string] = row.withdrawn ? ['excluded', 'withdrawn'] : row.superseded ? ['excluded', 'superseded']
      : row.referenced ? ['excluded', 'superseded_by_reference'] : row.open_loop ? ['excluded', 'open_loop_reference']
      : row.purged ? ['evidenced', 'page_purge_recorded'] : ['ambiguous', 'no_purge_record'];
    return { id: Number(row.id), source_id: row.source_id, slug: row.slug, class: klass, reason,
      fact_hash: digest([row.fact, row.context, row.entity_slug, row.visibility, row.source]) };
  });
}

/** Doctor's bounded count of the retirable candidates by class, capped. Read-only. */
export async function countPurgedPageFacts(db: BrainEngine, sourceIds: string[], cap: number): Promise<{ evidenced: number; ambiguous: number; capped: boolean }> {
  const rows = await db.executeRaw<{ purged: boolean }>(`SELECT ${PURGED_SQL} AS purged FROM facts f
     WHERE ${CANDIDATE_WHERE} AND NOT (${Object.values(EXCLUDED_SQL).join(' OR ')}) LIMIT $2`, [sourceIds, cap + 1]);
  const kept = rows.slice(0, cap);
  return { evidenced: kept.filter(r => r.purged).length, ambiguous: kept.filter(r => !r.purged).length, capped: rows.length > cap };
}

const DETAILS: Record<string, string> = {
  withdrawn: 'its claim was withdrawn (forget)',
  superseded: 'a newer fact superseded it',
  superseded_by_reference: 'another fact names it in superseded_by',
  open_loop_reference: 'an open loop references it (open_loops.fact_id)',
  page_purge_recorded: 'its page was purged (the page purge ledger records the slug) and the purge left it active',
  no_purge_record: 'its page is gone with no purge record (a retention purge of a deleted page, or a rename that did not carry its facts)',
};

async function previewCommand(engine: BrainEngine, sourceIds: string[], includeAmbiguous: boolean): Promise<string> {
  const [{ n }] = await engine.executeRaw<{ n: number | string }>('SELECT count(*)::int AS n FROM sources WHERE archived IS NOT TRUE');
  return `gbrain repair ${COMMAND}${sourceIds.length === 1 && Number(n) > 1 ? ` --source ${sourceIds[0]}` : ''}${includeAmbiguous ? ' --include-ambiguous' : ''}`;
}

function requestIdFor(hash: string, batch: Approved, attempt: number): string {
  const h = digest(['purged-page-facts-batch-v1', hash, batch.source_id, batch.facts.map(f => f.id), attempt]);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function batchItems(batches: Approved[], hash: string): BatchItem[] {
  return batches.map((batch, index) => ({ cursor: { phase: 0, id: index + 1 }, source_id: batch.source_id, slug: batch.facts[0]!.slug, chars: 0,
    action: `retire ${batch.facts.length} fact(s) left by purged page(s)`, batch, request_id: requestIdFor(hash, batch, 0), hash, last: index === batches.length - 1 }));
}

const sourcesOf = (engine: BrainEngine, ids: string[]) => engine.executeRaw<{ id: string; incarnation: string }>(
  'SELECT id, incarnation::text AS incarnation FROM sources WHERE id = ANY($1::text[]) ORDER BY id', [ids]);

export const purgedPageFactsRepair: RepairHandler = {
  kind: COMMAND,
  embeds: false,
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    const includeAmbiguous = opts?.includeAmbiguous === true;
    const command = await previewCommand(engine, scope.source_ids, includeAmbiguous);
    const hashOf = async (facts: PurgedPageFact[]) => previewHash({ kind: 'purged-page-facts-v1', brain_id: scope.brain_id, sources: await sourcesOf(engine, scope.source_ids),
      selection: { source_ids: scope.source_ids, include_ambiguous: includeAmbiguous }, facts });
    if (opts?.apply) {
      if (!opts.expect) {
        throw new OperationError('invalid_params', `gbrain repair ${COMMAND} --apply retires only the set a preview printed.`,
          `Preview first: ${command} — then run the apply command it prints: ${command} --apply --expect <preview-hash> --yes`, DOCS);
      }
      const approved = await loadApprovedSet<Approved>(engine, { command: COMMAND, hash: opts.expect, previewCommand: command, emptyHash: () => hashOf([]) });
      const scopeKey = JSON.stringify(scope.source_ids);
      if (approved.items.some(batch => batch.include_ambiguous !== includeAmbiguous || JSON.stringify(batch.scope) !== scopeKey)) throw previewChangedError(opts.expect, command);
      const items = batchItems(approved.items, opts.expect).filter(item => afterCursor(item.cursor, after));
      if (!items.length) await clearApprovedSet(engine, { command: COMMAND, hash: opts.expect });
      return { items, preview_hash: opts.expect, residuals: {} };
    }
    const facts = await classifyPurgedPageFacts(engine, scope.source_ids);
    const hash = await hashOf(facts);
    const batches: Approved[] = [];
    for (const fact of facts.filter(f => f.class === 'evidenced' || f.class === 'ambiguous' && includeAmbiguous)) {
      const open = batches.at(-1);
      if (open && open.source_id === fact.source_id && open.facts.length < BATCH_FACTS) open.facts.push(fact);
      else batches.push({ source_id: fact.source_id, include_ambiguous: includeAmbiguous, scope: scope.source_ids, facts: [fact] });
    }
    if (batches.length) await saveApprovedSet(engine, { command: COMMAND, hash }, batches);
    const count = (klass: PurgedPageFactClass) => facts.filter(f => f.class === klass).length;
    const listing: RepairListing[] = facts.map(fact => ({ item: `${fact.source_id}:${fact.slug}#${fact.id}`,
      class: fact.class === 'excluded' ? `excluded:${fact.reason}` : fact.class, detail: DETAILS[fact.reason] ?? fact.reason }));
    return { items: batchItems(batches, hash), preview_hash: hash, listing,
      residuals: { evidenced: count('evidenced'), ambiguous: count('ambiguous'), excluded: count('excluded') } };
  },
  async apply(ctx, entry): Promise<RepairItemOutcome> {
    const item = entry as BatchItem;
    const result = await managedPersistenceEnabled(ctx.engine)
      ? await expireManaged(ctx.engine, ctx.config, item, ctx.writeWaitMs)
      : await maintenanceTransaction(ctx.engine, async tx => {
        await tx.lockPageKeys([...new Set(item.batch.facts.map(f => f.slug))].map(slug => ({ sourceId: item.source_id, slug })));
        return expireBatch(tx, item.batch);
      });
    if (item.last) await clearApprovedSet(ctx.engine, { command: COMMAND, hash: item.hash });
    if (!result.expired.length) return { applied: false, outcome: 'changed_since_preview', reason: 'every approved fact changed since the preview' };
    return { applied: true, outcome: 'retired', detail: { retired: result.expired.length, ...(result.changed.length ? { changed_since_preview: result.changed } : {}) } };
  },
};

interface BatchResult { expired: number[]; changed: number[] }

/**
 * Under the batch's page keys: expire each approved fact that is still a candidate of the same class with the same
 * hash (still active, still filed on no page, its page still absent). Nothing outside the approved ids is read for
 * writing.
 */
async function expireBatch(tx: BrainEngine, batch: Approved): Promise<BatchResult> {
  const ids = batch.facts.map(f => f.id);
  await tx.executeRaw('SELECT id FROM facts WHERE source_id = $1 AND id = ANY($2::bigint[]) FOR UPDATE', [batch.source_id, ids]);
  const live = new Map((await classifyPurgedPageFacts(tx, [batch.source_id], { ids })).map(f => [f.id, f]));
  const same = batch.facts.filter(f => { const now = live.get(f.id); return !!now && now.class === f.class && now.fact_hash === f.fact_hash && now.slug === f.slug; });
  const expired = same.length ? (await tx.executeRaw<{ id: number | string }>(
    'UPDATE facts SET expired_at = now(), row_num = NULL WHERE source_id = $1 AND id = ANY($2::bigint[]) AND expired_at IS NULL RETURNING id',
    [batch.source_id, same.map(f => f.id)])).map(r => Number(r.id)) : [];
  const done = new Set(expired);
  return { expired: expired.sort((a, b) => a - b), changed: ids.filter(id => !done.has(id)) };
}

async function expireManaged(engine: BrainEngine, config: Parameters<typeof waitForWrite>[2], item: BatchItem, writeWaitMs: number | undefined): Promise<BatchResult> {
  const authority = (await maintenancePreflight(engine, item.source_id))!;
  for (let attempt = 0; ; attempt++) {
    const requestId = attempt === 0 ? item.request_id : requestIdFor(item.hash, item.batch, attempt);
    const prior = await getWriteRequest(engine, authority.writer.principal, requestId);
    if (prior && isTerminal(prior) && prior.state !== 'committed') continue;
    let receipt: Record<string, unknown>;
    if (prior) {
      await authorizeStoredRequest(engine, prior);
      receipt = writeResponse(await waitForWrite(engine, prior, config, writeWaitMs));
    } else {
      receipt = await submitDatabaseMaintenanceIntent(engine, authority, PURGED_PAGE_FACTS_ANCHOR_SLUG,
        { kind: PURGED_PAGE_FACTS_INTENT, expected_revision: null, preview_hash: item.hash, batch: item.batch }, requestId);
    }
    return { expired: (receipt.expired as number[] | undefined) ?? [], changed: (receipt.changed_since_preview as number[] | undefined) ?? [] };
  }
}

/** Preparer for `managed_maintenance_expire_purged_page_facts`: a database-only batch publication holding every gone page's key. */
export async function preparePurgedPageFactsExpiry(engine: BrainEngine, row: WriteRequest): Promise<PreparedMutation> {
  const batch = (row.intent as { batch?: Approved } | null)?.batch;
  if (row.slug !== PURGED_PAGE_FACTS_ANCHOR_SLUG || !batch || batch.source_id !== row.source_id || !Array.isArray(batch.facts) || !batch.facts.length
    || batch.facts.some(f => !Number.isSafeInteger(f?.id) || typeof f.slug !== 'string' || typeof f.fact_hash !== 'string')) {
    throw opError('invalid_params', 'The purged-page-facts intent does not name its facts.',
      `Request ${row.request_id} in source ${row.source_id} does not name the facts it retires, so nothing changed. Preview the repair again and apply the new preview after the user approves.`,
      { fix: previewFix(row.source_id) });
  }
  const slugs = [...new Set(batch.facts.map(f => f.slug))];
  const authorize = async (db: BrainEngine) => {
    await authorizeWrite(db, row.authority, 'submit_job', row.slug);
    for (const slug of slugs) await authorizeWrite(db, row.authority, 'submit_job', slug);
  };
  await authorize(engine);
  return { observedRevision: null, noop: true, additionalPageKeys: slugs.map(slug => ({ sourceId: row.source_id, slug })), validate: authorize,
    apply: async tx => {
      const result = await expireBatch(tx, batch);
      return { status: 'completed', expired: result.expired, changed_since_preview: result.changed };
    } };
}
