/**
 * `gbrain repair slug-spelling --source <id>`: move pages stored under an older spelling of their name to the normal
 * slug (`normalizeSlug`: lowercase, then Unicode NFC).
 *
 * Writes store slugs in the normal form, so a page saved before that (capitals, or a decomposed `café`) still opens by
 * any spelling and takes small edits, but a put by its stored spelling is refused and an import of its file is held
 * (persistence/legacy-slug-put.ts): either would create a second page that prints the same name. This repair moves the
 * page itself, so both work again. It is explicit-only, preview-bound and destructive: `--all`, the maintenance cycle and
 * the doctor remediation never run it, and a remote caller is refused.
 *
 * The preview lists every page of one source whose slug is not its normal slug, bounded like the legacy-twins scan, and
 * classifies each:
 *  - `move`: the normal slug is free in the source and the page's file evidence agrees.
 *  - `needs_human` (`slug_spelling_collision`): a page (live or soft-deleted) already holds the normal slug, or two stored
 *    spellings share it. Moving one would merge two pages, so nothing moves; the listing names the pages to compare.
 *  - `rename_file_first` (`rename_file_first`): the page has a file in the source's checkout, and it is not at the path
 *    of the normal slug (or cannot be found on disk), or a file sits at the path of the old spelling. Moving only the
 *    database row would split the page from its file; the owner renames the file in Git, then syncs, and sync carries the page.
 * A held write (an active quarantine hold of a fact or take) does not stop a move: a hold bound to the page follows its page id,
 * and an unbound hold under the old spelling reaches the page through the rename record `updateSlug` writes
 * (`holdAppliesToPageSql`), so the held content stays out of the moved page, and no hold is re-keyed or decided.
 * The plan hash binds the brain, the source incarnation and, for every page, its id, revision, recorded origin
 * and source path, and the file evidence read from the checkout.
 *
 * Apply moves each approved page in its own `maintenanceTransaction`: both page keys (the stored spelling and the normal slug) are locked, every bound fact is read
 * again (a change refuses `changed_since_preview` and nothing moves), the normal slug must still be free, then `updateSlug`
 * moves the page (version preimage, redirect alias, slug-keyed facts, withdrawals, search aliases) and the attachments'
 * `files.page_slug` follow, and the page's purge tombstones are copied to the normal slug (slug-spelling-guards.ts).
 * The transaction runs under `withStoredSlug`, so the lock on the stored spelling is taken like any writer's. A fault in any step rolls the whole page back. Page ids, versions, tags, timeline, links,
 * attachment ids, storage paths and bytes do not change. The page keeps its recorded origin only because the file
 * evidence proved the file is at the normal path (or the source has no checkout). Applying a set again moves nothing.
 *
 * Classic brains only: on a managed brain page tables take writes only through coordinated publications, so the preview
 * says `managed_remedy_unavailable` and an apply refuses with it; the message says a person is needed and names no repair command.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { Action } from '../agent-output.ts';
import { shellQuote } from '../agent-output.ts';
import { OperationError } from '../ops/contract.ts';
import { readFix, trustedCliRequired } from '../ops/op-fix.ts';
import { resolveRecordedSourceFilePath, sourceGitScope } from '../markdown.ts';
import type { SlugRootMode } from '../sync-anchor.ts';
import { normalizeSlug, validateSlug, withStoredSlug } from '../utils.ts';
import { serverEncoding, spellingKeys } from '../slug-spelling-key.ts';
import { lockedBeliefBatch } from '../belief/writers.ts';
import { markBeliefCommits } from '../belief/append.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import { slugSpellingPreviewArgv } from '../persistence/legacy-slug-put.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import { loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { assertGuardTablesReadable, carryGuards, rekeyAttachments } from './slug-spelling-guards.ts';
import { afterCursor, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairListing, type RepairPlan, type RepairScope } from './core.ts';

const DOCS = 'docs/guides/repair.md#slug-spelling';
export const MANAGED_REMEDY_UNAVAILABLE = 'managed_remedy_unavailable';
/** Pages one preview lists; more are moved in rounds (apply, then preview again). */
export const SLUG_SPELLING_LIMIT = 1000;
/** Candidate rows the scan reads per source before it stops and says so. */
export const SLUG_SPELLING_SCAN_LIMIT = 100_000;
let scanLimit = SLUG_SPELLING_SCAN_LIMIT;
/** Test hook: lowers the candidate rows one preview reads (no argument restores the default). */
export function __setSlugSpellingScanLimitForTests(limit?: number): void { scanLimit = limit ?? SLUG_SPELLING_SCAN_LIMIT; }
const BATCH = 5_000;

