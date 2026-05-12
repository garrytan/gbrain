/**
 * v0.32.2: pure mapper from parsed-fence rows → NewFact rows ready for
 * batch insert.
 *
 * The fence parser (`src/core/facts-fence.ts`) is markdown-shaped: rows
 * carry strings, optional flags, and the strikethrough-context semantic
 * distinction. The engine layer (`engine.insertFact` / new
 * `engine.insertFacts`) is Date-shaped and DB-shaped. This module is the
 * boundary.
 *
 * It is intentionally pure: no engine call, no I/O. Inputs are the parsed
 * facts plus the page-level binding (entity slug + source_id). Output is
 * a `FenceExtractedFact[]` — structural superset of `NewFact` that
 * carries the v51 fence columns (`row_num`, `source_markdown_slug`).
 *
 * Codex Q7 resolution: engines stay markdown-unaware. The cycle phase
 * (commit 7) and the backstop rewrite (commit 5) call this function to
 * convert parsed fences into engine-shaped rows, then hand them to the
 * batch insert.
 *
 * Strikethrough → date derivation:
 *   - `forgotten` rows get `valid_until = today` so the DB's existing
 *     `expired_at = valid_until + now()` rule produces the same forget
 *     state after `gbrain rebuild` (v0.32.3) as before.
 *   - `supersededBy` rows preserve their existing `validUntil` if set;
 *     otherwise leave `valid_until = null` (the consolidator phase fills
 *     this in based on the newer row's `valid_from`).
 *   - Inactive rows with neither flag (parser-tolerated hand-edits) are
 *     treated like `forgotten` for DB-derivation purposes — the user's
 *     strikethrough intent is honored; the lost reason is a JSONL
 *     warning surfaced by extract-facts, not a parse failure.
 */

import type { NewFact, FactKind, FactVisibility } from '../engine.ts';
import type { ParsedFact } from '../facts-fence.ts';

/**
 * Fence-extracted fact row. Structural superset of `NewFact` with the
 * v51 fence-only columns. Commit 4 widens the engine surface
 * (`insertFacts(rows, opts)`) to accept this shape directly. Until then,
 * the type lives here so commit 3 ships without an engine touch.
 */
export type FenceExtractedFact = NewFact & {
  row_num: number;
  source_markdown_slug: string;
};

/**
 * Default `source` value when a fence row doesn't carry one. The string
 * is the explicit provenance tag downstream consumers (recall, doctor)
 * use to distinguish backfilled / reconciled rows from rows originally
 * inserted via `mcp:extract_facts` or `cli:think`.
 *
 * Exported so the migration orchestrator (commit 6) can reuse it when
 * fencing pre-v51 DB facts that have no `source` recorded.
 */
export const FENCE_SOURCE_DEFAULT = 'fence:reconcile';

function parseValidDate(s: string | undefined): Date | undefined {
  if (!s) return undefined;
  // Be lenient on date shape — accept 'YYYY-MM-DD' or full ISO.
  // Invalid → undefined (caller decides whether to default or skip).
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : undefined;
}

/**
 * Format today's date as 'YYYY-MM-DD' UTC. Stable across timezones — used
 * by the forgotten-row derivation so re-running the mapping on the same
 * fence in different zones produces an identical `valid_until` (matters
 * for the bisect E2E that asserts byte-identical DB state after re-extract).
 */
function todayUtcDate(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export interface ExtractFromFenceOpts {
  /**
   * Override for "today" — only used by tests to make the forgotten-row
   * derivation deterministic. Production callers leave this unset and
   * the mapper uses real UTC midnight today.
   */
  nowOverride?: Date;
}

/**
 * Map an array of parsed fence rows into engine-ready batch insert rows.
 *
 * @param facts        ParsedFact[] from parseFactsFence()
 * @param slug         The entity page slug (also becomes source_markdown_slug)
 * @param sourceId     The source binding (resolved from sources.local_path
 *                     by the caller; multi-source brains thread this through)
 * @param opts         Test-only overrides
 */
export function extractFactsFromFenceText(
  facts: ParsedFact[],
  slug: string,
  sourceId: string,
  opts: ExtractFromFenceOpts = {},
): FenceExtractedFact[] {
  const today = opts.nowOverride ?? todayUtcDate();

  return facts.map(f => {
    const validFrom = parseValidDate(f.validFrom);

    // valid_until derivation. Three branches:
    //   1. Explicit validUntil in the fence → honor as-is.
    //   2. Inactive (forgotten OR strikethrough-unrecognized) → today.
    //   3. Otherwise → null.
    // supersededBy without an explicit validUntil leaves null; the
    // consolidator phase populates it later from the newer row's
    // valid_from.
    let validUntil: Date | null;
    const explicitUntil = parseValidDate(f.validUntil);
    if (explicitUntil) {
      validUntil = explicitUntil;
    } else if (!f.active && (f.forgotten || f.supersededBy === undefined)) {
      // forgotten or unrecognized-inactive: stamp today.
      // (supersededBy with NO explicit validUntil falls through to null
      // intentionally — the consolidator owns that derivation.)
      validUntil = today;
    } else {
      validUntil = null;
    }

    const row: FenceExtractedFact = {
      fact: f.claim,
      kind: f.kind as FactKind,
      entity_slug: slug,
      visibility: f.visibility as FactVisibility,
      notability: f.notability,
      context: f.context ?? null,
      valid_from: validFrom,
      valid_until: validUntil,
      source: f.source ?? FENCE_SOURCE_DEFAULT,
      confidence: f.confidence,
      row_num: f.rowNum,
      source_markdown_slug: slug,
    };
    return row;
  });
}
