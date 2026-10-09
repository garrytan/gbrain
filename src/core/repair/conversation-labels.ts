/**
 * `gbrain repair conversation-labels` (wave 9 follow-ups, item 2): retire
 * conversation facts the pre-v0.60.69 parser misattributed to meeting-note
 * labels. That parser read `**Date:**`, `**Attendees:**`, `**Summary:**` and
 * the other metadata labels as speakers and, on a page without a date,
 * stamped their turns at 1970-01-01. The parser was fixed, but the stored
 * batches stay "complete" for their content version, so an upgrade never
 * reopens them. This kind makes no model calls.
 *
 * Candidates: active per-segment extractor facts (`source` exactly
 * `cli:extract-conversation-facts`) on live pages whose text carries a bold
 * metadata label line (METADATA_LABELS). Each is classified (Decision 5):
 *   - excluded (kept, listed with the reason): the page's outcome was
 *     recorded by the fixed extractor (`extractor_version` stamp); the claim
 *     was withdrawn; the row is superseded; another fact's `superseded_by`
 *     or an open loop (`open_loops.fact_id`, no FK) references it.
 *   - evidenced: its context carries the epoch segment marker
 *     (`segment 1970-01-01`), which the fixed parser never writes (undated
 *     pages are skipped as not extractable).
 *   - ambiguous: everything else, listed fact by fact; retired only with
 *     `--include-ambiguous` and the hash of that preview.
 *
 * The preview lists every candidate, a per-page outcome and the follow-on
 * work, prints a hash over all of it and saves the approved set (one item
 * per page) through `persistence/preview-approval.ts`. The apply (Decision 4)
 * EXPIRES the approved ids that are still exactly as previewed, appending
 * LABEL_RETIRED_MARKER to their context (history kept; later replacement,
 * orphan cleanup and `repair extractor-facts` leave them alone), expires the
 * page's obsolete completion marker, and for a page the current parser
 * finds not extractable (prose, undated, a single email) writes that
 * durable outcome at no cost. Every other page drops back into the ordinary
 * extraction backlog; the preview and the apply print the hand-off commands
 * (`gbrain extract-conversation-facts --slugs … --dry-run`, then with
 * `--max-cost-usd`). A managed brain publishes one database-only
 * `managed_maintenance_conversation_label_retire` request per page; an
 * unmanaged brain writes under the page lock. Never automatic.
 */
import type { BrainEngine, NewFact } from '../engine.ts';
import type { Page } from '../types.ts';
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
import { METADATA_LABELS } from '../conversation-parser/builtins.ts';
import { parseConversation } from '../conversation-parser/parse.ts';
import { readConversationBodyForParsing } from '../conversation-parser/body.ts';
import { conversationSkip } from '../facts/conversation-skip.ts';
import { LABEL_RETIRED_MARKER } from '../facts/conversation-publication.ts';
import { LEGACY_TERMINAL_AUDIT_SOURCE, NON_EXTRACTABLE_AUDIT_SOURCE, TERMINAL_AUDIT_SOURCE, stampExtractorVersion } from '../facts/audit-sources.ts';
import { afterCursor, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairListing, type RepairPlan, type RepairScope } from './core.ts';

export const CONVERSATION_LABELS_INTENT = 'managed_maintenance_conversation_label_retire';
/** The request slug of every label-retire batch: a dot-led segment, which no page slug may have. */
export const LABELS_ANCHOR_SLUG = '.maintenance/conversation-labels';
/** Pages per label-retire batch request (one receipt, one request id). */
export const LABEL_BATCH_PAGES = 25;
const SEGMENT_SOURCE = 'cli:extract-conversation-facts';
/** The default context the pre-fix extractor wrote for an undated page's segment. */
export const EPOCH_SEGMENT_MARKER = 'segment 1970-01-01';
/** A bold metadata label line, as the pre-fix bold-name-no-time pattern read it (POSIX, case-insensitive). */
const LABEL_LINE_SQL = `(^|\\n)\\*\\*(${METADATA_LABELS.join('|')})[[:space:]]*:\\*\\*`;
const HANDOFF_SLUGS_PER_COMMAND = 50;
const previewFix = (sourceId: string) => readFix('Previews the conversation-labels repair without changing anything; it makes no model calls.',
  { argv: ['gbrain', 'repair', 'conversation-labels', '--source', sourceId, '--json'] });

