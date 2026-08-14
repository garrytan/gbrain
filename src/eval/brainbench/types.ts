/**
 * BrainBench — cross-harness memory conformance suite (Cathedral 2).
 *
 * Type layer for the fixture corpus, harness adapters, and result documents.
 * The fixture + result shapes are PUBLISHED interchange formats (mirrored as
 * JSON Schemas in evals/brainbench/schema/) so foreign runners — notably the
 * sibling gbrain-evals repo — can drive `gbrain eval brainbench --fixtures DIR
 * --gold DIR --json --out FILE` against their own corpora. Breaking changes
 * bump FIXTURE_SCHEMA_VERSION / RESULT_SCHEMA_VERSION; additive-only within a
 * version.
 *
 * Sealed-gold discipline (gbrain-evals convention): fixture files carry ONLY
 * what an adapter may see (turns, seed content). Gold annotations live in a
 * separate gold dir, joined by the loader, and the harness hands adapters a
 * sanitized PublicTurn. A `gold` key inside a fixture turn is a VALIDATION
 * ERROR, not a convenience.
 */

import type { ReflexPointer } from '../../core/context/retrieval-reflex.ts';
import type { PGLiteEngine } from '../../core/pglite-engine.ts';

export const FIXTURE_SCHEMA_VERSION = 1;
export const RESULT_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Suites + harnesses
// ---------------------------------------------------------------------------

export const ALL_SUITES = ['know-to-ask', 'push', 'write-back', 'continuity'] as const;
export type BrainBenchSuite = (typeof ALL_SUITES)[number];

export const ALL_HARNESSES = ['openclaw', 'claude-code', 'codex'] as const;
export type HarnessName = (typeof ALL_HARNESSES)[number];

/**
 * 'production' — exercises a shipped integration seam byte-for-byte.
 * 'contract'  — grades gbrain primitives through a harness-shaped injection
 *               contract a later PR will wire to the real harness. Printed on
 *               every scoreboard row; see docs/eval/BRAINBENCH.md.
 */
export type SeamKind = 'production' | 'contract';

// ---------------------------------------------------------------------------
// Fixture (adapter-visible) shapes
// ---------------------------------------------------------------------------

export interface SeedPage {
  slug: string;
  /** Full markdown content incl. frontmatter. Imported with noEmbed. */
  content: string;
  /** Which source this page seeds into. Default 'default'. */
  source_id?: string;
}

export interface SeedFact {
  fact: string;
  entity_slug?: string | null;
  /** Provenance string; default 'bench:seed'. */
  source?: string;
  source_session?: string | null;
  source_id?: string;
}

export interface FixtureTurn {
  turn_id: number;
  role: 'user' | 'assistant';
  text: string;
  /**
   * ISO timestamp. Required for write-back fixtures (the conversation page
   * rendering + segment splitting need real times); optional elsewhere.
   */
  ts?: string;
}

export interface BrainBenchFixture {
  schema_version: number;
  fixture_id: string;
  /** Which metric suites consume this fixture. */
  suites: BrainBenchSuite[];
  /** Generator category (kta-pos, kta-neg, push, write-back, continuity, multi-source, adversarial). */
  category?: string;
  /**
   * Excluded from the CI gate; scored only in published runs (--include-holdout).
   * Gaming resistance per decision 22.
   */
  holdout?: boolean;
  /**
   * Extra source ids to create beyond 'default' (multi-source fixtures,
   * decision 14). Seed pages/facts route via their own source_id.
   */
  sources?: string[];
  /** The source the conversation happens in. Default 'default'. */
  active_source?: string;
  seed_pages?: SeedPage[];
  seed_facts?: SeedFact[];
  turns: FixtureTurn[];
  /** Present on continuity fixtures only (pairing metadata, not gold). */
  continuity?: {
    pair_id: string;
    pair_role: 'writer' | 'reader';
  };
}

/**
 * What an adapter is allowed to see of a turn. Structurally sealed: built by
 * `toPublicTurn`, which picks exactly these fields — anything else (incl. a
 * smuggled `gold`) is dropped.
 */
export interface PublicTurn {
  turn_id: number;
  role: 'user' | 'assistant';
  text: string;
  ts?: string;
}

/**
 * The canonical 4-decimal rounding (decision 10 — baseline diff-stability).
 * ONE implementation; scoreboard + harness import it (review DRY finding).
 */
export function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function toPublicTurn(turn: FixtureTurn): PublicTurn {
  const out: PublicTurn = { turn_id: turn.turn_id, role: turn.role, text: turn.text };
  if (turn.ts !== undefined) out.ts = turn.ts;
  return out;
}

// ---------------------------------------------------------------------------
// Gold (sealed) shapes — evals/brainbench/gold/<fixture_id>.gold.json
// ---------------------------------------------------------------------------

export interface GoldFactSpec {
  /** Human label for the fact ("pricing concern"). */
  gist: string;
  /** The exact fact text the gold extractor emits into the production pipeline. */
  fact: string;
  entity_slug: string | null;
  /** Keyword probe: every keyword must appear (case-insensitive) in the stored fact. */
  match_keywords: string[];
  kind?: 'event' | 'preference' | 'commitment' | 'belief' | 'fact';
}

export interface TurnGold {
  should_retrieve: boolean;
  /** Slugs that SHOULD be injected (recall denominator). */
  gold_slugs?: string[];
  /** Additionally-acceptable slugs (count for precision, not required for recall). */
  acceptable_slugs?: string[];
  /** Write-back gold: facts this turn contributes (consumed via the gold extractor). */
  gold_facts?: GoldFactSpec[];
}

