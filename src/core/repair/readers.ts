/**
 * GST-2476 (D1): `gbrain repair visibility --readers <list>` sets the readers of named pages (`--slug`, repeatable, or
 * `--slugs-file`, one slug per line) through the label-only door (repair/label-write.ts): the page keeps its trust tier,
 * files no lower_page proposal and keeps its provenance stamps (source_kind, ingested_via, ingested_at), its file changes
 * only on the `readable_by` line (persistence/label-edit.ts), and the pages_access_derive_readers trigger (v282) sets
 * pages.page_readers from the written frontmatter in the same write, so reads see the readers at once. A put_page that
 * adds readers is an agent content write: it lowers the page and, on a managed brain, stamps put_page provenance.
 *
 * Every reader must name an enabled member (`alice-example`, `member:alice-example`) or an existing group
 * (`group:team-a`); `none` removes the line. When `gbrain access owner` names an owner, a list that does not
 * name the owner directly refuses unless `--allow-without-owner`: readers that leave the owner out close the page to the
 * owner's own keys on every read path (access/caller.ts), and a group holding the owner does not count.
 *
 * Preview-bound: the preview lists each page's readers change and prints a hash over the selection (pages, readers as
 * written, the flag, the owner) and the items; `--apply --expect <hash>` re-checks the readers and applies exactly that
 * set. Other readers or flags, a different owner, or a page whose readers moved since the preview refuse preview_changed
 * before anything is written. Works with no repository: a repo-less brain and a managed page under storage.db_only write
 * the database label only.
 */
import type { BrainEngine } from '../engine.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { opError } from '../ops/contract.ts';
import { getMember, listGroups } from '../access/members.ts';
import { ownerView } from '../access/owner.ts';
import { normalizePrincipal, normalizeReaders } from '../access/principals.ts';
import { READERS_KEY, type LabelEdit } from '../persistence/label-edit.ts';
import { digest } from '../persistence/digest.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { isSegmentedPage } from '../page-body/page-shape.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import { raisePageLabelGuard } from '../trust/page-write.ts';
import { openTwins, openTwinsWarning } from '../access/open-twins.ts';
import { afterCursor, type RepairCursor, type RepairItem, type RepairItemOutcome, type RepairPlan, type RepairPlanOptions, type RepairScope } from './core.ts';

/** The operator's request: `--readers` as typed (`none` removes), the owner flag, and the `--slugs-file` path with its slugs. */
export interface ReadersRequest { readers: string; allowWithoutOwner?: boolean; slugsFile?: { path: string; slugs: string[] } }
/** The phase a readers item's target carries (visibility.ts routes its apply here). */
export const READERS_PHASE = 6;
/** The most pages one readers preview lists. */
export const READERS_MAX_PAGES = 10_000;

interface ReadersChange { from: string[] | null; to: string[] | null }
export interface ReadersItem extends RepairItem { target: RepairCursor; readers: ReadersChange; hash?: string; last?: boolean }
interface Selection { source_ids: string[]; slugs: string[]; readers: string[] | null; allow_without_owner: boolean; owner: string | null }
interface ApprovedReaders { target: RepairCursor; source_id: string; slug: string; chars: number; action: string; readers: ReadersChange; selection_digest: string }

const invalid = (message: string, suggestion: string, reason?: string) => opError('invalid_params', message, suggestion, reason ? { reason } : {});
const unknownReader = (message: string, suggestion: string, reason: string) => opError('access_member_invalid', message, suggestion,
  { reason, why: 'A reader that names no enabled member or existing group would close the page to everyone it meant to admit.' });
const shown = (principal: string) => principal.startsWith('member:') ? principal.slice('member:'.length) : principal;
const listText = (readers: string[] | null) => readers ? '[' + readers.map(shown).join(', ') + ']' : '(none)';
const normalized = (readers: string[] | null) => readers ? normalizeReaders({ [READERS_KEY]: readers }) : null;
const same = (a: string[] | null, b: string[] | null) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The readers to write, as the frontmatter will hold them (members bare, groups as group:<id>, in the order typed, each
 * once), or null for `none`. Refuses an entry that is no principal, an unknown, disabled or removed member, an unknown
 * group, and a list without the owner unless the flag is passed; nothing is written before this passes.
 */
