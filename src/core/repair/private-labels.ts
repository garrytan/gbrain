/**
 * gbrain repair private-labels: clear the privacy labels that writer templates
 * over-stamped on ordinary pages. Every live page that is private by its label
 * (visibility: private, or a privacy alias with no visibility) is classified:
 *
 *   KEEP (counted, never changed)
 *     pinned_question      pinned_question in frontmatter, or type question
 *     derived              an atom, a page with derived_from or source_slug, a synthesized
 *                          concept or a life-chronicle event;
 *                          its privacy follows its origin (gbrain repair visibility owns it)
 *     strong_alias         access restricted or confidential, or a private confidentiality value
 *     explicit_visibility  visibility: private with no access: private (a deliberate writer or connector)
 *
 *   CLEAR (the only pages changed)
 *     alias                access: private and no visibility: the access key is removed
 *     alias-and-visibility access: private and visibility: private: both keys are removed
 *     git-publish          either of the two in a source with canonical git; private pages
 *                          there are database-only, so clearing commits the page into Git
 *                          for the first time. Applied only when named with --class git-publish.
 *
 * The preview lists one window (--limit, default PRIVATE_LABELS_WINDOW) of clear items in
 * (class, page id) order under a hash, with every category's count over the scope before
 * and after the window; --apply --expect <hash> applies exactly that window, re-deciding
 * each page against its live revision and labels first. A bare --apply is refused. Each
 * item is one revision-bound maintenance write, so it keeps the page's trust tier (no
 * trust_tier marker, no lower_page proposal) and its gate markers: a managed brain
 * publishes it through the maintenance door (the Git door on a repo source) with keep_trust,
 * an unmanaged one imports it in a maintenance transaction under the page lock, also
 * keeping the stored tier. readable_by and folder
 * rules are left as they are.
 *
 * Reversible: the ledger the caller passes (`privateLabelsLedger`; the CLI keeps it at
 * <gbrain home>/repair/private-labels/<brain_id>.jsonl, src/commands/repair-private-labels.ts) is
 * write-ahead. Each item appends an `intent` line with the exact removed (or re-added) values before
 * its page write and a `committed` line with the revision it wrote after; a ledger that cannot take
 * the intent line refuses the item before anything is written. --class restore plans from the lines
 * (see planRestore) and re-adds only access and visibility: private; it is preview-bound the same way
 * and writes its own lines. An apply that ends with a failure, a stop or a pending write keeps its
 * approved set, so the same --apply --expect resumes it. An apply or a restore preview without a
 * ledger is refused. A git-publish clear is not fully undone: restore re-adds the label and the file
 * leaves the checkout, but the commits that held it keep the page's content.
 */
import type { BrainEngine } from '../engine.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { opError } from '../ops/contract.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import { withTrustKeep } from '../persistence/context.ts';
import { maintenancePreflight, publishMaintenancePage } from '../persistence/prepared-maintenance.ts';
import { importFromContent } from '../import-file.ts';
import { isSegmentedPage } from '../page-body/page-shape.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { PRIVACY_ALIASES, privacyAliasSql } from '../search/private-visibility.ts';
import { afterCursor, repairRequestId, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairPlan, type RepairPlanOptions, type RepairScope } from './core.ts';

export type ClearClass = 'alias' | 'alias-and-visibility' | 'git-publish';
export type KeepClass = 'pinned_question' | 'derived' | 'strong_alias' | 'explicit_visibility';
type LabelsClass = ClearClass | 'restore';
const KEEP_CLASSES: readonly KeepClass[] = ['pinned_question', 'derived', 'strong_alias', 'explicit_visibility'];
const CLEAR_CLASSES: readonly ClearClass[] = ['alias', 'alias-and-visibility', 'git-publish'];
export const PRIVATE_LABELS_CLASSES: readonly LabelsClass[] = [...CLEAR_CLASSES, 'restore'];
/** Without --class a preview covers these; git-publish commits pages into Git and runs only when named. */
const DEFAULT_CLASSES: readonly ClearClass[] = ['alias', 'alias-and-visibility'];
export const PRIVATE_LABELS_WINDOW = 1000;
export const PRIVATE_LABELS_WINDOW_MAX = 10_000;
const SCAN_PAGE = 5000;
const bounded = { timeoutMs: 120_000 };