export interface ContinuityDecisionGold {
  decision_id: string;
  /** Reader-side success: any of these slugs injected on the probe turn... */
  expected_slugs: string[];
  /** ...or a stored fact matching all keywords is recallable. */
  match_keywords: string[];
}

export interface FixtureGold {
  fixture_id: string;
  /** Keyed by String(turn_id). Turns without an entry have no gold (assistant turns, filler). */
  turns: Record<string, TurnGold>;
  continuity?: {
    pair_id: string;
    decisions: ContinuityDecisionGold[];
  };
}

/** Loader output: fixture joined with its gold. Internal to the harness — never crosses to adapters. */
export interface LoadedFixture {
  fixture: BrainBenchFixture;
  gold: FixtureGold;
  /** Absolute path the fixture was loaded from (error reporting). */
  path: string;
}

export interface LoadedCorpus {
  fixtures: LoadedFixture[];
  /** sha256 over sorted relative-path + content of every fixture AND gold file. */
  fixtures_hash: string;
  fixture_dir: string;
  gold_dir: string;
}

// ---------------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------------

export interface HarnessTurnResult {
  /** The text the harness would inject this turn (null = stayed silent). */
  injectedText: string | null;
  /** Normalized slugs referenced by the injection — what metrics score. */
  injectedSlugs: string[];
  pointers: ReflexPointer[];
  /** Estimated tokens of injectedText (chars/4 heuristic; intrusion diagnostics). */
  injectedTokens: number;
  latencyMs: number;
}

export interface HarnessAdapter {
  readonly name: HarnessName;
  readonly seam: SeamKind;
  /** Called once per (fixture, adapter) before any turn. */
  beginConversation(engine: PGLiteEngine, fixture: AdapterFixtureView): Promise<void>;
  /**
   * Replay one turn. `priorContextText` is the joined text of PRIOR turns +
   * prior injections — adapters whose seam has no conversation memory (e.g.
   * the claude-code hook contract) ignore it by config, and that delta is
   * part of what the bench measures.
   */
  replayTurn(turn: PublicTurn, priorContextText: string): Promise<HarnessTurnResult>;
  endConversation(): Promise<void>;
}

/** The slice of a fixture an adapter may see (no gold, no category metadata). */
export interface AdapterFixtureView {
  fixture_id: string;
  active_source: string;
  turns: PublicTurn[];
}

// ---------------------------------------------------------------------------
// Per-turn evaluation rows + metric outputs
// ---------------------------------------------------------------------------

export interface TurnRow {
  fixture_id: string;
  turn_id: number;
  harness: HarnessName;
  suite: BrainBenchSuite;
  injected_slugs: string[];
  injected_tokens: number;
  gold: TurnGold | null;
  /** Slugs injected from a source other than the fixture's active source (decision 14). */
  cross_source_slugs: string[];
  latency_ms: number;
}

/** One harness × suite cell of the scoreboard. Counts first; rates derived. */
export interface SuiteMetrics {
  suite: BrainBenchSuite;
  harness: HarnessName;
  seam: SeamKind;
  /** Gold items evaluated / failed — the count-aware gate operates on these. */
  gold_total: number;
  gold_failed: number;
  /** Named metric values (registered in metric-glossary.ts). */
  metrics: Record<string, number>;
  /** Fixture ids that contributed (excludes holdout in gate mode). */
  fixtures: string[];
}

export interface BrainBenchReceipt {
  result_schema_version: number;
  fixtures_hash: string;
  harness_sha: string;
  ts: string;
  cmd_args: string[];
  seed: number;
  include_holdout: boolean;
  llm: boolean;
}

export interface BrainBenchResult {
  receipt: BrainBenchReceipt;
  cells: SuiteMetrics[];
  turn_rows: TurnRow[];
  /** Fixtures that failed to seed (decision 12) — run exits 2 when non-empty. */
  seed_failures: Array<{ fixture_id: string; error: string }>;
  _meta?: { metric_glossary: Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Canonical committed baseline (decision 10) — diff-stable, receipts excluded
// ---------------------------------------------------------------------------

export interface BrainBenchBaseline {
  schema_version: number;
  fixtures_hash: string;
  /**
   * Run configuration the numbers were produced under (red-team finding:
   * fixtures_hash covers files only — a holdout-inclusive or --llm baseline
   * is byte-plausible under the same hash but incomparable). compareBaselines
   * returns inconclusive on mismatch.
   */
  config: {
    include_holdout: boolean;
    llm: boolean;
    harnesses: string[];
    suites: string[];
  };
  /**
   * Required when a regression vs the prior baseline is being blessed
   * (decision 4) — visible in the PR diff, review-enforced.
   */
  justification?: string;
  /** `${harness}/${suite}` → metric name → value rounded to 4 decimals, keys sorted. */
  cells: Record<string, Record<string, number>>;
  /** `${harness}/${suite}` → { gold_total, gold_failed } for the count-aware gate. */
  counts: Record<string, { gold_total: number; gold_failed: number }>;
}

/** Verdict of a compare run. Maps to exit codes 0 / 1 / 2. */
export type CompareVerdict = 'pass' | 'regression' | 'inconclusive';

export interface CompareOutcome {
  verdict: CompareVerdict;
  mode: 'same-hash' | 'corpus-bless';
  breaches: Array<{
    cell: string;
    metric: string;
    baseline: number;
    current: number;
    detail: string;
  }>;
  notes: string[];
}