async function checkedReaders(engine: BrainEngine, request: ReadersRequest): Promise<{ readers: string[] | null; owner: string | null }> {
  const view = await ownerView(engine);
  const inactive = view.inactive ? normalizePrincipal(view.inactive.value) : null;
  const owner = view.owner ?? (inactive?.startsWith('member:') ? shown(inactive) : null);
  if (request.readers.trim() === 'none') return { readers: null, owner };
  const entries = request.readers.split(',').map(entry => entry.trim()).filter(Boolean);
  if (!entries.length) throw invalid('--readers names no reader.', 'Pass member ids and group:<id>, comma-separated (e.g. --readers alice-example,group:team-a), or none to remove the readers.');
  const principals: string[] = [];
  for (const entry of entries) {
    const principal = normalizePrincipal(entry);
    if (!principal) throw invalid('"' + entry + '" is not a member id or group:<id>.', 'Use member ids (alice-example) and groups (group:team-a): 1-64 lower-case letters, digits, ".", "_" or "-".');
    if (!principals.includes(principal)) principals.push(principal);
  }
  for (const principal of principals) {
    const id = shown(principal);
    if (principal.startsWith('group:')) {
      if (!(await listGroups(engine, id.slice('group:'.length))).length) throw unknownReader('No group "' + id.slice('group:'.length) + '" exists on this brain.', 'List groups with gbrain access group list, or create it: gbrain access group add ' + id.slice('group:'.length) + ' --members <ids>.', 'unknown_group');
      continue;
    }
    const member = await getMember(engine, id);
    if (member?.status !== 'enabled') {
      throw unknownReader(member ? 'Member "' + id + '" is ' + member.status + '.' : 'No member "' + id + '" exists on this brain.',
        member?.status === 'disabled' ? 'Enable it (gbrain access member enable ' + id + ') or name another member.' : 'Check the id with gbrain access member list, or add it: gbrain access member add ' + id + '.',
        member ? member.status : 'unknown');
    }
  }
  if (owner && !principals.includes('member:' + owner) && !request.allowWithoutOwner) {
    throw invalid('These readers leave out the brain owner "' + owner + '"' + (view.owner ? '' : ' (configured, not enabled now)') + ', so the owner\'s own keys could no longer read the page; nothing was written. Name the owner, or pass --allow-without-owner.',
      'Add the owner to the list (--readers ' + [...principals.map(shown), owner].join(',') + '), or pass --allow-without-owner if the owner should not read it. A group that holds the owner does not count.',
      'readers_omit_owner');
  }
  return { readers: principals.map(shown), owner };
}

/** The read-only command that previews this selection again, with the caller's flags. */
function previewCommand(scope: RepairScope, request: ReadersRequest, slugs: string[], sourceFlag: boolean): string {
  const pages = request.slugsFile ? ' --slugs-file ' + request.slugsFile.path : slugs.map(slug => ' --slug ' + slug).join('');
  return 'gbrain repair visibility' + (sourceFlag && scope.source_ids.length === 1 ? ' --source ' + scope.source_ids[0] : '') + pages
    + ' --readers ' + request.readers + (request.allowWithoutOwner ? ' --allow-without-owner' : '');
}

/**
 * The named pages whose readers differ from the selection's, in page-id order, with the pages not found and already set.
 * GST-2521: a page that already names the selection's readers but has no label guard (an upgrade, a rebuild from a clone)
 * is listed too, to raise the guard without a write.
 */
