/**
 * `gbrain pages status <slug...> [--source <id>] [--json]` (#7179): read-only,
 * one answer per page to "is this page searchable, and if not, why?". It joins
 * what an operator otherwise assembles by hand: the page row (live, deleted or
 * missing), its embedding state from the engine classifier
 * (`listEmbeddingStateRows` narrowed by `slugs`; worst state wins), the chunks
 * without a vector in the active column, an applying large-page embedding hold
 * (`budgetRowAppliesFilter`), the Git sync hold on its file (`readGitHold`),
 * and whether the file is in the source's synced commit. States use the
 * `sources resolve-path` vocabulary. A held large page stays
 * `pending_embedding`; its fix is the held approval (ask_user, preview first),
 * never a spend. A sync hold's own fix wins over every other fix.
 */
import { realpathSync } from 'node:fs';
import type { BrainEngine } from '../core/engine.ts';
import { cliRenderContext, renderAction, type Action } from '../core/agent-output.ts';
import { opError } from '../core/ops/contract.ts';
import { resolveSourceId } from '../core/source-resolver.ts';
import { embeddingsDisabled } from '../core/embedding-disabled.ts';
import { DELETED_PAGE_PURGE_WINDOW_HOURS, embeddingStateFix, type EmbeddingState, type EmbeddingStateRow } from '../core/embedding-state.ts';
import { approvalAmount, approvalBasis, heldApproveAction } from '../core/held-embedding-action.ts';
import { budgetRowAppliesFilter } from '../core/page-size-policy.ts';
import { embedProgressLine, readEmbedProgressView, type EmbedProgressView } from '../core/embedding-ledger.ts';
import { chunkGenerationFilter } from '../core/search/safe-chunks.ts';
import { quoteIdentifier, resolveActiveEmbeddingColumnFromEngine } from '../core/search/embedding-column.ts';
import { effectiveBytesBlock } from '../core/import-screen.ts';
import { loadSyncEligibility, syncGit } from '../core/persistence/sync-discovery.ts';
import { fenceAutoRepairFor, gitHoldFix, readGitHold } from '../core/persistence/sync-holds.ts';

export const PAGES_STATUS_USAGE = 'Usage: gbrain pages status <slug...> [--source <id>] [--json]';
/** Slugs one call reads. */
export const PAGES_STATUS_MAX = 200;

export type PageStatusState = 'searchable' | 'pending_embedding' | 'chunkless' | 'keyword_only' | 'quarantined' | 'empty' | 'missing' | 'page_deleted';

export interface PageStatus {
  slug: string;
  source_id: string;
  state: PageStatusState;
  /** Whether search finds the page now: by keyword and vector (`true`), by keyword only (`'keyword'`), or not at all. */
  searchable: true | 'keyword' | false;
  page: { id: number; slug: string; deleted: boolean; chunks: number; unembedded: number } | null;
  embedding_hold: { state: 'held' | 'capped'; reason: string | null; updated_at: string } | null;
  /** Wave C 1F: a segmented page's embedding progress (page_embedding_progress), with the line the human output prints; null when none is recorded. */
  embedding_progress: (EmbedProgressView & { line: string }) | null;
  hold: { code: string; message: string } | null;
  source_path: string | null;
  /** The file is in the source's synced commit (`sources.last_commit`); null without a Git checkout here or a recorded file. */
  in_synced_commit: boolean | null;
  why: string;
  fix: Action | null;
}

export interface PagesStatus {
  source_id: string;
  last_commit: string | null;
  head: string | null;
  at_head: boolean | null;
  embeddings_enabled: boolean;
  pages: PageStatus[];
}

export interface PagesStatusArgs { slugs: string[]; source: string | null; json: boolean }

/** Worst first: a page with some chunks embedded and some pending reads as pending. */
const STATE_ORDER: EmbeddingState[] = ['quarantined', 'chunkless_healable', 'pending', 'keyword_only', 'empty', 'embedded'];
const PAGE_STATE: Record<Exclude<EmbeddingState, 'deleted_page_chunks'>, PageStatusState> = { embedded: 'searchable', pending: 'pending_embedding',
  keyword_only: 'keyword_only', quarantined: 'quarantined', empty: 'empty', chunkless_healable: 'chunkless' };
const SEARCHABLE: Record<PageStatusState, PageStatus['searchable']> = { searchable: true, pending_embedding: 'keyword', keyword_only: 'keyword',
  quarantined: false, chunkless: false, empty: false, missing: false, page_deleted: false };