export type LabelFactClass = 'evidenced' | 'ambiguous' | 'excluded';
export type LabelPageOutcome = 'non_extractable' | 'awaiting_reextraction' | 'cleaned';

export interface LabelFactCandidate {
  id: number;
  source_id: string;
  slug: string;
  class: LabelFactClass;
  reason: string;
  /** Digest of the row's claim, context, entity and visibility, so an edited row is not retired. */
  fact_hash: string;
}

/** One approved page: the facts to retire, the marker to expire and the outcome the current parser decides. */
export interface LabelPage {
  source_id: string;
  slug: string;
  page_id: number;
  include_ambiguous: boolean;
  scope: string[];
  facts: Array<Pick<LabelFactCandidate, 'id' | 'class' | 'reason' | 'fact_hash'>>;
  outcome: LabelPageOutcome;
  /** Not-extractable reason (non_extractable pages) and the parser-input version it was decided for. */
  non_extractable_reason: string | null;
  version_token: string;
  segments: number;
}

interface BatchItem extends RepairItem { pages: LabelPage[]; request_id: string; hash: string; last: boolean }

interface CandidateRow {
  id: number | string; source_id: string; slug: string; fact: string; context: string | null; entity_slug: string | null; visibility: string;
  superseded: boolean; withdrawn: boolean; referenced: boolean; open_loop: boolean; outcome_stamped: boolean;
}

/** Every candidate of these sources (or of one page), classified, in (source, page, id) order. Read-only. */
export async function classifyLabelFacts(db: BrainEngine, sourceIds: string[], opts: { slug?: string } = {}): Promise<LabelFactCandidate[]> {
  const rows = await db.executeRaw<CandidateRow>(`
    SELECT f.id, f.source_id, f.source_markdown_slug AS slug, f.fact, f.context, f.entity_slug, f.visibility,
           f.superseded_by IS NOT NULL AS superseded,
           EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id=f.source_id AND w.visibility=f.visibility
             AND w.fact_hash IN (gbrain_fact_fingerprint(f.fact), gbrain_fact_fingerprint_v1(f.fact))
             AND (w.subject='*' OR w.subject=f.entity_slug)) AS withdrawn,
           EXISTS (SELECT 1 FROM facts g WHERE g.superseded_by=f.id) AS referenced,
           EXISTS (SELECT 1 FROM open_loops o WHERE o.fact_id=f.id) AS open_loop,
           EXISTS (SELECT 1 FROM facts o WHERE o.source_id=f.source_id AND o.source_markdown_slug=f.source_markdown_slug
             AND o.source IN ($3, $4) AND o.expired_at IS NULL AND o.context ~ 'extractor_version=[0-9]+$') AS outcome_stamped
      FROM facts f JOIN pages p ON p.source_id=f.source_id AND p.slug=f.source_markdown_slug AND p.deleted_at IS NULL
     WHERE f.source_id=ANY($1::text[]) AND f.source=$5 AND f.expired_at IS NULL
       AND ($2::text IS NULL OR f.source_markdown_slug=$2::text)
       AND (p.compiled_truth ~* $6 OR COALESCE(p.timeline,'') ~* $6)
     ORDER BY f.source_id, f.source_markdown_slug, f.id`,
  [sourceIds, opts.slug ?? null, TERMINAL_AUDIT_SOURCE, NON_EXTRACTABLE_AUDIT_SOURCE, SEGMENT_SOURCE, LABEL_LINE_SQL]);
  return rows.map(row => {
    const [klass, reason] = classify(row);
    return { id: Number(row.id), source_id: row.source_id, slug: row.slug, class: klass, reason,
      fact_hash: digest([row.fact, row.context, row.entity_slug, row.visibility]) };
  });
}

function classify(row: CandidateRow): [LabelFactClass, string] {
  if (row.outcome_stamped) return ['excluded', 'current_extractor'];
  if (row.withdrawn) return ['excluded', 'withdrawn'];
  if (row.superseded) return ['excluded', 'superseded'];
  if (row.referenced) return ['excluded', 'superseded_by_reference'];
  if (row.open_loop) return ['excluded', 'open_loop_reference'];
  if ((row.context ?? '').includes(EPOCH_SEGMENT_MARKER)) return ['evidenced', 'epoch_segment_context'];
  return ['ambiguous', 'no_epoch_marker'];
}