async function planPages(engine: BrainEngine, selection: Selection) {
  const rows = await engine.executeRaw<{ id: number; source_id: string; slug: string; named: boolean; readers: unknown; chars: number; guarded: boolean }>(
    `SELECT p.id, p.source_id, p.slug, p.frontmatter ? 'readable_by' AS named, p.frontmatter->'readable_by' AS readers, COALESCE(p.body_bytes, 0) AS chars,
      EXISTS (SELECT 1 FROM page_label_guards g WHERE g.page_id = p.id) AS guarded
    FROM pages p WHERE p.deleted_at IS NULL AND p.source_id = ANY($1::text[]) AND p.slug = ANY($2::text[]) ORDER BY p.id`, [selection.source_ids, selection.slugs], { timeoutMs: 120_000 });
  const target = normalized(selection.readers);
  const items: ReadersItem[] = rows.flatMap(row => {
    const from = normalizeReaders(row.named ? { [READERS_KEY]: row.readers } : {});
    const guardOnly = same(from, target);
    if (guardOnly && (target === null || row.guarded)) return [];
    const id = Number(row.id);
    return [{ cursor: { phase: READERS_PHASE, id }, target: { phase: READERS_PHASE, id }, source_id: row.source_id, slug: row.slug, chars: Number(row.chars),
      action: guardOnly ? 'readers ' + listText(from) + ' kept, label guard raised' : 'readers ' + listText(from) + ' -> ' + listText(selection.readers), readers: { from, to: selection.readers } }];
  });
  const found = new Set(rows.map(row => row.slug));
  return { items, residuals: { named_not_found: selection.slugs.filter(slug => !found.has(slug)).length, readers_already_set: rows.length - items.length } };
}

/** The maintenance batch id an approved readers apply carries on its managed writes (one per approved set and source). */
export const readersBatch = (hash: string, sourceId: string) => digest(['visibility-readers-batch-v1', hash, sourceId]);

/**
 * How the managed writes of the approved set `hash` reached Git: their Git effects by state. The Git effect runner commits
 * queued files of one checkout together (up to 100 files per commit); a pending file is committed when it runs. A
 * db_only page's effect is skipped (no file). Brains without managed persistence publish no Git effect.
 */
export async function readersGitCounts(engine: BrainEngine, scope: RepairScope, hash: string): Promise<Record<string, number>> {
  const [row] = await engine.executeRaw<Record<string, number | string>>(`SELECT count(*) FILTER (WHERE e.state = 'committed' AND e.outcome->>'git' = 'committed') AS committed,
      count(*) FILTER (WHERE e.state IN ('queued', 'running')) AS pending, count(*) FILTER (WHERE e.state = 'failed') AS failed,
      count(*) FILTER (WHERE e.state = 'committed' AND e.outcome->>'git' = 'skipped') AS skipped
    FROM persistence_requests r JOIN persistence_effects e ON e.request_id = r.id AND e.kind = 'git'
    WHERE r.intent->>'maintenance_batch' = ANY($1::text[])`, [scope.source_ids.map(sourceId => readersBatch(hash, sourceId))], { timeoutMs: 120_000 });
  return Object.fromEntries(Object.entries(row ?? {}).map(([key, value]) => [key, Number(value)]));
}

const hashParts = (scope: RepairScope, selection: Selection, items: ReadersItem[]) => ({ kind: 'visibility-readers-v1', brain_id: scope.brain_id, selection,
  items: items.map(item => ({ target: item.target, source_id: item.source_id, slug: item.slug, readers: item.readers })) });

/**
 * The apply's items: exactly the approved set, after the selection matched and every pending page still holds the readers
 * the preview read (or, on a resumed run, already the new ones); anything else refuses preview_changed with nothing written.
 */
async function approvedItems(engine: BrainEngine, scope: RepairScope, selection: Selection, expect: string, command: string, after: RepairCursor | null): Promise<ReadersItem[]> {
  const approved = await loadApprovedSet<ApprovedReaders>(engine, { command: 'visibility', hash: expect, previewCommand: command,
    emptyHash: async () => previewHash(hashParts(scope, selection, (await planPages(engine, selection)).items)) });
  const selectionDigest = digest(selection);
  if (approved.items.some(entry => entry.selection_digest !== selectionDigest)) throw previewChangedError(expect, command);
  const items: ReadersItem[] = approved.items.map(({ selection_digest: _selection, ...entry }, index) => ({ ...entry, cursor: { phase: 0, id: index }, hash: expect, last: index === approved.items.length - 1 }))
    .filter(item => afterCursor(item.cursor, after));
  const live = new Map((await planPages(engine, selection)).items.map(item => [item.target.id, item.readers.from]));
  const target = normalized(selection.readers);
  for (const item of items) {
    const settled = !live.has(item.target.id);
    if (settled ? !(await pageHolds(engine, item, target)) : !same(live.get(item.target.id)!, item.readers.from)) throw previewChangedError(expect, command);
  }
  return items;
}

