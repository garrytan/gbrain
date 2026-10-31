/**
 * #6712 PR 4b (design v3.2 §2.2, §3.1-§3.5, §8, §9; v3 §3.1-§3.3, §3.5): the live level-triggered pass of a managed,
 * non-company source. Under the source's drain lease it pins the target (`HEAD`), decides the pass kind, and runs rounds:
 *
 * - **Pin.** The pass row, `sync.admission`, `HEAD` and the mode (a detached `HEAD` forces working mode) are read; the
 *   row is written with a new `pass_id` and the lease's token (`writePassRow(..., { pin: true })` after `assertDrainLease`).
 *   An unfinished legacy cursor is superseded first (§3.5): its open requests are waited for, its options seed the episode.
 * - **Idle** (§2.2): nothing moved since the converged stamp, so only `last_sync_at` is stamped (`up_to_date`).
 * - **Rounds** (§3.1): round k reads the level (sync-pass.ts `readShadowLevel`) and classifies; `C_k = unsettled − S`.
 *   Candidates are admitted in batches of at most 10,000 (deletes, then imports) through the cursor machinery of
 *   sync-run.ts on an in-memory batch (sync-pass-batch.ts): freeze, screen, waive, group, admit, await and settle; every
 *   settled `(path, level)` joins `S` and is never admitted again in the pass. With nothing unsettled and nothing in
 *   flight, the stamp (sync-prepare.ts `applyPassCheckpoint`) publishes the converged state. Four rounds without
 *   converging stop `resumable` (`not_converged`).
 */
import { randomUUID } from 'node:crypto';
import { confirmedSyncDelta, confirmRenameIdentities, explicitIdVeto } from '../sync-rename-identity.ts';
import { buildDetachedWorkingTreeManifest } from '../sync-delta.ts';
import type { DowngradedRename, SyncManifest } from '../sync.ts';
import type { BrainEngine } from '../engine.ts';
import type { SyncOpts, SyncResult } from '../../commands/sync.ts';
import type { Cursor, RetryWait } from './sync-run.ts';
import { getWriteRequestById } from './journal.ts';
import type { WriteRequest } from './model.ts';
import { managedSyncWriteDiagnostic } from './sync-write-diagnostic.ts';
import { recordedStop, replaysUnchangedRefusal, resumableRowStop } from './sync-stop-class.ts';
import { adoptLegacyPage, incomingId, syncExcludePatterns, syncGit, type LegacyIdentity, type ManagedSyncContext, type SyncDiscovery, type SyncEntry, type SyncFileRefusal, type SyncSlugCollision } from './sync-discovery.ts';
import { assertSyncDispatchActive, type SyncAuthority, type SyncProcessingOptions } from './sync-authority.ts';
import { recordPassFenceTrend, type PassStamp, type SyncCursorOptions, type SyncIntent } from './sync-prepare.ts';
import { OPEN_AT_STAMP_CAP, passFingerprint, readPassRow, SYNC_ORIGIN_DELETED_OP, writePassRow, type ManagedSyncPassValue, type PassEpisode,
  type PassKind, type PassOutcome, type SyncSelection } from './sync-pass-row.ts';
import { readSyncAdmission, type SyncAdmission } from './sync-admission.ts';
import { faultPoint } from './fault-points.ts';
import { passFoldBase, passIdleProbe, readShadowLevel, workingIdleChange, type PassLevelCache, type ShadowLevel, type ShadowPath } from './sync-pass.ts';
import { ownWritebackCommit, type PassFold } from './sync-pass-fold.ts';
import { openPassRequests, settleCarried } from './sync-pass-carried.ts';
import { loopYield } from './sync-yield.ts';
import { recallWorkingStatCache, rememberWorkingStatCache, SyncTreeReadIncomplete } from './sync-git-stream.ts';
import { syncPassKind } from './sync-classify.ts';
import { PASS_BATCH_KEY_PREFIX, readConvergedWatermark, SyncAdmissionPaused, type PassEntry } from './sync-pass-batch.ts';
import { assertDrainLease, currentDrainLease } from './sync-lease.ts';
import { idleClear, readIdleFacts } from './sync-idle-skips.ts';
import { digest } from './digest.ts';
import { readSyncTail } from './sync-tail-record.ts';
import { movedDriftHolds } from './sync-prescreen.ts';
import { clearGitHold, clearGitHoldRetryPaths, holdRescreenDue, readGitHoldRetryPaths, readSyncHoldPolicy, readGitSourceHolds, readSyncImportProvenances, settledDeletionHolds, syncImportParserFor } from './sync-holds.ts';
import { loadActivePackForEngine } from '../schema-pack/engine-resolution.ts';
import { loadConfig } from '../config.ts';
import { startPersistenceConsumer } from './service.ts';
import { clearManagedSyncFailureAfterSuccess } from './sync-failures.ts';
import { managedCursorKey, passFailureKeys, resolveManagedCursor, retireManagedCursor, retireOrphanSliceRecords } from './sync-cursor-key.ts';
import { withCoordinatedWrite } from './context.ts';
import { pipelined } from '../page-state/transactions.ts';
import { principalAttribution } from './attribution.ts';
import { isCodeFilePath, readMetafilePagesMode, resolveSlugForPath } from '../sync.ts';
import { readPassSwitches } from './sync-held-deletions.ts';
import { keepPassPages, takePassPages } from './sync-tree-reuse.ts';
import { syncOriginPath } from './sync-origin.ts';
import { databaseOnlyPageSql } from './unbound-pages.ts';
import { originMarkerFingerprint } from './sync-markers.ts';
import { SYNC_SLICE_OP } from './sync-slices.ts';
import { passResumeArgs } from './sync-pass-readers.ts';
import { applyPassRound, sweepLegacy, finishPassApply, holdPassIdentities, newPassApplyState, passApplyCounts, remoteReconcile } from './sync-pass-apply.ts';
import { passClosureMemo, passCostDecision, type passEpisodeClosure, readReservedUsd, registerPassCost, unregisterPassCost } from './sync-pass-episode.ts';
import { currentEmbeddingPricePerMTok } from '../embedding.ts';
import { SIZE_STATE_SAMPLE, type SyncSizeStates } from '../page-embedding-budget.ts';
import { massReconcileAllowed } from '../sync-reconcile.ts';
import { keepDbHeadroom } from '../repair/keep-db-policy.ts';

/** Rounds a pass runs before it stops `not_converged` (design §3.1). */
export const PASS_MAX_ROUNDS = 4;
/** Candidates per round batch (design §3.1). */
export const PASS_BATCH_MAX = 10_000;
/** Waits for in-flight work a pass makes before it stops `writer_pending`, each bounded by the wait budget. */
const IN_FLIGHT_WAITS = 4;
/** #7355: how often a long level read writes the open pass row, so a follower and `sync status` see it working. */
const PASS_HEARTBEAT_MS = 30_000;

export interface SyncPassInput {
  opts: SyncOpts; slice?: { maxPages: number; maxMs: number }; context: ManagedSyncContext; authority: SyncAuthority;
  processingOptions: SyncProcessingOptions; syncOptions: SyncCursorOptions; assertActive: () => void; signal?: AbortSignal;
  state: { sourceId?: string; incarnation?: string; remote?: boolean }; runStartedAt: string;
  /** Drains one round batch through sync-run.ts's cursor loop: the batch back when it drained, or the result it stopped with. */
  drainBatch: (key: string, batch: Cursor, sliceBase: { started: number; pages: number }) => Promise<SyncResult | Cursor>;
  /** A round's level read starts at `target` (the HEAD it was pinned or last read at): a failure until its first batch is that read's. */
  onLevelRead: (target: string) => void;
}

/** The configured patterns a selection unions with its flags: read once, beside the pin's other reads. */
function selectionPatterns(engine: BrainEngine, opts: SyncOpts): Promise<[Iterable<string>, string | null]> {
  return Promise.all([syncExcludePatterns(engine, opts.exclude), engine.getConfig('sync.include_hidden')]);
}
/** The selection a pass syncs (design §6), with the configured one's test: no selection flag differs from the source's configuration. */
function passSelection([excluded, hidden]: [Iterable<string>, string | null], opts: SyncOpts, context: ManagedSyncContext, mode: SyncSelection['mode']): SyncSelection {
  const exclude = [...excluded].sort();
  const includeHidden = [...new Set([...opts.includeHidden ?? [], ...(hidden ?? '').split(/[\n,]/).map(v => v.trim()).filter(Boolean)]
    .map(v => v.endsWith('/') ? `${v}**` : v))].sort();
  return { exclude, includeHidden, strategy: opts.strategy ?? (context.source.config?.strategy as string | undefined) ?? 'markdown', srcSubpath: opts.srcSubpath ?? null, mode };
}

/** The parser fingerprint every import kind records (Markdown, code, image); a change makes the next pass a full round. */
const parserFingerprint = () => digest(['x.md', 'x.ts', 'x.png'].map(path => syncImportParserFor(path, null)));

/**
 * Design §3.5: the source's legacy cursors go on the first pass of an incarnation. Every unfinished one is superseded under
 * the lease (queued requests cancelled, a running, recovering or publishing one waited for); a finished one is deleted.
 * The newest unfinished cursor's options seed the episode (`inherited.from = 'legacy_cursor'`; a `--full` cursor seeds a
 * full episode). A remote caller retires nothing: an unfinished cursor leaves it to the brain host.
 */
async function retireLegacyCursors(engine: BrainEngine, input: { sourceId: string; incarnation: string; remote: boolean; assertActive: () => void }):
  Promise<{ wait?: RetryWait; hostRequired?: true; episode?: PassEpisode }> {
  const readHeader = (key: string) => engine.executeRaw<{ slices: boolean; header: { runId?: string; done?: boolean; processingOptions?: SyncProcessingOptions; syncOptions?: SyncCursorOptions & { exclude?: string[]; includeHidden?: string[]; strategy?: string; srcSubpath?: string; workingTree?: boolean } } | null }>(
    `SELECT (SELECT completed_keys->0 FROM op_checkpoints WHERE op='managed-sync' AND fingerprint=$1) AS header,
      EXISTS (SELECT 1 FROM op_checkpoints WHERE op=$2 AND left(fingerprint, length($3))=$3) AS slices`, [key, SYNC_SLICE_OP, `${input.sourceId}:${input.incarnation}:`]);
  // #6712 PR 4b: the canonical key's header is read beside the resolution (the key it picks unless it adopts an older one;
  // the resolution never writes the key it picks), and read again only for an adopted key.
  const canonical = managedCursorKey(input.incarnation, undefined), speculative = readHeader(canonical);
  speculative.catch(() => undefined);
  const resolution = await resolveManagedCursor(engine, { sourceId: input.sourceId, incarnation: input.incarnation, company: undefined, assertActive: input.assertActive, foldIn: !input.remote });
  if (resolution.waitFor) return { wait: { ...resolution.waitFor, retry_after_ms: 5000 } };
  const [row] = await (resolution.key === canonical ? speculative : readHeader(resolution.key));
  const header = row?.header;
  if (!header) {
    if (row?.slices && !input.remote) await retireOrphanSliceRecords(engine, input.sourceId, input.incarnation);
    return {};
  }
  if (input.remote) return header.done ? {} : { hostRequired: true };
  const busy = await retireManagedCursor(engine, { sourceId: input.sourceId, incarnation: input.incarnation, key: resolution.key, runId: header.runId ?? null, done: header.done === true });
  input.assertActive();
  if (busy) return { wait: { ...busy, retry_after_ms: 5000 } };
  if (header.done) return {};
  const options = header.processingOptions, sync = header.syncOptions;
  return { episode: { opened_at: new Date().toISOString(), ...(sync?.full ? { full_id: randomUUID() } : {}),
    selection: { exclude: [...sync?.exclude ?? []].sort(), includeHidden: [...sync?.includeHidden ?? []].sort(), strategy: sync?.strategy ?? null, srcSubpath: sync?.srcSubpath ?? null,
      mode: sync?.workingTree ? 'working' : 'committed' },
    inherited: { noEmbed: options?.noEmbed === true, noExtract: options?.noExtract === true, noSchemaPack: options?.noSchemaPack === true, from: 'legacy_cursor' } } };
}

