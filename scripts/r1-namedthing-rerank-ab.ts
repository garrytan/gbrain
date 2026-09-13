#!/usr/bin/env bun
/**
 * r1-namedthing-rerank-ab.ts — Phase C′ (rule R1): balanced reranker ON vs OFF
 * on NamedThingBench, paired per query, inside ONE in-memory PGLite brain.
 *
 * Rule R1 (TODOS.md:1635-1642): balanced stays ON iff rerank-ON vs OFF shows no
 * net per-query regression on NamedThingBench hit@1 / hit@3 / create_safety —
 * 0 hit@1 losses, ≤ 1 hit@3 loss. (cat13b + world-v1 live in the sibling evals
 * repo and are folded in by the orchestrator, not here.)
 *
 * INVARIANTS
 *   - ONE brain, seeded ONCE with real embeddings; both arms search the same
 *     rows. With --embed-cache both arms also see byte-identical QUERY vectors
 *     (the OFF arm fills the cache, the ON arm hits it), so the paired delta is
 *     the reranker and nothing else — the receipt says whether that held.
 *   - Arms are applied through `engine.setConfig` — the plane `gbrain config
 *     set` writes — so bare `hybridSearch` resolves them exactly as a production
 *     balanced brain would (mode resolution lives in bare hybridSearch, which
 *     never touches the semantic query cache). Autocut is pinned OFF in both
 *     arms: this comparison is rerank-only (Phase C owns autocut).
 *   - The ON arm FAILS LOUDLY (exit 2) instead of silently becoming OFF:
 *     reranker readiness is checked BEFORE any spend, and after the run every
 *     ON query must carry finite `rerank_score` rows and no `reranker_skipped`
 *     / `rerank_passthrough` degraded stage. Embedding-side degradation
 *     (`embed_unavailable` / `embed_timeout` / `vector_arm_failed`) in either
 *     live arm is an integrity failure too — it would silently turn "balanced"
 *     into "keyword-only".
 *   - Verdict: a LOSS is a query the OFF arm hit and the ON arm missed. Losses
 *     are NOT offset by wins (the strict reading of "no net per-query
 *     regression"); wins and net are reported alongside. create_safety
 *     downgrades of the top result are reported per query and counted, but the
 *     rule quantifies only hit@1 / hit@3, so they do not flip the verdict.
 *
 * Usage:
 *   bun run scripts/r1-namedthing-rerank-ab.ts [--json] [--out receipt.json]
 *       [--embed-cache PATH] [--relational] [--limit 10] [--stub-embed]
 *       [--autocut on|off] [--relational-pin N|off] [--search-pin search.KEY=VALUE]...
 *
 *   --stub-embed   hermetic dry run: the embed transport throws (the CI gate's
 *                  stub) so search takes the keyword + title + alias path; ONLY
 *                  the OFF arm runs and the ON arm is reported as skipped
 *                  (it needs VOYAGE_API_KEY + real embeddings).
 *   --relational   also seed the relational corpus and run its 42
 *                  graph-relationship questions (typed-edge arm; cheap).
 *   --autocut / --relational-pin / --search-pin
 *                  config overlays applied to BOTH arms on top of ARM_PINS, so
 *                  the operator can run the pair in the exact shipped shape.
 *                  Precedence (buildOverlay): ARM_PINS < --search-pin < the
 *                  explicit --autocut / --relational-pin flags — a generic
 *                  `--search-pin search.autocut=false` never silently overrides
 *                  an explicit `--autocut on` (the named flag is the more
 *                  specific statement of intent).
 *                  `search.reranker.*` is RESERVED and refused (exit 2): the
 *                  reranker is the arm axis — an overlay there would either run
 *                  the ON arm on a model other than the one whose readiness was
 *                  checked and that the receipt reports (R1_ON_RERANKER_MODEL),
 *                  or silently turn ON into OFF.
 *
 * Exit: 0 R1 PASS (or stub dry run) · 1 R1 FAIL · 2 integrity / usage.
 */