/** Whether the page the item names is still live and already holds the target readers (an item a stopped apply wrote). */
async function pageHolds(engine: BrainEngine, item: ReadersItem, target: string[] | null): Promise<boolean> {
  const snapshot = await engine.readPageSnapshot(item.slug, { sourceId: item.source_id });
  return !!snapshot && Number(snapshot.page.id) === item.target.id && same(normalizeReaders(snapshot.page.frontmatter), target);
}

/** The readers plan: the preview (saved under its hash) or the apply's approved items. */
export async function planReaders(engine: BrainEngine, scope: RepairScope, after: RepairCursor | null, opts: RepairPlanOptions & { readers: ReadersRequest }): Promise<RepairPlan> {
  const request = opts.readers;
  const slugs = [...new Set(request.slugsFile?.slugs ?? opts.slugs ?? [])].sort();
  if (!slugs.length) throw invalid('gbrain repair visibility --readers names its pages with --slug or --slugs-file.', 'Name each page: --slug notes/a-example (repeatable), or --slugs-file <file> with one slug per line.');
  if (opts.driftClass !== undefined) throw invalid('gbrain repair visibility takes --readers or --class, not both.', 'Set readers on named pages with --readers, or preview a visibility class with --class.');
  if (slugs.length > READERS_MAX_PAGES) throw invalid('--readers lists ' + slugs.length + ' pages; one preview lists at most ' + READERS_MAX_PAGES + '.', 'Split the slugs file and preview each part.');
  const command = previewCommand(scope, request, slugs, true);
  if (opts.apply && !opts.expect) throw invalid('gbrain repair visibility --readers applies only the set a preview printed.', 'Preview first: ' + command + ' — then run the apply command it prints: ' + command + ' --apply --expect <preview-hash>');
  const { readers, owner } = await checkedReaders(engine, request);
  const selection: Selection = { source_ids: scope.source_ids, slugs, readers, allow_without_owner: request.allowWithoutOwner === true, owner };
  if (opts.apply) return { items: await approvedItems(engine, scope, selection, opts.expect!, command, after), preview_hash: opts.expect, residuals: {} };
  const { items, residuals } = await planPages(engine, selection);
  const hash = previewHash(hashParts(scope, selection, items));
  const twins = await openTwins(engine, readers?.length ? items : [], readers ?? [],
    (source, named) => `gbrain repair visibility --source ${source}${named.map(slug => ` --slug ${slug}`).join('')} --readers ${request.readers}`);
  const selectionDigest = digest(selection);
  if (items.length) await saveApprovedSet<ApprovedReaders>(engine, { command: 'visibility', hash },
    items.map(item => ({ target: item.target, source_id: item.source_id, slug: item.slug, chars: item.chars, action: item.action, readers: item.readers, selection_digest: selectionDigest })));
  const warnings = [...(residuals.named_not_found ? [residuals.named_not_found + ' named page(s) were not found in ' + scope.source_ids.join(', ') + ' and are not listed.'] : []), ...openTwinsWarning(twins)];
  return { items: items.map((item, index) => ({ ...item, cursor: { phase: 0, id: index } })), preview_hash: hash, residuals: { ...residuals, ...(twins.count ? { open_twins: twins.count } : {}) },
    ...(warnings.length ? { warnings } : {}), ...(twins.count ? { details: { open_twins: twins } } : {}),
    listing: items.map(item => ({ item: item.source_id + ':' + item.slug, class: 'readers', detail: item.action })) };
}

/** A readers item ready to write: the page as read and its rendering with only `readable_by` changed. */
export interface ReadersWrite { snapshot: PageSnapshot; content: string; edit: LabelEdit }

/**
 * One page's readers write, re-checked against the page: false when its readers moved since the plan (skipped), the held
 * outcome of a page stored in segments, else the page and its rendering with only `readable_by` changed.
 */
