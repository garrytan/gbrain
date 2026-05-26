/**
 * `.gbrainignore` + multi-layer sync exclusion.
 *
 * Per-repo file-walk exclusion for `gbrain sync` / `gbrain import` / autopilot cycle.
 * Three layers, additive (later wins per gitignore last-match-wins semantics):
 *
 *   1. `.gbrainignore` at repo root (PR-reviewed checked-in policy)
 *   2. `sources.config.excludePatterns` JSONB (per-source persistent overrides)
 *   3. `--exclude <glob>` CLI flag (one-shot override; can rescue via `--exclude '!path'`)
 *
 * Pure module: no engine, no command imports. Safe to consume from anywhere in
 * the import graph.
 *
 * v0.40.9.0 design decisions, locked in plan-eng-review:
 *   - A3: walker descent-prune is disabled when ANY merged pattern starts with `!`.
 *     The `ignore` lib can't cheaply tell "could a child be re-included?" so we
 *     fall back to per-file checks whenever a negation exists. Fast path for the
 *     95% of users with no negation; correctness for the 5% who do.
 *   - A4: merge order is dotfile → source.config → cli. CLI flags win.
 *   - C1: ONE entry point — `resolveExclusions()`. Four call sites (incremental
 *     sync, full sync, --all fan-out, autopilot cycle) consume it.
 *   - C2: mtime-based cache invalidation. The autopilot daemon is a long-lived
 *     process; users who edit `.gbrainignore` mid-day expect the next cycle to
 *     honor the edit. stat(~10μs) on every call is negligible.
 *
 * gitignore parity comes from the `ignore` npm lib (ESLint / Prettier / Husky
 * use it). MIT, ~17KB packed, zero transitive deps, pure JS.
 */