const REASON_HISTORY = 'History or a log: it keeps the spelling it was written under, and a page rename (updateSlug) does not move it either.';
const REASON_DERIVED = 'Derived or cached state keyed by slug: a page rename (updateSlug) does not move it either; it is rebuilt or ages out.';
const REASON_RECORD = 'A record about the page that a page rename (updateSlug) does not move either; it keeps the spelling it was created under.';
const REASON_PREFIX = 'A folder prefix, not the slug of one page.';

/** Every column of the schema that holds a page slug and is re-keyed by this repair (through `updateSlug` or the attachment rekey). */
export const SLUG_COLUMNS_MOVED: readonly string[] = [
  'pages.slug', 'facts.entity_slug', 'facts.source_markdown_slug', 'fact_withdrawals.subject', 'page_aliases.slug', 'secret_store_occurrence.slug',
  'slug_aliases.alias_slug', 'slug_aliases.canonical_slug', 'slug_rename_history.old_slug', 'slug_rename_history.new_slug', 'files.page_slug',
  // Active guards the repair carries to the normal slug itself (`carryGuards`): purge tombstones are copied (the old rows stay).
  'fact_purges.subject', 'take_purges.subject',
];

/** Every other slug-holding column, with why the repair leaves it. test/repair-slug-spelling.test.ts scans the schema so a new one cannot be missed. */
export const SLUG_COLUMNS_EXEMPT: Readonly<Record<string, string>> = {
  'belief_events.slug': REASON_HISTORY,
  'belief_page_lifetimes.slug': 'Moved by the belief batch the page move runs in (the ledger renames the page lifetime), not by the repair\'s own statements.',
  'chronicle_page_state.slug': REASON_DERIVED,
  'chronicle_page_state.event_slugs': REASON_DERIVED,
  'context_volunteer_events.slug': REASON_HISTORY,
  'core_edit_notices.slug': REASON_HISTORY,
  'decide_review_proposals.subject': REASON_RECORD,
  'entity_identity_reviews.canonical_slug': REASON_RECORD,
  'eval_candidates.retrieved_slugs': REASON_HISTORY,
  'fact_relink_attempts.target_slug': REASON_DERIVED,
  'guest_marks.group_slug': REASON_RECORD,
  'guest_marks.slug_at_write': REASON_HISTORY,
  'guest_promotions.target_slug': REASON_RECORD,
  'ingest_applied_captures.slug': REASON_HISTORY,
  'learning_items.subject_slug': 'The subject a learning item named when it was derived, read with its target id; a page rename (updateSlug) does not move it either.',
  'memory_proposals.slug': REASON_RECORD,
  'memory_proposals.to_slug': REASON_RECORD,
  'mention_gazetteer_entries.target_slug': REASON_DERIVED,
  'oauth_clients.bound_slug_prefixes': REASON_PREFIX,
  'oauth_clients.delegated_slug_prefixes': REASON_PREFIX,
  'open_loops.counterparty_slug': REASON_RECORD,
  'open_loops.page_slug': REASON_RECORD,
  'page_body_stagings.slug': 'Staging row of a write in flight; none is open while the page locks are held, and a page rename (updateSlug) does not move it.',
  'page_projection_jobs.slug': REASON_DERIVED,
  'page_purges.slug': REASON_HISTORY,
  'page_write_guards.slug': 'A lock row taken for a write; the repair takes its own page locks on both spellings instead.',
  'persistence_requests.slug': REASON_HISTORY,
  'pinned_questions.scope_slug_prefix': REASON_PREFIX,
  'pinned_questions.slug': REASON_RECORD,
  'question_evidence.page_slug': REASON_RECORD,
  'retrieval_event_links.to_slug': REASON_HISTORY,
  'retrieval_event_pages.slug': REASON_HISTORY,
  'session_context_state.surfaced_slugs': REASON_DERIVED,
  'take_proposals.page_slug': REASON_RECORD,
  'wake_subscriptions.target': REASON_RECORD,
  'write_gate_holds.slug': 'A hold follows its page id (page_id), and an unbound hold under the old spelling reaches the moved page through the rename record updateSlug writes, so no hold is re-keyed; released and dropped holds are decided records and keep the spelling they were recorded under.',
};

