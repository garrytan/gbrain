/**
 * BrainBench orchestrator.
 *
 * Engine economy (eng-review D9): ONE in-memory PGLite for the whole run,
 * `resetTables()` between fixtures — the longmemeval lesson; per-fixture WASM
 * cold boots would blow the <2 min CI budget. Read-only suites (know-to-ask,
 * push) seed once and run ALL adapters against the same brain; mutating work
 * (write-back) runs after the replays, and the next fixture starts from a
 * reset. A sentinel-slug test pins that sharing leaks nothing.
 *
 * Continuity pairs (writer fixture → production write-back → reader fixture)
 * run on a shared brain; scores land on the READER's cell. The write path is
 * gbrain's pipeline — harness-INDEPENDENT in v1 (disclosed in
 * docs/eval/BRAINBENCH.md) — so each pair preps ONCE (reset + seed +
 * write-back) and every requested harness replays the read-only reader against
 * that shared state. The per-(writer×reader)-ordering loop this replaces
 * rebuilt byte-identical brains 6x per pair and replayed a writer whose state
 * could not outlive the call (review findings: dead work, identical scores).
 * The writer axis activates when harness-specific write paths actually land.
 *
 * Sealed gold: adapters only ever receive AdapterFixtureView + PublicTurn
 * (toPublicTurn picks fields; gold never crosses).
 */

import { BudgetTracker } from '../../core/budget/budget-tracker.ts';
import { createBenchmarkBrain, resetTables } from '../longmemeval/harness.ts';
import type { PGLiteEngine } from '../../core/pglite-engine.ts';
import { ClaudeCodeAdapter } from './adapters/claude-code.ts';
import { CodexAdapter } from './adapters/codex.ts';
import { OpenClawAdapter } from './adapters/openclaw.ts';
import { scoreKnowToAsk } from './metrics/know-to-ask.ts';
import { scorePush } from './metrics/push.ts';
import { runWriteBack, type WriteBackScore } from './metrics/write-back.ts';
import { scoreContinuityPair } from './metrics/continuity.ts';
import { SeedError, seedBrain, type SeedOutcome } from './seed.ts';
import {
  round4,
  toPublicTurn,
  type AdapterFixtureView,
  type BrainBenchSuite,
  type HarnessAdapter,
  type HarnessName,
  type LoadedCorpus,
  type LoadedFixture,
  type SuiteMetrics,
  type TurnRow,
} from './types.ts';

export interface RunBrainBenchOpts {
  harnesses: HarnessName[];
  suites: BrainBenchSuite[];
  includeHoldout: boolean;
  /** Run the real LLM extractor for write-back (budget-guarded upstream). */
  llm: boolean;
  /** Spend cap for --llm mode (threaded to the extraction pipeline's tracker). */
  budgetUsd?: number;
  /** Progress note sink (CLI wires the shared stderr reporter). */
  onProgress?: (note: string) => void;
}

export interface RunBrainBenchOutput {
  cells: SuiteMetrics[];
  turn_rows: TurnRow[];
  seed_failures: Array<{ fixture_id: string; error: string }>;
  fixtures_run: number;
}

function makeAdapter(name: HarnessName): HarnessAdapter {
  switch (name) {
    case 'openclaw':
      return new OpenClawAdapter();
    case 'claude-code':
      return new ClaudeCodeAdapter();
    case 'codex':
      return new CodexAdapter();
  }
}

const SEAM: Record<HarnessName, 'production' | 'contract'> = {
  openclaw: 'production',
  'claude-code': 'contract',
  codex: 'contract',
};

function adapterView(lf: LoadedFixture): AdapterFixtureView {
  return {
    fixture_id: lf.fixture.fixture_id,
    active_source: lf.fixture.active_source ?? 'default',
    turns: lf.fixture.turns.map(toPublicTurn),
  };
}

function crossSourceSlugs(
  injected: string[],
  slugSource: Map<string, Set<string>>,
  activeSource: string,
): string[] {
  return injected.filter((s) => {
    const set = slugSource.get(s);
    return set !== undefined && !set.has(activeSource);
  });
}

/**
 * Replay every USER turn of a fixture through one adapter. Assistant turns
 * feed prior context only (the production reflex fires on user messages).
 * Returns one TurnRow per (user turn × suite) so per-suite scorers and
 * external re-scorers see self-contained rows.
 */