/** The path forms of one level path: root-relative (`SyncEntry.path`) and the recorded origin (`sourcePath`). */
function entryPaths(level: ShadowLevel, gitPath: string): { path: string; sourcePath: string } {
  const path = level.scope ? gitPath.slice(level.scope.length + 1) : gitPath;
  return { path, sourcePath: level.slugMode === 'source-root' && level.scope ? path : gitPath };
}

/**
 * The round's candidates as batch entries, with the identities discovery resolves (`discoverManagedSync`): a live page
 * at the origin is the import's page; a new origin takes the slug its path names, and the page holding that slug is
 * taken over when its own origin leaves in this pass (`renameFrom`, its deletion retired), a collision when its origin
 * stays; one new origin whose bytes equal a page leaving at another origin is that page's Git rename (`renameFrom`, the
 * page moves to the new slug). Deletes first, then imports.
 */
async function batchEntries(engine: BrainEngine, level: ShadowLevel, deletes: ShadowPath[], imports: ShadowPath[]):
  Promise<{ entries: PassEntry[]; collisions: SyncSlugCollision[]; skipped: ShadowPath[]; downgrades: DowngradedRename[];
    identity: Array<{ entry: ShadowPath; origin: ShadowPath | null; slug: string; ids: { page: string; file: string } }> }> {
  await faultPoint('sync:batch_entries', { sourceId: level.sourceId });
  const working = (entry: ShadowPath) => level.mode === 'working' && entry.state.level !== entry.state.tree;
  const committedOnly = level.strict ? { committedOnly: true as const } : {};
  const deleteEntries = new Map<string, PassEntry>(deletes.map(entry => [entry.path, { ...entryPaths(level, entry.path), ...committedOnly, action: 'delete' as const, working: level.mode === 'working',
    slug: entry.slug!, pageId: entry.pageId, revision: entry.revision, level: null, ...(entry.result.heldDeletion ? { heldDeletion: entry.result.heldDeletion } : {}) }]));
  const leaving = new Map(deletes.map(entry => [entry.path, entry]));
  const fresh = imports.filter(entry => !entry.state.page);
  // Same-blob twins per level, and the leaving pages per recorded blob, counted once: a scan per winner was quadratic.
  const twinsAt = new Map<string | null | undefined, number>();
  for (const entry of fresh) twinsAt.set(entry.state.level, (twinsAt.get(entry.state.level) ?? 0) + 1);
  const leavingAt = new Map<string, ShadowPath[]>();
  for (const gone of leaving.values()) for (const oid of new Set(gone.state.record?.blobOids ?? [])) { const at = leavingAt.get(oid); if (at) at.push(gone); else leavingAt.set(oid, [gone]); }
  // A first sync's batch is every new file: each loop below yields between stretches, as a level's own loops do.
  const step = loopYield();
  const slugOf = new Map<string, string>();
  for (const entry of fresh) {
    if (step.due()) await step.pause();
    slugOf.set(entry.path, resolveSlugForPath(entryPaths(level, entry.path).sourcePath));
  }
  // #6727, as discovery does: a new origin with no live page at its slug takes the one legacy page (no recorded origin)
  // that folds to it; several, or one the importer cannot write, keep the slug and the freeze holds legacy_slug_conflict.
  const legacySlugs = new Map<string, Pick<SyncEntry, 'legacySlugs' | 'legacyIdVeto'>>();
  const adopting = fresh.filter(entry => slugOf.get(entry.path) && !isCodeFilePath(entryPaths(level, entry.path).sourcePath));
  const discovery = { root: level.root, gitRoot: level.gitRoot, target: level.head, sourceId: level.sourceId } as SyncDiscovery;
  const named = (entry: ShadowPath): SyncEntry => ({ ...entryPaths(level, entry.path), action: 'import', working: working(entry) });
  if (adopting.length) {
    // A batch-wide read runs on this thread under PGLite (at 8k new files, about as long as the loops' budget): it starts a stretch of its own.
    await step.pause();
    const identities = await engine.executeRaw<LegacyIdentity>("SELECT id, slug, source_path, deleted_at, frontmatter->>'id' AS fm_id FROM pages WHERE source_id=$1 AND (source_path IS NULL OR slug=ANY($2::text[]))",
      [level.sourceId, [...new Set(adopting.map(entry => slugOf.get(entry.path)!))]]);
    const bySlug = new Map(identities.map(page => [page.slug, page]));
    for (const entry of adopting) {
      if (step.due()) await step.pause();
      const adopted = named(entry);
      slugOf.set(entry.path, await adoptLegacyPage(engine, discovery, identities, bySlug.get(slugOf.get(entry.path)!), slugOf.get(entry.path)!, adopted));
      if (adopted.legacySlugs) legacySlugs.set(entry.path, { legacySlugs: adopted.legacySlugs, ...(adopted.legacyIdVeto ? { legacyIdVeto: true as const } : {}) });
    }
  }
  const slugs = [...new Set([...slugOf.values()].filter(Boolean))];
  if (slugs.length) await step.pause();
  const holders = new Map((slugs.length ? await engine.executeRaw<{ id: number | string; slug: string; source_path: string | null; revision: string; deleted: boolean; unbound: boolean; fm_id: string | null }>(
    `SELECT id, slug, source_path, knowledge_revision::text AS revision, deleted_at IS NOT NULL AS deleted, ${databaseOnlyPageSql('pages')} AS unbound, frontmatter->>'id' AS fm_id FROM pages WHERE source_id=$1 AND slug=ANY($2::text[])`, [level.sourceId, slugs]) : [])
    .map(page => [page.slug, page]));
  const gitPathOfOrigin = (origin: string) => level.slugMode === 'source-root' && level.scope ? `${level.scope}/${syncOriginPath(origin)}` : syncOriginPath(origin);
  // #6887: a both-moved import imports when the page still holds what its recorded disk blob imports (sync-screen.ts driftBaselineContent).
  const bothDrift = imports.filter(entry => entry.result.cls === 'drift' && entry.result.side === 'both' && entry.pageId !== null);
  const baselineRecords = await readSyncImportProvenances(engine, level.sourceId, level.incarnation, bothDrift.map(entry => entry.pageId!));
  // #7338: a page with no import record (imported by an older gbrain) has its file at the incarnation's baseline commit as its baseline.
  const driftBaseline = (entry: ShadowPath) => entry.pageId === null ? undefined : entry.result.side === 'both' ? baselineRecords.get(entry.pageId)?.disk_blob_oid ?? undefined
    : entry.result.side === 'unknown' ? entry.state.baseline ?? undefined : undefined;
  const entries: PassEntry[] = [], collisions: SyncSlugCollision[] = [], skipped: ShadowPath[] = [], identity: Array<{ entry: ShadowPath; origin: ShadowPath | null; slug: string; ids: { page: string; file: string } }> = [];
  const claims = new Map<string, ShadowPath[]>();
  for (const entry of imports) {
    if (step.due()) await step.pause();
    const paths = entryPaths(level, entry.path);
    const base = { ...paths, ...committedOnly, action: 'import' as const, working: working(entry), level: entry.state.level, ...(entry.result.cls === 'drift' && entry.result.side && entry.result.side !== 'deleted' ? { drift: entry.result.side, ...(driftBaseline(entry) ? { driftBaseline: driftBaseline(entry) } : {}) } : {}) };
    if (entry.state.page) { entries.push({ ...base, slug: entry.slug!, pageId: entry.pageId, revision: entry.revision }); continue; }
    const slug = slugOf.get(entry.path);
    if (!slug) { skipped.push(entry); continue; }
    claims.set(slug, [...claims.get(slug) ?? [], entry]);
  }
  const renamed = new Set<string>();
  let renames: Promise<Map<string, { from: string; identityHead?: string }> | null> | null = null;
  const downgrades: DowngradedRename[] = [];
  // #6729, as discovery confirms them: the commit range's renames, then (working mode) the dirty tree's, whose target side
  // is read from disk and whose kept renames are bound to the bytes the verdict read (identityHead, checked at import).
  const gitRenames = () => renames ??= (async () => {
    if (!deleteEntries.size && !level.heldRenames.length) return null;
    const confirm = { sourceId: level.sourceId, sourcePathOf: (path: string) => entryPaths(level, path).sourcePath };
    const manifests: SyncManifest[] = [];
    if (level.baselineCommit && level.baselineCommit !== level.head) {
      const delta = await confirmedSyncDelta(engine, level.gitRoot, level.baselineCommit, level.head, confirm);
      if (delta.status === 'ok') manifests.push(delta.manifest);
      else if (level.mode === 'committed') return null;
    }
    if (level.mode === 'working') manifests.push(await confirmRenameIdentities(engine, level.gitRoot, 'HEAD', null, buildDetachedWorkingTreeManifest(level.gitRoot), confirm));
    if (!manifests.length) return null;
    // The inexact renames whose identity was not kept are reported (and recorded) as discovery reported them.
    downgrades.push(...manifests.flatMap(manifest => manifest.downgradedRenames ?? []).map(pair => ({ ...pair, from: entryPaths(level, pair.from).sourcePath, to: entryPaths(level, pair.to).sourcePath })));
    return new Map(manifests.flatMap(manifest => manifest.renamed.map(pair => [pair.to, { from: pair.from, ...(pair.identityHead ? { identityHead: pair.identityHead } : {}) }] as const)));
  })();
  for (const [slug, claimants] of claims) {
    if (step.due()) await step.pause();
    const holder = holders.get(slug);
    const holderPath = holder?.source_path ? gitPathOfOrigin(holder.source_path) : null;
    const kept = holder && !holder.deleted && holderPath !== null && !leaving.has(holderPath) ? holderPath : null;
    const winner = kept === null ? claimants.find(entry => /\.mdx?$/i.test(entry.path) && entryPaths(level, entry.path).sourcePath.replace(/\.mdx?$/i, '') === slug) ?? claimants[0]! : null;
    const losers = claimants.filter(entry => entry !== winner);
    if (losers.length) collisions.push({ slug, kept: kept ?? entryPaths(level, winner!.path).sourcePath, skipped: losers.map(entry => entryPaths(level, entry.path).sourcePath) });
    if (!winner) continue;
    const paths = entryPaths(level, winner.path);
    const base = { ...paths, ...committedOnly, action: 'import' as const, working: working(winner), level: winner.state.level, slug, ...legacySlugs.get(winner.path) };
    if (holder) {
      // #6729: a file whose frontmatter id differs from the page's is another document; it inherits nothing. GBRA-130 B-4: it is
      // held alone and the page keeps its slug (its origin's deletion waits with it); discovery still refuses the source.
      const incoming = holder.fm_id ? incomingId(discovery, named(winner)) : null;
      if (explicitIdVeto(incoming, holder.fm_id)) {
        identity.push({ entry: winner, origin: deletes.find(entry => entry.path === holderPath) ?? null, slug, ids: { page: holder.fm_id!, file: incoming! } });
        if (holderPath !== null) deleteEntries.delete(holderPath);
        continue;
      }
      // A live page at the slug with no recorded origin (written straight to the database, or by an older gbrain) attests
      // neither side: the import is guarded as drift of unknown side, so the freeze imports it only as a proven no-op and
      // otherwise holds file_drift (as discovery's tree walk guards it, sync-prescreen.ts). A page written while the source was
      // unbound (#5254) is not guarded: its preparation refuses the file that now occupies its path (source_changed).
      entries.push({ ...base, pageId: Number(holder.id), revision: holder.revision,
        ...(holder.source_path !== null ? { renameFrom: { sourcePath: holder.source_path, slug, pageId: Number(holder.id), revision: holder.revision } } : {}),
        ...(holder.source_path === null && !holder.deleted && !holder.unbound && !level.strict ? { drift: 'unknown' as const } : {}) });
      if (holderPath !== null && deleteEntries.delete(holderPath)) renamed.add(holderPath);
      continue;
    }
    // #5988: a held rename destination still owes its page the move: re-bound while the origin page is unchanged, else held rename_held.
    // A held destination renamed again (a Git rename of the held path) carries the held identity on.
    const heldAt = (path: string | undefined) => path === undefined ? undefined : level.heldRenames.find(row => row.path === path)?.rename;
    const held = heldAt(winner.path) ?? (level.heldRenames.length ? heldAt((await gitRenames())?.get(winner.path)?.from) : undefined);
    const origin = held ? (await engine.executeRaw<{ source_path: string | null; revision: string; deleted: boolean; fm_id: string | null }>(
      "SELECT source_path, knowledge_revision::text AS revision, deleted_at IS NOT NULL AS deleted, frontmatter->>'id' AS fm_id FROM pages WHERE source_id=$1 AND id=$2", [level.sourceId, held.pageId]))[0] : undefined;
    if (held && origin && !origin.deleted && origin.source_path !== null && syncOriginPath(origin.source_path) === syncOriginPath(held.sourcePath)
      && !explicitIdVeto(incomingId(discovery, named(winner)), origin.fm_id)) {
      entries.push({ ...base, pageId: null, revision: null, ...(origin.revision === held.revision ? { renameFrom: held } : { renameHeld: held }) });
      continue;
    }
    const moved = (leavingAt.get(winner.state.level ?? '') ?? []).filter(gone => deleteEntries.has(gone.path) && !renamed.has(gone.path));
    const twins = twinsAt.get(winner.state.level) ?? 0;
    // #6729: a Git rename with an edit keeps its page when Git pairs it and the identity is confirmed, as discovery's delta does.
    const inexact = moved.length === 1 && twins === 1 ? null : (await gitRenames())?.get(winner.path);
    const gitMoved = inexact && deleteEntries.has(inexact.from) && !renamed.has(inexact.from) ? leaving.get(inexact.from) : undefined;
    if (gitMoved?.pageId != null || (moved.length === 1 && twins === 1)) {
      const gone = gitMoved ?? moved[0]!;
      const origin = entryPaths(level, gone.path).sourcePath;
      entries.push({ ...base, pageId: null, revision: null, renameFrom: { sourcePath: origin, slug: gone.slug!, pageId: gone.pageId!, revision: gone.revision! },
        ...(gitMoved && inexact?.identityHead && base.working ? { identityHead: inexact.identityHead } : {}) });
      deleteEntries.delete(gone.path); renamed.add(gone.path);
      continue;
    }
    entries.push({ ...base, pageId: null, revision: null });
  }
  const batch = [...deleteEntries.values(), ...entries.sort((a, b) => a.path.localeCompare(b.path))];
  // The drain freezes the batch's first entry (and reads its blob window) right after: it starts on a turn of its own too.
  await step.pause();
  return { entries: batch, collisions, skipped, downgrades, identity };
}

