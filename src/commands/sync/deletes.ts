/**
 * Incremental sync delete lanes (refactor wave 1, W4 sync): the
 * un-syncable-modified sweep that runs before the checkpoint opens, and the
 * batched removed-file drain. Both SOFT-delete (#4587).
 */
import { softDeleteSyncPages } from '../../core/company-brain/profile.ts';
import { serr, slog } from '../../core/console-prefix.ts';
import { DELETE_BATCH_SIZE } from '../../core/engine-constants.ts';
import type { BrainEngine } from '../../core/engine.ts';
import { resumeFilter } from '../../core/op-checkpoint.ts';
import {
  resolveRemovedPathSlug,
  resolveSlugsForRemovedPaths,
  refusedRemovedPathMessage,
} from '../../core/sync-git.ts';
import { unsyncableReason, isPoisonedPath, DEFAULT_SOURCE_ID } from '../../core/sync.ts';
import type { SyncResult } from '../sync.ts';
import { partial, markCompleted, maybeYield } from './sync-run.ts';
import type { SyncPlan, SyncRun, SyncProgress } from './sync-run.ts';

export async function sweepUnsyncableModified(
  engine: BrainEngine,
  plan: Pick<SyncPlan, 'opts' | 'manifest' | 'inScope' | 'isSelectedForRun' | 'syncOpts' | 'modePath'>,
): Promise<number> {
  const { opts, manifest, inScope, isSelectedForRun, syncOpts, modePath } = plan;
  // Delete pages that became un-syncable (modified but filtered out).
  // v0.20.0 Cathedral II SP-5: resolveSlugForPath picks the right slug shape
  // (markdown vs code) based on the chunker's classifier, so a Rust file that
  // became un-syncable (e.g., moved under `.gitignore` or filtered by
  // strategy=markdown) deletes the actual code-slug page, not a ghost
  // markdown-slug that never existed.
  //
  // v0.41.13 (#1433): the original cleanup loop deleted EVERY pre-existing
  // page for unsyncable-modified paths, including `log.md`, `schema.md`,
  // `index.md`, `README.md` — files that fail `isSyncable` precisely
  // because they're metafiles by convention, not because the user
  // "removed" them from the strategy. infiniteGameExp's domain `log.md`
  // pages had been indexed by an older gbrain version (or via direct
  // put_page) and were silently dropped on every subsequent sync. The
  // fix uses `unsyncableReason` (factored from `isSyncable` so they
  // cannot drift) to skip the delete when the reason is `'metafile'`.
  //
  // Honest scope: this guard only fixes the `manifest.modified` case.
  // `manifest.deleted` is filtered upstream at sync.ts:757 via the same
  // `isSyncable` call, so `rm log.md` followed by sync also doesn't
  // delete the page. That's the same pre-fix behavior — removing the
  // page requires `gbrain pages purge-deleted` or a direct MCP delete.
  // Filed as v0.42+ follow-up for a `gbrain pages remove <slug>` surface.
  const unsyncableModified = manifest.modified.filter(p => inScope(p) && !isSelectedForRun(p, syncOpts));
  // v0.18.0+ multi-source: scope getPage + deletePage to opts.sourceId so
  // unsyncable cleanup in source A doesn't accidentally sweep same-slug
  // pages in sources B/C/D.
  const pageOpts = opts.sourceId ? { sourceId: opts.sourceId } : undefined;
  // #4786: pages this loop retires count as `deleted` in the result (only rows
  // that actually transitioned), so a sweep-only run never reports up_to_date.
  let swept = 0;
  for (const path of unsyncableModified) {
    // v0.41.13 #1433: never delete on metafile classification.
    // #2404 hardening: same for 'pruned-dir' — a page under a pruned
    // directory can only exist via a deliberate put_page (sync never
    // imports those paths), so "the file was modified" is not evidence
    // the page is stale. Deleting here silently destroyed put-created
    // pages every time their materialized file landed in a commit.
    const reason = unsyncableReason(path, syncOpts);
    if (reason === 'metafile' || reason === 'pruned-dir') continue;
    // Bare-bracket markdown (pre-gate imports like `notes [draft].md`) keeps
    // its row — only the poison signature (`](`/control chars) is sweepable.
    // Deleting a legit page's row while its file sits on disk is data loss.
    if (reason === 'malformed-path' && !isPoisonedPath(path)) continue;
    // #3942: guarded resolver — never delete a page whose recorded origin is
    // a DIFFERENT file just because this path re-slugifies onto its slug.
    // #4342: resolve in the mode's namespace (source-relative under
    // 'source-root'; git-root-relative otherwise).
    const slug = await resolveRemovedPathSlug(engine, modePath(path), opts.sourceId, serr);
    if (slug === undefined) continue;
    try {
      const existing = await engine.getPage(slug, pageOpts);
      if (existing) {
        // #3583 review: this loop sits ABOVE the dry-run return below, so
        // an unguarded delete made a preview under a narrower strategy
        // hard-delete previously-imported pages. A preview only reports.
        if (opts.dryRun) {
          slog(`  [dry-run] would delete un-syncable page: ${slug}`);
        } else {
          // #4587: soft-delete (72h recovery window) instead of hard delete.
          // Scope falls back to DEFAULT_SOURCE_ID to preserve deletePage's
          // old 'default' fallback; softDeletePages requires an explicit
          // sourceId. The purge phase owns the eventual hard delete.
          swept += (await softDeleteSyncPages(engine, [slug], { sourceId: opts.sourceId ?? DEFAULT_SOURCE_ID })).length;
          slog(`  Soft-deleted un-syncable page (recoverable 72h): ${slug}`);
        }
      }
    } catch { /* ignore */ }
  }
  return swept;
}

