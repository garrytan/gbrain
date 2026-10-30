/**
 * GBRA-150: what gbrain did with each file path of a source, by gbrain's own rules, so a harness (a landing check, an
 * agent that just committed a page) never re-implements slugging or the skip lists and drifts from them.
 *
 * A landing check that copies gbrain rules drifts in exactly this way: a copy of the path→slug rule that only
 * lowercased (gbrain also strips leading and trailing hyphens), a deleted mixed-case file whose lowercase twin still
 * owns the slug (a delete must be checked by the page's origin, never by its slug), and a nested `index.md` that sync
 * skips as folder scaffolding (a page that will never exist). Resolving through here answers each with its reason.
 *
 * Per path (relative to the source root, or to the Git top level when it starts with the source's subpath):
 *   - `slug`: the slug sync gives the file (`resolveSlugForPath` of its origin under the source's slug mode).
 *   - `state`, one of RESOLVE_PATH_STATES, read in this order:
 *       not_synced_yet  the file at the checkout's HEAD differs from the last synced commit (added, changed or removed since);
 *       skipped         sync never imports this path (`skipped.reason`: a metafile, an excluded or pruned path, the strategy);
 *       held            a sync hold waits on the file (`hold.code`; `gbrain sync status` carries its fix);
 *       deleted         the file is gone from the synced commit and no live page records it as its origin (a live page
 *                       that only shares the slug, a case-folded twin, is named in `slug_owner` and is not a failure);
 *       stale_page      the file is gone from the synced commit but its page is still live;
 *       page_deleted    the file is committed but its page was deleted and sync keeps it deleted;
 *       slug_taken      the file is committed with no page because another file's page owns its slug;
 *       missing         the file is committed and eligible with no page, no hold and no skip: a real gap;
 *       searchable | pending_embedding | chunkless | keyword_only | quarantined | empty: the page's embedding state
 *                       (`embedding-state.ts`); `pending_embedding` is searchable by keyword on a brain keyless by choice.
 *   - `fix`: the existing command that moves the path on (never run here), or null when nothing is owed.
 * Read-only: Git object reads and bounded lookups on existing indexes; nothing is scheduled or written.
 */
import type { BrainEngine } from '../engine.ts';
import type { Action } from '../agent-output.ts';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { opError } from '../ops/contract.ts';
import { resolveSlugForPath, unsyncableReason, type SyncableReason } from '../sync.ts';
import { parseMarkdownHead } from '../markdown.ts';
import { embeddingsDisabled } from '../embedding-disabled.ts';
import { embeddingStateFix, type EmbeddingState } from '../embedding-state.ts';
import { PAGE_SEARCHABLE, readPageSearchability } from '../page-searchability.ts';
import { loadSyncEligibility, syncGit } from './sync-discovery.ts';
import { readBlobContents } from './sync-blobs.ts';
import { readGitHold } from './sync-holds.ts';
import { persistenceEnabledForHealth } from './ownership.ts';

/** Paths one call resolves. */
export const RESOLVE_PATHS_MAX = 200;

export const RESOLVE_PATH_STATES = ['searchable', 'pending_embedding', 'chunkless', 'keyword_only', 'quarantined', 'empty', 'held', 'skipped', 'not_synced_yet',
  'missing', 'slug_taken', 'page_deleted', 'deleted', 'stale_page'] as const;
export type ResolvePathState = typeof RESOLVE_PATH_STATES[number];

export interface ResolvedPath {
  path: string;
  /** The page origin the file maps to (`pages.source_path`). */
  source_path: string;
  slug: string;
  state: ResolvePathState;
  /** Whether search can find the page now: by keyword and vector (`true`), by keyword only (`'keyword'`), or not at all. */
  searchable: true | 'keyword' | false;
  in_synced_commit: boolean;
  at_head: boolean | null;
  skipped: { reason: SyncableReason; typed_frontmatter?: boolean } | null;
  hold: { code: string; message: string } | null;
  page: { id: number; slug: string; deleted: boolean; chunks: number; unembedded: number } | null;
  /**
   * The page's embedding budget hold (a large page held for approval or stopped at its cap, never an `embed_skip`), or
   * null. A held page reads `pending_embedding`; it waits for approval. `page.unembedded` is always the visible chunks with no active-column vector.
   */
  embedding_hold: { state: 'held' | 'capped'; reason: string; updated_at: string } | null;
  /** A live page that owns this slug with another origin (a case-folded or hyphen-folded twin), or null. */
  slug_owner: { slug: string; source_path: string | null } | null;
  /** A frontmatter `slug:` that differs from the path slug (sync holds such a file as SLUG_MISMATCH). */
  frontmatter_slug: string | null;
  why: string;
  fix: Action | null;
}