/** Positional slugs plus `--source <id>` (or `--source=<id>`) and `--json`; anything else is `invalid_params`. */
export function parsePagesStatusArgs(args: readonly string[]): PagesStatusArgs {
  const slugs: string[] = [];
  let source: string | null = null;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') { json = true; continue; }
    if (arg === '--source' || arg.startsWith('--source=')) {
      if (source !== null) throw opError('invalid_params', '--source was given more than once.', PAGES_STATUS_USAGE);
      const value = arg === '--source' ? args[++i] : arg.slice('--source='.length);
      if (!value || value.startsWith('-')) throw opError('invalid_params', '--source needs a source id.', PAGES_STATUS_USAGE);
      source = value;
      continue;
    }
    if (arg.startsWith('-')) throw opError('invalid_params', `Unknown option: ${arg}.`, PAGES_STATUS_USAGE);
    if (!slugs.includes(arg)) slugs.push(arg);
  }
  if (!slugs.length) throw opError('invalid_params', 'Name at least one page slug.', PAGES_STATUS_USAGE);
  if (slugs.length > PAGES_STATUS_MAX) throw opError('invalid_params', `At most ${PAGES_STATUS_MAX} slugs per call (got ${slugs.length}).`, `Split the slugs into batches. ${PAGES_STATUS_USAGE}`);
  return { slugs, source, json };
}

interface PageRow {
  id: number; slug: string; deleted: boolean; source_path: string | null; embed_skip: boolean;
  hold_state: 'held' | 'capped' | null; hold_reason: string | null; hold_updated_at: Date | string | null;
  chunks: number | string; unembedded: number | string; unembedded_chars: number | string;
}

/** The page rows (live or deleted), each with its chunk counts over the active column and its applying embedding budget row. */
async function readPages(engine: BrainEngine, sourceId: string, slugs: string[]): Promise<Map<string, PageRow>> {
  const column = `cc.${quoteIdentifier((await resolveActiveEmbeddingColumnFromEngine(engine, { fallbackToLegacy: true })).name)}`;
  const rows = await engine.executeRaw<PageRow>(
    `SELECT p.id, p.slug, p.deleted_at IS NOT NULL AS deleted, p.source_path, COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip' AS embed_skip,
            b.state AS hold_state, b.reason AS hold_reason, b.updated_at AS hold_updated_at, w.chunks, w.unembedded, w.unembedded_chars
       FROM pages p
       LEFT JOIN page_embedding_budget b ON b.page_id = p.id AND ${budgetRowAppliesFilter('b', 'p')}
       CROSS JOIN LATERAL (SELECT count(*)::int AS chunks, (count(*) FILTER (WHERE ${column} IS NULL))::int AS unembedded,
                                  COALESCE(sum(length(cc.chunk_text)) FILTER (WHERE ${column} IS NULL), 0)::bigint AS unembedded_chars
                             FROM content_chunks cc WHERE cc.page_id = p.id AND ${chunkGenerationFilter('p', 'cc')}) w
      WHERE p.source_id = $1 AND p.slug = ANY($2::text[])`, [sourceId, slugs]);
  return new Map(rows.map(row => [row.slug, row]));
}

/** The worst classifier row per live slug. */
async function readEmbeddingStates(engine: BrainEngine, sourceId: string, slugs: string[]): Promise<Map<string, EmbeddingStateRow>> {
  if (!slugs.length) return new Map();
  const rows = await engine.listEmbeddingStateRows({ sourceIds: [sourceId], slugs, states: STATE_ORDER, limit: slugs.length * STATE_ORDER.length,
    purgeWindowHours: DELETED_PAGE_PURGE_WINDOW_HOURS });
  const worst = new Map<string, EmbeddingStateRow>();
  for (const row of rows) {
    const prior = worst.get(row.slug);
    if (!prior || STATE_ORDER.indexOf(row.state) < STATE_ORDER.indexOf(prior.state)) worst.set(row.slug, row);
  }
  return worst;
}

interface GitView { head: string | null; files: Map<string, { inSynced: boolean | null; holdPath: string | null }> }

/**
 * HEAD of the source checkout on this host and, per recorded file, whether the synced commit has it and its hold key
 * (the source-root-relative path) under the source's slug mode. Null when the source has no readable Git checkout here.
 */
