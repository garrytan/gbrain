/**
 * #6712 PR 4a (design v3.1 §11 step 2, v3.2 §9 and §11): the convergence receipt, the one schema the read-only dry run
 * (`gbrain sync --dry-run --json`'s `convergence`), `sync status --detail`'s `convergence` and doctor's counts share.
 * Built from the shadow level (sync-pass.ts); every value is a prediction (`dry_run: true`), nothing is admitted.
 *
 * - `classes`: `{<class>: {count, action}}` with `action ∈ none | owner | repair` (the glossary, sync-classify.ts
 *   `syncClassAction`); `in_flight`, `keep_db_pending` and `deletes_withheld` are classes here too.
 * - `decisions`: the `file_drift` holds the pass would write, by side, after the read-only `sameContentAtOrigin` screen
 *   of each drift path (a dry run only, at most `SCREEN_CAP` paths): equal content is a `same_content_noops` settle, an
 *   unscreened path is counted in `screen_unknown`, never as a decision.
 * - `deletes`: the delete candidates with #2828's valve verdict; PR 4b withholds a tripped set and
 *   `GBRAIN_ALLOW_MASS_RECONCILE=1` applies it.
 * - `samples`: at most 20 paths per non-matched class with reason and action tag; `--redact-paths` replaces each path
 *   with a sha256 prefix and drops slugs, so the counts can be shared.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { MASS_RECONCILE_MIN_PAGES, MASS_RECONCILE_RATIO, massReconcileAllowed } from '../sync-reconcile.ts';
import { syncClassAction, type SyncClass, type SyncClassAction } from './sync-classify.ts';
import { readBlobs } from './sync-git-stream.ts';
import type { ShadowLevel, ShadowPath } from './sync-pass.ts';
import { readSyncFile, type ManagedSyncContext } from './sync-discovery.ts';
import { managedSyncAuthority, type SyncProcessingOptions } from './sync-authority.ts';
import { screeningRequest } from './noop-kernel.ts';
import { prepareManagedSyncMutation, type SyncIntent } from './sync-prepare.ts';
import { sha256 } from './digest.ts';

/** keep_db DB-wins writes one pass admits (design v3.2 §4, [estimated]); the rest are `keep_db_pending`. */
export const KEEP_DB_PASS_CAP = 200;
/** Drift paths one dry run screens with the read-only `sameContentAtOrigin`. */
export const SCREEN_CAP = 200;

export type ConvergenceClassKey = SyncClass | 'in_flight' | 'keep_db_pending' | 'deletes_withheld';
export interface ConvergenceSample { path: string; slug?: string; reason: string; action: SyncClassAction }
/** Screens drift paths: `same` (the import would change nothing), `differs`, or `unknown` (it could not run). */
export type ConvergenceScreen = (level: ShadowLevel, paths: ShadowPath[]) => Promise<Map<string, 'same' | 'differs' | 'unknown'>>;

export interface ConvergenceReceipt {
  schema: 'convergence/1'; dry_run: true; source_id: string; pass_id: null; kind: ShadowLevel['kind']; kind_blockers: string[];
  mode: ShadowLevel['mode']; target: string; baseline_commit: string | null; converged_at: null; round: 1; full: boolean;
  candidates: number; settled: number; remaining: number; in_flight: number; eta_seconds: null; eta_reason: 'shadow';
  counts: Partial<Record<ConvergenceClassKey, number>>;
  classes: Partial<Record<ConvergenceClassKey, { count: number; action: SyncClassAction }>>;
  decisions: { both: number; unknown: number; deleted: number };
  same_content_noops: number; screen_unknown: number; screen_skipped?: 'not_a_dry_run' | 'screen_unavailable';
  would_hold: number;
  keep_db_admitted: number; keep_db_pending: number; keep_db_authorized: number;
  db_ahead: { pending: number; db_only: number; unproven: number; by_prefix: Record<string, number> };
  db_ahead_by_prefix: Record<string, number>; full_skipped_db_ahead: number;
  legacy_unverified: number; legacy_pageless: number;
  deletes: { count: number; reconcilable: number; ratio: number; verdict: 'apply' | 'withheld' | 'allowed_by_env'; set_hash: string | null; samples: string[] };
  deletes_withheld: { count: number; ratio: number; set_hash: string | null; samples: string[] } | null;
  samples: Partial<Record<ConvergenceClassKey, ConvergenceSample[]>>;
  settle_mismatch: string[]; episode: null; admission: null; last_full_at: null;
  redacted: boolean; duration_ms: number; timings_ms: Record<string, number>; statements: number;
}

