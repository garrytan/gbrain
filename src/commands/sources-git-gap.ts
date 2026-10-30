/**
 * `gbrain sources git-gap <source-id>` (git-canonical memory, wave G1, docs/designs/GIT_CANONICAL_MEMORY.md): a read-only
 * census of how far one source's database is from the commit its checkout has at HEAD. Every live page lands in exactly
 * one state: equal to its committed blob, database_ahead or git_ahead of it, declared database-only (with its class),
 * undeclared database-only (no blob at HEAD and no declared reason), worktree_only (a file that is not committed),
 * unparseable or unsafe_path. The working tree is reported separately. It also counts the rows that have no Git home
 * (unfenced facts, fenced facts on pages with no file, links no file derives, timeline rows on pages with no file), the
 * source's open sync holds by code and its parked effect targets by code.
 *
 * Nothing is written. Each 256-page batch reads in its own read-only transaction; Git runs only as hardened plumbing
 * (persistence/git-gap.ts), so no repository filter or textconv ever runs. Trusted local CLI only, not an MCP operation:
 * it prints slugs and paths. Doctor `db_ahead_of_git` runs the same census within its budget.
 */
import { existsSync, realpathSync } from 'node:fs';
import { relative, sep } from 'node:path';
import type { BrainEngine } from '../core/engine.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { OperationError } from '../core/ops/contract.ts';
import { cliRenderContext, toAgentError } from '../core/agent-output.ts';
import { readExportPages, readExportWithdrawals, type ExportSnapshot, type ExportWithdrawal } from '../core/export-snapshot.ts';
import { RestoreTargetError, restoreFilePath } from '../core/restore-target.ts';
import { privatePagesFilterFragment, readHonorAliases } from '../core/search/private-visibility.ts';
import { resolveSourceId } from '../core/source-resolver.ts';
import { sourceMirrorReadOnly } from '../core/persistence/mirror-read-only.ts';
import { isSourceDbOnlySlug } from '../core/persistence/source-storage.ts';
import { GIT_HOLD_OP, readSyncImportProvenances } from '../core/persistence/sync-holds.ts';
import { DERIVED_LINK_SOURCES } from '../core/persistence/twin-merge.ts';
import { scannerSlugRootMode, scannerSourcePath } from '../core/write-through.ts';
import { compareInlineExportFile, compareSegmentedExportBlob, DECLARED_CLASSES, declaredDatabaseOnly, ignoredPaths, readBlobs, readHeadTree, worktreeBlobOid,
  type DeclaredClass, type ExportFileComparison, type HeadTree, type TreeBlob, type UnparseableReason } from '../core/persistence/git-gap.ts';

const USAGE = 'Usage: gbrain sources git-gap <source-id> [--sample <n>] [--json]';
export const GIT_GAP_DOCS = 'docs/designs/GIT_CANONICAL_MEMORY.md#the-git-gap-census';
const BATCH = 256;

export const PAGE_STATES = ['equal', 'database_ahead', 'git_ahead', 'declared_database_only', 'undeclared_database_only', 'worktree_only', 'unparseable', 'unsafe_path'] as const;
export type PageState = typeof PAGE_STATES[number];
export const WORKTREE_STATES = ['clean', 'modified', 'deleted', 'untracked', 'absent'] as const;
export type WorktreeState = typeof WORKTREE_STATES[number];

/** One page as the census classified it, handed to a caller that plans per page (G8 conversion, persistence/git-conversion.ts). */
export interface GitGapPage { id: string; slug: string; revision: string | null; path: string | null; state: PageState; segmented: boolean;
  declared?: DeclaredClass; worktree?: WorktreeState; headBlob?: string; databaseAlsoMoved?: boolean; unparseable?: UnparseableReason;
  /** A declared page: whether its row records a file (`source_path`), and the size of its committed blob. */
  recordsFile?: boolean; headSize?: number }