import { writeFileSync } from 'node:fs';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { DegradedStageEntry, HybridSearchMeta, SearchResult } from '../src/core/types.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';
import {
  __setEmbedTransportForTests,
  __setRerankTransportForTests,
  configureGateway,
  embed,
  getEmbeddingDimensions,
  getEmbeddingModel,
} from '../src/core/ai/gateway.ts';
import { buildGatewayConfig } from '../src/core/ai/build-gateway-config.ts';
import { loadConfig, type GBrainConfig } from '../src/core/config.ts';
import { rerankerReadinessForEngine } from '../src/core/ai/reranker-readiness-engine.ts';
import { describeRerankerFix, type RerankerReadiness } from '../src/core/ai/reranker-readiness.ts';
import { EmbeddingCache, installEmbedCache, type EmbedCacheStats, type InstalledEmbedCache } from '../src/eval/shared/embed-cache.ts';
import { buildMetricGlossaryMeta } from '../src/core/eval/metric-glossary.ts';
import { estimateCostFromChars, lookupEmbeddingPrice } from '../src/core/embedding-pricing.ts';
import { dedupeRankedKeys } from '../src/core/eval/ranked-docs.ts';
import {
  evaluateGate,
  runRetrievalQuality,
  type FamilyReport,
  type GateResult,
  type NamedThingQuestion,
  type RetrievalQualityReport,
} from '../src/eval/retrieval-quality/harness.ts';
import {
  loadNamedThingQuestions,
  seedNamedThingCorpus,
  NAMEDTHING_FIXTURE_PATH,
} from '../test/fixtures/retrieval-quality/namedthing/corpus.ts';
import { RELATIONAL_QUESTIONS, seedRelationalCorpus } from '../test/fixtures/retrieval-quality/relational/corpus.ts';

// ── Pins ─────────────────────────────────────────────────────────────────────

/** The model rule R1 decides about (the v0.48.2.0 bundle default). */
export const R1_ON_RERANKER_MODEL = 'voyage:rerank-2.5';

export type ArmId = 'off' | 'on';

/**
 * Config pins per arm, written with `engine.setConfig` (the `gbrain config set`
 * plane). Run OFF first, then ON: the ON pins are a superset, so the brain ends
 * the run in the shipped balanced default.
 */
export const ARM_PINS: Readonly<Record<ArmId, Readonly<Record<string, string>>>> = Object.freeze({
  off: Object.freeze({
    'search.mode': 'balanced',
    'search.reranker.enabled': 'false',
    'search.autocut': 'false',
  }),
  on: Object.freeze({
    'search.mode': 'balanced',
    'search.reranker.enabled': 'true',
    'search.reranker.model': R1_ON_RERANKER_MODEL,
    'search.autocut': 'false',
  }),
});

export async function applyArmPins(
  engine: Pick<BrainEngine, 'setConfig'>,
  arm: ArmId,
  overlay: Readonly<Record<string, string>> = {},
): Promise<void> {
  // `overlay` lets the operator run the ON arm in the exact shipped shape
  // (e.g. --autocut on) without changing the pinned defaults the tests pin.
  for (const [k, v] of Object.entries({ ...ARM_PINS[arm], ...overlay })) await engine.setConfig(k, v);
}

/** Every metric printed here routes through the shared glossary ([CDX-25]). */
export const R1_GLOSSARY_KEYS = ['hit@1', 'hit@3', 'mrr', 'create_safety'] as const;

// ── Per-arm run ──────────────────────────────────────────────────────────────

export interface TopEvidence {
  slug: string;
  evidence: string | null;
  create_safety: string | null;
  rerank_score: number | null;
}

export interface QueryRecord {
  query: string;
  family: string;
  /** Raw ranked slugs (chunk rows, as the harness receives them; it dedupes). */
  slugs: string[];
  /** Deduped top-3 pages for the paired table. */
  top3: string[];
  /** The rank-1 result's evidence tier (`create_safety` per query). */
  top: TopEvidence | null;
  /** Rows carrying a finite `rerank_score` — proof the reranker actually ran. */
  reranked_rows: number;
  degraded: DegradedStageEntry[];
  hit_at_1: boolean;
  hit_at_3: boolean;
  /** Set when hybridSearch threw (the harness would score it as a miss). */
  error?: string;
}

export interface ArmRun {
  arm: ArmId;
  records: QueryRecord[];
  report: RetrievalQualityReport;
  gate: GateResult;
}

/**
 * Run one arm: every question through bare `hybridSearch` at the brain's
 * CURRENT config (the caller applied the pins), capturing results + meta, then
 * score with the same `runRetrievalQuality` the CI gate and
 * `gbrain eval retrieval-quality` use — no local re-implementation of hit@k.
 */
