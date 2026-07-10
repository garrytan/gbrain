/**
 * BrainBench scoreboard: markdown render, canonical committed baseline, and
 * the compare gate with main-baseline governance (decisions 4, 8, 10).
 *
 * Gate semantics (deterministic corpus ⇒ any flip is a real behavior change):
 *   same fixtures_hash  → count-aware gate: any cell whose gold_failed rose,
 *                         any adverse gated-metric move, or ANY
 *                         source_isolation_violations > 0 is a breach.
 *   different hash      → corpus-bless mode: the committed baseline in the
 *                         working tree must EXACTLY match the current run
 *                         (the file can't lie); adverse moves vs main's
 *                         baseline additionally require a `justification`
 *                         string in the committed baseline.
 *   --allow-regression  → local/one-off escape hatch; reason recorded in the
 *                         outcome notes (and the run output).
 *
 * The committed baseline is diff-stable by construction: metrics rounded to 4
 * decimals, keys sorted, receipts excluded (decision 10).
 */

import {
  round4,
  type BrainBenchBaseline,
  type BrainBenchResult,
  type CompareOutcome,
  type SuiteMetrics,
} from './types.ts';

/** Gated metrics + their good direction. Anything absent is diagnostic-only. */
export const GATED_METRICS: Readonly<Record<string, 'lower' | 'higher'>> = {
  know_to_ask_failure_rate: 'lower',
  false_fire_rate: 'lower',
  source_isolation_violations: 'lower',
  push_precision: 'higher',
  push_recall: 'higher',
  write_back_fidelity: 'higher',
  provenance_accuracy: 'higher',
  continuity_rate: 'higher',
  extraction_recall: 'higher',
  extraction_precision: 'higher',
};

const BASELINE_SCHEMA_VERSION = 1;

/** The canonical `${harness}/${suite}` cell key — baseline + run-all records share it. */
export function cellKey(c: Pick<SuiteMetrics, 'harness' | 'suite'>): string {
  return `${c.harness}/${c.suite}`;
}

function sortedRecord<T>(entries: Array<[string, T]>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) out[k] = v;
  return out;
}

/** Build the canonical, diff-stable committed-baseline shape from a run. */
export function toCanonicalBaseline(
  result: Pick<BrainBenchResult, 'cells'> & {
    receipt: Pick<
      BrainBenchResult['receipt'],
      'fixtures_hash' | 'include_holdout' | 'llm'
    > & { harnesses?: string[]; suites?: string[] };
  },
  justification?: string,
  config?: { harnesses: string[]; suites: string[] },
): BrainBenchBaseline {
  const cells: Array<[string, Record<string, number>]> = [];
  const counts: Array<[string, { gold_total: number; gold_failed: number }]> = [];
  for (const c of result.cells) {
    cells.push([
      cellKey(c),
      sortedRecord(Object.entries(c.metrics).map(([k, v]) => [k, round4(v)] as [string, number])),
    ]);
    counts.push([cellKey(c), { gold_total: c.gold_total, gold_failed: c.gold_failed }]);
  }
  const baseline: BrainBenchBaseline = {
    schema_version: BASELINE_SCHEMA_VERSION,
    fixtures_hash: result.receipt.fixtures_hash,
    config: {
      include_holdout: result.receipt.include_holdout,
      llm: result.receipt.llm,
      harnesses: [...(config?.harnesses ?? [])].sort(),
      suites: [...(config?.suites ?? [])].sort(),
    },
    cells: sortedRecord(cells),
    counts: sortedRecord(counts),
  };
  if (justification) baseline.justification = justification;
  return baseline;
}

/** Deterministic serialization for the committed file + bless-mode equality. */
export function serializeBaseline(b: BrainBenchBaseline): string {
  // Field order is fixed by construction; metrics/cells already sorted.
  const ordered: Record<string, unknown> = {
    schema_version: b.schema_version,
    fixtures_hash: b.fixtures_hash,
    config: b.config,
  };
  if (b.justification) ordered.justification = b.justification;
  ordered.cells = b.cells;
  ordered.counts = b.counts;
  return JSON.stringify(ordered, null, 2) + '\n';
}

