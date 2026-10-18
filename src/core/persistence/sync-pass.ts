/**
 * #6712 PR 4a (design v3.2 §2.1-§2.2, §11 step 2): the read-only shadow of the level-triggered managed-sync pass.
 * It reads the level of one managed source and classifies every path of its domain with sync-classify.ts, and writes
 * and admits nothing: no hold, marker, record, pass row, cursor or request. `gbrain sync --dry-run --json` and
 * `gbrain sync status --detail --json` report the result as `convergence` (sync-convergence.ts); PR 4b turns the same
 * reads into the pass.
 *
 * Reads (each timed in `timings_ms`, with `context`, `setup` and the rest of the round): `T` (`ls-tree -r -z` at HEAD,
 * complete or refused), `X` (the index), `U` (working mode: untracked files), `Dp` (committed mode: candidates only;
 * working mode: every path, the full-round rehash), and the database: `I⋈P` (pages of the source with their import
 * records), `H` (holds and retry rows), `U_db` (open requests and pending Git effects), deletion markers, and `A` (the
 * attestation of the current revision) for the pages whose class needs a proof. The Git reads, the database snapshot and
 * the holds run concurrently (`reads` is their wall time). On Postgres the snapshot reads share one `REPEATABLE READ,
 * READ ONLY` transaction and `I⋈P` is one set-based statement; PGLite admits one transaction at a time, so there
 * they run as bounded statements of at most 2,000 rows with writers between them.
 */