export interface ResolvedPaths {
  source_id: string;
  mode: 'managed' | 'classic';
  last_commit: string | null;
  head: string | null;
  embeddings_enabled: boolean;
  paths: ResolvedPath[];
}

const DOCS = 'docs/guides/resolve-paths.md';
const PAGE_STATE: Record<Exclude<EmbeddingState, 'deleted_page_chunks'>, ResolvePathState> = { embedded: 'searchable', pending: 'pending_embedding',
  keyword_only: 'keyword_only', quarantined: 'quarantined', empty: 'empty', chunkless_healable: 'chunkless' };

interface TreeRow { path: string; oid: string; size: number }

function lsTree(gitRoot: string, commit: string | null, paths: string[]): Map<string, TreeRow> {
  const out = new Map<string, TreeRow>();
  if (!commit || !paths.length) return out;
  const raw = syncGit(gitRoot, ['--literal-pathspecs', 'ls-tree', '-l', '-z', commit, '--', ...paths]);
  for (const row of raw.split('\0')) {
    const tab = row.indexOf('\t');
    if (tab < 0) continue;
    const [, kind, oid, size] = row.slice(0, tab).split(/\s+/);
    if (kind === 'blob') out.set(row.slice(tab + 1), { path: row.slice(tab + 1), oid: oid!, size: Number(size) });
  }
  return out;
}

function headCommit(gitRoot: string): string | null {
  try { return syncGit(gitRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).trim() || null; } catch { return null; }
}

const readFix = (why: string, argv: string[], verify: string[]): Action => ({ argv, consent: [], actor: 'agent', requires_exclusive: false, why, verify: { argv: verify }, docs: DOCS });