const DETAILS: Record<string, string> = {
  current_extractor: 'the page was extracted by the fixed parser (its outcome carries extractor_version)',
  withdrawn: 'its claim was withdrawn (forget)',
  superseded: 'a newer fact superseded it',
  superseded_by_reference: 'another fact names it in superseded_by',
  open_loop_reference: 'an open loop references it (open_loops.fact_id)',
  epoch_segment_context: 'its context names a 1970-01-01 segment, which only the pre-fix parser wrote',
  no_epoch_marker: 'its page has meeting-note labels, but nothing on the row proves the label misattribution',
};

/** What the current parser decides for the page at no cost: a durable not-extractable reason, or null (it needs extraction). */
async function currentOutcome(db: BrainEngine, page: Page): Promise<{ reason: string | null; versionToken: string; segments: number }> {
  const { currentConversationVersionToken, splitIntoSegments } = await import('../../commands/extract-conversation-facts.ts');
  const body = await readConversationBodyForParsing(db, page);
  const parse = parseConversation(body, { page });
  const llmFallback = (await db.getConfig('conversation_parser.llm_fallback_enabled')) === 'true';
  const skip = conversationSkip(page, body, parse, parse.messages, { llmFallback });
  return { reason: skip?.reason ?? null, versionToken: await currentConversationVersionToken(db, page),
    segments: skip ? 0 : splitIntoSegments(parse.messages, {}).length };
}

async function activeMarker(db: BrainEngine, sourceId: string, slug: string): Promise<boolean> {
  const rows = await db.executeRaw('SELECT 1 FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND source IN ($3,$4) AND expired_at IS NULL LIMIT 1',
    [sourceId, slug, TERMINAL_AUDIT_SOURCE, LEGACY_TERMINAL_AUDIT_SOURCE]);
  return rows.length > 0;
}