import { realpathSync } from 'node:fs';
import { relative, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { hardenedGitStream, hardenedGitSync, hardenedStreamComplete, NulRecordSplitter } from '../hardened-git.ts';
import { matchesAnyGlob, isSyncable } from '../sync.ts';
import { isReservedSkillBundlePath } from '../skill-reserved-paths.ts';
import { resolveSlugRootMode } from '../sync-anchor.ts';
import { resolveSlugForPath } from '../sync.ts';
import { join } from 'node:path';
import { isKeepDbSlug, loadStorageConfig } from '../storage-config.ts';
import { loadActivePackForEngine } from '../schema-pack/engine-resolution.ts';
import { currentCompanyBrainSync, getCompanyBrainProfile } from '../company-brain/profile.ts';
import { sha256 } from './digest.ts';
import { sourceMirrorReadOnly } from './mirror-read-only.ts';
import { readSyncFile, resolveManagedSyncContext, syncExcludePatterns, syncGit, type ManagedSyncContext } from './sync-discovery.ts';
import { holdBasisMoved, holdRescreenDue, readGitHoldRetryPaths, readGitSourceHolds, SYNC_IMPORT_PROVENANCE_OP, syncImportParserFor,
  type GitHoldRecord, type SyncImportProvenance } from './sync-holds.ts';
import { movedDriftHolds, sameParser } from './sync-prescreen.ts';
import { syncOriginPath } from './sync-origin.ts';
import { probeDirtiness, readBlobs, readIndexLevel, readTreeLevel, type GitTreeEntry } from './sync-git-stream.ts';
import { classifySyncPath, syncPassKind, type SyncClassified, type SyncIdleBlocker, type SyncPathState } from './sync-classify.ts';
import { buildConvergenceReceipt, readOnlySameContentScreen, type ConvergenceReceipt, type ConvergenceScreen } from './sync-convergence.ts';
import { readManagedMode } from './ownership.ts';

/** The deletion marker op PR 4b writes in every page-row deletion (design v3.2 §2.5); PR 4a only reads it. */
export const SYNC_ORIGIN_DELETED_OP = 'sync-origin-deleted';
/** The pass row PR 4b writes (design v3.2 §3.4); PR 4a only reads it, so a shadow pass is always a full round. */
export const MANAGED_SYNC_PASS_OP = 'managed-sync-pass';
/** PGLite's keyset page size (design v3.2 §2.1); Postgres reads `I⋈P` in one statement of its snapshot. */
const PGLITE_KEYSET_ROWS = 2_000;
/** Blob bytes read for adoption by hash and the screen, per blob. */
const LEVEL_BLOB_MAX_BYTES = 8 * 1024 * 1024;
const SYNC_WRITE_KINDS = ['managed_sync_import', 'managed_sync_delete'];

/** One classified path of the shadow level. */
export interface ShadowPath { path: string; slug: string | null; pageId: number | null; revision: string | null; state: SyncPathState; result: SyncClassified;
  /** A page-less path whose file is unchanged since the baseline: PR 4b's bootstrap writes it a `legacy` marker (`legacy_pageless`). */
  legacyPageless?: true }

export interface ShadowLevel {
  sourceId: string; incarnation: string; root: string; gitRoot: string; scope: string; slugMode: 'git-root' | 'source-root';
  mode: 'committed' | 'working'; head: string; baselineCommit: string | null; full: boolean;
  kind: 'idle' | 'hold_only' | 'full'; kindBlockers: SyncIdleBlocker[];
  paths: ShadowPath[];
  /** Live file-backed pages whose origin is eligible: the mass-delete valve's denominator (#2828). */
  reconcilable: number;
  timings_ms: Record<string, number>;
  statements: number;
}

/** A page of the source with the import-record fields the classifier reads; `arm1` / `attested_hash` (`A`) are filled for the pages that need a proof. */
interface PageRow { id: number | string; slug: string; source_path: string; revision: string; deleted: boolean; request_id: string | null;
  record: Pick<SyncImportProvenance, 'origin' | 'blob_oid' | 'disk_blob_oid' | 'revision' | 'parser'> | null; arm1: boolean | null; attested_hash: string | null }

const recordOids = (record: PageRow['record']): string[] =>
  record ? [record.blob_oid, record.disk_blob_oid].filter((oid): oid is string => typeof oid === 'string' && oid.length > 0) : [];

type Exec = Pick<BrainEngine, 'executeRaw'>;

/**
 * Runs `fn` over the round's database reads: one `REPEATABLE READ, READ ONLY` snapshot on Postgres; on PGLite (one
 * connection, one transaction at a time) each statement runs on its own so writers and lease renewals interleave.
 */
async function withRoundSnapshot<T>(engine: BrainEngine, fn: (exec: Exec) => Promise<T>): Promise<T> {
  if (engine.kind === 'pglite') return fn(engine);
  return engine.transaction(async tx => {
    await tx.executeRaw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    return fn(tx);
  });
}

/**
 * `I⋈P`: every page of the source with a recorded origin and the fields of its import record the classifier reads. Postgres
 * reads it as one set-based statement inside the round's snapshot (the planner hash-joins pages with their records; a
 * keyset with a per-row primary-key probe made the 61k read plan-bound, about 1.7 s of server time); PGLite reads bounded
 * keyset statements so writers interleave.
 */
async function readPages(exec: Exec, kind: 'postgres' | 'pglite', sourceId: string, incarnation: string): Promise<{ rows: PageRow[]; statements: number }> {
  const select = `SELECT p.id, p.slug, p.source_path, p.knowledge_revision::text AS revision, p.deleted_at IS NOT NULL AS deleted,
      p.revision_write_request_id::text AS request_id,
      c.completed_keys IS NOT NULL AS has_record, c.completed_keys->0->>'origin' AS rec_origin, c.completed_keys->0->>'blob_oid' AS rec_blob_oid,
      c.completed_keys->0->>'disk_blob_oid' AS rec_disk_blob_oid, c.completed_keys->0->>'revision' AS rec_revision, c.completed_keys->0->'parser' AS rec_parser
    FROM pages p LEFT JOIN op_checkpoints c ON c.op=$2 AND c.fingerprint=$3||p.id::text
    WHERE p.source_id=$1 AND p.source_path IS NOT NULL`;
  const params = [sourceId, SYNC_IMPORT_PROVENANCE_OP, `${sourceId}:${incarnation}:`];
  type Raw = Omit<PageRow, 'record' | 'arm1' | 'attested_hash'> & { has_record: boolean; rec_origin: string | null; rec_blob_oid: string | null;
    rec_disk_blob_oid: string | null; rec_revision: string | null; rec_parser: SyncImportProvenance['parser'] | null };
  const rows: PageRow[] = [];
  const take = (page: Raw[]) => { for (const { has_record, rec_origin, rec_blob_oid, rec_disk_blob_oid, rec_revision, rec_parser, ...row } of page) rows.push({ ...row, arm1: null, attested_hash: null,
    record: has_record ? { origin: rec_origin ?? '', blob_oid: rec_blob_oid ?? undefined, disk_blob_oid: rec_disk_blob_oid, revision: rec_revision ?? undefined, parser: rec_parser ?? undefined } : null }); };
  if (kind === 'postgres') { take(await exec.executeRaw<Raw>(select, params)); return { rows, statements: 1 }; }
  let after = 0, statements = 0;
  for (;;) {
    statements++;
    const page = await exec.executeRaw<Raw>(`${select} AND p.id>$4 ORDER BY p.id LIMIT ${PGLITE_KEYSET_ROWS}`, [...params, after]);
    take(page);
    if (page.length < PGLITE_KEYSET_ROWS) return { rows, statements };
    after = Number(page[page.length - 1]!.id);
  }
}

/**
 * `A` for the given pages: whether the page's current revision came from a committed sync write of this incarnation (arm 1)
 * and the hash its Git effect expects. A committed request and its effect never change, so this reads by the request id
 * the snapshot returned, after the level is known; the answer is the one the snapshot would have given.
 */
async function readAttestations(exec: Exec, kind: 'postgres' | 'pglite', sourceId: string, incarnation: string, rows: PageRow[]): Promise<number> {
  const size = kind === 'postgres' ? 10_000 : PGLITE_KEYSET_ROWS;
  const byId = new Map(rows.map(row => [Number(row.id), row]));
  let statements = 0;
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    statements++;
    const found = await exec.executeRaw<{ page_id: number; arm1: boolean; attested_hash: string | null }>(`SELECT x.page_id,
        (r.intent->>'kind' = ANY($3::text[]) AND r.source_incarnation::text=$2 AND (r.page_id IS NULL OR r.page_id=x.page_id)) AS arm1,
        (SELECT e.data->>'expected_hash' FROM persistence_effects e WHERE e.request_id=r.id AND e.kind='git' AND e.revision=x.revision
          AND e.data->>'expected_hash' IS NOT NULL AND (e.data->>'relative_path'=x.source_path OR right(e.data->>'relative_path', length(x.source_path)+1)='/'||x.source_path) LIMIT 1) AS attested_hash
      FROM unnest($4::int[], $5::uuid[], $6::uuid[], $7::text[]) AS x(page_id, request_id, revision, source_path)
      JOIN persistence_requests r ON r.id=x.request_id AND r.state='committed' AND r.source_id=$1`,
      [sourceId, incarnation, SYNC_WRITE_KINDS, chunk.map(row => Number(row.id)), chunk.map(row => row.request_id), chunk.map(row => row.revision), chunk.map(row => row.source_path)]);
    for (const hit of found) Object.assign(byId.get(Number(hit.page_id))!, { arm1: hit.arm1, attested_hash: hit.attested_hash });
  }
  return statements;
}

