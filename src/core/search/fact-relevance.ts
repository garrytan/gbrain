/**
 * Question relevance for saved facts, shared by recall's `question` ranking
 * (src/core/facts/question-recall.ts) and the temporal fact reserve
 * (facts-arm.ts `applyTemporalFactReserve`); the `query` facts arm reads the
 * same candidate pool and keeps its own match rule.
 *
 * Candidates: one bounded pool per call under the caller's read policy
 * (source scope, active rows, audit rows excluded, quarantine and rederive
 * hiding, the trust floor, remote world-only plus the private-provenance
 * filter), optionally narrowed by recall's filters (entity pairs, session,
 * event-time since, escaped grep) inside the SQL. Three arms fill it: keyword
 * (FTS over fact text and entity), cosine (nearest by the question embedding,
 * cast to the facts column type) and the facts of the one entity page the
 * question names, constrained to that page's source. With `history` (GBRA-574
 * B1) that last arm also takes the entity's ended facts (ENDED_FACT_SQL),
 * under the same read policy.
 *
 * Score: cosine + term share + DATED_BONUS when the writer supplied the date.
 * Term share matches words on their stems under the brain's full-text config
 * (one to_tsvector read per pool, as the keyword arm matches them; whole words
 * when that read fails). ISO dates, years, auxiliaries and the config's own
 * stopwords count on neither side (GBRA-574 A4), so an as-of phrasing does not
 * dilute the share. Its denominator grows with a long fact's own term count,
 * so a fact stuffed with common words cannot match most questions. Order:
 * score, then newest valid_from, then id.
 *
 * Errors: a missing embedding column or a dimension mismatch skips the cosine
 * arm (expected on old or migrating brains); any other database error throws,
 * and each caller picks its policy.
 */
import type { BrainEngine } from '../engine.ts';
import { rethrowCapabilityRefusal } from '../engine-capability-refusal.ts';
import { getFtsLanguage } from '../fts-language.ts';
import { getEmbeddingModel } from '../ai/gateway.ts';
import { namedEntity } from './entity-anchor.ts';
import type { FactPoolScope, FactPoolFilters, RelevanceVector } from '../engine-sql/facts-trust.ts';
import { CALLED_OFF } from '../engine-sql/facts-recall.ts';
import type { HnswIterativeScanMode } from './hnsw-iterative-scan.ts';
import { RETRACTION } from './saved-facts-match.ts';
import type { SlotRow } from '../facts/slots.ts';

const STOPWORDS = new Set(['the', 'and', 'for', 'who', 'what', 'when', 'where', 'which', 'with', 'from', 'that', 'this', 'are', 'was', 'were', 'our', 'your', 'their',
  'now', 'current', 'currently', 'should', 'does', 'did', 'has', 'have', 'how', 'any', 'all', 'about', 'into', 'its', 'next', 'use', 'uses', 'tell']);
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'-]+/gu;
/** Words that frame a question's time or tense, never its subject: they count toward neither side of the term share. */
const DATE_TOKEN = /^\d{4}(-\d{2}(-\d{2})?)?$/;
const AUXILIARIES = new Set(['had', 'been', 'being', 'having', 'will', 'would', 'could', 'might', 'must', 'shall']);
const neutralWord = (w: string) => DATE_TOKEN.test(w) || AUXILIARIES.has(w);

/** A question with more content terms than this is scored on the ones its candidates hold (`heldTerms`). */
export const MAX_QUERY_TERMS = 12;
/** The content terms such a question is searched on: its last ones, where a provider puts the turn after its preamble. */
const SEARCH_TERMS = 24;
const contentTerms = (query: string) => [...new Set(query.toLowerCase().match(WORD_RE) ?? [])].filter(t => t.length >= 3 && !STOPWORDS.has(t));

/** The question's content terms: distinct words of 3+ characters, stopwords dropped, at most 12. */
export function queryTerms(query: string): string[] {
  return contentTerms(query).slice(0, MAX_QUERY_TERMS);
}

export const DATED_BONUS = 0.1;
/** What a term matched only through its stem (Rogers for Roger, lives for live) adds to the score, as a share of an exact match. */
const STEM_ONLY_WEIGHT = 0.9;
/** valid_from this far from created_at means the writer supplied the date. */
const DATED_MIN_MS = 24 * 60 * 60 * 1000;
/** A fact with more content terms than this many times the question's has its term share scaled down (term stuffing). */
export const TERM_STUFFING_RATIO = 3;

