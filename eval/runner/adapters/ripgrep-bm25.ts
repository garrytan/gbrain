/**
 * BrainBench EXT-1: Ripgrep + BM25 adapter.
 *
 * The "honest grep-plus-BM25 baseline" — what any agent could build in an
 * afternoon with standard unix tools and a classic IR formula. This is the
 * external comparator that turns BrainBench from internal gbrain ablation
 * into a real category benchmark.
 *
 * Design:
 *   1. init():  Tokenizes each page's content, builds an inverted index
 *               + per-doc length table + global term/doc frequencies.
 *   2. query(): Tokenizes the query, scores every candidate doc via BM25,
 *               returns top candidates ranked by score.
 *
 * No embeddings, no graph, no LLM. Just deterministic token-match ranking.
 * This is intentionally what a "what could any agent do with grep + a
 * reasonable ranker" baseline looks like.
 *
 * Reference: Robertson & Zaragoza, "The Probabilistic Relevance Framework:
 * BM25 and Beyond" (2009). Standard formula:
 *
 *   BM25(D, Q) = Σ_{q ∈ Q} IDF(q) × (tf(q, D) × (k1 + 1)) /
 *                         (tf(q, D) + k1 × (1 - b + b × |D| / avgdl))
 *
 * Defaults: k1 = 1.5, b = 0.75. These are the values Lucene ships.
 */

import type { Adapter, AdapterConfig, BrainState, Page, Query, RankedDoc } from '../types.ts';

// ─── Tokenization ──────────────────────────────────────────────────

/**
 * Tokenize text for BM25: lowercase, split on non-word chars, filter stopwords
 * and tokens shorter than 2 characters. Markdown link syntax `[Name](slug)`
 * is preserved enough that entity names tokenize into their component words.
 *
 * NOTE: Slug references (e.g. `people/alice-chen`) get split into
 * `people`, `alice`, `chen` tokens — intentional, so that a query for
 * "alice chen" matches pages referencing her by slug as well as name.
 */
const STOPWORDS = new Set([
  'a','an','the','and','or','but','is','are','was','were','be','been','being',
  'have','has','had','do','does','did','will','would','should','could','may',
  'might','can','of','to','in','on','at','for','with','by','from','as','it',
  'its','this','that','these','those','i','you','he','she','we','they',
  'them','us','him','her','his','hers','their','theirs','my','mine','your',
  'yours','our','ours',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 2 && !STOPWORDS.has(t));
}

// ─── BM25 state ─────────────────────────────────────────────────────

interface Bm25State {
  /** term -> Map<docId, termFreq>. Inverted index. */
  postings: Map<string, Map<string, number>>;
  /** docId -> total token count (doc length). */
  docLengths: Map<string, number>;
  /** Average doc length across the corpus (BM25 normalization). */
  avgDocLength: number;
  /** docId -> original Page (for returning ranked results). */
  docs: Map<string, Page>;
  /** Total docs (|corpus|). */
  N: number;
  k1: number;
  b: number;
}

function buildState(pages: Page[], k1: number, b: number): Bm25State {
  const postings = new Map<string, Map<string, number>>();
  const docLengths = new Map<string, number>();
  const docs = new Map<string, Page>();
  let totalLength = 0;

  for (const p of pages) {
    docs.set(p.slug, p);
    // Index title + compiled_truth + timeline. Title gets double weight by
    // being tokenized twice — cheap boost for slug-match on entity pages.
    const content = `${p.title} ${p.title} ${p.compiled_truth} ${p.timeline}`;
    const tokens = tokenize(content);
    docLengths.set(p.slug, tokens.length);
    totalLength += tokens.length;

    const termFreq = new Map<string, number>();
    for (const t of tokens) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
    for (const [term, tf] of termFreq) {
      let docMap = postings.get(term);
      if (!docMap) {
        docMap = new Map();
        postings.set(term, docMap);
      }
      docMap.set(p.slug, tf);
    }
  }

  return {
    postings,
    docLengths,
    avgDocLength: pages.length > 0 ? totalLength / pages.length : 0,
    docs,
    N: pages.length,
    k1,
    b,
  };
}

// ─── Scoring ────────────────────────────────────────────────────────

function bm25Score(state: Bm25State, docId: string, queryTokens: string[]): number {
  const docLen = state.docLengths.get(docId) ?? 0;
  if (docLen === 0) return 0;
  const { k1, b, avgDocLength, N } = state;
  let score = 0;
  for (const qt of queryTokens) {
    const posting = state.postings.get(qt);
    if (!posting) continue;
    const tf = posting.get(docId) ?? 0;
    if (tf === 0) continue;
    const df = posting.size;
    // IDF formula: log((N - df + 0.5) / (df + 0.5) + 1) — Lucene variant,
    // always positive. Standard Robertson-Sparck-Jones can go negative
    // for very common terms, which misranks; Lucene's +1 smooths this out.
    const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
    const numerator = tf * (k1 + 1);
    const denominator = tf + k1 * (1 - b + b * (docLen / avgDocLength));
    score += idf * (numerator / denominator);
  }
  return score;
}

// ─── Candidate collection ──────────────────────────────────────────

/** Union of docs containing ANY query token — inverted index lookup. */
function candidateDocs(state: Bm25State, queryTokens: string[]): Set<string> {
  const candidates = new Set<string>();
  for (const qt of queryTokens) {
    const posting = state.postings.get(qt);
    if (!posting) continue;
    for (const docId of posting.keys()) candidates.add(docId);
  }
  return candidates;
}

// ─── Adapter implementation ────────────────────────────────────────

interface RipgrepBm25Config extends AdapterConfig {
  k1?: number;
  b?: number;
}

export class RipgrepBm25Adapter implements Adapter {
  readonly name = 'ripgrep-bm25';

  async init(rawPages: Page[], config: RipgrepBm25Config): Promise<BrainState> {
    const k1 = config.k1 ?? 1.5;
    const b = config.b ?? 0.75;
    return buildState(rawPages, k1, b);
  }

  async query(q: Query, state: BrainState): Promise<RankedDoc[]> {
    const s = state as Bm25State;
    const queryTokens = tokenize(q.text);
    if (queryTokens.length === 0) return [];

    const candidates = candidateDocs(s, queryTokens);
    const scored: { id: string; score: number }[] = [];
    for (const docId of candidates) {
      const score = bm25Score(s, docId, queryTokens);
      if (score > 0) scored.push({ id: docId, score });
    }
    // Descending by score, stable tie-break by docId for determinism.
    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

    return scored.map((s, i) => ({
      page_id: s.id,
      score: s.score,
      rank: i + 1,
    }));
  }

  async snapshot(_state: BrainState): Promise<string> {
    // BM25 state is pure-memory; no snapshot semantics needed for v1.1.
    // Future: serialize the inverted index to disk for warm-start reruns.
    return '';
  }
}

/** Convenience factory — construct with default config. */
export function createRipgrepBm25(): RipgrepBm25Adapter {
  return new RipgrepBm25Adapter();
}