export async function runArm(
  engine: BrainEngine,
  arm: ArmId,
  questions: NamedThingQuestion[],
  opts: { sourceId?: string; limit?: number } = {},
): Promise<ArmRun> {
  const limit = opts.limit ?? 10;
  const sourceId = opts.sourceId ?? 'default';
  const captured: Array<{ results: SearchResult[]; meta: HybridSearchMeta | null; error?: string }> = [];
  for (const q of questions) {
    let meta: HybridSearchMeta | null = null;
    try {
      const results = await hybridSearch(engine, q.query, { limit, sourceId, onMeta: (m) => { meta = m; } });
      captured.push({ results, meta });
    } catch (err) {
      captured.push({ results: [], meta, error: err instanceof Error ? err.message : String(err) });
    }
  }
  // The harness walks `questions` in order, one await per question — an index
  // cursor (not a query-keyed map) keeps duplicate query strings distinct.
  let cursor = 0;
  const report = await runRetrievalQuality(questions, async () => captured[cursor++]?.results.map(r => r.slug) ?? []);
  const gate = evaluateGate(report);
  const records: QueryRecord[] = questions.map((q, i) => {
    const c = captured[i];
    const scored = report.questions[i];
    const slugs = c.results.map(r => r.slug);
    const first = c.results[0];
    return {
      query: q.query,
      family: q.family,
      slugs,
      top3: dedupeRankedKeys(slugs).slice(0, 3),
      top: first
        ? {
            slug: first.slug,
            evidence: first.evidence ?? null,
            create_safety: first.create_safety ?? null,
            rerank_score: typeof first.rerank_score === 'number' && Number.isFinite(first.rerank_score) ? first.rerank_score : null,
          }
        : null,
      reranked_rows: c.results.filter(r => typeof r.rerank_score === 'number' && Number.isFinite(r.rerank_score)).length,
      degraded: c.meta?.degraded ? [...c.meta.degraded] : [],
      hit_at_1: scored.hit_at_1,
      hit_at_3: scored.hit_at_3,
      ...(c.error ? { error: c.error } : {}),
    };
  });
  return { arm, records, report, gate };
}

// ── Pairing + verdict (pure) ─────────────────────────────────────────────────

export interface ArmCell {
  top3: string[];
  hit_at_1: boolean;
  hit_at_3: boolean;
  evidence: string | null;
  create_safety: string | null;
}

export interface PairedRow {
  query: string;
  family: string;
  off: ArmCell;
  on: ArmCell;
}

function cellOf(r: QueryRecord): ArmCell {
  return { top3: r.top3, hit_at_1: r.hit_at_1, hit_at_3: r.hit_at_3, evidence: r.top?.evidence ?? null, create_safety: r.top?.create_safety ?? null };
}

/** Zip the two arms query-by-query; refuses mismatched question sets. */
export function pairArms(off: ArmRun, on: ArmRun): PairedRow[] {
  if (off.records.length !== on.records.length) {
    throw new Error(`pairArms: OFF ran ${off.records.length} queries, ON ran ${on.records.length}`);
  }
  return off.records.map((o, i) => {
    const n = on.records[i];
    if (n.query !== o.query) throw new Error(`pairArms: query mismatch at ${i}: OFF "${o.query}" vs ON "${n.query}"`);
    return { query: o.query, family: o.family, off: cellOf(o), on: cellOf(n) };
  });
}

/** Minimal input the verdict needs — `PairedRow` satisfies it structurally. */
export interface VerdictRow {
  query: string;
  off: { hit_at_1: boolean; hit_at_3: boolean; create_safety?: string | null };
  on: { hit_at_1: boolean; hit_at_3: boolean; create_safety?: string | null };
}

export interface MetricDelta {
  wins: number;
  losses: number;
  /** wins − losses (reported; the verdict uses raw losses). */
  net: number;
  lost_queries: string[];
  won_queries: string[];
}

export interface R1Verdict {
  pass: boolean;
  n: number;
  hit_at_1: MetricDelta;
  hit_at_3: MetricDelta;
  create_safety: { downgrades: number; upgrades: number; downgraded_queries: string[] };
  rule: string;
  reasons: string[];
}

export const R1_RULE =
  'balanced reranker stays ON iff, paired per query (ON vs OFF), hit@1 losses == 0 and hit@3 losses <= 1; ' +
  'create_safety downgrades are reported, not gated (TODOS.md:1635-1642).';

const SAFETY_RANK: Record<string, number> = { exists: 2, probable: 1, unknown: 0 };

function delta(rows: readonly VerdictRow[], metric: 'hit_at_1' | 'hit_at_3'): MetricDelta {
  const lost = rows.filter(r => r.off[metric] && !r.on[metric]).map(r => r.query);
  const won = rows.filter(r => !r.off[metric] && r.on[metric]).map(r => r.query);
  return { wins: won.length, losses: lost.length, net: won.length - lost.length, lost_queries: lost, won_queries: won };
}

/** Pure: PASS iff hit@1 losses == 0 AND hit@3 losses <= 1 (losses never offset by wins). */
export function r1Verdict(rows: readonly VerdictRow[]): R1Verdict {
  const hit1 = delta(rows, 'hit_at_1');
  const hit3 = delta(rows, 'hit_at_3');
  const downgraded: string[] = [];
  let upgrades = 0;
  for (const r of rows) {
    const a = SAFETY_RANK[r.off.create_safety ?? ''];
    const b = SAFETY_RANK[r.on.create_safety ?? ''];
    if (a === undefined || b === undefined) continue; // unknown tier label or no top result — not comparable
    if (b < a) downgraded.push(r.query);
    else if (b > a) upgrades++;
  }
  const reasons: string[] = [];
  if (hit1.losses > 0) reasons.push(`hit@1 losses ${hit1.losses} > 0: ${hit1.lost_queries.join('; ')}`);
  if (hit3.losses > 1) reasons.push(`hit@3 losses ${hit3.losses} > 1: ${hit3.lost_queries.join('; ')}`);
  return {
    pass: reasons.length === 0,
    n: rows.length,
    hit_at_1: hit1,
    hit_at_3: hit3,
    create_safety: { downgrades: downgraded.length, upgrades, downgraded_queries: downgraded },
    rule: R1_RULE,
    reasons,
  };
}