function requestIdFor(hash: string, pages: Array<Pick<LabelPage, 'source_id' | 'slug'>>, attempt: number): string {
  const h = digest(['conversation-labels-batch-v1', hash, pages.map(p => `${p.source_id}\u0000${p.slug}`), attempt]);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function previewCommand(engine: BrainEngine, scope: RepairScope, includeAmbiguous: boolean): Promise<string> {
  const [{ n }] = await engine.executeRaw<{ n: number | string }>('SELECT count(*)::int AS n FROM sources WHERE archived IS NOT TRUE');
  const narrowed = scope.source_ids.length === 1 && Number(n) > 1;
  return `gbrain repair conversation-labels${narrowed ? ` --source ${scope.source_ids[0]}` : ''}${includeAmbiguous ? ' --include-ambiguous' : ''}`;
}

/**
 * The commands that re-extract the pages awaiting extraction, under the
 * extraction command's own cost cap: a dry run first, then the run. Each
 * names at most HANDOFF_SLUGS_PER_COMMAND pages.
 */
export function handoffCommands(pages: Array<Pick<LabelPage, 'source_id' | 'slug' | 'outcome'>>): string[] {
  const bySource = new Map<string, string[]>();
  for (const page of pages) if (page.outcome === 'awaiting_reextraction') bySource.set(page.source_id, [...bySource.get(page.source_id) ?? [], page.slug]);
  const commands: string[] = [];
  for (const [sourceId, slugs] of bySource) {
    for (let i = 0; i < slugs.length; i += HANDOFF_SLUGS_PER_COMMAND) {
      const base = `gbrain extract-conversation-facts --source-id ${sourceId} --slugs ${slugs.slice(i, i + HANDOFF_SLUGS_PER_COMMAND).join(',')}`;
      commands.push(`${base} --dry-run`, `${base} --max-cost-usd <n>`);
    }
  }
  return commands;
}

/** The approved pages as batch items: up to LABEL_BATCH_PAGES pages of one source per item, in approved order. */
function batchItems(pages: LabelPage[], hash: string): BatchItem[] {
  const batches: LabelPage[][] = [];
  for (const page of pages) {
    const open = batches.at(-1);
    if (open && open.length < LABEL_BATCH_PAGES && open[0]!.source_id === page.source_id) open.push(page); else batches.push([page]);
  }
  return batches.map((batch, index) => ({ cursor: { phase: 0, id: index + 1 }, source_id: batch[0]!.source_id, slug: batch[0]!.slug, chars: 0,
    action: `retire ${batch.reduce((n, p) => n + p.facts.length, 0)} label-misattributed fact(s) on ${batch.length} page(s)`,
    pages: batch, request_id: requestIdFor(hash, batch, 0), hash, last: index === batches.length - 1 }));
}

/** Batches of an approved set whose retirement already committed (or whose facts are all expired already). */
async function finishedBatches(engine: BrainEngine, items: BatchItem[]): Promise<Set<string>> {
  if (!items.length) return new Set();
  const committed = new Set((await engine.executeRaw<{ request_id: string }>(`SELECT request_id::text AS request_id FROM persistence_requests
    WHERE state='committed' AND operation='submit_job' AND request_id=ANY($1::uuid[])`, [items.map(item => item.request_id)])).map(row => row.request_id));
  const active = new Set((await engine.executeRaw<{ id: number | string }>('SELECT id FROM facts WHERE id=ANY($1::bigint[]) AND expired_at IS NULL',
    [items.flatMap(item => item.pages.flatMap(p => p.facts.map(f => f.id)))])).map(row => Number(row.id)));
  return new Set(items.filter(item => committed.has(item.request_id) || item.pages.every(p => p.facts.every(f => !active.has(f.id)))).map(item => item.request_id));
}

export const conversationLabelsRepair: RepairHandler = {
  kind: 'conversation-labels',
  embeds: false,
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    const includeAmbiguous = opts?.includeAmbiguous === true;
    const command = await previewCommand(engine, scope, includeAmbiguous);
    if (opts?.apply) {
      if (!opts.expect) {
        throw new OperationError('invalid_params', 'gbrain repair conversation-labels --apply retires only the set a preview printed.',
          `Preview first: ${command} — then run the apply command it prints: ${command} --apply --expect <preview-hash>`,
          'docs/guides/repair.md#conversation-labels');
      }
      const approved = await loadApprovedSet<LabelPage>(engine, { command: 'conversation-labels', hash: opts.expect, previewCommand: command });
      const scopeKey = JSON.stringify(scope.source_ids);
      if (approved.items.some(page => page.include_ambiguous !== includeAmbiguous || JSON.stringify(page.scope) !== scopeKey)) {
        throw previewChangedError(opts.expect, command);
      }
      const all = batchItems(approved.items, opts.expect);
      const done = await finishedBatches(engine, all);
      const items = all.filter(item => afterCursor(item.cursor, after) && !done.has(item.request_id));
      if (!items.length) await clearApprovedSet(engine, { command: 'conversation-labels', hash: opts.expect });
      return { items, preview_hash: opts.expect, residuals: { already_retired_pages: all.filter(item => done.has(item.request_id)).reduce((n, item) => n + item.pages.length, 0) },
        details: { handoff: handoffCommands(approved.items) } };
    }
    const facts = await classifyLabelFacts(engine, scope.source_ids);
    const selected = facts.filter(fact => fact.class === 'evidenced' || fact.class === 'ambiguous' && includeAmbiguous);
    const pages = new Map<string, LabelPage>();
    for (const fact of selected) {
      const key = `${fact.source_id}\u0000${fact.slug}`;
      let page = pages.get(key);
      if (!page) {
        const current = (await engine.getPage(fact.slug, { sourceId: fact.source_id }))!;
        const decided = await currentOutcome(engine, current);
        page = { source_id: fact.source_id, slug: fact.slug, page_id: current.id, include_ambiguous: includeAmbiguous, scope: scope.source_ids,
          facts: [], outcome: decided.reason ? 'non_extractable' : await activeMarker(engine, fact.source_id, fact.slug) ? 'awaiting_reextraction' : 'cleaned',
          non_extractable_reason: decided.reason, version_token: decided.versionToken, segments: decided.segments };
        pages.set(key, page);
      }
      page.facts.push({ id: fact.id, class: fact.class, reason: fact.reason, fact_hash: fact.fact_hash });
    }
    const sources = await engine.executeRaw<{ id: string; incarnation: string }>(
      'SELECT id, incarnation::text AS incarnation FROM sources WHERE id=ANY($1::text[]) ORDER BY id', [scope.source_ids]);
    const hash = previewHash({ kind: 'conversation-labels-v1', brain_id: scope.brain_id, sources, selection: { source_ids: scope.source_ids, include_ambiguous: includeAmbiguous },
      facts, pages: [...pages.values()] });
    const approved = [...pages.values()];
    if (approved.length) await saveApprovedSet(engine, { command: 'conversation-labels', hash }, approved);
    const count = (klass: LabelFactClass) => facts.filter(f => f.class === klass).length;
    const awaiting = approved.filter(p => p.outcome === 'awaiting_reextraction');
    const listing: RepairListing[] = facts.map(fact => ({ item: `${fact.source_id}:${fact.slug}#${fact.id}`,
      class: fact.class === 'excluded' ? `excluded:${fact.reason}` : fact.class, detail: DETAILS[fact.reason] ?? fact.reason }));
    return {
      items: batchItems(approved, hash), preview_hash: hash, listing,
      residuals: { evidenced: count('evidenced'), ambiguous: count('ambiguous'), excluded: count('excluded'),
        non_extractable_pages: approved.filter(p => p.outcome === 'non_extractable').length, awaiting_reextraction_pages: awaiting.length,
        awaiting_segments: awaiting.reduce((n, p) => n + p.segments, 0) },
      warnings: ['This command makes no model calls.'],
      details: { pages: approved.map(({ source_id, slug, outcome, facts: rows, segments, non_extractable_reason }) =>
        ({ source_id, slug, outcome, facts: rows.length, segments, ...(non_extractable_reason ? { reason: non_extractable_reason } : {}) })),
      handoff: handoffCommands(approved) },
    };
  },
  async apply(ctx, entry): Promise<RepairItemOutcome> {
    const item = entry as BatchItem;
    const result = await managedPersistenceEnabled(ctx.engine)
      ? await retireManaged(ctx.engine, ctx.config, item, ctx.writeWaitMs)
      : await maintenanceTransaction(ctx.engine, async tx => {
        await tx.lockPageKeys(item.pages.map(page => ({ sourceId: page.source_id, slug: page.slug })));
        return retireBatch(tx, item.pages, item.hash);
      });
    if (item.last) await clearApprovedSet(ctx.engine, { command: 'conversation-labels', hash: item.hash });
    if (!result.retired.length) return { applied: false, outcome: 'changed_since_preview', reason: 'every approved fact changed since the preview' };
    return { applied: true, outcome: 'retired', detail: { retired: result.retired.length, pages: result.pages,
      ...(result.changed.length ? { changed_since_preview: result.changed } : {}) } };
  },
  render(details) {
    const lines: string[] = [];
    for (const p of (details.pages ?? []) as Array<{ source_id: string; slug: string; outcome: string; facts: number; segments: number; reason?: string }>) {
      lines.push(`  ${p.source_id}:${p.slug}: retire ${p.facts} fact(s); ${p.outcome}${p.reason ? ` (${p.reason}, $0)` : p.outcome === 'awaiting_reextraction' ? ` (${p.segments} segment(s) at the next extraction)` : ''}`);
    }
    const handoff = (details.handoff ?? []) as string[];
    if (handoff.length) {
      lines.push('  This command makes no model calls. Pages awaiting re-extraction re-enter the ordinary backlog; re-extract them under the extraction cost cap '
        + '(--max-cost-usd, default $5; or the opt-in cycle.conversation_facts_backfill at $1 per run), previewing first:');
      for (const command of handoff) lines.push(`    ${command}`);
    }
    return lines;
  },
};

