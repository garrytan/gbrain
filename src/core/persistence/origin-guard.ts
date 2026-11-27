/**
 * #6948: the one owner of origin assignment. A page's origin is the file it
 * records (`pages.source_id`, `pages.source_path`); two live pages of a source
 * recording the same origin ("twins") make sync discovery refuse that file. The
 * partial unique index `pages_live_origin_key` makes twins impossible where it
 * exists; on a brain whose existing twins keep the migration from building it,
 * this guard is the protection. Every write that makes a page a live claimant of
 * an origin it did not live-claim before (an assignment, an insert carrying an
 * origin, a tombstone revival) runs `assertOriginUnclaimed` in its own
 * transaction, serialized on the origin by a transaction-scoped advisory lock.
 * A write that keeps the page's own origin is not an assignment.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { opError, type OperationError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { resolveSlugForPath } from '../sync.ts';
import { sameSyncOrigin, syncOriginPath, syncOriginScope, type SyncOriginScope } from './sync-origin.ts';

export const ORIGIN_INDEX_NAME = 'pages_live_origin_key';

type Exec = Pick<BrainEngine, 'executeRaw'>;

/** The page a write targets (by id, else by slug; absent for an insert) and the origin it would record (null: it keeps its stored origin). */
export interface OriginTarget {
  sourceId: string;
  sourcePath?: string | null;
  pageId?: number | null;
  slug?: string;
  /** The write makes a soft-deleted target live again (putPage's ON CONFLICT, restorePage, a segmented flip). */
  revive?: boolean;
  /** The source's origin form when the caller has it; omitted, it is read from the source row; null skips the legacy spelling. */
  scope?: SyncOriginScope | null;
}

/** The read-only preview of the origin-twin repair, which names the page that keeps the file. */
export function originTwinsFix(sourceId: string) {
  return readFix(`Previews which page of source ${sourceId} keeps each shared origin; read-only.`, { argv: ['gbrain', 'repair', 'origin-twins', '--source', sourceId] });
}

export function originAlreadyClaimed(sourceId: string, sourcePath: string, holders: readonly string[], target?: string): OperationError {
  const held = holders.length ? `Page ${holders.join(', ')} already records` : 'Another live page already records';
  return opError('page_identity_changed', `Another live page of source ${sourceId} already records ${JSON.stringify(sourcePath)} as its origin.`,
    `${held} ${JSON.stringify(sourcePath)} in source ${sourceId}, so ${target ? `page ${target}` : 'this page'} cannot become a second page of that file; nothing was written. `
    + `Write to the page that records the file, or preview gbrain repair origin-twins --source ${sourceId} to see which page keeps it.`,
    { detail: 'origin_already_claimed', fix: originTwinsFix(sourceId) });
}

/** A reader's refusal to pick one of several live pages recording a file (`origin_conflict`). */
export function originConflictMessage(sourceId: string, sourcePath: string, slugs: readonly string[]): string {
  return `${sourcePath} is recorded by several live pages of source ${sourceId} (${slugs.join(', ')}) and none is its canonical page, so nothing was written into either. `
    + `Preview gbrain repair origin-twins --source ${sourceId}, apply the merge it proposes, then preview this repair again.`;
}

/** Whether `error` is the guard's refusal (or a mapped index violation). */
export function isOriginClaimRefusal(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { detail?: unknown }).detail === 'origin_already_claimed';
}

/** A 23505 on `pages_live_origin_key` (both engines' error shapes), as the guard's own refusal; null for anything else. */
export function classifyOriginUniqueViolation(error: unknown, at?: { sourceId: string; sourcePath: string; slug?: string }): OperationError | null {
  if (!error || typeof error !== 'object') return null;
  const e = error as Record<string, unknown>;
  if (String(e.code) !== '23505' || (e.constraint_name ?? e.constraint) !== ORIGIN_INDEX_NAME) return null;
  const key = /=\((.*), (.*)\) already exists/.exec(typeof e.detail === 'string' ? e.detail : '');
  return originAlreadyClaimed(at?.sourceId ?? key?.[1] ?? 'unknown', at?.sourcePath ?? key?.[2] ?? 'unknown', [], at?.slug);
}