// ── Integrity (fail loudly, never fail open) ─────────────────────────────────

const RERANK_STAGES = new Set<string>(['reranker_skipped', 'rerank_passthrough']);
const EMBED_STAGES = new Set<string>(['embed_unavailable', 'embed_timeout', 'vector_arm_failed']);

/**
 * Problems that mean the ON arm was not actually reranked (fail-open would
 * silently turn ON into OFF and print a vacuous PASS).
 */
export function onArmIntegrityProblems(run: ArmRun, readiness: RerankerReadiness | null): string[] {
  const problems: string[] = [];
  if (!readiness) problems.push('reranker readiness was not evaluated');
  else if (!readiness.ready) problems.push(`reranker ${readiness.model} not ready: ${describeRerankerFix(readiness) ?? 'unknown reason'}`);
  for (const r of run.records) {
    if (r.error) problems.push(`ON "${r.query}": hybridSearch threw: ${r.error}`);
    for (const d of r.degraded) {
      if (RERANK_STAGES.has(d.stage)) problems.push(`ON "${r.query}": degraded ${d.stage}${d.reason ? ` (${d.reason})` : ''}`);
    }
    if (r.slugs.length > 0 && r.reranked_rows === 0 && !r.error) {
      problems.push(`ON "${r.query}": ${r.slugs.length} result(s) but no row carries a rerank_score — reranker did not run`);
    }
  }
  return problems;
}

/** Live-arm embedding degradation: "balanced" silently became keyword-only. */
export function embedIntegrityProblems(run: ArmRun): string[] {
  const problems: string[] = [];
  for (const r of run.records) {
    if (r.error) problems.push(`${run.arm.toUpperCase()} "${r.query}": hybridSearch threw: ${r.error}`);
    for (const d of r.degraded) {
      if (EMBED_STAGES.has(d.stage)) problems.push(`${run.arm.toUpperCase()} "${r.query}": degraded ${d.stage}${d.reason ? ` (${d.reason})` : ''}`);
    }
  }
  return problems;
}

// ── Rendering ────────────────────────────────────────────────────────────────

export interface RerankerTelemetry {
  configured: string;
  /** Model id the API echoed in its response body (Voyage returns `model`). */
  api_model: string | null;
  calls: number;
  request_chars: number;
  usage_tokens: number | null;
}

export interface R1Payload {
  schema_version: 1;
  benchmark: 'namedthing';
  mode: 'live' | 'stub-embed';
  fixtures: string[];
  questions: number;
  embedder: string | null;
  reranker: RerankerTelemetry | null;
  reranker_readiness: { plane: string; readiness: RerankerReadiness } | null;
  embed_cache: (EmbedCacheStats & { canonical_sha256: string }) | null;
  /** True iff both arms provably saw the same query vectors (cache installed, ON arm had 0 misses). */
  identical_query_vectors: boolean | null;
  pins: typeof ARM_PINS;
  arms: { off: ArmRun; on: ArmRun | null };
  on_skipped: string | null;
  paired: PairedRow[] | null;
  verdict: R1Verdict | null;
  spend_estimate_usd: { embedding: number | null; rerank: number | null; total: number | null; note: string };
  _meta: { metric_glossary: Record<string, string> };
}

const pct = (x: number): string => `${(100 * x).toFixed(0)}%`;
const yn = (b: boolean): string => (b ? 'Y' : 'n');
const arrow = (a: boolean, b: boolean): string => (a === b ? yn(a) : `${yn(a)}→${yn(b)}`);
const safety = (a: string | null, b: string | null): string => (a === b ? a ?? '—' : `${a ?? '—'}→${b ?? '—'}`);
const esc = (s: string): string => s.replace(/\|/g, '\\|');

