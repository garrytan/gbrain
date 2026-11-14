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
 * item is one revision-bound label-only write (repair/label-write.ts), so it keeps the page's
 * trust tier (no trust_tier marker, no lower_page proposal) and its gate markers: a managed
 * brain publishes it through the maintenance door (the Git door on a repo source) with
 * keep_trust and its label edit, so the page's file changes only in the removed or re-added
 * label lines (GST-2468); an unmanaged one imports it in a maintenance transaction under the
 * page lock, also keeping the stored tier. readable_by and folder rules are left as they are.
 *
 * The preview also counts, per window and by category, the pages whose only privacy is a listed
 * page's label and that the window would expose with it (`dependents`, never slugs): derived_from
 * pages whose declared origin loses its visibility: private, and life-chronicle events extracted
 * from a listed page. On a brain without managed persistence a page whose file sits in its source's
 * checkout is held (`file_backed`): the repair writes only the database there, and the next sync or
 * re-import would put the label back from the file.
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
import { openTwins, openTwinsLines, openTwinsWarning, type OpenTwins } from '../access/open-twins.ts';
import { ownerMemberId } from '../access/owner.ts';
import { opError, type OperationContext } from '../ops/contract.ts';
import { maintenancePreflight, publishMaintenancePages, type MaintenanceAuthority } from '../persistence/prepared-maintenance.ts';
import { isPlainLabelValue, type LabelEdit } from '../persistence/label-edit.ts';
import { filesInCheckout, labelFileRefusal, writeLabelPage } from './label-write.ts';
import { getWriteRequest } from '../persistence/journal.ts';
import { isTerminal } from '../persistence/model.ts';
import { requestPrincipalForContext } from '../persistence/page-mutations.ts';
import { digest } from '../persistence/digest.ts';
import { modeRequiresSynopsis } from '../embedding-context.ts';
import { chunkGenerationFilter } from '../search/safe-chunks.ts';
import { isSegmentedPage } from '../page-body/page-shape.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { PRIVACY_ALIASES, privacyAliasSql, privacyPartSql, privateSnapshotFilterFragment, readHonorAliases } from '../search/private-visibility.ts';
import { asciiLower } from '../edge-whitespace.ts';
import { afterCursor, repairRequestId, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairPlan, type RepairPlanOptions, type RepairScope, type RepairSettlement } from './core.ts';

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
/** `tried` (GBRA-443): an earlier apply tried this page and it did not change; its decline again does not count toward the breaker. */
interface Approved { mode: 'clear' | 'restore'; class: LabelsClass; brain_id: string; source_id: string; slug: string; page_id: number; revision: string | null; labels: Labels; chars: number; selection: Selection; exposes?: number[]; tried?: true }
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
  const value = (key: string) => typeof fm[key] === 'string' ? asciiLower((fm[key] as string).trim()) : null;
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
  items: entries.map(e => [e.mode, e.class, e.source_id, e.page_id, e.slug, e.revision, Object.entries(e.labels).sort(), e.exposes ?? []]) });