/** Resolves `paths` of one source; refuses more than RESOLVE_PATHS_MAX paths and a source without a local Git checkout. */
export async function resolveSourcePaths(engine: BrainEngine, sourceId: string, paths: string[]): Promise<ResolvedPaths> {
  if (!paths.length) throw opError('invalid_params', 'Pass at least one file path.', 'Name the repo-relative paths a commit changed, for example projects/acme-example/index.md.');
  if (paths.length > RESOLVE_PATHS_MAX) throw opError('invalid_params', `At most ${RESOLVE_PATHS_MAX} paths per call (got ${paths.length}).`, 'Split the paths into batches.');
  const [source] = await engine.executeRaw<{ local_path: string | null; last_commit: string | null; config: Record<string, unknown> | null; archived: boolean | null }>(
    'SELECT local_path, last_commit, config, archived FROM sources WHERE id=$1', [sourceId]);
  const status = ['gbrain', 'sources', 'status', sourceId, '--json'];
  if (!source || source.archived) throw opError('not_found', `Source ${sourceId} is not registered or is archived.`, 'List the registered sources and pass one of their ids.',
    { fix: readFix('Lists the registered sources.', ['gbrain', 'sources', 'list', '--json'], ['gbrain', 'sources', 'list', '--json']) });
  if (source.local_path && !isAbsolute(source.local_path)) throw opError('sync_anchor_relative', `Source ${sourceId} has a relative local_path, which names no fixed directory, so its paths cannot be resolved.`,
    'Ask the user which directory holds the checkout, then run gbrain sources set-path on the host that holds it.',
    { fix: { argv: ['gbrain', 'sources', 'set-path', sourceId, '<dir>'], consent: [], actor: 'user', ask_user: true, requires_exclusive: false,
      inputs: [{ name: 'dir', how: "The absolute path of the directory that holds this source's checkout, from the user; never the current directory by default." }],
      user_message: `Source "${sourceId}" has a relative path as its directory, so gbrain cannot tell which folder holds its files. Which directory holds them? I'll point the source there (gbrain sources set-path ${sourceId} <absolute-directory>).`,
      why: 'Points the source at an absolute directory; it only updates the pointer, no file or page changes.', verify: { argv: status }, docs: DOCS } });
  if (!source.local_path || !existsSync(source.local_path)) throw opError('not_found', `Source ${sourceId} has no Git checkout on this host, so its paths cannot be resolved here.`,
    'Run this on the host that holds the checkout (gbrain sources status names its path).', { fix: readFix('Shows where the source checkout lives.', status, status) });
  const root = realpathSync(source.local_path);
  const gitRoot = realpathSync(syncGit(root, ['rev-parse', '--show-toplevel']).trim());
  const context = { root, gitRoot, sourceId, source: { last_commit: source.last_commit, config: source.config ?? {} } };
  const { scope, eligible, sourcePath } = await loadSyncEligibility(engine, context);
  const managed = await persistenceEnabledForHealth(engine).catch(() => false);
  const [{ incarnation } = { incarnation: '' }] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [sourceId]);
  const disabled = await embeddingsDisabled(engine);
  const head = headCommit(gitRoot);
  const normalized = paths.map(input => {
    const clean = input.replace(/\\/g, '/').replace(/^\.?\//, '');
    const gitPath = !scope || clean.startsWith(`${scope}/`) ? clean : `${scope}/${clean}`;
    return { input, gitPath, rootPath: scope ? gitPath.slice(scope.length + 1) : gitPath, origin: sourcePath(gitPath) };
  });
  const gitPaths = normalized.map(p => p.gitPath);
  const synced = lsTree(gitRoot, source.last_commit, gitPaths);
  const atHead = head ? lsTree(gitRoot, head, gitPaths) : null;
  const heads = readBlobContents(gitRoot, [...synced.values()].filter(row => row.size <= 256 * 1024));
  const origins = normalized.map(p => p.origin);
  const pages = await engine.executeRaw<{ id: number; slug: string; source_path: string; deleted: boolean }>(
    'SELECT id, slug, source_path, deleted_at IS NOT NULL AS deleted FROM pages WHERE source_id=$1 AND source_path = ANY($2::text[]) ORDER BY deleted_at IS NOT NULL, id DESC', [sourceId, origins]);
  const byOrigin = new Map<string, typeof pages[number]>();
  for (const page of pages) if (!byOrigin.has(page.source_path)) byOrigin.set(page.source_path, page);
  const slugs = [...new Set(origins.map(origin => resolveSlugForPath(origin)).filter(Boolean))];
  const owners = new Map((await engine.executeRaw<{ slug: string; source_path: string | null }>(
    'SELECT slug, source_path FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND slug = ANY($2::text[])', [sourceId, slugs])).map(row => [row.slug, row]));
  const liveSlugs = [...new Set([...byOrigin.values()].filter(page => !page.deleted).map(page => page.slug))];
  const searchability = await readPageSearchability(engine, sourceId, liveSlugs);
  const embedding = new Map([...searchability].filter(([, page]) => page.embedding_state).map(([slug, page]) => [slug, { state: page.embedding_state!, chunks: page.chunks, unembedded: page.unembedded }]));
  const budgetHolds = new Map([...searchability].filter(([, page]) => page.embedding_hold).map(([slug, page]) => [slug, page.embedding_hold!]));
  const sync = ['gbrain', 'sync', '--source', sourceId, '--no-pull'];
  const syncStatus = ['gbrain', 'sync', 'status', '--source', sourceId, '--json'];
  const verify = (path: string) => ['gbrain', 'sources', 'resolve-path', sourceId, path, '--json'];
  const out: ResolvedPath[] = [];
  for (const p of normalized) {
    const slug = resolveSlugForPath(p.origin);
    const committed = synced.get(p.gitPath);
    const current = atHead ? atHead.get(p.gitPath) : undefined;
    const page = byOrigin.get(p.origin) ?? null;
    const owner = owners.get(slug);
    const slugOwner = owner && owner.source_path !== p.origin ? { slug: owner.slug, source_path: owner.source_path } : null;
    const content = committed ? heads.get(committed.oid) : undefined;
    const frontmatter = content !== undefined ? parseMarkdownHead(content).frontmatter as Record<string, unknown> : {};
    const declared = typeof frontmatter.slug === 'string' && frontmatter.slug !== slug ? frontmatter.slug : null;
    const reason = unsyncableReason(p.gitPath, { strategy: (source.config?.strategy as 'markdown') ?? 'markdown' });
    const skippedBy: SyncableReason | null = eligible(p.gitPath) ? null : reason ?? 'exclude-glob-hit';
    const live = page && !page.deleted ? page : null;
    const emb = live ? embedding.get(live.slug) : undefined;
    const base = { path: p.input, source_path: p.origin, slug, in_synced_commit: !!committed, at_head: atHead ? !!current : null, slug_owner: slugOwner, frontmatter_slug: declared,
      page: page ? { id: Number(page.id), slug: page.slug, deleted: page.deleted, chunks: emb?.chunks ?? 0, unembedded: emb?.unembedded ?? 0 } : null,
      skipped: null as ResolvedPath['skipped'], hold: null as ResolvedPath['hold'], embedding_hold: null as ResolvedPath['embedding_hold'] };
    const push = (state: ResolvePathState, searchable: ResolvedPath['searchable'], why: string, fix: Action | null, extra: Partial<ResolvedPath> = {}) =>
      out.push({ ...base, state, searchable, why, fix, ...extra });
    const liveSearch: ResolvedPath['searchable'] = emb ? PAGE_SEARCHABLE[emb.state] : false;
    if (atHead && (current?.oid ?? null) !== (committed?.oid ?? null)) {
      push('not_synced_yet', live ? liveSearch : false, `The file at HEAD ${current ? (committed ? 'changed' : 'was added') : 'was removed'} after the last synced commit ${source.last_commit?.slice(0, 12) ?? '(none)'}; the next sync of the source takes it.`,
        readFix('Syncs the checkout as it is.', sync, verify(p.input)));
      continue;
    }
    if (skippedBy) {
      const typed = skippedBy === 'metafile' && content !== undefined ? frontmatter.type != null || frontmatter.title != null : undefined;
      push('skipped', live ? liveSearch : false, skippedBy === 'metafile'
        ? `Sync never imports ${p.rootPath.split('/').pop()} files: they are folder scaffolding (SYNC_SKIP_FILES), so this path has no page by design${typed ? ', even though its frontmatter has a type: or title: (sync.metafile_pages is off; gbrain config set sync.metafile_pages typed imports it)' : ''}.`
        : `Sync does not import this path (${skippedBy}); it has no page by design.`, null, { skipped: { reason: skippedBy, ...(typed !== undefined ? { typed_frontmatter: typed } : {}) } });
      continue;
    }
    const hold = managed && committed && incarnation ? await readGitHold(engine, sourceId, incarnation, p.rootPath) : null;
    if (hold) {
      push('held', live ? liveSearch : false, `A sync hold (${hold.code}) waits on this file; ${live ? 'search shows the page as it was before the held change' : 'it has no page until the hold clears'}.`,
        readFix('Lists each hold with its fix and whether it needs a person.', syncStatus, verify(p.input)), { hold: { code: hold.code, message: hold.message } });
      continue;
    }
    if (!committed) {
      if (live) push('stale_page', liveSearch, `The file is gone from the synced commit, but its page ${live.slug} is still live.`, readFix('Syncs the source so the delete lands.', sync, verify(p.input)));
      else push('deleted', false, slugOwner ? `The file is gone and no live page records it as its origin. The slug ${slug} belongs to another file (${slugOwner.source_path ?? 'no recorded origin'}), which is not this file's page.`
        : 'The file is gone and no live page records it as its origin.', null);
      continue;
    }
    if (page?.deleted) { push('page_deleted', false, `The file is committed, but its page ${page.slug} was deleted and sync keeps it deleted. Restore the page, or delete or rename the file.`, null); continue; }
    if (!live) {
      if (slugOwner) { push('slug_taken', false, `The file is committed with no page: its slug ${slug} belongs to another file (${slugOwner.source_path ?? 'no recorded origin'}). Rename one of the two files.`, null); continue; }
      push('missing', false, 'The file is committed and eligible, with no page, no hold and no skip. A re-screen imports it or records why it cannot.',
        { ...readFix('Schedules committed files that have no page and no hold for a re-screen, then names the follow-up sync.', ['gbrain', 'sources', 'retry-held', sourceId, '--unindexed'], verify(p.input)),
          then: readFix('Imports the scheduled files.', sync, verify(p.input)) });
      continue;
    }
    const budget = budgetHolds.get(live.slug);
    if (budget) {
      push('pending_embedding', 'keyword', `Page ${live.slug} is searchable by keyword; its embedding budget is ${budget.state} (${budget.reason}), so ${base.page!.unembedded} chunk(s) wait for a vector until the hold is approved.`,
        readFix('Lists the held and capped large pages with the cost to finish and the approve command; read-only.', ['gbrain', 'embed', '--held', '--dry-run', '--source', sourceId], verify(p.input)),
        { embedding_hold: budget });
      continue;
    }
    const state = emb ? PAGE_STATE[emb.state as Exclude<EmbeddingState, 'deleted_page_chunks'>] ?? 'searchable' : 'chunkless';
    const fix = emb && emb.state !== 'embedded' ? embeddingStateFix(emb.state, { sourceId, slug: live.slug, embeddingsEnabled: !disabled, verify: { argv: verify(p.input) } }) : null;
    push(state, liveSearch, state === 'searchable' ? `Page ${live.slug} is live and every chunk has a vector.`
      : state === 'pending_embedding' ? (disabled ? `Page ${live.slug} is searchable by keyword; embeddings are off on this brain, so its chunks carry no vector.` : `Page ${live.slug} is searchable by keyword; ${emb!.unembedded} chunk(s) still wait for a vector.`)
      : `Page ${live.slug} is ${state.replace('_', ' ')}.`, disabled && state === 'pending_embedding' ? null : fix);
  }
  return { source_id: sourceId, mode: managed ? 'managed' : 'classic', last_commit: source.last_commit, head, embeddings_enabled: !disabled, paths: out };
}