export type SlugSpellingClass = 'move' | 'needs_human' | 'rename_file_first';
/** What the checkout says about a page's file; bound into the plan hash and read again at apply. */
export interface FileEvidence {
  checkout: 'none' | 'unavailable' | 'present';
  /** A page that records a file: where it is. */
  origin_file?: 'missing' | 'at_normal_path' | 'elsewhere';
  /** A page that records no file: whether a file sits at the old spelling's path (and not the same file as the normal path's). */
  old_path_file?: boolean;
  normal_path_file?: boolean;
  /** Where the page's file is and where the normal slug puts it, relative to the source's checkout (the `git mv` the fix names). */
  from_path?: string;
  to_path?: string;
}
export interface SpellingPage { page_id: number; slug: string; normal: string; revision: string; deleted: boolean; source_path: string | null; evidence: FileEvidence }
export interface SpellingEntry extends SpellingPage {
  class: SlugSpellingClass;
  /** `slug_spelling_collision` (needs_human) or `rename_file_first`; absent for `move`. */
  code?: 'slug_spelling_collision' | 'rename_file_first';
  /** The other pages (ids and slugs) that print the same name. */
  holders?: Array<{ page_id: number; slug: string }>;
  reason?: string;
}
export interface SpellingScan { source_id: string; incarnation: string; entries: SpellingEntry[]; inspected: number; truncated: boolean }

interface PageRow { id: number | string; slug: string; revision: string; source_path: string | null; deleted: boolean }
interface PageItem extends RepairItem { page: SpellingPage; incarnation: string; moved?: boolean }

/** The consent payload of `--apply --expect <hash> --yes` (registry `consentText`). */
export const SLUG_SPELLING_CONSENT_TEXT = {
  what: 'Move each previewed page stored under an older spelling of its name to its normal slug',
  why: 'The preview listed each page with its id, revision and file evidence; moving it lets a replace by its name and an import of its file work again.',
  risk: 'Each page keeps its id, versions, tags, timeline, links, facts and attachments; only its slug (and the attachment rows\' page name) changes, and its old spelling keeps resolving through an alias. '
    + 'A page whose normal slug is taken, or whose file is not at the normal path, is never moved. Undo with the page\'s old spelling only by moving it back by hand; gbrain has no undo for this repair.',
  user_message: 'Move the previewed pages to their normal slugs? Each keeps its id, history and attachments, and the old spelling keeps resolving',
};

const previewCommand = (sourceId: string) => slugSpellingPreviewArgv(sourceId).join(' ');
const previewAction = (sourceId: string, why = 'Previews the pages of the source stored under an older spelling again; writes nothing.'): Action =>
  ({ ...readFix(why, { argv: [...slugSpellingPreviewArgv(sourceId), '--json'] }), verify: { argv: [...slugSpellingPreviewArgv(sourceId), '--json'] } });
const getArgv = (sourceId: string, slug: string) => ['gbrain', 'get', '--source', sourceId, '--', slug];

function refuse(code: string, message: string, suggestion: string, fix: Action, detail?: Record<string, unknown>): OperationError {
  const error = new OperationError(code, message, suggestion, DOCS);
  error.fix = fix;
  if (typeof detail?.reason === 'string') error.detail = detail.reason;
  return error;
}

/** Stable refusal: something bound by the preview moved. Nothing was changed. */
export function changedSincePreview(sourceId: string, slug: string, why: string): OperationError {
  return refuse('changed_since_preview', `Page ${slug} of source ${sourceId} changed since its preview: ${why}.`,
    `Nothing was moved. Preview again (${previewCommand(sourceId)}), review the new plan and approve its new hash; the refused hash is not reused.`,
    previewAction(sourceId), { reason: why });
}

/** Stable refusal on a managed brain: a person is needed, and no command is named that would refuse again. */
export function managedRemedyRefusal(sourceId: string): OperationError {
  const message = `Moving pages of source ${sourceId} to their normal spelling is unavailable on a managed brain; nothing was written.`;
  const suggestion = 'A person has to decide how to rename each page: it stays readable and editable by its stored spelling, but a replace by that spelling is refused until the page is renamed through the managed route, which does not exist yet.';
  const fix: Action = { consent: [], actor: 'user', why: 'Page tables on a managed brain change only through coordinated publications, so this repair cannot move a page there; the owner decides how to rename it.',
    user_message: `Pages of source ${sourceId} stored under an older spelling cannot be moved automatically on a managed brain. A person has to decide how to rename them; until then each stays readable and editable by its stored spelling.`,
    verify: { argv: ['gbrain', 'doctor', '--only', 'legacy_slug_spellings', '--json'] }, requires_exclusive: false };
  return refuse(MANAGED_REMEDY_UNAVAILABLE, message, suggestion, fix, { reason: 'needs_human' });
}