export interface GitGapSample { slug: string; path: string; state: PageState; fields?: string[]; declared?: DeclaredClass; basis?: 'import_record' | 'no_import_record'; worktree?: WorktreeState }

export interface GitGapCensus {
  status: 'census';
  source_id: string;
  checkout: string | null;
  /** The commit compared against; null when the source has no checkout or its branch has no commit. */
  head: string | null;
  /** False when a doctor budget stopped the page scan; the counts cover the pages read so far. */
  complete: boolean;
  pages: number;
  states: Record<PageState, number>;
  declared: Record<DeclaredClass, number>;
  /** Declared pages whose file is still committed at HEAD (for example a page that turned private). */
  declared_with_head_blob: number;
  /** database_ahead pages with no import record, so the side that moved is unknown (see the design doc). */
  database_ahead_without_import_record: number;
  /** git_ahead pages whose row also moved since its last import: both sides changed. */
  git_ahead_database_also_moved: number;
  /** Pages of a source without a checkout that are not declared. Since G7a such a source is declared `database_only_source`, so this stays 0; kept for readers of the JSON. */
  not_compared: number;
  /** Working-tree files of the pages that may have a tracked file, by their raw bytes against HEAD; null without a checkout. */
  worktree: Record<WorktreeState, number> | null;
  rows_without_git_home: {
    facts_unfenced: number;
    facts_fence_page_missing: number;
    facts_on_pages_without_file: { undeclared: number; declared: number };
    links: { total: number; by_link_source: Record<string, number> };
    timeline_on_pages_without_file: { undeclared: number; declared: number };
  };
  holds: Record<string, number>;
  parked_effects: Array<{ kind: string; code: string; targets: number }>;
  sample: GitGapSample[];
  next: string;
}

export function parseGitGapArgs(args: string[]): { sourceId: string; json: boolean; sample: number } {
  const positional: string[] = [];
  let sample = 20;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--sample') {
      const raw = args[++i];
      sample = Number(raw);
      if (raw === undefined || !Number.isInteger(sample) || sample < 0 || sample > 1000) {
        throw new OperationError('invalid_params', `--sample needs a whole number from 0 to 1000; got ${raw ?? 'nothing'}.`, USAGE);
      }
      continue;
    }
    if (arg.startsWith('-')) {
      if (arg !== '--json') throw new OperationError('invalid_params', `Unknown sources git-gap flag: ${arg}.`, USAGE);
      continue;
    }
    positional.push(arg);
  }
  if (positional.length !== 1) throw new OperationError('invalid_params', 'sources git-gap needs exactly one source id.', USAGE);
  return { sourceId: positional[0]!, json: args.includes('--json'), sample };
}

type Key = { id: string; slug: string; source_id: string; source_path: string | null; source_path_bytes: number; source_uri: string | null; withheld_source_path: string | null; type: string;
  frontmatter: unknown; database_only_reason: string | null; segmented: boolean; lineage_private: boolean; revision: string | null };

const zeros = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map(key => [key, 0])) as Record<K, number>;

function emptyCensus(sourceId: string, root: string | null, head: HeadTree | null): GitGapCensus {
  return { status: 'census', source_id: sourceId, checkout: root, head: head?.commit ?? null, complete: true, pages: 0, states: zeros(PAGE_STATES),
    declared: zeros(DECLARED_CLASSES), declared_with_head_blob: 0, database_ahead_without_import_record: 0, git_ahead_database_also_moved: 0, not_compared: 0,
    worktree: root ? zeros(WORKTREE_STATES) : null,
    rows_without_git_home: { facts_unfenced: 0, facts_fence_page_missing: 0, facts_on_pages_without_file: { undeclared: 0, declared: 0 },
      links: { total: 0, by_link_source: {} }, timeline_on_pages_without_file: { undeclared: 0, declared: 0 } },
    holds: {}, parked_effects: [], sample: [],
    next: `Nothing changed. This release only reports the gap; converting a source to git-canonical arrives in a later release (${GIT_GAP_DOCS}).` };
}

