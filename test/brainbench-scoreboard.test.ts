/**
 * BrainBench scoreboard + gate governance (decisions 4, 8, 10).
 * Canonical baseline determinism, count-aware gating, corpus-bless modes,
 * justification flow, allow-regression recording, isolation gates-at-zero.
 */
import { describe, expect, test } from 'bun:test';
import {
  compareBaselines,
  parseBaseline,
  renderScoreboardMarkdown,
  serializeBaseline,
  toCanonicalBaseline,
} from '../src/eval/brainbench/scoreboard.ts';
import type { BrainBenchBaseline, BrainBenchResult, SuiteMetrics } from '../src/eval/brainbench/types.ts';

function cell(partial: Partial<SuiteMetrics>): SuiteMetrics {
  return {
    suite: 'know-to-ask',
    harness: 'openclaw',
    seam: 'production',
    gold_total: 10,
    gold_failed: 1,
    metrics: { know_to_ask_failure_rate: 0.1, source_isolation_violations: 0 },
    fixtures: ['fx-1'],
    ...partial,
  };
}

const TEST_CONFIG = { harnesses: ['openclaw'], suites: ['know-to-ask'] };

function mkBaseline(cells: SuiteMetrics[], hash = 'hash-a', justification?: string): BrainBenchBaseline {
  return toCanonicalBaseline(
    { cells, receipt: { fixtures_hash: hash, include_holdout: false, llm: false } },
    justification,
    TEST_CONFIG,
  );
}

describe('canonical baseline (decision 10)', () => {
  test('deterministic bytes: same input → identical serialization; keys sorted; 4-decimal rounding', () => {
    const a = mkBaseline([
      cell({ metrics: { know_to_ask_failure_rate: 0.123456789, source_isolation_violations: 0 } }),
      cell({ harness: 'codex', seam: 'contract' }),
    ]);
    const b = mkBaseline([
      cell({ harness: 'codex', seam: 'contract' }),
      cell({ metrics: { know_to_ask_failure_rate: 0.123456789, source_isolation_violations: 0 } }),
    ]);
    expect(serializeBaseline(a)).toBe(serializeBaseline(b)); // cell order irrelevant
    expect(a.cells['openclaw/know-to-ask'].know_to_ask_failure_rate).toBe(0.1235);
    expect(Object.keys(a.cells)).toEqual([...Object.keys(a.cells)].sort());
  });

  test('receipts (sha/ts/cmd_args) never enter the committed baseline', () => {
    const b = mkBaseline([cell({})]);
    const ser = serializeBaseline(b);
    expect(ser).not.toContain('harness_sha');
    expect(ser).not.toContain('cmd_args');
    expect(parseBaseline(ser, 'x.json').fixtures_hash).toBe('hash-a');
  });
});

describe('same-hash gate (count-aware, decision 8)', () => {
  test('one newly-failed gold item = regression, named in the breach', () => {
    const main = mkBaseline([cell({ gold_failed: 1 })]);
    const current = mkBaseline([cell({ gold_failed: 2 })]);
    const out = compareBaselines(current, main);
    expect(out.verdict).toBe('regression');
    expect(out.mode).toBe('same-hash');
    expect(out.breaches.some((b) => b.metric === 'gold_failed' && b.detail.includes('1 newly-failed'))).toBe(true);
  });

  test('adverse gated-metric move without a count change is still a breach (precision class)', () => {
    const main = mkBaseline([cell({ suite: 'push', metrics: { push_precision: 0.9, source_isolation_violations: 0 } })]);
    const current = mkBaseline([cell({ suite: 'push', metrics: { push_precision: 0.85, source_isolation_violations: 0 } })]);
    expect(compareBaselines(current, main).verdict).toBe('regression');
  });

  test('improvement passes; diagnostic-only metrics (avg_injected_tokens) never gate', () => {
    const main = mkBaseline([cell({ gold_failed: 2, metrics: { know_to_ask_failure_rate: 0.2, avg_injected_tokens: 10, source_isolation_violations: 0 } })]);
    const current = mkBaseline([cell({ gold_failed: 1, metrics: { know_to_ask_failure_rate: 0.1, avg_injected_tokens: 99, source_isolation_violations: 0 } })]);
    expect(compareBaselines(current, main).verdict).toBe('pass');
  });

  test('disappeared cell (coverage loss) is a breach', () => {
    const main = mkBaseline([cell({}), cell({ harness: 'codex', seam: 'contract' })]);
    const current = mkBaseline([cell({})]);
    const out = compareBaselines(current, main);
    expect(out.verdict).toBe('regression');
    expect(out.breaches.some((b) => b.detail.includes('coverage disappeared'))).toBe(true);
  });

  test('--allow-regression downgrades to pass and RECORDS the reason', () => {
    const main = mkBaseline([cell({ gold_failed: 0 })]);
    const current = mkBaseline([cell({ gold_failed: 1 })]);
    const out = compareBaselines(current, main, { allowRegression: 'intentional trade, see PR' });
    expect(out.verdict).toBe('pass');
    expect(out.notes.join(' ')).toContain('intentional trade, see PR');
    expect(out.breaches.length).toBeGreaterThan(0); // still visible
  });

  test('source_isolation_violations > 0 gates at zero EVEN IF the baseline had it', () => {
    const main = mkBaseline([cell({ metrics: { know_to_ask_failure_rate: 0.1, source_isolation_violations: 1 } })]);
    const current = mkBaseline([cell({ metrics: { know_to_ask_failure_rate: 0.1, source_isolation_violations: 1 } })]);
    const out = compareBaselines(current, main);
    expect(out.verdict).toBe('regression');
    expect(out.breaches[0].detail).toContain('data-leak invariant');
  });
});

