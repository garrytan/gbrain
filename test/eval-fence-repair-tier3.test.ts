/**
 * Keyless check of the Tier 3 fence-repair eval instrument (#6188 T4,
 * evals/fence-repair-tier3/).
 *
 * Protects: the committed fixtures (round 1) and the held-out set (round 2)
 * match their generator; round 1 keeps at least 60 repairable fences across
 * every Tier 3 residual class plus both kinds of adversarial fence, and the
 * held-out set at least 40 with ambiguous and split-claim adversarials; every
 * label holds under the production gates (the $0 oracle: each repairable
 * ground truth passes every gate and comes out byte-identical, each
 * gate-limited one is rejected, each ambiguous and split-claim probe is
 * accepted, each unrecoverable probe is rejected, the free tiers decide the
 * fixtures the oracle lists as theirs, and a HOLD answer is held as
 * `llm_declined`); and the scorer's match rule, its Tier 3 and whole-path
 * rates and the decision boundary. Fails when: a fixture is hand-edited
 * without regenerating, a Tier 1 or gate change moves a fixture off its listed
 * path or makes a ground truth unreachable, or the scorer stops counting a
 * moved cell as a mismatch. It guards the instrument, not the score: the live
 * run (harness.ts --model ...) spends tokens and is never part of CI.
 * Why new: the eval is new with T4.
 * Seams: the gateway's chat transport stub (oracle.ts), which production never sets.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { fixturesJsonl, type Fixture } from '../evals/fence-repair-tier3/generate-fixtures.ts';
import { HELDOUT_CASES } from '../evals/fence-repair-tier3/heldout-cases.ts';
import { oracleAnswers, runOracle } from '../evals/fence-repair-tier3/oracle.ts';
import { compareRepair, meetsRule, summarize, wilson, type ResultRow } from '../evals/fence-repair-tier3/score.ts';

const dir = join(import.meta.dir, '..', 'evals/fence-repair-tier3');
const text = readFileSync(join(dir, 'fixtures.jsonl'), 'utf8');
const fixtures: Fixture[] = text.trim().split('\n').map(line => JSON.parse(line));
const heldoutText = readFileSync(join(dir, 'heldout.jsonl'), 'utf8');
const heldout: Fixture[] = heldoutText.trim().split('\n').map(line => JSON.parse(line));

afterAll(() => resetGateway());

describe('fixtures', () => {
  test('match the generator (regenerate with bun evals/fence-repair-tier3/generate-fixtures.ts)', () => {
    expect(text).toBe(fixturesJsonl());
  });

  test('at least 60 repairable fences over every class, both adversarial kinds, unique ids', () => {
    expect(new Set(fixtures.map(f => f.id)).size).toBe(fixtures.length);
    const repairable = fixtures.filter(f => f.set === 'repairable');
    expect(repairable.length).toBeGreaterThanOrEqual(60);
    for (const cls of ['short_row_trailing', 'short_row_gap', 'no_header', 'row_before_header', 'extra_cells', 'header_unmapped', 'mixed']) {
      expect(repairable.filter(f => f.cls === cls).length).toBeGreaterThanOrEqual(5);
    }
    for (const kind of ['facts', 'takes']) expect(repairable.filter(f => f.kind === kind).length).toBeGreaterThanOrEqual(15);
    expect(fixtures.filter(f => f.adversarial === 'ambiguous').length).toBeGreaterThanOrEqual(5);
    expect(fixtures.filter(f => f.adversarial === 'unrecoverable').length).toBeGreaterThanOrEqual(3);
    for (const f of fixtures) expect(f.expected === null).toBe(f.set === 'adversarial');
  });

  test('the held-out set matches its generator: at least 40 fences, the same classes, ambiguous and split-claim adversarials, no id shared with round 1', () => {
    expect(heldoutText).toBe(fixturesJsonl(HELDOUT_CASES));
    expect(heldout.length).toBeGreaterThanOrEqual(40);
    const repairable = heldout.filter(f => f.set === 'repairable');
    expect(repairable.length).toBeGreaterThanOrEqual(40);
    for (const cls of ['short_row_trailing', 'short_row_gap', 'no_header', 'row_before_header', 'extra_cells', 'header_unmapped', 'mixed']) {
      expect(repairable.filter(f => f.cls === cls).length).toBeGreaterThanOrEqual(3);
    }
    expect(heldout.filter(f => f.adversarial === 'ambiguous').length).toBeGreaterThanOrEqual(5);
    expect(heldout.filter(f => f.adversarial === 'split_claim').length).toBeGreaterThanOrEqual(3);
    const roundOne = new Set(fixtures.map(f => f.id));
    expect(heldout.filter(f => roundOne.has(f.id))).toEqual([]);
    for (const f of heldout) expect(f.expected === null).toBe(f.set === 'adversarial');
  });
});

describe('oracle', () => {
  test('every round 1 label holds under the production gates', async () => {
    expect((await runOracle(fixtures, oracleAnswers)).violations).toEqual([]);
  }, 60_000);

  test('every held-out label holds under the production gates', async () => {
    expect((await runOracle(heldout, oracleAnswers)).violations).toEqual([]);
  }, 60_000);
});

describe('scorer', () => {
  const fx = fixtures.find(f => f.id === 'f-sg-01')!;
  const want = fx.expected!;
  test('cell spacing does not matter; a moved or changed cell does', () => {
    const spaced = { ...want, compiled_truth: want.compiled_truth.replace('| 2026-04-01 |  | intro call |  |', '|2026-04-01||intro call||') };
    expect(compareRepair(spaced, want)).toEqual({ cells: true, exact: false });
    const moved = { ...want, compiled_truth: want.compiled_truth.replace('| 2026-04-01 |  | intro call |  |', '| 2026-04-01 | intro call |  |  |') };
    expect(compareRepair(moved, want).cells).toBe(false);
    const changed = { ...want, compiled_truth: want.compiled_truth.replace('intro call', 'intro-call') };
    expect(compareRepair(changed, want).cells).toBe(false);
    const prose = { ...want, compiled_truth: want.compiled_truth.replace('Working notes', 'Working note') };
    expect(compareRepair(prose, want).cells).toBe(false);
  });

  test('rates, the decision boundary and the interval', () => {
    const row = (id: string, set: ResultRow['set'], outcome: ResultRow['outcome'], match: boolean | null): ResultRow => ({ model: 'm', run: 1, id, set, adversarial: set === 'adversarial' ? 'ambiguous' : null,
      cls: 'short_row_trailing', kind: 'facts', tags: [], tier1: 'llm', requests: 1, outcome, reason: outcome === 'held' ? 'cell_changed' : null, gate: outcome === 'held' ? 'f' : null,
      match_cells: match, match_exact: match, calls: [{ latency_ms: 1000, input_tokens: 500, output_tokens: 100, estimate_usd: 0.02, usd: 0.01, stop: 'end_turn', text: '' }],
      spent_usd: 0.01, usd_unregistered: 0.01, latency_ms: 1000, attempts: 1 });
    const rows = [...Array.from({ length: 8 }, (_, i) => row(`r${i}`, 'repairable', 'repaired', true)), row('r8', 'repairable', 'repaired', false), row('r9', 'repairable', 'held', null), row('a0', 'adversarial', 'held', null)];
    rows[10] = { ...rows[10]!, reason: 'llm_declined', gate: null };
    const [s] = summarize(rows);
    expect(s!.repairable).toMatchObject({ n: 10, repaired: 9, gate_pass: 0.9, false_accepts: 1, false_accept: 0.1 });
    expect(s!.adversarial).toMatchObject({ n: 1, held: 1, held_how: { declined: 1 } });
    expect(s!.cost.usd_per_repair).toBeCloseTo(0.1 / 9, 10);
    const freeTier = { ...rows[0]!, id: 't1', tier1: 'proposal', tier: 'deterministic', calls: [], spent_usd: 0 };
    const [w] = summarize([...rows, freeTier]);
    expect(w!.repairable).toMatchObject({ n: 10, repaired: 9 });
    expect(w!.whole_path).toMatchObject({ n: 11, repaired: 10, false_accepts: 1 });
    expect(w!.end_to_end.by_tier).toMatchObject({ deterministic: { runs: 1, repaired: 1, wrong_writes: 0 }, llm: { runs: 10, repaired: 9, wrong_writes: 1 } });
    expect(meetsRule(s!)).toBe(false);
    expect(meetsRule({ ...s!, repairable: { ...s!.repairable, gate_pass: 0.8, false_accept: 0.01 } })).toBe(true);
    expect(meetsRule({ ...s!, repairable: { ...s!.repairable, gate_pass: 0.79, false_accept: 0 } })).toBe(false);
    const [lo, hi] = wilson(0, 198)!;
    expect(lo).toBe(0);
    expect(hi).toBeCloseTo(0.019, 3);
  });
});