const redact = (path: string) => `sha256:${createHash('sha256').update(path).digest('hex').slice(0, 16)}`;

function reasonOf(entry: ShadowPath): string {
  const { state, result } = entry;
  switch (result.cls) {
    case 'held': return 'held at this level';
    case 'spelling': return 'origins differ only by case or separator';
    case 'delete': return 'file gone from the tree; the page has no database-only change';
    case 'delete_drift': return 'file gone from the tree; the page changed in the database';
    case 'deleted_edited': return `page deleted; file differs (${result.state})`;
    case 'dirty': return `working copy ${state.dirty ?? 'unknown'}`;
    case 'adopt': return 'the bytes are the attested publication';
    case 'reparse': return !state.record?.parserSame ? 'parser or schema pack changed' : !state.page?.originMatches ? 'origin changed' : 'full re-import';
    case 'db_ahead': return `database ahead (${result.sub})`;
    case 'import': return state.page?.live ? 'file changed; the database has no unseen change' : 'new file';
    case 'legacy_unverified': return 'no import record; unchanged since the baseline';
    case 'keep_db': return 'keep_db prefix: the database wins on a clean committed file';
    case 'drift': return `file and database both changed (side ${result.side})`;
    default: return result.cls;
  }
}

/** The receipt of one shadow level. `screen` runs only for dry runs; status and doctor pass `false`. */
export async function buildConvergenceReceipt(_engine: BrainEngine, level: ShadowLevel, opts: { redactPaths: boolean; sampleCap: number; screen: ConvergenceScreen | false }): Promise<ConvergenceReceipt> {
  const started = performance.now();
  const keyed: Array<{ entry: ShadowPath; key: ConvergenceClassKey }> = [];
  let keepDbSeen = 0;
  const deletes = level.paths.filter(entry => entry.result.cls === 'delete' && !entry.result.inFlight);
  const ratio = level.reconcilable ? deletes.length / level.reconcilable : 0;
  const tripped = level.reconcilable > MASS_RECONCILE_MIN_PAGES && deletes.length > level.reconcilable * MASS_RECONCILE_RATIO;
  const verdict = !tripped ? 'apply' : massReconcileAllowed() ? 'allowed_by_env' : 'withheld';
  for (const entry of level.paths) {
    let key: ConvergenceClassKey = entry.result.inFlight ? 'in_flight' : entry.result.cls;
    if (key === 'keep_db' || (key === 'db_ahead' && entry.result.keepDbWrite)) {
      keepDbSeen++;
      if (keepDbSeen > KEEP_DB_PASS_CAP) key = 'keep_db_pending';
    }
    if (key === 'delete' && verdict === 'withheld') key = 'deletes_withheld';
    keyed.push({ entry, key });
  }
  const counts: ConvergenceReceipt['counts'] = {};
  for (const { key } of keyed) counts[key] = (counts[key] ?? 0) + 1;
  const classes: ConvergenceReceipt['classes'] = Object.fromEntries(Object.entries(counts).map(([key, count]) => [key, { count, action: syncClassAction(key as ConvergenceClassKey) }]));

  const drift = keyed.filter(({ key }) => key === 'drift').map(({ entry }) => entry);
  let screened = new Map<string, 'same' | 'differs' | 'unknown'>();
  let screenSkipped: ConvergenceReceipt['screen_skipped'];
  const screenStarted = performance.now();
  if (opts.screen === false) screenSkipped = drift.length ? 'not_a_dry_run' : undefined;
  else if (drift.length) {
    try { screened = await opts.screen(level, drift.slice(0, SCREEN_CAP)); } catch { screenSkipped = 'screen_unavailable'; }
  }
  const screenMs = Math.round((performance.now() - screenStarted) * 10) / 10;
  const decisions = { both: 0, unknown: 0, deleted: 0 };
  let noops = 0, unknown = 0;
  for (const entry of drift) {
    const verdictOf = screened.get(entry.path) ?? 'unknown';
    if (verdictOf === 'same') noops++;
    else if (verdictOf === 'unknown') unknown++;
    else decisions[entry.result.side === 'both' ? 'both' : 'unknown']++;
  }
  decisions.deleted = (counts.delete_drift ?? 0) + (counts.deleted_edited ?? 0);
  const dirtyHolds = keyed.filter(({ key, entry }) => key === 'dirty' && !entry.result.settled).length;

  const dbAhead = { pending: 0, db_only: 0, unproven: 0, by_prefix: {} as Record<string, number> };
  let fullSkipped = 0;
  for (const { entry } of keyed) {
    if (entry.result.cls !== 'db_ahead') continue;
    dbAhead[entry.result.sub!]++;
    const prefix = opts.redactPaths ? redact(entry.path.split('/')[0]!) : entry.path.includes('/') ? `${entry.path.split('/')[0]}/` : '';
    dbAhead.by_prefix[prefix] = (dbAhead.by_prefix[prefix] ?? 0) + 1;
    if (entry.result.fullSkipped) fullSkipped++;
  }

  const show = (path: string) => (opts.redactPaths ? redact(path) : path);
  const samples: ConvergenceReceipt['samples'] = {};
  for (const { entry, key } of keyed) {
    if (key === 'matched') continue;
    const list = samples[key] ?? (samples[key] = []);
    if (list.length >= opts.sampleCap) continue;
    list.push({ path: show(entry.path), ...(opts.redactPaths || !entry.slug ? {} : { slug: entry.slug }), reason: reasonOf(entry), action: syncClassAction(key) });
  }
  const sortedDeletes = deletes.map(entry => entry.path).sort();
  const setHash = sortedDeletes.length ? sha256(sortedDeletes.join('\0')) : null;
  const deleteSamples = sortedDeletes.slice(0, opts.sampleCap).map(show);
  const settled = keyed.filter(({ entry, key }) => entry.result.settled || key === 'keep_db_pending' || key === 'deletes_withheld').length;
  const inFlight = counts.in_flight ?? 0;
  const candidates = level.paths.length - settled - inFlight;
  const keepDbAdmitted = Math.min(keepDbSeen, KEEP_DB_PASS_CAP);
  return {
    schema: 'convergence/1', dry_run: true, source_id: level.sourceId, pass_id: null, kind: level.kind, kind_blockers: level.kindBlockers, mode: level.mode,
    target: level.head, baseline_commit: level.baselineCommit, converged_at: null, round: 1, full: level.full,
    candidates, settled, remaining: candidates, in_flight: inFlight, eta_seconds: null, eta_reason: 'shadow',
    counts, classes, decisions, same_content_noops: noops, screen_unknown: unknown, ...(screenSkipped ? { screen_skipped: screenSkipped } : {}),
    would_hold: decisions.both + decisions.unknown + decisions.deleted + unknown + dirtyHolds,
    keep_db_admitted: keepDbAdmitted, keep_db_pending: counts.keep_db_pending ?? 0, keep_db_authorized: keepDbAdmitted,
    db_ahead: dbAhead, db_ahead_by_prefix: dbAhead.by_prefix, full_skipped_db_ahead: fullSkipped,
    legacy_unverified: counts.legacy_unverified ?? 0, legacy_pageless: level.paths.filter(entry => entry.legacyPageless && entry.result.cls === 'legacy_same').length,
    deletes: { count: deletes.length, reconcilable: level.reconcilable, ratio: Math.round(ratio * 1000) / 1000, verdict, set_hash: setHash, samples: deleteSamples },
    deletes_withheld: verdict === 'withheld' ? { count: deletes.length, ratio: Math.round(ratio * 1000) / 1000, set_hash: setHash, samples: deleteSamples } : null,
    samples, settle_mismatch: [], episode: null, admission: null, last_full_at: null, redacted: opts.redactPaths,
    duration_ms: Math.round(level.timings_ms.total ?? 0), timings_ms: { ...level.timings_ms, screen: screenMs, receipt: Math.round((performance.now() - started) * 10) / 10 },
    statements: level.statements,
  };
}

