/**
 * BrainBench adapter interface (v1.1 Phase 2).
 *
 * Adapters are configs-under-test. Each one ingests the same raw pages,
 * answers the same queries, and emits ranked results. The runner treats
 * BrainState as opaque — it never inspects adapter internals.
 *
 * Ingestion boundary: the runner passes `rawPages: Page[]` in memory.
 * Adapters NEVER receive the `gold/` directory path. Gold is consumed only
 * by scorers, which the runner calls separately on adapter output. This is
 * structural enforcement of the "system-under-test gets only raw pages"
 * contract (eng pass 2 requirement).
 *
 * Precedence of adapter implementations (ships across Phase 2):
 *   GbrainAdapter       (configs A–F — existing gbrain wrapped in the interface)
 *   RipgrepBm25Adapter  (EXT-1 — strong grep-based baseline)
 *   VectorOnlyAdapter   (EXT-2 — commodity vector RAG, same embedder as gbrain)
 *   HybridNoGraphAdapter(EXT-3 — gbrain hybrid with graph features disabled)
 */

// ─── Page ────────────────────────────────────────────────────────────

/**
 * A raw page as the adapter sees it. Slug is the stable ID;
 * compiled_truth + timeline are the prose the adapter indexes.
 * Frontmatter carries loosely-typed metadata (type, title, etc.).
 */
export interface Page {
  slug: string;
  type: 'person' | 'company' | 'meeting' | 'concept' | 'deal' | 'project' | 'source' | 'media';
  title: string;
  compiled_truth: string;
  timeline: string;
  /** Optional additional metadata. Adapters should NOT rely on _facts —
   *  that field is the gold canonical source, reserved for scorers. */
  frontmatter?: Record<string, unknown>;
}

// ─── Query ───────────────────────────────────────────────────────────

export type Tier =
  | 'easy'              // T1: single-page lookup
  | 'medium'            // T2: relational, graph-required
  | 'hard'              // T3: multi-hop + temporal
  | 'adversarial'       // T4: identity collisions, contradictions
  | 'fuzzy'             // T5: vague recall, "I know I mentioned it somewhere"
  | 'externally-authored'; // T5.5: outside-researcher queries

export type ExpectedOutputType =
  | 'answer-string'
  | 'canonical-entity-id'
  | 'cited-source-pages'
  | 'time-qualified-answer'
  | 'abstention'
  | 'contradiction-explanation'
  | 'poison-flag'
  | 'confidence-score';

/**
 * Gold shape varies by tier. Kept as an open-ended record; scorers
 * validate the tier-specific shape. Canonical gold for relational queries
 * lives under `relevant` (list of page slugs expected in top-K).
 */
export interface Gold {
  relevant?: string[];
  grades?: Record<string, number>;
  expected_answer?: string;
  expected_entity_id?: string;
  expected_citations?: string[];
  expected_abstention?: boolean;
  expected_as_of?: string;
  [key: string]: unknown;
}

export interface Query {
  id: string;                       // q-0001 … q-0350
  tier: Tier;
  text: string;                     // natural-language query
  expected_output_type: ExpectedOutputType;
  gold: Gold;
  /** Required for temporal queries — see eng pass 2 validator spec. */
  as_of_date?: string | 'corpus-end' | 'per-source';
  acceptable_variants?: string[];   // for LLM-judged outputs
  known_failure_modes?: string[];
  author?: string;                  // set for Tier 5.5 externally-authored
  tags?: string[];                  // 'identity-collision', 'contradiction', etc.
}

// ─── RankedDoc ──────────────────────────────────────────────────────

/**
 * Adapter output per query: a ranked list of pages the adapter believes
 * are relevant. Score semantics are adapter-specific; only RANK matters
 * for top-K metrics. Scorers never compare scores across adapters.
 */
export interface RankedDoc {
  page_id: string;   // page slug
  score: number;     // adapter-internal relevance score (not comparable across adapters)
  rank: number;      // 1-based rank within this query's result list
  /** Optional snippet of supporting text. Useful for citation scoring. */
  snippet?: string;
}

// ─── PoisonDisposition ──────────────────────────────────────────────

