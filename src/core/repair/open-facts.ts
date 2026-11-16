/**
 * `gbrain repair open-facts` (Discussion #8194): opens facts stamped private before `facts.default_visibility world`.
 * Operator-only (the trusted local CLI on the brain host; remote callers and member mode are refused), explicit-only
 * (never from `--all`, the doctor or the remediation plan) and preview-bound.
 *
 * The preview lists one window of active private facts of one source created before `--created-before` (required), in
 * fact id order after `--after <id>` (`--limit`, default OPEN_FACTS_WINDOW), by class:
 *   fenced              a row of a page's `## Facts` fence
 *   unfenced            a database-only row held on a page
 *   unpaged:<lane>      a row with no holding page, or from a transcript lane (conversation extraction, capture hooks,
 *                       connectors); listed apart and opened only when the operator names the lane with --class
 * and counts every private fact of the selection by the reason it is left alone (openFactsReasonSql, one SQL expression
 * shared by the preview and the locked apply): expired, superseded, a member page, withdrawn or purged at any visibility,
 * a trust contest (any pending proposal; a rejected or undone widening), a holding, provenance or entity page that is
 * derivation-private (the tighten repair's own predicate, tested against every page row with the slug, deleted or not),
 * a missing holding page, an unresolved provenance slug (fail closed), or a quarantined page. Because the exclusion is
 * the tighten repair's predicate, `gbrain repair visibility` never plans to close what this opened.
 *
 * `--apply --expect <hash>` opens exactly the previewed window; a fact that became eligible inside it since refuses
 * `preview_changed`. Every write locks the holding, provenance and entity pages FOR SHARE and rechecks each fact under
 * its row lock, so a page flipped private meanwhile keeps its fact private. Database-only rows change in place (a managed
 * brain: the OPEN_FACTS_INTENT maintenance request; otherwise a maintenance transaction). A fenced row is opened by the
 * label-only door with its cell set to world (strikeFenceRow): on a managed brain the publication names the rows
 * (`open_facts`) and its projection runs under withOpenFacts, so fence-guard moves each row to world in place with its id
 * and tier; elsewhere the page import does not re-project the fence, so the row is opened in place in the same
 * transaction, before a file in the source's checkout is written, and a row the locked recheck keeps private rolls the
 * whole page write back (`revision_conflict`). Anything not opened is reported `fact_left_private` with its reason and next step, never as applied.
 *
 * Every write is recorded ahead in the CLI's ledger (an `intent` line, then a `committed` line naming the facts it
 * changed). `--undo <ledger>` previews the facts the ledger opened that are still world and unchanged (skipping one
 * since expired, superseded, edited or gone) and re-privates exactly those on --apply --expect. Undo restores the label,
 * not what remote callers already read.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { strikeFenceRow } from '../facts/forget.ts';
import { opError, OperationError, type OperationContext } from '../ops/contract.ts';
import { trustedCliRequired } from '../ops/op-fix.ts';
import { MEMBER_PAGE_PREFIX } from '../access/member-facts.ts';
import { quarantineFilterFragment } from '../quarantine.ts';
import { derivationPrivateSql } from '../search/private-visibility.ts';
import { isSegmentedPage } from '../page-body/page-shape.ts';
import { authorizeWrite } from '../persistence/authority.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import { withOpenFacts } from '../persistence/context.ts';
import type { PreparedMutation } from '../persistence/coordinator.ts';
import { digest } from '../persistence/digest.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import { maintenancePreflight, publishMaintenancePage, submitDatabaseMaintenanceIntent } from '../persistence/prepared-maintenance.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { filesInCheckout, importAtRevision, labelFileRefusal, writeLabelFile } from './label-write.ts';
import { factProvenanceSlugSql, PLAN_STATEMENT_MS } from './visibility.ts';
import { afterCursor, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairPlan, type RepairPlanOptions, type RepairScope } from './core.ts';

export const OPEN_FACTS_INTENT = 'managed_maintenance_open_fact_visibility';
/** Facts one preview lists and one `--apply --expect` opens (`--limit` sets it, up to OPEN_FACTS_WINDOW_MAX). */
export const OPEN_FACTS_WINDOW = 1000;
export const OPEN_FACTS_WINDOW_MAX = 10_000;
export const OPEN_FACTS_DEFAULT_CLASSES: readonly string[] = ['fenced', 'unfenced'];
/** Ids one database-only write carries. */
const GROUP_MAX = 500;
/** The slug a database-only write of facts with no holding page is admitted under. */
const UNPAGED_SLUG = 'memory/unattributed';
const bounded = { timeoutMs: PLAN_STATEMENT_MS };

/** One ledger line: `intent` before a write, `committed` after it with the facts it changed. */
export interface OpenFactsLedgerLine { at: string; brain_id: string; source_id: string; hash: string; request_id: string; action: 'open' | 'close'; phase: 'intent' | 'committed';
  facts: Array<{ id: number; row_num: number | null; slug: string | null; fact_md5: string }> }
/** The undo ledger the CLI keeps (src/commands/repair-open-facts.ts): its path, parsed lines (untrusted) and the append. */
export interface OpenFactsLedger { path: string; lines: unknown[]; unreadable: number; record(line: OpenFactsLedgerLine): void }
/** What the CLI parsed for this kind. `undo`: the ledger path whose opened facts the run re-privates. */
export interface OpenFactsRequest { createdBefore?: string; ids?: number[]; idsFile?: string; classes: string[]; undo?: string; ledger: OpenFactsLedger }