async function replayFixture(
  engine: PGLiteEngine,
  adapter: HarnessAdapter,
  lf: LoadedFixture,
  seed: SeedOutcome,
  rowSuites: BrainBenchSuite[],
): Promise<TurnRow[]> {
  const view = adapterView(lf);
  const activeSource = view.active_source;
  await adapter.beginConversation(engine, view);
  const rows: TurnRow[] = [];
  let priorContext = '';
  try {
    for (const turn of view.turns) {
      if (turn.role !== 'user') {
        priorContext += `\n${turn.text}`;
        continue;
      }
      const result = await adapter.replayTurn(turn, priorContext);
      const gold = lf.gold.turns[String(turn.turn_id)] ?? null;
      for (const suite of rowSuites) {
        rows.push({
          fixture_id: lf.fixture.fixture_id,
          turn_id: turn.turn_id,
          harness: adapter.name,
          suite,
          injected_slugs: result.injectedSlugs,
          injected_tokens: result.injectedTokens,
          gold,
          cross_source_slugs: crossSourceSlugs(result.injectedSlugs, seed.slugSource, activeSource),
          latency_ms: Math.round(result.latencyMs * 1000) / 1000,
        });
      }
      priorContext += `\n${turn.text}`;
      if (result.injectedText) priorContext += `\n${result.injectedText}`;
    }
  } finally {
    await adapter.endConversation();
  }
  return rows;
}

interface WriteBackAgg {
  gold_total: number;
  gold_failed: number;
  survived: number;
  provenance_ok: number;
  stored_rows: number;
  matched_any_gold: number;
  fixtures: string[];
  failed_items: string[];
}

interface ContinuityAgg {
  gold_total: number;
  gold_failed: number;
  fixtures: string[];
  failed_items: string[];
}

