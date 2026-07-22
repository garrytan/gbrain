/**
 * NamedThingBench (T6) — the retrieval-quality eval that makes the
 * retrieval-maxpool incident impossible to reintroduce silently.
 *
 * Query families, each a distinct failure class the incident exposed:
 *   title-substring      — query is a phrase in the title (the direct regression)
 *   generic-to-named     — tourist label -> the named thing
 *   alias-synonym        — declared alias / romanization -> canonical
 *   multi-chunk-dilution — one strong chunk among many weak (stresses max-pool)
 *   short-vs-rich        — 2-word vs 8-word form of the same intent
 *   graph-relationship   — relationship query (guardrail: don't regress)
 *   hard-negative        — query that must NOT return a page (precision guard)
 *
 * Pure: the caller injects a SearchFn (CLI uses hybridSearch; tests stub it),
 * so the harness is engine-agnostic and runs identically against postgres +
 * pglite + a deterministic stub.
 */

export type Family =
  | 'title-substring'
  | 'generic-to-named'
  | 'alias-synonym'
  | 'multi-chunk-dilution'
  | 'short-vs-rich'
  | 'graph-relationship'
  | 'hard-negative';

export interface NamedThingQuestion {
  family: Family;
  query: string;
  /** slugs that SHOULD rank for this query (non-hard-negative families). */
  relevant?: string[];
  /** slugs that must NOT appear in top-k (hard-negative family). */
  forbidden?: string[];
  notes?: string;
  /**
   * v0.43 relational metadata (graph-relationship family). Optional, typed
   * (not buried in `notes`) so the relational parser/path/determinism tests
   * can machine-check the parse. `seed` is the entity the answer relates to;
   * `linkTypes` the edge(s) expected; `kind` the archetype.
   */
  seed?: string;
  linkTypes?: string[];
  kind?: 'who_rel' | 'who_at' | 'connects' | 'intro';
}

/** Ranked slugs for a query, best-first. */
export type SearchFn = (query: string) => Promise<string[]>;

export interface QuestionResult {
  family: Family;
  query: string;
  hit_at_1: boolean;
  hit_at_3: boolean;
  reciprocal_rank: number; // 0 if no relevant slug in results
  /** hard-negative only: true when NO forbidden slug appeared in top-3. */
  negative_clean?: boolean;
  /** v0.43 — fraction of relevant slugs found in top-K (K=3). 0 for hard-negative. */
  recall_at_k: number;
  /** v0.43 — fraction of relevant slugs found in top-10. The relational
   *  headline metric (a relationship query often has several valid answers). */
  recall_at_10: number;
}

export interface FamilyReport {
  family: Family;
  n: number;
  hit_at_1: number; // rate
  hit_at_3: number; // rate
  mrr: number;
  /** v0.43 — mean recall@K / recall@10 across the family's questions. */
  recall_at_k: number;
  recall_at_10: number;
}

export interface RetrievalQualityReport {
  schema_version: 1;
  k: number;
  total: number;
  families: FamilyReport[];
  questions: QuestionResult[];
}

const K = 3;

export function scoreQuestion(q: NamedThingQuestion, ranked: string[]): QuestionResult {
  if (q.family === 'hard-negative') {
    const forbidden = new Set(q.forbidden ?? []);
    const topK = ranked.slice(0, K);
    const clean = !topK.some(s => forbidden.has(s));
    return { family: q.family, query: q.query, hit_at_1: clean, hit_at_3: clean, reciprocal_rank: clean ? 1 : 0, negative_clean: clean, recall_at_k: 0, recall_at_10: 0 };
  }
  const relevant = new Set(q.relevant ?? []);
  const firstRelevantIdx = ranked.findIndex(s => relevant.has(s));
  const hit1 = firstRelevantIdx === 0;
  const hit3 = firstRelevantIdx >= 0 && firstRelevantIdx < K;
  const rr = firstRelevantIdx >= 0 ? 1 / (firstRelevantIdx + 1) : 0;
  const recallAt = (k: number): number => {
    if (relevant.size === 0) return 0;
    const top = ranked.slice(0, k);
    const found = top.filter(s => relevant.has(s)).length;
    return found / relevant.size;
  };
  return { family: q.family, query: q.query, hit_at_1: hit1, hit_at_3: hit3, reciprocal_rank: rr, recall_at_k: recallAt(K), recall_at_10: recallAt(10) };
}

