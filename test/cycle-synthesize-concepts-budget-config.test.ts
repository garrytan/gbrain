// synthesize_concepts reads `cycle.synthesize_concepts.budget_usd`.
//
// The sibling phase `extract_atoms` has read `cycle.extract_atoms.budget_usd`
// since it shipped; this one hardcoded `const budgetCap = DEFAULT_BUDGET_USD`,
// so the only way past $1.50 was editing the source. The cap does not stop the
// phase — it silently swaps the Sonnet narrative for a deterministic stub and
// stamps `budget_fallback` — so an operator with more budget than the default
// got a quietly degraded corpus and no error to notice.
//
// These tests drive the REAL phase through its `_chat` / `_atoms` seams under
// `dryRun`, so no page is written and no provider is called. Every assertion is
// on the phase's own returned counts, not on a re-implementation of the rule.
import { test, expect } from 'bun:test';
import { runPhaseSynthesizeConcepts } from '../src/core/cycle/synthesize-concepts.ts';

/** Three T1 groups (>= 10 atoms each), so every one is LLM-eligible. */
function atoms(groups = 3, per = 10) {
  const out: Array<{ slug: string; concept_refs: string[]; body: string; title: string }> = [];
  for (let g = 0; g < groups; g++) {
    for (let i = 0; i < per; i++) {
      out.push({
        slug: `atoms/2026-09-05/g${g}-a${i}`,
        concept_refs: [`concept-${g}`],
        title: `atom ${g}.${i}`,
        body: `body of atom ${g}.${i}`,
      });
    }
  }
  return out;
}

/**
 * Each answer costs $0.90 at Sonnet fallback pricing (300k input * $3/M).
 *
 * The cap is checked BEFORE each call, so the call that CROSSES it still runs:
 * group 1 ($0.90) and group 2 ($1.80) are answered, and only group 3 sees
 * estimatedSpendUsd >= 1.50 and stubs. That off-by-one is the real behaviour,
 * not a rounding detail — asserting llm=1 here would have been asserting a
 * rule that does not exist.
 */
const chat = (async () => ({
  model: 'test:unpriced-model',       // canonical miss -> FALLBACK_PRICING
  text: 'a synthesized narrative.',
  usage: { input_tokens: 300_000, output_tokens: 0 },
})) as never;

function engineWith(configured: string | null) {
  return {
    getConfig: async (k: string) =>
      k === 'cycle.synthesize_concepts.budget_usd' ? configured : null,
  } as never;
}

async function modes(configured: string | null) {
  const r = await runPhaseSynthesizeConcepts(engineWith(configured), {
    dryRun: true,
    _atoms: atoms(),
    _chat: chat,
  } as never);
  const d = (r as { details?: Record<string, unknown> }).details ?? {};
  return (d.synthesis_mode_counts ?? d) as Record<string, number>;
}

test('the default cap still degrades past $1.50 — the behaviour being made configurable', async () => {
  const m = await modes(null);
  expect(m.llm).toBe(2);
  expect(m.budget_fallback).toBe(1);
});

test('a configured budget is honoured: every eligible group gets a real narrative', async () => {
  const m = await modes('20');
  expect(m.llm).toBe(3);
  expect(m.budget_fallback).toBe(0);
});

test('a non-numeric budget leaves the default in place rather than disabling the cap', async () => {
  const m = await modes('not-a-number');
  expect(m.llm).toBe(2);
  expect(m.budget_fallback).toBe(1);
});

test('a zero or negative budget is refused, not applied — it would disable every LLM call', async () => {
  for (const bad of ['0', '-5']) {
    const m = await modes(bad);
    expect(m.llm).toBe(2);
    expect(m.budget_fallback).toBe(1);
  }
});

test('a getConfig that throws does not stop the phase', async () => {
  // getConfig also backs resolveModel (model-config.ts). Throwing for every key
  // would test model resolution, not this read — so throw for OURS only.
  const engine = {
    getConfig: async (k: string) => {
      if (k === 'cycle.synthesize_concepts.budget_usd') throw new Error('config plane down');
      return null;
    },
  } as never;
  const r = await runPhaseSynthesizeConcepts(engine, {
    dryRun: true, _atoms: atoms(), _chat: chat,
  } as never);
  expect((r as { status: string }).status).not.toBe('error');
});