interface Selection { source_id: string; created_before: string | null; classes: string[]; ids: number[] | null; ids_file: string | null; after: number; undo: string | null }
interface FactRef { id: number; row_num: number | null; fact: string; holder: string | null }
/** One write: the facts of one page's fence (`fence`), or database-only facts held on one slug. */
interface Group { mode: 'open' | 'close'; source_id: string; slug: string; fence: boolean; cls: string; facts: FactRef[]; selection: Selection; upper: number | null }
interface OpenItem extends RepairItem { group: Group; hash: string; ledger: OpenFactsLedger; brain_id: string }
interface PlannedRow extends FactRef { cls: string; fence: boolean }

const TRANSCRIPT_LANES = (f: string) => `(${f}.source LIKE 'cli:extract-conversation-facts%' OR ${f}.source IN ('hook:writeback', 'hook:compact', 'sweep:corpus')
  OR ${f}.source LIKE 'transcript:%' OR ${f}.source LIKE 'connector:%')`;

/** A fact's class: unpaged:<lane> (no holding page, or a transcript lane), fenced, or unfenced. */
export const openFactClassSql = (f: string) => `(CASE WHEN ${f}.source_markdown_slug IS NULL OR ${TRANSCRIPT_LANES(f)} THEN 'unpaged:' || COALESCE(NULLIF(${f}.source, ''), 'unknown')
  WHEN ${f}.row_num IS NOT NULL THEN 'fenced' ELSE 'unfenced' END)`;

/** Any page row with the slug (deleted or not) that is derivation-private. */
const anyPrivatePage = (f: string, slug: string, alias: string) =>
  `EXISTS (SELECT 1 FROM pages ${alias} WHERE ${alias}.source_id = ${f}.source_id AND ${alias}.slug = ${slug} AND ${derivationPrivateSql(alias)})`;
const livePage = (f: string, slug: string, alias: string, extra = 'true') =>
  `EXISTS (SELECT 1 FROM pages ${alias} WHERE ${alias}.source_id = ${f}.source_id AND ${alias}.slug = ${slug} AND ${alias}.deleted_at IS NULL AND ${extra})`;

/**
 * Why a private fact `f` stays private, or NULL when it may open: the one exclusion expression the preview, the reason
 * counts and the locked apply share. A trust contest is any pending proposal on the row (a hold, a forget, a supersession)
 * or a widening (`before_state.visibility`) the owner rejected or undid: an owner's decision is never overridden.
 */
export function openFactsReasonSql(f: string): string {
  const prov = `(${factProvenanceSlugSql(f)})`;
  const member = (expr: string) => `left(${expr}, ${MEMBER_PAGE_PREFIX.length}) = '${MEMBER_PAGE_PREFIX}'`;
  return `(CASE
    WHEN ${f}.expired_at IS NOT NULL THEN 'expired'
    WHEN ${f}.superseded_by IS NOT NULL THEN 'superseded'
    WHEN ${member(`${f}.source_markdown_slug`)} OR ${member(`${f}.entity_slug`)} OR ${member(prov)} THEN 'member_page'
    WHEN EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id = ${f}.source_id
        AND w.fact_hash IN (gbrain_fact_fingerprint(${f}.fact), gbrain_fact_fingerprint_v1(${f}.fact)) AND (w.subject = '*' OR w.subject = ${f}.entity_slug))
      OR EXISTS (SELECT 1 FROM fact_purges x WHERE x.source_id = ${f}.source_id AND x.fact_hash = gbrain_fact_fingerprint(${f}.fact)
        AND (x.subject = '*' OR x.subject = ${f}.entity_slug)) THEN 'withdrawn'
    WHEN EXISTS (SELECT 1 FROM trust_proposals tp WHERE ((tp.target_table = 'facts' AND tp.target_id = ${f}.id) OR (tp.related_table = 'facts' AND tp.related_id = ${f}.id))
        AND (tp.status = 'pending' OR (tp.action = 'supersede_fact' AND tp.status IN ('rejected', 'undone') AND tp.before_state->'visibility' IS NOT NULL))) THEN 'contested'
    WHEN ${f}.source_markdown_slug IS NOT NULL AND ${anyPrivatePage(f, `${f}.source_markdown_slug`, 'oh')} THEN 'holding_page_private'
    WHEN ${f}.source_markdown_slug IS NOT NULL AND NOT ${livePage(f, `${f}.source_markdown_slug`, 'oh')} THEN 'holding_page_missing'
    WHEN ${f}.source_markdown_slug IS NOT NULL AND ${livePage(f, `${f}.source_markdown_slug`, 'oh', `NOT ${quarantineFilterFragment('oh')}`)} THEN 'holding_page_quarantined'
    WHEN ${prov} IS NOT NULL AND ${anyPrivatePage(f, prov, 'op')} THEN 'provenance_private'
    WHEN ${prov} IS NOT NULL AND NOT ${livePage(f, prov, 'op')} THEN 'provenance_unresolved'
    WHEN ${prov} IS NOT NULL AND ${livePage(f, prov, 'op', `NOT ${quarantineFilterFragment('op')}`)} THEN 'provenance_quarantined'
    WHEN ${f}.entity_slug IS NOT NULL AND ${anyPrivatePage(f, `${f}.entity_slug`, 'oe')} THEN 'entity_page_private'
    ELSE NULL END)`;
}

/** The selection's private facts, before reasons: one source, created before the cut, the named ids. */
const BASE = (f: string) => `${f}.source_id = $1 AND ${f}.visibility = 'private' AND ${f}.created_at < $2::timestamptz AND ($3::bigint[] IS NULL OR ${f}.id = ANY($3::bigint[]))`;

