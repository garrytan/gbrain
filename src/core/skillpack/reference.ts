/**
 * skillpack/reference.ts — `gbrain skillpack reference <name>`.
 *
 * Read-only update lens. Compares every file in gbrain's bundle (skill
 * dir + paired sources + shared deps) against the host's local copy
 * and emits per-file status + unified diffs.
 *
 * The agent reads this output and decides what to integrate. gbrain
 * does NOT auto-apply (that's `reference --apply-clean-hunks` in T15,
 * which composes a separate apply step on top).
 *
 * Framing line is the load-bearing signal: "these are references; your
 * local edits are intentional; do not blindly overwrite."
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';

import {
  enumerateScaffoldEntries,
  loadBundleManifest,
  bundledSkillSlugs,
} from './bundle.ts';
import type { ScaffoldEntry } from './bundle.ts';
import { unifiedDiff } from './diff-text.ts';
import { applyHunks, parseUnifiedDiff } from './apply-hunks.ts';

export interface ReferenceOptions {
  /** Absolute path to gbrain repo root (source-of-truth bundle). */
  gbrainRoot: string;
  /** Absolute path to the target workspace. */
  targetWorkspace: string;
  /** Single skill slug, or `null` for --all (one-line-per-skill summary). */
  skillSlug: string | null;
}

export type ReferenceStatus = 'identical' | 'differs' | 'missing';

export interface ReferenceFileResult {
  source: string;
  target: string;
  status: ReferenceStatus;
  sharedDep: boolean;
  pairedSource: boolean;
  /** Unified diff text when status is 'differs'. Empty otherwise. */
  unifiedDiff: string;
  /** Byte sizes for quick scanning. */
  sourceBytes: number;
  targetBytes: number;
}

export interface ReferenceResult {
  /** Agent-readable framing line — load-bearing for the new model. */
  framing: string;
  files: ReferenceFileResult[];
  summary: {
    identical: number;
    differs: number;
    missing: number;
  };
}

export interface ReferenceAllResult {
  framing: string;
  skills: Array<{
    slug: string;
    summary: { identical: number; differs: number; missing: number };
  }>;
}

const FRAMING_TEMPLATE = (refPath: string): string =>
  `These files live at ${refPath} as reference. Read them and decide what (if anything) to integrate into your local skills/. Your local edits are intentional — do not blindly overwrite.`;

/**
 * Run reference against a single skill. Returns per-file status +
 * unified diffs.
 */
export function runReference(opts: ReferenceOptions): ReferenceResult {
  if (opts.skillSlug === null) {
    throw new Error('runReference requires a slug; use runReferenceAll() for --all');
  }
  const manifest = loadBundleManifest(opts.gbrainRoot);
  const entries = enumerateScaffoldEntries({
    gbrainRoot: opts.gbrainRoot,
    skillSlug: opts.skillSlug,
    manifest,
  });

  const files = entries.map(e => diffOne(opts.targetWorkspace, e));
  const framing = FRAMING_TEMPLATE(`${opts.gbrainRoot}/skills/${opts.skillSlug}/`);
  return {
    framing,
    files,
    summary: {
      identical: files.filter(f => f.status === 'identical').length,
      differs: files.filter(f => f.status === 'differs').length,
      missing: files.filter(f => f.status === 'missing').length,
    },
  };
}

/**
 * Run reference across every bundled skill — one-line-per-skill summary.
 * Used by `gbrain skillpack reference --all` for the upgrade sweep
 * workflow.
 */