export function renderMarkdown(p: R1Payload): string {
  const out: string[] = [];
  out.push(`# R1 — NamedThingBench: balanced reranker ON vs OFF (${p.mode})`);
  out.push('');
  out.push(`brain: in-memory PGLite · embedder: ${p.embedder ?? '(stub — embed transport throws; keyword + title + alias path)'} · questions: ${p.questions}`);
  out.push(
    `reranker (ON arm): ${p.reranker?.configured ?? R1_ON_RERANKER_MODEL}` +
      (p.reranker ? ` · api model: ${p.reranker.api_model ?? 'not echoed'} · calls: ${p.reranker.calls}` : '') +
      ` · autocut: ${p.pins?.on?.['search.autocut'] === 'true' ? 'on' : 'off'} (both arms)` +
      (p.pins?.on?.['search.relational_rerank_pin'] !== undefined ? ` · relational pin: ${p.pins.on['search.relational_rerank_pin']} (both arms)` : ''),
  );
  if (p.embed_cache) {
    out.push(`embed cache: ${p.embed_cache.path} hits=${p.embed_cache.hits} misses=${p.embed_cache.misses} infra_faults=${p.embed_cache.infra_faults} · identical query vectors across arms: ${p.identical_query_vectors ? 'yes' : 'NOT PROVEN'}`);
  } else if (p.mode === 'live') {
    out.push('embed cache: none (query vectors re-embedded per arm; pass --embed-cache PATH to pin them)');
  }
  out.push('');
  out.push('## per-family');
  out.push('');
  const on = p.arms.on;
  if (on) {
    out.push('| family | n | hit@1 OFF | hit@1 ON | hit@3 OFF | hit@3 ON | MRR OFF | MRR ON |');
    out.push('|---|---|---|---|---|---|---|---|');
    const onBy = new Map(on.report.families.map(f => [f.family, f]));
    for (const f of p.arms.off.report.families) {
      const g: FamilyReport | undefined = onBy.get(f.family);
      out.push(`| ${f.family} | ${f.n} | ${pct(f.hit_at_1)} | ${g ? pct(g.hit_at_1) : '—'} | ${pct(f.hit_at_3)} | ${g ? pct(g.hit_at_3) : '—'} | ${f.mrr.toFixed(3)} | ${g ? g.mrr.toFixed(3) : '—'} |`);
    }
  } else {
    out.push('| family | n | hit@1 OFF | hit@3 OFF | MRR OFF |');
    out.push('|---|---|---|---|---|');
    for (const f of p.arms.off.report.families) {
      out.push(`| ${f.family} | ${f.n} | ${pct(f.hit_at_1)} | ${pct(f.hit_at_3)} | ${f.mrr.toFixed(3)} |`);
    }
  }
  out.push('');
  out.push(`OFF gate (CI floors): ${p.arms.off.gate.pass ? 'PASS' : 'FAIL'}${on ? ` · ON gate: ${on.gate.pass ? 'PASS' : 'FAIL'}` : ''}`);
  out.push('');
  out.push('## paired per-query');
  out.push('');
  if (p.paired) {
    out.push('| # | family | query | OFF top-3 | ON top-3 | hit@1 OFF→ON | hit@3 OFF→ON | create_safety OFF→ON |');
    out.push('|---|---|---|---|---|---|---|---|');
    p.paired.forEach((r, i) => {
      out.push(
        `| ${i + 1} | ${r.family} | ${esc(r.query)} | ${r.off.top3.join(', ') || '—'} | ${r.on.top3.join(', ') || '—'} | ` +
          `${arrow(r.off.hit_at_1, r.on.hit_at_1)} | ${arrow(r.off.hit_at_3, r.on.hit_at_3)} | ${safety(r.off.create_safety, r.on.create_safety)} |`,
      );
    });
  } else {
    out.push('| # | family | query | OFF top-3 | hit@1 | hit@3 | create_safety | degraded |');
    out.push('|---|---|---|---|---|---|---|---|');
    p.arms.off.records.forEach((r, i) => {
      out.push(
        `| ${i + 1} | ${r.family} | ${esc(r.query)} | ${r.top3.join(', ') || '—'} | ${yn(r.hit_at_1)} | ${yn(r.hit_at_3)} | ${r.top?.create_safety ?? '—'} | ${r.degraded.map(d => d.stage).join(',') || '—'} |`,
      );
    });
  }
  out.push('');
  out.push('## verdict');
  out.push('');
  if (p.verdict) {
    const v = p.verdict;
    out.push(`R1: **${v.pass ? 'PASS' : 'FAIL'}** — hit@1 losses ${v.hit_at_1.losses} (wins ${v.hit_at_1.wins}, net ${v.hit_at_1.net >= 0 ? '+' : ''}${v.hit_at_1.net}) · hit@3 losses ${v.hit_at_3.losses} (wins ${v.hit_at_3.wins}, net ${v.hit_at_3.net >= 0 ? '+' : ''}${v.hit_at_3.net}) · create_safety downgrades ${v.create_safety.downgrades} (upgrades ${v.create_safety.upgrades})`);
    for (const r of v.reasons) out.push(`  - ${r}`);
    for (const q of v.create_safety.downgraded_queries) out.push(`  - create_safety downgraded (reported, not gated): ${q}`);
    out.push('');
    out.push(`rule: ${v.rule}`);
  } else {
    out.push(`R1: **NOT DECIDED** — ${p.on_skipped ?? 'ON arm did not run'}`);
  }
  out.push('');
  const s = p.spend_estimate_usd;
  out.push(`spend estimate: ${s.total === null ? 'n/a' : `$${s.total.toFixed(4)}`} (embedding ${s.embedding === null ? 'n/a' : `$${s.embedding.toFixed(4)}`}, rerank ${s.rerank === null ? 'n/a' : `$${s.rerank.toFixed(4)}`}) — ${s.note}`);
  out.push('');
  out.push('Glossary:');
  for (const [k, v] of Object.entries(p._meta.metric_glossary)) out.push(`  ${k}: ${v}`);
  return out.join('\n') + '\n';
}