interface RetireResult { retired: number[]; changed: number[]; outcome: LabelPageOutcome }
interface BatchResult { retired: number[]; changed: number[]; pages: Record<string, LabelPageOutcome | 'changed_since_preview'> }

/** Every page of one batch under its lock (the caller holds every page key). */
async function retireBatch(tx: BrainEngine, pages: LabelPage[], hash: string): Promise<BatchResult> {
  const result: BatchResult = { retired: [], changed: [], pages: {} };
  for (const page of pages) {
    const one = await retirePageFacts(tx, page, hash);
    result.retired.push(...one.retired);
    result.changed.push(...one.changed);
    result.pages[page.slug] = one.retired.length ? one.outcome : 'changed_since_preview';
  }
  return result;
}

async function retireManaged(engine: BrainEngine, config: Parameters<typeof waitForWrite>[2], item: BatchItem,
  writeWaitMs: number | undefined): Promise<BatchResult> {
  const authority = (await maintenancePreflight(engine, item.source_id))!;
  for (let attempt = 0; ; attempt++) {
    const requestId = attempt === 0 ? item.request_id : requestIdFor(item.hash, item.pages, attempt);
    const prior = await getWriteRequest(engine, authority.writer.principal, requestId);
    if (prior && isTerminal(prior) && prior.state !== 'committed') continue;
    let receipt: Record<string, unknown>;
    if (prior) {
      await authorizeStoredRequest(engine, prior);
      receipt = writeResponse(await waitForWrite(engine, prior, config, writeWaitMs));
    } else {
      receipt = await submitDatabaseMaintenanceIntent(engine, authority, LABELS_ANCHOR_SLUG,
        { kind: CONVERSATION_LABELS_INTENT, expected_revision: null, preview_hash: item.hash, pages: item.pages }, requestId);
    }
    return { retired: (receipt.retired as number[] | undefined) ?? [], changed: (receipt.changed_since_preview as number[] | undefined) ?? [],
      pages: (receipt.pages as BatchResult['pages'] | undefined) ?? {} };
  }
}

