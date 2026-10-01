/** Rename-reconcile liveness helpers and the orphaned `<rename:…>` sentinel sweep. */
import { readSourceFileSync } from '../../core/minions/source-filesystem.ts';
import { lstatSync } from 'fs';
import { join } from 'path';
import type { BrainEngine } from '../../core/engine.ts';
import { DELETE_BATCH_SIZE } from '../../core/engine-constants.ts';
import { MAX_FILE_SIZE } from '../../core/import-file.ts';
import { parseMarkdown } from '../../core/markdown.ts';
import { validateSlug } from '../../core/utils.ts';
import {
  resolveSlugForPath,
  isCodeFilePath,
  loadSyncFailures,
  RENAME_SENTINEL_PREFIX,
  parseRenameReconcileFrom,
  clearFailures,
  restoreFailures,
} from '../../core/sync.ts';
import type { SyncFailure } from '../../core/sync.ts';
import { serr } from '../../core/console-prefix.ts';
import { git, gitRawOutput } from '../../core/sync-git.ts';

/**
 * Source-scoped ACTIVE slugs for the given source_paths, considering EVERY
 * matching row. `source_path` has only a non-unique index and
 * `resolveSlugsByPaths` collapses to one arbitrary row per path — through
 * that collapse a soft-deleted row could mask a live duplicate sharing the
 * same path (#3479 review), so the rename-reconcile paths query all rows
 * with an explicit `deleted_at IS NULL` instead.
 */
export async function activeSlugsBySourcePath(
  engine: BrainEngine,
  paths: string[],
  sourceId: string,
  signal?: AbortSignal,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < paths.length; i += DELETE_BATCH_SIZE) {
    // gate 17 (timeout responsiveness): a large rename manifest runs many
    // batches; stop between them once aborted. The partial map is safe for
    // both consumers — the rename loop's own per-iteration check returns
    // `partial` before consuming it, and a smaller map only ever degrades
    // toward skipping cheap renames, never toward moving a guessed row.
    if (signal?.aborted) break;
    const batch = paths.slice(i, i + DELETE_BATCH_SIZE);
    const rows = await engine.executeRaw<{ slug: string; source_path: string }>(
      `SELECT slug, source_path FROM pages
        WHERE source_path = ANY($1::text[]) AND source_id = $2 AND deleted_at IS NULL`,
      [batch, sourceId],
    );
    for (const r of rows) {
      const arr = out.get(r.source_path);
      if (arr) arr.push(r.slug);
      else out.set(r.source_path, [r.slug]);
    }
  }
  return out;
}

/**
 * #3583 review (data-loss blocker): every tracked working-tree file, indexed
 * by the slug it derives to. `updateSlug` never rewrites `source_path` and an
 * unchanged-content re-import is a no-write skip, so after an ordinary cheap
 * rename the LIVE row still carries its OLD path — `source_path = from`
 * therefore matches live pages, not just stale ones. A reconcile candidate is
 * only genuinely stale when NO tracked file derives to its CURRENT slug.
 *
 * Derivation mirrors the import path exactly, in both of its regimes:
 *   - Ordinary paths: resolveSlugForPath. Import's anti-spoof check rejects
 *     any frontmatter slug that disagrees with the path-derived one, so for
 *     these files the path IS the slug authority (case folding and spaces
 *     included — a naive `slug + '.md'` inversion would misclassify those).
 *   - CJK-wave frontmatter fallback (#598): a markdown file whose path
 *     derives NO slug (emoji / exotic-script filename) imports under its
 *     frontmatter `slug:` — resolveSlugForPath cannot see that slug, so
 *     resolve it the way import does end to end: parseMarkdown on the
 *     content (working tree first, git index blob when the working-tree
 *     copy is absent, e.g. a sparse checkout), then the same validateSlug
 *     chokepoint importFromContent runs (which lowercases). Every non-code
 *     file with an empty derived slug is a candidate — importFromFile has
 *     no extension gate; see fallbackSlugsForFile.
 *
 * `complete` goes false when some fallback-regime file's content could not
 * be read at all: its true slug is then unknowable, so absence from the
 * index no longer PROVES staleness — callers must treat an index miss as
 * unknown and spare the row, never delete on it. That same fail-safe
 * absorbs the awkward index states: an unmerged path (no stage-0 blob →
 * cat-file throws) and an undecodable filename (utf-8 replacement mangles
 * the name → both reads miss) both land on `complete = false`, not on a
 * delete. Deliberately BROADER than the sync scope: every working-tree file
 * counts (submodule interiors never appear — ls-files lists the gitlink
 * only, and the walker never imports them — and scope/exclude-filtered
 * files still register). Over-inclusion can only delay a cleanup, never
 * delete a live page.
 *
 * Post-review fix: the listing MUST match `collectSyncableFiles`' git-aware
 * fast path (`git ls-files --cached --others --exclude-standard`, tracked
 * PLUS untracked-not-ignored — see `gitListSyncableFiles` in import.ts), not
 * a bare `git ls-files` (tracked only). A file added to the working tree but
 * not yet `git add`-ed still gets imported by `collectSyncableFiles`, so a
 * plain tracked-only listing here would treat its slug as absent from the
 * index and reconcile could hard-delete the LIVE page that import just
 * created. `--exclude-standard` keeps `.gitignore`d files out of the index
 * exactly as it keeps them out of import, so the two enumerations stay in
 * lockstep.
 *
 * Built at most once per sync run, and only when a fallback rename actually
 * has reconcile candidates. Throws on git ls-files failure: the caller's
 * catch records the `<rename:…>` sentinel (fail-closed) instead of guessing.
 */
