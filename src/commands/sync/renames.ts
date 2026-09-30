/**
 * Incremental sync rename lane (refactor wave 1, W4 sync): cheap `updateSlug`
 * renames with an observed fallback to add + reconcile (#3056), guarded by
 * the tracked-file liveness index (#3583) and `<rename:…>` sentinels.
 */
import { existsSync } from 'fs';
import { join } from 'path';
import { softDeleteSyncPages } from '../../core/company-brain/profile.ts';
import { serr } from '../../core/console-prefix.ts';
import { DELETE_BATCH_SIZE } from '../../core/engine-constants.ts';
import { importFile, isImageFilePath as isImageImportPath, importImageFile } from '../../core/import-file.ts';
import {
  resolveSlugsForRemovedPaths,
  refusedRemovedPathMessage,
  resolveRemovedPathSlug,
  isPathSafe,
} from '../../core/sync-git.ts';
import {
  DEFAULT_SOURCE_ID,
  resolveSlugForPath,
  loadSyncFailures,
  renameSentinelPath,
  sanitizePathForDisplay,
  renameReconcileErrorMessage,
} from '../../core/sync.ts';
import type { SyncResult } from '../sync.ts';
import { trackedSlugIndex, activeSlugsBySourcePath } from './rename-reconcile.ts';
import type { TrackedSlugIndex } from './rename-reconcile.ts';
import { partial, noteTypeWarning, markCompleted } from './sync-run.ts';
import type { SyncPlan, SyncRun, SyncProgress } from './sync-run.ts';

type RenamePlan = Pick<SyncPlan, 'opts' | 'filtered' | 'manifest' | 'lastCommit' | 'pin' | 'gitContextRoot' | 'modePath' | 'syncImportRoot' | 'syncActivePack'>;

type RenameContext = {
  renameOpts: { sourceId: string } | undefined;
  slugLiveness: (s: string, from: string) => 'live' | 'stale' | 'unknown';
  renameOldSlugs: Map<string, Set<string>>;
  fromSlugByPath: Map<string, string>;
  renameSentinelAlreadyOpen: (to: string) => boolean;
  noEmbed: boolean;
};