/**
 * Under the page lock: expire the approved facts still exactly as previewed,
 * then the page's completion marker, then write the not-extractable outcome
 * when the page is still at the parser input the preview decided it for.
 */
async function retirePageFacts(tx: BrainEngine, page: LabelPage, hash: string): Promise<RetireResult> {
  const ids = page.facts.map(f => f.id);
  await tx.executeRaw('SELECT id FROM facts WHERE source_id=$1 AND id=ANY($2::bigint[]) FOR UPDATE', [page.source_id, ids]);
  const live = new Map((await classifyLabelFacts(tx, [page.source_id], { slug: page.slug })).map(f => [f.id, f]));
  const current = await tx.getPage(page.slug, { sourceId: page.source_id });
  const result: RetireResult = { retired: [], changed: [], outcome: page.outcome };
  const marker = `${LABEL_RETIRED_MARKER} ${hash.slice(0, 12)}`;
  for (const approved of page.facts) {
    const now = live.get(approved.id);
    const same = !!current && current.id === page.page_id && !!now && now.class === approved.class && now.fact_hash === approved.fact_hash;
    const updated = same ? await tx.executeRaw(`UPDATE facts SET expired_at=now(), context=concat_ws(' | ', NULLIF(context, ''), $3::text)
      WHERE source_id=$1 AND id=$2 AND expired_at IS NULL RETURNING id`, [page.source_id, approved.id, marker]) : [];
    if (updated.length) result.retired.push(approved.id); else result.changed.push(approved.id);
  }
  if (!result.retired.length || !current) return result;
  await tx.executeRaw(`UPDATE facts SET expired_at=now() WHERE source_id=$1 AND source_markdown_slug=$2 AND source IN ($3,$4) AND expired_at IS NULL`,
    [page.source_id, page.slug, TERMINAL_AUDIT_SOURCE, LEGACY_TERMINAL_AUDIT_SOURCE]);
  if (page.outcome !== 'non_extractable') return result;
  const decided = await currentOutcome(tx, current);
  if (!decided.reason || decided.versionToken !== page.version_token) return { ...result, outcome: 'awaiting_reextraction' };
  await tx.executeRaw(`UPDATE facts SET expired_at=now() WHERE source_id=$1 AND source_markdown_slug=$2 AND source=$3 AND expired_at IS NULL`,
    [page.source_id, page.slug, NON_EXTRACTABLE_AUDIT_SOURCE]);
  const [top] = await tx.executeRaw<{ n: number | string | null }>('SELECT max(row_num) AS n FROM facts WHERE source_id=$1 AND source_markdown_slug=$2', [page.source_id, page.slug]);
  const outcome: NewFact & { row_num: number; source_markdown_slug: string } = { fact: 'EXTRACTION_NOT_APPLICABLE', kind: 'fact', entity_slug: null,
    source: NON_EXTRACTABLE_AUDIT_SOURCE, source_session: `${NON_EXTRACTABLE_AUDIT_SOURCE}:${page.slug}:${decided.versionToken}`, confidence: 1.0, notability: 'low',
    context: stampExtractorVersion(`scanned, not extractable: ${decided.reason}`), row_num: top?.n == null ? 0 : Number(top.n) + 1, source_markdown_slug: page.slug };
  const { inserted } = await tx.insertFacts([outcome], { source_id: page.source_id }); // gbrain-allow-direct-insert: the durable not-extractable outcome a label repair writes under the page lock (inside its receipted publication on a managed brain)
  if (inserted !== 1) throw opError('storage_error', 'The not-extractable outcome was not written; nothing on the page changed.',
    `The repair of ${page.slug} in source ${page.source_id} could not insert its not-extractable outcome, so the transaction rolled back. Preview the repair again.`,
    { fix: previewFix(page.source_id) });
  return result;
}