/** The two preregistered admission rules; dev picks one (`recall.question_admission`). */
export const QUESTION_ADMISSION_RULES = ['reserve', 'facts_arm'] as const;
export type QuestionAdmissionRule = (typeof QUESTION_ADMISSION_RULES)[number];
/**
 * Absolute cosine floors: a fact passes on similarity alone at or above them.
 * They are a property of the embedding model's cosine scale and no model has
 * a measured floor yet (#6590): on a high-baseline embedder an unrelated
 * question clears them, so an empty facts list stops meaning "nothing
 * matched". Doctor `fact_admission_floors` says so for the configured model.
 */
export const RESERVE_COSINE_MIN = 0.5;
const RESERVE_TERM_SHARE_MIN = 0.34;
/** The facts-arm floor; `query`'s facts arm (facts-arm.ts) and the `facts_arm` admission rule share it. */
export const FACTS_ARM_COSINE_MIN = 0.6;
/**
 * Embedding models whose admission floors an eval measured, keyed
 * `provider:model@dims` (facts/supersession-threshold.ts calibrationKey). Add
 * a row only with an eval behind it. Doctor `fact_admission_floors` and
 * recall's `facts_calibration` (#6590) read it.
 */
export const FACT_ADMISSION_FLOOR_EVIDENCE: Readonly<Record<string, string>> = {};

export type { FactPoolScope, FactPoolFilters };

export interface FactPoolOpts {
  depth: { keyword: number; cosine: number; entity: number };
  filters?: FactPoolFilters;
  /** Score every candidate's cosine, whichever arm found it (recall and the reserve); the facts arm keeps cosine-arm-only similarity. */
  cosineForAll?: boolean;
  /** Set for filtered recall pools: hnsw.ef_search sized to the depth plus pgvector's iterative scan when supported. */
  hnswIterativeScan?: HnswIterativeScanMode;
  /** Search a question over MAX_QUERY_TERMS content terms on its last SEARCH_TERMS and score it on those its candidates hold (recall). */
  distinctiveTerms?: boolean;
  /** GBRA-574 B1: the named-entity arm also pools that entity's ended facts (ENDED_FACT_SQL), the most recent first. */
  history?: boolean;
}

export interface FactCandidate {
  id: number; fact: string; kind: string; entity_slug: string | null; source_id: string; source: string;
  valid_from: Date | string; valid_until: Date | string | null; created_at?: Date | string | null; claim_metric: string | null; claim_period: string | null;
  /** The page the fact was taken from (its observation date) and the columns copies collapse on (capture-dedup.ts). */
  source_markdown_slug?: string | null; visibility?: string; attributed_to?: import('../engine.ts').FactAttribution | null;
  /** GBRA-574 B2: the fact's slot (facts/slots.ts), when it carries one. */
  dimension?: string | null; value_hash?: string | null;
  similarity?: number;
  /** Found by the named-entity arm. */
  entity: boolean;
}

export interface FactPool {
  candidates: FactCandidate[];
  /** Whether the cosine arm ran (an embedding was given and the facts column can be compared with it). */
  cosine: boolean;
  /** Whether the facts table has an embedding column (probed only when an embedding was given). */
  column: boolean;
  /** The content terms the keyword arm searched and `scoreFactCandidates` scores with. */
  terms: string[];
  /** Each question and candidate word's lexemes under the brain's full-text config (empty: a stopword); null when that read failed. */
  stems: WordStems | null;
}

/** Word to its full-text lexemes, for `scoreFactCandidates`. */
export type WordStems = Map<string, string[]>;

/** One to_tsvector read for every word: its lexemes under the brain's full-text config. Null on any database error (whole words then). */
async function wordStems(engine: BrainEngine, words: string[]): Promise<WordStems | null> {
  if (!words.length) return new Map();
  try {
    const lexemes = await engine.wordLexemes(words);
    return new Map([...lexemes].map(([w, all]) => {
      const whole = all.filter(l => l.length > 1 || l === w);
      return [w, whole.length ? whole : all];
    }));
  } catch (err) {
    rethrowCapabilityRefusal(err);
    return null;
  }
}

/** The facts embedding column's type and declared dimensions, or null when there is none. */
async function factsEmbeddingColumn(engine: BrainEngine): Promise<{ type: string; dims: number } | null> {
  const row = await engine.readFactsEmbeddingColumn();
  return row && (row.type === 'vector' || row.type === 'halfvec') ? { type: row.type, dims: Number(row.dims) } : null;
}