/** The checkout side of a census: the source root, HEAD, the slug root mode and the source's directory inside the checkout. */
interface Checkout { root: string; head: HeadTree; mode: Awaited<ReturnType<typeof scannerSlugRootMode>>; scope: string }

const refuse = (message: string, suggestion: string) => new OperationError('storage_error', message, suggestion, GIT_GAP_DOCS);

/** `collect` receives each classified page, with the export snapshot the census compared for a database_ahead or git_ahead page. */
export async function censusGitGap(engine: BrainEngine, sourceId: string, opts: { sample: number; deadlineAt?: number; collect?: GitGapCollect }): Promise<GitGapCensus> {
  await resolveSourceId(engine, sourceId, undefined, { skipLocalSignals: true });
  const [source] = await engine.executeRaw<{ local_path: string | null; incarnation: string }>('SELECT local_path, incarnation::text AS incarnation FROM sources WHERE id=$1', [sourceId]);
  const root = source?.local_path && existsSync(source.local_path) ? source.local_path : null;
  const mirror = await sourceMirrorReadOnly(engine, sourceId);
  if (root) isSourceDbOnlySlug(root, '', 'refuse');
  await readHonorAliases(engine);
  let checkout: Checkout | null = null;
  if (root) {
    const head = await readHeadTree(root);
    if (!head) throw refuse(`Git could not list HEAD of the checkout at ${root}, so nothing can be compared.`,
      `Nothing changed. Check that ${root} is a Git checkout (git -C ${root} rev-parse HEAD), then rerun gbrain sources git-gap ${sourceId}.`);
    const scope = relative(head.gitRoot, realpathSync(root)).split(sep).join('/');
    checkout = { root, head, mode: await scannerSlugRootMode(engine, sourceId, root), scope };
  }
  const census = emptyCensus(sourceId, root, checkout?.head ?? null);
  // G7a: a source with no checkout is a database-only source, one declared class for all its pages (outside strict mode).
  const policy = { mirror, databaseOnlySource: root === null, dbOnly: (slug: string) => root !== null && isSourceDbOnlySlug(root, slug, 'refuse'), ignored: new Set<string>() };
  for (let cursor = '0'; ;) {
    if (opts.deadlineAt !== undefined && Date.now() >= opts.deadlineAt) { census.complete = false; break; }
    const done = await engine.transaction(async tx => {
      await tx.executeRaw('SET TRANSACTION READ ONLY');
      const batch = await tx.executeRaw<Key>(`SELECT id::text, slug, source_id, source_path, octet_length(source_path) AS source_path_bytes, source_uri, withheld_source_path, type, frontmatter,
          database_only_reason, body_storage='segmented' AS segmented, knowledge_revision::text AS revision, NOT ${privatePagesFilterFragment('pages')} AS lineage_private
        FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND pages.id > $2::bigint ORDER BY pages.id LIMIT ${BATCH}`, [sourceId, cursor]);
      if (batch.length) { await censusBatch(tx, batch, census, { checkout, policy, incarnation: source!.incarnation, sample: opts.sample, collect: opts.collect }); cursor = batch[batch.length - 1]!.id; }
      return batch.length < BATCH;
    });
    if (done) break;
  }
  await engine.transaction(async tx => {
    await tx.executeRaw('SET TRANSACTION READ ONLY');
    await countSourceRows(tx, census);
  });
  return census;
}

export type GitGapCollect = (page: GitGapPage, snapshot?: ExportSnapshot) => void;

interface BatchContext { checkout: Checkout | null; policy: { mirror: boolean; databaseOnlySource: boolean; dbOnly: (slug: string) => boolean; ignored: Set<string> }; incarnation: string; sample: number;
  collect?: GitGapCollect }

const collected = (key: Key, path: string | null, state: PageState, extra: Partial<GitGapPage> = {}): GitGapPage =>
  ({ id: key.id, slug: key.slug, revision: key.revision, path, state, segmented: key.segmented === true, ...extra });