export async function runRetrievalQuality(
  questions: NamedThingQuestion[],
  searchFn: SearchFn,
): Promise<RetrievalQualityReport> {
  const results: QuestionResult[] = [];
  for (const q of questions) {
    let ranked: string[] = [];
    try { ranked = await searchFn(q.query); } catch { ranked = []; }
    results.push(scoreQuestion(q, ranked));
  }
  const byFamily = new Map<Family, QuestionResult[]>();
  for (const r of results) {
    const list = byFamily.get(r.family) ?? [];
    list.push(r);
    byFamily.set(r.family, list);
  }
  const families: FamilyReport[] = [];
  for (const [family, list] of byFamily) {
    const n = list.length;
    families.push({
      family,
      n,
      hit_at_1: n ? list.filter(r => r.hit_at_1).length / n : 0,
      hit_at_3: n ? list.filter(r => r.hit_at_3).length / n : 0,
      mrr: n ? list.reduce((s, r) => s + r.reciprocal_rank, 0) / n : 0,
      recall_at_k: n ? list.reduce((s, r) => s + r.recall_at_k, 0) / n : 0,
      recall_at_10: n ? list.reduce((s, r) => s + r.recall_at_10, 0) / n : 0,
    });
  }
  families.sort((a, b) => a.family.localeCompare(b.family));
  return { schema_version: 1, k: K, total: results.length, families, questions: results };
}

// ── Gate ────────────────────────────────────────────────────────────────

export interface GateOpts {
  /** Families hard-gated from day one (the bug's families). */
  hardFamilies: Partial<Record<Family, { hit_at_1?: number; hit_at_3?: number }>>;
  /** Soft families: reported, breaches are warnings (not failures) for now. */
  softFamilies: Family[];
}

/**
 * D12 — hard-gate the two families that ARE this bug from day one
 * (title-substring Hit@1 >= 0.95, multi-chunk-dilution Hit@3 = 1.0), plus
 * alias-synonym Hit@1 >= 0.98 (Codex#13 exact numbers). Softer families
 * (generic-to-named, short-vs-rich, graph-relationship, hard-negative) are
 * warn-then-enforce until a 3x baseline noise floor is established.
 * Env-overridable like the existing replay-gate floors.
 */
export const DEFAULT_GATE: GateOpts = {
  hardFamilies: {
    'title-substring': { hit_at_1: floorEnv('GBRAIN_NTB_TITLE_HIT1', 0.95) },
    'multi-chunk-dilution': { hit_at_3: floorEnv('GBRAIN_NTB_DILUTION_HIT3', 1.0) },
    'alias-synonym': { hit_at_1: floorEnv('GBRAIN_NTB_ALIAS_HIT1', 0.98) },
  },
  softFamilies: ['generic-to-named', 'short-vs-rich', 'graph-relationship', 'hard-negative'],
};

function floorEnv(name: string, dflt: number): number {
  const v = process.env[name];
  if (v === undefined) return dflt;
  const n = parseFloat(v);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : dflt;
}

export interface GateBreach { family: Family; metric: 'hit_at_1' | 'hit_at_3'; got: number; floor: number; }
export interface GateResult { pass: boolean; breaches: GateBreach[]; warnings: GateBreach[]; }

export function evaluateGate(report: RetrievalQualityReport, opts: GateOpts = DEFAULT_GATE): GateResult {
  const byFamily = new Map(report.families.map(f => [f.family, f]));
  const breaches: GateBreach[] = [];
  for (const [family, floors] of Object.entries(opts.hardFamilies) as [Family, { hit_at_1?: number; hit_at_3?: number }][]) {
    const fr = byFamily.get(family);
    if (!fr || fr.n === 0) continue; // no questions for this family → nothing to gate
    if (floors.hit_at_1 !== undefined && fr.hit_at_1 < floors.hit_at_1) {
      breaches.push({ family, metric: 'hit_at_1', got: fr.hit_at_1, floor: floors.hit_at_1 });
    }
    if (floors.hit_at_3 !== undefined && fr.hit_at_3 < floors.hit_at_3) {
      breaches.push({ family, metric: 'hit_at_3', got: fr.hit_at_3, floor: floors.hit_at_3 });
    }
  }
  // Soft families: surface low Hit@3 as warnings (informational until enforced).
  const warnings: GateBreach[] = [];
  for (const family of opts.softFamilies) {
    const fr = byFamily.get(family);
    if (fr && fr.n > 0 && fr.hit_at_3 < 0.8) {
      warnings.push({ family, metric: 'hit_at_3', got: fr.hit_at_3, floor: 0.8 });
    }
  }
  return { pass: breaches.length === 0, breaches, warnings };
}

export function parseQuestionsJsonl(text: string): NamedThingQuestion[] {
  const out: NamedThingQuestion[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('//') || t.startsWith('#')) continue;
    const obj = JSON.parse(t) as NamedThingQuestion;
    out.push(obj);
  }
  return out;
}