export async function runBrainBench(
  corpus: LoadedCorpus,
  opts: RunBrainBenchOpts,
): Promise<RunBrainBenchOutput> {
  const progress = opts.onProgress ?? (() => {});
  const turnRows: TurnRow[] = [];
  const seedFailures: Array<{ fixture_id: string; error: string }> = [];

  const wantedSuites = new Set(opts.suites);
  const eligible = corpus.fixtures.filter((lf) => {
    if (lf.fixture.holdout && !opts.includeHoldout) return false;
    return lf.fixture.suites.some((s) => wantedSuites.has(s));
  });

  // Continuity pairs are orchestrated separately from regular fixtures.
  const pairFixtures = new Map<string, { writer?: LoadedFixture; reader?: LoadedFixture }>();
  const regular: LoadedFixture[] = [];
  for (const lf of eligible) {
    const cont = lf.fixture.continuity;
    if (cont && wantedSuites.has('continuity')) {
      const p = pairFixtures.get(cont.pair_id) ?? {};
      p[cont.pair_role] = lf;
      pairFixtures.set(cont.pair_id, p);
      // A writer that also declares know-to-ask/push runs as a regular fixture
      // too (its retrieval gold is independent of the pair).
      if (lf.fixture.suites.some((s) => s !== 'continuity' && s !== 'write-back' && wantedSuites.has(s))) {
        regular.push(lf);
      }
    } else {
      regular.push(lf);
    }
  }

  const writeBackAgg: WriteBackAgg = {
    gold_total: 0, gold_failed: 0, survived: 0, provenance_ok: 0,
    stored_rows: 0, matched_any_gold: 0, fixtures: [], failed_items: [],
  };
  const continuityByReader = new Map<HarnessName, ContinuityAgg>();

  // RUN-scoped --llm budget (review finding: a per-invocation cap would
  // multiply by fixture count — ~$550 worst case on the committed corpus).
  const llmTracker = opts.llm
    ? new BudgetTracker({ maxCostUsd: opts.budgetUsd ?? 5, label: 'brainbench:llm' })
    : undefined;

  const engine = await createBenchmarkBrain();
  let fixturesRun = 0;
  try {
    // ---- regular fixtures: seed once, replay all adapters, then mutate ----
    for (const lf of regular) {
      const id = lf.fixture.fixture_id;
      progress(`fixture ${id}`);
      await resetTables(engine);
      let seed: SeedOutcome;
      try {
        seed = await seedBrain(engine, lf.fixture);
      } catch (err) {
        if (err instanceof SeedError) {
          seedFailures.push({ fixture_id: id, error: err.message });
          continue;
        }
        throw err;
      }
      fixturesRun++;

      const retrievalSuites = lf.fixture.suites.filter(
        (s): s is BrainBenchSuite => (s === 'know-to-ask' || s === 'push') && wantedSuites.has(s),
      );
      if (retrievalSuites.length > 0) {
        for (const harness of opts.harnesses) {
          const adapter = makeAdapter(harness);
          const rows = await replayFixture(engine, adapter, lf, seed, retrievalSuites);
          turnRows.push(...rows);
        }
      }

      // Exactly ONE owner per writer's write-back score: the pair loop owns it
      // when continuity is being run (adversarial finding: a hybrid writer
      // double-counted); THIS loop owns it when continuity is filtered out
      // (codex P2: `--suite write-back` alone silently dropped the writers'
      // 12 gold items — 46 vs 58 between filtered and default runs).
      if (
        lf.fixture.suites.includes('write-back') &&
        wantedSuites.has('write-back') &&
        !(lf.fixture.continuity && wantedSuites.has('continuity'))
      ) {
        const score = await runWriteBack(engine, lf.fixture, lf.gold, {
          llm: opts.llm,
          budgetUsd: opts.budgetUsd,
          budgetTracker: llmTracker,
        });
        accumulateWriteBack(writeBackAgg, id, score);
      }
    }

    // ---- continuity pairs: ONE prep per pair, every harness reads it ----
    for (const [pairId, pair] of pairFixtures) {
      if (!pair.writer || !pair.reader) continue; // loader validates; belt+suspenders
      const writer = pair.writer;
      const reader = pair.reader;
      const decisions = reader.gold.continuity?.decisions ?? [];
      if (!decisions.length) continue;

      progress(`continuity ${pairId}`);
      await resetTables(engine);
      let writerSeed: SeedOutcome;
      let readerSeed: SeedOutcome;
      try {
        writerSeed = await seedBrain(engine, writer.fixture);
        readerSeed = await seedBrain(engine, reader.fixture);
      } catch (err) {
        if (err instanceof SeedError) {
          seedFailures.push({ fixture_id: pairId, error: err.message });
          continue;
        }
        throw err;
      }
      fixturesRun += 2;
      // The reader replays against BOTH fixtures' seeded pages — merge the
      // slug→source maps or cross-source detection is structurally blind to
      // writer-seeded slugs (red-team finding: the zero-gate was vacuous).
      const mergedSeed: SeedOutcome = {
        slugSource: new Map(writerSeed.slugSource),
        pages: writerSeed.pages + readerSeed.pages,
        facts: writerSeed.facts + readerSeed.facts,
      };
      for (const [slug, sources] of readerSeed.slugSource) {
        const set = mergedSeed.slugSource.get(slug) ?? new Set<string>();
        for (const s of sources) set.add(s);
        mergedSeed.slugSource.set(slug, set);
      }

      // The writer's decisions persist through the PRODUCTION pipeline —
      // harness-independent in v1, so it runs once per pair. Writers that
      // declare the write-back suite are SCORED here too (red-team finding:
      // the score was computed and dropped, leaving 15 writers' provenance
      // gold unmeasured in the default run and making the write-back cell
      // composition flag-dependent).
      const writerWb = await runWriteBack(engine, writer.fixture, writer.gold, {
        llm: opts.llm,
        budgetUsd: opts.budgetUsd,
        budgetTracker: llmTracker,
      });
      if (writer.fixture.suites.includes('write-back') && wantedSuites.has('write-back')) {
        accumulateWriteBack(writeBackAgg, writer.fixture.fixture_id, writerWb);
      }

      // Every requested harness reads the SAME persisted state (read-only).
      for (const readerHarness of opts.harnesses) {
        const readerAdapter = makeAdapter(readerHarness);
        const readerRows = await replayFixture(engine, readerAdapter, reader, mergedSeed, ['continuity']);
        turnRows.push(...readerRows);

        const activeSource = reader.fixture.active_source ?? 'default';
        const score = await scoreContinuityPair(engine, activeSource, pairId, readerRows, decisions);

        const agg = continuityByReader.get(readerHarness) ?? {
          gold_total: 0, gold_failed: 0, fixtures: [], failed_items: [],
        };
        agg.gold_total += score.gold_total;
        agg.gold_failed += score.gold_failed;
        if (!agg.fixtures.includes(reader.fixture.fixture_id)) agg.fixtures.push(reader.fixture.fixture_id);
        agg.failed_items.push(...score.failed_items.map((f) => `${f} [reader: ${readerHarness}]`));
        continuityByReader.set(readerHarness, agg);
      }
    }
  } finally {
    await engine.disconnect();
  }

  // ---- assemble cells ----
  const cells: SuiteMetrics[] = [];
  for (const harness of opts.harnesses) {
    for (const suite of opts.suites) {
      const cell = assembleCell(harness, suite, turnRows, writeBackAgg, continuityByReader, opts.llm);
      if (cell) cells.push(cell);
    }
  }

  return { cells, turn_rows: turnRows, seed_failures: seedFailures, fixtures_run: fixturesRun };
}