/** One keyset window of eligible facts: ids in (after, upper], the selected classes, every exclusion in the statement. */
async function planWindow(engine: BrainEngine, sel: Selection, limit: number, upper: number | null): Promise<PlannedRow[]> {
  const rows = await engine.executeRaw<{ id: number; row_num: number | null; fact: string; source_markdown_slug: string | null; cls: string }>(
    `SELECT f.id, f.row_num, f.fact, f.source_markdown_slug, ${openFactClassSql('f')} AS cls
    FROM facts f WHERE ${BASE('f')} AND f.id > $4 AND ($5::bigint IS NULL OR f.id <= $5::bigint)
      AND ${openFactClassSql('f')} = ANY($6::text[]) AND ${openFactsReasonSql('f')} IS NULL
    ORDER BY f.id LIMIT $7`, [sel.source_id, sel.created_before, sel.ids, sel.after, upper, sel.classes, limit], bounded);
  return rows.map(row => {
    const rowNum = row.row_num === null ? null : Number(row.row_num);
    return { id: Number(row.id), row_num: rowNum, fact: row.fact, holder: row.source_markdown_slug, cls: row.cls, fence: row.cls === 'fenced' };
  });
}

/** Every private fact of the selection (any class, any id) counted by class and by the reason it stays private; null when it overran its bound. */
async function countReasons(engine: BrainEngine, sel: Selection): Promise<{ eligible: Record<string, number>; excluded: Record<string, number> } | null> {
  let rows: Array<{ cls: string; reason: string; n: number }>;
  try {
    rows = await engine.executeRaw(`SELECT cls, reason, count(*)::int AS n FROM (SELECT ${openFactClassSql('f')} AS cls, COALESCE(${openFactsReasonSql('f')}, 'eligible') AS reason
      FROM facts f WHERE ${BASE('f')}) x GROUP BY cls, reason ORDER BY cls, reason`, [sel.source_id, sel.created_before, sel.ids], bounded);
  } catch (error) {
    if ((error as { code?: string } | null)?.code === '57014') return null;
    throw error;
  }
  const eligible: Record<string, number> = {};
  const excluded: Record<string, number> = {};
  for (const row of rows) {
    if (row.reason === 'eligible') eligible[row.cls] = (eligible[row.cls] ?? 0) + Number(row.n);
    else excluded[row.reason] = (excluded[row.reason] ?? 0) + Number(row.n);
  }
  return { eligible, excluded };
}

/** Rows as writes: one per page fence, one per holding slug of database-only rows (at most GROUP_MAX ids each). */
function groupRows(mode: Group['mode'], sel: Selection, rows: PlannedRow[], upper: number | null): Group[] {
  const groups: Group[] = [];
  const open = new Map<string, Group>();
  for (const row of rows) {
    const slug = row.holder ?? UNPAGED_SLUG;
    const key = `${row.fence ? 'fence' : 'db'}\0${slug}\0${row.fence ? '' : row.cls}`;
    let group = open.get(key);
    if (!group || (!row.fence && group.facts.length >= GROUP_MAX)) {
      group = { mode, source_id: sel.source_id, slug, fence: row.fence, cls: row.cls, facts: [], selection: sel, upper };
      open.set(key, group);
      groups.push(group);
    }
    group.facts.push({ id: row.id, row_num: row.row_num, fact: row.fact, holder: row.holder });
  }
  return groups;
}

const md5 = (text: string) => createHash('md5').update(text).digest('hex');
const factLabel = (group: Group, fact: FactRef) => group.fence ? `fact ${fact.id} (fenced row ${fact.row_num})` : `fact ${fact.id} (${group.cls.startsWith('unpaged:') ? 'unpaged' : 'unfenced'})`;
const hashParts = (scope: RepairScope, sel: Selection, groups: Group[], upper: number | null) => ({ kind: 'open-facts-v1', brain_id: scope.brain_id, selection: sel, upper,
  groups: groups.map(g => [g.mode, g.slug, g.fence, g.cls, g.facts.map(f => [f.id, f.row_num, md5(f.fact)])]) });
const selectionArgs = (sel: Selection) => sel.undo ? ['--undo', sel.undo]
  : ['--created-before', sel.created_before!, ...(sel.classes.join() === [...OPEN_FACTS_DEFAULT_CLASSES].sort().join() ? [] : sel.classes.flatMap(c => ['--class', c])),
    ...(sel.ids_file ? ['--ids-file', sel.ids_file] : []), ...(sel.after ? ['--after', String(sel.after)] : [])];
/** The selection flags the printed apply command repeats (`--after` and `--limit` are the runner's). */
export const openFactsApplyArgs = (request: OpenFactsRequest): string[] => request.undo ? ['--undo', request.undo]
  : [...(request.createdBefore ? ['--created-before', request.createdBefore] : []), ...request.classes.flatMap(c => ['--class', c]), ...(request.idsFile ? ['--ids-file', request.idsFile] : [])];
const previewCommand = (sel: Selection) => `gbrain repair open-facts --source ${sel.source_id} ${selectionArgs(sel).join(' ')}`;

