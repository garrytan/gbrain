/**
 * BrainBench cross-session continuity scoring.
 *
 * A continuity pair runs writer fixture → (production write-back pipeline) →
 * reader fixture on the SAME brain, with writer and reader replayed through
 * DIFFERENT harness adapters and distinct session identities (decision 14's
 * session-boundary requirement is carried by the write path's per-page
 * source_session vs the reader's fresh conversation).
 *
 * A decision probe succeeds when the reader's replay either injected one of
 * the expected slugs, or the decision fact persisted by the writer is
 * recallable by keyword probe within the active source. Headline
 * continuity_rate per harness = mean over pairs where that harness READ.
 */

import type { PGLiteEngine } from '../../../core/pglite-engine.ts';
import type { ContinuityDecisionGold, TurnRow } from '../types.ts';

export interface ContinuityPairScore {
  gold_total: number;
  gold_failed: number;
  /** decision_id → hit. */
  hits: Record<string, boolean>;
  failed_items: string[];
}

export async function scoreContinuityPair(
  engine: PGLiteEngine,
  activeSource: string,
  pairId: string,
  readerRows: TurnRow[],
  decisions: ContinuityDecisionGold[],
): Promise<ContinuityPairScore> {
  const injected = new Set<string>();
  for (const row of readerRows) for (const s of row.injected_slugs) injected.add(s);

  const hits: Record<string, boolean> = {};
  const failed: string[] = [];
  let failedCount = 0;

  for (const d of decisions) {
    let hit = d.expected_slugs.some((slug) => injected.has(slug));
    if (!hit && d.match_keywords.length > 0) {
      hit = await factKeywordProbe(engine, activeSource, d.match_keywords);
    }
    hits[d.decision_id] = hit;
    if (!hit) {
      failedCount++;
      failed.push(`${pairId}/${d.decision_id} (decision not recalled)`);
    }
  }

  return { gold_total: decisions.length, gold_failed: failedCount, hits, failed_items: failed };
}

/** True when an active (non-expired) fact in the source contains every keyword. */
export async function factKeywordProbe(
  engine: PGLiteEngine,
  sourceId: string,
  keywords: string[],
): Promise<boolean> {
  // Escape ILIKE metacharacters so a gold keyword containing % or _ can't
  // silently broaden the match into a false pass (review finding — scoring
  // integrity, not injection: everything is parameterized).
  const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);
  const conds = keywords.map((_, i) => `fact ILIKE $${i + 2} ESCAPE '\\'`).join(' AND ');
  const params = [sourceId, ...keywords.map((kw) => `%${escapeLike(kw)}%`)];
  const rows = await engine.executeRaw<{ one: number }>(
    `SELECT 1 AS one FROM facts
      WHERE source_id = $1 AND expired_at IS NULL AND ${conds}
      LIMIT 1`,
    params,
  );
  return rows.length > 0;
}