/** The rename drain. Returns a partial result when the run aborts mid-drain. */
export async function runRenamesPhase(
  run: SyncRun,
  plan: RenamePlan,
  progress: SyncProgress,
  noEmbed: boolean,
): Promise<SyncResult | undefined> {
  const { engine, completed } = run;
  const { opts, filtered, manifest, gitContextRoot, lastCommit, modePath } = plan;
  // Process renames (updateSlug preserves page_id, chunks, embeddings).
  // SP-5: both old and new slugs use resolveSlugForPath so a .ts → .ts
  // rename (code→code), .md → .md (markdown→markdown), or cross-kind rename
  // all resolve to the right slug shape for each side.
  //
  // v0.41.19.0 (T4): pre-batched slug resolution per Phase 3 of the plan.
  // Renames' per-file cost is dominated by importFile() (file IO + chunking
  // + embedding), so the per-iteration updateSlug + importFile loop stays;
  // only the upfront slug-resolve N+1 gets batched. The try/catch around
  // updateSlug for slug-doesn't-exist preserves verbatim.
  // v0.42.x (#1794): resume-filter renames on the destination path.
  const renamesToDo = filtered.renamed.filter(r => !completed.has(r.to));
  if (renamesToDo.length > 0) {
    progress.start('sync.renames', renamesToDo.length);
    // v0.18.0+ multi-source: scope updateSlug so the rename only touches the
    // source-A row, not every same-slug row across sources (which would
    // either sweep them all OR violate (source_id, slug) UNIQUE).
    const renameOpts = opts.sourceId ? { sourceId: opts.sourceId } : undefined;

    // #3583 review: lazily-built (at most once per run) tracked-file slug
    // index for the live-row filter in the reconcile below. A throw from the
    // index build surfaces inside the reconcile's own try/catch, where it
    // records the `<rename:…>` sentinel — fail-closed, never a guessed delete.
    // Liveness = tracked in the git index, deliberately NOT "present on
    // disk": sync's ground truth is git, and in a sparse/partial checkout a
    // tracked file is intentionally absent from the working tree — an
    // on-disk check would misclassify its live page as stale and delete it,
    // the same failure shape this filter exists to prevent.
    // Three-way verdict, not boolean: when the index is incomplete (an
    // unreadable fallback-regime file — see trackedSlugIndex), an index miss
    // proves nothing, so the row is spared as 'unknown' rather than deleted.
    let treeSlugIndex: TrackedSlugIndex | undefined;
    const slugLiveness = (s: string, from: string): 'live' | 'stale' | 'unknown' => {
      // lastCommit = the commit the brain reflects; its blob is one of the
      // consulted content states (see fallbackSlugsForFile). Anchor paths
      // are keyed through modePath so they compare against `from` under
      // #4342 source-root mode too.
      treeSlugIndex ??= trackedSlugIndex(gitContextRoot, lastCommit, modePath);
      if (treeSlugIndex.slugs.has(s)) {
        // #4597: when the ONLY liveness proof is the anchor blob at THIS
        // rename's own from-path, that proof is the pre-rename state of the
        // file just re-imported at `to` (the reconcile only runs once the
        // destination materialized) — the exact duplicate it exists to
        // remove. Sparing it checkpointed the rename as converged, so the
        // duplicate never re-entered an incremental diff. Any current-tree
        // hit, or anchor proof from a DIFFERENT path (the #3583 data-loss
        // shapes), still spares the row.
        const onlyAt = treeSlugIndex.anchorOnlyPaths.get(s);
        if (!onlyAt || ![...onlyAt].every(p => p === from)) return 'live';
      }
      return treeSlugIndex.complete ? 'stale' : 'unknown';
    };

    // #3583 review (GATE6): the old slug of EVERY rename in this diff. A
    // row can be CARRIED by a different rename in the same diff whose
    // destination derives no slug (ordinary path → exotic path, frontmatter
    // absent): no current path, blob, or anchor state names its slug, but
    // the rename pair itself proves the content is still tracked. The
    // reconcile of rename R therefore spares candidates that are ANOTHER
    // rename's old slug; R's OWN old slug stays deletable — that is
    // exactly the duplicate the reconcile exists to remove once the
    // destination materializes. Built over the RAW manifest — not the
    // scope/exclude/resume-filtered list — so a carried row is protected
    // even when its own rename was filtered out of processing (an
    // --exclude'd or out-of-scope destination still proves the content is
    // tracked; registration is purely spare-side).
    // Each from-path maps to a SET of slugs, never one: source_path is
    // non-unique, so a DB resolve can return an UNRELATED row's slug
    // (stale bookkeeping naming the same path) and silently displace the
    // path-derived slug the carried-spare depends on — the carried row
    // then lost its protection and the GATE6 delete came back. The set
    // always holds the path-derived slug (when the path derives one)
    // PLUS every active row's slug under that source_path; registration
    // is purely spare-side, so over-inclusion only delays a cleanup.
    // Spare-side only: a resolve failure merely shrinks the DB half of the
    // set, and the path-derived entries still protect the carried row.
    let dbSlugsByFrom = new Map<string, string[]>();
    try {
      dbSlugsByFrom = await activeSlugsBySourcePath(
        engine, manifest.renamed.map(r => r.from), opts.sourceId ?? DEFAULT_SOURCE_ID,
        opts.signal,
      );
    } catch { /* see above — both consumers degrade safely */ }
    const renameOldSlugs = new Map<string, Set<string>>();
    for (const r of manifest.renamed) {
      const shapes = new Set<string>();
      const derived = resolveSlugForPath(r.from);
      if (derived !== '') shapes.add(derived);
      for (const s of dbSlugsByFrom.get(r.from) ?? []) shapes.add(s);
      renameOldSlugs.set(r.from, shapes);
    }

    // T4: pre-resolve ALL `from` slugs in batches before iterating. Falls
    // back to the guarded per-path resolver when sourceId is unset. For
    // large rename commits (rare but possible: prefix sweep, reorganization),
    // this drops the slug-resolve round-trips from O(renames) to O(renames/500).
    //
    // #3942: routed through resolveSlugsForRemovedPaths (same guarded
    // resolver the delete lane uses) instead of a raw resolveSlugsByPaths +
    // unguarded resolveSlugForPath fallback — a re-slugified fallback can
    // name a page whose recorded origin is a DIFFERENT file (e.g. a
    // trailing-hyphen collision). A refused from-path gets no entry in
    // fromSlugByPath, so the rename below skips the cheap updateSlug and
    // falls through to add + reconcile instead of repointing that page.
    const fromSlugByPath = new Map<string, string>();
    if (opts.sourceId) {
      const sid = opts.sourceId;
      const fromPaths = renamesToDo.map(r => r.from);
      for (let i = 0; i < fromPaths.length; i += DELETE_BATCH_SIZE) {
        if (opts.signal?.aborted) {
          progress.finish();
          return await partial(run, plan, 'timeout');
        }
        const batch = fromPaths.slice(i, i + DELETE_BATCH_SIZE);
        const resolution = await resolveSlugsForRemovedPaths(engine, batch, sid);
        for (const r of resolution.refused) serr(refusedRemovedPathMessage(r));
        for (const [p, s] of resolution.slugs) fromSlugByPath.set(p, s);
      }
    }

    // Is a `<rename:…>` sentinel for this destination already open from an
    // earlier run? Read once per run: the ledger is only rewritten at the
    // gate, after this loop.
    const openRenameSentinels = new Set(
      loadSyncFailures()
        .filter(f => f.source_id === (opts.sourceId ?? DEFAULT_SOURCE_ID) && f.state === 'open')
        .map(f => f.path),
    );
    const renameSentinelAlreadyOpen = (to: string): boolean =>
      openRenameSentinels.has(renameSentinelPath(to));


    const ctx: RenameContext = { renameOpts, slugLiveness, renameOldSlugs, fromSlugByPath, renameSentinelAlreadyOpen, noEmbed };
    for (const { from, to } of renamesToDo) {
      const aborted = await applyRename(run, plan, ctx, progress, from, to);
      if (aborted) return aborted;
    }
    progress.finish();
  }
  return undefined;
}