function selectionOf(scope: RepairScope, opts?: RepairPlanOptions): { sel: Selection; request: OpenFactsRequest } {
  if (opts?.remote !== false) throw trustedCliRequired('gbrain repair open-facts widens what remote callers read, so it runs only from the CLI on the brain host; remote callers cannot run it.');
  const request = opts.openFacts;
  if (!request) throw opError('invalid_params', 'gbrain repair open-facts needs its ledger and selection, and this caller passed none.',
    'Run gbrain repair open-facts from the CLI on the brain host, naming one source with --source and the cut with --created-before, e.g. --created-before 2026-06-01T00:00:00Z; gbrain sources list --json lists the sources.');
  if (scope.source_ids.length !== 1) throw opError('invalid_params', 'gbrain repair open-facts opens facts in one named source.', 'Name one source with --source (gbrain sources list --json lists them).',
    { reason: 'source_required' });
  if (!request.undo && !request.createdBefore) throw createdBeforeRequired();
  return { request, sel: { source_id: scope.source_ids[0]!, created_before: request.undo ? null : request.createdBefore!,
    classes: request.undo ? [] : request.classes.length ? [...new Set(request.classes)].sort() : [...OPEN_FACTS_DEFAULT_CLASSES].sort(),
    ids: request.ids?.length ? [...new Set(request.ids)].sort((a, b) => a - b) : null, ids_file: request.idsFile ?? null,
    after: request.undo ? 0 : opts.afterPage ?? 0, undo: request.undo ?? null } };
}

/** `created_before_required`: the instant facts.default_visibility became world is the operator's to name. */
export function createdBeforeRequired(): OperationError {
  return opError('invalid_params', 'gbrain repair open-facts needs --created-before <ISO-8601>.',
    'Pass the instant facts.default_visibility became world on this brain, e.g. --created-before 2026-06-01T00:00:00Z; facts created after it stay as written.', { reason: 'created_before_required' });
}

/** `member_mode_refused`: a CLI under GBRAIN_ENFORCED_MEMBER acts as a member and never opens facts (the CLI checks it before the run). */
export function memberModeRefused(): OperationError {
  return opError('permission_denied', 'gbrain repair open-facts is refused under GBRAIN_ENFORCED_MEMBER: a member CLI cannot widen what other callers read.',
    'Run it as the brain host\'s operator, without GBRAIN_ENFORCED_MEMBER set.', { reason: 'member_mode_refused' });
}

/** Ledger lines readable for --undo: the latest committed line per fact decides (open: still to undo; close: undone). */
function ledgerOpened(ledger: OpenFactsLedger, brainId: string, sourceId: string): Map<number, { row_num: number | null; slug: string | null; fact_md5: string }> {
  const latest = new Map<number, { action: string; row_num: number | null; slug: string | null; fact_md5: string }>();
  for (const raw of ledger.lines) {
    const line = raw as Partial<OpenFactsLedgerLine> | null;
    if (!line || typeof line !== 'object' || line.phase !== 'committed' || line.brain_id !== brainId || line.source_id !== sourceId || !Array.isArray(line.facts)) continue;
    for (const fact of line.facts) {
      if (!fact || !Number.isSafeInteger(fact.id) || typeof fact.fact_md5 !== 'string') continue;
      latest.set(fact.id, { action: String(line.action), row_num: Number.isSafeInteger(fact.row_num) ? fact.row_num : null, slug: typeof fact.slug === 'string' ? fact.slug : null, fact_md5: fact.fact_md5 });
    }
  }
  return new Map([...latest].flatMap(([id, entry]) => entry.action === 'open' ? [[id, entry] as const] : []));
}

/** --undo: the opened facts still world and unchanged, grouped as writes, and the count of each one skipped by reason. */
async function planUndo(engine: BrainEngine, scope: RepairScope, sel: Selection, ledger: OpenFactsLedger) {
  const opened = ledgerOpened(ledger, scope.brain_id, sel.source_id);
  const rows = opened.size ? await engine.executeRaw<{ id: number; row_num: number | null; fact: string; visibility: string; source_markdown_slug: string | null;
    expired: boolean; superseded: boolean; fact_md5: string; cls: string }>(`SELECT f.id, f.row_num, f.fact, f.visibility, f.source_markdown_slug, f.expired_at IS NOT NULL AS expired,
      f.superseded_by IS NOT NULL AS superseded, md5(f.fact) AS fact_md5, ${openFactClassSql('f')} AS cls
    FROM facts f WHERE f.source_id = $1 AND f.id = ANY($2::bigint[]) ORDER BY f.id`, [sel.source_id, [...opened.keys()]], bounded) : [];
  const skipped: Record<string, number> = { gone: opened.size - rows.length };
  const keep: PlannedRow[] = [];
  for (const row of rows) {
    const recorded = opened.get(Number(row.id))!;
    const rowNum = row.row_num === null ? null : Number(row.row_num);
    const reason = row.expired ? 'expired' : row.superseded ? 'superseded' : row.visibility !== 'world' ? 'already_private'
      : row.fact_md5 !== recorded.fact_md5 || rowNum !== recorded.row_num || row.source_markdown_slug !== recorded.slug ? 'changed' : null;
    if (reason) { skipped[reason] = (skipped[reason] ?? 0) + 1; continue; }
    keep.push({ id: Number(row.id), row_num: rowNum, fact: row.fact, holder: row.source_markdown_slug, cls: row.cls, fence: row.cls === 'fenced' });
  }
  return { groups: groupRows('close', sel, keep, null), skipped: Object.fromEntries(Object.entries(skipped).filter(([, n]) => n > 0)) };
}

const listingOf = (groups: Group[]) => groups.flatMap(group => group.facts.map(fact => ({ item: `${group.source_id}:${group.slug}`, class: group.cls, detail: factLabel(group, fact) })));