describe('corpus-bless mode (decision 4 — a PR cannot self-approve)', () => {
  const main = mkBaseline([cell({ gold_failed: 1 })], 'hash-main');

  test('hash mismatch + no committed baseline → inconclusive with the fix command', () => {
    const current = mkBaseline([cell({ gold_failed: 1 })], 'hash-new');
    const out = compareBaselines(current, main, { committedBaseline: null });
    expect(out.verdict).toBe('inconclusive');
    expect(out.mode).toBe('corpus-bless');
    expect(out.notes.join(' ')).toContain('--update-baseline');
  });

  test('committed baseline that does not match the run → inconclusive (the file cannot lie)', () => {
    const current = mkBaseline([cell({ gold_failed: 1 })], 'hash-new');
    const stale = mkBaseline([cell({ gold_failed: 0 })], 'hash-new'); // lies about failures
    const out = compareBaselines(current, main, { committedBaseline: stale });
    expect(out.verdict).toBe('inconclusive');
    expect(out.notes.join(' ')).toContain('does not match this run');
  });

  // In bless mode, raw counts are incomparable across different gold (the
  // denominator changed) — the justification trigger is adverse METRIC moves,
  // which are dimensionless and stay comparable.
  const regressedCell = cell({
    gold_failed: 5,
    metrics: { know_to_ask_failure_rate: 0.3, source_isolation_violations: 0 },
  });

  test('matching committed baseline + metric regression vs main + NO justification → regression', () => {
    const current = mkBaseline([regressedCell], 'hash-new');
    const committed = mkBaseline([regressedCell], 'hash-new');
    const out = compareBaselines(current, main, { committedBaseline: committed });
    expect(out.verdict).toBe('regression');
    expect(out.notes.join(' ')).toContain('justification');
  });

  test('matching committed baseline + justification → pass with the reason recorded', () => {
    const current = mkBaseline([regressedCell], 'hash-new');
    const committed = mkBaseline([regressedCell], 'hash-new', 'corpus rewrite: stricter gold');
    const out = compareBaselines(current, main, { committedBaseline: committed });
    expect(out.verdict).toBe('pass');
    expect(out.notes.join(' ')).toContain('corpus rewrite: stricter gold');
  });

  test('count comparisons are NOT applied cross-hash (different gold ⇒ counts incomparable)', () => {
    // current has more failures but also a different corpus; only metric-level
    // adverse moves + the committed-baseline verification apply.
    const current = mkBaseline([cell({ gold_failed: 3, metrics: { know_to_ask_failure_rate: 0.1, source_isolation_violations: 0 } })], 'hash-new');
    const committed = mkBaseline([cell({ gold_failed: 3, metrics: { know_to_ask_failure_rate: 0.1, source_isolation_violations: 0 } })], 'hash-new');
    const out = compareBaselines(current, main, { committedBaseline: committed });
    expect(out.verdict).toBe('pass');
  });
});

describe('parseBaseline error paths (each names the offending file)', () => {
  test('invalid JSON', () => {
    expect(() => parseBaseline('{ nope', 'bad.json')).toThrow(/bad\.json: invalid JSON/);
  });
  test('wrong schema_version', () => {
    expect(() => parseBaseline(JSON.stringify({ schema_version: 99 }), 'v99.json')).toThrow(
      /v99\.json: schema_version must be 1/,
    );
  });
  test('missing config/cells/counts', () => {
    expect(() =>
      parseBaseline(JSON.stringify({ schema_version: 1, fixtures_hash: 'x' }), 'partial.json'),
    ).toThrow(/partial\.json: missing fixtures_hash\/config\/cells\/counts/);
  });
});