/** Equality on the receipts-backed content (justification excluded — it's the bless note, not data). */
function baselineDataEquals(a: BrainBenchBaseline, b: BrainBenchBaseline): boolean {
  return (
    serializeBaseline({ ...a, justification: undefined }) ===
    serializeBaseline({ ...b, justification: undefined })
  );
}

export function parseBaseline(raw: string, file: string): BrainBenchBaseline {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`brainbench baseline ${file}: invalid JSON (${(err as Error).message})`);
  }
  const b = parsed as Partial<BrainBenchBaseline>;
  if (b.schema_version !== BASELINE_SCHEMA_VERSION) {
    throw new Error(`brainbench baseline ${file}: schema_version must be ${BASELINE_SCHEMA_VERSION}`);
  }
  if (typeof b.fixtures_hash !== 'string' || !b.cells || !b.counts || !b.config) {
    throw new Error(`brainbench baseline ${file}: missing fixtures_hash/config/cells/counts`);
  }
  return b as BrainBenchBaseline;
}

function configsMatch(a: BrainBenchBaseline['config'], b: BrainBenchBaseline['config']): boolean {
  return (
    a.include_holdout === b.include_holdout &&
    a.llm === b.llm &&
    JSON.stringify(a.harnesses) === JSON.stringify(b.harnesses) &&
    JSON.stringify(a.suites) === JSON.stringify(b.suites)
  );
}

export interface CompareOpts {
  /** Local escape hatch — reason recorded, breaches downgraded to notes. */
  allowRegression?: string;
  /**
   * Corpus-bless verification target: the committed baseline from the WORKING
   * TREE (decision 4). Required for bless mode to pass; must exactly match the
   * current run.
   */
  committedBaseline?: BrainBenchBaseline | null;
}