export const openFactsRepair: RepairHandler = {
  kind: 'open-facts',
  embeds: false,
  outcomeItemsLimit: 100,
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    const { sel, request } = selectionOf(scope, opts);
    const command = previewCommand(sel);
    const toItems = (groups: Group[], hash: string): OpenItem[] => groups.map((group, index) => ({ cursor: { phase: 0, id: index }, source_id: group.source_id, slug: group.slug,
      chars: 0, action: `${group.mode === 'open' ? 'open' : 're-private'} ${group.facts.length} ${group.cls} fact(s)`, group, hash, ledger: request.ledger, brain_id: scope.brain_id }));
    if (opts?.apply) {
      if (!opts.expect) throw opError('invalid_params', 'gbrain repair open-facts --apply changes only the set a preview printed (opening a fact widens remote reads).',
        `Preview first: ${command} --json, then rerun it with --apply --expect and the preview_hash it printed.`);
      const approved = await loadApprovedSet<Group>(engine, { command: 'open-facts', hash: opts.expect, previewCommand: command,
        emptyHash: async () => previewHash(hashParts(scope, sel, [], null)) });
      if (approved.items.some(group => digest(group.selection) !== digest(sel))) throw previewChangedError(opts.expect, command);
      if (!sel.undo) {
        // A fact that became eligible inside the approved window since the preview is a changed set.
        const known = new Set(approved.items.flatMap(group => group.facts.map(f => f.id)));
        const upper = approved.items[0]?.upper ?? null;
        if ((await planWindow(engine, sel, OPEN_FACTS_WINDOW_MAX + 1, upper)).some(row => !known.has(row.id))) throw previewChangedError(opts.expect, command);
      }
      return { items: toItems(approved.items, opts.expect).filter(item => afterCursor(item.cursor, after)), preview_hash: opts.expect, residuals: {} };
    }
    if (sel.undo) {
      const { groups, skipped } = await planUndo(engine, scope, sel, request.ledger);
      const hash = previewHash(hashParts(scope, sel, groups, null));
      if (groups.length) await saveApprovedSet<Group>(engine, { command: 'open-facts', hash }, groups);
      return { items: toItems(groups, hash), preview_hash: hash, residuals: {},
        warnings: ['Re-privating restores the label only: anything a remote caller read while these facts were world stays read.',
          ...(request.ledger.unreadable ? [`${request.ledger.unreadable} ledger line(s) could not be read and are not planned.`] : [])],
        listing: listingOf(groups), details: { mode: 'undo', ledger: request.ledger.path, skipped, listed: groups.reduce((n, g) => n + g.facts.length, 0) } };
    }
    const size = Math.min(Math.max(1, opts?.limit ?? OPEN_FACTS_WINDOW), OPEN_FACTS_WINDOW_MAX);
    const window = await planWindow(engine, sel, size, null);
    const upper = window.length >= size ? window[window.length - 1]!.id : null;
    const groups = groupRows('open', sel, window, upper);
    const hash = previewHash(hashParts(scope, sel, groups, upper));
    if (groups.length) await saveApprovedSet<Group>(engine, { command: 'open-facts', hash }, groups);
    const counts = await countReasons(engine, sel);
    const samples: Record<string, string[]> = {};
    for (const row of window) if ((samples[row.cls] ??= []).length < 3) samples[row.cls]!.push(row.fact);
    const next = upper === null ? null : `${previewCommand({ ...sel, after: upper })}${opts?.limit ? ` --limit ${size}` : ''}`;
    const notNamed = Object.entries(counts?.eligible ?? {}).filter(([cls]) => !sel.classes.includes(cls));
    return { items: toItems(groups, hash), preview_hash: hash,
      residuals: Object.fromEntries(Object.entries(counts?.excluded ?? {}).map(([reason, n]) => [`left_private_${reason}`, n])),
      warnings: [
        'Opening a fact widens what remote callers that are not the brain owner can read, and that is one-way for anything they read before an undo. '
          + `Each opened fact is recorded in ${request.ledger.path}; undo with: gbrain repair open-facts --source ${sel.source_id} --undo ${request.ledger.path}`,
        ...(next ? [`This preview lists one window of ${window.length} fact(s); more may follow it. Apply this window (or decide not to), then preview the next one: ${next}`] : []),
        ...(counts ? [] : [`The counts by reason did not finish within the ${PLAN_STATEMENT_MS} ms statement bound and are not listed; the window is.`]),
        ...(notNamed.length ? [`${notNamed.map(([cls, n]) => `${n} ${cls}`).join(', ')} fact(s) are not in this preview: they come from no page the brain can judge, or from a class not named. `
          + `Name one to preview it, e.g. --class ${notNamed[0]![0]}`] : []),
      ],
      listing: listingOf(groups),
      details: { mode: 'open', ledger: request.ledger.path, eligible: counts?.eligible ?? null, excluded: counts?.excluded ?? null, samples,
        window: { size, listed: window.length, after: sel.after, next_after: upper, next_preview: next } } };
  },
  async apply(ctx, raw): Promise<RepairItemOutcome> {
    const item = raw as OpenItem;
    return item.group.fence ? applyFence(ctx, item) : applyDatabase(ctx, item);
  },
  async report(ctx, _scope, result, opts) {
    if (result.mode === 'apply' && opts.expect && result.complete && !result.stopped && !result.failed.length && !result.pending?.length) {
      await clearApprovedSet(ctx.engine, { command: 'open-facts', hash: opts.expect });
    }
    return result.mode === 'apply' && opts.openFacts ? { details: { ...result.details, ledger: opts.openFacts.ledger.path } } : {};
  },
  render(details) {
    const line = (values: unknown) => Object.entries((values ?? {}) as Record<string, number>).map(([key, value]) => `${key}=${value}`).join(', ') || 'none';
    const samples = (details.samples ?? {}) as Record<string, string[]>;
    return [
      ...(details.mode === 'open' ? [`  eligible by class: ${line(details.eligible)}`, `  left private by reason: ${line(details.excluded)}`] : []),
      ...(details.mode === 'undo' ? [`  skipped (changed since it was opened): ${line(details.skipped)}`] : []),
      ...Object.entries(samples).map(([cls, claims]) => `  sample ${cls}: ${claims.map(claim => JSON.stringify(claim)).join('; ')}`),
      ...(details.ledger ? [`  ledger: ${String(details.ledger)}`] : []),
    ];
  },
};