/**
 * GST-1304: a question of up to MAX_QUERY_TERMS content terms is scored on them all. A longer one (a provider's
 * instruction preamble ahead of the turn) is searched on its last SEARCH_TERMS and scored on the MAX_QUERY_TERMS of
 * those the fewest pooled candidates hold, the later word first on a tie, so preamble words no readable fact holds stop
 * filling the term share's denominator. The pool is already under the caller's read policy; when no candidate holds a
 * term, the first MAX_QUERY_TERMS searched.
 */
function heldTerms(searched: string[], candidates: FactCandidate[]): string[] {
  if (searched.length <= MAX_QUERY_TERMS) return searched;
  const words = candidates.map(wordsOf);
  const held = searched.map((t, i) => ({ i, n: words.filter(w => w.has(t)).length })).filter(r => r.n > 0)
    .sort((a, b) => a.n - b.n || b.i - a.i).slice(0, MAX_QUERY_TERMS);
  return held.length ? held.sort((a, b) => a.i - b.i).map(r => searched[r.i]!) : searched.slice(0, MAX_QUERY_TERMS);
}

/**
 * The bounded candidate pool for `question`. Throws on a database error
 * (callers choose fail-open or `unavailable`).
 */
export async function collectFactCandidates(engine: BrainEngine, question: string, scope: FactPoolScope, queryEmbedding: Float32Array | null | undefined,
  opts: FactPoolOpts): Promise<FactPool> {
  const all = contentTerms(question);
  const searched = opts.distinctiveTerms && all.length > MAX_QUERY_TERMS ? all.slice(-SEARCH_TERMS) : all.slice(0, MAX_QUERY_TERMS);
  const column = queryEmbedding?.length ? await factsEmbeddingColumn(engine) : null;
  const cosine = !!column && (column.dims <= 0 || column.dims === queryEmbedding!.length);
  const vec = cosine ? { lit: `[${Array.from(queryEmbedding!).join(',')}]`, type: column!.type === 'halfvec' ? 'halfvec' as const : 'vector' as const } : null;
  const allSim = vec && opts.cosineForAll;
  const found = new Map<number, FactCandidate>();
  const add = (rows: Array<FactCandidate & { similarity?: number | null }>, entity = false) => {
    for (const r of rows) {
      const prev = found.get(Number(r.id));
      const sim = r.similarity === null || r.similarity === undefined ? prev?.similarity : Number(r.similarity);
      found.set(Number(r.id), { ...r, id: Number(r.id), similarity: sim, entity: entity || !!prev?.entity });
    }
  };

  type Row = FactCandidate & { similarity?: number | null };
  const vector: RelevanceVector | null = allSim ? { literal: vec!.lit, type: vec!.type, model: getEmbeddingModel(), dims: queryEmbedding!.length } : null;
  const keyword = async (): Promise<Row[]> => {
    if (!searched.length) return [];
    return engine.listFactsForRelevance({ arm: 'keyword', scope, filters: opts.filters, vector, terms: searched.join(' '), limit: opts.depth.keyword }) as Promise<Row[]>;
  };
  const nearest = async (): Promise<Row[]> => {
    if (!vec) return [];
    return engine.listNearestFacts({ scope, filters: opts.filters, vector: { literal: vec.lit, type: vec.type, model: getEmbeddingModel(), dims: queryEmbedding!.length },
      declared: column!.dims > 0, limit: opts.depth.cosine, hnswIterativeScan: opts.hnswIterativeScan });
  };
  const entityFacts = async (): Promise<Row[]> => {
    const sourceIds = scope.sourceIds?.length ? scope.sourceIds : [scope.sourceId ?? 'default'];
    const named = await namedEntity(engine, question, { sourceIds, excludePrivate: scope.excludePrivate });
    if (!named) return [];
    const read = (arm: 'entity' | 'entity_ended') => engine.listFactsForRelevance({ arm, scope, filters: opts.filters, vector,
      entity: { sourceId: named.source_id, slug: named.slug }, limit: opts.depth.entity }) as Promise<Row[]>;
    const active = await read('entity');
    if (!opts.history) return active;
    return [...active, ...await read('entity_ended')];
  };
  // Independent arms run concurrently (separate connections on Postgres); merged in a fixed order.
  const [byKeyword, byCosine, byEntity] = await Promise.all([keyword(), nearest(), entityFacts()]);
  add(byKeyword);
  add(byCosine);
  add(byEntity, true);
  const candidates = [...found.values()];
  const terms = heldTerms(searched, candidates);
  const stems = await wordStems(engine, [...new Set([...terms, ...candidates.flatMap(c => [...wordsOf(c)])])].filter(w => !neutralWord(w)));
  return { candidates, cosine, column: !!column, terms, stems };
}