export function compareBaselines(
  current: BrainBenchBaseline,
  main: BrainBenchBaseline,
  opts: CompareOpts = {},
): CompareOutcome {
  const breaches: CompareOutcome['breaches'] = [];
  const notes: string[] = [];

  // Source isolation gates at zero regardless of what any baseline says.
  for (const [cell, metrics] of Object.entries(current.cells)) {
    const v = metrics.source_isolation_violations;
    if (v !== undefined && v > 0) {
      breaches.push({
        cell,
        metric: 'source_isolation_violations',
        baseline: 0,
        current: v,
        detail: 'cross-source injection — gates at zero (data-leak invariant)',
      });
    }
  }

  const sameHash = current.fixtures_hash === main.fixtures_hash;
  const mode: CompareOutcome['mode'] = sameHash ? 'same-hash' : 'corpus-bless';

  // Run-config binding (red-team finding: fixtures_hash covers files only —
  // a holdout-inclusive or --llm baseline is incomparable under the same hash).
  if (!configsMatch(current.config, main.config)) {
    return {
      verdict: 'inconclusive',
      mode,
      breaches,
      notes: [
        `run config mismatch: current=${JSON.stringify(current.config)} vs baseline=${JSON.stringify(main.config)} — compare like with like`,
      ],
    };
  }

  // Adverse metric/count movement vs main's baseline (both modes; in bless
  // mode it's what the justification must answer for).
  for (const [cell, mainCounts] of Object.entries(main.counts)) {
    const cur = current.counts[cell];
    if (!cur) {
      breaches.push({
        cell,
        metric: 'gold_failed',
        baseline: mainCounts.gold_failed,
        current: NaN,
        detail: 'cell missing from current run (suite/harness coverage disappeared)',
      });
      continue;
    }
    if (sameHash && cur.gold_failed > mainCounts.gold_failed) {
      breaches.push({
        cell,
        metric: 'gold_failed',
        baseline: mainCounts.gold_failed,
        current: cur.gold_failed,
        detail: `${cur.gold_failed - mainCounts.gold_failed} newly-failed gold item(s)`,
      });
    }
    // Same corpus MUST yield identical gold_total (adversarial finding: a
    // code-only change that breaks the scorer/loader could silently hollow
    // scoring coverage to zero failures). Free invariant — enforce it.
    if (sameHash && cur.gold_total !== mainCounts.gold_total) {
      breaches.push({
        cell,
        metric: 'gold_total',
        baseline: mainCounts.gold_total,
        current: cur.gold_total,
        detail: 'scoring coverage changed WITHOUT a fixture change — scorer/loader behavior shifted',
      });
    }
    // Corpus hollowing (red-team finding): in bless mode, deleting failing
    // fixtures (or flipping them holdout) shrinks gold_total and IMPROVES
    // every rate — require a justification for shrunken coverage exactly like
    // an adverse metric move.
    if (!sameHash && cur.gold_total < mainCounts.gold_total) {
      breaches.push({
        cell,
        metric: 'gold_total',
        baseline: mainCounts.gold_total,
        current: cur.gold_total,
        detail: `gold coverage shrank by ${mainCounts.gold_total - cur.gold_total} item(s) — corpus hollowing requires justification`,
      });
    }
  }
  for (const [cell, mainMetrics] of Object.entries(main.cells)) {
    const curMetrics = current.cells[cell];
    if (!curMetrics) continue; // covered by the counts check above
    for (const [metric, direction] of Object.entries(GATED_METRICS)) {
      const was = mainMetrics[metric];
      const now = curMetrics[metric];
      if (was === undefined || now === undefined) continue;
      if (metric === 'source_isolation_violations') continue; // gated at zero above
      const adverse = direction === 'lower' ? now > was : now < was;
      if (adverse) {
        breaches.push({
          cell,
          metric,
          baseline: was,
          current: now,
          detail: `${direction === 'lower' ? 'rose' : 'fell'} ${round4(Math.abs(now - was))}`,
        });
      }
    }
  }

  if (mode === 'corpus-bless') {
    notes.push(
      `fixtures_hash changed (${main.fixtures_hash.slice(0, 12)} → ${current.fixtures_hash.slice(0, 12)}) — corpus-bless mode`,
    );
    const committed = opts.committedBaseline;
    if (!committed) {
      return {
        verdict: 'inconclusive',
        mode,
        breaches,
        notes: [
          ...notes,
          'no committed baseline to verify — run `gbrain eval brainbench --update-baseline` and commit the result',
        ],
      };
    }
    // The committed file must match the actual run (it can't lie).
    const runSer = serializeBaseline({ ...current, justification: committed.justification });
    const committedSer = serializeBaseline(committed);
    if (runSer !== committedSer) {
      return {
        verdict: 'inconclusive',
        mode,
        breaches,
        notes: [
          ...notes,
          'committed baseline does not match this run — re-run `--update-baseline` and commit',
        ],
      };
    }
    if (breaches.length > 0 && !committed.justification && !opts.allowRegression) {
      return {
        verdict: 'regression',
        mode,
        breaches,
        notes: [
          ...notes,
          'metrics regressed vs main — add a `justification` to the committed baseline (the reviewable reason)',
        ],
      };
    }
    if (breaches.length > 0) {
      notes.push(
        `regression blessed: ${committed.justification ?? opts.allowRegression ?? ''}`.trim(),
      );
    }
    return { verdict: 'pass', mode, breaches, notes };
  }

  // SAME-HASH committed-baseline drift (red-team finding: two-PR gate
  // poisoning). Any edit to the committed baseline without a fixture change
  // must be receipts-backed by THIS run — otherwise a PR can doctor the file
  // main's future gates compare against. NO hash carve-out (adversarial
  // finding: a doctored committed file with a FOREIGN fixtures_hash slipped
  // through a hash-matched check) — callers running foreign corpora opt out
  // by pointing --committed-baseline elsewhere.
  const committed = opts.committedBaseline;
  if (sameHash && committed && !baselineDataEquals(committed, main)) {
    if (!baselineDataEquals(committed, current)) {
      return {
        verdict: 'inconclusive',
        mode,
        breaches,
        notes: [
          ...notes,
          'committed baseline differs from main WITHOUT a fixture change and does not match this run — a baseline edit must be receipts-backed (`--update-baseline`) or reverted',
        ],
      };
    }
    notes.push('committed baseline updated (matches this run) — the diff vs main is the visible delta');
    // Receipts-backed update: regressions still need blessing below.
    if (breaches.length > 0 && committed.justification && !opts.allowRegression) {
      notes.push(`regression blessed: ${committed.justification}`);
      return { verdict: 'pass', mode, breaches, notes };
    }
  }

  if (breaches.length > 0) {
    if (opts.allowRegression) {
      notes.push(`regression allowed: ${opts.allowRegression}`);
      return { verdict: 'pass', mode, breaches, notes };
    }
    return { verdict: 'regression', mode, breaches, notes };
  }
  return { verdict: 'pass', mode, breaches, notes };
}

