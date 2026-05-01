/**
 * skillpack/installer.ts — copy bundle files into a target OpenClaw
 * workspace, atomically and with data-loss protection.
 *
 * Contracts (from codex outside-voice review):
 *   - Per-file diff protection (D-CX-3 / F4): if a target file differs
 *     from the bundle source, skip it unless `--overwrite-local` is
 *     passed. `--force` only bypasses the top-level "skill dir already
 *     exists" gate.
 *   - Dependency closure (D-CX-10): every skill install pulls the
 *     full `shared_deps` set so cross-references don't break.
 *   - Concurrency / lockfile (D-CX-11): acquire `.gbrain-skillpack.lock`
 *     before any write. Atomic AGENTS.md managed-block update via
 *     tmp + rename. Stale lock (>10 min PID mismatch) emits a warning
 *     and refuses to overwrite unless `--force-unlock`.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'fs';
import { dirname, join } from 'path';

import {
  enumerateBundle,
  loadBundleManifest,
  pathSlug,
  type BundleEntry,
  type BundleManifest,
} from './bundle.ts';
import { findResolverFile } from '../resolver-filenames.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FileOutcome =
  | 'wrote_new'
  | 'wrote_overwrite'
  | 'skipped_locally_modified'
  | 'skipped_identical'
  | 'skipped_overwrite_local_declined';

export interface FileResult {
  source: string;
  target: string;
  outcome: FileOutcome;
  sharedDep: boolean;
}

export interface ManagedBlockResult {
  resolverFile: string;
  applied: boolean;
  skippedReason?: 'resolver_not_found' | 'no_change';
}

export interface InstallPlan {
  gbrainRoot: string;
  targetSkillsDir: string;
  targetWorkspace: string;
  entries: BundleEntry[];
  manifest: BundleManifest;
  /** Computed diffs per entry — populated in planInstall, consumed by apply. */
  entryOutcomes: Array<{ entry: BundleEntry; existing: boolean; identical: boolean }>;
}

export interface InstallOptions {
  /** Absolute path to the target workspace (above skills/). */
  targetWorkspace: string;
  /** Absolute path to the target skills directory. */
  targetSkillsDir: string;
  /** Gbrain repo root (source). Defaults to the one found by findGbrainRoot. */
  gbrainRoot: string;
  /** Scope to a single skill slug, or `null` for --all. */
  skillSlug: string | null;
  /** Overwrite local files that differ from the bundle source. */
  overwriteLocal?: boolean;
  /** Dry-run: populate plan, do not write. */
  dryRun?: boolean;
  /** Forcibly proceed even when a stale lockfile exists. */
  forceUnlock?: boolean;
  /** Override the lock stale threshold (ms). Tests use this. */
  lockStaleMs?: number;
}

export class InstallError extends Error {
  constructor(
    message: string,
    public code:
      | 'lock_held'
      | 'bundle_error'
      | 'target_missing'
      | 'unknown_skill',
  ) {
    super(message);
    this.name = 'InstallError';
  }
}

const DEFAULT_LOCK_STALE_MS = 10 * 60 * 1000; // 10 minutes

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/**
 * Build an InstallPlan for either a single skill (by slug) or every
 * skill (`skillSlug: null`). Always returns the full dependency
 * closure (shared_deps + target skills).
 */
export function planInstall(opts: InstallOptions): InstallPlan {
  const manifest = loadBundleManifest(opts.gbrainRoot);
  const entries = enumerateBundle({
    gbrainRoot: opts.gbrainRoot,
    skillSlug: opts.skillSlug ?? undefined,
    manifest,
  });

  const entryOutcomes = entries.map(e => {
    const target = join(opts.targetSkillsDir, e.relTarget);
    const existing = existsSync(target);
    let identical = false;
    if (existing) {
      try {
        const a = readFileSync(e.source);
        const b = readFileSync(target);
        identical = a.equals(b);
      } catch {
        identical = false;
      }
    }
    return { entry: e, existing, identical };
  });

  return {
    gbrainRoot: opts.gbrainRoot,
    targetSkillsDir: opts.targetSkillsDir,
    targetWorkspace: opts.targetWorkspace,
    entries,
    manifest,
    entryOutcomes,
  };
}

// ---------------------------------------------------------------------------
// Lockfile (D-CX-11)
// ---------------------------------------------------------------------------

function lockPath(workspace: string): string {
  return join(workspace, '.gbrain-skillpack.lock');
}

interface LockInfo {
  pid: number;
  mtimeMs: number;
}