// ── CLI ──────────────────────────────────────────────────────────────────────

interface Args {
  /** --autocut on|off — overlays search.autocut on BOTH arms (default off = the pinned ARM_PINS). */
  autocut?: 'on' | 'off';
  /** --relational-pin N|off — overlays search.relational_rerank_pin on BOTH arms (default: gbrain's bundle default). */
  relationalPin?: string;
  /** --search-pin KEY=VALUE (repeatable) — arbitrary search.* overlay on BOTH arms; `search.reranker.*` refused (see SEARCH_PIN_RESERVED). */
  searchPins?: Record<string, string>;
  json: boolean;
  out?: string;
  embedCache?: string;
  relational: boolean;
  limit: number;
  stubEmbed: boolean;
}

/**
 * `--search-pin` keys the script refuses: the overlay lands on BOTH arms, and
 * `search.reranker.*` is exactly what the two arms differ on. Exported so the
 * test pins the reservation alongside the pins themselves.
 */
export const SEARCH_PIN_RESERVED = /^search\.reranker(\.|$)/;

function usage(code: number): never {
  process.stderr.write(
    'usage: bun run scripts/r1-namedthing-rerank-ab.ts [--json] [--out receipt.json] [--embed-cache PATH] [--relational] [--limit 10] [--stub-embed] [--autocut on|off] [--relational-pin N|off] [--search-pin search.KEY=VALUE (search.reranker.* reserved)]\n',
  );
  process.exit(code);
}

export function parseArgs(argv: string[]): Args {
  const a: Args = { json: false, relational: false, limit: 10, stubEmbed: false };
  const need = (i: number, flag: string): string => {
    if (i + 1 >= argv.length) {
      process.stderr.write(`${flag} needs a value\n`);
      usage(2);
    }
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--json') a.json = true;
    else if (x === '--stub-embed') a.stubEmbed = true;
    else if (x === '--relational') a.relational = true;
    else if (x === '--out') a.out = need(i++, x);
    else if (x === '--embed-cache') a.embedCache = need(i++, x);
    else if (x === '--search-pin') {
      const v = need(i++, x);
      const eq = v.indexOf('=');
      const key = eq > 0 ? v.slice(0, eq).trim() : '';
      const val = eq > 0 ? v.slice(eq + 1).trim() : '';
      if (!key.startsWith('search.') || key === 'search.' || !val) {
        process.stderr.write(`--search-pin takes search.<key>=<value> (got ${v})\n`);
        usage(2);
      }
      if (SEARCH_PIN_RESERVED.test(key)) {
        // The reranker is the arm axis: the ON arm always runs R1_ON_RERANKER_MODEL
        // (readiness-checked, receipt-reported) and the OFF arm always has it off.
        process.stderr.write(`--search-pin cannot overlay ${key}: search.reranker.* is the ON/OFF arm axis (the ON arm always runs ${R1_ON_RERANKER_MODEL})\n`);
        usage(2);
      }
      a.searchPins = { ...(a.searchPins ?? {}), [key]: val };
    }
    else if (x === '--relational-pin') { const v = need(i++, x); if (!/^(off|[0-9]|10)$/.test(v)) { process.stderr.write(`--relational-pin takes 0-10 or off (got ${v})\n`); usage(2); } a.relationalPin = v; }
    else if (x === '--autocut') { const v = need(i++, x); if (v !== 'on' && v !== 'off') { process.stderr.write(`--autocut takes on|off (got ${v})\n`); usage(2); } a.autocut = v as 'on' | 'off'; }
    else if (x === '--limit') {
      a.limit = Number(need(i++, x));
      if (!Number.isInteger(a.limit) || a.limit < 3) {
        process.stderr.write(`--limit must be an integer >= 3 (got ${argv[i]})\n`);
        usage(2);
      }
    } else if (x === '--help' || x === '-h') usage(0);
    else {
      process.stderr.write(`unknown argument: ${x}\n`);
      usage(2);
    }
  }
  return a;
}