/** Every category's count over the scope and the clear entries of the selected classes, in (class, page id) order. */
async function planClear(engine: BrainEngine, scope: RepairScope, selection: Selection, classes: readonly ClearClass[], ledger?: PrivateLabelsLedger) {
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
  const tried = triedBefore(ledger, scope.brain_id);
  for (const entry of entries) if (tried.has(entry.source_id + '\0' + entry.page_id)) entry.tried = true;
  const retry = (entry: Approved) => Number(entry.tried === true);
  entries.sort((a, b) => retry(a) - retry(b) || CLEAR_CLASSES.indexOf(a.class as ClearClass) - CLEAR_CLASSES.indexOf(b.class as ClearClass) || a.page_id - b.page_id);
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
 * The windowDependents statement: (id, cleared_id, category) for each exposed page and the cleared page it is tied to, from
 * the cleared pages ($1 ids, $2 source ids, $3 slugs, $4 comma-joined label keys). It never pairs every page with every
 * cleared page: one scan of the window's sources lists each page's references (source_slug, event.depth, each
 * derived_from slug without `.md`), and every tie is an equality join of those references, or of concept-provenance
 * links through idx_links_to, to the cleared pages. The postimage is the pages table shadowed with the window's keys
 * removed; its privacy rules read only candidate pages and the pages they name.
 *
 * GST-2689 `remove`: the postimage is the pages table with the cleared pages removed instead (their rows, so the links to
 * them go too), `keys` is unused, an atom also ties to the page a rename moved its `source_slug` to (slug_aliases and
 * slug_rename_history, read before a purge scrubs them). A page that names readers is judged by the same privacy rules,
 * since readable_by never relaxes them: it is returned when the removal would open it to its listed readers. A soft-deleted
 * page is a candidate too, since a restore brings it back with the origin row gone, and so is a removed page tied to
 * another removed page (judged on its own row, against the postimage), since another hold may keep it from the purge.
 */
export function dependentsSql(mode: 'clear' | 'remove' = 'clear'): string {
  const remove = mode === 'remove';
  const live = (sql: string) => remove ? '' : sql;
  return `WITH cleared AS MATERIALIZED (
      SELECT * FROM unnest($1::integer[], $2::text[], $3::text[], $4::text[]) AS c(id, source_id, slug, keys)),
    refs AS MATERIALIZED (SELECT p.id, p.source_id, p.slug, p.deleted_at, r.kind, r.ref FROM pages p
      CROSS JOIN LATERAL (SELECT 'source_slug' AS kind, p.frontmatter->>'source_slug' AS ref
        UNION ALL SELECT 'depth', p.frontmatter->'event'->>'depth'
        UNION ALL SELECT 'declared', regexp_replace(declared.slug, '\\.md$', '') FROM jsonb_array_elements_text(
          CASE jsonb_typeof(p.frontmatter->'derived_from') WHEN 'array' THEN p.frontmatter->'derived_from'
            WHEN 'string' THEN jsonb_build_array(p.frontmatter->'derived_from') ELSE '[]'::jsonb END) AS declared(slug)${remove ? `
        UNION ALL SELECT 'source_slug', renamed.canonical_slug FROM slug_aliases renamed WHERE renamed.source_id = p.source_id
          AND renamed.alias_slug = p.frontmatter->>'source_slug' AND renamed.notes = 'rename'
        UNION ALL SELECT 'source_slug', moved.new_slug FROM slug_rename_history moved WHERE moved.source_id = p.source_id
          AND moved.old_slug = p.frontmatter->>'source_slug'` : ''}) r
      WHERE p.source_id = ANY($2::text[]) AND r.ref IS NOT NULL),
    hits AS MATERIALIZED (SELECT r.id, r.source_id, r.slug, r.deleted_at, r.kind, c.id AS cleared_id
      FROM refs r JOIN cleared c ON c.source_id = r.source_id AND c.slug = r.ref),
    provenance AS MATERIALIZED (SELECT l.from_page_id, x.cleared_id, x.source_id
      FROM (SELECT c.id, c.id AS cleared_id, c.source_id FROM cleared c UNION ALL SELECT h.id, h.cleared_id, h.source_id FROM hits h WHERE h.kind = 'source_slug') x
      JOIN links l ON l.to_page_id = x.id WHERE l.link_source = 'concept-provenance' AND l.link_type = 'synthesized_from'),
    ties AS (SELECT h.id, h.cleared_id FROM hits h${live(' WHERE h.deleted_at IS NULL')}
      UNION ALL SELECT r.id, h.cleared_id FROM hits h JOIN refs r ON r.source_id = h.source_id AND r.kind = 'depth' AND r.ref = h.slug
        WHERE h.kind = 'declared'${live(' AND r.deleted_at IS NULL')}
      UNION ALL SELECT p.id, t.cleared_id FROM provenance t JOIN pages p ON p.id = t.from_page_id AND p.source_id = t.source_id${live(' AND p.deleted_at IS NULL')}),
    candidates AS MATERIALIZED (SELECT DISTINCT t.id, t.cleared_id FROM ties t WHERE ${remove ? 't.id <> t.cleared_id' : 'NOT EXISTS (SELECT 1 FROM cleared x WHERE x.id = t.id)'}),${remove ? `
    candidate_rows AS MATERIALIZED (SELECT a.id, a.source_id, a.slug, a.type, a.frontmatter FROM pages a WHERE a.id IN (SELECT id FROM candidates)),` : ''}
    public_after AS MATERIALIZED (WITH pages AS NOT MATERIALIZED (SELECT pg.id, pg.source_id, pg.slug, pg.type, pg.deleted_at,
          CASE WHEN c.id IS NULL THEN pg.frontmatter ELSE pg.frontmatter - string_to_array(c.keys, ',') END AS frontmatter
        FROM pages pg LEFT JOIN cleared c ON c.id = pg.id${remove ? ' WHERE c.id IS NULL' : ''})
      SELECT after_clear.id FROM (${remove ? 'SELECT * FROM candidate_rows' : `SELECT a.id, a.source_id, a.slug, a.type, a.frontmatter FROM (SELECT DISTINCT id FROM candidates) k
        JOIN pages a ON a.id = k.id`} OFFSET 0) after_clear WHERE ${privacyPartSql('after_clear', true)})
    SELECT cand.id, cand.cleared_id, CASE WHEN p.type = 'event' AND p.frontmatter->>'captured_via' LIKE 'life-chronicle:%' THEN 'life_chronicle'
        WHEN p.type = 'atom' THEN 'atom' WHEN p.type = 'concept' AND p.frontmatter->>'synthesized_by' IS NOT NULL THEN 'concept' ELSE 'derived_from' END AS category
      FROM candidates cand JOIN pages p ON p.id = cand.id
      WHERE cand.id IN (SELECT id FROM public_after) AND NOT ${privacyPartSql('p')}
      ORDER BY cand.id, cand.cleared_id`;
}

type Dependents = { derived_from: number; atom: number; concept: number; life_chronicle: number };

/**
 * GST-2093: the pages a window's clears expose besides themselves, by category, judged by the remote privacy rules
 * (privacyPartSql) on each page as it is now and as it would be once the window applies. A candidate is a live page of
 * the same source tied to a cleared page the way those rules follow privacy: `derived_from`, an atom's `source_slug`, a
 * life-chronicle event's `event.depth` (or the `derived_from` of the page it names), or a concept-provenance link to a cleared atom or to an atom of a cleared origin.
 * The postimage is the pages table shadowed with the window's keys removed. Also returned, per cleared page id, the
 * exposed page ids tied to it: the preview hash binds them, and apply refuses a window that would expose a page outside them.
 */
async function windowDependents(engine: BrainEngine, window: Approved[]): Promise<{ counts: Dependents; exposes: Map<number, number[]> }> {
  const counts: Dependents = { derived_from: 0, atom: 0, concept: 0, life_chronicle: 0 };
  const exposes = new Map<number, number[]>();
  const clears = window.filter(entry => entry.mode === 'clear');
  if (!clears.length) return { counts, exposes };
  await readHonorAliases(engine);
  const rows = await engine.executeRaw<{ id: number; cleared_id: number; category: keyof Dependents }>(dependentsSql(),
    [clears.map(entry => entry.page_id), clears.map(entry => entry.source_id), clears.map(entry => entry.slug), clears.map(entry => Object.keys(entry.labels).sort().join(','))],
    { ...bounded, jitOff: true, prepare: false });
  const counted = new Set<number>();
  for (const row of rows) {
    const id = Number(row.id);
    if (!counted.has(id)) { counted.add(id); counts[row.category]++; }
    exposes.set(Number(row.cleared_id), [...(exposes.get(Number(row.cleared_id)) ?? []), id]);
  }
  return { counts, exposes };
}

/** GBRA-443: lines this run appended to its ledger, by phase (the apply result's ledger_rows_written and ledger_rows), kept on the ledger it was handed. */
type CountedLedger = PrivateLabelsLedger & { rows?: { intent: number; committed: number } };
function recordLine(ledger: CountedLedger, line: LedgerLine & { phase: 'intent' | 'committed' }): void {
  ledger.record(line);
  (ledger.rows ??= { intent: 0, committed: 0 })[line.phase]++;
}

/**
 * GBRA-443: the pages (brain, source, page id) whose latest ledger line is a removal's intent line with nothing after it:
 * an earlier apply tried to clear them and the write did not land (a declined page; a crash before its write, too). The
 * preview lists them after every page not tried yet, so a page that keeps declining stops heading each new window.
 */
function triedBefore(ledger: PrivateLabelsLedger | undefined, brainId: string): Set<string> {
  const latest = new Map<string, LedgerLine>();
  for (const raw of ledger?.lines ?? []) {
    const line = readableLine(raw);
    if (line && line.brain_id === brainId) latest.set(line.source_id + '\0' + line.page_id, line);
  }
  return new Set([...latest].flatMap(([key, line]) => line.removed && line.phase === 'intent' ? [key] : []));
}

/** GBRA-443: the listed items whose write embeds: a label-only edit keeps every stored vector except on a page stored under per-chunk synopsis; a page with a chunk that has no vector yet is counted too. */
async function reembedding(engine: BrainEngine, items: LabelsItem[]): Promise<LabelsItem[]> {
  if (!items.length) return [];
  const ids = items.map(item => item.entry.page_id);
  const rows = await engine.executeRaw<{ id: number; mode: string }>(`SELECT id, contextual_retrieval_mode AS mode FROM pages
    WHERE id = ANY($1::integer[]) AND contextual_retrieval_mode IS NOT NULL`, [ids], bounded);
  const unembedded = await engine.executeRaw<{ id: number }>(`SELECT DISTINCT cc.page_id AS id FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
    WHERE cc.page_id = ANY($1::integer[]) AND cc.embedding IS NULL AND ${chunkGenerationFilter('p', 'cc')}`, [ids], bounded);
  const embeds = new Set([...rows.filter(row => modeRequiresSynopsis(row.mode as Parameters<typeof modeRequiresSynopsis>[0])).map(row => Number(row.id)),
    ...unembedded.map(row => Number(row.id))]);
  return items.filter(item => embeds.has(item.entry.page_id));
}

const CHANGED: RepairItemOutcome = { applied: false, outcome: 'changed_since_preview' };
interface Ready { revision: string; content: string; labels: Labels }

/**
 * One approved item re-decided against its live page: the page write it needs, or the outcome that leaves it alone (moved
 * since the preview, segmented, no longer this class, or held as file_backed on an unmanaged brain).
 */
async function prepareWrite(ctx: OperationContext, item: LabelsItem): Promise<Ready | { outcome: RepairItemOutcome }> {
  const { entry } = item;
  const snapshot = await ctx.engine.readPageSnapshot(entry.slug, { sourceId: entry.source_id });
  if (!snapshot || Number(snapshot.page.id) !== entry.page_id || snapshot.revision !== entry.revision) return { outcome: CHANGED };
  if (isSegmentedPage(snapshot.page)) return { outcome: { applied: false, outcome: 'segmented_page', reason: 'The page body is stored in segments; edit its frontmatter by hand on the brain host.' } };
  const frontmatter = snapshot.page.frontmatter ?? {};
  const labels = ledgerLabels(entry.labels);
  if (!labels) return { outcome: CHANGED };
  let next: Record<string, unknown>;
  if (entry.mode === 'clear') {
    let decided: Decision = null;
    await scanLabelled(ctx.engine, [entry.source_id], row => { decided = classifyPrivateLabel(row); }, [entry.page_id]);
    const current = decided as Decision;
    if (!current || !('clear' in current) || current.clear !== entry.class || !sameLabels(current.removed, labels)) return { outcome: CHANGED };
    next = Object.fromEntries(Object.entries(frontmatter).filter(([key]) => !Object.hasOwn(labels, key)));
  } else {
    if (Object.keys(labels).some(key => Object.hasOwn(frontmatter, key))) return { outcome: CHANGED };
    if (!Object.values(labels).every(isPlainLabelValue)) {
      return { outcome: { applied: false, outcome: 'label_not_plain', reason: `${describeLabels(labels)} cannot be written back as plain label lines; add it to the page's file by hand, commit it, then run: gbrain sync --source ${entry.source_id}` } };
    }
    next = { ...frontmatter, ...labels };
  }
  const file = (await filesInCheckout(ctx.engine, [entry.page_id])).get(entry.page_id);
  if (file) {
    return { outcome: { applied: false, outcome: 'file_backed', detail: { path: file },
      reason: `${entry.source_id}:${entry.slug} has a file in its source's checkout (${file}); on a brain without managed persistence this repair writes only the database, `
        + `so the next sync or re-import would undo it from the file. ${entry.mode === 'clear' ? `Remove ${describeLabels(labels)} from that file's frontmatter`
          : `Add ${describeLabels(labels)} back to that file's frontmatter if it is missing`}, commit it, then run: gbrain sync --source ${entry.source_id}` } };
  }
  const content = serializePageToMarkdown({ ...snapshot.page, frontmatter: next }, snapshot.tags);
  // GST-2603: a file that holds the page but cannot take the label edit line by line declines here, before its intent line.
  const refusal = await labelFileRefusal(ctx.engine, snapshot, content, labelEditOf(entry));
  if (refusal?.reason === 'label_edit_refused') throw refusal.error;
  return { revision: snapshot.revision, content, labels };
}

/** The item's ledger line under its deterministic request id (a resumed run replays the same request). */
async function ledgerLine(ctx: OperationContext, item: LabelsItem, ready: Ready): Promise<LedgerLine> {
  const { entry } = item;
  return { at: new Date().toISOString(), brain_id: entry.brain_id, source_id: entry.source_id, slug: entry.slug, page_id: entry.page_id,
    revision_before: ready.revision, request_id: await repairRequestId(ctx, 'private-labels', item, ready.revision),
    ...(entry.mode === 'clear' ? { removed: ready.labels } : { restored: ready.labels }) };
}

/** Write-ahead: the intent line lands before the page write, or the item is refused with nothing written. */
function recordIntent(item: LabelsItem, line: LedgerLine): void {
  try { recordLine(item.ledger, { ...line, phase: 'intent' }); } catch (error) {
    throw opError('storage_error', `${line.source_id}:${line.slug} was not written: the undo ledger ${item.ledger.path} did not take its intent line (${error instanceof Error ? error.message : String(error)}).`,
      `Make ${item.ledger.path} writable by this user, then rerun the same apply command; nothing was changed and the approved preview is kept.`);
  }
}

/** The landed write's committed line, with the revision it wrote; a ledger that cannot take it still leaves the intent line restore reads. */
function committedOutcome(item: LabelsItem, line: LedgerLine, written: string | null): RepairItemOutcome {
  const outcome = item.entry.mode === 'clear' ? 'cleared' : 'restored';
  try { recordLine(item.ledger, { ...line, at: new Date().toISOString(), phase: 'committed', ...(written ? { revision_after: written } : {}) }); } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { applied: true, outcome, reason: `The page was written and its intent line is in the ledger, so --class restore finds it, but its commit line was not saved (${message}).`,
      detail: { ledger: item.ledger.path, ledger_error: message, labels: line.removed ?? line.restored } };
  }
  return { applied: true, outcome, detail: { ledger: item.ledger.path } };
}

const writtenRevision = async (engine: BrainEngine, entry: Approved) => (await engine.readPageSnapshot(entry.slug, { sourceId: entry.source_id }))?.revision ?? null;

/** The label edit an item makes: a clear removes its recorded keys, a restore sets them back. */
const labelEditOf = (entry: Approved): LabelEdit => entry.mode === 'clear' ? { set: {}, remove: Object.keys(entry.labels) }
  : { set: entry.labels as Record<string, string>, remove: [] };

/** One item's page write after its intent line (repair/label-write.ts): the maintenance door on a managed brain, the legacy import under the page lock otherwise. */
async function writeOne(ctx: OperationContext, item: LabelsItem, ready: Ready, line: LedgerLine, authority: MaintenanceAuthority | null, embed: boolean): Promise<RepairItemOutcome> {
  recordIntent(item, line);
  const written = await writeLabelPage(ctx, item.entry, { revision: ready.revision, content: ready.content, edit: labelEditOf(item.entry), requestId: line.request_id, embed,
    preview: 'gbrain repair private-labels' }, authority);
  if (!written && !authority) return CHANGED;
  return committedOutcome(item, line, written);
}

export const privateLabelsRepair: RepairHandler = {
  kind: 'private-labels',
  /** GBRA-443: a label-only edit keeps every stored vector; the plan names the pages that re-embed anyway (embedding_items). */
  embeds: false,
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    const selection: Selection = { source_ids: scope.source_ids, class: selectedClass(opts) };
    const command = previewCommand(scope, selection);
    const ledger = opts?.privateLabelsLedger;
    if (!ledger && (opts?.apply || selection.class === 'restore')) {
      throw opError('invalid_params', 'gbrain repair private-labels needs its undo ledger to apply or restore, and this caller passed none.', `Run it from the CLI on the brain host: ${command}`);
    }
    const toItems = (entries: Approved[]) => entries.map((entry, index): LabelsItem => ({ cursor: { phase: 0, id: index }, source_id: entry.source_id, slug: entry.slug,
      chars: entry.chars, action: `${entry.mode === 'clear' ? 'remove' : 're-add'} ${describeLabels(entry.labels)}`, entry, ledger: ledger!,
      ...(entry.tried ? { retried: true } : {}) }));
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
      const approvedExposes = new Set(approved.items.flatMap(entry => entry.exposes ?? []));
      if ([...(await windowDependents(engine, approved.items)).exposes.values()].flat().some(id => !approvedExposes.has(id))) throw previewChangedError(opts.expect, command);
      (ledger as CountedLedger).rows = { intent: 0, committed: 0 };
      const items = toItems(approved.items).filter(item => afterCursor(item.cursor, after));
      return { items, preview_hash: opts.expect, residuals: {}, embedding_items: await reembedding(engine, items) };
    }
    const size = Math.min(Math.max(1, opts?.limit ?? PRIVATE_LABELS_WINDOW), PRIVATE_LABELS_WINDOW_MAX);
    const restore = selection.class === 'restore';
    const planned = restore ? await planRestore(engine, scope, selection, ledger!)
      : await planClear(engine, scope, selection, selection.class ? [selection.class as ClearClass] : DEFAULT_CLASSES, ledger);
    const window = planned.entries.slice(0, size);
    const retried = window.filter(entry => entry.tried).length;
    const pastWindow = planned.entries.length - window.length;
    const before = { ...planned.counts };
    const projected = { ...before };
    for (const entry of window) {
      if (entry.class !== 'restore') { projected[entry.class]!--; continue; }
      projected.restorable!--;
      projected.already_restored!++;
    }
    const found = restore ? null : await windowDependents(engine, window);
    for (const entry of window) if (found?.exposes.has(entry.page_id)) entry.exposes = found.exposes.get(entry.page_id);
    const hash = previewHash(hashParts(scope, selection, window));
    if (window.length) await saveApprovedSet<Approved>(engine, { command: 'private-labels', hash }, window);
    const gitPublish = restore ? 0 : before['git-publish'] ?? 0;
    const dependents = found?.counts ?? null;
    const exposed = dependents ? Object.values(dependents).reduce((sum, n) => sum + n, 0) : 0;
    const fileBacked = (await filesInCheckout(engine, window.map(entry => entry.page_id))).size;
    const owner = await ownerMemberId(engine);
    const twins = await openTwins(engine, restore ? window : [], owner ? [owner] : [],
      (source, slugs) => `gbrain repair visibility --source ${source}${slugs.map(slug => ` --slug ${slug}`).join('')}`);
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
      ...(exposed ? [`Clearing this window also exposes ${exposed} page(s) whose only privacy is a listed page's label: ${dependents!.derived_from} derived_from page(s), `
        + `${dependents!.atom} atom(s), ${dependents!.concept} synthesized concept(s) and ${dependents!.life_chronicle} life-chronicle event(s) extracted from a listed page. Remote callers that are not the brain owner `
        + 'can read them once this window applies (readable_by and folder rules still apply). To keep one private, give it its own label first; --class restore re-hides them with their origins.'] : []),
      ...(fileBacked ? [`${fileBacked} listed page(s) have a file in their source's checkout on a brain without managed persistence. This repair writes only the database there, `
        + 'and the next sync or re-import would put the label back from the file, so the apply holds each (outcome file_backed) with the file to edit.'] : []),
      ...(retried ? [`${retried} listed page(s) were tried by an earlier apply and did not change (the ledger has their intent line and nothing after it); `
        + 'they are listed after every page not tried yet. Each is tried again and, if its page still declines, left unchanged with its reason; '
        + 'such a decline does not count toward the run\'s systemic-failure stop.'] : []),
      ...openTwinsWarning(twins),
      ...(planned.unreadable ? [`${planned.unreadable} ledger line(s) could not be read and are not planned.`] : []),
      ...(restore && before.removed_after_restore ? [`${before.removed_after_restore} page(s) had their label removed after a restore landed (the page changed since the revision the restore wrote), `
        + 'so they are not listed; re-add the label by hand if that edit was a mistake.'] : []),
      ...(restore && !Object.values(before).some(Boolean) ? [`The ledger ${ledger!.path} has no line for brain ${scope.brain_id} in this scope. Restore reads only the ledger on the host `
        + 'and GBRAIN_HOME that ran the clear; run it there.'] : []),
    ];
    const items = toItems(window);
    return { items, preview_hash: hash, residuals: {}, warnings, embedding_items: await reembedding(engine, items),
      listing: window.map(entry => ({ item: `${entry.source_id}:${entry.slug}`, class: entry.class,
        detail: entry.mode === 'restore' ? `re-add ${describeLabels(entry.labels)}` : entry.labels.visibility ? 'remove access: private, visibility: private' : 'remove access: private' })),
      details: { counts: { before, after: projected }, window: { size, listed: window.length, pending_past_window: pastWindow, next_preview: command, file_backed: fileBacked, tried_before: retried },
        ...(dependents ? { dependents } : {}), ...(twins.count ? { open_twins: twins } : {}),
        ledger: ledger?.path ?? null, class: selection.class } };
  },
  async apply(ctx, raw, opts): Promise<RepairItemOutcome> {
    const item = raw as LabelsItem;
    const ready = await prepareWrite(ctx, item);
    if ('outcome' in ready) return ready.outcome;
    const authority = await maintenancePreflight(ctx.engine, item.entry.source_id);
    return writeOne(ctx, item, ready, await ledgerLine(ctx, item, ready), authority, opts?.embed === true);
  },
  /**
   * GBRA-443: a run of approved items at once. Each is re-decided as apply does; on a managed brain every page of a source
   * gets its intent line first (write-ahead for the whole run), then the pages are admitted together and the owner publishes
   * them in groups (publishMaintenancePages), each page its own fate: a declined page fails alone. The batch id is the
   * approval hash, so a window resumed at any item replays its pending requests. An unmanaged source writes one page at a
   * time, as apply does.
   */
  async applyBatch(ctx, raw, opts) {
    const items = raw as LabelsItem[];
    const out: RepairSettlement[] = new Array(items.length);
    // Once any page of this call may have been written, a later throw settles the pages it left instead of discarding the batch.
    let wrote = false;
    const settle = (index: number, write: () => Promise<RepairItemOutcome>) => { wrote = true; return write().then(value => { out[index] = { value }; }, error => { out[index] = { error }; }); };
    const ready: Array<Ready | null> = [];
    for (const [index, item] of items.entries()) {
      const prepared = await prepareWrite(ctx, item).catch((error: unknown) => ({ error }));
      ready.push('revision' in prepared ? prepared : null);
      if ('error' in prepared) out[index] = { error: prepared.error };
      else if ('outcome' in prepared) out[index] = { value: prepared.outcome };
    }
    const principal = await requestPrincipalForContext(ctx);
    for (const sourceId of new Set(items.map(item => item.entry.source_id))) {
      const indices = items.flatMap((item, index) => item.entry.source_id === sourceId && ready[index] ? [index] : []);
      if (!indices.length) continue;
      try {
        const preflight = await maintenancePreflight(ctx.engine, sourceId).then(authority => ({ authority }), (error: unknown) => ({ error }));
        if ('error' in preflight) { for (const index of indices) out[index] = { error: preflight.error }; continue; }
        const { authority } = preflight;
        const batch: Array<{ index: number; line: LedgerLine }> = [];
        for (const index of indices) {
          const line = await ledgerLine(ctx, items[index]!, ready[index]!);
          // An unmanaged source, or a request a single-page apply admitted before batching (its intent has no batch id), writes on its own.
          const prior = authority ? await getWriteRequest(ctx.engine, principal, line.request_id) : null;
          if (!authority || (prior && !isTerminal(prior) && typeof prior.intent?.maintenance_batch !== 'string')) {
            await settle(index, () => writeOne(ctx, items[index]!, ready[index]!, line, authority, opts.embed));
            continue;
          }
          batch.push({ index, line });
        }
        if (!batch.length || !authority) continue;
        const admitted: typeof batch = [];
        for (const [position, entry] of batch.entries()) {
          try { recordIntent(items[entry.index]!, entry.line); admitted.push(entry); } catch (error) {
            // A ledger that refuses one intent line refuses the rest too: nothing after it is written.
            for (const rest of batch.slice(position)) out[rest.index] = { error };
            break;
          }
        }
        if (!admitted.length) continue;
        const published = await publishMaintenancePages(ctx.engine, authority, admitted.map(({ index, line }) => ({ slug: items[index]!.entry.slug, content: ready[index]!.content,
          expectedRevision: ready[index]!.revision, requestId: line.request_id, keepTrust: true as const, labelEdit: labelEditOf(items[index]!.entry) })), { batch: digest(['private-labels-batch-v1', opts.expect ?? opts.runId ?? '', sourceId]) });
        wrote = true;
        for (const [position, { index, line }] of admitted.entries()) {
          const settled = published[position]!;
          if ('error' in settled) { out[index] = { error: settled.error }; continue; }
          // A failed read of the written revision still records the committed line (without revision_after).
          out[index] = { value: committedOutcome(items[index]!, line, await writtenRevision(ctx.engine, items[index]!.entry).catch(() => null)) };
        }
      } catch (error) {
        if (!wrote) throw error;
        for (const index of indices) out[index] ??= { error };
      }
    }
    return out;
  },
  /** GBRA-443: a write still pending when its run moved on, committed later in the run: its committed line, as apply writes for one that landed in its wait. */
  async onCommitted(ctx, raw, requestId) {
    const item = raw as LabelsItem;
    const { entry } = item;
    const line: LedgerLine = { at: new Date().toISOString(), brain_id: entry.brain_id, source_id: entry.source_id, slug: entry.slug, page_id: entry.page_id,
      revision_before: entry.revision ?? '', request_id: requestId, ...(entry.mode === 'clear' ? { removed: entry.labels } : { restored: entry.labels }) };
    committedOutcome(item, line, await writtenRevision(ctx.engine, entry));
  },
  /**
   * GST-2128 item 7: the approved set is retired only by an apply that attempted every item with no failure, stop or pending write.
   * GBRA-443: an apply reports where its ledger is and how many lines it appended (intent and committed), so a caller can
   * check the file grew by ledger_rows_written and that every applied page has its committed line.
   */
  async report(ctx, _scope, result, opts) {
    if (result.mode === 'apply' && opts.expect && result.complete && !result.stopped && !result.failed.length && !result.pending?.length) {
      await clearApprovedSet(ctx.engine, { command: 'private-labels', hash: opts.expect });
    }
    const ledger = opts.privateLabelsLedger;
    if (result.mode !== 'apply' || !ledger) return {};
    const rows = (ledger as CountedLedger).rows ?? { intent: 0, committed: 0 };
    return { details: { ...result.details, ledger: ledger.path, ledger_rows_written: rows.intent + rows.committed, ledger_rows: { ...rows } } };
  },
  render(details) {
    const counts = details.counts as { before: Record<string, number>; after: Record<string, number> } | undefined;
    const line = (values: Record<string, number>) => Object.entries(values).map(([key, value]) => `${key}=${value}`).join(', ');
    const dependents = details.dependents as Record<string, number> | undefined;
    const rows = details.ledger_rows as { intent: number; committed: number } | undefined;
    return [...(counts ? [`  before: ${line(counts.before)}`, `  after (this window applied): ${line(counts.after)}`] : []),
      ...(dependents ? [`  also exposed by this window: ${line(dependents)}`] : []),
      ...openTwinsLines(details.open_twins as OpenTwins | undefined),
      ...(details.ledger ? [`  ledger: ${String(details.ledger)}${rows ? ` (this run appended ${rows.intent + rows.committed} line(s): ${rows.intent} intent, ${rows.committed} committed)` : ''}`] : [])];
  },
};