import { existsSync, readFileSync, statSync, realpathSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import ignore from 'ignore';

// ── Types ──────────────────────────────────────────────────────────────────

export interface GbrainIgnoreMatcher {
  /** True iff `relativePath` (from repo root, forward-slash separated) is excluded. */
  ignores(relativePath: string): boolean;
  /** Source patterns in merge order. Empty array means no exclusion. */
  readonly patterns: readonly string[];
  /**
   * True iff the walker can short-circuit descent on a directory match.
   * False when ANY merged pattern starts with `!` (gitignore negation) —
   * a child file might be re-included so we must walk the dir. See A3.
   */
  readonly safeForDescentPrune: boolean;
  /** SHA-8 of the canonical pattern list. Used by sync.ts reconciliation hash gate (A2). */
  readonly patternsHash: string;
}

export interface ResolveExclusionsOpts {
  /** Absolute or relative path to the repo root (`.gbrainignore` lives at this path). */
  repoPath: string;
  /** Parsed sources.config JSON object. Reads `excludePatterns?: string[]`. */
  sourceConfig?: Record<string, unknown> | null;
  /** From `--exclude <glob>` CLI flag (repeatable). */
  cliExcludes?: string[];
}

// ── Cache (C2: mtime-invalidated) ───────────────────────────────────────────

interface CacheEntry {
  /** mtimeMs of `.gbrainignore`, or 0 if the file is absent. */
  mtimeMs: number;
  /** Cached merge of the dotfile patterns ONLY (not cli / source.config — those vary per call). */
  dotfilePatterns: string[];
}

const _dotfileCache = new Map<string, CacheEntry>();

/** Test seam — used only by test/gbrainignore.test.ts to reset state between cases. */
export function _resetGbrainignoreCache(): void {
  _dotfileCache.clear();
}

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Read `.gbrainignore` from `repoPath`, returning its pattern lines.
 *
 * Per the v0.40.9.0 design:
 *   - missing file → []
 *   - empty / all-comments → []
 *   - read error (perms, weird encoding, etc) → warn to stderr, return [] (fail-open;
 *     same posture as `manageGitignore` at src/commands/sync.ts:2316)
 *   - >1000 lines → warn + truncate (sanity cap; legit dotfiles are tiny)
 *
 * Comment/blank-line stripping happens HERE so callers don't have to think
 * about it. The `ignore` lib also strips them, but normalizing here makes
 * the cache + hash deterministic regardless of trailing-whitespace shuffles.
 */
function readDotfilePatterns(repoPath: string): string[] {
  const dotfilePath = join(repoPath, '.gbrainignore');
  if (!existsSync(dotfilePath)) return [];
  let raw: string;
  try {
    raw = readFileSync(dotfilePath, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[gbrainignore] could not read ${dotfilePath}: ${msg} — exclusions skipped`);
    return [];
  }
  const lines = raw.split(/\r?\n/);
  const MAX_LINES = 1000;
  let truncated = false;
  let lineSource = lines;
  if (lines.length > MAX_LINES) {
    truncated = true;
    lineSource = lines.slice(0, MAX_LINES);
  }
  const out: string[] = [];
  for (const rawLine of lineSource) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (line.startsWith('#')) continue;
    out.push(line);
  }
  if (truncated) {
    console.warn(
      `[gbrainignore] ${dotfilePath} exceeds ${MAX_LINES} lines — truncated. Trim the file or open an issue if you have a legitimate use case for more.`,
    );
  }
  return out;
}

/**
 * Stat `.gbrainignore` for its mtime in milliseconds. Returns 0 when the
 * file is absent so missing → present transitions still invalidate the cache
 * (0 < any real mtime).
 */
function dotfileMtimeMs(repoPath: string): number {
  const dotfilePath = join(repoPath, '.gbrainignore');
  try {
    if (!existsSync(dotfilePath)) return 0;
    return statSync(dotfilePath).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Resolve `repoPath` to its canonical absolute form for cache keying.
 * `realpathSync` handles symlinked Conductor worktrees: two worktrees of the
 * same repo at different paths still cache independently, but the same
 * worktree reached via different symlink chains shares a cache entry.
 */
function cacheKey(repoPath: string): string {
  try {
    return realpathSync(repoPath);
  } catch {
    return repoPath;
  }
}

// ── Public surface ──────────────────────────────────────────────────────────

/**
 * Read (and cache) the `.gbrainignore` patterns for a repo. Returns a frozen
 * snapshot. Mutating the returned array is undefined behavior.
 *
 * v0.40.9.0 (C2): mtime check on every call. Re-reads when the file has been
 * edited since the cache was written. Missing → present and present → missing
 * transitions also invalidate (the mtime sentinel handles both).
 */
export function loadGbrainignore(repoPath: string): readonly string[] {
  const key = cacheKey(repoPath);
  const currentMtime = dotfileMtimeMs(repoPath);
  const cached = _dotfileCache.get(key);
  if (cached && cached.mtimeMs === currentMtime) {
    return cached.dotfilePatterns;
  }
  const patterns = readDotfilePatterns(repoPath);
  _dotfileCache.set(key, { mtimeMs: currentMtime, dotfilePatterns: patterns });
  return patterns;
}

/**
 * Extract `excludePatterns` from a parsed `sources.config` JSONB. Defensive
 * against the schemaless-by-design source config (matches the existing
 * `cfg.strategy` cast pattern at src/commands/sync.ts:1596).
 *
 * Rejects non-string entries and bounds the length at 200 patterns (the same
 * sanity cap `gbrain sources add --exclude` enforces — keeps a malformed row
 * from poisoning every sync).
 */
function readSourceConfigExcludes(sourceConfig?: Record<string, unknown> | null): string[] {
  if (!sourceConfig) return [];
  const raw = sourceConfig.excludePatterns;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const p of raw) {
    if (typeof p !== 'string') continue;
    const trimmed = p.trim();
    if (trimmed === '') continue;
    out.push(trimmed);
    if (out.length >= 200) break;
  }
  return out;
}

/** Sanitize CLI `--exclude` flag values (same rules as the source-config read). */
function readCliExcludes(cliExcludes?: string[]): string[] {
  if (!cliExcludes || cliExcludes.length === 0) return [];
  const out: string[] = [];
  for (const p of cliExcludes) {
    if (typeof p !== 'string') continue;
    const trimmed = p.trim();
    if (trimmed === '') continue;
    out.push(trimmed);
    if (out.length >= 200) break;
  }
  return out;
}

/**
 * Compute SHA-8 of the canonicalized merged pattern list. Used by the A2
 * reconciliation hash gate at src/commands/sync.ts: when the hash changes vs
 * `sources.config.excludePatternsHash`, run the orphan-page cleanup pass.
 *
 * Canonicalization: the merged list is hashed verbatim with `\n` separators.
 * Order matters (gitignore semantics depend on order). Empty list → empty
 * string SHA-8 ("e3b0c442" — the well-known sha256 of empty input, truncated).
 */
function computePatternsHash(merged: readonly string[]): string {
  const text = merged.join('\n');
  return createHash('sha256').update(text).digest('hex').slice(0, 8);
}

/**
 * Detect whether the merged pattern list contains any gitignore negation.
 * A3: when true, the walker MUST NOT descent-prune on dir matches because
 * a `!path/inside.md` pattern might re-include a file inside an excluded
 * directory.
 *
 * Conservative: any pattern starting with `!` (after trim) triggers the
 * fallback, even when the negation can't actually rescue anything. False
 * positives cost some walker IO; false negatives cost correctness.
 */
function detectNegation(merged: readonly string[]): boolean {
  for (const p of merged) {
    if (p.startsWith('!')) return true;
  }
  return false;
}

/**
 * One entry point for the four sync call sites. Returns a fully-built matcher
 * plus the metadata downstream callers need (hash for reconciliation, descent-
 * prune safety flag for the walker).
 *
 * Merge order (A4): dotfile → source.config → cli. Gitignore last-match-wins
 * means cli flags can `!rescue` files from dotfile excludes.
 *
 * Pre-built matcher never throws. The `ignore` lib accepts arbitrary strings;
 * if a future version rejects something, we catch and fall back to an empty
 * matcher with a stderr warn (fail-open per the v0.22.11 manageGitignore
 * precedent).
 */
export function resolveExclusions(opts: ResolveExclusionsOpts): GbrainIgnoreMatcher {
  const dotfile = loadGbrainignore(opts.repoPath);
  const sourceCfg = readSourceConfigExcludes(opts.sourceConfig);
  const cli = readCliExcludes(opts.cliExcludes);
  const merged: string[] = [...dotfile, ...sourceCfg, ...cli];

  const safeForDescentPrune = !detectNegation(merged);
  const patternsHash = computePatternsHash(merged);

  // Empty matcher fast path — keeps the per-call cost near-zero for the
  // 99% of repos that don't have any exclusions configured.
  if (merged.length === 0) {
    return Object.freeze({
      ignores: (_p: string) => false,
      patterns: Object.freeze([]),
      safeForDescentPrune: true,
      patternsHash,
    });
  }

  let ig: ReturnType<typeof ignore>;
  try {
    ig = ignore().add(merged);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[gbrainignore] failed to compile ${merged.length} pattern(s): ${msg} — exclusions skipped`);
    return Object.freeze({
      ignores: (_p: string) => false,
      patterns: Object.freeze([]),
      safeForDescentPrune: true,
      patternsHash: computePatternsHash([]),
    });
  }

  const frozenPatterns = Object.freeze([...merged]);
  return Object.freeze({
    ignores: (relativePath: string): boolean => {
      // ignore lib expects forward-slash paths and rejects absolute paths.
      // Normalize windows backslashes + strip any leading slash.
      const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
      if (normalized === '') return false;
      try {
        return ig.ignores(normalized);
      } catch {
        return false;
      }
    },
    patterns: frozenPatterns,
    safeForDescentPrune,
    patternsHash,
  });
}