/**
 * The config overlay both arms receive on top of ARM_PINS. Generic
 * `--search-pin` entries are spread FIRST so the explicit `--autocut` /
 * `--relational-pin` flags win: an operator who typed `--autocut on` meant it,
 * even if a pasted pin list also carries `search.autocut=false`.
 */
export function buildOverlay(args: Pick<Args, 'autocut' | 'relationalPin' | 'searchPins'>): Readonly<Record<string, string>> {
  return {
    ...(args.searchPins ?? {}),
    ...(args.autocut === 'on' ? { 'search.autocut': 'true' } : args.autocut === 'off' ? { 'search.autocut': 'false' } : {}),
    ...(args.relationalPin !== undefined ? { 'search.relational_rerank_pin': args.relationalPin } : {}),
  };
}

/** Mirror of cli.ts's `eval longmemeval` bootstrap: config file when present, env otherwise. */
function configureGatewayFromEnv(): void {
  const config =
    loadConfig() ??
    ({
      embedding_model: process.env.GBRAIN_EMBEDDING_MODEL,
      embedding_dimensions: process.env.GBRAIN_EMBEDDING_DIMENSIONS ? Number(process.env.GBRAIN_EMBEDDING_DIMENSIONS) : undefined,
    } as GBrainConfig);
  configureGateway(buildGatewayConfig(config));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const log = (s: string): void => { process.stderr.write(`[r1] ${s}\n`); };

  const fixtures = [NAMEDTHING_FIXTURE_PATH];
  const questions: NamedThingQuestion[] = loadNamedThingQuestions();
  if (args.relational) {
    fixtures.push('test/fixtures/retrieval-quality/relational/corpus.ts (RELATIONAL_QUESTIONS)');
    questions.push(...RELATIONAL_QUESTIONS);
  }

  let embedder: string | null = null;
  let installedCache: InstalledEmbedCache | null = null;
  let cache: EmbeddingCache | null = null;
  let engine: PGLiteEngine | null = null;

  // Reranker wire telemetry: a pass-through transport that tees the response
  // body for the API-echoed model id + usage. Same seam class the embed cache
  // uses (documented decision in embed-cache.ts); restored to null on exit.
  const rerankTel: RerankerTelemetry = { configured: R1_ON_RERANKER_MODEL, api_model: null, calls: 0, request_chars: 0, usage_tokens: null };

  try {
    if (args.stubEmbed) {
      // The CI gate's stub: embed throws → hybrid falls open to keyword + title + alias.
      __setEmbedTransportForTests(() => { throw new Error('stub: no embed in R1 dry run'); });
    } else {
      configureGatewayFromEnv();
      embedder = `${getEmbeddingModel()}@${getEmbeddingDimensions()}`;
      log(`embedder ${embedder}`);
      if (args.embedCache) {
        cache = new EmbeddingCache(args.embedCache);
        installedCache = installEmbedCache(cache, { realTransport: null });
        log(`embed cache ${args.embedCache} (${installedCache.model}@${installedCache.dims})`);
      }
    }

    // Gateway first, THEN the brain: initSchema sizes the embedding column
    // from the gateway's dims.
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();

    let readiness: { plane: string; readiness: RerankerReadiness } | null = null;
    if (!args.stubEmbed) {
      const r = await rerankerReadinessForEngine(engine, R1_ON_RERANKER_MODEL);
      readiness = { plane: r.plane, readiness: r.readiness };
      if (!r.readiness.ready) {
        log(`ON arm reranker ${R1_ON_RERANKER_MODEL} is NOT ready (${r.plane} plane): ${describeRerankerFix(r.readiness) ?? 'unknown'}`);
        log('refusing to run: a not-ready reranker would fail open and silently turn ON into OFF. Nothing was spent.');
        process.exit(2);
      }
      log(`reranker ${R1_ON_RERANKER_MODEL} ready (${r.plane} plane)`);
    }

    // Seed ONCE. Live: real document-side vectors in one batch.
    const seeded = await seedNamedThingCorpus(engine, args.stubEmbed ? {} : { embed: (texts) => embed(texts) });
    log(`seeded ${seeded.pages} pages / ${seeded.chunks} chunks (${seeded.embedded} embedded)`);
    if (args.relational) {
      await seedRelationalCorpus(engine);
      log(`seeded relational corpus (${RELATIONAL_QUESTIONS.length} graph-relationship questions)`);
    }

    let embeddedChars = seeded.embedded_chars;
    const queryChars = questions.reduce((s, q) => s + q.query.length, 0);

    // OFF arm.
    const overlay = buildOverlay(args);
    await applyArmPins(engine, 'off', overlay);
    const off = await runArm(engine, 'off', questions, { limit: args.limit });
    if (!args.stubEmbed) embeddedChars += queryChars;
    log(`OFF arm: gate ${off.gate.pass ? 'PASS' : 'FAIL'}`);

    let on: ArmRun | null = null;
    let onSkipped: string | null = null;
    let cacheMissesBeforeOn = 0;
    if (args.stubEmbed) {
      onSkipped = 'stub-embed dry run: the ON arm needs VOYAGE_API_KEY + real embeddings (run without --stub-embed).';
      log(onSkipped);
    } else {
      cacheMissesBeforeOn = cache?.stats().misses ?? 0;
      __setRerankTransportForTests(async (url, init) => {
        rerankTel.calls++;
        rerankTel.request_chars += typeof init.body === 'string' ? init.body.length : 0;
        const res = await fetch(url, init);
        try {
          const j = (await res.clone().json()) as { model?: unknown; usage?: { total_tokens?: unknown } };
          if (typeof j?.model === 'string') rerankTel.api_model = j.model;
          if (typeof j?.usage?.total_tokens === 'number') rerankTel.usage_tokens = (rerankTel.usage_tokens ?? 0) + j.usage.total_tokens;
        } catch {
          /* body tee is best-effort; rerank() parses its own copy */
        }
        return res;
      });
      await applyArmPins(engine, 'on', overlay);
      on = await runArm(engine, 'on', questions, { limit: args.limit });
      __setRerankTransportForTests(null);
      if (!cache) embeddedChars += queryChars;
      log(`ON arm: gate ${on.gate.pass ? 'PASS' : 'FAIL'} · rerank calls ${rerankTel.calls} · api model ${rerankTel.api_model ?? 'not echoed'}`);

      const problems = [...embedIntegrityProblems(off), ...embedIntegrityProblems(on), ...onArmIntegrityProblems(on, readiness?.readiness ?? null)];
      if (problems.length) {
        log(`INTEGRITY FAILURE — the arms are not comparable (${problems.length} problem(s)):`);
        for (const p of problems) log(`  - ${p}`);
        process.exit(2);
      }
    }

    const paired = on ? pairArms(off, on) : null;
    const verdict = paired ? r1Verdict(paired) : null;

    const cacheStats = cache ? { ...cache.stats(), canonical_sha256: cache.canonicalSha256() } : null;
    // Proven only when the cache was installed AND the ON arm never missed it.
    const identical = cache && on && cacheStats ? cache.stats().misses === cacheMissesBeforeOn && cacheStats.infra_faults === 0 : null;

    const embPrice = embedder ? lookupEmbeddingPrice(getEmbeddingModel()) : null;
    const rrPrice = on ? lookupEmbeddingPrice(R1_ON_RERANKER_MODEL) : null;
    const embCost = embPrice?.kind === 'known' ? estimateCostFromChars(embeddedChars, embPrice.pricePerMTok) : null;
    const rrCost = rrPrice?.kind === 'known' ? estimateCostFromChars(rerankTel.request_chars, rrPrice.pricePerMTok) : null;

    const payload: R1Payload = {
      schema_version: 1,
      benchmark: 'namedthing',
      mode: args.stubEmbed ? 'stub-embed' : 'live',
      fixtures,
      questions: questions.length,
      embedder,
      reranker: on ? rerankTel : null,
      reranker_readiness: readiness,
      embed_cache: cacheStats,
      identical_query_vectors: identical,
      pins: { off: { ...ARM_PINS.off, ...overlay }, on: { ...ARM_PINS.on, ...overlay } },
      arms: { off, on },
      on_skipped: onSkipped,
      paired,
      verdict,
      spend_estimate_usd: {
        embedding: embCost,
        rerank: rrCost,
        total: embCost === null && rrCost === null ? null : (embCost ?? 0) + (rrCost ?? 0),
        note: args.stubEmbed
          ? 'stub-embed: no provider calls were made'
          : `chars/3.5 tokens × list price; embedding chars ${embeddedChars}${cache ? ' (query embeds counted once — cache serves the ON arm)' : ''}, rerank request chars ${rerankTel.request_chars}` +
            (rerankTel.usage_tokens !== null ? `, API-reported rerank tokens ${rerankTel.usage_tokens}` : ''),
      },
      _meta: { metric_glossary: buildMetricGlossaryMeta(R1_GLOSSARY_KEYS) },
    };

    if (args.out) {
      writeFileSync(args.out, JSON.stringify(payload, null, 2) + '\n');
      log(`receipt written: ${args.out}`);
    }
    if (args.json) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    else process.stdout.write(renderMarkdown(payload));

    if (verdict && !verdict.pass) process.exitCode = 1;
  } finally {
    __setRerankTransportForTests(null);
    installedCache?.uninstall();
    cache?.close();
    if (args.stubEmbed) __setEmbedTransportForTests(null);
    if (engine) await engine.disconnect();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`[r1] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(2);
  });
}