function note(census: GitGapCensus, limit: number, item: GitGapSample): void {
  if (census.sample.length < limit) census.sample.push(item);
}

/** One batch: classify every page, compare the ones with a committed blob, and count the rows of the pages without a file. */
async function censusBatch(tx: BrainEngine, batch: Key[], census: GitGapCensus, ctx: BatchContext): Promise<void> {
  const { checkout } = ctx;
  const target = (key: Key): string | null => {
    // A withheld page's file is looked for where its private transition removed it, as page-prepare writes it there again.
    const recorded = key.source_path || key.withheld_source_path;
    try { return restoreFilePath(checkout!.root, key.slug, recorded, key.source_path ? Number(key.source_path_bytes) : Buffer.byteLength(recorded ?? ''), checkout!.mode); }
    catch (error) { if (error instanceof RestoreTargetError) return null; throw error; }
  };
  const rows = batch.map(key => {
    const path = checkout ? target(key) : null;
    return { key, path, rel: path ? relative(checkout!.root, path).split(sep).join('/') : null };
  });
  if (checkout) {
    // A path whose ignore status Git cannot read (one beyond a symlink) is classified as if not ignored in the conversion
    // plan, which discards it as ignore_status_unknown instead of adopting it; the census report refuses, as it did before #7617.
    const status = await ignoredPaths(checkout.root, rows.flatMap(row => row.rel === null ? [] : [row.rel]));
    if (!status) throw refuse(`Git could not say which paths the checkout at ${checkout.root} ignores, so the declared classes are unknown.`,
      `Nothing changed. Check that ${checkout.root} is a Git checkout (git -C ${checkout.root} rev-parse HEAD), then rerun gbrain sources git-gap ${batch[0]!.source_id}.`);
    const [unknown] = status.unknown;
    if (unknown && !ctx.collect) throw refuse(`Git could not say whether ${unknown[0]} in the checkout at ${checkout.root} is ignored (${unknown[1]}), so the declared classes are unknown.`,
      `Nothing changed. Check the path with git -C ${checkout.root} check-ignore -- ${unknown[0]} (Git cannot check a path beyond a symlinked directory), then rerun gbrain sources git-gap ${batch[0]!.source_id}.`);
    ctx.policy.ignored = status.ignored;
  }
  const noFile = { undeclared: [] as Key[], declared: [] as Key[] };
  const compare: Array<{ key: Key; path: string; rel: string; blob: TreeBlob; worktree: WorktreeState }> = [];
  for (const { key, path, rel } of rows) {
    census.pages++;
    const frontmatter = typeof key.frontmatter === 'string' ? JSON.parse(key.frontmatter) : key.frontmatter;
    const declared = declaredDatabaseOnly({ ...key, frontmatter }, rel, ctx.policy);
    const blob = checkout && rel !== null ? checkout.head.blobs.get(checkout.scope ? `${checkout.scope}/${rel}` : rel) : undefined;
    if (declared) {
      census.declared[declared]++;
      census.states.declared_database_only++;
      const oid = ctx.collect && blob && path ? await worktreeBlobOid(path, checkout!.head.format) : undefined;
      ctx.collect?.(collected(key, rel, 'declared_database_only', { declared, recordsFile: Boolean(key.source_path),
        ...(blob ? { headBlob: blob.oid, headSize: blob.size, worktree: oid === null ? 'deleted' : oid === blob.oid ? 'clean' : 'modified' } : {}) }));
      if (blob) { census.declared_with_head_blob++; note(census, ctx.sample, { slug: key.slug, path: rel!, state: 'declared_database_only', declared }); }
      else if (checkout) noFile.declared.push(key);
      continue;
    }
    if (!checkout) { census.not_compared++; continue; }
    if (!path || rel === null) {
      census.states.unsafe_path++;
      ctx.collect?.(collected(key, null, 'unsafe_path'));
      noFile.undeclared.push(key);
      note(census, ctx.sample, { slug: key.slug, path: key.source_path ?? '', state: 'unsafe_path' });
      continue;
    }
    const oid = await worktreeBlobOid(path, checkout.head.format);
    if (!blob) {
      const state: PageState = oid === null ? 'undeclared_database_only' : 'worktree_only';
      census.worktree![oid === null ? 'absent' : 'untracked']++;
      census.states[state]++;
      ctx.collect?.(collected(key, rel, state, { worktree: oid === null ? 'absent' : 'untracked' }));
      noFile.undeclared.push(key);
      note(census, ctx.sample, { slug: key.slug, path: rel, state, worktree: oid === null ? 'absent' : 'untracked' });
      continue;
    }
    const worktree: WorktreeState = oid === null ? 'deleted' : oid === blob.oid ? 'clean' : 'modified';
    census.worktree![worktree]++;
    if (blob.mode !== '100644' && blob.mode !== '100755') {
      census.states.unparseable++;
      ctx.collect?.(collected(key, rel, 'unparseable', { worktree, headBlob: blob.oid, unparseable: blob.mode === '120000' ? 'symlink' : 'non_regular_mode' }));
      note(census, ctx.sample, { slug: key.slug, path: rel, state: 'unparseable', worktree });
      continue;
    }
    compare.push({ key, path, rel, blob, worktree });
  }
  if (compare.length) await compareBatch(tx, compare, census, ctx);
  await countRowsWithoutFile(tx, batch[0]!.source_id, noFile, census);
}