/**
 * Facts in the same authorized, filtered pool that the cosine arm cannot
 * compare (no vector, another model, a stale text hash or other
 * dimensions), per source. Only meaningful when an embedding was compared.
 */
export async function countUncomparableFacts(engine: BrainEngine, scope: FactPoolScope, filters: FactPoolFilters | undefined, dims: number): Promise<Array<{ source_id: string; n: number }>> {
  const column = await factsEmbeddingColumn(engine);
  if (!column) return [];
  return engine.countUncomparableFacts({ scope, filters, dims, model: getEmbeddingModel(), declared: column.dims === dims });
}

/**
 * GBRA-574 B2: every active conversation slot row (dim_status active; ontology observations never shape a window) of the given (source, entity, dimension) slots under exactly
 * the pool's read policy, so a row the caller cannot see never shapes a window the caller sees; ordered by valid_from, id.
 * A row whose stored valid_until has passed still ends the value before it; withdrawn and superseded rows never do.
 */
export async function readSlotRows(engine: BrainEngine, scope: FactPoolScope, slots: ReadonlyArray<{ source_id: string; entity_slug: string; dimension: string }>): Promise<Array<SlotRow & Omit<FactCandidate, 'entity'>>> {
  if (!slots.length) return [];
  return engine.listSlotRows(scope, slots);
}

/**
 * GBRA-574 F (D1): the distinct (source_id, entity_slug) pairs among `keys` that hold an active fact in the pool under
 * its read policy and have no live page at that slug (an unbacked name key), at most `limit`, by source then slug.
 */
export async function poolUnbackedKeys(engine: BrainEngine, scope: FactPoolScope, keys: readonly string[], limit: number): Promise<Array<{ source_id: string; entity_slug: string }>> {
  if (!keys.length) return [];
  return engine.listPoolUnbackedKeys(scope, keys, limit);
}