/** Whether `a` and `b` name the same file (a case-insensitive file system maps two spellings to one file). */
function sameFile(a: string, b: string): boolean {
  try { const x = statSync(a), y = statSync(b); return x.ino === y.ino && x.dev === y.dev; } catch { return false; }
}

const isFile = (path: string): boolean => { try { return statSync(path).isFile(); } catch { return false; } };

/**
 * A slug's file path relative to the source's checkout. A source that is a subfolder of its Git repository, synced in
 * git-root slug mode (the default), names its pages from the repository root, so their slugs carry the folder's path and
 * the file sits under the checkout without it (`notes/alice` is `alice.md` in the `notes/` checkout).
 */
function checkoutPath(slug: string, scope: readonly string[] | null, mode: SlugRootMode | null): string {
  if (!scope?.length || mode === 'source-root') return slug;
  const parts = slug.split('/');
  return parts.length > scope.length && scope.every((segment, i) => normalizeSlug(parts[i]!) === normalizeSlug(segment)) ? parts.slice(scope.length).join('/') : slug;
}

/** The file evidence of one page: what the source's checkout holds at the page's recorded path or at the old spelling's path. */
export function fileEvidence(root: string | null, page: { slug: string; normal: string; source_path: string | null }, mode: SlugRootMode | null = null): FileEvidence {
  if (!root) return { checkout: 'none' };
  if (!existsSync(root)) return { checkout: 'unavailable' };
  const scope = sourceGitScope(root);
  const recorded = page.source_path?.trim();
  if (recorded) {
    // The resolver returns the direct path even when no file is there, so the file itself is checked.
    const resolved = resolveRecordedSourceFilePath(root, recorded, page.slug, mode ?? undefined, scope);
    if (!resolved || !isFile(resolved)) return { checkout: 'present', origin_file: 'missing' };
    const rel = relative(resolve(root), resolved).split(sep).join('/');
    const to = `${checkoutPath(page.normal, scope, mode)}${extname(recorded)}`;
    return { checkout: 'present', origin_file: rel === to ? 'at_normal_path' : 'elsewhere', from_path: rel, to_path: to };
  }
  const at = (slug: string): string | null => { try { validateSlug(slug); return join(root, `${checkoutPath(slug, scope, mode)}.md`); } catch { return null; } };
  const oldPath = at(page.slug), normalPath = at(page.normal);
  const normalFile = !!normalPath && existsSync(normalPath);
  const oldFile = !!oldPath && existsSync(oldPath) && !(normalFile && sameFile(oldPath, normalPath!));
  return { checkout: 'present', old_path_file: oldFile, normal_path_file: normalFile,
    from_path: `${checkoutPath(page.slug, scope, mode)}.md`, to_path: `${checkoutPath(page.normal, scope, mode)}.md` };
}

const fileBlocks = (evidence: FileEvidence, recorded: boolean): string | null => {
  if (evidence.checkout === 'unavailable') return recorded ? 'the source checkout is not on this host, so the page\'s file cannot be found' : null;
  if (evidence.origin_file === 'missing') return 'the page\'s recorded file is not in the checkout';
  if (evidence.origin_file === 'elsewhere') return 'the page\'s file is not at the path of the normal slug';
  if (evidence.old_path_file) return 'a file sits at the path of the old spelling';
  return null;
};

/** One source's pages whose slug is not normal, classified; bounded by `SLUG_SPELLING_LIMIT` listed and `SLUG_SPELLING_SCAN_LIMIT` read. */
export async function scanSlugSpellings(engine: Pick<BrainEngine, 'readSlugRepairSource' | 'listSourceSlugSpellingCandidates' | 'readSpellingKeyPages'>, sourceId: string): Promise<SpellingScan> {
  const source = await engine.readSlugRepairSource(sourceId);
  if (!source) throw new OperationError('invalid_params', `Source '${sourceId}' does not exist.`, 'Run `gbrain sources list` and pass an active source id.');
  const candidates: PageRow[] = [];
  let inspected = 0, truncated = false, after = 0;
  for (;;) {
    // A slug that is not normal has a capital or a character outside printable ASCII; the check below is the exact one.
    const rows: PageRow[] = await engine.listSourceSlugSpellingCandidates(sourceId, after);
    for (const row of rows) {
      if (inspected >= scanLimit) { truncated = true; break; }
      inspected++;
      if (normalizeSlug(row.slug) !== row.slug) candidates.push(row);
    }
    if (rows.length < BATCH || truncated) break;
    after = Number(rows[rows.length - 1]!.id);
  }
  const entries: SpellingEntry[] = [];
  for (const row of candidates) {
    if (entries.length >= SLUG_SPELLING_LIMIT) { truncated = true; break; }
    const normal = normalizeSlug(row.slug);
    const base: SpellingPage = { page_id: Number(row.id), slug: row.slug, normal, revision: String(row.revision), deleted: row.deleted === true, source_path: row.source_path,
      evidence: fileEvidence(source.local_path, { slug: row.slug, normal, source_path: row.source_path }, source.slug_root_mode) };
    const others = await samePrintedName(engine, sourceId, normal, base.page_id);
    if (others.length) { entries.push({ ...base, class: 'needs_human', code: 'slug_spelling_collision', holders: others }); continue; }
    const blocked = fileBlocks(base.evidence, !!base.source_path?.trim());
    entries.push(blocked ? { ...base, class: 'rename_file_first', code: 'rename_file_first', reason: blocked } : { ...base, class: 'move' });
  }
  return { source_id: sourceId, incarnation: source.incarnation, entries, inspected, truncated };
}