/**
 * Per eng pass 2 spec. Each poison item in the corpus is tagged with an
 * `expected_behavior` in gold; the adapter reports which behavior it
 * chose via getPoisonDisposition(). Scorer matches adapter disposition
 * against expected to compute poison_resistance.
 */
export type PoisonDisposition =
  | 'exclude'        // never ingested; page not in index
  | 'quarantine'     // ingested but tagged; not returned in normal queries
  | 'warn'           // retrievable with a warning flag on results
  | 'ignore'         // indexed but not used for factual answers
  | 'mark-untrusted';// provenance metadata flags source as untrusted

// ─── AdapterConfig ──────────────────────────────────────────────────

/**
 * Per-adapter configuration knobs. Adapter implementations extend this
 * with their own fields (e.g. GbrainAdapter takes `config: 'A' | ... | 'F'`).
 */
export interface AdapterConfig {
  /** Human-readable adapter name (shown in scorecards). */
  name: string;
  /** Top-K truncation the scorer uses (adapter is free to return more). */
  k?: number;
  /** Adapter-specific options. */
  [key: string]: unknown;
}

// ─── BrainState ─────────────────────────────────────────────────────

/**
 * OPAQUE to the runner. Each adapter internally defines its own shape:
 *   RipgrepBm25Adapter BrainState = an in-memory inverted index + doc-length table
 *   GbrainAdapter BrainState      = a PGLite engine handle + .db file path
 *   VectorOnlyAdapter BrainState  = embedding index + cached vectors
 *
 * The runner only uses it as an adapter-internal state handle. Never
 * inspected, serialized, or cross-type-checked. This is the structural
 * boundary that prevents a runner bug from leaking implementation details
 * across adapters.
 */
export type BrainState = unknown;

// ─── Adapter interface ──────────────────────────────────────────────

export interface Adapter {
  /** The registered adapter name, e.g. "gbrain-a" | "ripgrep-bm25". */
  readonly name: string;

  /**
   * Ingest the raw pages and build internal state. Called ONCE per
   * benchmark run. Adapters that need warming (embeddings, indexes) do
   * that work here.
   */
  init(rawPages: Page[], config: AdapterConfig): Promise<BrainState>;

  /**
   * Answer a single query. Adapters return their top results in rank
   * order. The scorer applies the query's `k` cutoff; adapters are free
   * to return fewer than k (with a shorter list).
   */
  query(q: Query, state: BrainState): Promise<RankedDoc[]>;

  /**
   * Persist the brain state to a filesystem path (for reproducibility +
   * cross-task state sharing). Returns the path. Optional — adapters
   * that don't support snapshotting can return an empty string.
   */
  snapshot?(state: BrainState): Promise<string>;

  /**
   * Per-page poison disposition: what did the adapter do with each
   * poison item? Scorer compares to gold's `expected_behavior`.
   * Adapters that don't have a poison path return an empty map.
   */
  getPoisonDisposition?(state: BrainState): Record<string, PoisonDisposition>;

  /**
   * Release any resources held by `state` (DB connections, file locks,
   * worker threads). Called once per run after scoring completes.
   * Adapters that hold no resources can omit this. Without it, PGLite-backed
   * adapters leak engine workers and Bun exits 99 at the end of the run.
   */
  teardown?(state: BrainState): Promise<void>;
}

// ─── Scorer helpers ─────────────────────────────────────────────────

/** Standard top-K slice; helper since every scorer needs it. */
export function topK(docs: RankedDoc[], k: number): RankedDoc[] {
  return docs.slice(0, k);
}

/** Precision@k: fraction of top-k that are in relevant set. */
export function precisionAtK(docs: RankedDoc[], relevant: Set<string>, k: number): number {
  const topDocs = topK(docs, k);
  if (topDocs.length === 0) return 0;
  let hits = 0;
  for (const d of topDocs) if (relevant.has(d.page_id)) hits++;
  return hits / topDocs.length;
}

/** Recall@k: fraction of relevant found in top-k. */
export function recallAtK(docs: RankedDoc[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 0;
  const topDocs = topK(docs, k);
  let hits = 0;
  for (const d of topDocs) if (relevant.has(d.page_id)) hits++;
  return hits / relevant.size;
}