export interface TrackedSlugIndex {
  /**
   * The slugs some tracked file derives to. A SET, not a slug -> paths map:
   * liveness only ever asks "does any file still derive to this slug"
   * (`has`), so the paths were accurate but unread — state a later reader
   * would have had to re-derive the purpose of.
   */
  slugs: Set<string>;
  complete: boolean;
  /**
   * Slugs proven ONLY by the anchor tree (no current tracked file derives
   * to them) -> the anchor paths that proved them, in the caller's path
   * mode (`pathKey`). Lets the reconcile tell "another file owned this slug
   * at the anchor" from "the pre-rename state of the very file this rename
   * just re-imported" (#4597).
   */
  anchorOnlyPaths: Map<string, Set<string>>;
}

export function trackedSlugIndex(
  gitContextRoot: string,
  anchorCommit?: string,
  pathKey: (rel: string) => string = (rel) => rel,
): TrackedSlugIndex {
  const slugs = new Set<string>();
  const anchorOnlyPaths = new Map<string, Set<string>>();
  let complete = true;
  const addSlug = (slug: string): void => { slugs.add(slug); };
  // --cached --others --exclude-standard mirrors gitListSyncableFiles (see
  // docstring above): tracked-only would miss an unstaged new file that
  // collectSyncableFiles already imported, misclassifying its live page as
  // stale.
  const listing = gitRawOutput(gitContextRoot, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  for (const rel of listing.split('\u0000')) {
    if (!rel) continue;
    const slug = resolveSlugForPath(rel);
    addSlug(slug);
    // Fallback-regime candidates are every non-code file whose path derives
    // no slug. NOT just `.md`/`.mdx`: importFromFile has no extension gate —
    // an extensionless emoji-named file imports under its frontmatter slug
    // all the same, so skipping it here deleted its live row. Reads are
    // bounded by the size gates inside fallbackSlugsForFile, so a multi-GB
    // punctuation-named artifact costs one lstat, never a read.
    if (slug === '' && !isCodeFilePath(rel)) {
      try {
        const fallback = fallbackSlugsForFile(gitContextRoot, rel);
        for (const fmSlug of fallback.slugs) addSlug(fmSlug);
        if (!fallback.proofIntact) {
          complete = false;
          serr(
            `  [sync] rename reconcile: could not fully resolve the slug of ` +
            `tracked file ${rel} (unreadable, unmerged, or over the import ` +
            `size gate); staleness is unprovable this run, so reconcile will ` +
            `not delete any row missing from the index.`,
          );
        }
      } catch {
        complete = false;
        serr(
          `  [sync] rename reconcile: could not resolve the slug of tracked ` +
          `file ${rel}; staleness is unprovable this run, so reconcile will ` +
          `not delete any row missing from the index.`,
        );
      }
    }
  }
  // The anchor commit (`last_commit`, what the brain actually reflects) is
  // enumerated as ITS OWN tree, not looked up through current paths: a
  // commit that RENAMES a fallback-regime file (and drops its slug) leaves
  // the anchor's content at the OLD path, which no current-path lookup can
  // reach — the anchor-imported row was deleted while the index still
  // claimed to be complete. Registration is purely spare-side (extra
  // liveness can only delay a cleanup), so enumerating the whole anchor
  // tree is safe; reads stay bounded by the same size gates and only fire
  // for fallback-regime paths.
  if (anchorCommit && anchorCommit !== 'HEAD') {
    const currentSlugs = new Set(slugs);
    try {
      const epochs = attributeEpochCommits(gitContextRoot, anchorCommit);
      const historicalFilter = epochs === null || anyFilterAtAttributeEpochs(gitContextRoot, epochs);
      const anchorListing = gitRawOutput(gitContextRoot, ['ls-tree', '-r', '-z', '--name-only', anchorCommit]);
      for (const rel of anchorListing.split('\u0000')) {
        if (!rel) continue;
        if (resolveSlugForPath(rel) !== '' || isCodeFilePath(rel)) continue;
        const res = anchorBlobSlugs(gitContextRoot, anchorCommit, rel, historicalFilter);
        for (const s of res.slugs) {
          addSlug(s);
          if (currentSlugs.has(s)) continue;
          let at = anchorOnlyPaths.get(s);
          if (!at) anchorOnlyPaths.set(s, (at = new Set()));
          at.add(pathKey(rel));
        }
        if (!res.proofIntact) {
          complete = false;
          serr(
            `  [sync] rename reconcile: could not resolve the slug of ${rel} at ` +
            `the sync anchor; staleness is unprovable this run, so reconcile ` +
            `will not delete any row missing from the index.`,
          );
        }
      }
    } catch {
      complete = false;
      serr(
        `  [sync] rename reconcile: could not enumerate the sync anchor tree; ` +
        `staleness is unprovable this run, so reconcile will not delete any ` +
        `row missing from the index.`,
      );
    }
  }
  return { slugs, complete, anchorOnlyPaths };
}

/**
 * The frontmatter-slug shapes a content state can own a row under: the
 * validateSlug chokepoint importFromContent runs (lowercases), or — when
 * the current chokepoint REJECTS the slug — both raw casings, since a
 * legacy row imported under older validation rules may still carry it
 * (purely spare-side registration).
 */
function frontmatterSlugShapes(content: string, rel: string): string[] {
  const fmSlug = parseMarkdown(content, rel).slug;
  if (!fmSlug) return [];
  try {
    return [validateSlug(fmSlug)];
  } catch {
    return [fmSlug, fmSlug.toLowerCase()];
  }
}

/**
 * Size-gated read + slug extraction of one anchor-tree blob. When a
 * content filter is in effect for the path under TODAY's attributes, or
 * ANY reachable attribute epoch assigns a filter to ANYTHING
 * (`historicalFilter`, computed once per index build), the read still
 * registers what it can (spare-side) but the proof is NOT intact:
 * `cat-file --filters` reconstructs the historical blob with TODAY's
 * filter definitions, and the row's content was imported under whatever
 * filter was active — at ITS import-time anchor, under ITS path AT THAT
 * TIME. The historical side is deliberately repo-wide rather than
 * per-path: the file can have been RENAMED since the import, so its
 * import-time filter was keyed to a path no current tree names, and a
 * per-path history walk would put git's rename-detection heuristics on
 * the DELETE side of the proof. `!filter` resets, entries deleted
 * outright, and interval-only filters all land on the spare side. The
 * remaining residual is an UNVERSIONED attribute source
 * (info/attributes, core.attributesFile) whose filter entry was removed
 * since the import, or an import-time state force-pushed out of the
 * reachable history — invisible to every git surface.
 */
function anchorBlobSlugs(
  gitContextRoot: string,
  anchorCommit: string,
  rel: string,
  historicalFilter: boolean,
): { slugs: string[]; proofIntact: boolean } {
  try {
    const filtered = historicalFilter || pathHasContentFilter(gitContextRoot, rel);
    const size = Number(git(gitContextRoot, ['cat-file', '-s', `${anchorCommit}:${rel}`]));
    if (Number.isFinite(size) && size > MAX_FILE_SIZE) return { slugs: [], proofIntact: false };
    // BOTH the raw blob and the filter-converted view register (union,
    // spare-side): a smudge filter that STRIPS the slug line hides it from
    // the converted view while the raw blob still carries it. The
    // injection direction (a drifted smudge that ADDED the slug at import
    // time) is invisible to every git surface — that is what the
    // filter-presence proof downgrade below is for.
    const slugs = new Set<string>();
    const raw = git(gitContextRoot, ['cat-file', 'blob', `${anchorCommit}:${rel}`]);
    if (raw.length > MAX_FILE_SIZE) return { slugs: [], proofIntact: false };
    for (const s of frontmatterSlugShapes(raw, rel)) slugs.add(s);
    const converted = git(gitContextRoot, ['cat-file', '--filters', `${anchorCommit}:${rel}`]);
    if (converted.length <= MAX_FILE_SIZE) {
      for (const s of frontmatterSlugShapes(converted, rel)) slugs.add(s);
    }
    return { slugs: [...slugs], proofIntact: !filtered };
  } catch {
    return { slugs: [], proofIntact: false };
  }
}

/**
 * Every reachable commit that CHANGED an attributes file (root or nested
 * .gitattributes), walked from BOTH the current HEAD and the anchor (a
 * blocked past sync can have imported at a commit ahead of the anchor;
 * multiple start points cover both ancestries even after a force-push
 * moved one aside). The attribute state at any past import-time anchor is
 * the state at its nearest attribute-epoch ancestor, so checking the
 * filter attribute at every epoch covers every historical state a live
 * row can have been imported under. The anchor itself is appended so the
 * check never depends on the epoch enumeration being exhaustive for it.
 * Returns null when the enumeration fails — the caller downgrades every
 * anchor proof (spare-side).
 */
function attributeEpochCommits(gitContextRoot: string, anchorCommit: string): string[] | null {
  try {
    // A shallow clone's history is truncated: an import-time filter epoch
    // can sit below the shallow boundary where no enumeration reaches it.
    // Unprovable, not absent.
    if (git(gitContextRoot, ['rev-parse', '--is-shallow-repository']) === 'true') return null;
    // --full-history: the default path-simplified walk prunes a side line
    // whose attribute change was discarded at a merge (`-s ours` of an
    // experiment branch is TREESAME to the kept parent) — but a sync
    // anchored ON that side line imported under the pruned filter state.
    const out = git(gitContextRoot, [
      'log', '--full-history', '--format=%H', 'HEAD', anchorCommit, '--',
      '.gitattributes', ':(glob)**/.gitattributes',
    ]);
    const epochs = out.split('\n').filter(Boolean);
    if (!epochs.includes(anchorCommit)) epochs.push(anchorCommit);
    return epochs;
  } catch {
    return null;
  }
}

/**
 * Is a `filter` attribute in effect for this path under TODAY's
 * attributes? `check-attr --all` omits genuinely-unspecified attributes
 * from its output entirely, so ANY `filter` line — whatever its value,
 * including the magic-looking `unspecified`/`unset` tokens that a literal
 * driver name can produce, and regardless of whether a driver is still
 * configured (a removed driver leaves the attribute behind and may have
 * converted content back when it was imported) — counts as filtered.
 * Explicit `-filter` lands here too: spare-side only, never delete-side.
 * Any failure counts as filtered (fail toward unprovable, never a delete).
 */
function pathHasContentFilter(gitContextRoot: string, rel: string): boolean {
  try {
    const out = gitRawOutput(gitContextRoot, ['check-attr', '--all', '-z', '--', rel]);
    if (out === '') return false;
    // -z output is a flat sequence of NUL-terminated <path> <attr> <value>
    // triplets; the attribute name sits at every 3k+1 position.
    const fields = out.split('\u0000');
    for (let i = 1; i + 1 < fields.length; i += 3) {
      if (fields[i] === 'filter') return true;
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * Do the attributes files at ANY reachable attribute epoch assign a
 * content filter to ANYTHING? Deliberately repo-wide, not per-path: a
 * fallback-regime file can have been RENAMED since its import, so its
 * import-time filter was keyed to a path no current tree names — a
 * per-path history walk would put git's rename-detection heuristics on
 * the DELETE side of the proof. Text-level `filter=` detection
 * over-approximates (a commented-out assignment still counts), which is
 * purely spare-side; `-filter`/`!filter` lines assign nothing and
 * convert nothing, and git rejects `filter` inside `[attr]` macros, so
 * the token cannot be introduced without the literal `filter=` text.
 * A grep failure that is not a clean no-match counts as filtered.
 */
function anyFilterAtAttributeEpochs(gitContextRoot: string, epochs: string[]): boolean {
  for (const epoch of epochs) {
    try {
      git(gitContextRoot, [
        'grep', '-l', '-F', 'filter=', epoch, '--',
        '.gitattributes', ':(glob)**/.gitattributes',
      ]);
      return true;
    } catch (err) {
      if ((err as { status?: unknown }).status === 1) continue;
      return true;
    }
  }
  return false;
}

/**
 * The slugs a fallback-regime file (path derives no slug) can own a row
 * under, resolved the way import resolves them — parseMarkdown for the
 * frontmatter `slug:`, then the SAME validateSlug chokepoint
 * importFromContent runs, which lowercases (a `slug: Party-Notes` row is
 * stored as `party-notes`; an index carrying the raw casing would miss it
 * and misclassify the live row as stale). A slug the current chokepoint
 * REJECTS still registers in both casings: a legacy row imported under
 * older validation rules may carry it, and extra entries are purely
 * spare-side.
 *
 * THREE current-path content states are consulted and their slugs unioned
 * (the fourth state — the sync anchor commit — is enumerated as its own
 * tree by trackedSlugIndex, since a rename moves its content to a path no
 * current-path lookup can reach):
 *   - the working tree — what the next import would read; never followed
 *     through a symlink (import rejects symlinks via lstat before reading,
 *     and following one would read an arbitrary out-of-repo target);
 *   - the git index (staging) blob — what an in-flight `git add` holds;
 *   - the HEAD blob — the last committed content. An uncommitted edit
 *     that removes or changes the `slug:` line must not un-prove the slug
 *     the imported row still carries — and STAGING that edit changes the
 *     first two states at once, so HEAD keeps proving it.
 *
 * `proofIntact` goes false when either side that might name a slug could
 * not be examined — an unreadable file (EACCES; plain working-tree absence
 * is normal, the blob covers it), a side over the import size gate (a row
 * imported while the file was under the gate stays live, and an unread
 * file must never supply a staleness proof), a smudge filter expanding the
 * blob past the gate after the raw-size check, or a path with no stage-0
 * index entry (unmerged). The caller then marks the whole index incomplete
 * and every miss is spared as unknown.
 */
function fallbackSlugsForFile(
  gitContextRoot: string,
  rel: string,
): { slugs: string[]; proofIntact: boolean } {
  const contents: string[] = [];
  let proofIntact = true;
  try {
    // `rel` comes from `git ls-files`/`git ls-tree` (trackedSlugIndex, above) —
    // paths git itself tracked, never external input — but reject any `..`
    // segment before it reaches join() rather than trust that invariant
    // silently (semgrep path-join-resolve-traversal; belt-and-braces
    // alongside the symlink guard below, which covers the OTHER
    // out-of-repo-read vector this function's own docstring calls out).
    if (rel.split('/').includes('..')) {
      proofIntact = false;
    } else {
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
      const abs = join(gitContextRoot, rel);
      const st = lstatSync(abs);
      if (!st.isSymbolicLink()) {
        if (st.size > MAX_FILE_SIZE) proofIntact = false;
        else contents.push(readSourceFileSync(abs, 'utf-8'));
      }
    }
    // A symlink's own registrable content is its index blob (the target
    // path text, read below) — matching both git's view and import's
    // refusal to follow it.
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') proofIntact = false;
  }
  try {
    const blobSize = Number(git(gitContextRoot, ['cat-file', '-s', `:${rel}`]));
    if (Number.isFinite(blobSize) && blobSize > MAX_FILE_SIZE) {
      proofIntact = false;
    } else {
      // git()'s trim() can only ADD a frontmatter parse (leading
      // whitespace stripped) — spare side. Re-check the size AFTER the
      // read: a smudge filter can expand output past the raw blob size.
      const c = git(gitContextRoot, ['cat-file', '--filters', `:${rel}`]);
      if (c.length > MAX_FILE_SIZE) proofIntact = false;
      else contents.push(c);
    }
  } catch {
    // No stage-0 entry (unmerged path) or another repo oddity: the
    // committed side could not be examined.
    proofIntact = false;
  }
  // HEAD blob — the last COMMITTED content, the state sync's own imports
  // actually came from. `:${rel}` above is the STAGING index, so staging
  // an uncommitted edit that removes the slug: line changed BOTH other
  // states at once — and un-proved (deleted) the row imported from HEAD.
  try {
    const inHead = git(gitContextRoot, ['ls-tree', 'HEAD', '--', rel]);
    if (inHead !== '') {
      const headSize = Number(git(gitContextRoot, ['cat-file', '-s', `HEAD:${rel}`]));
      if (Number.isFinite(headSize) && headSize > MAX_FILE_SIZE) {
        proofIntact = false;
      } else {
        const c = git(gitContextRoot, ['cat-file', '--filters', `HEAD:${rel}`]);
        if (c.length > MAX_FILE_SIZE) proofIntact = false;
        else contents.push(c);
      }
    }
    // Absent from HEAD (a newly added file) is normal — nothing to prove.
  } catch {
    proofIntact = false;
  }
  // No frontmatter slug in a content state → that state derives nothing
  // (the import path refuses it). Residual, accepted: a row from a content
  // revision older than EVERY consulted state carries a slug this pass
  // cannot recover — it would also need drifted source_path bookkeeping to
  // ever become a reconcile candidate.
  const slugs = new Set<string>();
  for (const content of contents) {
    for (const s of frontmatterSlugShapes(content, rel)) slugs.add(s);
  }
  return { slugs: [...slugs], proofIntact };
}

/**
 * #3479 blocker 2 — find open `<rename:…>` sentinels with nothing left to
 * reconcile. A sentinel is orphaned when NO active row carries the rename's
 * OLD source_path (read back out of the sentinel's own error text) anymore:
 * the duplicate it guarded against is gone — hard-deleted, or soft-deleted
 * by the operator's `gbrain delete` — so keeping the row open only ages
 * doctor toward a permanent FAIL.
 *
 * Fail-closed on every uncertain branch: a sentinel that failed again THIS
 * run (in `excludePaths`), one whose error text doesn't parse, or a probe
 * that throws leaves the row open — only a positive "no active row has the
 * old path" clears. ANY surviving active row keeps its sentinel: the
 * duplicate is real, and the operator remedy (`gbrain delete <stale-slug>`)
 * or a converging retry is the way out, not silent bookkeeping cleanup.
 */
async function orphanedRenameSentinels(
  engine: BrainEngine,
  sourceId: string,
  excludePaths: ReadonlySet<string>,
): Promise<string[]> {
  const candidates: Array<{ path: string; from: string }> = [];
  for (const row of loadSyncFailures()) {
    if (row.source_id !== sourceId || row.state !== 'open') continue;
    if (!row.path.startsWith(RENAME_SENTINEL_PREFIX)) continue;
    if (excludePaths.has(row.path)) continue;
    const from = parseRenameReconcileFrom(row.error);
    if (from === undefined) continue;
    candidates.push({ path: row.path, from });
  }
  if (candidates.length === 0) return [];
  try {
    const active = await activeSlugsBySourcePath(
      engine, [...new Set(candidates.map(c => c.from))], sourceId,
    );
    const firstPass = candidates.filter(c => !active.has(c.from));
    if (firstPass.length === 0) return [];
    // Second probe, immediately before the verdict leaves this function: a
    // writer outside the sync lock (a raw import, restore_page) can
    // materialize an active row with the old path between probe and clear.
    // Requiring two consecutive positive "no active row" verdicts shrinks
    // that window to the clear itself. Full atomicity is unreachable here —
    // the file ledger and the DB share no transaction — and a duplicate
    // re-created AFTER the clear is out of any sentinel's reach by design:
    // the sentinel is a one-shot failure record of a specific reconcile,
    // not a continuously re-derived invariant.
    const recheck = await activeSlugsBySourcePath(
      engine, [...new Set(firstPass.map(c => c.from))], sourceId,
    );
    return firstPass.filter(c => !recheck.has(c.from)).map(c => c.path);
  } catch {
    // Probe unavailable — leave every row open rather than guess.
    return [];
  }
}

/**
 * The quiet-run half of the #3479 blocker-2 fix: the up_to_date early
 * returns never reach the failure gate, and the reviewer's exact probe was
 * a `synced` then `up_to_date` run pair that left the orphaned sentinel
 * open forever. Clears directly through the ledger; a no-op (including the
 * no-ledger-file case) costs one small file read.
 *
 * Clear-then-verify: after the clear, verifyOrRestoreClearedSentinels runs
 * the probe once more and restores any sentinel whose old path re-acquired
 * an active row in the window.
 */
export async function sweepOrphanedRenameSentinels(
  engine: BrainEngine,
  sourceId: string,
  excludePaths: ReadonlySet<string> = new Set(),
): Promise<void> {
  const orphaned = await orphanedRenameSentinels(engine, sourceId, excludePaths);
  if (orphaned.length === 0) return;
  const orphanSet = new Set(orphaned);
  // Captured BEFORE the clear so a restore can reproduce the exact row.
  const clearedRows = loadSyncFailures().filter(
    r => r.source_id === sourceId && orphanSet.has(r.path),
  );
  clearFailures(sourceId, orphaned);
  serr(
    `  [sync] cleared ${orphaned.length} orphaned rename sentinel(s) — ` +
    `the stale row(s) they guarded no longer resolve.`,
  );
  await verifyOrRestoreClearedSentinels(engine, sourceId, clearedRows);
}

/**
 * The verify half of clear-then-verify (#3583), shared by every path that
 * clears `<rename:…>` sentinels on an orphan verdict (the quiet-run sweeps
 * AND both failure gates): probe once more AFTER the clear and RESTORE —
 * verbatim, via restoreFailures, so attempts / first_seen / commit survive
 * — any sentinel whose old path re-acquired an active row. A writer
 * outside the sync lock (a raw import, restore_page) landing between
 * probe and clear thereby converts from silently-lost to
 * detected-and-repaired.
 *
 * Fail-closed: when the verify probe itself is unavailable, EVERY cleared
 * row is restored — a premature restore is self-healing (the next quiet
 * run re-clears a genuinely-orphaned sentinel), a lost sentinel is not.
 * restoreFailures skips rows that are already present, so this can never
 * double-record or fight a gate that did not actually clear. A writer
 * landing after the verify probe is indistinguishable from one landing a
 * second after a legitimate clear — out of any sentinel's reach by design
 * (the sentinel is a one-shot failure record, not a continuously
 * re-derived invariant), and the file ledger and the DB share no
 * transaction that could close it.
 */
async function verifyOrRestoreClearedSentinels(
  engine: BrainEngine,
  sourceId: string,
  clearedRows: SyncFailure[],
): Promise<void> {
  if (clearedRows.length === 0) return;
  let revived: SyncFailure[];
  try {
    const froms = new Map<string, string>();
    for (const row of clearedRows) {
      const from = parseRenameReconcileFrom(row.error);
      if (from !== undefined) froms.set(row.path, from);
    }
    const active = await activeSlugsBySourcePath(
      engine, [...new Set(froms.values())], sourceId,
    );
    revived = clearedRows.filter(r => {
      const from = froms.get(r.path);
      return from !== undefined && active.has(from);
    });
  } catch {
    revived = clearedRows;
  }
  const restored = restoreFailures(sourceId, revived);
  if (restored > 0) {
    serr(
      `  [sync] restored ${restored} rename sentinel(s) — an active row ` +
      `re-acquired the old path after the clear, or verification was unavailable.`,
    );
  }
}