/**
 * Refuses (`slug_spelling_encoding`, nothing read or written) on a Postgres database whose encoding is not UTF8: the
 * collision lookup compares composed Unicode (`SPELLING_KEY_SQL`), which such a database cannot evaluate, and a page it
 * missed would be merged into another.
 */
async function assertUtf8(db: Pick<BrainEngine, 'readServerEncoding'>, sourceId: string): Promise<void> {
  const encoding = await serverEncoding(db);
  if (encoding === 'UTF8') return;
  throw new OperationError('slug_spelling_encoding',
    `Pages of source ${sourceId} were not moved: the database encoding is ${encoding}, not UTF8, so the repair cannot find every stored spelling of a name; nothing was written.`,
    'Move the brain to a database created with UTF8 encoding (gbrain doctor reports database_encoding), then preview again.', DOCS);
}

/**
 * Every other page of the source (live or soft-deleted) whose stored slug normalizes to `normal`, the normal slug itself
 * included. Found through the spelling index (`spellingKeys`; the unindexed ASCII key past `MAX_SPELLING_VARIANTS`), so the
 * answer never depends on how many candidates the preview read. The preview classes a page by it, and the apply reads it
 * again under the page locks.
 */
async function samePrintedName(db: Pick<BrainEngine, 'readSpellingKeyPages'>, sourceId: string, normal: string, pageId: number): Promise<Array<{ page_id: number; slug: string }>> {
  const rows = await db.readSpellingKeyPages(sourceId, spellingKeys(normal), normal.replace(/[^a-z0-9]/g, ''), pageId);
  return rows.filter(row => normalizeSlug(row.slug) === normal).map(row => ({ page_id: Number(row.id), slug: row.slug }));
}

/** Per source, how many pages are stored under an older spelling (the doctor check; a count, not the preview's classes). */
export async function countSlugSpellings(engine: Pick<BrainEngine, 'listSlugSpellingCandidates'>): Promise<{ by_source: Array<{ source_id: string; count: number }>; truncated: boolean }> {
  const counts = new Map<string, number>();
  let inspected = 0, truncated = false, after = 0;
  for (;;) {
    // The typed candidate read (engine-sql/slug-spelling-repair.ts): BATCH rows a call, after the last id.
    const rows = await engine.listSlugSpellingCandidates(after);
    for (const row of rows) {
      if (inspected >= SLUG_SPELLING_SCAN_LIMIT) { truncated = true; break; }
      inspected++;
      if (normalizeSlug(row.slug) !== row.slug) counts.set(row.source_id, (counts.get(row.source_id) ?? 0) + 1);
    }
    if (rows.length < BATCH || truncated) break;
    after = Number(rows[rows.length - 1]!.id);
  }
  return { by_source: [...counts].map(([source_id, count]) => ({ source_id, count })).sort((a, b) => a.source_id.localeCompare(b.source_id)), truncated };
}

const entryAction = (sourceId: string, entry: SpellingEntry, root: string | null): Action => {
  if (entry.code === 'slug_spelling_collision') {
    const other = entry.holders![0]!;
    return { ...readFix(`Shows page ${other.slug}, which prints the same name as ${entry.slug}; read both before deciding which to keep.`, { argv: getArgv(sourceId, other.slug) }),
      verify: { argv: [...slugSpellingPreviewArgv(sourceId), '--json'] } };
  }
  const normalPath = entry.evidence.to_path ?? `${entry.normal}${extname(entry.source_path ?? '') || '.md'}`;
  const from = entry.evidence.from_path ?? (entry.source_path?.trim() || `${entry.slug}.md`);
  return { argv: ['git', '-C', root ?? '<checkout>', 'mv', from, normalPath], consent: [], actor: 'user',
    why: `The page's file is not at ${normalPath}; moving only the database row would split the page from its file.`,
    user_message: `Rename the file with git mv ${from} ${normalPath}, commit, and sync; sync carries the page identity to the new path. Then preview again.`,
    verify: { argv: [...slugSpellingPreviewArgv(sourceId), '--json'] }, requires_exclusive: false };
};