function gitRootOf(path: string): string | null {
  for (let dir = resolve(path); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

/** The origin form of a source pinned to source-root slugs at a subdirectory of its repository; undefined otherwise. */
async function originScopeOf(tx: BrainEngine, sourceId: string): Promise<SyncOriginScope | undefined> {
  const source = await tx.getSource(sourceId);
  // `config->>'slug_root_mode'` of a config that is not an object (a jsonb scalar) is NULL.
  const config = source?.config, mode = config && typeof config === 'object' && !Array.isArray(config) ? (config as Record<string, unknown>).slug_root_mode : null;
  return sourceOriginScope(sourceId, source?.local_path ?? null, typeof mode === 'string' ? mode : null);
}

/** `originScopeOf` from a source's `local_path` and `config.slug_root_mode`, for a caller that already has the source row. */
export function sourceOriginScope(sourceId: string, localPath: string | null, slugRootMode: unknown): SyncOriginScope | undefined {
  if (!localPath || slugRootMode !== 'source-root' || !existsSync(localPath)) return undefined;
  const gitRoot = gitRootOf(localPath);
  return gitRoot ? syncOriginScope({ sourceId, root: localPath, gitRoot, slugMode: 'source-root' }) : undefined;
}

const originKey = (path: string) => process.platform === 'win32' ? path.replaceAll('\\', '/').toLowerCase() : path;
/** The lock key of one spelling: `syncOriginPath`'s normal form folded as `originKey` compares it (a path it refuses keeps its raw spelling). */
const lockKey = (path: string) => { try { return originKey(syncOriginPath(path)); } catch { return originKey(path); } };

/** Whether `recorded` (stored on the page `recordedSlug`) names the same file as `origin`: the same spelling, or the legacy Git-root spelling of either. */
function sameOrigin(recorded: string, recordedSlug: string | undefined, origin: string, originSlug: string | undefined, scope: SyncOriginScope | undefined): boolean {
  if (originKey(recorded) === originKey(origin)) return true;
  const prefix = scope?.slugMode === 'source-root' && scope.scope ? `${scope.scope}/` : null;
  if (!prefix) return false;
  try {
    if (originKey(recorded) === originKey(prefix + origin)) return sameSyncOrigin(recorded, origin, scope, recordedSlug);
    if (originKey(origin) === originKey(prefix + recorded)) return sameSyncOrigin(origin, recorded, scope, originSlug);
  } catch {
    return true;
  }
  return false;
}

/**
 * Refuses (`page_identity_changed`, detail `origin_already_claimed`) when the target would become a live claimant of an
 * origin another live page of its source records, in any spelling discovery reads as the same file. Runs inside the
 * caller's `engine.transaction()` and holds the origin's advisory lock until it ends, so two writers assigning one origin
 * to different pages serialize and the second sees the first.
 */
export async function assertOriginUnclaimed(tx: BrainEngine, target: OriginTarget): Promise<void> {
  if (!(tx as { _heldPageKeys?: unknown })._heldPageKeys) throw new Error('assertOriginUnclaimed requires engine.transaction(): the origin lock and the write must commit together');
  const row = await tx.readPageOrigin({ sourceId: target.sourceId, pageId: target.pageId, slug: target.slug });
  const origin = target.sourcePath ?? row?.source_path ?? null;
  if (!origin || row && row.deleted_at != null && !target.revive) return;
  const scope = target.scope === undefined ? await originScopeOf(tx, target.sourceId) : target.scope ?? undefined;
  const slug = row?.slug ?? target.slug;
  if (row && row.deleted_at == null && row.source_path != null && sameOrigin(row.source_path, row.slug, origin, slug, scope)) return;
  const prefix = scope?.slugMode === 'source-root' && scope.scope ? `${scope.scope}/` : null;
  const forms = [origin, ...(prefix ? [prefix + origin] : []), ...(prefix && origin.startsWith(prefix) ? [origin.slice(prefix.length)] : [])];
  const spellings = [...new Set(forms.map(originKey))].sort();
  const holders = (await tx.listOriginClaims(target.sourceId, spellings, { lockKeys: [...new Set(forms.map(lockKey))].sort(), excludePageId: row ? Number(row.id) : null }))
    .filter(holder => sameOrigin(holder.source_path, holder.slug, origin, slug, scope));
  if (holders.length) throw originAlreadyClaimed(target.sourceId, origin, holders.map(holder => holder.slug), slug);
}

/**
 * Records `sourcePath` as the target page's origin, guarded: the assignment statement every origin-assigning write that
 * is not a page upsert uses. `onlyIfUnset` fills a missing origin only; `liveOnly` never touches a tombstone. A page that
 * records the origin drops an `origin_twin` database-only marker (it gave an origin up to a twin and now has its own file
 * again). Returns the number of rows whose origin changed.
 */
export async function bindOrigin(tx: BrainEngine, target: OriginTarget & { sourcePath: string; onlyIfUnset?: boolean; liveOnly?: boolean }): Promise<number> {
  await assertOriginUnclaimed(tx, target);
  try {
    return await tx.bindPageOrigin({ sourceId: target.sourceId, pageId: target.pageId, slug: target.slug, sourcePath: target.sourcePath,
      onlyIfUnset: target.onlyIfUnset, liveOnly: target.liveOnly });
  } catch (error) {
    throw classifyOriginUniqueViolation(error, target) ?? error;
  }
}

/** Every soft-deleted page `restorePage(slug, opts)` would revive, guarded (a restore without a source revives the slug in every source). */
export async function assertRevivalUnclaimed(tx: BrainEngine, slug: string, sourceId?: string): Promise<void> {
  const rows = await tx.listRevivalPages(slug, sourceId ?? null);
  for (const row of rows) await assertOriginUnclaimed(tx, { sourceId: row.source_id, pageId: Number(row.id), revive: true });
}

/**
 * Of the live pages recording one origin, the one a reader or a repair may act on: the only one, else the one whose slug
 * is the file's derived slug (`resolveSlugForPath`); several with none canonical are `{ ambiguous }` (never written into).
 */
export function pickCanonicalOrigin<T extends { slug: string }>(pages: readonly T[], sourcePath: string): T | { ambiguous: string[] } | null {
  if (pages.length <= 1) return pages[0] ?? null;
  const derived = resolveSlugForPath(sourcePath);
  const canonical = pages.filter(page => page.slug === derived);
  return canonical.length === 1 ? canonical[0]! : { ambiguous: pages.map(page => page.slug).sort() };
}

export async function canonicalOriginPage(engine: Pick<BrainEngine, 'listLiveOriginPages' | 'listOriginClaimants'>, sourceId: string, sourcePath: string): Promise<{ id: number; slug: string } | { ambiguous: string[] } | null> {
  // Typed reads (the live pages recording the origin, then their slugs); the slug order never reaches output: pickCanonicalOrigin sorts the ambiguous slugs itself and a single row has no order.
  const live = await engine.listLiveOriginPages(sourceId, [sourcePath]);
  if (!live.length) return null;
  const claimants = await engine.listOriginClaimants(sourceId, live.map(page => page.id));
  return pickCanonicalOrigin(claimants.map(row => ({ id: Number(row.id), slug: row.slug })).sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)), sourcePath);
}