/** The ledger entries of a group's facts. */
const ledgerFacts = (group: Group, ids?: ReadonlySet<number>) => group.facts.filter(f => !ids || ids.has(f.id))
  .map(f => ({ id: f.id, row_num: f.row_num, slug: f.holder, fact_md5: md5(f.fact) }));
function recordIntent(item: OpenItem, requestId: string): void {
  try { item.ledger.record({ at: new Date().toISOString(), brain_id: item.brain_id, source_id: item.group.source_id, hash: item.hash, request_id: requestId, action: item.group.mode, phase: 'intent', facts: ledgerFacts(item.group) }); }
  catch (error) {
    throw opError('storage_error', `${item.group.source_id}:${item.group.slug} was not written: the undo ledger ${item.ledger.path} did not take its intent line (${error instanceof Error ? error.message : String(error)}).`,
      `Make ${item.ledger.path} writable by this user, then rerun the same apply command; nothing was changed and the approved preview is kept.`);
  }
}

/** The item's outcome once its write returned: the facts it changed (committed to the ledger), and any left as they were. */
function settle(item: OpenItem, requestId: string, changed: readonly number[], why: string): RepairItemOutcome {
  const done = new Set(changed.map(Number));
  const left = item.group.facts.filter(f => !done.has(f.id)).map(f => f.id);
  const opening = item.group.mode === 'open';
  let ledgerError: string | undefined;
  if (done.size) {
    try { item.ledger.record({ at: new Date().toISOString(), brain_id: item.brain_id, source_id: item.group.source_id, hash: item.hash, request_id: requestId, action: item.group.mode, phase: 'committed', facts: ledgerFacts(item.group, done) }); }
    catch (error) { ledgerError = error instanceof Error ? error.message : String(error); }
  }
  const next = opening ? `preview again (gbrain repair open-facts --source ${item.group.source_id} --created-before ${item.group.selection.created_before}); each fact left private is counted there by its reason`
    : `gbrain repair visibility --source ${item.group.source_id} --class facts`;
  if (!done.size) return { applied: false, outcome: opening ? 'fact_left_private' : 'fact_left_world', reason: `${why}; next: ${next}`, detail: { fact_ids: left.join(','), ledger: item.ledger.path } };
  const notes = [left.length ? `${left.length} fact(s) were left as they were: ${why}` : '', ledgerError ? `the ledger did not take the commit line (${ledgerError}); its intent line is there` : ''].filter(Boolean);
  return { applied: true, outcome: opening ? 'opened' : 'reprivated', ...(notes.length ? { reason: notes.join('; ') } : {}),
    detail: { fact_ids: [...done].join(','), ...(left.length ? { left: left.join(',') } : {}), ledger: item.ledger.path } };
}

/** Item failures that leave the item's facts as they were, reported as its outcome instead of failing the run. */
const ITEM_REFUSALS = new Set(['revision_conflict', 'source_changed', 'label_edit_refused', 'page_body_segmented', 'canonical_file_missing']);
const refusal = (error: unknown) => error instanceof OperationError && (ITEM_REFUSALS.has(error.code) || ITEM_REFUSALS.has(String(error.detail ?? ''))) ? error : null;
const CHANGED = 'it changed since the preview (a page it names turned private or went away, the fact was withdrawn, contested, edited or retired), so the locked recheck left it';

type PinnedRow = { id: number; row_num: number | null; fact_md5: string };
const pinned = (facts: readonly FactRef[]): PinnedRow[] => facts.map(f => ({ id: f.id, row_num: f.row_num, fact_md5: md5(f.fact) }));

/** Locks every page the facts name (holding, provenance, entity; every row with the slug) FOR SHARE, in page id order. */
async function lockNamedPages(tx: BrainEngine, sourceId: string, ids: readonly number[]): Promise<void> {
  await tx.executeRaw(`SELECT p.id FROM pages p WHERE p.source_id = $1 AND p.slug IN (
      SELECT v.s FROM facts f CROSS JOIN LATERAL (VALUES (f.source_markdown_slug), (${factProvenanceSlugSql('f')}), (f.entity_slug)) AS v(s)
      WHERE f.source_id = $1 AND f.id = ANY($2::bigint[]) AND v.s IS NOT NULL)
    ORDER BY p.id FOR SHARE OF p`, [sourceId, ids]);
}