/**
 * Waits (bounded) until no open request or Git effect of the worktree names one of the in-flight pages or origins, and
 * returns what the requests open at its start committed meanwhile: an earlier drain's work this pass reports as its own.
 */
async function awaitInFlight(engine: BrainEngine, level: ShadowLevel, inFlight: ShadowPath[], budgetMs: number, assertActive: () => void,
  /** Earlier passes' open requests (sync-pass-carried.ts): counted here when they commit, even after the open read below. */
  carried: readonly string[] = []): Promise<{ added: number; modified: number; deleted: number; renamed: number; committed: string[] }> {
  const pageIds = inFlight.flatMap(entry => entry.pageId === null ? [] : [entry.pageId]);
  const origins = inFlight.map(entry => entryPaths(level, entry.path).sourcePath);
  const names = `r.page_id=ANY($2::int[]) OR r.intent->>'sourcePath'=ANY($3::text[]) OR r.intent->>'path'=ANY($3::text[])`;
  const opened = [...new Set([...(await engine.executeRaw<{ id: string }>(`SELECT r.id FROM persistence_requests r WHERE r.source_id=$1 AND r.state IN ('queued','running','recovering') AND (${names})`,
    [level.sourceId, pageIds, origins])).map(row => String(row.id)), ...carried])];
  const until = Date.now() + budgetMs;
  while (Date.now() < until) {
    // The open work readOpenWork marked: an open request, or a pending Git effect named by its request or its relative_path
    // (a put_page that created its page records no page_id or origin on the request).
    const [open] = await engine.executeRaw(`SELECT 1 FROM persistence_requests r WHERE r.source_id=$1 AND (r.state IN ('queued','running','recovering') AND (${names})
        OR EXISTS (SELECT 1 FROM persistence_effects e WHERE e.request_id=r.id AND e.kind='git' AND e.state IN ('queued','running')
          AND (${names} OR e.data->>'relative_path'=ANY($3::text[])))) LIMIT 1`, [level.sourceId, pageIds, origins]);
    assertActive();
    if (!open) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const credited = { added: 0, modified: 0, deleted: 0, renamed: 0, committed: [] as string[] };
  if (!opened.length) return credited;
  const created = new Set(inFlight.filter(entry => entry.pageId === null).map(entry => entryPaths(level, entry.path).sourcePath));
  const committed = await engine.executeRaw<{ id: string; kind: string | null; source_path: string | null; renamed: boolean }>(`SELECT id::text AS id, intent->>'kind' AS kind, intent->>'sourcePath' AS source_path,
    intent ? 'renameFrom' AS renamed FROM persistence_requests WHERE id=ANY($1::uuid[]) AND state='committed'`, [opened]);
  credited.committed = committed.map(row => row.id);
  for (const row of committed) {
    if (row.kind === 'managed_sync_delete') credited.deleted++;
    else if (row.kind !== 'managed_sync_import') continue;
    else if (row.renamed) credited.renamed++;
    else if (row.source_path !== null && created.has(row.source_path)) credited.added++;
    else credited.modified++;
  }
  return credited;
}

/** The oldest open request naming one of the in-flight pages or origins. */
async function openInFlightRequest(engine: BrainEngine, level: ShadowLevel, inFlight: ShadowPath[]): Promise<WriteRequest | null> {
  const [row] = await engine.executeRaw<{ id: string }>(`SELECT r.id FROM persistence_requests r WHERE r.source_id=$1 AND r.state IN ('queued','running','recovering')
    AND (r.page_id=ANY($2::int[]) OR r.intent->>'sourcePath'=ANY($3::text[])) ORDER BY r.sequence LIMIT 1`,
  [level.sourceId, inFlight.flatMap(entry => entry.pageId === null ? [] : [entry.pageId]), inFlight.map(entry => entryPaths(level, entry.path).sourcePath)]);
  return row ? getWriteRequestById(engine, row.id) : null;
}

/** Design §2.7 (b1): the incarnation's first pass writes a `legacy` marker, with its deletion proof, for each page-less path deleted before PR 4. */
async function writeLegacyMarkers(engine: BrainEngine, level: ShadowLevel): Promise<number> {
  const rows = level.paths.filter(entry => entry.legacyPageless && entry.state.level).map(entry => ({
    fingerprint: originMarkerFingerprint(level.sourceId, level.incarnation, entryPaths(level, entry.path).sourcePath),
    value: { source_id: level.sourceId, incarnation: level.incarnation, kind: 'legacy', blob_oids: [entry.state.level], deletion: entry.state.marker?.deletion ?? null, at: new Date().toISOString() } }));
  if (!rows.length) return 0;
  await engine.transaction(async tx => {
    await assertDrainLease(tx, level.sourceId);
    await tx.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at)
      SELECT $1, row->>'fingerprint', jsonb_build_array(row->'value'), now() FROM jsonb_array_elements($2::text::jsonb) AS row ON CONFLICT (op,fingerprint) DO NOTHING`,
    [SYNC_ORIGIN_DELETED_OP, JSON.stringify(rows)]);
  });
  return rows.length;
}

/**
 * The pass's pin (design §2.2): its reads, mode, selection, options, kind and the row it opens; `ended` when the legacy
 * cursors' retirement ends the pass before it pins.
 */
async function pinPass(engine: BrainEngine, input: SyncPassInput, lease: NonNullable<ReturnType<typeof currentDrainLease>>, started: number) {
  const { opts, context, authority, assertActive } = input;
  const { sourceId, incarnation } = context;
  const remote = authority.writer.remote;
  const startedAt = new Date(started).toISOString();
  // Pin (design §2.2): the row, sync.admission, HEAD and the mode. The reads the kind needs ride the same round trip: the
  // selection's patterns, the schema pack, the tail, the retry row, the source's holds and the idle probe (which reads the
  // row's watermark and open ids itself). #6712 PR 4b: the legacy cursors' retirement runs beside them; it writes none of
  // what they read, and its outcome is still decided first.
  const pin = Promise.all([readPassRow(engine, sourceId, incarnation),
    readSyncAdmission(engine), engine.getConfig('sync.include_working_tree'), selectionPatterns(engine, opts),
    input.processingOptions.noSchemaPack ? null : loadActivePackForEngine(engine, { remote: false, sourceId }).catch(() => null),
    readSyncTail(engine, sourceId), readGitHoldRetryPaths(engine, sourceId, incarnation), readGitSourceHolds(engine, { sourceIds: [sourceId] }),
    passIdleProbe(engine, { sourceId, incarnation, worktreeId: context.binding.worktree_id, requestHwm: null, openAtStamp: null }),
    engine.executeRaw(`SELECT 1 FROM op_checkpoints WHERE op='managed-sync-failure' AND fingerprint=ANY($1::text[]) LIMIT 1`, [passFailureKeys(sourceId, incarnation)]),
    readIdleFacts(engine, sourceId, incarnation)] as const);
  pin.catch(() => undefined);
  const handover = await retireLegacyCursors(engine, { sourceId, incarnation, remote, assertActive });
  const empty = (status: SyncResult['status'], reason?: SyncResult['reason']) => emptyPassResult(context, remote, status, reason);
  if (handover.wait) return { ended: { ...empty('partial', 'writer_pending'), ...(remote ? {} : { retryWait: handover.wait }) } };
  if (handover.hostRequired) return { ended: empty('blocked_by_failures', 'reconcile_host_required') };
  const [prior, admission, configuredWorking, patterns, loadedPack, tail, retry, sourceHolds, rowProbe, failed, idleFacts] = await pin;
  assertActive();
  const [headLine, refLine] = syncGit(context.gitRoot, ['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD']).split('\n');
  const head = headLine!.trim();
  const detached = refLine?.trim() === 'HEAD';
  // G3: a strict source's pass reads its commit alone, a detached HEAD's too (sync-pass.ts).
  const strict = context.source.config?.canonical === 'git';
  const mode: SyncSelection['mode'] = !strict && (detached || (opts.workingTree ?? configuredWorking === 'true')) ? 'working' : 'committed';
  const selection = passSelection(patterns, opts, context, mode);
  const configured = !remote && !opts.exclude?.length && !opts.includeHidden?.length && opts.srcSubpath === undefined
    && (opts.strategy === undefined || opts.strategy === ((context.source.config?.strategy as string | undefined) ?? 'markdown'))
    && (strict || detached || opts.workingTree === undefined || opts.workingTree === (configuredWorking === 'true'));
  // GBRA-150: `sync.metafile_pages typed` widens the level's universe, so it joins the selection fingerprint (`off` keeps
  // the fingerprint an older pass stamped): the first pass after the upgrade or a flip reads the whole level once.
  const metafilePages = await readMetafilePagesMode(engine);
  // GBRA-133: so does `sync.apply_held_deletions` when on (sync-held-deletions.ts): turning it on reads the level, and its held deletions, once.
  // `sync.level_reuse` rides the same read (sync-tree-reuse.ts); it changes how the level is read, not what it is.
  const { heldDeletions, levelReuse } = await readPassSwitches(engine, sourceId);
  const selectionFp = digest({ ...selection, ...(metafilePages === 'off' ? {} : { metafile_pages: metafilePages }), ...(heldDeletions ? { apply_held_deletions: true } : {}), ...(strict ? { canonical: 'git' } : {}) }), parserFp = parserFingerprint();
  const obligations: ManagedSyncPassValue['obligations'] = prior ? structuredClone(prior.value.obligations)
    : { baseline_commit: context.source.last_commit, mismatch: {}, not_converged_streak: 0, faults: {} };
  obligations.mismatch ??= {}; obligations.faults ??= {}; obligations.not_converged_streak ??= 0;
  const abandoned = prior?.value.telemetry.outcome === 'open' ? (obligations.abandoned_streak ?? 0) + 1 : 0;
  if (abandoned) obligations.abandoned_streak = abandoned; else delete obligations.abandoned_streak;
  if (handover.episode && !obligations.episode) obligations.episode = handover.episode;
  const passId = randomUUID();
  // #6696: a cost-gate deferral rides as noEmbed but is this run's constraint (its requests carry embedDeferred), never an opt-out an episode keeps.
  const requested = opts.embedDeferred ? { ...input.processingOptions, noEmbed: false } : input.processingOptions;
  if (opts.full && !obligations.episode?.full_id) obligations.episode = { opened_at: startedAt, full_id: passId, selection,
    inherited: { noEmbed: requested.noEmbed, noExtract: requested.noExtract, noSchemaPack: requested.noSchemaPack, from: obligations.episode?.inherited.from ?? 'flag' } };
  // A pass that admits under an opt-out opens an episode carrying it (design §6), when it admits its first batch.
  const optOutEpisode: PassEpisode | null = !obligations.episode && (requested.noEmbed || requested.noExtract || requested.noSchemaPack) ? { opened_at: startedAt, selection,
    inherited: { noEmbed: requested.noEmbed, noExtract: requested.noExtract, noSchemaPack: requested.noSchemaPack, from: 'flag' } } : null;
  const episode = obligations.episode;
  // A flagless pass keeps the open episode's opt-outs (#6712 PR 1's inherited_options contract).
  const processingOptions: SyncProcessingOptions = { noEmbed: requested.noEmbed || !!episode?.inherited.noEmbed, noExtract: requested.noExtract || !!episode?.inherited.noExtract,
    noSchemaPack: requested.noSchemaPack || !!episode?.inherited.noSchemaPack };
  const inherited = (['noEmbed', 'noExtract', 'noSchemaPack'] as const).filter(key => processingOptions[key] && !requested[key]);
  const pack = processingOptions.noSchemaPack ? null : loadedPack?.identity ?? null;

  // The kind (design §2.2), from the real converged state.
  const converged = obligations.converged;
  const probe = converged ? rowProbe : null;
  const holds = (sourceHolds[0]?.holds ?? []).filter(hold => hold.incarnation === incarnation);
  // GBRA-133: a file_drift hold whose page moved since it was held is re-screened even when Git did not move.
  const driftMoved = (await movedDriftHolds(engine, sourceId, holds)).size > 0;
  // Working mode (design §2.2): the stat cache this process kept from the round its last stamp used; a cold process has none.
  const cacheKey = passFingerprint(sourceId, incarnation);
  const kindStarted = Date.now();
  const working = mode === 'working' && converged ? await workingIdleChange(context, recallWorkingStatCache(cacheKey)) : { changed: mode === 'working', cache: null };
  // A configured stamp writes last_commit = converged.target: a source whose last_commit moved since (a topology re-clone
  // clears it, as an upgrade's catch-up does) has no converged state to be idle against.
  const stamped = converged && (!configured || context.source.last_commit === converged.target) ? converged : null;
  const kindOf = syncPassKind({ converged: stamped ? { target: stamped.target, parserFp: stamped.parser_fp, pack: stamped.pack, selectionFp: stamped.selection_fp,
      passesSinceFull: stamped.passes_since_full, lastFullAt: Date.parse(stamped.last_full_at) } : null,
    head, parserFp, pack, selectionFp, now: started, openEpisode: !!episode, owedTail: tail !== null, retryRow: retry.length > 0,
    notConvergedStreak: obligations.not_converged_streak, mismatchStreak: Object.keys(obligations.mismatch).length,
    requestNewer: probe?.newer === true, openAtStampFinished: !!converged && (converged.open_at_stamp === null || (probe?.stillOpen ?? 0) < converged.open_at_stamp.length),
    writebackOpen: probe?.writebackOpen === true, workingChange: working.changed, rescreenDueHold: driftMoved || holds.some(hold => holdRescreenDue(hold, retry.includes(hold.path))), full: opts.full === true, fullRound: opts.fullRound === true });
  // Design §2.6: a withheld mass delete is applied by a full round once the owner host's env valve allows it.
  const valveOpen = !remote && !!obligations.deletes_withheld && massReconcileAllowed();
  // Design §4: keep_db writes the previous pass deferred (`keep_db_pending`: its cap, or write capacity) are owed to this pass, so it is
  // not idle, unless write capacity still stops them; then the idle tick stays idle instead of re-reading the tree every tick.
  const keepDbOwed = !remote && admission === 'normal' && kindOf.kind === 'idle' && (prior?.value.telemetry.classes?.keep_db_pending?.count ?? 0) > 0
    && !(await keepDbHeadroom(engine));
  const kind: PassKind = admission === 'classify_only' && kindOf.kind === 'idle' ? 'idle' : (valveOpen || keepDbOwed) && kindOf.kind === 'idle' ? 'full' : kindOf.kind;
  const value: ManagedSyncPassValue = { source_id: sourceId, incarnation, lease_token: lease.token, obligations,
    telemetry: { pass_id: passId, target: head, started_at: startedAt, ended_at: null, kind, round: 0, outcome: 'open', stop_reason: null, candidates: 0, settled: 0, remaining: 0,
      counts: {}, duration_ms: null, timings_ms: {} } };
  // The incarnation's legacy markers (§2.7 b1) are owed until a local pass wrote them, not only by its first row.
  const markersOwed = () => remote ? !prior : !value.obligations.legacy_markers_at;
  return { prior, admission, tail, retry, failed, holds, idleFacts, head, mode, selection, configured, selectionFp, parserFp, obligations, passId, optOutEpisode, episode,
    processingOptions, inherited, pack, converged, cacheKey, kindStarted, working, kind, value, markersOwed, heldDeletions, levelReuse };
}

/**
 * #7355: a level read that screens a large source for minutes before its first commit is progress too. `report` tells the
 * drain's governor it is working and, every PASS_HEARTBEAT_MS, saves the open row (what a follower and `sync status` read);
 * `pending` is that save, which the pass's next save waits for so an older row never lands over a newer one.
 */
function levelBeat(opts: SyncOpts, sliceBase: { pages: number }, save: () => Promise<void>): { report: () => void; readonly pending: Promise<void> | null } {
  let at = Date.now(), pending: Promise<void> | null = null;
  return {
    report: () => {
      opts.onProgress?.({ phase: 'managed_sync.level_progress', bankedFiles: sliceBase.pages });
      if (Date.now() - at < PASS_HEARTBEAT_MS || pending) return;
      at = Date.now();
      pending = save().catch(() => undefined).finally(() => { pending = null; });
    },
    get pending() { return pending; },
  };
}

/** A pass result that imported nothing, at the source's last commit. */
function emptyPassResult(context: ManagedSyncContext, remote: boolean, status: SyncResult['status'], reason?: SyncResult['reason']): SyncResult {
  return { status, fromCommit: remote ? null : context.source.last_commit, toCommit: remote ? '' : context.source.last_commit ?? '',
    added: 0, modified: 0, deleted: 0, renamed: 0, chunksCreated: 0, embedded: 0, pagesAffected: [], filesImported: 0, bankedFiles: 0, ...(reason ? { reason } : {}) };
}

/** Master's up_to_date for an idle tick (a complete check that found nothing): only last_sync_at, plus the pass row's count. */
async function stampIdlePass(engine: BrainEngine, input: SyncPassInput, lease: NonNullable<ReturnType<typeof currentDrainLease>>, started: number, pinned: Exclude<Awaited<ReturnType<typeof pinPass>>, { ended: SyncResult }>): Promise<SyncResult> {
  const { opts, context, authority, assertActive } = input;
  const { sourceId, incarnation } = context;
  const remote = authority.writer.remote;
  const { value, converged, episode, passId, kindStarted, failed, holds, idleFacts, tail, head, inherited } = pinned;
  const at = new Date().toISOString();
  value.obligations.converged = { ...converged!, passes_since_full: converged!.passes_since_full + 1 };
  value.obligations.stuck_since = null;
  // Design §7: an owner approval (--yes) on an idle tick still makes an unknown cost known again.
  if (opts.costApproved && value.obligations.cost?.approved_usd === null) value.obligations.cost = (await passCostDecision(engine, { sourceId, incarnation,
    scope: episode?.full_id ?? passId, priorRow: true, prior: value.obligations.cost, approved: true })).cost;
  value.telemetry = { ...value.telemetry, outcome: 'up_to_date', ended_at: at, duration_ms: Date.now() - started, timings_ms: { setup: kindStarted - started, kind: Date.now() - kindStarted } };
  await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], async () => {
    assertActive();
    // One round trip: the lease check, the stamp and the row (started at the transaction's clock) are pipelined; a lost
    // lease rolls the other two back.
    await pipelined(tx, [() => assertDrainLease(tx, sourceId), () => tx.executeRaw('UPDATE sources SET last_sync_at=now() WHERE id=$1 AND incarnation=$2::uuid', [sourceId, incarnation]),
      () => writePassRow(tx, value, { pin: true, clock: true })]);
  }, principalAttribution(authority.writer.principal)));
  // A failure is recorded only under the lease this pass holds, so none recorded at pin means none to clear.
  if (failed.length) await clearPassFailures(engine, sourceId, incarnation);
  // Nor can a tail be owed since the pin read none: the lease's holder reads none after it (sync-run.ts).
  lease.tailClear = !tail;
  lease.idleClear = idleClear({ tail: !!tail, holds: holds.length, ...idleFacts });
  return { ...emptyPassResult(context, remote, 'up_to_date'), toCommit: remote ? '' : head, ...(inherited.length ? { inherited_options: inherited } : {}) };
}

/**
 * A round's unsettled paths by what the pass does with them: deletes and imports to batch, in-flight writes to wait for,
 * settle mismatches, and owed paths it cannot settle. A path settled earlier in this pass is admitted at most once more.
 */
async function triageRound(level: ShadowLevel, input: { S: Map<string, string>; legacyWaived: Set<string>; readmitted: Set<string>; admission: string; remote: boolean;
  counts: { pausedDeletes: number }; consumeRetry: (paths: Iterable<string>) => Promise<void> }) {
  const { S, legacyWaived, readmitted, admission, remote, counts } = input;
  const settledPaths: string[] = [];
  const settledKey = (path: string, levelOid: string | null) => `${path}\0${levelOid ?? ''}`;
  const deletes: ShadowPath[] = [], imports: ShadowPath[] = [], inFlight: ShadowPath[] = [], mismatch: ShadowPath[] = [], owed: ShadowPath[] = [];
  const heldRenameOrigins = new Set(level.heldRenames.map(held => syncOriginPath(held.rename.sourcePath)));
  const step = loopYield();
  for (const entry of level.paths) {
    if (step.due()) await step.pause();
    const r = entry.result;
    if (r.settled) { settledPaths.push(entryPaths(level, entry.path).path); continue; }
    if (r.inFlight) { inFlight.push(entry); continue; }
    if (S.has(settledKey(entry.path, entry.state.level))) {
      // A hold this pass wrote or re-screened at L, a slug collision it skipped, or the origin deletion an identity hold keeps
      // (GBRA-130 B-4) is that path's fate here, even when its code re-screens every pass or the skipped twin still classifies as an import.
      if (entry.state.hold?.atLevel || ['collision', 'identity_origin'].includes(S.get(settledKey(entry.path, entry.state.level))!)
        || legacyWaived.has(settledKey(entryPaths(level, entry.path).path, entry.state.level))) continue;
      // Design §3.1: admitted at most once more per (path, level) in this pass, then counted as a settle mismatch.
      const again = settledKey(entry.path, entry.state.level);
      if (readmitted.has(again)) { mismatch.push(entry); continue; }
      readmitted.add(again);
    }
    if (r.action === 'delete') {
      if (heldRenameOrigins.has(syncOriginPath(entryPaths(level, entry.path).sourcePath))) { S.set(settledKey(entry.path, entry.state.level), 'rename_held'); continue; }
      if (admission !== 'normal') { S.set(settledKey(entry.path, entry.state.level), 'paused_deletes'); counts.pausedDeletes++; continue; }
      deletes.push(entry);
    } else if (r.action === 'import' || r.action === 'reparse' || (!remote && (r.cls === 'drift' || r.cls === 'dirty'))) imports.push(entry);
    else owed.push(entry);
  }
  await input.consumeRetry(settledPaths);
  return { deletes, imports, inFlight, mismatch, owed };
}

/**
 * v3 §3.3: a pass that finds nothing at last_commit = T admits no checkpoint; it keeps master's up_to_date (only
 * last_sync_at), and its full round refreshes the converged watermark so the next tick can be idle.
 */
async function stampUnchangedPass(engine: BrainEngine, input: SyncPassInput, round: { value: ManagedSyncPassValue; level: ShadowLevel; head: string; kind: PassKind;
  converged: ManagedSyncPassValue['obligations']['converged']; parserFp: string; pack: string | null; selectionFp: string; passId: string; startedAt: string; started: number;
  counts: Record<string, number>; applied: ReturnType<typeof newPassApplyState> }): Promise<void> {
  const { context, authority, assertActive } = input;
  const { sourceId, incarnation } = context;
  const { value, level, head, kind, converged, parserFp, pack, selectionFp, passId, startedAt, started, counts, applied } = round;
  const at = new Date().toISOString();
  await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], async () => {
    assertActive();
    await assertDrainLease(tx, sourceId);
    await tx.executeRaw('UPDATE sources SET last_sync_at=now() WHERE id=$1 AND incarnation=$2::uuid', [sourceId, incarnation]);
    // Holds on paths that left the level go with it here too, as a stamp releases them.
    for (const path of [...level.releasableHolds, ...await settledDeletionHolds(tx, sourceId, level.deletionCandidates)]) await clearGitHold(tx, { sourceId, incarnation, path, observedAt: startedAt });
    await recordPassFenceTrend(tx, { worktreeId: context.binding.worktree_id, sourceId, passId, since: converged?.request_hwm ?? null });
    const watermark = await readConvergedWatermark(tx, { worktreeId: context.binding.worktree_id, sourceId, incarnation }, null, OPEN_AT_STAMP_CAP, { prior: converged?.writeback });
    value.obligations.converged = { target: head, at, ...watermark, parser_fp: parserFp, pack, selection_fp: selectionFp,
      last_full_at: kind === 'full' || !converged ? at : converged.last_full_at, passes_since_full: kind === 'full' || !converged ? 0 : converged.passes_since_full + 1 };
    Object.assign(value.obligations, { not_converged_streak: 0, mismatch: {}, stuck_since: null });
    value.telemetry = { ...value.telemetry, outcome: 'up_to_date', ended_at: at, remaining: 0, duration_ms: Date.now() - started, counts: { ...counts, ...passApplyCounts(applied) },
      classes: applied.classes, ...(applied.summary ? { summary: applied.summary } : {}) };
    await writePassRow(tx, value);
  }, principalAttribution(authority.writer.principal)));
}

/**
 * Design §3.1: a path settled in this pass that does not classify settled is a settle mismatch, counted per (path, level)
 * across passes (lane B turns a streak of SETTLE_MISMATCH_STREAK into a settle_mismatch hold).
 */
function mismatchStreaks(before: ManagedSyncPassValue['obligations']['mismatch'], mismatched: ShadowPath[]): ManagedSyncPassValue['obligations']['mismatch'] {
  return Object.fromEntries(mismatched.map(entry => {
    const seen = before?.[entry.path];
    return [entry.path, { level: entry.state.level, streak: seen && seen.level === entry.state.level ? seen.streak + 1 : 1 }];
  }));
}

/** The pass of one managed, non-company source (module header). */
/** The refused request a blocked pass stopped on, when it replays unchanged under the fail policy (#6712 PR 3, L7); else null. */
async function unchangedBlockedRefusal(engine: BrainEngine, input: { sourceId: string; incarnation: string; root: string; head: string; blocked: { request_id: string; pass_id: string } }):
  Promise<{ row: WriteRequest; intent: SyncIntent } | null> {
  if ((await readSyncHoldPolicy(engine)).mode !== 'fail') return null;
  const [found] = await engine.executeRaw<{ id: string }>('SELECT id FROM persistence_requests WHERE source_id=$1 AND request_id=$2', [input.sourceId, input.blocked.request_id]);
  const row = found ? await getWriteRequestById(engine, found.id) : null;
  const intent = row?.intent as unknown as SyncIntent | null | undefined;
  if (!row || !intent || !['failed', 'conflict', 'cancelled'].includes(row.state)) return null;
  const recorded = await recordedStop(engine, passFingerprint(input.sourceId, input.incarnation), input.blocked.pass_id);
  return recorded && replaysUnchangedRefusal(row, recorded, { root: input.root, intent, target: intent.target ?? '', head: () => input.head }) ? { row, intent } : null;
}

/** Adds each present count of `add` to `counts`. */
function addCounts(counts: Record<string, number>, add: Record<string, number | undefined>): void {
  for (const [key, value] of Object.entries(add)) counts[key] = (counts[key] ?? 0) + (value ?? 0);
}

/**
 * #7149: a requested re-screen is consumed once the pass settled its path (imported, held, or settled at its level), not
 * only by the stamp: a pass that stopped before its stamp (timeout, writer_pending, not_converged) left the whole row
 * behind, so doctor kept reporting imported files as waiting and every later pass was forced to a full round. #7327: a
 * batch that stops (a deadline, a yield, a block) consumes those of the entries its cursor passed, so the next pass resumes
 * after them instead of re-screening every one again.
 */
function retryConsumer(engine: BrainEngine, sourceId: string, incarnation: string, retry: readonly string[]): (paths: Iterable<string>) => Promise<void> {
  const open = new Set(retry);
  return async paths => {
    if (!open.size) return;
    const taken = [...new Set(paths)].filter(path => open.has(path));
    if (!taken.length) return;
    await clearGitHoldRetryPaths(engine, sourceId, incarnation, taken);
    for (const path of taken) open.delete(path);
  };
}

/** The pass stamp (design v3.2 §3.3): what its converged checkpoint publishes; closing the open episode counts what it released. */
async function passStampFor(engine: BrainEngine, input: { context: ManagedSyncContext; head: string; slugMode: Cursor['slugMode']; episode: PassEpisode | undefined; selection: SyncSelection;
  configured: boolean; mode: SyncSelection['mode']; leaseToken: string; retry: string[]; level: ShadowLevel; selectionFp: string; parserFp: string; pack: string | null; full: boolean;
  counts: { added: number; modified: number; deleted: number; renamed: number; episodeReleased: number }; extract: boolean; since: string; rescreen: boolean;
  closures: typeof passEpisodeClosure }): Promise<PassStamp> {
  const { context, episode, configured, counts } = input;
  // Design §6: an open episode closes by inclusion (a) or at the configured selection (b); chunker_version only by (b) over U_config.
  const closure = episode ? await input.closures({ gitRoot: context.gitRoot, root: context.root, head: input.head, slugMode: input.slugMode, episode, pass: input.selection, configured,
    metafilePages: await readMetafilePagesMode(engine),
    configuredSelection: passSelection(await selectionPatterns(engine, { sourceId: context.sourceId } as SyncOpts), { sourceId: context.sourceId } as SyncOpts, context, input.mode) }) : null;
  const closesEpisode = closure?.closes === true;
  if (closure?.released) counts.episodeReleased = closure.released;
  return { leaseToken: input.leaseToken, incarnation: context.incarnation, configured, stampChunker: configured && (context.source.last_commit === null || (closesEpisode && !!episode?.full_id && closure!.stampChunker)),
    closesEpisode, retryTaken: [...input.retry], releasedHolds: input.level.releasableHolds, ...(input.level.deletionCandidates.length ? { deletionCandidates: input.level.deletionCandidates } : {}), selectionFp: input.selectionFp, parserFp: input.parserFp, pack: input.pack, full: input.full,
    changed: counts.added + counts.modified + counts.deleted + counts.renamed, extract: input.extract, since: input.since, ...(input.rescreen ? { rescreen: true as const } : {}) };
}

/**
 * #6926, folded into 4b: the round's fold (sync-pass-fold.ts), when its last import may carry the stamp; null keeps the stamp
 * path. A committed-mode local round folds only when its imports were its only unsettled paths: no delete, rename,
 * collision, in-flight write, owed or mismatched path, legacy waiver or retry row, no hold at S1 and none on an import, no
 * marker or spelling on one, and a marked `I⋈P` to prove against.
 */
function passFold(level: ShadowLevel, cache: PassLevelCache, round: { imports: ShadowPath[]; entries: PassEntry[]; unsettled: number; remote: boolean; episodeFullId: string | null }): PassFold | null {
  const base = !round.remote && level.mode === 'committed' && !round.unsettled ? passFoldBase(cache) : null;
  if (!base || base.mark.holds.length || !round.imports.length || round.entries.length !== round.imports.length || round.entries.some(entry => entry.action !== 'import' || entry.renameFrom)) return null;
  if (round.imports.some(entry => entry.state.hold || entry.state.marker || entry.state.spelling)) return null;
  return { base: base.mark, pages: base.pages, maxId: base.maxId, imports: round.imports.length, newPages: round.imports.filter(entry => entry.pageId === null).length,
    newRecords: round.imports.filter(entry => entry.state.record === null).length, episodeFullId: round.episodeFullId, scope: level.scope };
}

/** After a folded stamp: the pass row's obligations as the stamp left them (converged, the closed episode and the resets). */
async function adoptStampedObligations(engine: BrainEngine, value: ManagedSyncPassValue): Promise<void> {
  const stamped = (await readPassRow(engine, value.source_id, value.incarnation))?.value.obligations;
  if (!stamped) return;
  for (const key of Object.keys(value.obligations)) if (!(key in stamped)) delete (value.obligations as Record<string, unknown>)[key];
  Object.assign(value.obligations, stamped);
}

/** Pins the pass row under the drain lease; true when a caller abort stopped the pin (a job abort or a lost lease throws, leaving no row). */
async function pinPassRow(engine: BrainEngine, value: ManagedSyncPassValue, input: SyncPassInput): Promise<boolean> {
  try {
    await engine.transaction(async tx => {
      // The lease check and the clock read share a round trip: a lost lease aborts the transaction before the row is written.
      [, value.telemetry.started_at] = await Promise.all([assertDrainLease(tx, input.context.sourceId), databaseNow(tx)]);
      await writePassRow(tx, value, { pin: true });
      // An interrupt during the pin rolls the pin back with it: no `open` row is left for a pass that never ran.
      input.assertActive();
    });
    return false;
  } catch (error) {
    assertSyncDispatchActive();
    if (input.signal?.aborted && error instanceof Error && error.name === 'AbortError') return true;
    throw error;
  }
}

/**
 * The pass's level cache: its next round at the same commit reuses the tree; it dies with the pass. With `sync.level_reuse` its
 * first round starts from the `I⋈P` of this process's last pass of the source that ended synced (sync-tree-reuse.ts; taken
 * either way, so off drops it), and a synced end keeps its own.
 */
function openPassLevelCache(sourceId: string, incarnation: string, levelReuse: boolean): PassLevelCache {
  const kept = takePassPages<NonNullable<PassLevelCache['pages']>>([sourceId, incarnation]);
  return { pages: levelReuse ? kept : undefined };
}

/** Design §7 (v3 §7): whether this batch crossed the approved envelope, which defers embeddings for the rest of the pass. */
async function envelopeCrossed(engine: BrainEngine, value: ManagedSyncPassValue, costScope: string, processingOptions: SyncProcessingOptions): Promise<boolean> {
  const envelope = value.obligations.cost;
  if (!envelope) return false;
  envelope.reserved_usd = (await readReservedUsd(engine, value.source_id, value.incarnation, costScope)).usd;
  if (processingOptions.noEmbed || envelope.approved_usd === null || envelope.reserved_usd <= 0 || envelope.reserved_usd < envelope.approved_usd) return false;
  processingOptions.noEmbed = true;
  return true;
}

/** #7243: a round's level read, then its `managed_sync.round_level` progress event, so a long round (the legacy sweep, the import walk) says where it stands first. */
async function readLevelReporting(engine: BrainEngine, levelInput: Parameters<typeof readShadowLevel>[1], round: number, onProgress: SyncOpts['onProgress']): Promise<Awaited<ReturnType<typeof readShadowLevel>>> {
  const started = Date.now();
  const level = await readShadowLevel(engine, levelInput);
  if (level) onProgress?.({ phase: 'managed_sync.round_level', round: { round, target: level.head, paths: level.paths.length, read_ms: Date.now() - started } });
  return level;
}

export async function runSyncPass(engine: BrainEngine, input: SyncPassInput): Promise<SyncResult> {
  const { opts, context, authority, assertActive } = input;
  const { sourceId, incarnation } = context, remote = authority.writer.remote;
  const lease = currentDrainLease(sourceId);
  if (!lease) throw new Error(`The live sync pass of ${sourceId} runs only under the source's drain lease.`);
  lease.tailClear = false; lease.idleClear = false;
  const started = Date.now(), startedAt = new Date(started).toISOString();
  const pinned = await pinPass(engine, input, lease, started);
  if (pinned.ended) return pinned.ended;
  const { prior, admission, tail, retry, failed, mode, selection, configured, selectionFp, parserFp, obligations, passId, optOutEpisode,
    processingOptions, inherited, pack, converged, cacheKey, working, kind, value, markersOwed, heldDeletions, levelReuse } = pinned;
  let { head, episode } = pinned;

  if (kind === 'idle' && working.cache) rememberWorkingStatCache(cacheKey, working.cache);
  if (kind === 'idle') return stampIdlePass(engine, input, lease, started, pinned);
  // Design §7: the cost decision at pin; an unknown or spent envelope defers embeddings for this pass (never inherited).
  const costScope = episode?.full_id ?? passId;
  const costDecision = await passCostDecision(engine, { sourceId, incarnation, scope: costScope, priorRow: !!prior, prior: obligations.cost, approved: opts.costApproved === true });
  obligations.cost = costDecision.cost;
  let costDeferred: string | null = null;
  if (costDecision.defer && !processingOptions.noEmbed) { processingOptions.noEmbed = true; costDeferred = costDecision.defer; }

  const counts = { added: 0, modified: 0, deleted: 0, renamed: 0, chunks: 0, waivedImports: 0, waivedDeletes: 0, held: 0, pausedDeletes: 0, collisions: 0, episodeReleased: 0, costDeferred: costDeferred ? 1 : 0,
    skippedContextualMode: 0, skippedCanonicalBytes: 0 };
  const collisions: SyncSlugCollision[] = [];
  // What the batches report beside their counts, as a cursor run reported it: committed pages' size states and #5751's legacy skips.
  let sizeStates: SyncSizeStates | undefined;
  const foldReport = (sizes: SyncSizeStates | undefined) => {
    if (sizes?.total) sizeStates = { total: (sizeStates?.total ?? 0) + sizes.total, pages: [...sizeStates?.pages ?? [], ...sizes.pages].slice(0, SIZE_STATE_SAMPLE) };
  };
  const S = new Map<string, string>();
  // #5751: (path, level) keys a legacy kernel waiver passed. The waiver records no import, so the path classifies as before;
  // it is settled for this pass (never re-admitted, never a settle mismatch) and re-screened by the next one.
  const legacyWaived = new Set<string>();
  const settledKey = (path: string, level: string | null) => `${path}\0${level ?? ''}`;
  // The entries this round's batches settled before the round folds its candidates into S: a slice that stops mid-round
  // reports them (yieldSettled); a blocked stop reports S as it replays.
  let roundSettled = 0, yieldSettled = 0;
  const retryConsumed = new Set<string>(retry), consumeRetry = retryConsumer(engine, sourceId, incarnation, remote ? [] : retry);
  const sliceBase = { started: performance.now(), pages: 0 };
  let batchNo = 0, waits = 0, candidatesFirst = 0;
  let lastMismatch: ShadowPath[] = [];
  let lastLevel: ShadowLevel | null = null;
  const rememberLevel = () => { if (lastLevel?.workingCache) rememberWorkingStatCache(cacheKey, lastLevel.workingCache); };
  const applied = newPassApplyState();
  const readmitted = new Set<string>();
  // #6926, folded into 4b: the head a round's last import stamped, and what the pass had done by then.
  let folded: { head: string; done: string } | null = null, batchFolded = false;
  const doneKey = () => JSON.stringify([counts, passApplyCounts(applied)]);
  const closures = passClosureMemo();
  const stampFor = (level: ShadowLevel) => passStampFor(engine, { context, head, slugMode: levelSlugMode, episode, selection, configured, mode, leaseToken: lease.token, retry, level, selectionFp, parserFp,
    pack, full: kind === 'full', counts, extract: !processingOptions.noExtract, since: value.telemetry.started_at, rescreen: legacyWaived.size > 0, closures });

  const save = async (outcome: PassOutcome, stopReason: string | null, pin = false, fenced = true, onlyOpen = false) => {
    await beat.pending; const ended = outcome !== 'open';
    if (ended && outcome !== 'synced') {
      const open = await openPassRequests(engine, { sourceId, passId, carried: value.obligations.pending_requests ?? [] });
      if (open.length) value.obligations.pending_requests = open; else delete value.obligations.pending_requests;
    }
    value.telemetry = { ...value.telemetry, outcome, stop_reason: stopReason, settled: S.size + yieldSettled, counts: { ...counts, ...passApplyCounts(applied) },
      classes: applied.classes, ...(applied.summary ? { summary: applied.summary } : {}),
      ...(ended ? { ended_at: new Date().toISOString(), duration_ms: Date.now() - started } : {}) };
    if (outcome === 'blocked' || stopReason === 'not_converged') value.obligations.stuck_since ??= new Date().toISOString();
    await engine.transaction(async tx => { if (fenced) await assertDrainLease(tx, sourceId); await writePassRow(tx, value, { pin, onlyOpen }); });
  };
  // GBRA-108: a committed legacy-sweep slice is progress the row and the drain's governor see; #7355: so is a level read still working (`levelBeat`).
  const onSwept = async () => { assertActive(); await save('open', null); opts.onProgress?.({ phase: 'managed_sync.legacy_swept', bankedFiles: sliceBase.pages }); }, beat = levelBeat(opts, sliceBase, () => save('open', null));
  const identityDowngrades: DowngradedRename[] = [];
  const fileRefusals = new Map<string, SyncFileRefusal>();
  const keptCount = () => lastLevel?.paths.filter(entry => entry.result.cls === 'kept').length ?? 0;
  const result = (status: SyncResult['status'], reason?: SyncResult['reason']): SyncResult => ({ status, fromCommit: remote ? null : context.source.last_commit, toCommit: remote ? '' : head,
    added: counts.added, modified: counts.modified, deleted: counts.deleted, renamed: counts.renamed, chunksCreated: counts.chunks, embedded: 0, pagesAffected: [],
    filesImported: sliceBase.pages, bankedFiles: sliceBase.pages, waived: { imports: counts.waivedImports, deletes: counts.waivedDeletes }, prescreened: 0,
    ...(counts.skippedContextualMode || counts.skippedCanonicalBytes ? { legacySkips: { contextualMode: counts.skippedContextualMode, canonicalBytes: counts.skippedCanonicalBytes } } : {}),
    ...(collisions.length ? { slugCollisions: collisions } : {}), ...(fileRefusals.size ? { fileRefusals: [...fileRefusals.values()] } : {}), ...(identityDowngrades.length ? { identityDowngrades } : {}), ...(inherited.length ? { inherited_options: inherited } : {}), ...(reason ? { reason } : {}),
    ...(sizeStates ? { size_states: sizeStates } : {}), ...(keptCount() ? { working_tree_kept: keptCount() } : {}),
    pass: { pass_id: passId, kind, round: value.telemetry.round, outcome: value.telemetry.outcome, stop_reason: value.telemetry.stop_reason, candidates: candidatesFirst,
      settled: S.size + yieldSettled, remaining: value.telemetry.remaining, not_converged_streak: value.obligations.not_converged_streak } });
  // A caller abort records the stop on the pass row (the pin it rolled back is replaced).
  if (await pinPassRow(engine, value, input)) { await save('resumable', 'timeout', true).catch(() => undefined); return result('partial', 'timeout'); }
  assertActive();
  registerPassCost(passId, { sourceId, incarnation, scope: costScope, pricePerMTok: currentEmbeddingPricePerMTok() });
  /** The batch cursor sync-run.ts drains: the discovery shape with no cursor row behind it. */
  const batchCursor = (entries: PassEntry[], stamp?: PassStamp): Cursor => ({ binding: { ...context.binding, owner_epoch: String(context.binding.owner_epoch), topology_generation: String(context.binding.topology_generation) },
    root: context.root, gitRoot: context.gitRoot, sourceId, incarnation, from: folded?.head ?? context.source.last_commit, target: head, entries, slugMode: levelSlugMode, discoveredAt: startedAt,
    runId: passId, passId, index: 0, authority, processingOptions, syncOptions: input.syncOptions, counts: { added: 0, modified: 0, deleted: 0, chunks: 0 },
    failureKey: passFingerprint(sourceId, incarnation), resumeArgs: passResumeArgs(sourceId, { value, updated_at: startedAt }), ...(episode?.full_id ? { fullEpisode: episode.full_id } : {}), ...(stamp ? { stamp } : {}) });
  let levelSlugMode: Cursor['slugMode'] = 'git-root';
  /** Drains one batch; a stop is the pass's ending, and `stop` folds that batch's counts in. */
  const drain = async (entries: PassEntry[], stamp?: PassStamp): Promise<SyncResult | null> => {
    const key = `${PASS_BATCH_KEY_PREFIX}${passId}:${batchNo++}`;
    for (const entry of entries) if (entry.pageId != null) applied.recorded.add(entry.pageId);
    const batch = batchCursor(entries, stamp);
    const drained = await input.drainBatch(key, batch, sliceBase);
    if ('entries' in drained) {
      const c = drained.counts;
      batchFolded = c.folded === true;
      addCounts(counts, { added: c.added, modified: c.modified, deleted: c.deleted, renamed: c.renamed, chunks: c.chunks, waivedImports: c.waived?.imports, waivedDeletes: c.waived?.deletes,
        held: c.held, skippedContextualMode: c.skippedContextualMode, skippedCanonicalBytes: c.skippedCanonicalBytes });
      for (const index of drained.passLegacyWaived ?? []) legacyWaived.add(settledKey(entries[index]!.path, entries[index]!.level));
      sliceBase.pages += drained.index;
      roundSettled += drained.index;
      foldReport(c.sizeStates);
      return null;
    }
    return await consumeRetry(entries.slice(0, drained.managedCursor?.index ?? 0).map(entry => entry.path)).then(() => drained);
  };
  const levelCache = openPassLevelCache(sourceId, incarnation, levelReuse);
  /** The pass ended on its stamp; a folded one (sync-pass-fold.ts) saves the round's telemetry beside the obligations it wrote. */
  const synced = async (onFold: boolean): Promise<SyncResult> => {
    if (onFold) await save('synced', configured ? null : 'selection_scoped');
    rememberLevel();
    if (levelReuse && levelCache.pages) keepPassPages([sourceId, incarnation], { ...levelCache.pages, key: levelCache.pages.acrossKey, across: true });
    await clearPassFailures(engine, sourceId, incarnation);
    await finishPassApply(engine, sourceId, applied);
    return result(configured && context.source.last_commit === null ? 'first_sync' : 'synced', configured ? undefined : 'selection_scoped');
  };
  const stop = async (drained: SyncResult): Promise<SyncResult> => {
    addCounts(counts, { added: drained.added, modified: drained.modified, deleted: drained.deleted, renamed: drained.renamed, chunks: drained.chunksCreated, waivedImports: drained.waived?.imports,
      waivedDeletes: drained.waived?.deletes, skippedContextualMode: drained.legacySkips?.contextualMode, skippedCanonicalBytes: drained.legacySkips?.canonicalBytes });
    sliceBase.pages += drained.filesImported ?? 0;
    foldReport(drained.size_states);
    // A slice that stops mid-batch (a writer yield, a deadline, an abort) settled the entries its cursor passed: they count as
    // settled and leave the round's remaining; a blocked stop reports what its replay reports.
    if (drained.status !== 'blocked_by_failures') {
      const passed = drained.managedCursor?.index ?? 0;
      yieldSettled = roundSettled + passed;
      value.telemetry.remaining = Math.max(0, value.telemetry.remaining - passed);
    }
    const outcome: PassOutcome = drained.status === 'blocked_by_failures' ? 'blocked' : 'resumable';
    const blockedOn = drained.managedWrite?.path ? drained.managedWrite.write_request.request_id : null;
    if (outcome === 'blocked' && blockedOn && obligations.blocked?.request_id !== blockedOn) obligations.blocked = { request_id: blockedOn, pass_id: passId };
    await save(outcome, drained.reason ?? (outcome === 'blocked' ? 'blocked_by_failures' : null));
    const { runId: _run, managedCursor: _cursor, ...rest } = drained;
    return { ...rest, ...result(drained.status, drained.reason) };
  };

  try {
    // A page refusal the last pass stopped on replays, with no new request, while what decided it is unchanged (#6712 PR 3, L7).
    // Under the hold policy the next pass re-admits it instead, and its refusal settles as a hold.
    const blocked = obligations.blocked;
    delete obligations.blocked;
    const failed = blocked ? await unchangedBlockedRefusal(engine, { sourceId, incarnation, root: context.root, head, blocked }) : null;
    assertActive();
    if (failed) {
      obligations.blocked = blocked;
      const replay: Cursor = { ...batchCursor([]), runId: blocked!.pass_id, pending: { requestId: failed.row.request_id, slug: failed.row.slug, pageId: failed.row.page_id, intent: failed.intent } };
      const drained = await input.drainBatch(`${PASS_BATCH_KEY_PREFIX}${passId}:${batchNo++}`, replay, sliceBase);
      if (!('entries' in drained)) return await stop(drained);
    }
    for (let round = 1; round <= PASS_MAX_ROUNDS; round++) {
      assertActive();
      value.telemetry.round = round;
      input.onLevelRead(head);
      // The previous round's level is done with: dropped before the next one is read, so a large source holds one level, not two.
      lastLevel = null;
      await faultPoint('sync:round_start', { sourceId, round });
      // A folded writeback stamp whose Git effect moved HEAD by exactly the pass's own bytes ends the pass on that stamp.
      if (folded && mode === 'committed' && await ownWritebackCommit(engine, { gitRoot: context.gitRoot, localPath: context.binding.local_path ?? context.root, from: folded.head,
        writeIds: value.obligations.converged?.writeback ?? [] })) return synced(true);
      const levelInput = { sourceId, context, workingTree: mode === 'working',
        pass: { noSchemaPack: processingOptions.noSchemaPack, episodeFullId: episode?.full_id ?? null, retryConsumed: round > 1 ? retryConsumed : undefined, exclude: opts.exclude, includeHidden: opts.includeHidden, strategy: opts.strategy, bootstrap: markersOwed(),
          slugMode: value.obligations.slug_mode, cache: levelCache, levelReuse, passId, recorded: applied.recorded, onProgress: beat.report, assertActive } };
      const level = await readLevelReporting(engine, levelInput, round, opts.onProgress);
      await faultPoint('sync:level_read', { sourceId, round, level: level ? { statements: level.statements, confirm: level.confirm ?? null, reused: level.reused ?? 0, shadow: level, input: levelInput } : undefined });
      assertActive();
      if (!level) throw new Error(`Source ${sourceId} became a company-brain source during its sync pass.`);
      // Each round reads the level at the current HEAD, and its batches freeze that commit (a commit landing mid-pass is
      // imported by the next round, never frozen from an older pin it is not in).
      head = value.telemetry.target = level.head;
      levelSlugMode = level.slugMode;
      lastLevel = level;
      for (const refusal of level.fileRefusals ?? []) fileRefusals.set(refusal.path, refusal);
      value.telemetry.timings_ms = level.timings_ms;
      // Design §2.7 (b1): until the incarnation's markers are written (an aborted or failed first pass wrote none), not only on its first row.
      if (markersOwed() && !remote) {
        await writeLegacyMarkers(engine, level);
        value.obligations.legacy_markers_at = new Date().toISOString();
      }
      const roundInput = { passId, observedAt: startedAt, remote, admission, fullRound: kind === 'full', obligations: value.obligations, context, processingOptions, grantPrefixes: remote ? authority.writer.slugPrefixes : null, onSwept, heldDeletions };
      await applyPassRound(engine, level, roundInput, applied);
      assertActive();
      if (!remote) value.obligations.deletes_withheld = applied.withheld?.set_hash ?? null;
      const { deletes, imports, inFlight, mismatch, owed } = await triageRound(level, { S, legacyWaived, readmitted, admission, remote, counts, consumeRetry });
      // Earlier passes' requests that committed since they stopped are this pass's imports (sync-pass-carried.ts).
      if (value.obligations.pending_requests?.length) {
        const carried = await settleCarried(engine, value.obligations.pending_requests);
        addCounts(counts, carried.counts);
        sliceBase.pages += carried.counts.added + carried.counts.modified + carried.counts.renamed;
        if (carried.open.length) value.obligations.pending_requests = carried.open; else delete value.obligations.pending_requests;
      }
      lastMismatch = mismatch;
      const candidates = deletes.length + imports.length;
      if (round === 1) candidatesFirst = candidates + inFlight.length + owed.length;
      value.telemetry.candidates = candidatesFirst;
      value.telemetry.remaining = candidates + inFlight.length + owed.length + mismatch.length;
      if (admission === 'classify_only') { await save('resumable', 'admission_paused'); return result('partial', 'admission_paused'); }
      if (!candidates && inFlight.length && waits < IN_FLIGHT_WAITS) {
        waits++; round--;
        startPersistenceConsumer(engine, loadConfig() ?? { engine: engine.kind }).wake(true);
        const credited = await awaitInFlight(engine, level, inFlight, opts.drainStartedAt ? 30_000 : 5_000, assertActive, value.obligations.pending_requests);
        Object.assign(counts, { added: counts.added + credited.added, modified: counts.modified + credited.modified, deleted: counts.deleted + credited.deleted, renamed: counts.renamed + credited.renamed });
        const carried = value.obligations.pending_requests?.filter(id => !credited.committed.includes(id));
        if (carried?.length) value.obligations.pending_requests = carried; else delete value.obligations.pending_requests;
        sliceBase.pages += credited.added + credited.modified + credited.renamed;
        continue;
      }
      if (!candidates && inFlight.length) {
        await save('resumable', 'writer_pending');
        // The request an agent waits on, as the cursor's writer_pending named it.
        const waiting = remote ? null : await openInFlightRequest(engine, level, inFlight);
        return { ...result('partial', 'writer_pending'), ...(waiting?.intent ? { managedWrite: managedSyncWriteDiagnostic({ sourceId, root: context.root, processingOptions,
          syncOptions: input.syncOptions ?? null }, { slug: waiting.slug, intent: waiting.intent as unknown as SyncIntent }, waiting) } : {}) };
      }
      if (!candidates) {
        if (remote) {
          // Design §5: a remote caller stops after its one-sided work; the owner host settles and stamps the rest.
          const reconcile = remoteReconcile(level, { committed: counts.added + counts.modified + counts.deleted + counts.renamed, grantPrefixes: authority.writer.slugPrefixes });
          await save('blocked', 'reconcile_host_required');
          return { ...result('blocked_by_failures', 'reconcile_host_required'), reconcile };
        }
        if (mismatch.length || owed.length) break;
        if (round === 1 && configured && context.source.last_commit === head && !episode && !retry.length && !tail && !value.obligations.slug_mode) {
          // v3 §3.3: a pass that finds nothing at last_commit = T admits no checkpoint (`stampUnchangedPass`).
          await stampUnchangedPass(engine, input, { value, level, head, kind, converged, parserFp, pack, selectionFp, passId, startedAt, started, counts, applied });
          rememberLevel();
          await clearPassFailures(engine, sourceId, incarnation);
          await finishPassApply(engine, sourceId, applied);
          return { ...result('up_to_date'), fromCommit: remote ? null : head };
        }
        // #6926: a round after a folded stamp that confirmed the level and did nothing more ends on that stamp.
        if (folded?.head === head && level.confirm?.taken && !applied.recorded.size && folded.done === doneKey()) return synced(true);
        const stamp = await stampFor(level);
        await save('open', null);
        const stopped = await drain([], stamp);
        if (stopped) return stop(stopped);
        value.telemetry = { ...value.telemetry, outcome: 'synced', stop_reason: configured ? null : 'selection_scoped', remaining: 0 };
        return synced(false);
      }
      opts.onProgress?.({ phase: 'managed_sync.round_admit', round: { round, target: head, paths: level.paths.length, imports: imports.length, deletes: deletes.length, in_flight: inFlight.length } });
      const built = await batchEntries(engine, level, deletes, imports).catch(async (error: unknown) => {
        if ((error as { code?: string } | null | undefined)?.code === 'page_identity_changed') await save('blocked', 'page_identity_changed');
        throw error;
      });
      collisions.push(...built.collisions);
      if (!remote && built.identity.length) await holdPassIdentities(engine, level, { passId, observedAt: startedAt }, applied, built.identity);
      for (const { entry, origin } of built.identity) {
        S.set(settledKey(entry.path, entry.state.level), 'held');
        if (origin) S.set(settledKey(origin.path, origin.state.level), 'identity_origin');
      }
      identityDowngrades.push(...built.downgrades.filter(pair => !identityDowngrades.some(seen => seen.from === pair.from && seen.to === pair.to)));
      for (const entry of [...built.skipped, ...built.collisions.flatMap(c => c.skipped.map(sourcePath => imports.find(i => entryPaths(level, i.path).sourcePath === sourcePath)!))].filter(Boolean)) {
        S.set(settledKey(entry.path, entry.state.level), 'collision'); counts.collisions++;
      }
      if (optOutEpisode && !value.obligations.episode && built.entries.length) value.obligations.episode = episode = optOutEpisode;
      // #6694: the mode this pass publishes pages under is recorded before the first of them, so a pin changed before the stamp refuses there.
      if (level.scope && built.entries.length && !value.obligations.slug_mode) { value.obligations.slug_mode = level.slugMode; await save('open', null); }
      const fold = passFold(level, levelCache, { imports, entries: built.entries, unsettled: deletes.length + inFlight.length + owed.length + mismatch.length + legacyWaived.size + retry.length,
        remote, episodeFullId: episode?.full_id ?? null });
      for (let i = 0; i < built.entries.length; i += PASS_BATCH_MAX) {
        const chunk = built.entries.slice(i, i + PASS_BATCH_MAX), last = !!fold && i + chunk.length >= built.entries.length; opts.onProgress?.({ phase: 'managed_sync.round_batch', round: { round, target: head, paths: level.paths.length, batch: i / PASS_BATCH_MAX + 1, batches: Math.ceil(built.entries.length / PASS_BATCH_MAX), base: i } });
        // A folded stamp writes the pass row with the obligations as they stand when its import is frozen.
        const stopped = await drain(chunk, last ? { ...await stampFor(level), fold: { ...fold, obligations: structuredClone(value.obligations), batch: chunk.length } } : undefined);
        if (stopped) return stop(stopped);
        await consumeRetry(chunk.map(entry => entry.path));
        value.telemetry.remaining = Math.max(0, built.entries.length - i - chunk.length) + inFlight.length + owed.length + mismatch.length;
        if (await envelopeCrossed(engine, value, costScope, processingOptions)) counts.costDeferred = 1;
        if (last && batchFolded) { await adoptStampedObligations(engine, value); folded = { head, done: doneKey() }; continue; } // the stamp wrote the pass row
        await save('open', null);
      }
      // Every candidate of the round settled: committed, waived, held, deferred to a hold, a collision, or (a rename's
      // deletion) carried by its import.
      for (const entry of [...deletes, ...imports]) if (!S.has(settledKey(entry.path, entry.state.level))) S.set(settledKey(entry.path, entry.state.level), 'settled');
      if (!remote) await sweepLegacy(engine, level, roundInput, applied);
      roundSettled = 0;
      lastMismatch = [];
    }
    // Not converged (design §3.1): four rounds, or a settle mismatch or a path this release cannot settle.
    // A path settled in this pass that does not classify settled is a settle mismatch: counted per (path, level) across
    // passes; lane B turns a streak of SETTLE_MISMATCH_STREAK into a settle_mismatch hold.
    value.obligations.mismatch = mismatchStreaks(value.obligations.mismatch, lastMismatch);
    value.obligations.not_converged_streak = (value.obligations.not_converged_streak ?? 0) + 1;
    await finishPassApply(engine, sourceId, applied);
    await save('resumable', 'not_converged');
    return result('partial', 'not_converged');
  } catch (error) {
    assertSyncDispatchActive();
    if (error instanceof SyncAdmissionPaused) { await save('resumable', 'admission_paused').catch(() => undefined); return result('partial', 'admission_paused'); }
    if (input.signal?.aborted && error instanceof Error && error.name === 'AbortError') {
      // A folded stamp with nothing since ended the pass: the abort stops nothing it owes.
      if (folded?.done === doneKey()) return synced(true);
      await save('resumable', 'timeout', false, true, true).catch(() => undefined); return result('partial', 'timeout');
    }
    // A Git listing that did not finish cleanly classifies nothing (design v3.2 §9): the pass stops blocked, having written nothing for that round.
    if (error instanceof SyncTreeReadIncomplete) { await save('blocked', 'reconcile_read_incomplete').catch(() => undefined); return result('blocked_by_failures', 'reconcile_read_incomplete'); }
    const stop = resumableRowStop(error); if (stop) await save('resumable', stop, false, stop !== 'lease_lost', true).catch(() => undefined); throw error;
  } finally {
    unregisterPassCost(passId);
  }
}

/**
 * The pin's start time from the database clock: `sync.admission`'s `effective` compares it with `set_at` (the database's
 * `clock_timestamp()`), so a host clock running ahead cannot make a restriction look effective early.
 */
async function databaseNow(tx: Pick<BrainEngine, 'executeRaw'>): Promise<string> {
  const [row] = await tx.executeRaw<{ at: string | Date }>('SELECT now() AS at');
  return new Date(row!.at).toISOString();
}

/** A converged or idle pass clears what earlier stops recorded: the pass row's failure key and the incarnation's cursor key. */
async function clearPassFailures(engine: BrainEngine, sourceId: string, incarnation: string): Promise<void> {
  await Promise.all(passFailureKeys(sourceId, incarnation).map(key => clearManagedSyncFailureAfterSuccess(engine, key)));
}

export type { SyncAdmission };