async function compareBatch(tx: BrainEngine, compare: Array<{ key: Key; path: string; rel: string; blob: TreeBlob; worktree: WorktreeState }>, census: GitGapCensus,
  ctx: BatchContext): Promise<void> {
  const checkout = ctx.checkout!;
  const sourceId = compare[0]!.key.source_id;
  const blobs = await readBlobs(checkout.root, compare.filter(item => !item.key.segmented).map(item => item.blob));
  if (!blobs) throw refuse(`Git could not read committed files of the checkout at ${checkout.root}.`,
    `Nothing changed. Check the checkout with git -C ${checkout.root} fsck, then rerun gbrain sources git-gap ${sourceId}.`);
  const withdrawals: ExportWithdrawal[] = await readExportWithdrawals(tx, sourceId);
  const differs: Array<{ key: Key; rel: string; blob: TreeBlob; worktree: WorktreeState; fields: string[]; snapshot: ExportSnapshot }> = [];
  const snapshots = await readExportPages(tx, compare.map(item => item.key), withdrawals);
  for (const [i, item] of compare.entries()) {
    const snapshot = snapshots[i]!;
    const compared: ExportFileComparison = item.key.segmented ? await compareSegmentedExportBlob(tx, snapshot, withdrawals, item.blob, checkout.head.format)
      : compareInlineExportFile(blobs.get(item.blob.oid)!, scannerSourcePath(checkout.root, item.path, checkout.mode), snapshot);
    if (compared.state === 'equal') { census.states.equal++; ctx.collect?.(collected(item.key, item.rel, 'equal', { worktree: item.worktree, headBlob: item.blob.oid })); continue; }
    if (compared.state === 'unparseable') {
      census.states.unparseable++;
      ctx.collect?.(collected(item.key, item.rel, 'unparseable', { worktree: item.worktree, headBlob: item.blob.oid, unparseable: compared.reason }));
      note(census, ctx.sample, { slug: item.key.slug, path: item.rel, state: 'unparseable', worktree: item.worktree });
      continue;
    }
    differs.push({ ...item, fields: compared.paths, snapshot });
  }
  if (!differs.length) return;
  const records = await readSyncImportProvenances(tx, sourceId, ctx.incarnation, differs.map(item => Number(item.key.id)));
  for (const item of differs) {
    const record = records.get(Number(item.key.id));
    const imported = [record?.blob_oid, record?.disk_blob_oid].filter((oid): oid is string => typeof oid === 'string' && oid.length > 0);
    const gitMoved = imported.length > 0 && !imported.includes(item.blob.oid);
    const state: PageState = gitMoved ? 'git_ahead' : 'database_ahead';
    census.states[state]++;
    if (!imported.length) census.database_ahead_without_import_record++;
    const databaseAlsoMoved = gitMoved && record?.revision != null && String(record.revision) !== String(item.key.revision);
    if (databaseAlsoMoved) census.git_ahead_database_also_moved++;
    ctx.collect?.(collected(item.key, item.rel, state, { worktree: item.worktree, headBlob: item.blob.oid, databaseAlsoMoved }), item.snapshot);
    note(census, ctx.sample, { slug: item.key.slug, path: item.rel, state, fields: item.fields, basis: imported.length ? 'import_record' : 'no_import_record', worktree: item.worktree });
  }
}

