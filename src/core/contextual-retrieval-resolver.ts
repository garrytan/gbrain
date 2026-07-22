/**
 * v0.40.3.0 — contextual retrieval mode resolver.
 *
 * Pure function that picks the effective CRMode for one page by walking
 * the three-source override chain:
 *
 *   page frontmatter > source row > global mode bundle
 *
 * Mount-frontmatter overrides (D15 security gate): a per-page
 * `contextual_retrieval` frontmatter key in a MOUNTED source's page is
 * honored ONLY when that source's `trust_frontmatter_overrides` column is
 * true. The host source (id='default') is always trusted regardless of
 * the column value. This protects against pulling a third-party brain
 * that bakes `contextual_retrieval: per_chunk_synopsis` into every page's
 * frontmatter and draining your Haiku quota without consent.
 *
 * Unknown / invalid frontmatter values (typos like `per_chunk` instead of
 * `per_chunk_synopsis`) return `kind: 'invalid'` so the caller can write
 * a SyncFailure entry per D13. Falls back to the source/global tier.
 *
 * Pure — no engine calls, no env reads, no filesystem. Mockable in tests.
 */

import { CR_MODES, isCRMode, type CRMode } from './types.ts';

export interface ResolveContextualRetrievalModeArgs {
  /** Parsed page frontmatter (may contain `contextual_retrieval` key). */
  pageFrontmatter: Record<string, unknown>;
  /** The source row that owns this page. */
  source: {
    id: string;
    contextual_retrieval_mode?: string | null;
    trust_frontmatter_overrides?: boolean;
  };
  /** The global mode bundle's contextual_retrieval value. */
  globalMode: CRMode;
  /**
   * The soft kill switch from D18. When true, ALL overrides collapse to
   * 'none' regardless of frontmatter / source / global. Reads `search.
   * contextual_retrieval_disabled` config key at the caller.
   */
  killSwitchDisabled?: boolean;
}

/**
 * The host source id. Always trusted for frontmatter overrides regardless
 * of `trust_frontmatter_overrides` column value (which is for mounts).
 */
const HOST_SOURCE_ID = 'default';

export interface ResolveContextualRetrievalModeResult {
  /** The effective mode after override resolution. */
  mode: CRMode;
  /** Which source supplied the winning value (for attribution / doctor). */
  source: 'kill_switch' | 'page_frontmatter' | 'source_row' | 'global_mode';
  /**
   * When the page frontmatter contained an unknown / invalid value, this
   * carries the raw string so the caller can write a SyncFailure entry
   * with the typo for the doctor surface (D13). Absent on success paths.
   */
  invalid_frontmatter_value?: string;
  /**
   * True when the page frontmatter HAD a `contextual_retrieval` key BUT
   * was rejected because the source is a mount without
   * `trust_frontmatter_overrides`. Lets the doctor surface a hint pointing
   * at `gbrain mounts trust-frontmatter <source>`.
   */
  frontmatter_rejected_untrusted_mount?: boolean;
}

export function resolveContextualRetrievalMode(
  args: ResolveContextualRetrievalModeArgs,
): ResolveContextualRetrievalModeResult {
  // Kill switch shortcircuits everything (D18). Wrapped vectors in DB stay
  // valid; queries just stop seeing the lift, new embeds stop wrapping.
  if (args.killSwitchDisabled) {
    return { mode: 'none', source: 'kill_switch' };
  }

  const rawFrontmatterValue = args.pageFrontmatter['contextual_retrieval'];
  const hasFrontmatterKey = rawFrontmatterValue !== undefined;
  const isTrustedSource =
    args.source.id === HOST_SOURCE_ID ||
    args.source.trust_frontmatter_overrides === true;

  // Page frontmatter wins when present + trusted + valid.
  if (hasFrontmatterKey) {
    if (!isTrustedSource) {
      // Mount without trust flag — IGNORE the frontmatter override and
      // surface the rejection so doctor can hint about `mounts
      // trust-frontmatter`.
      const fallback = pickFromSourceOrGlobal(args);
      return {
        mode: fallback.mode,
        source: fallback.source,
        frontmatter_rejected_untrusted_mount: true,
      };
    }
    if (isCRMode(rawFrontmatterValue)) {
      return { mode: rawFrontmatterValue, source: 'page_frontmatter' };
    }
    // Unknown / invalid value (typo). Fall through to source/global per
    // D13 warn-and-default, surface raw string for SyncFailure entry.
    const fallback = pickFromSourceOrGlobal(args);
    return {
      mode: fallback.mode,
      source: fallback.source,
      invalid_frontmatter_value: String(rawFrontmatterValue),
    };
  }

  return pickFromSourceOrGlobal(args);
}

function pickFromSourceOrGlobal(
  args: Pick<ResolveContextualRetrievalModeArgs, 'source' | 'globalMode'>,
): { mode: CRMode; source: 'source_row' | 'global_mode' } {
  // Source-row override. NULL or missing column falls through to global.
  const sourceMode = args.source.contextual_retrieval_mode;
  if (typeof sourceMode === 'string' && isCRMode(sourceMode)) {
    return { mode: sourceMode, source: 'source_row' };
  }
  return { mode: args.globalMode, source: 'global_mode' };
}

/**
 * D26 P0-4 helper: SQL-style "is distinct from" for CRMode app-side
 * comparisons. `mode !== expected` in TS misses NULL drift in the same way
 * `col != expected` in SQL misses NULL drift — a NULL value is neither
 * equal nor unequal to any other value under three-valued logic. This
 * helper treats NULL/undefined as distinct from any defined mode.
 *
 *   crModeDistinct(undefined, 'title')  // true  (DB had no mode yet)
 *   crModeDistinct('title', 'title')    // false (aligned)
 *   crModeDistinct('title', undefined)  // true  (expected unset is odd)
 *   crModeDistinct(undefined, undefined)// false (both unset is aligned)
 */
export function crModeDistinct(
  actual: CRMode | string | null | undefined,
  expected: CRMode | string | null | undefined,
): boolean {
  if (actual == null && expected == null) return false;
  if (actual == null || expected == null) return true;
  return actual !== expected;
}

/**
 * Exported for tests + doctor / reindex predicates. Use this in code rather
 * than hand-typing the list — the canonical set lives in `types.ts:CR_MODES`.
 */
export const ALL_CR_MODES = CR_MODES;