/**
 * The dry run's read-only `sameContentAtOrigin` (sync-run.ts): prepares each drift path's import as a screening request
 * (`prepareManagedSyncMutation(..., { unsaved: true })`, never admitted or persisted) and reports `same` when the
 * preparer's own no-op verdict holds at the page's current revision.
 */
export function readOnlySameContentScreen(engine: BrainEngine, context: ManagedSyncContext, processingOptions: SyncProcessingOptions): ConvergenceScreen {
  return async (level, paths) => {
    const verdicts = new Map<string, 'same' | 'differs' | 'unknown'>();
    const authority = await managedSyncAuthority(engine, context.sourceId, context.incarnation, context.root);
    const committed = level.mode === 'committed' ? await readBlobs(level.gitRoot, [...new Set(paths.map(entry => entry.state.level!).filter(Boolean))], 8 * 1024 * 1024) : new Map<string, Buffer>();
    const runId = randomUUID();
    for (const entry of paths) {
      try {
        const sourceRelative = level.scope ? entry.path.slice(level.scope.length + 1) : entry.path;
        const disk = readSyncFile(level.root, sourceRelative);
        const bytes = level.mode === 'committed' ? committed.get(entry.state.level!) ?? null : disk;
        const snapshot = entry.slug ? await engine.readPageSnapshot(entry.slug, { sourceId: level.sourceId, includeDeleted: true }) : null;
        if (!bytes || !snapshot || snapshot.page.deleted_at != null) { verdicts.set(entry.path, 'unknown'); continue; }
        const content = bytes.toString('utf8');
        const lineEndingOnly = disk !== null && disk.equals(Buffer.from(disk.toString('utf8'))) && disk.toString('utf8').replace(/\r\n/g, '\n') === content.replace(/\r\n/g, '\n');
        const sourcePath = level.slugMode === 'source-root' ? sourceRelative : entry.path;
        const intent: SyncIntent = { kind: 'managed_sync_import', expected_revision: snapshot.revision, sourcePath, path: sourceRelative, rawHash: disk ? sha256(disk) : null, content, lineEndingOnly,
          processingOptions, ownerEpoch: String(context.binding.owner_epoch), syncAuthority: authority, cursorKey: `convergence-shadow:${level.sourceId}`, runId,
          slugMode: level.slugMode, index: 0, total: 1, from: level.baselineCommit, target: level.head, working: level.mode === 'working' };
        const prepared = await prepareManagedSyncMutation(engine, screeningRequest({ source_id: level.sourceId, source_incarnation: level.incarnation, slug: snapshot.page.slug,
          page_id: snapshot.page.id, worktree_id: context.binding.worktree_id, authority: authority.writer, intent }), { engine: engine.kind } as never, undefined, { unsaved: true });
        verdicts.set(entry.path, (prepared.contentUnchanged === true || prepared.noop === true) && !prepared.file && prepared.observedRevision === snapshot.revision ? 'same' : 'differs');
      } catch {
        verdicts.set(entry.path, 'unknown');
      }
    }
    return verdicts;
  };
}