/** Fenced fact rows and timeline rows of this batch's pages that have no committed file. */
async function countRowsWithoutFile(tx: BrainEngine, sourceId: string, noFile: { undeclared: Key[]; declared: Key[] }, census: GitGapCensus): Promise<void> {
  const rows = census.rows_without_git_home;
  for (const side of ['undeclared', 'declared'] as const) {
    const keys = noFile[side];
    if (!keys.length) continue;
    const [facts] = await tx.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM facts WHERE source_id=$1 AND row_num IS NOT NULL AND source_markdown_slug = ANY($2::text[])`,
      [sourceId, keys.map(key => key.slug)]);
    const [timeline] = await tx.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM timeline_entries WHERE page_id = ANY($1::int[])', [keys.map(key => Number(key.id))]);
    rows.facts_on_pages_without_file[side] += Number(facts?.n ?? 0);
    rows.timeline_on_pages_without_file[side] += Number(timeline?.n ?? 0);
  }
}

/**
 * Source-wide rows with no Git home and the source's open holds and parked targets. A link has a Git home only when a
 * file derives it (DERIVED_LINK_SOURCES: markdown, frontmatter, mentions, wikilink-resolved); every other provenance
 * (manual, a custom tag, concept-provenance, atom-provenance, a legacy NULL) is counted, by provenance.
 */
async function countSourceRows(tx: BrainEngine, census: GitGapCensus): Promise<void> {
  const sourceId = census.source_id;
  const rows = census.rows_without_git_home;
  const [unfenced] = await tx.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM facts WHERE source_id=$1 AND row_num IS NULL AND expired_at IS NULL', [sourceId]);
  rows.facts_unfenced = Number(unfenced?.n ?? 0);
  const [missing] = await tx.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM facts f WHERE f.source_id=$1 AND f.row_num IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id=f.source_id AND p.slug=f.source_markdown_slug AND p.deleted_at IS NULL)`, [sourceId]);
  rows.facts_fence_page_missing = Number(missing?.n ?? 0);
  const links = await tx.executeRaw<{ link_source: string; n: number }>(`SELECT COALESCE(l.link_source, '(none)') AS link_source, count(*)::int AS n
    FROM links l JOIN pages p ON p.id=l.from_page_id WHERE p.source_id=$1 AND p.deleted_at IS NULL AND (l.link_source IS NULL OR NOT (l.link_source = ANY($2::text[])))
    GROUP BY 1 ORDER BY 1`, [sourceId, DERIVED_LINK_SOURCES]);
  rows.links = { total: links.reduce((sum, row) => sum + Number(row.n), 0), by_link_source: Object.fromEntries(links.map(row => [row.link_source, Number(row.n)])) };
  const holds = await tx.executeRaw<{ code: string; n: number }>(`SELECT h.completed_keys->0->>'code' AS code, count(*)::int AS n FROM op_checkpoints h
    JOIN sources s ON s.id=h.completed_keys->0->>'source_id' AND s.incarnation::text=h.completed_keys->0->>'incarnation'
    WHERE h.op=$1 AND s.id=$2 GROUP BY 1 ORDER BY 1`, [GIT_HOLD_OP, sourceId]);
  census.holds = Object.fromEntries(holds.map(row => [row.code ?? 'unknown', Number(row.n)]));
  const parked = await tx.executeRaw<{ kind: string; code: string | null; targets: number }>(`SELECT e.kind, p->>'error_code' AS code, count(*)::int AS targets
    FROM persistence_effects e CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(e.data->'parked')='array' THEN e.data->'parked' ELSE '[]'::jsonb END) p
    WHERE e.source_id=$1 GROUP BY 1, 2 ORDER BY 1, 2`, [sourceId]);
  census.parked_effects = parked.map(row => ({ kind: row.kind, code: row.code ?? 'unknown', targets: Number(row.targets) }));
}