type Labels = { access?: string; visibility?: string };
interface LabelRow { id: number; source_id: string; slug: string; type: string; frontmatter: Record<string, unknown> | null; revision: string | null; chars: number; git: boolean }
interface Selection { source_ids: string[]; class: LabelsClass | null }
interface Approved { mode: 'clear' | 'restore'; class: LabelsClass; brain_id: string; source_id: string; slug: string; page_id: number; revision: string | null; labels: Labels; chars: number; selection: Selection }
interface LabelsItem extends RepairItem { entry: Approved; ledger: PrivateLabelsLedger }
/**
 * One ledger line. `phase`: `intent` is appended before the page write, `committed` after it landed, with the revision it
 * wrote (`revision_after`); a line with no phase predates the write-ahead ledger and was appended after its write.
 */
export interface PrivateLabelsLedgerLine { at: string; brain_id: string; source_id: string; slug: string; page_id: number; revision_before: string; request_id: string;
  removed?: Labels; restored?: Labels; phase?: 'intent' | 'committed'; revision_after?: string }
type LedgerLine = PrivateLabelsLedgerLine;
/** The undo ledger, kept by the caller: where it is, its parsed lines (untrusted; read for --class restore), unparseable line count, and the append. */
export interface PrivateLabelsLedger { path: string; lines: unknown[]; unreadable: number; record(line: PrivateLabelsLedgerLine): void }
type Decision = { keep: KeepClass } | { clear: ClearClass; removed: Labels } | null;

/** KEEP or CLEAR for a page that is private by its label; null for a page no label makes private. */
export function classifyPrivateLabel(row: Pick<LabelRow, 'type' | 'frontmatter' | 'git'>): Decision {
  const fm = row.frontmatter ?? {};
  const value = (key: string) => typeof fm[key] === 'string' ? (fm[key] as string).trim().toLowerCase() : null;
  const aliased = Object.entries(PRIVACY_ALIASES).some(([key, values]) => values.includes(value(key) ?? ''));
  if (!(fm.visibility === 'private' || (fm.visibility == null && aliased))) return null;
  if (Object.hasOwn(fm, 'pinned_question') || row.type === 'question') return { keep: 'pinned_question' };
  if (row.type === 'atom' || Object.hasOwn(fm, 'derived_from') || Object.hasOwn(fm, 'source_slug') || (row.type === 'concept' && fm.synthesized_by != null)
    || (row.type === 'event' && typeof fm.captured_via === 'string' && fm.captured_via.startsWith('life-chronicle:'))) return { keep: 'derived' };
  const access = value('access');
  if (access === 'restricted' || access === 'confidential' || PRIVACY_ALIASES.confidentiality!.includes(value('confidentiality') ?? '')) return { keep: 'strong_alias' };
  if (access !== 'private') return { keep: 'explicit_visibility' };
  const removed: Labels = fm.visibility == null ? { access: fm.access as string } : { access: fm.access as string, visibility: 'private' };
  return { clear: row.git ? 'git-publish' : removed.visibility ? 'alias-and-visibility' : 'alias', removed };
}

/** Live pages of the sources that a label makes private, in page id order (`ids` narrows to those pages). */
async function scanLabelled(engine: BrainEngine, sourceIds: string[], visit: (row: LabelRow) => void, ids?: number[]): Promise<void> {
  for (let after = 0; ;) {
    const rows = await engine.executeRaw<LabelRow>(`SELECT p.id, p.source_id, p.slug, p.type, p.frontmatter, p.knowledge_revision::text AS revision,
        COALESCE(p.body_bytes, 0) AS chars, COALESCE(s.config->>'canonical' = 'git', false) AS git
      FROM pages p JOIN sources s ON s.id = p.source_id
      WHERE p.deleted_at IS NULL AND p.source_id = ANY($1::text[]) AND p.id > $2
        AND (p.frontmatter->>'visibility' = 'private' OR (p.frontmatter->>'visibility' IS NULL AND ${privacyAliasSql('p')}))
        AND ($3::integer[] IS NULL OR p.id = ANY($3::integer[]))
      ORDER BY p.id LIMIT ${SCAN_PAGE}`, [sourceIds, after, ids ?? null], bounded);
    for (const row of rows) visit(row);
    if (rows.length < SCAN_PAGE) return;
    after = Number(rows[rows.length - 1]!.id);
  }
}

