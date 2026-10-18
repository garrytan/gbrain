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

export const ALL_SUITES = [
  'know-to-ask', 'push', 'write-back', 'continuity',
  'trust', 'state-resolution', 'poisoning', 'deletion',
] as const;
export type BrainBenchSuite = (typeof ALL_SUITES)[number];

/**
 * Memory-trust suites (#5575). Their fixtures drive real tiered write paths
 * (`trust_steps`) on a persistence-enabled brain instead of the seeder, and
 * are scored from the sealed `trust` gold block. One suite per fixture.
 */
export const TRUST_SUITES = ['trust', 'state-resolution', 'poisoning', 'deletion'] as const;
export type TrustSuite = (typeof TRUST_SUITES)[number];
export function isTrustSuite(s: string): s is TrustSuite {
  return (TRUST_SUITES as readonly string[]).includes(s);
}

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
  /**
   * Memory-trust suites only: ordered writes through real channels (owner
   * sync, local and remote agents, a connector capture, owner actions). They
   * run before the turns, which then replay as a later session.
   */
  trust_steps?: TrustStep[];
}

/**
 * Who performs a trust step. `owner` writes and syncs files in the
 * fixture's own git-backed source (operator_curated) and runs owner actions
 * on a confirmed terminal; `local_agent` / `remote_agent` call operations as
 * the local CLI / an MCP connection with read+write scopes; `connector` is a
 * webhook capture (external); `raw` is a process with a database connection
 * attempting a direct tier raise.
 */
export const TRUST_ACTORS = ['owner', 'local_agent', 'remote_agent', 'connector', 'raw'] as const;
export type TrustActor = (typeof TRUST_ACTORS)[number];
export const TRUST_OPS = ['write_file', 'sync', 'put_page', 'capture', 'remember', 'forget', 'confirm', 'purge', 'raise_tier'] as const;
export type TrustOp = (typeof TRUST_OPS)[number];
/** Which actors may perform which op (validated by the loader). */
export const TRUST_ACTOR_OPS: Readonly<Record<TrustActor, readonly TrustOp[]>> = {
  owner: ['write_file', 'sync', 'confirm', 'purge'],
  local_agent: ['put_page', 'remember', 'confirm'],
  remote_agent: ['put_page', 'capture', 'remember', 'forget', 'confirm', 'purge'],
  connector: ['capture'],
  raw: ['raise_tier'],
};

export interface TrustStep {
  step_id: string;
  actor: TrustActor;
  op: TrustOp;
  /** Page slug (write_file, put_page, capture). */
  slug?: string;
  /** Page markdown (write_file, put_page) or capture body. */
  content?: string;
  /** remember: the claim. */
  fact?: string;
  entity?: string;
  kind?: 'fact' | 'preference' | 'commitment' | 'event' | 'belief';
  content_origin?: 'user_said' | 'tool_output' | 'inferred';
  /** confirm / purge / forget / raise_tier / remember.replaces: the step whose row is acted on. */
  target?: string;
  /** Picks one fact row of a page step (an owner file's facts fence) by its claim text. */
  target_claim?: string;
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
  /** Memory-trust suites: what each step should have produced. */
  trust?: { items: TrustGoldItem[] };
}

/**
 * One scored expectation of a memory-trust fixture.
 *   tier       the step's row is stored and read back (get_page, search, recall) at exactly `tier` (trust)
 *   max_tier   the step's row is stored at `tier` or lower: no laundering upward (trust)
 *   refused    the step was refused and its target's tier did not rise (trust: self-promotion)
 *   current    the step's fact is the active one recall returns (state-resolution)
 *   stale      the step's fact is not returned as current (state-resolution)
 *   history    the step's fact row is kept (expired or superseded, never deleted) (state-resolution)
 *   guarded    the step's fact stays active after a lower-tier write tried to replace or forget it (state-resolution)
 *   poison     an instruction-like payload carrying `canary` (poisoning)
 *   benign     ordinary content carrying `canary` (poisoning)
 *   purged     the purge step removed `probe` from every live store, its receipt names them, nothing resurrects (deletion)
 */
export const TRUST_CHECKS = ['tier', 'max_tier', 'refused', 'current', 'stale', 'history', 'guarded', 'poison', 'benign', 'purged'] as const;
export type TrustCheck = (typeof TRUST_CHECKS)[number];
export interface TrustGoldItem {
  item_id: string;
  check: TrustCheck;
  step: string;
  /** Fact selector within a page step. */
  claim?: string;
  /** Exact tier (`tier`) or ceiling (`max_tier`). */
  tier?: import('../../core/trust/tier.ts').TrustTier;
  /** poisoning arm. */
  arm?: 'external' | 'agent_relayed';
  /** poisoning: unique token inside the payload or benign text. */
  canary?: string;
  /** poisoning: the payload is a standing preference or commitment fact. */
  preference?: boolean;
  /** deletion: the exact text the purge must remove. */
  probe?: string;
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
  /** System One (turn-context seams): the per-turn decide meta, present only when a decide slot is not off. */
  decide?: import('../../core/search/decide-stage.ts').DecideSearchMeta;
}

export interface HarnessAdapter {
  readonly name: HarnessName;
  readonly seam: SeamKind;
  /**
   * v0.46.15 — optional RUN-scoped lifecycle (outside-voice F4/R2-5). The
   * harness constructs ONE adapter per harness per run and calls setupRun
   * before the first fixture / teardownRun after the last, so a production
   * seam can own long-lived infrastructure (the claude-code adapter's
   * resolve-IPC server + temp home) instead of paying setup per fixture.
   */
  setupRun?(): Promise<void>;
  teardownRun?(): Promise<void>;
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
  /** System One arm (`--decide`): per-slot receipt for this turn (S6 recall_needed meta + decide spend). Absent when every slot is off. */
  decide?: Partial<Record<import('../../core/ai/decide/types.ts').DecideSlot, import('../decide-eval-flags.ts').DecideSlotReceipt>>;
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
  /** System One arm (`--decide`): flags, provider, calibrations, split and the per-slot roll-up. Absent when every slot is off. */
  decide?: Record<string, unknown>;
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