async function readGitView(engine: BrainEngine, sourceId: string, source: { local_path: string | null; last_commit: string | null; config: Record<string, unknown> | null },
  sourcePaths: string[]): Promise<GitView | null> {
  if (!source.local_path) return null;
  try {
    const root = realpathSync(source.local_path);
    const gitRoot = realpathSync(syncGit(root, ['rev-parse', '--show-toplevel']).trim());
    let head: string | null = null;
    try { head = syncGit(gitRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).trim() || null; } catch { /* unborn HEAD */ }
    const { scope, slugMode } = await loadSyncEligibility(engine, { root, gitRoot, sourceId, source: { last_commit: source.last_commit, config: source.config ?? {} } });
    const mapped = sourcePaths.map(sourcePath => {
      if (slugMode === 'source-root' && scope) return { sourcePath, gitPath: `${scope}/${sourcePath}`, holdPath: sourcePath };
      return { sourcePath, gitPath: sourcePath, holdPath: !scope ? sourcePath : sourcePath.startsWith(`${scope}/`) ? sourcePath.slice(scope.length + 1) : null };
    });
    let synced: Set<string> | null = null;
    if (source.last_commit && mapped.length) {
      try {
        const listed = syncGit(gitRoot, ['--literal-pathspecs', 'ls-tree', '-z', '--name-only', source.last_commit, '--', ...mapped.map(m => m.gitPath)]);
        synced = new Set(listed.split('\0').filter(Boolean));
      } catch { /* the synced commit is not in this checkout */ }
    }
    return { head, files: new Map(mapped.map(m => [m.sourcePath, { inSynced: synced ? synced.has(m.gitPath) : null, holdPath: m.holdPath }])) };
  } catch {
    return null;
  }
}

function stateWhy(slug: string, state: PageStatusState, ctx: { row?: EmbeddingStateRow; unembedded: number; disabled: boolean; embeddingHold: PageStatus['embedding_hold'] }): string {
  switch (state) {
    case 'searchable': return `Page ${slug} is live and every chunk has a vector.`;
    case 'pending_embedding':
      if (ctx.embeddingHold) return `Page ${slug} is searchable by keyword; ${ctx.unembedded} chunk(s) of this large page wait for embedding approval (${ctx.embeddingHold.state}${ctx.embeddingHold.reason ? `: ${ctx.embeddingHold.reason}` : ''}), and nothing embeds them until the user approves.`;
      return ctx.disabled ? `Page ${slug} is searchable by keyword; embeddings are off on this brain, so its chunks carry no vector.`
        : `Page ${slug} is searchable by keyword; ${ctx.unembedded} chunk(s) still wait for a vector.`;
    case 'keyword_only': return `Page ${slug} is searchable by keyword only: the import gate marked it embed_skip (${ctx.row?.embed_skip_reason ?? 'embed_skip'}), so it gets no vectors.`;
    case 'quarantined': return `Page ${slug} is quarantined (${ctx.row?.quarantine_reason ?? 'quarantine'}): the content-quality gate hides it from search.`;
    case 'chunkless': return `Page ${slug} has body text but no chunk rows, so neither keyword nor vector search can read its body.`;
    case 'empty': return `Page ${slug} has no body text, so there is nothing to search.`;
    case 'page_deleted': return `Page ${slug} is soft-deleted, so search never returns it. If it should come back, restore it with gbrain restore ${slug} --force.`;
    case 'missing': return `No page with slug ${slug} exists in this source, live or deleted.`;
  }
}

