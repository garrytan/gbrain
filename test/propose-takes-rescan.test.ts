/**
 * propose_takes rescan-loop + dropped-claims regression tests (migrations v125 + v126).
 *
 * Two live-observed defects, both fixed by the v125 (upstream, per-claim index) + v126 (sentinels) schema + phase changes:
 *
 *   1. RESCAN LOOP — a page whose extraction yielded zero claims never
 *      entered the idempotency cache (only proposal rows were written), so
 *      every cycle re-spent the extractor call on the same unchanged page.
 *      Live impact: ~60 such pages × every cycle ≈ 1,400 wasted LLM calls
 *      (~$15) per day — ~90% of total autopilot spend. Fix: status='empty'
 *      sentinel row per zero-claim scan.
 *
 *   2. DROPPED CLAIMS — the 4-column unique index collapsed a same-page
 *      multi-claim run to its first claim (rows 2..N conflicted, ON CONFLICT
 *      DO NOTHING dropped them silently; verified live: exactly 1 row per
 *      (page, hash) over 3 days). Fix: idempotency index gains
 *      md5(claim_text).
 *
 * Hermetic: PGLite engine + injected extractor; no gateway, no LLM.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseProposeTakes, type ProposeTakesExtractor, type ProposedTake } from '../src/core/cycle/propose-takes.ts';
import type { OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;

function ctx(): OperationContext {
  return {
    engine,
    remote: false,
    config: {} as OperationContext['config'],
    logger: { info() {}, warn() {}, error() {}, debug() {} } as unknown as OperationContext['logger'],
  } as unknown as OperationContext;
}

/** Extractor stub that counts invocations per page slug. */
function countingExtractor(
  claimsBySlug: Record<string, ProposedTake[]>,
): { extractor: ProposeTakesExtractor; calls: string[] } {
  const calls: string[] = [];
  const extractor: ProposeTakesExtractor = async ({ pagePath }) => {
    calls.push(pagePath);
    return claimsBySlug[pagePath] ?? [];
  };
  return { extractor, calls };
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage('notes/zero-claims', {
    type: 'note',
    title: 'pure narrative',
    compiled_truth: 'A quiet walk in the park. Nothing opinionated happened at all today.',
  });
  await engine.putPage('notes/three-claims', {
    type: 'note',
    title: 'opinionated',
    compiled_truth: 'I bet acme-example wins the market. widget-co will struggle. fund-a is overexposed.',
  });
});

afterAll(async () => {
  await engine.disconnect();
});

describe('rescan loop — zero-claim scans enter the cache', () => {
  test('second run cache-hits: extractor is NOT called again on unchanged pages', async () => {
    const claims = {
      'notes/three-claims': [
        { claim_text: 'acme-example wins the market', kind: 'bet' as const, holder: 'brain', weight: 0.7 },
        { claim_text: 'widget-co will struggle', kind: 'take' as const, holder: 'brain', weight: 0.6 },
        { claim_text: 'fund-a is overexposed', kind: 'take' as const, holder: 'brain', weight: 0.55 },
      ],
    };

    const first = countingExtractor(claims);
    const r1 = await runPhaseProposeTakes(ctx(), { extractor: first.extractor });
    expect(r1.status).toBe('ok');
    // Both pages extracted on the first pass.
    expect(first.calls).toContain('notes/zero-claims');
    expect(first.calls).toContain('notes/three-claims');

    const second = countingExtractor(claims);
    const r2 = await runPhaseProposeTakes(ctx(), { extractor: second.extractor });
    expect(r2.status).toBe('ok');
    // THE regression: pre-fix the zero-claim page missed the cache every
    // run and was re-extracted here. (Run 1's receipt page legitimately
    // appears once — it's a new page — and its zero-claim scan now caches
    // too; pre-fix, receipts re-scanned forever as well.)
    expect(second.calls).not.toContain('notes/zero-claims');
    expect(second.calls).not.toContain('notes/three-claims');

    // Run 2 inserted nothing, so no new receipt page exists: run 3 must be
    // fully quiescent — zero extractor calls, zero cache misses.
    const third = countingExtractor(claims);
    const r3 = await runPhaseProposeTakes(ctx(), { extractor: third.extractor });
    expect(r3.status).toBe('ok');
    expect(third.calls).toEqual([]);
    expect((r3.details as Record<string, unknown>).cache_misses).toBe(0);
  });

  test('zero-claim scan wrote an "empty" sentinel invisible to the pending queue', async () => {
    const sentinel = await engine.executeRaw<{ status: string; claim_text: string }>(
      `SELECT status, claim_text FROM take_proposals WHERE page_slug = 'notes/zero-claims'`,
      [],
    );
    expect(sentinel.length).toBe(1);
    expect(sentinel[0].status).toBe('empty');
    expect(sentinel[0].claim_text).toBe('');
    const pending = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM take_proposals WHERE page_slug = 'notes/zero-claims' AND status = 'pending'`,
      [],
    );
    expect(Number(pending[0].n)).toBe(0);
  });
});

describe('dropped claims — per-claim rows survive the idempotency index', () => {
  test('a 3-claim page stores 3 rows and reports an honest inserted count', async () => {
    const rows = await engine.executeRaw<{ claim_text: string }>(
      `SELECT claim_text FROM take_proposals WHERE page_slug = 'notes/three-claims' AND status = 'pending' ORDER BY id`,
      [],
    );
    // Pre-fix the 4-column unique index kept only the FIRST claim.
    expect(rows.length).toBe(3);
    expect(rows.map(r => r.claim_text)).toEqual([
      'acme-example wins the market',
      'widget-co will struggle',
      'fund-a is overexposed',
    ]);
  });

  test('content change re-extracts and stores the new version separately', async () => {
    await engine.putPage('notes/zero-claims', {
      type: 'note',
      title: 'pure narrative',
      compiled_truth: 'Updated: I now believe acme-example is undervalued and will re-rate within a year.',
    });
    const claims = {
      'notes/zero-claims': [
        { claim_text: 'acme-example is undervalued', kind: 'take' as const, holder: 'brain', weight: 0.6 },
      ],
    };
    const run = countingExtractor(claims);
    const r = await runPhaseProposeTakes(ctx(), { extractor: run.extractor });
    expect(r.status).toBe('ok');
    // Changed page re-extracts; the unchanged 3-claim page stays cached.
    expect(run.calls).toEqual(['notes/zero-claims']);
    expect((r.details as Record<string, unknown>).proposals_inserted).toBe(1);
    const all = await engine.executeRaw<{ status: string }>(
      `SELECT status FROM take_proposals WHERE page_slug = 'notes/zero-claims' ORDER BY id`,
      [],
    );
    // Old hash's sentinel + new hash's pending claim coexist.
    expect(all.map(r2 => r2.status).sort()).toEqual(['empty', 'pending']);
  });
});