export async function readersWrite(engine: BrainEngine, item: ReadersItem): Promise<false | RepairItemOutcome | ReadersWrite> {
  const snapshot = await engine.readPageSnapshot(item.slug, { sourceId: item.source_id });
  if (!snapshot || Number(snapshot.page.id) !== item.target.id || !same(normalizeReaders(snapshot.page.frontmatter), item.readers.from)) return false;
  if (isSegmentedPage(snapshot.page)) return { applied: false, outcome: 'segmented_page', reason: 'The page body is stored in segments; edit its readable_by line by hand on the brain host.' };
  const { [READERS_KEY]: _readers, ...rest } = snapshot.page.frontmatter;
  const to = item.readers.to;
  const frontmatter = to ? { ...snapshot.page.frontmatter, [READERS_KEY]: to } : rest;
  const edit: LabelEdit = to ? { set: { [READERS_KEY]: to }, remove: [] } : { set: {}, remove: [READERS_KEY] };
  return { snapshot, content: serializePageToMarkdown({ ...snapshot.page, frontmatter }, snapshot.tags), edit };
}

/**
 * GST-2521: an item whose labels already match (`unchanged` re-checks the page's frontmatter under its page lock) raises the
 * page's label guard without a write; false when the page moved since the plan. A write prepared before the raise re-reads
 * the guard under the same lock at publication and refuses `revision_conflict` (page-prepare.ts).
 */
export async function raiseGuardOnly(engine: BrainEngine, item: { source_id: string; slug: string; target: RepairCursor },
  unchanged: (frontmatter: Record<string, unknown>) => boolean): Promise<false | RepairItemOutcome> {
  return maintenanceTransaction(engine, async tx => {
    await tx.lockPageKeys([{ sourceId: item.source_id, slug: item.slug }]);
    const [page] = await tx.executeRaw<{ id: number; frontmatter: Record<string, unknown> | null }>(
      'SELECT id, frontmatter FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL FOR UPDATE', [item.source_id, item.slug]);
    if (!page || Number(page.id) !== item.target.id || !unchanged(page.frontmatter ?? {})) return false;
    await raisePageLabelGuard(tx, item.source_id, item.slug);
    return { applied: true, outcome: 'label_guard_raised' };
  });
}

/** A readers item that only raises the label guard: its page already names the requested readers. */
export const readersGuardOnly = (item: ReadersItem) => same(item.readers.from, normalized(item.readers.to));

/** A guard-only readers item applied: the guard raised while the page still names those readers. */
export const raiseReadersGuard = (engine: BrainEngine, item: ReadersItem) =>
  raiseGuardOnly(engine, item, frontmatter => same(normalizeReaders(frontmatter), item.readers.from));

/** The outcome of a written readers item. */
export const readersOutcome = (item: ReadersItem): RepairItemOutcome => ({ applied: true, outcome: item.readers.to ? 'readers_set' : 'readers_removed' });

/** Retires the approved set once its last item has been tried. */
export async function retireReaders(engine: BrainEngine, items: ReadersItem[]): Promise<void> {
  const last = items.find(item => item.last && item.hash);
  if (last) await clearApprovedSet(engine, { command: 'visibility', hash: last.hash! });
}

/**
 * One page's readers write on its own (visibility.ts applyBatch admits a managed run's pages together): readersWrite, then
 * the label-only write (`write`, visibility.ts labelWrite). Its held outcome when the write could not be made;
 * `readers_set` or `readers_removed` once written.
 */
export async function applyReaders(engine: BrainEngine, item: ReadersItem,
  write: (snapshot: PageSnapshot, content: string, edit: LabelEdit, batch?: string) => Promise<RepairItemOutcome | null>): Promise<boolean | RepairItemOutcome> {
  try {
    if (readersGuardOnly(item)) return await raiseReadersGuard(engine, item);
    const ready = await readersWrite(engine, item);
    if (ready === false || !('snapshot' in ready)) return ready;
    return await write(ready.snapshot, ready.content, ready.edit, item.hash ? readersBatch(item.hash, item.source_id) : undefined) ?? readersOutcome(item);
  } finally {
    await retireReaders(engine, [item]);
  }
}