// ---------------------------------------------------------------------------
// Markdown scoreboard
// ---------------------------------------------------------------------------

const METRIC_ORDER = [
  'know_to_ask_failure_rate',
  'false_fire_rate',
  'push_precision',
  'push_recall',
  'write_back_fidelity',
  'provenance_accuracy',
  'continuity_rate',
  'extraction_recall',
  'extraction_precision',
  'source_isolation_violations',
  'avg_injected_tokens',
];

export function renderScoreboardMarkdown(
  result: BrainBenchResult,
  compare?: CompareOutcome | null,
): string {
  const lines: string[] = [];
  lines.push('# BrainBench scoreboard');
  lines.push('');
  lines.push(
    `fixtures \`${result.receipt.fixtures_hash.slice(0, 12)}\` · ${result.receipt.include_holdout ? 'holdout INCLUDED (published-run mode)' : 'holdout excluded (gate mode)'} · ${result.receipt.llm ? 'LLM extractor' : 'deterministic (hermetic)'}`,
  );
  lines.push('');
  lines.push('| harness | seam | suite | failed/gold | ' + METRIC_ORDER.map((m) => `\`${m}\``).join(' | ') + ' |');
  lines.push('|---|---|---|---|' + METRIC_ORDER.map(() => '---').join('|') + '|');
  for (const c of result.cells) {
    const vals = METRIC_ORDER.map((m) => (c.metrics[m] !== undefined ? String(c.metrics[m]) : '—'));
    lines.push(
      `| ${c.harness} | ${c.seam} | ${c.suite} | ${c.gold_failed}/${c.gold_total} | ${vals.join(' | ')} |`,
    );
  }
  lines.push('');
  lines.push(
    '_seam: `production` rows exercise a shipped integration seam; `contract` rows grade the same gbrain primitives through a harness-shaped injection contract (see docs/eval/BRAINBENCH.md)._',
  );
  if (result.seed_failures.length > 0) {
    lines.push('');
    lines.push(`**SEED FAILURES (${result.seed_failures.length})** — run is invalid (exit 2):`);
    for (const f of result.seed_failures) lines.push(`- ${f.fixture_id}: ${f.error}`);
  }
  if (compare) {
    lines.push('');
    lines.push(`## Gate: ${compare.verdict.toUpperCase()} (${compare.mode})`);
    for (const n of compare.notes) lines.push(`- ${n}`);
    if (compare.breaches.length > 0) {
      lines.push('');
      lines.push('| cell | metric | main | current | detail |');
      lines.push('|---|---|---|---|---|');
      for (const b of compare.breaches) {
        lines.push(
          `| ${b.cell} | ${b.metric} | ${Number.isNaN(b.baseline) ? '—' : b.baseline} | ${Number.isNaN(b.current) ? '—' : b.current} | ${b.detail} |`,
        );
      }
    }
  }
  lines.push('');
  return lines.join('\n');
}
