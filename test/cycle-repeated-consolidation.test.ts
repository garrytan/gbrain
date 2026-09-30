/**
 * Repeated-consolidation regression pin (gbrain 10x plan, amendment 7).
 *
 * Three real dream cycles on a fixed brain with a scripted model that
 * invents quotes, swaps speakers, invents numbers and states one speaker's
 * proposal as another speaker's decision (#5425), including edits into
 * existing pages. See test/helpers/repeated-consolidation.ts for the design
 * and scripts/repeated-consolidation-experiment.ts for the printable run.
 *
 * The fixture was written alongside the checker, so this is a regression pin
 * for the mechanical grounding gate, not an estimate of a real model's
 * hallucination rate. Unquoted inventions (no quote, no number) are not
 * mechanically checkable; their count is pinned so a change in either
 * direction is noticed.
 */
import { describe, test, expect } from 'bun:test';
import { runRepeatedConsolidation } from './helpers/repeated-consolidation.ts';

describe('repeated consolidation: three dream cycles with invented claims', () => {
  test('no checkable invented claim becomes active memory; every source-supported claim survives', async () => {
    const m = await runRepeatedConsolidation();
    for (const c of m.per_cycle) expect(c.statuses).toEqual({ synthesize: 'ok', extract: 'ok', extract_facts: 'ok' });

    expect(m.claims_by_kind).toEqual({ valid: 14, fabricated_quote: 6, speaker_swap: 3, invented_number: 6, misattributed_decision: 1, unquoted_invention: 2 });
    expect(m.invented_active_by_kind).toEqual({ fabricated_quote: 0, speaker_swap: 0, invented_number: 0, misattributed_decision: 0, unquoted_invention: 2 });
    expect(m.invented_active_ids.sort()).toEqual(['c1-unq', 'c3-unq']);
    expect(m.wrong_attribution_active).toBe(0);

    expect(m.valid_lost_ids).toEqual([]);
    expect(m.source_supported_retention).toBe(1);
    expect(m.human_line_intact).toBe(true);
  }, 120_000);
});