/** The pinned facts still eligible to open, each locked FOR UPDATE, read after the named pages are locked. */
async function lockEligible(tx: BrainEngine, sourceId: string, rows: readonly PinnedRow[]): Promise<number[]> {
  await lockNamedPages(tx, sourceId, rows.map(r => r.id));
  const locked = await tx.executeRaw<{ id: number }>(`SELECT f.id FROM facts f WHERE f.source_id = $1 AND f.id = ANY($2::bigint[]) ORDER BY f.id FOR UPDATE OF f`, [sourceId, rows.map(r => r.id)]);
  if (!locked.length) return [];
  const eligible = await tx.executeRaw<{ id: number }>(`SELECT f.id FROM facts f JOIN jsonb_to_recordset($2::text::jsonb) AS r(id bigint, row_num integer, fact_md5 text) ON r.id = f.id
    WHERE f.source_id = $1 AND f.row_num IS NOT DISTINCT FROM r.row_num AND md5(f.fact) = r.fact_md5 AND f.visibility = 'private'
      AND ${openFactsReasonSql('f')} IS NULL`, [sourceId, JSON.stringify(rows)]);
  return eligible.map(row => Number(row.id));
}

/**
 * Changes the pinned facts still eligible in place, in the caller's transaction: open (private to world) only those
 * lockEligible keeps; close (world to private) those unchanged since their ledger line and still active.
 */
async function changeRows(tx: BrainEngine, sourceId: string, mode: Group['mode'], rows: readonly PinnedRow[]): Promise<number[]> {
  if (!rows.length) return [];
  if (mode === 'open') {
    const ids = await lockEligible(tx, sourceId, rows);
    if (!ids.length) return [];
    return (await tx.executeRaw<{ id: number }>(`UPDATE facts SET visibility = 'world' WHERE source_id = $1 AND id = ANY($2::bigint[]) AND visibility = 'private' RETURNING id`,
      [sourceId, ids])).map(row => Number(row.id));
  }
  return (await tx.executeRaw<{ id: number }>(`UPDATE facts f SET visibility = 'private' FROM jsonb_to_recordset($2::text::jsonb) AS r(id bigint, row_num integer, fact_md5 text)
      WHERE f.source_id = $1 AND f.id = r.id AND f.row_num IS NOT DISTINCT FROM r.row_num AND md5(f.fact) = r.fact_md5 AND f.visibility = 'world'
        AND f.expired_at IS NULL AND f.superseded_by IS NULL RETURNING f.id`, [sourceId, JSON.stringify(rows)])).map(row => Number(row.id));
}

