/**
 * #6712 PR 4b (design v3.2 §2.5, §2.6): the deletion marker of a managed Git source's origin, and the source-level
 * record of a withheld mass delete. Both are `op_checkpoints` rows whose value carries `source_id` and `incarnation`,
 * so the checkpoint GC keeps them while the incarnation lives (`op-checkpoint.ts`).
 *
 * - `sync-origin-deleted`, fingerprint `<source>:<incarnation>:<origin>`: written by `writeOriginDeletedMarker` in
 *   the transaction of every page-row deletion of a managed Git source (`page-purge.ts`, the belief purge-mirror
 *   replay), only when it can matter: the origin is in the source's `last_commit` tree or a file backs it on disk.
 *   The classifier reads it (`sync-pass.ts` `readMarkers`: `kind`, `blob_oids`), so a purged page's unchanged file
 *   settles `deleted_same` and a changed one is held, never imported as a new page. A full round retires it by
 *   compare-and-delete (`retireOriginDeletedMarker`) when the origin is independently absent from the pinned tree
 *   and the disk, or a live page claims the origin again.
 * - `sync-deletes-withheld`, fingerprint `<source>:<incarnation>`: a round's tripped mass-delete valve (#2828),
 *   refreshed each pass while the trip lasts and cleared when it clears.
 */
import { realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { hardenedGitSync } from '../hardened-git.ts';
import { companyBrainProfile } from '../company-brain/policy.ts';
import { sha256 } from './digest.ts';
import { faultPoint } from './fault-points.ts';
import { getWorktreeBinding, managedPersistenceEnabled } from './ownership.ts';
import { readSyncFile } from './sync-discovery.ts';
import { readSyncImportProvenance } from './sync-holds.ts';
import { syncOriginPath } from './sync-origin.ts';
import type { SyncDeleteCaps, SyncDeleteTrip } from '../sync-reconcile.ts';
import { SYNC_DELETES_WITHHELD_OP, SYNC_ORIGIN_DELETED_OP, passFingerprint } from './sync-pass-row.ts';

type Exec = Pick<BrainEngine, 'executeRaw'>;

export interface OriginDeletedMarker {
  source_id: string;
  incarnation: string;
  kind: 'deleted';
  /** The blob ids the brain held for the origin (the import record's `blob_oid` and `disk_blob_oid`); empty without a record, so every level differs (fail closed). */
  blob_oids: string[];
  page_id: number;
  slug: string;
  at: string;
}

export const originMarkerFingerprint = (sourceId: string, incarnation: string, origin: string) => `${sourceId}:${incarnation}:${syncOriginPath(origin)}`;

/** Bounds of the `ls-tree` read that decides whether the purged origin is still committed. */
const TREE_READ_LIMITS = { timeoutMs: 10_000, maxBytes: 1024 * 1024 };

/**
 * Whether the marker can matter: the origin is in the `last_commit` tree, or a file backs it on disk. Every read that
 * cannot answer counts as present (fail closed), so an unreadable checkout or tree writes the marker.
 */
function originStillBacked(root: string | null, lastCommit: string | null, slugMode: string | null, sourcePath: string): boolean {
  const origin = originGitPaths(root, slugMode, sourcePath);
  if (!origin) return true;
  for (const gitPath of origin.candidates) {
    try { if (readSyncFile(root!, origin.scope ? gitPath.slice(origin.scope.length + 1) : gitPath) !== null) return true; } catch { return true; }
  }
  return originInTree(origin, lastCommit);
}

/** The Git paths `sourcePath` may have in `root`'s repository, or null when the checkout cannot be read. */
function originGitPaths(root: string | null, slugMode: string | null, sourcePath: string): { gitRoot: string; scope: string; candidates: Set<string> } | null {
  if (!root) return null;
  const toplevel = hardenedGitSync(root, ['rev-parse', '--show-toplevel'], { timeoutMs: 10_000, maxBytes: 4096 });
  if (!toplevel.ok) return null;
  const gitRoot = toplevel.stdout.toString('utf8').trim();
  let scope: string;
  try { scope = relative(realpathSync.native(gitRoot), realpathSync.native(root)).split(sep).join('/'); } catch { return null; }
  if (scope.startsWith('..')) return null;
  const candidates = new Set<string>();
  if (slugMode !== 'git-root') candidates.add(scope ? `${scope}/${sourcePath}` : sourcePath);
  if (slugMode !== 'source-root' && (!scope || sourcePath.startsWith(`${scope}/`))) candidates.add(sourcePath);
  return { gitRoot, scope, candidates };
}

/** Whether one of the origin's paths is in `lastCommit`'s tree; a tree that cannot be read counts as present. */
function originInTree(origin: { gitRoot: string; candidates: Set<string> }, lastCommit: string | null): boolean {
  if (!lastCommit || origin.candidates.size === 0) return false;
  const tree = hardenedGitSync(origin.gitRoot, ['ls-tree', '-z', '--full-tree', lastCommit, '--', ...origin.candidates], TREE_READ_LIMITS);
  return !tree.ok || tree.stdout.length > 0;
}

/**
 * GST-2201: whether a page's file is committed at its source's `last_commit` or at the checkout's HEAD (a commit sync has not
 * read yet), so a retention purge must not remove it. False on an unmanaged brain, for a source with no worktree binding (a
 * repo-less brain), a company-brain source or a checkout with no commit yet; a checkout or tree that cannot be read counts as committed (fail closed: the
 * file stays).
 */
export async function originCommitted(engine: BrainEngine, sourceId: string, sourcePath: string | null | undefined): Promise<boolean> {
  if (!sourcePath || !await managedPersistenceEnabled(engine)) return false;
  const [source] = await engine.executeRaw<{ last_commit: string | null; config: Record<string, unknown> | null }>('SELECT last_commit, config FROM sources WHERE id=$1', [sourceId]);
  if (!source || companyBrainProfile(source.config) !== null) return false;
  const binding = await getWorktreeBinding(engine, sourceId);
  if (!binding) return false;
  const root = binding.local_path ? resolve(binding.local_path, binding.relative_path) : null;
  const origin = originGitPaths(root, typeof source.config?.slug_root_mode === 'string' ? source.config.slug_root_mode : null, sourcePath);
  if (!origin) return true;
  if (originInTree(origin, source.last_commit)) return true;
  const head = hardenedGitSync(origin.gitRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], TREE_READ_LIMITS);
  if (!head.ok) return !(head.reason === 'exit' && head.status === 1);
  return originInTree(origin, head.stdout.toString('utf8').trim());
}