/** Preparer for `managed_maintenance_conversation_label_retire`: a database-only batch publication holding every page's key. */
export async function prepareConversationLabelRetirement(engine: BrainEngine, row: WriteRequest): Promise<PreparedMutation> {
  const intent = row.intent as { pages?: LabelPage[]; preview_hash?: unknown } | null;
  const pages = intent?.pages;
  if (row.slug !== LABELS_ANCHOR_SLUG || !Array.isArray(pages) || !pages.length || typeof intent?.preview_hash !== 'string'
    || pages.some(page => page?.source_id !== row.source_id || typeof page.slug !== 'string' || !Array.isArray(page.facts))) {
    throw opError('invalid_params', 'The conversation-labels intent does not name its pages.',
      `Request ${row.request_id} in source ${row.source_id} does not name the pages and preview it retires, so nothing changed. Preview the repair again and apply the new preview after the user approves.`,
      { fix: previewFix(row.source_id) });
  }
  const authorize = async (db: BrainEngine) => {
    await authorizeWrite(db, row.authority, 'submit_job', row.slug);
    for (const page of pages) await authorizeWrite(db, row.authority, 'submit_job', page.slug);
  };
  await authorize(engine);
  const hash = intent!.preview_hash as string;
  return { observedRevision: null, noop: true, additionalPageKeys: pages.map(page => ({ sourceId: row.source_id, slug: page.slug })),
    validate: authorize,
    apply: async tx => {
      const result = await retireBatch(tx, pages, hash);
      return { status: 'completed', preview_hash: hash, retired: result.retired, changed_since_preview: result.changed, pages: result.pages };
    } };
}

/** Doctor's bounded count of the default (evidenced) set: the classification's exclusions applied in SQL, capped. */
export async function countLabelFacts(db: BrainEngine, sourceIds: string[], cap: number): Promise<{ count: number; capped: boolean }> {
  const rows = await db.executeRaw<{ id: number }>(`SELECT f.id FROM facts f
      JOIN pages p ON p.source_id=f.source_id AND p.slug=f.source_markdown_slug AND p.deleted_at IS NULL
     WHERE f.source_id=ANY($1::text[]) AND f.source LIKE 'cli:extract-conversation-facts%' AND f.source=$2 AND f.expired_at IS NULL
       AND f.context LIKE $3 AND (p.compiled_truth ~* $4 OR COALESCE(p.timeline,'') ~* $4)
       AND NOT EXISTS (SELECT 1 FROM facts o WHERE o.source_id=f.source_id AND o.source_markdown_slug=f.source_markdown_slug
         AND o.source IN ($6, $7) AND o.expired_at IS NULL AND o.context ~ 'extractor_version=[0-9]+$')
       AND f.superseded_by IS NULL AND NOT EXISTS (SELECT 1 FROM facts g WHERE g.superseded_by=f.id)
       AND NOT EXISTS (SELECT 1 FROM open_loops l WHERE l.fact_id=f.id)
       AND NOT EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id=f.source_id AND w.visibility=f.visibility
         AND w.fact_hash IN (gbrain_fact_fingerprint(f.fact), gbrain_fact_fingerprint_v1(f.fact)) AND (w.subject='*' OR w.subject=f.entity_slug))
     LIMIT $5`, [sourceIds, SEGMENT_SOURCE, `%${EPOCH_SEGMENT_MARKER}%`, LABEL_LINE_SQL, cap + 1, TERMINAL_AUDIT_SOURCE, NON_EXTRACTABLE_AUDIT_SOURCE]);
  return { count: Math.min(rows.length, cap), capped: rows.length > cap };
}