const entryMessage = (sourceId: string, entry: SpellingEntry): string => {
  if (entry.code === 'slug_spelling_collision') {
    const names = entry.holders!.map(h => `${h.slug} (id ${h.page_id})`).join(', ');
    return `Page ${entry.slug} (id ${entry.page_id}) prints the same name as ${names}; moving one would merge two pages, so nothing moves. `
      + `Compare them (${shellQuote(getArgv(sourceId, entry.slug))} and ${entry.holders!.map(h => shellQuote(getArgv(sourceId, h.slug))).join(', ')}), keep the content you want in one, `
      + `soft-delete the other with gbrain delete ${shellQuote([entry.slug])} --source-id ${sourceId}, then preview again.`;
  }
  if (entry.code === 'rename_file_first') {
    return `Page ${entry.slug} (id ${entry.page_id}) is not moved because ${entry.reason}. git mv the file to ${entry.evidence.to_path ?? `${entry.normal}${extname(entry.source_path ?? '') || '.md'}`}, commit and sync (sync carries the page identity), then preview again.`;
  }
  return `page ${entry.page_id} moves from ${entry.slug} to ${entry.normal}; its id, history, facts and attachments stay, and ${entry.slug} keeps resolving through an alias`;
};

function item(sourceId: string, page: SpellingPage, incarnation: string, moved?: boolean): PageItem {
  return { cursor: { phase: 1, id: page.page_id }, source_id: sourceId, slug: page.slug, chars: 0, action: 'move:slug_spelling', change: { from: page.slug, to: page.normal }, page, incarnation, ...(moved ? { moved } : {}) };
}

const hashParts = (scope: RepairScope, scan: SpellingScan) => ({ kind: 'slug-spelling-v1', brain_id: scope.brain_id, source_id: scan.source_id, incarnation: scan.incarnation,
  truncated: scan.truncated, entries: scan.entries });

async function localRoot(engine: Pick<BrainEngine, 'readSourceLocalPath'>, sourceId: string): Promise<string | null> {
  return engine.readSourceLocalPath(sourceId);
}