/** The labels a ledger line may carry: access (a string) and visibility (only private), nothing else; null otherwise. */
function ledgerLabels(value: unknown): Labels | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (!entries.length || entries.some(([key, v]) => !(key === 'access' ? typeof v === 'string' : key === 'visibility' && v === 'private'))) return null;
  return Object.fromEntries(entries) as Labels;
}

/** A ledger line restore may plan from, or null: string identity fields, a positive integer page id, one well-formed label set. */
function readableLine(raw: unknown): LedgerLine | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const line = raw as Record<string, unknown>;
  if (![line.brain_id, line.source_id, line.slug].every(v => typeof v === 'string') || !Number.isSafeInteger(line.page_id) || (line.page_id as number) < 1) return null;
  if (line.phase !== undefined && line.phase !== 'intent' && line.phase !== 'committed') return null;
  if (line.revision_after !== undefined && typeof line.revision_after !== 'string') return null;
  const removed = line.removed === undefined ? undefined : ledgerLabels(line.removed);
  const restored = line.restored === undefined ? undefined : ledgerLabels(line.restored);
  if (removed === null || restored === null || (removed === undefined) === (restored === undefined)) return null;
  return { ...(line as unknown as LedgerLine), ...(removed ? { removed } : { restored: restored! }) };
}

const describeLabels = (labels: Labels) => Object.entries(labels).map(([key, value]) => `${key}: ${value}`).join(', ');
const sameLabels = (a: Labels, b: Labels) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
const previewCommand = (scope: RepairScope, selection: Selection) =>
  `gbrain repair private-labels${scope.source_ids.length === 1 ? ` --source ${scope.source_ids[0]}` : ''}${selection.class ? ` --class ${selection.class}` : ''}`;

function selectedClass(opts?: RepairPlanOptions): LabelsClass | null {
  const value = opts?.driftClass;
  if (value === undefined) return null;
  if ((PRIVATE_LABELS_CLASSES as readonly string[]).includes(value)) return value as LabelsClass;
  throw opError('invalid_params', `--class for gbrain repair private-labels takes ${PRIVATE_LABELS_CLASSES.join(', ')} (got "${value}").`,
    'Preview the default classes with gbrain repair private-labels, or one with e.g. gbrain repair private-labels --class git-publish.');
}

const hashParts = (scope: RepairScope, selection: Selection, entries: Approved[]) => ({ kind: 'private-labels-v1', brain_id: scope.brain_id, selection,
  items: entries.map(e => [e.mode, e.class, e.source_id, e.page_id, e.slug, e.revision, Object.entries(e.labels).sort()]) });

/** Every category's count over the scope and the clear entries of the selected classes, in (class, page id) order. */
async function planClear(engine: BrainEngine, scope: RepairScope, selection: Selection, classes: readonly ClearClass[]) {
  const counts = Object.fromEntries([...KEEP_CLASSES, ...CLEAR_CLASSES].map(cls => [cls, 0])) as Record<KeepClass | ClearClass, number>;
  const entries: Approved[] = [];
  await scanLabelled(engine, scope.source_ids, row => {
    const decided = classifyPrivateLabel(row);
    if (!decided) return;
    if ('keep' in decided) { counts[decided.keep]++; return; }
    counts[decided.clear]++;
    if (classes.includes(decided.clear)) entries.push({ mode: 'clear', class: decided.clear, brain_id: scope.brain_id, source_id: row.source_id, slug: row.slug,
      page_id: Number(row.id), revision: row.revision, labels: decided.removed, chars: Number(row.chars), selection });
  });
  entries.sort((a, b) => CLEAR_CLASSES.indexOf(a.class as ClearClass) - CLEAR_CLASSES.indexOf(b.class as ClearClass) || a.page_id - b.page_id);
  return { counts: counts as Record<string, number>, entries, unreadable: 0 };
}

/**
 * Per page (source, page id) in scope, its latest removal line (intent, committed or a pre-write-ahead line) decides what
 * restore re-adds: the page is restorable while it is live and lacks every removed key. A restore line after that removal
 * counts only when it is `committed` with the revision it wrote: a page that has moved past that revision and lacks the
 * keys again had its label removed after the restore landed (`removed_after_restore`), so it is counted, warned about
 * and not planned. A restore line with no committed revision proves nothing (an accepted write can still fail), so its
 * page stays restorable. A line restore cannot trust (not an object, a page id that is not a positive integer, a key
 * other than access or visibility: private, a value that is not a string) is counted unreadable and never planned.
 */