/** One rename: cheap updateSlug, destination re-import, reconcile, sentinel and checkpoint bookkeeping. */
async function applyRename(
  run: SyncRun,
  plan: RenamePlan,
  ctx: RenameContext,
  progress: SyncProgress,
  from: string,
  to: string,
): Promise<SyncResult | undefined> {
  const { engine, failedFiles, succeededPaths, pagesAffected, deletedSlugs } = run;
  const { opts, gitContextRoot, syncImportRoot, syncActivePack } = plan;
  const { renameOpts, fromSlugByPath, noEmbed } = ctx;
  // v0.41.13.0 (T2 / D-V4-2): per-iteration abort check. Renames call
  // importFile() at line 1173-style sites which can be slow on big files;
  // refactor commits with 200+ renames must respect --timeout.
  if (opts.signal?.aborted) {
    progress.finish();
    return await partial(run, plan, 'timeout');
  }
  // T4: the batch-resolved slug for `from` (see fromSlugByPath above). A
  // refused/unresolved from-path has no entry, so this is undefined
  // rather than falling back to an unverified derived slug.
  //
  // #3942: the no-sourceId lane is scoped to DEFAULT_SOURCE_ID (not
  // left unscoped) — updateSlug below only ever touches the
  // default-scoped row (renameOpts is undefined here, and updateSlug
  // defaults its own sourceId to 'default'), so the read that decides
  // what to rename must agree with that scope. An unscoped resolve
  // could otherwise return a DIFFERENT source's row sharing this
  // source_path, licensing the wrong (or a foreign) slug for a
  // default-scoped rename.
  const oldSlug = opts.sourceId
    ? fromSlugByPath.get(from)
    : await resolveRemovedPathSlug(engine, from, DEFAULT_SOURCE_ID, serr);
  // The new path doesn't yet have a row, so resolve from path only.
  const newSlug = resolveSlugForPath(to);
  // #3056: the cheap rename is OBSERVED, not assumed. A zero-row UPDATE
  // doesn't throw, and a thrown collision used to be swallowed by an
  // empty catch — both fell through to importFile, which created/updated
  // the row at the new path while the old row stayed behind live. Both
  // shapes now fall through to the reconcile below.
  let renameApplied = false;
  if (oldSlug !== undefined) {
    try {
      renameApplied = (await engine.updateSlug(oldSlug, newSlug, renameOpts)) > 0;
    } catch {
      // Destination slug occupied or invalid — treat as add; the
      // reconcile below removes the stale old row once the destination
      // materialized.
    }
  }
  if (renameApplied) {
    // #3583 gate13: the cheap rename moves the ROW but updateSlug never
    // rewrites source_path — and the unchanged-content reimport below is
    // a no-write skip, so the stale bookkeeping survived indefinitely
    // and the full-sync purge later read it as "source file removed"
    // and hard-deleted the LIVE renamed page. Repair the bookkeeping at
    // the moment the rename lands. Best-effort, and nothing downstream
    // covers a miss: rows renamed BEFORE this repair — and rows whose
    // repair query fails — keep the stale path and stay exposed to the
    // full-sync purge exactly as they are on master. That exposure is
    // pre-existing (verified against the merge base) and out of scope
    // here; this repair stops the shape being manufactured going
    // forward.
    try {
      // Scope EXACTLY the way updateSlug scoped the move it repairs:
      // no sourceId means the DEFAULT source, never every source — an
      // unqualified UPDATE rewrote a matching (slug, source_path) row
      // in ANOTHER source, and that source's later fallback reconcile
      // probed the rewritten path, found nothing, and advanced without
      // its rename sentinel (gate 14).
      await engine.executeRaw(
        `UPDATE pages SET source_path = $1 WHERE source_id = $2 AND slug = $3 AND source_path = $4`,
        [to, opts.sourceId ?? DEFAULT_SOURCE_ID, newSlug, from],
      );
    } catch { /* bookkeeping only — never fail the rename over it */ }
  }
  // Reimport at new path (picks up content changes). Wrapped to match the
  // deletes/adds loops: a malformed renamed file is recorded to failedFiles
  // and skipped, NOT thrown uncaught. importFile still throws on content
  // sanity-block, duplicate-slug, and missing-link endpoints; an uncaught
  // throw here crashes the whole sync mid-run and freezes the checkpoint,
  // defeating --skip-failed. A `skipped` result carrying an error is also
  // captured so the failure is recorded rather than silently dropped.
  // Paths from git diff are relative to gitContextRoot — except under
  // #4342's 'source-root' mode, where the filtered manifest (this loop's
  // source) was remapped scope-relative; the join base moves with it.
  // NAV-1 TOCTOU: refuse a destination that realpath-resolves outside the
  // repo (committed symlink pointing out).
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- `to` is a git-diff rename path from the synced repo (repo content can be hostile), but the joined path is used ONLY inside the isPathSafe(filePath, gitContextRoot) realpath containment check on the next line — a path escaping the repo root (dot-dot or committed symlink) is refused before any read
  const filePath = join(syncImportRoot, to);
  let importResult: Awaited<ReturnType<typeof importFile>> | undefined;
  // #2683 residual: a failed destination import (status 'error' OR a
  // throw) must not checkpoint `to` — the resume filter would skip the
  // rename forever, leaving the target permanently unimported.
  let importErrored = false;
  if (existsSync(filePath) && isPathSafe(filePath, gitContextRoot)) {
    try {
      // #2683: dispatch renamed images to importImageFile (binary bytes
      // through importFile threw UTF-8 errors). Same gate as import.ts.
      const result = isImageImportPath(to) && process.env.GBRAIN_EMBEDDING_MULTIMODAL === 'true'
        ? await importImageFile(engine, filePath, to, { noEmbed, sourceId: opts.sourceId })
        : await importFile(engine, filePath, to, { noEmbed, sourceId: opts.sourceId, activePack: syncActivePack });
      importResult = result;
      noteTypeWarning(run, result.type_warning);
      if (result.status === 'imported') run.chunksCreated += result.chunks;
      else if (result.status === 'skipped' && result.skip_reason === 'malformed_path') {
        // Informational skip — a bracket/control-char filename can never
        // import; counting it as a failure would gate the bookmark forever.
        serr(`  Skipped (malformed filename): ${sanitizePathForDisplay(to)}`);
      } else if (result.status === 'skipped' && (result as { error?: string }).error) {
        // An errored skip (frontmatter slug-authority rejection, invalid
        // YAML, symlink refusal, oversize file, ...) means the
        // destination never materialized — same as status 'error' below,
        // this must gate the success sentinel + markCompleted(to), or a
        // resumed sync would treat the rename as permanently done.
        importErrored = true;
        failedFiles.push({ path: to, error: String((result as { error?: string }).error) });
      } else if (result.status === 'error') {
        // importImageFile (and importFile's frontmatter gate) report
        // failures as status 'error', which no branch above recorded —
        // the rename silently succeeded with a dead target.
        importErrored = true;
        failedFiles.push({ path: to, error: String((result as { error?: string }).error ?? 'import error') });
      }
    } catch (e: unknown) {
      importErrored = true;
      failedFiles.push({ path: to, error: e instanceof Error ? e.message : String(e) });
    }
  }
  const reconcileFailed = await reconcileRenameFallback(run, plan, ctx, from, to, newSlug, renameApplied, importResult);
  // Converged (cheap rename, clean reconcile, or nothing to reconcile):
  // clear any `<rename:…>` sentinel a previous failing run recorded.
  // A run that spared an UNPROVABLE row reaches here too — that is the
  // accepted cost of never deleting without proof — EXCEPT when this
  // rename already had a sentinel open, which the reconcile turns into
  // a failure above precisely so this line cannot retire it. #2683
  // residual (#4496): a failed destination import likewise cannot retire
  // the sentinel — the rename did not converge.
  if (!reconcileFailed && !importErrored) succeededPaths.push(renameSentinelPath(to));
  pagesAffected.push(newSlug);
  deletedSlugs.delete(newSlug); // #1284: rename landed on a previously-deleted slug → embeddable again
  // A failed reconcile OR a failed destination import must NOT checkpoint:
  // banking `to` would make the resume filter skip this rename on the
  // retry run — a permanent duplicate (reconcile) or a permanently
  // unimported target (import error) — the exact bug class being fixed.
  if (!reconcileFailed && !importErrored) await markCompleted(run, to);
  progress.tick(1, newSlug);
  return undefined;
}