function readLock(workspace: string): LockInfo | null {
  const p = lockPath(workspace);
  if (!existsSync(p)) return null;
  try {
    const content = readFileSync(p, 'utf-8');
    const pid = parseInt(content.trim(), 10);
    const mtimeMs = statSync(p).mtimeMs;
    return { pid: isNaN(pid) ? -1 : pid, mtimeMs };
  } catch {
    return null;
  }
}

function acquireLock(workspace: string, opts: InstallOptions): void {
  const p = lockPath(workspace);
  const existing = readLock(workspace);
  const staleMs = opts.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
  if (existing) {
    // Clamp to 0. On Linux ext4, statSync().mtimeMs has sub-ms precision;
    // Date.now() is integer ms. A file written microseconds ago can report
    // a negative age here, which would break the staleMs:0 "any age is stale"
    // contract the force-unlock path relies on (CI passes, local macOS masks it).
    const age = Math.max(0, Date.now() - existing.mtimeMs);
    // `staleMs: 0` in tests means "any age counts as stale". Use >=
    // so a just-written lock qualifies when the threshold is 0.
    // Negative age (mtime in the future) happens on fast CI filesystems
    // where write → stat roundtrip returns an mtime microseconds ahead of
    // Date.now() — treat it as stale to avoid a "lock held" false positive.
    const stale = age < 0 || age >= staleMs;
    if (stale && !opts.forceUnlock) {
      throw new InstallError(
        `Stale skillpack lock at ${p} (pid ${existing.pid}, ${Math.round(age / 1000)}s old). Pass --force-unlock to proceed.`,
        'lock_held',
      );
    }
    if (stale && opts.forceUnlock) {
      try {
        unlinkSync(p);
      } catch {
        // fall through to write
      }
    } else if (!stale) {
      throw new InstallError(
        `Another skillpack install appears to be running (pid ${existing.pid}). Wait or pass --force-unlock.`,
        'lock_held',
      );
    }
  }
  mkdirSync(dirname(p), { recursive: true });
  const fd = openSync(p, 'w');
  try {
    writeSync(fd, String(process.pid));
  } finally {
    closeSync(fd);
  }
}

function releaseLock(workspace: string): void {
  const p = lockPath(workspace);
  try {
    unlinkSync(p);
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Managed block (AGENTS.md / RESOLVER.md)
// ---------------------------------------------------------------------------

const MANAGED_BEGIN = '<!-- gbrain:skillpack:begin -->';
const MANAGED_END = '<!-- gbrain:skillpack:end -->';

// Receipt comment embedded inside the fence on every write. Lets the
// next install distinguish "row gbrain installed previously" from
// "row a user hand-added inside the fence." Format is intentionally
// regex-friendly.
//
//   <!-- gbrain:skillpack:manifest cumulative-slugs="a,b,c" version="0.19.0" -->
//
// Sorted, comma-separated slug list. version is the gbrain version
// that wrote this receipt.
const RECEIPT_RE =
  /<!-- gbrain:skillpack:manifest cumulative-slugs="([^"]*)" version="([^"]*)" -->/;

function buildReceipt(cumulativeSlugs: string[], version: string): string {
  const sorted = [...cumulativeSlugs].sort();
  return `<!-- gbrain:skillpack:manifest cumulative-slugs="${sorted.join(',')}" version="${version}" -->`;
}

/**
 * Parse the receipt comment from a managed block. Returns null if no
 * receipt is present (pre-v0.19 fences). The slug list is split on
 * comma; an empty string returns an empty list.
 */
export function parseReceipt(resolverContent: string): { cumulativeSlugs: string[]; version: string } | null {
  const beginIdx = resolverContent.indexOf(MANAGED_BEGIN);
  const endIdx = resolverContent.indexOf(MANAGED_END);
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) return null;
  const block = resolverContent.slice(beginIdx, endIdx);
  const m = RECEIPT_RE.exec(block);
  if (!m) return null;
  const slugs = m[1].length === 0 ? [] : m[1].split(',');
  return { cumulativeSlugs: slugs, version: m[2] };
}

export function buildManagedBlock(
  manifest: BundleManifest,
  slugs: string[],
  cumulativeSlugs?: string[],
): string {
  const sorted = [...slugs].sort();
  const rows = sorted.map(
    slug => `| "${slug}" | \`skills/${slug}/SKILL.md\` |`,
  );
  // Default cumulative = the rendered slug set when caller didn't
  // pass one explicitly (kept backward-compatible with older callers
  // that don't yet thread the cumulative set through).
  const receipt = buildReceipt(cumulativeSlugs ?? sorted, manifest.version);
  return [
    MANAGED_BEGIN,
    '',
    `<!-- Installed by gbrain ${manifest.version} — do not hand-edit between markers. -->`,
    receipt,
    '',
    '| Trigger | Skill |',
    '|---------|-------|',
    ...rows,
    '',
    MANAGED_END,
  ].join('\n');
}

/**
 * Replace the managed block in `resolverContent` with `newBlock`. If
 * no managed block exists yet, append one (preceded by a blank line).
 */
export function updateManagedBlock(
  resolverContent: string,
  newBlock: string,
): string {
  const beginIdx = resolverContent.indexOf(MANAGED_BEGIN);
  const endIdx = resolverContent.indexOf(MANAGED_END);
  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = resolverContent.slice(0, beginIdx);
    const after = resolverContent.slice(endIdx + MANAGED_END.length);
    return before + newBlock + after;
  }
  const needsNewline = resolverContent.endsWith('\n') ? '' : '\n';
  return resolverContent + needsNewline + '\n' + newBlock + '\n';
}