export function runReferenceAll(opts: Omit<ReferenceOptions, 'skillSlug'>): ReferenceAllResult {
  const manifest = loadBundleManifest(opts.gbrainRoot);
  const slugs = bundledSkillSlugs(manifest);
  const skills = slugs.map(slug => {
    const entries = enumerateScaffoldEntries({
      gbrainRoot: opts.gbrainRoot,
      skillSlug: slug,
      manifest,
    });
    const files = entries.map(e => diffOne(opts.targetWorkspace, e));
    return {
      slug,
      summary: {
        identical: files.filter(f => f.status === 'identical').length,
        differs: files.filter(f => f.status === 'differs').length,
        missing: files.filter(f => f.status === 'missing').length,
      },
    };
  });
  return {
    framing: FRAMING_TEMPLATE(`${opts.gbrainRoot}/skills/`),
    skills,
  };
}

// ---------------------------------------------------------------------------
// `reference --apply-clean-hunks` (D15, TODO-3 folded)
// ---------------------------------------------------------------------------

export interface ReferenceApplyOptions extends ReferenceOptions {
  /** Dry-run: compute the apply, report outcomes, don't write. */
  dryRun?: boolean;
}

export interface ReferenceApplyFileResult {
  source: string;
  target: string;
  status: 'identical' | 'missing' | 'applied_clean' | 'partial' | 'binary_skip';
  /** Hunks applied to the target. 0 when identical / missing / binary. */
  hunksApplied: number;
  /** Hunks that conflicted and were left alone. */
  hunksConflicted: number;
  /** Detail entries for each conflicting hunk — `file:line: Manual merge needed.` */
  conflicts: string[];
  sharedDep: boolean;
  pairedSource: boolean;
}

export interface ReferenceApplyResult {
  framing: string;
  dryRun: boolean;
  files: ReferenceApplyFileResult[];
  summary: {
    filesApplied: number;
    filesPartial: number;
    filesIdentical: number;
    filesMissing: number;
    filesBinarySkipped: number;
    totalHunksApplied: number;
    totalHunksConflicted: number;
  };
}

/**
 * Run `reference --apply-clean-hunks`. For each `differs` file, parses
 * the diff between the user's local copy (target) and gbrain's bundle
 * (source), then applies every hunk whose pre-change context appears
 * uniquely in the user's file. Writes the result back. Conflicting
 * hunks are left alone and reported.
 *
 * **Two-way merge limitation (D15 contract).** Without scaffold-time
 * base tracking, this command cannot distinguish "gbrain changed line
 * X" from "the user changed line X." Both look like differences from
 * gbrain's current bundle. Applied hunks therefore replace the user's
 * local content with gbrain's wherever they differ, including spots
 * the user intentionally edited. Use `--dry-run` first, or run
 * `gbrain skillpack reference <name>` to inspect the diff before
 * applying. True three-way merge with scaffold-time base is in the
 * NOT-in-scope section of the v0.33 plan.
 *
 * Missing target files are NOT created here — scaffold's job. Binary
 * files are skipped (can't text-merge).
 */
export function runReferenceApply(opts: ReferenceApplyOptions): ReferenceApplyResult {
  if (opts.skillSlug === null) {
    throw new Error(
      'runReferenceApply requires a slug; --all+--apply-clean-hunks is intentionally not supported (apply one skill at a time)',
    );
  }
  const manifest = loadBundleManifest(opts.gbrainRoot);
  const entries = enumerateScaffoldEntries({
    gbrainRoot: opts.gbrainRoot,
    skillSlug: opts.skillSlug,
    manifest,
  });

  const files: ReferenceApplyFileResult[] = [];
  for (const entry of entries) {
    files.push(applyOne(opts.targetWorkspace, entry, opts.dryRun ?? false));
  }

  return {
    framing: FRAMING_TEMPLATE(`${opts.gbrainRoot}/skills/${opts.skillSlug}/`),
    dryRun: opts.dryRun ?? false,
    files,
    summary: {
      filesApplied: files.filter(f => f.status === 'applied_clean').length,
      filesPartial: files.filter(f => f.status === 'partial').length,
      filesIdentical: files.filter(f => f.status === 'identical').length,
      filesMissing: files.filter(f => f.status === 'missing').length,
      filesBinarySkipped: files.filter(f => f.status === 'binary_skip').length,
      totalHunksApplied: files.reduce((s, f) => s + f.hunksApplied, 0),
      totalHunksConflicted: files.reduce((s, f) => s + f.hunksConflicted, 0),
    },
  };
}