/**
 * `U_db`: open requests of the worktree (the `persistence_requests_pending` index) and of the source incarnation with no
 * worktree (a write-through-off put_page, page-mutations.ts; `persistence_requests_database_pending`), and pending Git
 * effects of the source.
 */
async function readOpenWork(exec: Exec, sourceId: string, worktreeId: string, incarnation: string): Promise<{ pageIds: Set<number>; origins: Set<string>; statements: number }> {
  const [requests, effects] = await Promise.all([exec.executeRaw<{ page_id: number | null; source_path: string | null; path: string | null }>(`SELECT page_id, intent->>'sourcePath' AS source_path, intent->>'path' AS path
    FROM persistence_requests WHERE (worktree_id=$1 OR (worktree_id IS NULL AND source_incarnation=$3::uuid)) AND state IN ('queued','running','recovering') AND source_id=$2`,
    [worktreeId, sourceId, incarnation]),
  exec.executeRaw<{ page_id: number | null; path: string | null }>(`SELECT r.page_id, e.data->>'relative_path' AS path
    FROM persistence_requests r JOIN persistence_effects e ON e.request_id=r.id
    WHERE r.worktree_id=$1 AND r.source_id=$2 AND e.kind='git' AND e.state IN ('queued','running')`, [worktreeId, sourceId])]);
  const pageIds = new Set<number>(), origins = new Set<string>();
  for (const row of [...requests, ...effects]) if (row.page_id != null) pageIds.add(Number(row.page_id));
  for (const row of requests) for (const origin of [row.source_path, row.path]) if (origin) origins.add(syncOriginPath(origin));
  for (const row of effects) if (row.path) origins.add(syncOriginPath(row.path));
  return { pageIds, origins, statements: 2 };
}

/** Deletion markers of the incarnation (a primary-key range read); none exist before PR 4b. */
async function readMarkers(exec: Exec, sourceId: string, incarnation: string): Promise<Map<string, { kind: 'deleted' | 'legacy'; blobOids: string[] }>> {
  const prefix = `${sourceId}:${incarnation}:`;
  // `starts_with`, not a range: under a linguistic collation (en_US) a `< prefix || U+FFFF` bound matches nothing.
  const rows = await exec.executeRaw<{ fingerprint: string; value: { kind?: string; blob_oids?: unknown } | null }>(
    'SELECT fingerprint, completed_keys->0 AS value FROM op_checkpoints WHERE op=$1 AND starts_with(fingerprint, $2)',
    [SYNC_ORIGIN_DELETED_OP, prefix]);
  return new Map(rows.map(row => [syncOriginPath(row.fingerprint.slice(prefix.length)), {
    kind: row.value?.kind === 'legacy' ? 'legacy' as const : 'deleted' as const,
    blobOids: Array.isArray(row.value?.blob_oids) ? (row.value!.blob_oids as unknown[]).filter((oid): oid is string => typeof oid === 'string') : [] }]));
}

/** The pass row of the incarnation (PR 4b writes it); null in PR 4a. */
async function readPassRow(exec: Exec, sourceId: string, incarnation: string): Promise<Record<string, unknown> | null> {
  const [row] = await exec.executeRaw<{ value: Record<string, unknown> | null }>('SELECT completed_keys->0 AS value FROM op_checkpoints WHERE op=$1 AND fingerprint=$2',
    [MANAGED_SYNC_PASS_OP, `${sourceId}:${incarnation}`]);
  return row?.value ?? null;
}

function revParse(gitRoot: string, rev: string): string | null {
  const out = hardenedGitSync(gitRoot, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { timeoutMs: 10_000, maxBytes: 4096 });
  return out.ok ? out.stdout.toString('utf8').trim() || null : null;
}