/** The removed-file drain. Returns a partial result when the run aborts mid-drain. */
export async function runDeletesPhase(
  run: SyncRun,
  plan: Pick<SyncPlan, 'opts' | 'filtered' | 'lastCommit' | 'pin'>,
  progress: SyncProgress,
): Promise<SyncResult | undefined> {
  const { engine, completed, pagesAffected, deletedSlugs, failedFiles } = run;
  const { opts, filtered } = plan;
  // v0.41.19.0 (T2/D6/D7/D16/D18 via /plan-eng-review + codex outside-voice):
  // batched delete loop. Replaces the per-file N+1 that PR #1538 originally
  // batched on Postgres only. See plan file:
  //   ~/.claude/plans/system-instruction-you-are-working-ethereal-narwhal.md
  // #4587: the lanes below SOFT-delete (deleted_at = now(), 72h recovery
  // window) via softDeletePages; the autopilot purge phase owns the eventual
  // hard delete and a re-import within the window revives via upsert.
  //
  // SHAPE (interleaved per-batch resolve + delete; caller owns chunking):
  //
  //   filtered.deleted (e.g. 73K paths)
  //       │
  //       ▼
  //   slice into batches of DELETE_BATCH_SIZE (500)
  //       │
  //       ▼  for each batch:
  //   abort-check ──► partial('timeout')
  //       │
  //       ▼
  //   resolveSlugsForRemovedPaths(batch)             ◀── exact source_path,
  //       │                                              then VERIFIED fallback;
  //       ▼                                              foreign-origin refusals
  //   slugs = deletable.map(...)                         (#3942) warned + skipped
  //       │
  //       ▼
  //   try {
  //     deleted = engine.softDeletePages(slugs, opts) ◀── 1 SQL round-trip
  //     pagesAffected.push(...deleted)                ◀── D6: only confirmed
  //   } catch {                                           transitions, not phantoms
  //     // D7 decompose: one-element softDeletePages per slug,
  //     // unrecoverable failures → failedFiles, run continues
  //   }
  //
  // ROUND-TRIP COUNTS (73K deletes):
  //   pre-fix:   73,000 SELECTs + 73,000 DELETEs = 146,000 (~5 hours)
  //   post-fix:     146 SELECTs +     146 UPDATEs =     292 (~2 minutes)
  //
  // ATOMICITY (D3): each batch is one transaction. A mid-batch abort or
  // transient connection failure rolls back up to DELETE_BATCH_SIZE - 1
  // successful deletes. Sync is idempotent — the next run picks them up
  // via git diff regenerating the deletion list.
  //
  // NO-SOURCEID FALLBACK: when opts.sourceId is undefined (legacy unscoped
  // callers, rare post-v0.34.1 source-resolution wiring), fall back to the
  // OLD per-path loop. The batch engine surface requires sourceId per D5
  // (multi-source-bug-class defense at the type level). Production callers
  // that thread sourceId via resolveSourceWithTier get the new fast path.
  // v0.42.x (#1794): resume-filter the delete set so a resumed run skips paths
  // already drained in a prior run (deletes are idempotent, but skipping avoids
  // re-resolving + re-deleting tens of thousands of already-gone pages).
  const deletesToDo = resumeFilter(filtered.deleted, [...completed]);
  if (deletesToDo.length > 0) {
    progress.start('sync.deletes', deletesToDo.length);
    if (opts.sourceId) {
      const sid = opts.sourceId;
      const deleteScopedOpts = { sourceId: sid };
      for (let i = 0; i < deletesToDo.length; i += DELETE_BATCH_SIZE) {
        if (opts.signal?.aborted) {
          progress.finish();
          return await partial(run, plan, 'timeout');
        }
        const batch = deletesToDo.slice(i, i + DELETE_BATCH_SIZE);

        // Phase A: guarded batch slug resolution (#3942 — a re-slugified
        // fallback can name a DIFFERENT page; refusals are logged + skipped).
        const resolution = await resolveSlugsForRemovedPaths(engine, batch, sid);
        for (const r of resolution.refused) {
          serr(refusedRemovedPathMessage(r));
          // Deliberately handled — checkpoint so a resume doesn't re-refuse.
          await markCompleted(run, r.path);
        }
        const deletable = batch.filter(p => resolution.slugs.has(p));
        const slugs = deletable.map(p => resolution.slugs.get(p) as string);

        // Phase B: batch soft-delete (1 round-trip per batch). #4587: the
        // removed-file drain honors the 72h recovery window — deleted_at is
        // set, the purge phase hard-deletes later, and a re-import within
        // the window revives via putPage's upsert.
        try {
          const deleted = await softDeleteSyncPages(engine, slugs, deleteScopedOpts);
          // D6: only push slugs that actually transitioned. Filters phantom
          // slugs (paths in filtered.deleted but with no DB row — or rows
          // already soft-deleted) so downstream extract/embed don't waste
          // lookups.
          pagesAffected.push(...deleted);
          for (const s of deleted) deletedSlugs.add(s);
          // v0.42.x (#1794): the whole batch is handled (soft-deleted,
          // already gone, or refused above); checkpoint every path so a
          // resume skips it.
          for (const p of deletable) await markCompleted(run, p);
        } catch (err) {
          // D7 decompose: a transient blip on this batch shouldn't lose all
          // 500 deletes. Fall back to one-element softDeletePages batches
          // for THIS batch only (per-slug isolation, same primitive);
          // unrecoverable per-slug failures land in failedFiles and the run
          // CONTINUES (--skip-failed semantics), matching the existing
          // import-loop pattern.
          for (let j = 0; j < slugs.length; j++) {
            try {
              await softDeleteSyncPages(engine, [slugs[j]], deleteScopedOpts);
              pagesAffected.push(slugs[j]);
              deletedSlugs.add(slugs[j]);
              await markCompleted(run, deletable[j]);
            } catch (perSlugErr) {
              failedFiles.push({
                path: deletable[j],
                error: `delete failed: ${perSlugErr instanceof Error ? perSlugErr.message : String(perSlugErr)} (batch error: ${err instanceof Error ? err.message : String(err)})`,
              });
            }
          }
        }
        progress.tick(batch.length, `deletes ${Math.min(i + DELETE_BATCH_SIZE, deletesToDo.length)}/${deletesToDo.length}`);
        await maybeYield(run);
      }
    } else {
      // Legacy no-sourceId path. The engine batch methods require sourceId
      // per D5 (kills the multi-source-bug-class on the new surface); when
      // sourceId is unset, fall back to the original per-path loop. Slow
      // but correct; production callers all thread sourceId so this branch
      // is functionally dead post-v0.34.1.
      for (const path of deletesToDo) {
        if (opts.signal?.aborted) {
          progress.finish();
          return await partial(run, plan, 'timeout');
        }
        // #3942: same guarded resolver as the batched lane (single-path call).
        const slug = await resolveRemovedPathSlug(engine, path, undefined, serr);
        if (slug === undefined) {
          await markCompleted(run, path);
          progress.tick(1, path);
          continue;
        }
        try {
          // #4587: soft-delete with the same 'default' fallback the old
          // optional-opts deletePage call applied on this legacy lane
          // (opts.sourceId is undefined here by construction).
          await softDeleteSyncPages(engine, [slug], { sourceId: opts.sourceId ?? DEFAULT_SOURCE_ID });
          pagesAffected.push(slug);
          deletedSlugs.add(slug);
          await markCompleted(run, path);
        } catch (err) {
          failedFiles.push({
            path,
            error: `delete failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        progress.tick(1, slug);
      }
    }
    progress.finish();
  }
  return undefined;
}