const requestIdOf = (item: OpenItem, revision: string | null) => {
  const h = digest(['open-facts-write-v1', item.hash, item.group.mode, item.group.source_id, item.group.slug, item.group.fence, item.group.facts.map(f => f.id), revision]);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/** Database-only facts: one in-place UPDATE under the page locks (a managed brain: the OPEN_FACTS_INTENT maintenance request). */
async function applyDatabase(ctx: OperationContext, item: OpenItem): Promise<RepairItemOutcome> {
  const { group } = item;
  const rows = pinned(group.facts);
  if (!await managedPersistenceEnabled(ctx.engine)) {
    const requestId = requestIdOf(item, null);
    recordIntent(item, requestId);
    return settle(item, requestId, await maintenanceTransaction(ctx.engine, tx => changeRows(tx, group.source_id, group.mode, rows)), CHANGED);
  }
  const authority = (await maintenancePreflight(ctx.engine, group.source_id))!;
  const holder = await ctx.engine.readPageSnapshot(group.slug, { sourceId: group.source_id });
  const requestId = requestIdOf(item, holder?.revision ?? null);
  recordIntent(item, requestId);
  try {
    const receipt = await submitDatabaseMaintenanceIntent(ctx.engine, authority, group.slug,
      { kind: OPEN_FACTS_INTENT, action: group.mode, expected_revision: holder?.revision ?? null, rows }, requestId);
    return settle(item, requestId, ((receipt.changed as number[] | undefined) ?? []).map(Number), CHANGED);
  } catch (error) {
    const refused = refusal(error);
    if (!refused) throw error;
    return settle(item, requestId, [], refused.message);
  }
}

/**
 * A page's fenced facts: the cells set to world (close: private) by one label-only write. A managed brain publishes it
 * through the maintenance door naming the rows it opens (openFactsPublication); elsewhere the page is imported and the
 * rows changed in place in the same transaction, before a file in the source's checkout is written; an open whose locked
 * recheck keeps a row private throws `revision_conflict`, so neither the page, the file nor any row changes.
 */
async function applyFence(ctx: OperationContext, item: OpenItem): Promise<RepairItemOutcome> {
  const { group } = item;
  const from = group.mode === 'open' ? 'private' : 'world', to = group.mode === 'open' ? 'world' : 'private';
  const snapshot = await ctx.engine.readPageSnapshot(group.slug, { sourceId: group.source_id });
  if (!snapshot) return settle(item, '', [], 'its page is gone');
  if (isSegmentedPage(snapshot.page)) return settle(item, '', [], 'its page is stored in segments, which this repair does not rewrite; edit the facts fence by hand on the brain host');
  let body = snapshot.page.compiled_truth ?? '';
  const struck: FactRef[] = [];
  for (const fact of group.facts) {
    let hit = false;
    const next = strikeFenceRow(body, fact.row_num!, row => row.claim === fact.fact && row.visibility === from ? (hit = true, { ...row, visibility: to }) : row);
    if (next === null || !hit) continue;
    body = next;
    struck.push(fact);
  }
  if (!struck.length) return settle(item, '', [], 'its rows were not found in the page\'s facts fence as previewed, or the fence does not parse cleanly');
  const content = serializePageToMarkdown({ ...snapshot.page, compiled_truth: body }, snapshot.tags);
  const edit = { set: {}, remove: [] };
  const rows = pinned(struck);
  const requestId = requestIdOf(item, snapshot.revision);
  try {
    if (await managedPersistenceEnabled(ctx.engine)) {
      const authority = (await maintenancePreflight(ctx.engine, group.source_id))!;
      const refused = await labelFileRefusal(ctx.engine, snapshot, content, edit);
      if (refused) return settle(item, requestId, [], refused.error.message);
      recordIntent(item, requestId);
      await publishMaintenancePage(ctx.engine, authority, group.slug, content,
        { expectedRevision: snapshot.revision, requestId, keepTrust: true, labelEdit: edit, ...(group.mode === 'open' ? { openFacts: rows } : {}) });
      const settled = await ctx.engine.executeRaw<{ id: number }>(`SELECT id FROM facts WHERE source_id = $1 AND id = ANY($2::bigint[]) AND visibility = $3 AND expired_at IS NULL`,
        [group.source_id, rows.map(r => r.id), to]);
      return settle(item, requestId, settled.map(r => Number(r.id)), CHANGED);
    }
    const path = (await filesInCheckout(ctx.engine, [Number(snapshot.page.id)])).get(Number(snapshot.page.id));
    recordIntent(item, requestId);
    let changed: number[] = [];
    const inPlace = async (tx: BrainEngine) => {
      changed = await changeRows(tx, group.source_id, group.mode, rows);
      if (group.mode === 'open' && changed.length !== rows.length) {
        throw opError('revision_conflict', `${group.source_id}:${group.slug} was not written: ${CHANGED}.`, 'Preview gbrain repair open-facts again; the facts are listed with their current state.');
      }
    };
    if (path) {
      const written = await writeLabelFile(ctx.engine, group, { revision: snapshot.revision, content, edit, embed: false, preview: 'gbrain repair open-facts', path, afterImport: inPlace });
      if (written !== null && typeof written === 'object') return settle(item, requestId, [], written.reason ?? written.outcome);
      if (written === null) return settle(item, requestId, [], 'its page changed after it was read');
    } else if (await importAtRevision(ctx.engine, group, snapshot.revision, content, false, 'gbrain repair open-facts', inPlace) === null) {
      return settle(item, requestId, [], 'its page changed after it was read');
    }
    return settle(item, requestId, changed, CHANGED);
  } catch (error) {
    const refused = refusal(error);
    if (!refused) throw error;
    return settle(item, requestId, [], refused.message);
  }
}

const validRows = (value: unknown): value is PinnedRow[] => Array.isArray(value) && value.length > 0
  && value.every(r => r && Number.isSafeInteger(r.id) && (r.row_num === null || Number.isSafeInteger(r.row_num)) && typeof r.fact_md5 === 'string');

/** Preparer for `managed_maintenance_open_fact_visibility`: the named database-only facts change in place under the page locks. */
export async function prepareOpenFactsIntent(engine: BrainEngine, row: WriteRequest): Promise<PreparedMutation> {
  const p = row.intent as { action?: unknown; rows?: unknown } | null;
  if (!p || (p.action !== 'open' && p.action !== 'close') || !validRows(p.rows)) {
    throw opError('invalid_params', 'The open-facts intent does not name its facts.',
      `Request ${row.request_id} in source ${row.source_id} does not name the facts to change, so nothing changed. Preview gbrain repair open-facts again and apply it after the user approves.`);
  }
  const mode = p.action, rows = p.rows;
  await authorizeWrite(engine, row.authority, 'submit_job', row.slug);
  const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id });
  return { observedRevision: snapshot?.revision ?? null, noop: true,
    validate: async tx => { await authorizeWrite(tx, row.authority, 'submit_job', row.slug); },
    apply: async tx => ({ status: 'completed', changed: await changeRows(tx, row.source_id, mode, rows) }) };
}

/**
 * The managed label door's publication of a page whose fence cells this repair set to world (`open_facts` on a
 * keep_trust maintenance page intent): every named row is rechecked under the page and row locks first, the projection
 * runs under withOpenFacts so fence-guard moves each row to world in place, and a row that changed, or that the
 * projection did not move, rolls the whole publication back (`revision_conflict`).
 */
export function openFactsPublication(row: WriteRequest, prepared: PreparedMutation): PreparedMutation {
  const rows = (row.intent as { open_facts?: unknown } | null)?.open_facts;
  if (!validRows(rows)) throw opError('invalid_params', 'The open-facts publication does not name its facts.',
    `Request ${row.request_id} in source ${row.source_id} does not name the fence rows it opens, so nothing changed. Preview gbrain repair open-facts again.`);
  const ids = rows.map(r => r.id);
  const conflict = (what: string) => opError('revision_conflict', `${row.source_id}:${row.slug} was not written: ${what}.`,
    'Preview gbrain repair open-facts again; the facts are listed with their current state.');
  return { ...prepared, apply: (tx, preimage) => withOpenFacts(tx, ids, async () => {
    if ((await lockEligible(tx, row.source_id, rows)).length !== rows.length) throw conflict('a fence row changed since the preview, or a page it names turned private');
    const outcome = await prepared.apply(tx, preimage);
    const [moved] = await tx.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM facts WHERE source_id = $1 AND id = ANY($2::bigint[]) AND visibility = 'world' AND expired_at IS NULL`,
      [row.source_id, ids]);
    if (Number(moved?.n ?? 0) !== rows.length) throw conflict('a fence row was not opened in place');
    return outcome;
  }) };
}