export const slugSpellingRepair: RepairHandler = {
  kind: 'slug-spelling',
  embeds: false,
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    if (opts?.remote === true) throw trustedCliRequired('gbrain repair slug-spelling runs only from the trusted local CLI on the brain host.');
    if (scope.source_ids.length !== 1) {
      throw new OperationError('invalid_params', 'gbrain repair slug-spelling needs --source <id>.',
        'Pages are moved one source at a time; name it, e.g. gbrain repair slug-spelling --source default.', DOCS);
    }
    const sourceId = scope.source_ids[0]!;
    const command = previewCommand(sourceId);
    const managed = await managedPersistenceEnabled(engine);
    if (managed && opts?.apply) throw managedRemedyRefusal(sourceId);
    await assertUtf8(engine, sourceId);
    await assertGuardTablesReadable(engine, sourceId);
    const scan = await scanSlugSpellings(engine, sourceId);
    const root = await localRoot(engine, sourceId);
    const listing = (entry: SpellingEntry): RepairListing => ({ item: `${sourceId}:${entry.slug}`, class: managed ? MANAGED_REMEDY_UNAVAILABLE : entry.class, detail: entryMessage(sourceId, entry) });
    const detailItems = scan.entries.map(entry => ({ ...entry, ...(entry.class === 'move' ? {} : { message: entryMessage(sourceId, entry), fix: entryAction(sourceId, entry, root) }) }));
    if (managed) {
      const error = managedRemedyRefusal(sourceId);
      return { items: [], residuals: { unavailable: scan.entries.length }, listing: scan.entries.map(listing),
        details: { code: MANAGED_REMEDY_UNAVAILABLE, needs_human: true, message: error.message, suggestion: error.suggestion, items: [], docs: DOCS } };
    }
    const movable = scan.entries.filter(entry => entry.class === 'move');
    const hash = previewHash(hashParts(scope, scan));
    const warnings = [
      ...(scan.truncated ? [`More pages may be stored under an older spelling past the first ${SLUG_SPELLING_LIMIT} listed; apply this set, then preview again.`] : []),
      ...(scan.entries.length - movable.length ? [`${scan.entries.length - movable.length} page(s) are never moved by the apply: each lists why and the fix a person makes.`] : []),
      ...(movable.length ? [SLUG_SPELLING_CONSENT_TEXT.risk] : []),
    ];
    if (!opts?.apply) {
      if (movable.length) await saveApprovedSet<SpellingPage & { incarnation: string }>(engine, { command: 'slug-spelling', hash }, movable.map(entry => ({ ...stripEntry(entry), incarnation: scan.incarnation })));
      return { warnings, items: movable.map(entry => item(sourceId, stripEntry(entry), scan.incarnation)), preview_hash: hash,
        residuals: { move: movable.length, needs_human: scan.entries.filter(e => e.class === 'needs_human').length, rename_file_first: scan.entries.filter(e => e.class === 'rename_file_first').length, inspected: scan.inspected },
        listing: scan.entries.map(listing), details: { items: detailItems, truncated: scan.truncated, docs: DOCS } };
    }
    if (!opts.expect) {
      throw refuse('invalid_params', 'gbrain repair slug-spelling --apply moves only the pages a preview printed.',
        `Preview first: ${command} — then, after the owner agrees, run the apply command it prints: ${command} --apply --expect <preview-hash> --yes`, previewAction(sourceId));
    }
    const approved = await loadApprovedSet<SpellingPage & { incarnation: string }>(engine, { command: 'slug-spelling', hash: opts.expect, previewCommand: command,
      emptyHash: async () => previewHash(hashParts(scope, { ...scan, entries: scan.entries.filter(entry => entry.class !== 'move') })) });
    const now = new Map(scan.entries.map(entry => [entry.page_id, entry]));
    const items: PageItem[] = [];
    for (const { incarnation, ...page } of approved.items) {
      if (incarnation !== scan.incarnation) throw changedSincePreview(sourceId, page.slug, 'the source was replaced (its incarnation changed)');
      const current = now.get(page.page_id);
      if (!current) {
        const slug = await engine.readPageSlugInSource(page.page_id, sourceId);
        if (slug === page.normal) { items.push(item(sourceId, page, incarnation, true)); continue; }
        throw changedSincePreview(sourceId, page.slug, slug !== null ? `the page is now ${slug}` : 'the page is gone');
      }
      const why = changedFact(page, current);
      if (why) throw changedSincePreview(sourceId, page.slug, why);
      items.push(item(sourceId, page, incarnation));
    }
    return { items: items.filter(entry => afterCursor(entry.cursor, after)), preview_hash: opts.expect, residuals: {} };
  },
  async apply(ctx, entry): Promise<RepairItemOutcome> {
    const { page, source_id: sourceId, incarnation, moved } = entry as PageItem;
    if (moved) return { applied: false, outcome: 'already_moved', detail: { page_id: page.page_id, from: page.slug, to: page.normal } };
    return movePage(ctx.engine, sourceId, page, incarnation);
  },
  render(details) {
    if (details.code === MANAGED_REMEDY_UNAVAILABLE) return [`  ${details.code}: ${details.message}`, `  ${details.suggestion}`];
    const items = (details.items as Array<SpellingEntry & { message?: string }> | undefined) ?? [];
    return [...items.filter(entry => entry.class !== 'move').map(entry => `  ${entry.class} ${entry.slug}: ${entry.message}`), `  guide: ${details.docs}`];
  },
};

const stripEntry = (entry: SpellingEntry): SpellingPage => ({ page_id: entry.page_id, slug: entry.slug, normal: entry.normal, revision: entry.revision, deleted: entry.deleted, source_path: entry.source_path, evidence: entry.evidence });

/** Why the page now is not the page the preview bound, or null. */
/** Whether two file evidences say the same, whatever their key order (the approved preview comes back from storage re-keyed). */
function sameEvidence(a: FileEvidence, b: FileEvidence): boolean {
  const canonical = (e: FileEvidence) => JSON.stringify(Object.fromEntries(Object.entries(e).sort(([x], [y]) => x.localeCompare(y))));
  return canonical(a) === canonical(b);
}

function changedFact(page: SpellingPage, current: SpellingEntry): string | null {
  if (current.slug !== page.slug) return `the page is now ${current.slug}`;
  if (current.revision !== page.revision) return 'the page has a new revision';
  if (current.deleted !== page.deleted) return 'the page was deleted or restored';
  if (current.source_path !== page.source_path) return 'the page\'s recorded origin changed';
  if (!sameEvidence(current.evidence, page.evidence)) return 'the file evidence in the checkout changed';
  if (current.class === 'needs_human') return 'another page now prints the same name (slug_spelling_collision)';
  if (current.class === 'rename_file_first') return `${current.reason} (rename_file_first)`;
  return null;
}