/** Resolves each slug of one source to its search state, reason and fix. Read-only. */
export async function readPagesStatus(engine: BrainEngine, sourceId: string, slugs: string[]): Promise<PagesStatus> {
  const [source] = await engine.executeRaw<{ local_path: string | null; last_commit: string | null; config: Record<string, unknown> | null; incarnation: string | null }>(
    'SELECT local_path, last_commit, config, incarnation::text AS incarnation FROM sources WHERE id=$1', [sourceId]);
  const disabled = await embeddingsDisabled(engine);
  const pages = await readPages(engine, sourceId, slugs);
  const states = await readEmbeddingStates(engine, sourceId, [...pages.values()].filter(page => !page.deleted).map(page => page.slug));
  const sourcePaths = [...new Set([...pages.values()].flatMap(page => page.source_path ? [page.source_path] : []))];
  const git = source ? await readGitView(engine, sourceId, source, sourcePaths) : null;
  const lastCommit = source?.last_commit ?? null;
  const head = git?.head ?? null;
  let blockBytes: number | undefined;
  let basis: Awaited<ReturnType<typeof approvalBasis>> | undefined;
  const out: PageStatus[] = [];
  for (const slug of slugs) {
    const page = pages.get(slug);
    if (!page) {
      out.push({ slug, source_id: sourceId, state: 'missing', searchable: false, page: null, embedding_hold: null, embedding_progress: null, hold: null, source_path: null, in_synced_commit: null,
        why: stateWhy(slug, 'missing', { unembedded: 0, disabled, embeddingHold: null }), fix: null });
      continue;
    }
    const file = page.source_path ? git?.files.get(page.source_path) : undefined;
    const record = file?.holdPath && source?.incarnation ? await readGitHold(engine, sourceId, source.incarnation, file.holdPath) : null;
    const embeddingHold = page.hold_state ? { state: page.hold_state, reason: page.hold_reason, updated_at: new Date(page.hold_updated_at!).toISOString() } : null;
    const unembedded = Number(page.unembedded);
    const row = page.deleted ? undefined : states.get(slug);
    let classifier: EmbeddingState | null = page.deleted ? null : row?.state ?? 'chunkless_healable';
    if (classifier === 'keyword_only' && embeddingHold && !page.embed_skip) classifier = 'pending';
    const state: PageStatusState = classifier === null ? 'page_deleted' : PAGE_STATE[classifier as Exclude<EmbeddingState, 'deleted_page_chunks'>] ?? 'searchable';
    let why = stateWhy(slug, state, { row, unembedded, disabled, embeddingHold });
    let fix: Action | null = null;
    if (record) {
      why = `Sync holds its file ${page.source_path} (${record.code}): ${record.message} Search shows the page as it was before the held change. ${why}`;
      fix = gitHoldFix(record, await fenceAutoRepairFor(engine, [record]));
    } else if (state === 'pending_embedding' && embeddingHold) {
      basis ??= await approvalBasis();
      fix = heldApproveAction({ source_id: sourceId, slug, pending_chunks: unembedded, ...approvalAmount(Number(page.unembedded_chars), basis) }, basis.free);
    } else if (classifier && classifier !== 'embedded' && !(disabled && classifier === 'pending')) {
      if (classifier === 'keyword_only') blockBytes ??= await effectiveBytesBlock(engine);
      fix = embeddingStateFix(classifier, { sourceId, slug, markerBytes: row?.marker_bytes ?? null, blockBytes, embeddingsEnabled: !disabled,
        verify: { argv: ['gbrain', 'pages', 'status', slug, '--source', sourceId, '--json'] } });
    }
    const progress = page.deleted ? null : await readEmbedProgressView(engine, Number(page.id));
    out.push({ slug, source_id: sourceId, state, searchable: SEARCHABLE[state],
      page: { id: Number(page.id), slug: page.slug, deleted: page.deleted, chunks: Number(page.chunks), unembedded },
      embedding_hold: embeddingHold, embedding_progress: progress ? { ...progress, line: embedProgressLine(progress) } : null, hold: record ? { code: record.code, message: record.message } : null, source_path: page.source_path,
      in_synced_commit: file?.inSynced ?? null, why, fix });
  }
  return { source_id: sourceId, last_commit: lastCommit, head, at_head: head && lastCommit ? head === lastCommit : null, embeddings_enabled: !disabled, pages: out };
}

export async function runPagesStatus(engine: BrainEngine, args: string[]): Promise<void> {
  const parsed = parsePagesStatusArgs(args);
  const sourceId = await resolveSourceId(engine, parsed.source);
  const result = await readPagesStatus(engine, sourceId, parsed.slugs);
  if (parsed.json) { console.log(JSON.stringify(result, null, 2)); return; }
  const commit = result.last_commit ? `last synced commit ${result.last_commit.slice(0, 12)}` : 'no synced commit';
  const headNote = result.head && result.at_head === false ? `, checkout HEAD ${result.head.slice(0, 12)} (not synced yet)` : '';
  console.log(`Source ${result.source_id}, ${commit}${headNote}; embeddings ${result.embeddings_enabled ? 'on' : 'off'}.`);
  const render = cliRenderContext();
  for (const p of result.pages) {
    const reach = p.searchable === true ? 'searchable' : p.searchable === 'keyword' ? 'keyword search only' : 'not searchable';
    console.log(`  ${p.slug}: ${p.state} (${reach})`);
    console.log(`    ${p.why}`);
    if (p.embedding_progress) console.log(`    embedding: ${p.embedding_progress.line}`);
    const fix = p.fix ? renderAction(p.fix, render) : null;
    if (fix?.command) console.log(`    fix (${fix.next.replace(/_/g, ' ')}): ${fix.command}`);
  }
}