const counts = (record: Record<string, number>) => Object.entries(record).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';

export function describeGitGap(census: GitGapCensus): string {
  const lines = [`Git gap of source ${census.source_id} (read-only): ${census.pages} live page(s)${census.head ? `, compared with HEAD ${census.head.slice(0, 12)}` : ''}.`];
  if (!census.checkout) lines.push(`The source has no checkout: a database-only source, so its page(s) are declared database_only_source and none were compared.`);
  else if (!census.head) lines.push('The checkout has no commit yet, so no page has a committed file.');
  lines.push(`Pages: ${counts(census.states)}.`, `Declared database-only: ${counts(census.declared)}${census.declared_with_head_blob ? ` (${census.declared_with_head_blob} still committed at HEAD)` : ''}.`);
  if (census.database_ahead_without_import_record) lines.push(`${census.database_ahead_without_import_record} database_ahead page(s) have no import record, so the side that moved is unknown.`);
  if (census.git_ahead_database_also_moved) lines.push(`${census.git_ahead_database_also_moved} git_ahead page(s) also changed in the database since their last import.`);
  if (census.worktree) lines.push(`Working tree against HEAD: ${counts(census.worktree)}.`);
  const rows = census.rows_without_git_home;
  lines.push(`Rows with no Git home: facts unfenced ${rows.facts_unfenced}, fenced on a missing page ${rows.facts_fence_page_missing}, `
    + `fenced on a page without a file ${rows.facts_on_pages_without_file.undeclared} (+${rows.facts_on_pages_without_file.declared} declared); `
    + `links ${rows.links.total} (${counts(rows.links.by_link_source)}); timeline rows on a page without a file ${rows.timeline_on_pages_without_file.undeclared} `
    + `(+${rows.timeline_on_pages_without_file.declared} declared).`);
  lines.push(`Open sync holds: ${counts(census.holds)}. Parked effect targets: ${census.parked_effects.map(p => `${p.kind} ${p.code} ${p.targets}`).join(', ') || 'none'}.`);
  for (const item of census.sample) {
    lines.push(`  ${item.state}${item.declared ? ` (${item.declared})` : ''}: ${item.slug} (${item.path})${item.fields ? ` fields ${item.fields.join(', ')}` : ''}${item.worktree ? ` worktree ${item.worktree}` : ''}`);
  }
  if (!census.complete) lines.push('PARTIAL: the scan stopped at its time budget, so the counts cover only the pages read.');
  lines.push(census.next);
  return lines.join('\n');
}

export async function runSourcesGitGap(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  if (args.includes('--help') || args.includes('-h')) { console.log(`${USAGE}\nRead-only: compares each page of the source with its committed file at HEAD (${GIT_GAP_DOCS}).`); return; }
  try {
    const parsed = parseGitGapArgs(args);
    const census = await censusGitGap(engine, parsed.sourceId, { sample: parsed.sample });
    console.log(json ? JSON.stringify(census) : describeGitGap(census));
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    const env = toAgentError(error, { transport: 'cli', command: 'sources git-gap', render: cliRenderContext() });
    console.log(json ? JSON.stringify({ status: 'refused', ...env }) : `Census refused (${error.code}): ${error.message}\nFix: ${error.suggestion ?? USAGE}`);
    setCliExitVerdict(1);
  }
}