/** GBRA-574 B5: what marks a later fact as calling an earlier one off: saved-facts-match.ts's RETRACTION plus plain cancellation words (`CALLED_OFF`, engine-sql/facts-recall.ts). Fixed, never configurable. */
const CALL_OFF_WORDS = new RegExp(String.raw`\b(${RETRACTION}|${CALLED_OFF})\b`, 'gi');
/** A cue a word or two after one of these is negated ("not cancelled", "wasn't called off", "isn't a rumour"). Fixed, never configurable. */
const NEGATED = /(?:^|[^\p{L}\p{N}'’])(?:not|never|no|[\p{L}]+n['’]t)\s+(?:[\p{L}\p{N}'’-]+\s+)?$/iu;

/**
 * GBRA-574 B5: for each fact, the later facts that retract it or call it off, oldest first. One read of the cue facts
 * about the facts' entities, the newest CALL_OFF_DEPTH per entity, under exactly the pool's read policy (active rows
 * only, so a withdrawn, forgotten or superseded fact never comes back, nor one the caller cannot read). A cue fact
 * answers a fact when it is about the same entity in the same source, is dated strictly after it, carries a cue no
 * negation sits a word or two before (NEGATED; a cue that starts with one, "not happening", still counts), and either
 * carries the same slot (dimension and value_hash) or, on content terms other than the entity's name and the cue words,
 * has all of its terms (at least one) in the fact or shares at least two with it.
 */
export async function laterRetractions(engine: BrainEngine, scope: FactPoolScope, facts: readonly FactCandidate[]): Promise<Map<number, FactCandidate[]>> {
  const out = new Map<number, FactCandidate[]>();
  const keyed = facts.filter(f => f.entity_slug);
  if (!keyed.length) return out;
  const pairs = [...new Map(keyed.map(f => [`${f.source_id}\u0000${f.entity_slug}`, f])).values()];
  const cues = await engine.listCallOffCueFacts(scope, pairs.map(f => ({ source_id: f.source_id, entity_slug: f.entity_slug! })));
  const time = (v: Date | string) => new Date(v).getTime();
  const calledOff = (text: string) => [...text.matchAll(CALL_OFF_WORDS)].some(m => !NEGATED.test(text.slice(0, m.index)));
  const terms = (slug: string, text: string) => {
    const name = new Set(slug.toLowerCase().split(/[^\p{L}\p{N}]+/u));
    return new Set(contentTerms(text).flatMap(w => w.replace(/'s$/, '').split('-')).filter(w => w.length >= 3 && !STOPWORDS.has(w) && !neutralWord(w) && !name.has(w)));
  };
  for (const f of keyed) {
    const own = terms(f.entity_slug!, f.fact);
    const answers = cues.filter(r => {
      if (r.source_id !== f.source_id || r.entity_slug !== f.entity_slug || time(r.valid_from) <= time(f.valid_from) || !calledOff(r.fact)) return false;
      if (f.dimension && f.value_hash && r.dimension === f.dimension && r.value_hash === f.value_hash) return true;
      const theirs = [...terms(f.entity_slug!, r.fact.replace(CALL_OFF_WORDS, ' '))];
      const shared = theirs.filter(t => own.has(t)).length;
      return shared >= 2 || (theirs.length > 0 && shared === theirs.length);
    })
      .map(r => ({ ...r, id: Number(r.id), entity: false }))
      .sort((a, b) => time(a.valid_from) - time(b.valid_from) || a.id - b.id);
    if (answers.length) out.set(Number(f.id), answers);
  }
  return out;
}

/** The distinct (source_id, entity_slug) pairs with a fact in the authorized, filtered pool (the namesake check runs on these before any ranking). */
export async function poolEntityPairs(engine: BrainEngine, scope: FactPoolScope, filters: FactPoolFilters): Promise<Array<{ source_id: string; entity_slug: string }>> {
  return engine.listPoolEntityPairs(scope, filters);
}

export interface ScoredFact {
  candidate: FactCandidate;
  cosine: number;
  /** Whole-word content terms of the question the fact holds. */
  matched: number;
  /** The question's content-term count. */
  terms: number;
  termShare: number;
  score: number;
}

const wordsOf = (c: FactCandidate) => {
  const slug = c.entity_slug ?? '';
  return new Set(`${c.fact} ${slug} ${slug.replace(/-/g, ' ')}`.toLowerCase().match(WORD_RE) ?? []);
};

export const isDatedFact = (f: Pick<FactCandidate, 'valid_from' | 'created_at'>) =>
  !!f.created_at && Math.abs(new Date(f.valid_from).getTime() - new Date(f.created_at).getTime()) > DATED_MIN_MS;

/**
 * Score every candidate (cosine + term share + DATED_BONUS when dated), ordered by score, newest valid_from, then id.
 * With `stems` (the pool's) a term matches a fact word sharing a lexeme, and a word with none is a stopword; dates,
 * years and auxiliaries count on neither side. A stem-only match adds STEM_ONLY_WEIGHT of an exact one to the score
 * (never to termShare, which admission reads), so "Roger" ranks the Roger fact above the Rogers one.
 */
export function scoreFactCandidates(question: string, candidates: FactCandidate[], terms = queryTerms(question), stems: WordStems | null = null): ScoredFact[] {
  const lexemes = (w: string) => stems?.get(w) ?? [w];
  const counted = (w: string) => w.length >= 3 && !STOPWORDS.has(w) && !neutralWord(w) && lexemes(w).length > 0;
  const asked = terms.filter(counted);
  return candidates.map(c => {
    const words = [...wordsOf(c)].filter(counted);
    const held = new Set(words.flatMap(lexemes));
    const hits = asked.filter(t => lexemes(t).some(l => held.has(l)));
    const exact = hits.filter(t => words.includes(t)).length;
    const denominator = Math.max(asked.length, Math.ceil(words.length / TERM_STUFFING_RATIO));
    const termShare = asked.length ? hits.length / denominator : 0;
    const scoredShare = asked.length ? (exact + STEM_ONLY_WEIGHT * (hits.length - exact)) / denominator : 0;
    const cosine = c.similarity ?? 0;
    return { candidate: c, cosine, matched: hits.length, terms: asked.length, termShare, score: cosine + scoredShare + (isDatedFact(c) ? DATED_BONUS : 0) };
  }).sort((a, b) => b.score - a.score
    || new Date(b.candidate.valid_from).getTime() - new Date(a.candidate.valid_from).getTime()
    || b.candidate.id - a.candidate.id);
}

/** Whether a scored fact passes the admission rule. */
export function admitted(s: ScoredFact, rule: QuestionAdmissionRule): boolean {
  if (rule === 'reserve') return s.cosine >= RESERVE_COSINE_MIN || s.termShare >= RESERVE_TERM_SHARE_MIN;
  return s.candidate.entity || s.cosine >= FACTS_ARM_COSINE_MIN
    || (s.terms > 0 && s.matched >= Math.max(Math.min(2, s.terms), Math.ceil(s.terms / 2)));
}