/**
 * #3056: when the cheap rename did not apply, the rename fell back to add
 * semantics; remove the stale old row once the destination materialized.
 * Returns true when the reconcile failed (the `<rename:…>` sentinel was
 * recorded and the rename must not checkpoint).
 */
async function reconcileRenameFallback(
  run: SyncRun,
  plan: Pick<SyncPlan, 'opts'>,
  ctx: Pick<RenameContext, 'slugLiveness' | 'renameOldSlugs' | 'renameSentinelAlreadyOpen'>,
  from: string,
  to: string,
  newSlug: string,
  renameApplied: boolean,
  importResult: Awaited<ReturnType<typeof importFile>> | undefined,
): Promise<boolean> {
  const { engine, failedFiles, deletedSlugs } = run;
  const { opts } = plan;
  const { slugLiveness, renameOldSlugs, renameSentinelAlreadyOpen } = ctx;
  // #3056 reconcile: the rename fell back to add semantics, so the row
  // that still represents the OLD path is the stale half of the rename
  // (git reported the old path gone; a plain delete of that path would
  // remove this row). Two safety rails, both from the #3252 review:
  //
  //   1. Delete only after the destination demonstrably materialized —
  //      `imported`, or an errorless `skipped` AT the new slug. Identity
  //      dedup can skip against the OLD row (result.slug === oldSlug),
  //      in which case nothing landed at newSlug and deleting the old
  //      row would destroy the only copy.
  //   2. Locate the stale row POSITIVELY by `source_path = from`, never
  //      by the oldSlug guess — after a collision, a path-derived
  //      fallback slug could name an unrelated (e.g. manually curated)
  //      row. No source_path match → nothing is deleted (code pages
  //      imported before `importCodeFile` wrote `source_path` (#4900)
  //      still carry NULL until their next import and fall back safely
  //      to leaving the old row rather than guessing).
  //
  // A failed delete records a `<rename:…>` SENTINEL (not an ordinary
  // path failure): the gate hard-blocks the bookmark, and — unlike a
  // plain path row — the auto-skip valve can never chronic-skip it after
  // N attempts, which would advance the bookmark and make a transient
  // delete outage a permanent duplicate. The sentinel clears through the
  // ordinary success path once the rename converges on a later run.
  let reconcileFailed = false;
  if (!renameApplied && importResult !== undefined) {
    const destMaterialized = importResult.status === 'imported' ||
      (importResult.status === 'skipped' && !importResult.error && importResult.slug === newSlug);
    if (destMaterialized) {
      // Hoisted above the try so the failure record can name the exact
      // row `gbrain delete` should remove when the DELETE itself failed
      // (still unknown — recorded as `?` — when the probe threw first).
      //
      // ACTIVE rows only, considering EVERY row with the old path:
      // source_path is non-unique, and a one-row resolve could hand back
      // a soft-deleted row while a live duplicate sharing the path hides
      // behind it (#3479 review). Skipping already-soft-deleted rows is
      // also what makes `gbrain delete` (a soft delete) the documented
      // operator exit from a permanent delete-failure wedge (blocker 1):
      // retrying the hard delete against a row the operator already
      // removed would just re-fail and keep the sync blocked.
      // Rows whose CURRENT slug a working-tree file still derives to are
      // LIVE, not stale, and are filtered out before any delete (#3583
      // review) — so `staleSlug` below (and the sentinel/remedy text it
      // feeds) can only ever name a genuinely-stale row.
      let staleSlug: string | undefined;
      try {
        const active = await activeSlugsBySourcePath(
          engine, [from], opts.sourceId ?? DEFAULT_SOURCE_ID,
        );
        // #3583 review (data-loss blocker): `source_path = from` also
        // matches LIVE pages — after an ordinary cheap rename the
        // surviving row keeps the OLD path (updateSlug never rewrites
        // source_path; an unchanged-content re-import writes nothing).
        // Delete only rows whose CURRENT slug no tracked file derives
        // to; spare the rest — 'live' when a tracked file still derives
        // to the slug, 'unknown' when staleness could not be proven.
        const candidates = (active.get(from) ?? []).filter(s => s !== newSlug);
        const staleSlugs: string[] = [];
        const unprovable: string[] = [];
        for (const s of candidates) {
          // Carried by ANOTHER rename in this diff (see renameOldSlugs):
          // its content is still tracked even when no slug state names
          // it anymore — never a reconcile target of THIS rename.
          let carriedByOtherRename = false;
          for (const [rFrom, rOldSlugs] of renameOldSlugs) {
            if (rFrom !== from && rOldSlugs.has(s)) { carriedByOtherRename = true; break; }
          }
          if (carriedByOtherRename) {
            serr(
              `  [sync] rename reconcile: skipping row ${s} — another rename in ` +
              `this diff still carries it (source_path ${from} is stale bookkeeping).`,
            );
            continue;
          }
          const verdict = slugLiveness(s, from);
          if (verdict === 'live') {
            serr(
              `  [sync] rename reconcile: skipping live row ${s} — a tracked ` +
              `file still derives to it (source_path ${from} is stale bookkeeping).`,
            );
          } else if (verdict === 'unknown') {
            // An unreadable tracked file could own this slug, so the row
            // is NOT deleted. What happens to the RENAME depends on
            // whether it was already unresolved (see the check after this
            // loop): a first unprovable run is accepted and banks
            // normally — the usual cause is a live row whose slug merely
            // could not be read (content filter, shallow clone, sparse
            // checkout, over-size file), where nothing is pending — but a
            // rename that already carries an open sentinel is not
            // retired on this evidence.
            unprovable.push(s);
            serr(
              `  [sync] rename reconcile: cannot prove row ${s} stale — an ` +
              `unreadable tracked file could still own this slug, so it is ` +
              `spared rather than deleted.`,
            );
          } else {
            // Established bookkeeping cleanup (#3056 → gate 6): a stale
            // claimant is exactly the duplicate the reconcile exists to
            // remove once the destination materialized.
            staleSlugs.push(s);
          }
        }
        if (staleSlugs.length > 0) {
          // Delete every genuinely-stale active row still carrying the
          // old path — with a non-unique source_path there can be more
          // than one, and the rename is checkpointed after this loop, so
          // a survivor would never be retried (#3479 review, the ORDER BY
          // finding).
          //
          // Post-review note: the `slugLiveness(s)` verdict above and this
          // `deletePage` are not one atomic operation — `deletePage` takes
          // only `slug`, not a row id or updated_at, so it can't express
          // "delete iff still the row I just proved stale". Under
          // `performSync`'s per-source writer lock this window is closed
          // for every normal caller (no other sync/import for this source
          // can run concurrently); it only opens for a write that bypasses
          // the lock entirely (e.g. a direct `put_page` racing this run).
          // Closing it for real needs a conditional DELETE (id/source_path/
          // updated_at) added to `BrainEngine.deletePage` on both engines —
          // out of scope for this fix; tracked as a known gap rather than
          // silently assumed safe.
          for (const s of staleSlugs) {
            staleSlug = s;
            // #4587: soft-delete the stale claimant (72h recovery) —
            // candidates come from activeSlugsBySourcePath, so every s
            // is an ACTIVE row and the flip always applies. Same scope
            // fallback updateSlug/renameOpts use ('default' when the
            // caller threads no sourceId).
            await softDeleteSyncPages(engine, [s], { sourceId: opts.sourceId ?? DEFAULT_SOURCE_ID });
            deletedSlugs.add(s); // never hand a deleted slug to auto-embed
            serr(`  [sync] rename reconciled: soft-deleted stale row ${s} (recoverable 72h; ${from} -> ${to} fell back to add).`);
          }
        } else if (candidates.length > 0) {
          serr(`  [sync] rename fallback: every active row with source_path ${from} was spared (live or unprovable); nothing stale to reconcile.`);
        } else {
          serr(`  [sync] rename fallback: no active row has source_path ${from}; nothing left to reconcile.`);
        }
        if (unprovable.length > 0 && renameSentinelAlreadyOpen(to)) {
          // Provably-stale rows above were still removed; these were not
          // provable either way. On its own that is an accepted cost (see
          // the verdict comment). But an EARLIER run already recorded a
          // `<rename:…>` sentinel for this rename, so convergence has been
          // denied before — and falling through would hand that sentinel
          // to the success path, which the gate clears before it decides.
          // Clearing a non-convergence marker requires proof of
          // convergence, and 'unprovable' is not proof.
          // Deliberately NOT named: `staleSlug` feeds the sentinel's
          // "stale row X" slot and the blocked-run remedy tells the
          // operator to `gbrain delete X`. An unprovable row may well be
          // LIVE — that is the whole reason it was spared — so naming one
          // here would tell the operator to delete a page this very code
          // just refused to delete. Clearing it also drops whatever
          // actionable slug an earlier failure had recorded. `undefined`
          // renders as `?`, which is the truth: not known.
          staleSlug = undefined;
          throw new Error(
            `staleness unprovable for ${unprovable.length} row(s) ` +
            `(${unprovable.join(', ')}): the tracked-file slug index is ` +
            `incomplete, so no index miss proves a row stale, and this ` +
            `rename was already unresolved. Fix or remove the unreadable ` +
            `tracked file and re-run.`,
          );
        }
      } catch (e: unknown) {
        reconcileFailed = true;
        failedFiles.push({
          path: renameSentinelPath(to),
          error: renameReconcileErrorMessage(
            from, staleSlug, e instanceof Error ? e.message : String(e),
          ),
        });
      }
    } else {
      serr(
        `  [sync] rename fallback: ${from} -> ${to} did not materialize at ${newSlug} ` +
        `(import ${importResult.status}); old row left in place.`,
      );
    }
  }
  return reconcileFailed;
}
