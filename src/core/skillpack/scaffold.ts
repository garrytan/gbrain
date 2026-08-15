/**
 * skillpack/scaffold.ts — `gbrain skillpack scaffold <name>`.
 *
 * One-time, additive copy of a bundled skill into a host workspace. The
 * file-copy primitive is shared with harvest (host→gbrain) via
 * `copyArtifacts`. The bundle enumeration is shared with the bundle
 * manifest itself via `enumerateScaffoldEntries` — which now also picks
 * up paired source files declared in each skill's frontmatter
 * `sources:` array.
 *
 * Contracts (the new model):
 *   1. **No managed-block writes.** The host's RESOLVER.md / AGENTS.md
 *      stays untouched. Routing happens via each skill's frontmatter
 *      `triggers:` array, which downstream agents walk at runtime.
 *   2. **Refuses to overwrite existing files.** Once a file lands, the
 *      user owns it. To update, run `gbrain skillpack reference <name>`
 *      and decide.
 *   3. **Partial-state policy.** When `skills/<slug>/` already exists
 *      but the skill's frontmatter declares paired `sources:` that are
 *      missing on host, scaffold copies the missing paired files into
 *      place. Existing files are still preserved. Closes the
 *      "skill shipped, later gained a paired source" gap.
 *   4. **No lockfile, no cumulative-slugs receipt, no `--all` prune.**
 *      All deleted. The new model lets the user own the files; nothing
 *      to lock or to track.
 */

import { join } from 'path';

import { copyArtifacts, walkSourceDir } from './copy.ts';
import type { CopyItem } from './copy.ts';
import { enumerateScaffoldEntries, loadBundleManifest } from './bundle.ts';
import type { ScaffoldEntry } from './bundle.ts';

export interface ScaffoldOptions {
  /** Absolute path to gbrain repo root (source-of-truth bundle). */
  gbrainRoot: string;
  /** Absolute path to the target agent-repo workspace. */
  targetWorkspace: string;
  /** Single skill slug, or `null` for --all. */
  skillSlug: string | null;
  /** Dry-run: validate + report; no writes. */
  dryRun?: boolean;
}

export type ScaffoldOutcome = 'wrote_new' | 'skipped_existing';

export interface ScaffoldFileResult {
  source: string;
  target: string;
  outcome: ScaffoldOutcome;
  sharedDep: boolean;
  pairedSource: boolean;
}

export interface ScaffoldResult {
  dryRun: boolean;
  files: ScaffoldFileResult[];
  summary: {
    wroteNew: number;
    skippedExisting: number;
    /** Among `wroteNew`, how many were paired source files (frontmatter
     *  `sources:`) — useful for partial-state cases where the skill
     *  already existed but a paired source was missing. */
    pairedSourcesWritten: number;
  };
}

export class ScaffoldError extends Error {
  constructor(
    message: string,
    public code: 'bundle_error' | 'target_missing' | 'unknown_skill',
  ) {
    super(message);
    this.name = 'ScaffoldError';
  }
}

/**
 * Run a scaffold. Loads the bundle manifest, enumerates every file the
 * skill (or all skills when slug=null) would land, and copies them into
 * the target workspace at their mirror paths. Refuses to overwrite any
 * existing file.
 *
 * Idempotent: re-running on a fully-scaffolded workspace is a no-op.
 *
 * Partial-state handled naturally: if `skills/<slug>/` exists but a
 * declared paired source is missing, the missing item is copied while
 * the present ones are skipped.
 */
export function runScaffold(opts: ScaffoldOptions): ScaffoldResult {
  const manifest = loadBundleManifest(opts.gbrainRoot);

  // enumerateScaffoldEntries throws BundleError if the slug is unknown
  // or if any declared paired source is missing on disk. Surface those
  // as ScaffoldError with the matching code for caller ergonomics.
  let entries: ScaffoldEntry[];
  try {
    entries = enumerateScaffoldEntries({
      gbrainRoot: opts.gbrainRoot,
      skillSlug: opts.skillSlug ?? undefined,
      manifest,
    });
  } catch (err) {
    const e = err as Error & { code?: string };
    if (e.code === 'skill_not_found') {
      throw new ScaffoldError(e.message, 'unknown_skill');
    }
    throw new ScaffoldError(e.message, 'bundle_error');
  }

  // Map ScaffoldEntry → CopyItem (workspace-rooted target path).
  const items: CopyItem[] = entries.map(e => ({
    source: e.source,
    target: join(opts.targetWorkspace, e.relWorkspaceTarget),
  }));

  // Shared copy primitive. Refuses to overwrite existing files; no
  // symlink check or path confinement (the scaffold source is gbrain's
  // own trusted bundle).
  const copyResult = copyArtifacts(items, { dryRun: opts.dryRun });

  // Stitch outcomes back to ScaffoldEntry metadata so callers can tell
  // sharedDep / pairedSource per file.
  const files: ScaffoldFileResult[] = copyResult.files.map((f, i) => ({
    source: f.source,
    target: f.target,
    outcome: f.outcome,
    sharedDep: entries[i].sharedDep,
    pairedSource: entries[i].pairedSource,
  }));

  return {
    dryRun: copyResult.dryRun,
    files,
    summary: {
      wroteNew: copyResult.summary.wroteNew,
      skippedExisting: copyResult.summary.skippedExisting,
      pairedSourcesWritten: files.filter(
        f => f.outcome === 'wrote_new' && f.pairedSource,
      ).length,
    },
  };
}

// Re-export the public symbols from copy.ts so callers can `import
// { walkSourceDir } from 'scaffold.ts'` if they prefer one entry point.
// (Not load-bearing — direct imports from copy.ts are equally fine.)
export { copyArtifacts, walkSourceDir };