/**
 * Writes the deletion marker of `page`'s origin inside `tx`, the transaction that deletes the page row (call it before
 * the delete). Writes nothing on an unmanaged brain, for a page without an origin, while another live page records the
 * origin (a shared origin, #6517: the live page owns it), for a source without a worktree binding or a company-brain
 * source (its frozen manifest decides), or when the origin left both `last_commit` and the disk. Returns the marker
 * written, or null.
 */
export async function writeOriginDeletedMarker(tx: BrainEngine, input: { sourceId: string; page: { id: number; slug: string; source_path?: string | null } }):
  Promise<OriginDeletedMarker | null> {
  const { sourceId, page } = input;
  if (!page.source_path) return null;
  let origin: string;
  try { origin = syncOriginPath(page.source_path); } catch { return null; }
  if (!await managedPersistenceEnabled(tx)) return null;
  const [owned] = await tx.executeRaw('SELECT 1 FROM pages WHERE source_id=$1 AND id<>$2 AND deleted_at IS NULL AND source_path = ANY($3::text[]) LIMIT 1',
    [sourceId, page.id, [...new Set([page.source_path, origin, `./${origin}`])]]);
  if (owned) return null;
  const [source] = await tx.executeRaw<{ incarnation: string; last_commit: string | null; config: Record<string, unknown> | null }>(
    'SELECT incarnation::text AS incarnation, last_commit, config FROM sources WHERE id=$1', [sourceId]);
  if (!source || companyBrainProfile(source.config) !== null) return null;
  const binding = await getWorktreeBinding(tx, sourceId);
  if (!binding) return null;
  const root = binding.local_path ? resolve(binding.local_path, binding.relative_path) : null;
  const slugMode = typeof source.config?.slug_root_mode === 'string' ? source.config.slug_root_mode : null;
  if (!originStillBacked(root, source.last_commit, slugMode, page.source_path)) return null;
  const record = await readSyncImportProvenance(tx, sourceId, source.incarnation, page.id);
  const marker: OriginDeletedMarker = {
    source_id: sourceId, incarnation: source.incarnation, kind: 'deleted',
    blob_oids: [...new Set([record?.blob_oid, record?.disk_blob_oid].filter((oid): oid is string => typeof oid === 'string' && oid.length > 0))],
    page_id: page.id, slug: page.slug, at: new Date().toISOString(),
  };
  await tx.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at) VALUES($1,$2,jsonb_build_array($3::text::jsonb),now())
    ON CONFLICT (op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys, updated_at=now()`,
  [SYNC_ORIGIN_DELETED_OP, originMarkerFingerprint(sourceId, source.incarnation, origin), JSON.stringify(marker)]);
  await faultPoint('purge:marker_written', { sourceId, slug: page.slug, path: origin });
  return marker;
}

/** The deletion marker at one origin of an incarnation, or null. */
export async function readOriginDeletedMarker(exec: Exec, sourceId: string, incarnation: string, origin: string): Promise<OriginDeletedMarker | null> {
  const [row] = await exec.executeRaw<{ value: OriginDeletedMarker | null }>('SELECT completed_keys->0 AS value FROM op_checkpoints WHERE op=$1 AND fingerprint=$2',
    [SYNC_ORIGIN_DELETED_OP, originMarkerFingerprint(sourceId, incarnation, origin)]);
  return row?.value ?? null;
}

/**
 * Retires a marker by compare-and-delete on the value the pass read: a marker rewritten since (another purge at the
 * same origin) stays. Returns whether it was deleted.
 */
export async function retireOriginDeletedMarker(tx: Exec, input: { sourceId: string; incarnation: string; origin: string; expected: unknown }): Promise<boolean> {
  const rows = await tx.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2 AND completed_keys->0 = $3::text::jsonb RETURNING 1',
    [SYNC_ORIGIN_DELETED_OP, originMarkerFingerprint(input.sourceId, input.incarnation, input.origin), JSON.stringify(input.expected)]);
  return rows.length > 0;
}

/** The sample paths a withheld record keeps. */
export const DELETES_WITHHELD_SAMPLES = 20;

export interface DeletesWithheld {
  source_id: string;
  incarnation: string;
  /** The pinned commit of the round that tripped the valve. */
  target: string;
  count: number;
  /** The valve's denominator: live file-backed pages whose origin is eligible. */
  reconcilable: number;
  ratio: number;
  /** `deleteSetHash` of the withheld paths: the record matches a later trip only while the set is the same. */
  set_hash: string;
  samples: string[];
  /** #7130: the limit the set went over (absent on a record written before the caps: the 50% valve). */
  trip?: SyncDeleteTrip;
  caps?: SyncDeleteCaps;
  at: string;
}

/** sha256 (hex) over the set of paths, sorted and joined with NUL. */
export function deleteSetHash(paths: Iterable<string>): string {
  return sha256([...new Set(paths)].sort().join('\0'));
}

/** Writes (or refreshes) the source's withheld mass-delete record inside `tx`; keeps the first `DELETES_WITHHELD_SAMPLES` samples. */
export async function writeDeletesWithheld(tx: Exec, input: { sourceId: string; incarnation: string; target: string; count: number; reconcilable: number; ratio: number;
  set_hash: string; samples: readonly string[]; trip?: SyncDeleteTrip; caps?: SyncDeleteCaps }): Promise<DeletesWithheld> {
  const value: DeletesWithheld = { source_id: input.sourceId, incarnation: input.incarnation, target: input.target, count: input.count, reconcilable: input.reconcilable,
    ratio: input.ratio, set_hash: input.set_hash, samples: input.samples.slice(0, DELETES_WITHHELD_SAMPLES), ...(input.trip ? { trip: input.trip } : {}), ...(input.caps ? { caps: input.caps } : {}), at: new Date().toISOString() };
  await tx.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at) VALUES($1,$2,jsonb_build_array($3::text::jsonb),now())
    ON CONFLICT (op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys, updated_at=now()`,
  [SYNC_DELETES_WITHHELD_OP, passFingerprint(input.sourceId, input.incarnation), JSON.stringify(value)]);
  return value;
}

export async function readDeletesWithheld(exec: Exec, sourceId: string, incarnation: string): Promise<DeletesWithheld | null> {
  const [row] = await exec.executeRaw<{ value: DeletesWithheld | null }>('SELECT completed_keys->0 AS value FROM op_checkpoints WHERE op=$1 AND fingerprint=$2',
    [SYNC_DELETES_WITHHELD_OP, passFingerprint(sourceId, incarnation)]);
  return row?.value ?? null;
}

/** Deletes the source's withheld record (the trip cleared); returns whether one existed. */
export async function clearDeletesWithheld(tx: Exec, sourceId: string, incarnation: string): Promise<boolean> {
  return (await tx.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2 RETURNING 1',
    [SYNC_DELETES_WITHHELD_OP, passFingerprint(sourceId, incarnation)])).length > 0;
}