function writeAtomic(file: string, content: string): void {
  const tmp = file + '.tmp.' + process.pid + '.' + Date.now();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export interface InstallResult {
  dryRun: boolean;
  files: FileResult[];
  managedBlock: ManagedBlockResult;
  summary: {
    wroteNew: number;
    wroteOverwrite: number;
    skippedIdentical: number;
    skippedLocallyModified: number;
  };
}

export function applyInstall(
  plan: InstallPlan,
  opts: InstallOptions,
): InstallResult {
  const files: FileResult[] = [];

  // Lock acquisition. Dry-run does NOT touch the lockfile — it's read-only.
  const shouldLock = !opts.dryRun;
  if (shouldLock) acquireLock(opts.targetWorkspace, opts);

  try {
    // Write files
    for (const { entry, existing, identical } of plan.entryOutcomes) {
      const target = join(plan.targetSkillsDir, entry.relTarget);
      let outcome: FileOutcome;
      if (!existing) {
        outcome = 'wrote_new';
        if (!opts.dryRun) {
          const content = readFileSync(entry.source);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, content);
        }
      } else if (identical) {
        outcome = 'skipped_identical';
      } else if (opts.overwriteLocal) {
        outcome = 'wrote_overwrite';
        if (!opts.dryRun) {
          const content = readFileSync(entry.source);
          writeFileSync(target, content);
        }
      } else {
        outcome = 'skipped_locally_modified';
      }
      files.push({
        source: entry.source,
        target,
        outcome,
        sharedDep: entry.sharedDep,
      });
    }

    // Managed block update.
    //
    // installedSlugs = slugs we just wrote in THIS call.
    // bundleSlugs    = the FULL bundle manifest's slug list (always
    //                  populated; used for the install-all prune path).
    // isInstallAll   = caller passed --all (no specific skillSlug).
    const installedSlugs = opts.skillSlug
      ? [opts.skillSlug]
      : plan.manifest.skills.map(pathSlug);
    const bundleSlugs = plan.manifest.skills.map(pathSlug);
    const isInstallAll = !opts.skillSlug;
    const managedBlock = applyManagedBlock(
      plan.targetWorkspace,
      plan.targetSkillsDir,
      plan.manifest,
      installedSlugs,
      bundleSlugs,
      isInstallAll,
      opts.dryRun ?? false,
    );

    const summary = {
      wroteNew: files.filter(f => f.outcome === 'wrote_new').length,
      wroteOverwrite: files.filter(f => f.outcome === 'wrote_overwrite').length,
      skippedIdentical: files.filter(f => f.outcome === 'skipped_identical').length,
      skippedLocallyModified: files.filter(
        f => f.outcome === 'skipped_locally_modified',
      ).length,
    };

    return { dryRun: opts.dryRun ?? false, files, managedBlock, summary };
  } finally {
    if (shouldLock) releaseLock(opts.targetWorkspace);
  }
}