function accumulateWriteBack(agg: WriteBackAgg, fixtureId: string, score: WriteBackScore): void {
  agg.gold_total += score.gold_total;
  agg.gold_failed += score.gold_failed;
  agg.survived += score.survived;
  agg.provenance_ok += score.provenance_ok;
  agg.stored_rows += score.stored_rows;
  agg.matched_any_gold += score.matched_any_gold;
  agg.fixtures.push(fixtureId);
  agg.failed_items.push(...score.failed_items);
}

function assembleCell(
  harness: HarnessName,
  suite: BrainBenchSuite,
  turnRows: TurnRow[],
  writeBackAgg: WriteBackAgg,
  continuityByReader: Map<HarnessName, ContinuityAgg>,
  llm: boolean,
): SuiteMetrics | null {
  if (suite === 'write-back') {
    if (writeBackAgg.fixtures.length === 0) return null;
    // The write path is gbrain's pipeline — identical for every harness seam
    // in v1, so each harness cell carries the same (once-computed) numbers.
    // When harness-specific write paths land, this is where they diverge.
    const metrics: Record<string, number> = {
      write_back_fidelity: round4(
        writeBackAgg.gold_total > 0 ? writeBackAgg.survived / writeBackAgg.gold_total : 1,
      ),
      provenance_accuracy: round4(
        writeBackAgg.survived > 0 ? writeBackAgg.provenance_ok / writeBackAgg.survived : 1,
      ),
    };
    if (llm) {
      // Σ-aggregated extraction quality (review finding: per-fixture values
      // were computed but never reached any cell).
      metrics.extraction_recall = round4(
        writeBackAgg.gold_total > 0 ? writeBackAgg.survived / writeBackAgg.gold_total : 1,
      );
      metrics.extraction_precision = round4(
        writeBackAgg.stored_rows > 0 ? writeBackAgg.matched_any_gold / writeBackAgg.stored_rows : 1,
      );
    }
    return {
      suite, harness, seam: SEAM[harness],
      gold_total: writeBackAgg.gold_total,
      gold_failed: writeBackAgg.gold_failed,
      metrics,
      fixtures: [...writeBackAgg.fixtures],
    };
  }

  if (suite === 'continuity') {
    const agg = continuityByReader.get(harness);
    if (!agg) return null;
    const rows = turnRows.filter((r) => r.harness === harness && r.suite === 'continuity');
    return {
      suite, harness, seam: SEAM[harness],
      gold_total: agg.gold_total,
      gold_failed: agg.gold_failed,
      metrics: {
        continuity_rate: round4(
          agg.gold_total > 0 ? (agg.gold_total - agg.gold_failed) / agg.gold_total : 1,
        ),
        source_isolation_violations: rows.reduce((n, r) => n + r.cross_source_slugs.length, 0),
        avg_injected_tokens: round4(avg(rows.map((r) => r.injected_tokens))),
      },
      fixtures: [...agg.fixtures],
    };
  }

  const rows = turnRows.filter((r) => r.harness === harness && r.suite === suite);
  if (rows.length === 0) return null;
  const score = suite === 'know-to-ask' ? scoreKnowToAsk(rows) : scorePush(rows);
  const fixtures = [...new Set(rows.map((r) => r.fixture_id))];
  return {
    suite, harness, seam: SEAM[harness],
    gold_total: score.gold_total,
    gold_failed: score.gold_failed,
    metrics: {
      ...Object.fromEntries(Object.entries(score.metrics).map(([k, v]) => [k, round4(v)])),
      source_isolation_violations: rows.reduce((n, r) => n + r.cross_source_slugs.length, 0),
      avg_injected_tokens: round4(avg(rows.map((r) => r.injected_tokens))),
    },
    fixtures,
  };
}

function avg(ns: number[]): number {
  return ns.length === 0 ? 0 : ns.reduce((a, b) => a + b, 0) / ns.length;
}