/** Working mode's `U`: untracked, not ignored files (index and exclude files only; no worktree conversion). */
async function readUntracked(gitRoot: string, scope: string): Promise<string[]> {
  const paths: string[] = [];
  const splitter = new NulRecordSplitter();
  const result = await hardenedGitStream(gitRoot, ['ls-files', '-z', '--others', '--exclude-standard', '--', scope === '' ? '.' : scope],
    { timeoutMs: 120_000, onChunk: chunk => { for (const record of splitter.push(chunk)) paths.push(record.toString('utf8')); } });
  if (!hardenedStreamComplete(result) || !splitter.atRecordBoundary) throw new Error('git ls-files --others did not finish a complete read');
  return paths;
}

const timer = () => { const started = performance.now(); return () => Math.round((performance.now() - started) * 10) / 10; };

/**
 * The shadow level of a managed source: every path classified, nothing written. Null for a company-brain source, which
 * keeps its frozen manifest (design v3.2 §3.6).
 */
export async function readShadowLevel(engine: BrainEngine, input: { sourceId: string; full?: boolean; workingTree?: boolean; context?: ManagedSyncContext }): Promise<ShadowLevel | null> {
  const total = timer();
  const timings: Record<string, number> = {};
  let t = timer();
  const context = input.context ?? await resolveManagedSyncContext(engine, { sourceId: input.sourceId, noPull: true, dryRun: true });
  timings.context = t();
  const { sourceId, incarnation, root, gitRoot } = context;
  const engineKind = engine.kind === 'pglite' ? 'pglite' : 'postgres';
  const nativeRoot = realpathSync.native(root), nativeGitRoot = realpathSync.native(gitRoot);
  const scope = relative(nativeGitRoot, nativeRoot).split(sep).join('/');
  // The setup reads are independent: one round trip each, all in flight together.
  t = timer();
  const [company, slugModeRead, excludeRead, includeHiddenRead, workingRead, packRead, mirrorRead] = await Promise.allSettled([
    currentCompanyBrainSync(sourceId) ? Promise.resolve(true) : getCompanyBrainProfile(engine, sourceId).then(profile => !!profile),
    scope ? resolveSlugRootMode(engine, { sourceId, explicitGitRoot: false, slugPrefix: resolveSlugForPath(join(scope, 'x.md')).slice(0, -2), dryRun: true }) : Promise.resolve('git-root' as const),
    syncExcludePatterns(engine),
    engine.getConfig('sync.include_hidden'),
    input.workingTree === undefined ? engine.getConfig('sync.include_working_tree') : Promise.resolve(null),
    loadActivePackForEngine(engine, { remote: false, sourceId }).catch(() => null),
    sourceMirrorReadOnly(engine, sourceId),
  ]);
  timings.setup = t();
  const settled = <T>(read: PromiseSettledResult<T>): T => { if (read.status === 'rejected') throw read.reason; return read.value; };
  if (settled(company)) return null;
  const slugMode = settled(slugModeRead), exclude = settled(excludeRead), pack = settled(packRead), mirror = settled(mirrorRead);
  const strategy = (context.source.config?.strategy as string | undefined) ?? 'markdown';
  const includeHidden = [...new Set((settled(includeHiddenRead) ?? '').split(/[\n,]/).map(v => v.trim()).filter(Boolean).map(v => v.endsWith('/') ? `${v}**` : v))];
  const keepDbPrefixes = (() => { try { return loadStorageConfig(root)?.keep_db ?? []; } catch { return []; } })();
  const sourceRelative = (gitPath: string) => (scope ? gitPath.slice(scope.length + 1) : gitPath);
  // Pure per path and asked several times per path in a round, so each is computed once.
  const memo = <T>(fn: (path: string) => T) => { const seen = new Map<string, T>(); return (path: string): T => { let value = seen.get(path); if (value === undefined && !seen.has(path)) seen.set(path, value = fn(path)); return value as T; }; };
  const eligible = memo((gitPath: string) => (!scope || gitPath.startsWith(`${scope}/`)) && !matchesAnyGlob(sourceRelative(gitPath), exclude)
    && !isReservedSkillBundlePath(slugMode === 'source-root' ? sourceRelative(gitPath) : gitPath) && isSyncable(gitPath, { strategy: strategy as 'markdown', includeHidden }));
  const originPath = memo((path: string) => syncOriginPath(path));
  const originOf = memo((gitPath: string) => originPath(slugMode === 'source-root' && scope ? sourceRelative(gitPath) : gitPath));
  const gitPathOf = memo((origin: string) => { const o = originPath(origin); return slugMode === 'source-root' && scope ? `${scope}/${o}` : o; });

  t = timer();
  const head = revParse(gitRoot, 'HEAD');
  if (!head) throw new Error(`source ${sourceId}: HEAD does not name a commit, so there is no level to read`);
  // Master's rule (sync-discovery.ts): a detached HEAD forces working mode.
  const detached = syncGit(gitRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() === 'HEAD';
  const working = detached || (input.workingTree ?? settled(workingRead) === 'true');
  const mode: 'committed' | 'working' = working ? 'working' : 'committed';
  timings.rev_parse = t();

  // The Git level, the database snapshot and the holds are independent reads: they overlap, so each key times its own
  // read and `reads` is the wall time of the three together.
  const timed = async <T>(key: string, read: () => Promise<T>): Promise<T> => { const st = timer(); try { return await read(); } finally { timings[key] = st(); } };
  t = timer();
  const [gitLevel, snapshot, held] = await Promise.all([
    Promise.all([timed('T', () => readTreeLevel(gitRoot, head, scope)), timed('X', () => readIndexLevel(gitRoot)),
      timed('U', async () => (mode === 'working' ? (await readUntracked(gitRoot, scope)).filter(eligible) : []))]),
    // Issued together, the snapshot's statements pipeline on its one connection (PGLite runs them in turn).
    timed('I⋈P', () => withRoundSnapshot(engine, async exec => {
      const [read, work, markers, passRow] = await Promise.all([timed('pages', () => readPages(exec, engineKind, sourceId, incarnation)),
        timed('open_work', () => readOpenWork(exec, sourceId, context.binding.worktree_id, incarnation)), timed('markers', () => readMarkers(exec, sourceId, incarnation)),
        timed('pass_row', () => readPassRow(exec, sourceId, incarnation))]);
      return { pages: read.rows, open: work, markers, passRow, statements: read.statements + work.statements + 2 };
    })),
    timed('H', async () => {
      const [sourceHolds, retryPaths] = await Promise.all([readGitSourceHolds(engine, { sourceIds: [sourceId] }), readGitHoldRetryPaths(engine, sourceId, incarnation)]);
      const holds = (sourceHolds[0]?.holds ?? []).filter(hold => hold.incarnation === incarnation);
      const holdByPath = new Map(holds.map(hold => [hold.path, hold]));
      const [basisMoved, driftMoved] = await Promise.all([holdBasisMoved(engine, sourceId, holdByPath, [...holdByPath.keys()]), movedDriftHolds(engine, sourceId, holds)]);
      return { holds, retry: new Set(retryPaths), moved: [...basisMoved, ...driftMoved] };
    }),
  ]);
  timings.reads = t();
  const [treeAll, index, untrackedPaths] = gitLevel;
  const tree = new Map<string, GitTreeEntry>([...treeAll].filter(([path]) => eligible(path)));
  const untracked = new Set(untrackedPaths);
  const { pages, open, markers, passRow, statements } = snapshot;
  const { holds, retry } = held;
  const toGit = (holdPath: string) => (scope ? `${scope}/${holdPath}` : holdPath);
  const holdByGitPath = new Map<string, GitHoldRecord>(holds.map(hold => [toGit(hold.path), hold]));
  const moved = new Set(held.moved.map(toGit));

  // The page claiming each origin: the live one first, else the newest tombstone.
  t = timer();
  const byOrigin = new Map<string, PageRow>();
  for (const row of pages) {
    const key = gitPathOf(row.source_path);
    const prior = byOrigin.get(key);
    if (!prior || (prior.deleted && !row.deleted) || (prior.deleted === row.deleted && Number(row.id) > Number(prior.id))) byOrigin.set(key, row);
  }
  const domain = new Set<string>([...tree.keys(), ...untracked, ...(mode === 'working' ? [...index.keys()].filter(eligible) : []), ...[...byOrigin.keys()].filter(eligible), ...[...markers.keys()].map(gitPathOf).filter(eligible)]);
  // Spellings of one origin that differ only by case or separator: the domain holds each path once, so a count is enough.
  const fold = (path: string) => path.replaceAll('\\', '/').toLowerCase();
  const spellings = new Map<string, number>();
  for (const path of domain) {
    const live = byOrigin.get(path);
    if (!tree.has(path) && !(live && !live.deleted)) continue;
    const folded = fold(path);
    spellings.set(folded, (spellings.get(folded) ?? 0) + 1);
  }
  const reconcilable = [...byOrigin.entries()].filter(([path, row]) => !row.deleted && eligible(path)).length;
  timings.domain = t();

  // Working mode rehashes every path (the full round's unconditional rehash); committed mode probes candidates only.
  t = timer();
  const probes = mode === 'working' ? await probeDirtiness(root, gitRoot, [...domain], tree, index) : new Map();
  timings.Dp = t();

  const levelOf = (path: string, probe: { dp: string; rawOid: string | null; rawSha256: string | null } | undefined): string | null => {
    const committed = tree.get(path) ?? null;
    return mode === 'committed' ? committed?.oid ?? null
      : !probe || probe.dp === 'deleted' ? null
      : ['clean', 'clean_eol', 'clean_lfs'].includes(probe.dp) ? committed?.oid ?? probe.rawOid
      // A path in neither T nor the index (untracked) or only staged has no `deleted` verdict: no bytes and no file is absent.
      : probe.rawOid ?? (probe.rawSha256 === null && !readPresent(root, path, scope) ? null : `unreadable:${path}`);
  };
  // `A` only matters where the file or the database moved (no row settles on `fileSame ∧ dbSame` with a proof): read it
  // for those pages alone, so a converged source reads none.
  t = timer();
  const unproven = [...byOrigin].filter(([path, row]) => {
    if (row.request_id === null) return false;
    const level = levelOf(path, probes.get(path));
    return row.deleted || level === null || !recordOids(row.record).includes(level) || row.record?.revision == null || String(row.record.revision) !== row.revision;
  }).map(([, row]) => row);
  const attestationStatements = unproven.length ? await readAttestations(engine, engineKind, sourceId, incarnation, unproven) : 0;
  timings.A = t();

  const baselineCommit = (context.source.last_commit && revParse(gitRoot, context.source.last_commit)) || null;
  let baselineTree: Map<string, GitTreeEntry> | null | undefined;
  const baselineOf = async (path: string): Promise<string | null> => {
    if (!baselineCommit) return null;
    if (baselineTree === undefined) { const bt = timer(); baselineTree = await readTreeLevel(gitRoot, baselineCommit, scope).catch(() => null); timings.baseline = bt(); }
    return baselineTree?.get(path)?.oid ?? null;
  };

  const fp = (path: string) => syncImportParserFor(sourceRelative(path), pack?.identity ?? null);
  const stateOf = async (path: string, dirty: SyncPathState['dirty'], probe: { dp: string; rawOid: string | null; rawSha256: string | null } | undefined): Promise<{ state: SyncPathState; row?: PageRow; legacyPageless?: true }> => {
    const committed = tree.get(path) ?? null;
    const row = byOrigin.get(path);
    const level = levelOf(path, probe);
    // Presence decides only rows 4-6 (a level of absent); a committed path in T is not read here (Dp covers it).
    const presentNow = mode === 'working' ? level !== null : level === null ? readPresent(root, path, scope) : true;
    const record = row?.record ?? null;
    const recordBlobOids = recordOids(record);
    const attested = row && (row.arm1 || row.attested_hash) ? { hash: row.attested_hash ?? null, arm1: row.arm1 === true } : null;
    const hold = holdByGitPath.get(path);
    const marker = markers.get(originOf(path)) ?? null;
    let virtualMarker: SyncPathState['marker'] = null;
    let legacyPageless: true | undefined;
    if (!row && !marker && level !== null && level === await baselineOf(path)) { virtualMarker = { kind: 'legacy', blobOids: [level] }; legacyPageless = true; }
    const needsBaseline = row && !row.deleted && (record?.revision == null) && level !== null && !recordBlobOids.includes(level);
    const state: SyncPathState = {
      mode, tree: committed?.oid ?? null, level, present: presentNow, dirty, diskOid: probe?.rawOid ?? null,
      page: row ? { live: !row.deleted, revision: row.revision, originMatches: !!record && originPath(record.origin) === originPath(row.source_path) } : null,
      record: record ? { blobOids: recordBlobOids, revision: record.revision != null ? String(record.revision) : null, parserSame: sameParser(record.parser, fp(path)) } : null,
      attested, levelSha256: probe?.rawSha256 ?? null,
      published: !!attested?.hash && probe?.rawSha256 === attested.hash,
      hold: hold ? { atLevel: holdAtLevel(hold, level, probe?.rawSha256 ?? null) && !moved.has(path), rescreenDue: holdRescreenDue(hold, retry.has(hold.path)), retried: retry.has(hold.path) } : null,
      marker: marker ?? virtualMarker, baseline: needsBaseline ? await baselineOf(path) : null,
      spelling: (spellings.get(fold(path)) ?? 0) > 1,
      episodeUnsatisfied: input.full === true && !!row && !row.deleted,
      keepDb: !mirror && keepDbPrefixes.length > 0 && !!row && isKeepDbSlug(row.slug, keepDbPrefixes),
      openWork: !!row && open.pageIds.has(Number(row.id)) || open.origins.has(originOf(path)),
    };
    return { state, ...(row ? { row } : {}), ...(legacyPageless ? { legacyPageless } : {}) };
  };

  t = timer();
  const paths: ShadowPath[] = [];
  const candidates: string[] = [];
  const settledBeforeDirtiness = new Set(['held', 'spelling', 'untracked', 'kept', 'delete', 'delete_drift', 'gone', 'deleted_same', 'deleted_edited', 'legacy_same', 'matched']);
  for (const path of [...domain].sort()) {
    const probe = probes.get(path);
    const { state, row, legacyPageless } = await stateOf(path, mode === 'committed' && tree.has(path) ? 'clean' : null, probe);
    const result = classifySyncPath(state);
    // Rows 1-10 precede row 11 and `matched` settles either way, so only the rest are Dp candidates (design v3.2 §2.1).
    const staged = mode === 'committed' && tree.has(path) && (index.get(path)?.oid !== tree.get(path)!.oid || (index.get(path)?.stage ?? 0) !== 0);
    if (mode === 'committed' && tree.has(path) && (!settledBeforeDirtiness.has(result.cls) || staged)) candidates.push(path);
    paths.push({ path, slug: row?.slug ?? null, pageId: row ? Number(row.id) : null, revision: row?.revision ?? null, state, result, ...(legacyPageless ? { legacyPageless } : {}) });
  }
  timings.classify = t();
  if (candidates.length) {
    t = timer();
    const probed = await probeDirtiness(root, gitRoot, candidates, tree, index);
    timings.Dp = (timings.Dp ?? 0) + t();
    t = timer();
    const at = new Map(paths.map((entry, i) => [entry.path, i]));
    for (const path of candidates) {
      const probe = probed.get(path);
      const i = at.get(path)!;
      const { state } = await stateOf(path, (probe?.dp ?? 'unknown') as SyncPathState['dirty'], probe);
      paths[i] = { ...paths[i]!, state, result: classifySyncPath(state) };
    }
    timings.classify += t();
  }

  // Adoption by hash needs the level's bytes: committed mode reads the blobs of the candidates that could adopt.
  const needBytes = paths.filter(entry => entry.state.levelSha256 === null && entry.state.level !== null && entry.state.attested?.hash && entry.state.page?.live
    && !['matched', 'held', 'dirty'].includes(entry.result.cls));
  if (needBytes.length) {
    t = timer();
    const blobs = await readBlobs(gitRoot, [...new Set(needBytes.map(entry => entry.state.level!))], LEVEL_BLOB_MAX_BYTES);
    for (const entry of needBytes) {
      const bytes = blobs.get(entry.state.level!);
      if (!bytes) continue;
      const state = { ...entry.state, levelSha256: sha256(bytes) };
      Object.assign(entry, { state, result: classifySyncPath(state) });
    }
    timings.level_bytes = t();
  }

  const kind = syncPassKind({ converged: null, head, parserFp: '', pack: pack?.identity ?? null, selectionFp: '', now: Date.now(), openEpisode: input.full === true, owedTail: false,
    retryRow: retry.size > 0, notConvergedStreak: 0, mismatchStreak: 0, requestNewer: false, openAtStampFinished: false, workingChange: false,
    rescreenDueHold: holds.some(hold => holdRescreenDue(hold, retry.has(hold.path))), full: input.full === true });
  void passRow;
  timings.total = total();
  return { sourceId, incarnation, root, gitRoot, scope, slugMode, mode, head, baselineCommit, full: input.full === true, kind: kind.kind, kindBlockers: kind.blockers,
    paths, reconcilable, timings_ms: timings, statements: statements + attestationStatements + 3 };
}

/** `workingTreeFilePresent` (sync-discovery.ts) for a Git-root path: a file that exists, or one that cannot be read (fail closed). */
function readPresent(root: string, gitPath: string, scope: string): boolean {
  const path = scope ? gitPath.slice(scope.length + 1) : gitPath;
  try { return readSyncFile(root, path) !== null; } catch { return true; }
}

/** Whether a hold still describes the path at level `L`, in the hold's own domain (a pinned blob, working bytes, or a deletion). */
function holdAtLevel(hold: GitHoldRecord, level: string | null, diskSha256: string | null): boolean {
  if (hold.meta.deleted) return level === null;
  if (level === null) return false;
  if (hold.meta.working) return diskSha256 === null || diskSha256 === (hold.meta.working_hash ?? hold.upstream_version);
  return hold.meta.blob_oid ? hold.meta.blob_oid === level : true;
}

/**
 * The read-only convergence receipt of a source (design v3.1 §11 step 2): the shadow level, its predicted decisions after
 * a read-only screen (dry runs only), and the delete valve's verdict. Null for a company-brain source.
 */
export async function shadowConvergence(engine: BrainEngine, input: { sourceId: string; full?: boolean; workingTree?: boolean; redactPaths?: boolean; sampleCap?: number;
  screen?: ConvergenceScreen | false; context?: ManagedSyncContext }): Promise<ConvergenceReceipt | null> {
  const level = await readShadowLevel(engine, input);
  if (!level) return null;
  return buildConvergenceReceipt(engine, level, { redactPaths: input.redactPaths === true, sampleCap: input.sampleCap ?? 20, screen: input.screen ?? false });
}

/**
 * The idle tick's reads (design v3.2 §2.2): `rev-parse`, the per-source request probe above the converged watermark
 * (a range on the unique `sequence` index), the open-set probe (`persistence_requests_pending`, plus
 * `persistence_requests_database_pending` for the source's write-through-off requests, which carry no worktree) and the
 * pass row; both request probes count those requests too. PR 4a
 * writes no pass row, so a real tick is never idle yet; `assumeConverged` lets the bench time the reads PR 4b's idle
 * tick will make, with `request_hwm` at the current maximum.
 */
export async function idleTickProbe(engine: BrainEngine, input: { sourceId: string; assumeConverged?: { target: string; requestHwm: number }; context?: ManagedSyncContext }):
  Promise<{ idle: boolean; reasons: SyncIdleBlocker[]; timings_ms: Record<string, number>; rows: number }> {
  const timings: Record<string, number> = {};
  const total = timer();
  let t = timer();
  const context = input.context ?? await resolveManagedSyncContext(engine, { sourceId: input.sourceId, noPull: true, dryRun: true });
  timings.context = t();
  t = timer();
  const head = revParse(context.gitRoot, 'HEAD');
  timings.rev_parse = t();
  // The pass row, the request probe above its watermark and the open-set probe are one statement (one round trip).
  t = timer();
  const [probe] = await engine.executeRaw<{ pass_row: Record<string, unknown> | null; newer: boolean; pending: boolean }>(`WITH pass AS (
      SELECT completed_keys->0 AS value FROM op_checkpoints WHERE op=$1 AND fingerprint=$2)
    SELECT (SELECT value FROM pass) AS pass_row,
      EXISTS (SELECT 1 FROM persistence_requests WHERE sequence > COALESCE($3::bigint, ((SELECT value FROM pass)->'converged'->>'request_hwm')::bigint, 0)
        AND (worktree_id = $4 OR (worktree_id IS NULL AND source_incarnation = $5::uuid))) AS newer,
      EXISTS (SELECT 1 FROM persistence_requests WHERE (worktree_id = $4 OR (worktree_id IS NULL AND source_incarnation = $5::uuid))
        AND state IN ('queued','running','recovering')) AS pending`,
    [MANAGED_SYNC_PASS_OP, `${context.sourceId}:${context.incarnation}`, input.assumeConverged?.requestHwm ?? null, context.binding.worktree_id, context.incarnation]);
  timings.probes = t();
  const row = probe?.pass_row ?? null;
  const converged = input.assumeConverged ?? (row?.converged as { target: string; request_hwm: number } | undefined
    ? { target: String((row!.converged as Record<string, unknown>).target), requestHwm: Number((row!.converged as Record<string, unknown>).request_hwm) } : null);
  const newer = probe?.newer === true, pending = probe?.pending === true;
  const kind = syncPassKind({ converged: converged ? { target: converged.target, parserFp: '', pack: null, selectionFp: '', passesSinceFull: 0, lastFullAt: Date.now() } : null,
    head: head ?? '', parserFp: '', pack: null, selectionFp: '', now: Date.now(), openEpisode: false, owedTail: false, retryRow: false, notConvergedStreak: 0, mismatchStreak: 0,
    requestNewer: newer, openAtStampFinished: pending && !input.assumeConverged, workingChange: false, rescreenDueHold: false, full: false });
  timings.total = total();
  return { idle: kind.kind === 'idle', reasons: kind.blockers, timings_ms: timings, rows: (newer ? 1 : 0) + (pending ? 1 : 0) + (row ? 1 : 0) };
}

/**
 * `gbrain sync --dry-run --json`'s `convergence` for one source: the receipt with the read-only screen, undefined
 * on a brain that is not managed or for a company-brain source; a read that cannot run reports why instead of failing
 * the dry run.
 */
export async function dryRunConvergence(engine: BrainEngine, input: { sourceId: string; full: boolean; workingTree?: boolean; redactPaths: boolean;
  noEmbed: boolean; noExtract: boolean; noSchemaPack: boolean }): Promise<ConvergenceReceipt | { dry_run: true; status: 'unavailable'; code: string; message: string } | undefined> {
  if (!await readManagedMode(engine)) return undefined;
  try {
    const context = await resolveManagedSyncContext(engine, { sourceId: input.sourceId, noPull: true, dryRun: true });
    return await shadowConvergence(engine, { sourceId: input.sourceId, full: input.full, workingTree: input.workingTree, redactPaths: input.redactPaths, context,
      screen: readOnlySameContentScreen(engine, context, { noEmbed: input.noEmbed, noExtract: input.noExtract, noSchemaPack: input.noSchemaPack }) }) ?? undefined;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return { dry_run: true, status: 'unavailable', code: typeof code === 'string' ? code : 'convergence_read_failed', message: error instanceof Error ? error.message : String(error) };
  }
}

/** \`sync status --detail\`'s \`convergence\`: the receipt without the screen (status never prepares an import). */
export async function statusConvergence(engine: BrainEngine, sourceId: string): Promise<ConvergenceReceipt | { dry_run: true; status: 'unavailable'; code: string; message: string } | null> {
  if (!await readManagedMode(engine)) return null;
  try {
    return await shadowConvergence(engine, { sourceId, screen: false });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return { dry_run: true, status: 'unavailable', code: typeof code === 'string' ? code : 'convergence_read_failed', message: error instanceof Error ? error.message : String(error) };
  }
}