function applyManagedBlock(
  workspace: string,
  skillsDir: string,
  manifest: BundleManifest,
  installedSlugs: string[],
  bundleSlugs: string[],
  isInstallAll: boolean,
  dryRun: boolean,
): ManagedBlockResult {
  // Prefer skills-dir resolver; fall back to workspace-root resolver.
  const resolver = findResolverFile(skillsDir) ?? findResolverFile(workspace);
  if (!resolver) {
    return {
      resolverFile: '',
      applied: false,
      skippedReason: 'resolver_not_found',
    };
  }
  const existing = readFileSync(resolver, 'utf-8');

  // Step 1: figure out what gbrain previously installed into this fence.
  //   - If receipt is present, trust it as the cumulative-slug history.
  //   - If receipt is absent (pre-v0.19 fence), fall back to the rows
  //     currently in the fence — they were ALL gbrain-written before
  //     the receipt feature existed, so trust them as the prior set.
  const receipt = parseReceipt(existing);
  const priorCumulativeSlugs =
    receipt !== null
      ? new Set(receipt.cumulativeSlugs)
      : new Set(extractManagedSlugs(existing));

  // Step 2: compute the new cumulative slug set.
  //   - Single-skill install: union(prior, installed). Per-skill
  //     installs accumulate; the documented v0.18 behavior.
  //   - Install-all: prune slugs no longer in the bundle. Renamed
  //     and removed skills leave the cumulative set ONLY via this
  //     path. (Single-skill never prunes — it would regress
  //     cumulative semantics for unrelated skills.)
  //
  // We track `prunedSlugs` separately so the unknown-row detector
  // (Step 3) doesn't re-resurrect slugs we just intentionally removed.
  const newCumulative = new Set(priorCumulativeSlugs);
  for (const s of installedSlugs) newCumulative.add(s);
  const prunedSlugs = new Set<string>();
  if (isInstallAll) {
    const bundleSet = new Set(bundleSlugs);
    for (const s of [...newCumulative]) {
      if (!bundleSet.has(s)) {
        newCumulative.delete(s);
        prunedSlugs.add(s);
      }
    }
  }

  // Step 3: detect unknown rows. A row inside the fence whose slug
  // is NOT in newCumulative AND NOT in bundleSlugs AND NOT in the
  // intentionally-pruned set is something gbrain never wrote: a user
  // hand-add, a typo, or stale debris from an unknown bundle.
  // Preserve it (do not destroy data) and emit a single stderr
  // warning per slug instructing the agent to investigate.
  const existingRowSlugs = extractManagedSlugs(existing);
  const bundleSet = new Set(bundleSlugs);
  const unknownSlugs: string[] = [];
  // Skip the unknown-row check on the very first v0.19 install (no
  // receipt yet). All existing rows are presumed gbrain-written and
  // captured into newCumulative via the fallback above; warning here
  // would create false positives.
  if (receipt !== null) {
    for (const slug of existingRowSlugs) {
      if (newCumulative.has(slug)) continue;
      if (bundleSet.has(slug)) continue;
      if (prunedSlugs.has(slug)) continue; // known prune, do not resurrect
      unknownSlugs.push(slug);
      // Re-add to newCumulative so the rebuild preserves the row.
      newCumulative.add(slug);
    }
  }
  for (const slug of unknownSlugs) {
    console.error(
      `[skillpack] unknown row in managed block: "${slug}" at skills/${slug}/SKILL.md — not in gbrain's installed set. Investigate: user-added skill, hand-edited fence, or typo?`,
    );
  }

  // Step 4: write the new block. The visible row set is sorted
  // newCumulative. The receipt comment carries the same set so the
  // next install can do the same diff.
  const cumulativeArr = [...newCumulative].sort();
  const newBlock = buildManagedBlock(manifest, cumulativeArr, cumulativeArr);
  const updated = updateManagedBlock(existing, newBlock);
  if (updated === existing) {
    return { resolverFile: resolver, applied: false, skippedReason: 'no_change' };
  }
  if (!dryRun) writeAtomic(resolver, updated);
  return { resolverFile: resolver, applied: true };
}

export function extractManagedSlugs(resolverContent: string): string[] {
  const beginIdx = resolverContent.indexOf(MANAGED_BEGIN);
  const endIdx = resolverContent.indexOf(MANAGED_END);
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) return [];
  const block = resolverContent.slice(beginIdx, endIdx);
  const slugs: string[] = [];
  const re = /`skills\/([^/]+)\/SKILL\.md`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    slugs.push(m[1]);
  }
  return slugs;
}

// ---------------------------------------------------------------------------
// Diff helpers (for `skillpack diff <name>`)
// ---------------------------------------------------------------------------

export interface SkillDiff {
  source: string;
  target: string;
  existing: boolean;
  identical: boolean;
  sourceBytes: number;
  targetBytes: number;
}

export function diffSkill(
  gbrainRoot: string,
  skillSlug: string,
  targetSkillsDir: string,
): SkillDiff[] {
  const manifest = loadBundleManifest(gbrainRoot);
  const entries = enumerateBundle({ gbrainRoot, skillSlug, manifest });
  const out: SkillDiff[] = [];
  for (const e of entries) {
    const target = join(targetSkillsDir, e.relTarget);
    const existing = existsSync(target);
    let identical = false;
    let targetBytes = 0;
    const sourceBytes = statSync(e.source).size;
    if (existing) {
      try {
        const a = readFileSync(e.source);
        const b = readFileSync(target);
        targetBytes = b.length;
        identical = a.equals(b);
      } catch {
        // treat as non-identical
      }
    }
    out.push({
      source: e.source,
      target,
      existing,
      identical,
      sourceBytes,
      targetBytes,
    });
  }
  return out;
}