describe('red-team hardening (gate gaming vectors)', () => {
  test('run-config mismatch (holdout/llm/harness set) → inconclusive, never a quiet pass', () => {
    const main = mkBaseline([cell({})]);
    const current = toCanonicalBaseline(
      { cells: [cell({})], receipt: { fixtures_hash: 'hash-a', include_holdout: true, llm: false } },
      undefined,
      TEST_CONFIG,
    );
    const out = compareBaselines(current, main);
    expect(out.verdict).toBe('inconclusive');
    expect(out.notes.join(' ')).toContain('run config mismatch');
  });

  test('corpus hollowing: bless-mode gold_total shrink requires justification', () => {
    const main = mkBaseline([cell({ gold_total: 20, gold_failed: 5 })], 'hash-main');
    // PR deletes the failing fixtures: fewer gold, better rate, no metric breach.
    const shrunk = cell({ gold_total: 10, gold_failed: 0, metrics: { know_to_ask_failure_rate: 0, source_isolation_violations: 0 } });
    const current = mkBaseline([shrunk], 'hash-new');
    const committed = mkBaseline([shrunk], 'hash-new'); // matches the run, no justification
    const out = compareBaselines(current, main, { committedBaseline: committed });
    expect(out.verdict).toBe('regression');
    expect(out.breaches.some((b) => b.metric === 'gold_total' && b.detail.includes('hollowing'))).toBe(true);
    // With a justification it passes — reviewable in the diff.
    const blessed = mkBaseline([shrunk], 'hash-new', 'retired flaky fixtures, see PR');
    expect(compareBaselines(current, main, { committedBaseline: blessed }).verdict).toBe('pass');
  });

  test('two-PR poisoning: same-hash committed-baseline edit that matches NO run → inconclusive', () => {
    const main = mkBaseline([cell({ gold_failed: 1 })]);
    const current = mkBaseline([cell({ gold_failed: 1 })]); // run == main, nothing changed
    const doctored = mkBaseline([cell({ gold_failed: 5 })]); // committed file pretends worse counts
    const out = compareBaselines(current, main, { committedBaseline: doctored });
    expect(out.verdict).toBe('inconclusive');
    expect(out.notes.join(' ')).toContain('receipts-backed');
  });

  test('same-hash receipts-backed improvement (committed == run) passes with the delta noted', () => {
    const main = mkBaseline([cell({ gold_failed: 2, metrics: { know_to_ask_failure_rate: 0.2, source_isolation_violations: 0 } })]);
    const improved = cell({ gold_failed: 1, metrics: { know_to_ask_failure_rate: 0.1, source_isolation_violations: 0 } });
    const current = mkBaseline([improved]);
    const committed = mkBaseline([improved]);
    const out = compareBaselines(current, main, { committedBaseline: committed });
    expect(out.verdict).toBe('pass');
    expect(out.notes.join(' ')).toContain('visible delta');
  });

  test('same-hash receipts-backed REGRESSION still needs a justification to pass', () => {
    const main = mkBaseline([cell({ gold_failed: 1 })]);
    const regressed = cell({ gold_failed: 3 });
    const current = mkBaseline([regressed]);
    const unjustified = mkBaseline([regressed]);
    expect(compareBaselines(current, main, { committedBaseline: unjustified }).verdict).toBe('regression');
    const justified = mkBaseline([regressed], 'hash-a', 'intentional trade, see PR');
    const out = compareBaselines(current, main, { committedBaseline: justified });
    expect(out.verdict).toBe('pass');
    expect(out.notes.join(' ')).toContain('intentional trade');
  });

  test('poisoning v2: a FOREIGN-hash doctored committed baseline is still inconclusive (no hash carve-out)', () => {
    const main = mkBaseline([cell({ gold_failed: 1 })]);
    const current = mkBaseline([cell({ gold_failed: 1 })]);
    const foreign = mkBaseline([cell({ gold_failed: 99 })], 'some-other-corpus');
    const out = compareBaselines(current, main, { committedBaseline: foreign });
    expect(out.verdict).toBe('inconclusive');
    expect(out.notes.join(' ')).toContain('receipts-backed');
  });

  test('same-hash gold_total drift (scorer/loader shift under unchanged corpus) is a breach', () => {
    const main = mkBaseline([cell({ gold_total: 10, gold_failed: 0 })]);
    const current = mkBaseline([cell({ gold_total: 4, gold_failed: 0 })]);
    const out = compareBaselines(current, main);
    expect(out.verdict).toBe('regression');
    expect(out.breaches.some((b) => b.metric === 'gold_total' && b.detail.includes('WITHOUT a fixture change'))).toBe(true);
  });
});

describe('renderScoreboardMarkdown', () => {
  test('deterministic output; seam column present; gate + breaches rendered', () => {
    const result: BrainBenchResult = {
      receipt: {
        result_schema_version: 1,
        fixtures_hash: 'abcdef1234567890',
        harness_sha: 'sha',
        ts: '2026-06-12T00:00:00Z',
        cmd_args: [],
        seed: 42,
        include_holdout: false,
        llm: false,
      },
      cells: [cell({})],
      turn_rows: [],
      seed_failures: [],
    };
    const main = mkBaseline([cell({ gold_failed: 0 })]);
    const current = toCanonicalBaseline(
      { cells: result.cells, receipt: { fixtures_hash: 'hash-a', include_holdout: false, llm: false } },
      undefined,
      TEST_CONFIG,
    );
    const outcome = compareBaselines(current, main);
    const md1 = renderScoreboardMarkdown(result, outcome);
    const md2 = renderScoreboardMarkdown(result, outcome);
    expect(md1).toBe(md2);
    expect(md1).toContain('| openclaw | production | know-to-ask |');
    expect(md1).toContain('## Gate: REGRESSION');
    expect(md1).toContain('newly-failed');
  });
});
