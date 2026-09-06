/**
 * Per-page source-drift count for the extract_atoms phase.
 *
 * Doctor's `atom_provenance_drift` check (src/commands/doctor/checks/
 * extraction-sync.ts) reports, brain-wide and only when someone runs
 * `gbrain doctor`, atoms whose stored `source_hash` no longer resolves to a
 * live page. Its largest bucket is `source_changed`: the source page is still
 * there, it was just edited after the atoms were extracted. This module answers
 * the narrower per-page version of that question for the one page the phase is
 * already holding, so the number rides ordinary cycle output.
 *
 * Diagnostic only, exactly like the check it points at: one SELECT, no writes,
 * no retirement, no control-flow effect.
 */

import type { BrainEngine } from '../engine.ts';

/**
 * Count live atoms bound to `pageSlug` in `sourceId` whose stored `source_hash`
 * differs from `currentHash16`.
 *
 * `pending:%` rows are excluded for the same reason doctor excludes them: that
 * is the provisional marker written before an extraction commits (the
 * completion receipt in extract-atoms.ts), so it is in-flight, not drift.
 *
 * **Related to doctor's predicate, but deliberately not the same one.** Doctor
 * asks "does ANY live page in this source still carry the stored hash", which
 * lets it split `source_changed` from `source_gone` and leaves it unaffected by
 * a second page that happens to hold identical content. This asks the narrower
 * question the phase can answer for free — "does this atom match the content
 * this page currently has" — so it never distinguishes edited from deleted, and
 * it does count an atom whose hash is still carried by some OTHER live page.
 * Doctor stays the authoritative brain-wide view; this is a cheap in-run signal
 * pointing at it, not a replacement for it.
 *
 * `currentHash16` is the hash DISCOVERY captured for the page, i.e. the content
 * the run actually extracted from, so atoms this run just wrote are correctly
 * not counted. An edit that lands mid-run is therefore reported by the NEXT
 * run, not this one.
 *
 * Fail-soft: any query error returns 0. A reporting counter must never fail a
 * phase.
 */
export async function countSourceChangedAtoms(
  engine: BrainEngine,
  sourceId: string,
  pageSlug: string,
  currentHash16: string,
): Promise<number> {
  try {
    const rows = await engine.executeRaw<{ cnt: number | string }>(
      `SELECT COUNT(*)::int AS cnt
         FROM pages
        WHERE type = 'atom'
          AND deleted_at IS NULL
          AND source_id = $1
          AND frontmatter->>'source_slug' = $2
          AND frontmatter->>'source_hash' IS NOT NULL
          AND frontmatter->>'source_hash' NOT LIKE 'pending:%'
          AND frontmatter->>'source_hash' <> $3`,
      [sourceId, pageSlug, currentHash16],
    );
    const cnt = rows[0]?.cnt;
    return cnt == null ? 0 : Number(cnt);
  } catch {
    return 0;
  }
}