async function planRestore(engine: BrainEngine, scope: RepairScope, selection: Selection, ledger: PrivateLabelsLedger) {
  let unreadable = ledger.unreadable;
  const pages = new Set<string>();
  const latest = new Map<string, { removal: LedgerLine; landed?: LedgerLine }>();
  for (const raw of ledger.lines) {
    const line = readableLine(raw);
    if (!line) { unreadable++; continue; }
    if (line.brain_id !== scope.brain_id || !scope.source_ids.includes(line.source_id)) continue;
    const key = `${line.source_id}:${line.page_id}`;
    pages.add(key);
    if (line.removed) latest.set(key, { removal: line });
    else if (line.phase === 'committed' && line.revision_after && latest.has(key)) latest.get(key)!.landed = line;
  }
  const removals = [...latest.values()];
  const live = removals.length ? await engine.executeRaw<LabelRow>(`SELECT id, source_id, slug, type, frontmatter, knowledge_revision::text AS revision, COALESCE(body_bytes, 0) AS chars
    FROM pages WHERE id = ANY($1::integer[]) AND deleted_at IS NULL`, [removals.map(({ removal }) => removal.page_id)], bounded) : [];
  const byId = new Map(live.map(row => [Number(row.id), row]));
  const counts = { restorable: 0, already_restored: pages.size - removals.length, page_gone: 0, removed_after_restore: 0 };
  const entries: Approved[] = [];
  for (const { removal, landed } of removals) {
    const page = byId.get(removal.page_id);
    if (!page || page.source_id !== removal.source_id) { counts.page_gone++; continue; }
    if (Object.keys(removal.removed!).some(key => Object.hasOwn(page.frontmatter ?? {}, key))) { counts.already_restored++; continue; }
    if (landed && landed.revision_after !== page.revision) { counts.removed_after_restore++; continue; }
    counts.restorable++;
    entries.push({ mode: 'restore', class: 'restore', brain_id: scope.brain_id, source_id: page.source_id, slug: page.slug, page_id: Number(page.id),
      revision: page.revision, labels: removal.removed!, chars: Number(page.chars), selection });
  }
  entries.sort((a, b) => a.page_id - b.page_id);
  return { counts: counts as Record<string, number>, entries, unreadable };
}

/**
 * Unmanaged brains: the legacy maintenance import (an owner path: no write gate, no trust marker, gate markers kept),
 * under withTrustKeep so the page keeps its stored tier, bound to the previewed revision under the page lock. The revision
 * it wrote; null when the page moved.
 */
async function importAtRevision(engine: BrainEngine, entry: Approved, revision: string, content: string, embed: boolean): Promise<string | null> {
  return maintenanceTransaction(engine, async tx => {
    await tx.lockPageKeys([{ sourceId: entry.source_id, slug: entry.slug }]);
    if ((await tx.readPageSnapshot(entry.slug, { sourceId: entry.source_id }))?.revision !== revision) return null;
    const result = await withTrustKeep(tx, ['pages'], () => importFromContent(tx, entry.slug, content, { sourceId: entry.source_id, noEmbed: !embed, preserveGateMarkers: true }));
    if (result.status === 'error') throw opError('invalid_params', `${entry.source_id}:${entry.slug} was not written: ${result.error ?? 'the import refused it'}`,
      'Preview gbrain repair private-labels again; the page is listed with its current state.');
    return (await tx.readPageSnapshot(entry.slug, { sourceId: entry.source_id }))?.revision ?? null;
  });
}