function applyOne(
  targetWorkspace: string,
  entry: ScaffoldEntry,
  dryRun: boolean,
): ReferenceApplyFileResult {
  const target = join(targetWorkspace, entry.relWorkspaceTarget);
  const base = {
    source: entry.source,
    target,
    hunksApplied: 0,
    hunksConflicted: 0,
    conflicts: [] as string[],
    sharedDep: entry.sharedDep,
    pairedSource: entry.pairedSource,
  };

  if (!existsSync(target)) {
    return { ...base, status: 'missing' };
  }
  const aBuf = readFileSync(entry.source);
  const bBuf = readFileSync(target);
  if (aBuf.equals(bBuf)) {
    return { ...base, status: 'identical' };
  }
  if (aBuf.includes(0) || bBuf.includes(0)) {
    return { ...base, status: 'binary_skip' };
  }

  const diff = unifiedDiff(aBuf.toString('utf-8'), bBuf.toString('utf-8'));
  // The diff above is target→source (b→a). We need source→target for
  // apply: gbrain (a) is what we want to bring into the target. So
  // recompute with the operands swapped.
  const diffApply = unifiedDiff(bBuf.toString('utf-8'), aBuf.toString('utf-8'));
  const parsed = parseUnifiedDiff(diffApply);
  const result = applyHunks(bBuf.toString('utf-8'), parsed);

  // Conflict locations: report by zero-based hunk index + line range.
  for (let i = 0; i < result.outcomes.length; i++) {
    const o = result.outcomes[i];
    if (o.status === 'applied') continue;
    const h = parsed.hunks[i];
    base.conflicts.push(
      `${target}:${h.oldStart},${h.oldCount}: Manual merge needed (${o.status}).`,
    );
  }

  base.hunksApplied = result.applied;
  base.hunksConflicted = result.conflicted;

  if (!dryRun && result.applied > 0) {
    writeFileSync(target, result.text);
  }

  const status: ReferenceApplyFileResult['status'] =
    result.applied > 0 && result.conflicted === 0
      ? 'applied_clean'
      : 'partial';
  return { ...base, status };
}

function diffOne(targetWorkspace: string, entry: ScaffoldEntry): ReferenceFileResult {
  const target = join(targetWorkspace, entry.relWorkspaceTarget);
  const sourceBytes = statSync(entry.source).size;
  let targetBytes = 0;
  let status: ReferenceStatus;
  let diffText = '';

  if (!existsSync(target)) {
    status = 'missing';
  } else {
    const aBuf = readFileSync(entry.source);
    const bBuf = readFileSync(target);
    targetBytes = bBuf.length;
    if (aBuf.equals(bBuf)) {
      status = 'identical';
    } else {
      status = 'differs';
      // Best-effort textual diff. Binary files fall through to a stub
      // (binary detection: any NUL byte in either buffer).
      const isBinary = aBuf.includes(0) || bBuf.includes(0);
      if (isBinary) {
        diffText = `Binary files differ (a: ${sourceBytes}B, b: ${targetBytes}B). Use a binary-aware tool to inspect.\n`;
      } else {
        diffText = unifiedDiff(aBuf.toString('utf-8'), bBuf.toString('utf-8'), {
          oldPath: `a/${entry.relWorkspaceTarget}`,
          newPath: `b/${entry.relWorkspaceTarget}`,
        });
      }
    }
  }

  return {
    source: entry.source,
    target,
    status,
    sharedDep: entry.sharedDep,
    pairedSource: entry.pairedSource,
    unifiedDiff: diffText,
    sourceBytes,
    targetBytes,
  };
}