/** One page's move in its own maintenance transaction: re-checked under both page locks, rolled back whole on any failure. */
function movePage(engine: BrainEngine, sourceId: string, page: SpellingPage, incarnation: string): Promise<RepairItemOutcome> {
  // The stored spelling is kept as it is (validateSlug would normalize it): writers of an existing page lock that spelling, so
  // the repair must lock the same key, read the page and capture its versions under it, and run the rename addressing it.
  return withStoredSlug(page.slug, () => movePageUnderStoredSlug(engine, sourceId, page, incarnation));
}

async function movePageUnderStoredSlug(engine: BrainEngine, sourceId: string, page: SpellingPage, incarnation: string): Promise<RepairItemOutcome> {
  if (await managedPersistenceEnabled(engine)) throw managedRemedyRefusal(sourceId);
  const publicationId = randomUUID();
  const report = { appended: 0 };
  const outcome = await maintenanceTransaction(engine, async tx => {
    await tx.lockPageKeys([{ sourceId, slug: page.slug }, { sourceId, slug: page.normal }]);
    // Row security is checked before anything is read: a table it applies to can come back short.
    await assertGuardTablesReadable(tx, sourceId);
    const source = await tx.readSlugRepairSource(sourceId);
    if (source?.incarnation !== incarnation) throw changedSincePreview(sourceId, page.slug, 'the source was replaced (its incarnation changed)');
    const row: PageRow | null = await tx.readSlugRepairPage(page.page_id, sourceId);
    if (!row || row.slug !== page.slug) throw changedSincePreview(sourceId, page.slug, row ? `the page is now ${row.slug}` : 'the page is gone');
    if (String(row.revision) !== page.revision) throw changedSincePreview(sourceId, page.slug, 'the page has a new revision');
    if ((row.deleted === true) !== page.deleted) throw changedSincePreview(sourceId, page.slug, 'the page was deleted or restored');
    if (row.source_path !== page.source_path) throw changedSincePreview(sourceId, page.slug, 'the page\'s recorded origin changed');
    if (!sameEvidence(fileEvidence(source.local_path, { slug: page.slug, normal: page.normal, source_path: row.source_path }, source.slug_root_mode), page.evidence)) {
      throw changedSincePreview(sourceId, page.slug, 'the file evidence in the checkout changed');
    }
    const [taken] = await samePrintedName(tx, sourceId, page.normal, page.page_id);
    if (taken) throw changedSincePreview(sourceId, page.slug, `another page now prints the same name, ${taken.slug} (id ${taken.page_id}) (slug_spelling_collision)`);
    let attachments = 0, guards: Awaited<ReturnType<typeof carryGuards>> = { fact_purges: 0, take_purges: 0 };
    await lockedBeliefBatch(tx, { sourceId, slugs: [page.slug, page.normal], publicationId, op: 'slug_spelling', remote: false, report }, async () => {
      // The page's attachments (bound to it, or naming the old spelling with no page id), counted first for the report.
      const [own] = await tx.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM files WHERE source_id = $1 AND page_slug = $2 AND (page_id = $3 OR page_id IS NULL)', [sourceId, page.slug, page.page_id]);
      // updateSlug moves the bound ones (moveSlugBindings); the rows with no page id stay there, but the older spelling
      // names exactly this one page under the page locks, so this repair moves those itself.
      if (await tx.updateSlug(page.slug, page.normal, { sourceId }) !== 1) throw changedSincePreview(sourceId, page.slug, `page ${page.slug} could not move to ${page.normal}`);
      // Attachments carry the page's slug beside its id: updateSlug moved the bound rows; this moves the rows with no page id that name the old slug. The report counts both, as counted before the move (`own`).
      await rekeyAttachments(tx, sourceId, page.slug, page.normal, page.page_id);
      attachments = Number(own?.n ?? 0);
      guards = await carryGuards(tx, sourceId, page.slug, page.normal);
    });
    return { applied: true, outcome: 'moved', detail: { page_id: page.page_id, from: page.slug, to: page.normal, attachments_moved: attachments, kept_source_path: page.source_path, guards_carried: guards } } satisfies RepairItemOutcome;
  });
  if (report.appended) await markBeliefCommits(engine, [publicationId]).catch(() => undefined);
  return outcome;
}