export const privateLabelsRepair: RepairHandler = {
  kind: 'private-labels',
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    const selection: Selection = { source_ids: scope.source_ids, class: selectedClass(opts) };
    const command = previewCommand(scope, selection);
    const ledger = opts?.privateLabelsLedger;
    if (!ledger && (opts?.apply || selection.class === 'restore')) {
      throw opError('invalid_params', 'gbrain repair private-labels needs its undo ledger to apply or restore, and this caller passed none.', `Run it from the CLI on the brain host: ${command}`);
    }
    const toItems = (entries: Approved[]) => entries.map((entry, index): LabelsItem => ({ cursor: { phase: 0, id: index }, source_id: entry.source_id, slug: entry.slug,
      chars: entry.chars, action: `${entry.mode === 'clear' ? 'remove' : 're-add'} ${describeLabels(entry.labels)}`, entry, ledger: ledger! }));
    if (opts?.apply) {
      if (!opts.expect) {
        throw opError('invalid_params', 'gbrain repair private-labels --apply changes only the set a preview printed (clearing a label widens remote reads).',
          `Preview first: ${command} — then run the apply command it prints: ${command} --apply --expect <preview-hash>`);
      }
      const approved = await loadApprovedSet<Approved>(engine, { command: 'private-labels', hash: opts.expect, previewCommand: command,
        emptyHash: async () => previewHash(hashParts(scope, selection, [])) });
      if (approved.items.some(entry => (entry.selection.class ?? null) !== selection.class || JSON.stringify(entry.selection.source_ids) !== JSON.stringify(selection.source_ids))) {
        throw previewChangedError(opts.expect, command);
      }
      return { items: toItems(approved.items).filter(item => afterCursor(item.cursor, after)), preview_hash: opts.expect, residuals: {} };
    }
    const size = Math.min(Math.max(1, opts?.limit ?? PRIVATE_LABELS_WINDOW), PRIVATE_LABELS_WINDOW_MAX);
    const restore = selection.class === 'restore';
    const planned = restore ? await planRestore(engine, scope, selection, ledger!)
      : await planClear(engine, scope, selection, selection.class ? [selection.class as ClearClass] : DEFAULT_CLASSES);
    const window = planned.entries.slice(0, size);
    const pastWindow = planned.entries.length - window.length;
    const before = { ...planned.counts };
    const projected = { ...before };
    for (const entry of window) {
      if (entry.class !== 'restore') { projected[entry.class]!--; continue; }
      projected.restorable!--;
      projected.already_restored!++;
    }
    const hash = previewHash(hashParts(scope, selection, window));
    if (window.length) await saveApprovedSet<Approved>(engine, { command: 'private-labels', hash }, window);
    const gitPublish = restore ? 0 : before['git-publish'] ?? 0;
    const warnings = [
      ...(pastWindow ? [`This preview lists one window of ${window.length} item(s); ${pastWindow} more found past it. Apply this window (or decide not to), then preview again for the next one: ${command}`] : []),
      restore ? 'Restoring re-adds each recorded label, so remote callers that are not the brain owner stop reading these pages again.'
        : 'Clearing a label widens what remote callers that are not the brain owner can read: each cleared page becomes readable remotely (readable_by and folder rules still apply). '
          + 'Undo with: gbrain repair private-labels --class restore',
      ...(gitPublish && selection.class === 'git-publish' ? [`${gitPublish} page(s) of class git-publish live in git-canonical sources, where private pages are database-only; `
        + 'clearing commits each listed page into its source\'s Git history for the first time. That part is one-way: --class restore re-adds the label and removes the file '
        + 'from the checkout, but every earlier commit, and any remote it was pushed to, keeps the page\'s content.'] : []),
      ...(gitPublish && selection.class !== 'git-publish' ? [`${gitPublish} page(s) of class git-publish (git-canonical sources) carry the same label and are not in this preview: `
        + 'private pages there are database-only, so clearing commits each into its source\'s Git history for the first time. Preview them by name: gbrain repair private-labels --class git-publish'] : []),
      ...(planned.unreadable ? [`${planned.unreadable} ledger line(s) could not be read and are not planned.`] : []),
      ...(restore && before.removed_after_restore ? [`${before.removed_after_restore} page(s) had their label removed after a restore landed (the page changed since the revision the restore wrote), `
        + 'so they are not listed; re-add the label by hand if that edit was a mistake.'] : []),
      ...(restore && !Object.values(before).some(Boolean) ? [`The ledger ${ledger!.path} has no line for brain ${scope.brain_id} in this scope. Restore reads only the ledger on the host `
        + 'and GBRAIN_HOME that ran the clear; run it there.'] : []),
    ];
    return { items: toItems(window), preview_hash: hash, residuals: {}, warnings,
      listing: window.map(entry => ({ item: `${entry.source_id}:${entry.slug}`, class: entry.class,
        detail: entry.mode === 'restore' ? `re-add ${describeLabels(entry.labels)}` : entry.labels.visibility ? 'remove access: private, visibility: private' : 'remove access: private' })),
      details: { counts: { before, after: projected }, window: { size, listed: window.length, pending_past_window: pastWindow, next_preview: command },
        ledger: ledger?.path ?? null, class: selection.class } };
  },
  async apply(ctx, raw, opts): Promise<RepairItemOutcome> {
    const item = raw as LabelsItem;
    const { entry } = item;
    const changed: RepairItemOutcome = { applied: false, outcome: 'changed_since_preview' };
    const snapshot = await ctx.engine.readPageSnapshot(entry.slug, { sourceId: entry.source_id });
    if (!snapshot || Number(snapshot.page.id) !== entry.page_id || snapshot.revision !== entry.revision) return changed;
    if (isSegmentedPage(snapshot.page)) return { applied: false, outcome: 'segmented_page', reason: 'The page body is stored in segments; edit its frontmatter by hand on the brain host.' };
    const frontmatter = snapshot.page.frontmatter ?? {};
    const labels = ledgerLabels(entry.labels);
    if (!labels) return changed;
    let next: Record<string, unknown>;
    if (entry.mode === 'clear') {
      let decided: Decision = null;
      await scanLabelled(ctx.engine, [entry.source_id], row => { decided = classifyPrivateLabel(row); }, [entry.page_id]);
      const current = decided as Decision;
      if (!current || !('clear' in current) || current.clear !== entry.class || !sameLabels(current.removed, labels)) return changed;
      next = Object.fromEntries(Object.entries(frontmatter).filter(([key]) => !Object.hasOwn(labels, key)));
    } else {
      if (Object.keys(labels).some(key => Object.hasOwn(frontmatter, key))) return changed;
      next = { ...frontmatter, ...labels };
    }
    const authority = await maintenancePreflight(ctx.engine, entry.source_id);
    const requestId = await repairRequestId(ctx, 'private-labels', item, snapshot.revision);
    const line: LedgerLine = { at: new Date().toISOString(), brain_id: entry.brain_id, source_id: entry.source_id, slug: entry.slug, page_id: entry.page_id,
      revision_before: snapshot.revision, request_id: requestId, ...(entry.mode === 'clear' ? { removed: labels } : { restored: labels }) };
    try { item.ledger.record({ ...line, phase: 'intent' }); } catch (error) {
      throw opError('storage_error', `${entry.source_id}:${entry.slug} was not written: the undo ledger ${item.ledger.path} did not take its intent line (${error instanceof Error ? error.message : String(error)}).`,
        `Make ${item.ledger.path} writable by this user, then rerun the same apply command; nothing was changed and the approved preview is kept.`);
    }
    const content = serializePageToMarkdown({ ...snapshot.page, frontmatter: next }, snapshot.tags);
    let written: string | null;
    if (authority) {
      await publishMaintenancePage(ctx.engine, authority, entry.slug, content, { expectedRevision: snapshot.revision, requestId, keepTrust: true });
      written = (await ctx.engine.readPageSnapshot(entry.slug, { sourceId: entry.source_id }))?.revision ?? null;
    } else {
      written = await importAtRevision(ctx.engine, entry, snapshot.revision, content, opts?.embed === true);
      if (!written) return changed;
    }
    const outcome = entry.mode === 'clear' ? 'cleared' : 'restored';
    try { item.ledger.record({ ...line, at: new Date().toISOString(), phase: 'committed', ...(written ? { revision_after: written } : {}) }); } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { applied: true, outcome, reason: `The page was written and its intent line is in the ledger, so --class restore finds it, but its commit line was not saved (${message}).`,
        detail: { ledger: item.ledger.path, ledger_error: message, labels } };
    }
    return { applied: true, outcome, detail: { ledger: item.ledger.path } };
  },
  /** GST-2128 item 7: the approved set is retired only by an apply that attempted every item with no failure, stop or pending write. */
  async report(ctx, _scope, result, opts) {
    if (result.mode === 'apply' && opts.expect && result.complete && !result.stopped && !result.failed.length && !result.pending?.length) {
      await clearApprovedSet(ctx.engine, { command: 'private-labels', hash: opts.expect });
    }
    return {};
  },
  render(details) {
    const counts = details.counts as { before: Record<string, number>; after: Record<string, number> } | undefined;
    const line = (values: Record<string, number>) => Object.entries(values).map(([key, value]) => `${key}=${value}`).join(', ');
    return [...(counts ? [`  before: ${line(counts.before)}`, `  after (this window applied): ${line(counts.after)}`] : []), ...(details.ledger ? [`  ledger: ${String(details.ledger)}`] : [])];
  },
};
