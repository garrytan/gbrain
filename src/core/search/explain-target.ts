/**
 * explain-target.ts — "why is this page missing from my results?"
 *
 * A `TargetTrace` rides one hybridSearch call (HybridSearchOpts.explainTarget)
 * and records, at each pipeline stage, whether the target page was present
 * and at what rank: every retrieval arm instance, the keyword arm before and
 * after relaxed-row demotion, fusion, dedup, rerank, return sizing (autocut,
 * adaptive return, identity tiers, relational evidence slot), the limit slice
 * and the token budget. `diagnoseTrace` turns those observations into one
 * state — retrieved / dropped / reinjected / not_retrieved / not_recorded —
 * naming the first stage that lost the page. It never claims a cause it did
 * not observe: boost stages only re-order (they are reported through
 * score_details, never as a drop), and a stage the path never ran is absent
 * from the observations rather than guessed.
 *
 * When no arm retrieved the page, `probeTarget` runs ONE read under the
 * caller's read policy to tell "not indexed" from "not retrieved". A page the
 * caller cannot read and a page that does not exist return the same
 * `target_not_found_or_not_visible`, so the diagnosis never leaks existence.
 *
 * Tracking runs only when a target is set; normal searches pay nothing.
 */

import type { SearchResult, PageReadPolicy } from '../types.ts';
import type { Action } from '../agent-output.ts';
import { pageReadFilter } from './read-policy-sql.ts';
import { belowSafeChunkFence, chunkGenerationFilter } from './safe-chunks.ts';

export interface ExplainTargetRef {
  slug: string;
  /** Required when the slug exists in more than one readable source. */
  sourceId?: string;
}

export interface TargetObservation {
  /** Pipeline stage, or `arm:<instance>` for one retrieval arm's list. */
  stage: string;
  present: boolean;
  /** 1-based rank within that stage's list when present. */
  rank?: number;
}

export class TargetTrace {
  readonly observations: TargetObservation[] = [];
  constructor(readonly target: ExplainTargetRef) {}

  matches(r: SearchResult): boolean {
    if (r.slug !== this.target.slug) return false;
    return this.target.sourceId === undefined || (r.source_id ?? 'default') === this.target.sourceId;
  }

  /** Record presence (page-level: the first matching row's rank) in one stage's list. */
  observe(stage: string, rows: readonly SearchResult[]): void {
    const i = rows.findIndex(r => this.matches(r));
    this.observations.push(i >= 0 ? { stage, present: true, rank: i + 1 } : { stage, present: false });
  }

  arms(): TargetObservation[] {
    return this.observations.filter(o => o.stage.startsWith('arm:'));
  }

  last(stage: string): TargetObservation | undefined {
    for (let i = this.observations.length - 1; i >= 0; i--) if (this.observations[i].stage === stage) return this.observations[i];
    return undefined;
  }
}

/** The ordered post-arm stages a target can be lost at, with the code each loss maps to. */
const LOSS_STAGES: ReadonlyArray<{ stage: string; code: string; why: string }> = [
  { stage: 'fused', code: 'target_dropped_relaxed_keyword', why: 'Only the relaxed (OR-of-terms) keyword match found the page, and relaxed rows do not vote while the semantic arm is healthy.' },
  { stage: 'deduped', code: 'target_dropped_dedup', why: 'Result dedup removed the page (per-page chunk cap, near-duplicate text, or type-diversity cap) in favor of a higher-ranked row.' },
  { stage: 'reranked', code: 'target_dropped_rerank', why: 'The page fell out during reranking.' },
  { stage: 'return_pool', code: 'target_dropped_return_sizing', why: 'Return sizing cut the page: autocut found a relevance cliff above it, or adaptive return sizing trimmed the tail.' },
  { stage: 'limit_slice', code: 'target_beyond_limit', why: 'The page ranked below the requested result limit (or before the offset).' },
  { stage: 'token_budget', code: 'target_dropped_token_budget', why: 'The token budget filled before the page was reached.' },
];

export type TargetState = 'retrieved' | 'dropped' | 'reinjected' | 'not_retrieved' | 'not_recorded';

export interface ExplainTargetDiagnosis {
  target: { slug: string; source_id?: string };
  state: TargetState;
  code: string;
  why: string;
  /** 1-based rank in the returned rows, when returned. */
  rank?: number;
  /** Arm instances that retrieved the page, with their 1-based list rank. */
  arms: Array<{ arm: string; rank: number }>;
  /** The stage that last held the page, and the first that lost it. */
  last_seen?: TargetObservation;
  lost_at?: string;
  /** Rank the page held at the last stage that had it (for limit retries). */
  last_rank?: number;
  stages: TargetObservation[];
  fix?: Action;
}

function armsOf(trace: TargetTrace): ExplainTargetDiagnosis['arms'] {
  return trace.arms().filter(o => o.present).map(o => ({ arm: o.stage.slice(4), rank: o.rank! }));
}

/**
 * Turn the observations into one state. `returned` is the final row list the
 * caller receives. `retry` holds the original search arguments so every fix
 * is a complete call.
 */
export function diagnoseTrace(
  trace: TargetTrace,
  returned: readonly SearchResult[],
  retry: { tool: 'search' | 'query'; arguments: Record<string, unknown> },
): ExplainTargetDiagnosis {
  const target = { slug: trace.target.slug, ...(trace.target.sourceId ? { source_id: trace.target.sourceId } : {}) };
  const stages = trace.observations;
  const arms = armsOf(trace);
  const getPage: Action = {
    mcp: { tool: 'get_page', arguments: { slug: trace.target.slug, ...(trace.target.sourceId ? { source_id: trace.target.sourceId } : {}) } },
    argv: ['gbrain', 'get', trace.target.slug],
    consent: [], actor: 'agent', requires_exclusive: false,
    why: 'Read the page directly; search ranking does not limit a direct read.',
  };
  const idx = returned.findIndex(r => trace.matches(r));
  if (idx >= 0) {
    const reinjected = stages.some(o => o.stage === 'reranked' && !o.present) && trace.last('return_pool')?.present === true;
    return reinjected
      ? { target, state: 'reinjected', code: 'target_reinjected', rank: idx + 1, arms, stages,
          why: 'The page was cut earlier and put back on page 1 by the relational evidence slot or an identity tier (exact slug/title, declared alias).' }
      : { target, state: 'retrieved', code: 'target_returned', rank: idx + 1, arms, stages,
          why: `The page is result #${idx + 1}; score_details on that row shows how its score was formed.` };
  }
  if (stages.length === 0) {
    return { target, state: 'not_recorded', code: 'target_not_recorded', arms, stages,
      why: 'This search path did not record stage observations for the target.' };
  }
  if (arms.length === 0) {
    return { target, state: 'not_retrieved', code: 'target_not_retrieved', arms, stages,
      why: 'No retrieval arm (semantic, keyword, title, relational) returned the page for this query.',
      fix: { mcp: { tool: 'query', arguments: { ...retry.arguments, query: retry.arguments.query } }, consent: [], actor: 'agent', requires_exclusive: false,
        why: 'The query tool adds multi-query expansion, which recovers pages phrased differently from the question; or read the page directly with get_page.' } };
  }
  // The page reached at least one arm: find the first post-arm stage that lost it.
  const keywordRaw = trace.last('arm:keyword_raw');
  const keyword = trace.last('arm:keyword');
  if (keywordRaw?.present && keyword && !keyword.present && arms.every(a => a.arm === 'keyword_raw')) {
    const loss = LOSS_STAGES[0];
    return { target, state: 'dropped', code: loss.code, why: loss.why, arms, stages, lost_at: 'fused', last_seen: keywordRaw, last_rank: keywordRaw.rank, fix: getPage };
  }
  let lastSeen: TargetObservation | undefined = trace.arms().filter(o => o.present).pop();
  for (const loss of LOSS_STAGES) {
    const o = trace.last(loss.stage);
    if (!o) continue;
    if (o.present) { lastSeen = o; continue; }
    const base = { target, state: 'dropped' as const, code: loss.code, why: loss.why, arms, stages, lost_at: loss.stage, last_seen: lastSeen, last_rank: lastSeen?.rank };
    if (loss.code === 'target_beyond_limit' && lastSeen?.rank) {
      return { ...base, fix: { mcp: { tool: retry.tool, arguments: { ...retry.arguments, limit: Math.min(100, lastSeen.rank + 5) } },
        consent: [], actor: 'agent', requires_exclusive: false, why: `Repeat the same search with a limit that reaches rank ${lastSeen.rank}.` } };
    }
    if (loss.code === 'target_dropped_token_budget') {
      return { ...base, fix: { mcp: { tool: retry.tool, arguments: { ...retry.arguments, token_budget: 12000 } },
        consent: [], actor: 'agent', requires_exclusive: false, why: 'Repeat the same search with a larger evidence token budget, or read the page directly with get_page.' } };
    }
    return { ...base, fix: getPage };
  }
  return { target, state: 'not_recorded', code: 'target_not_recorded', arms, stages, last_seen: lastSeen,
    why: 'The page reached the pipeline but the stage that removed it was not observed (evidence delivery or an output filter after the traced stages).', fix: getPage };
}

/** One readable copy of the target page. */
export interface TargetProbeRow {
  source_id: string;
  chunks: number;
  current: boolean;
  chunker_version: number | null;
}

type ReadQuery = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;

/** Every readable live copy of `slug` under the caller's policy (one query). */
export async function probeTarget(query: ReadQuery, slug: string, policy: PageReadPolicy, chunkManifest = true): Promise<TargetProbeRow[]> {
  const params: unknown[] = [slug];
  const filter = pageReadFilter('p', policy, params, true);
  const rows = await query<{ source_id: string; chunks: number; current: boolean; chunker_version: number | null }>(
    `SELECT p.source_id,
       (SELECT COUNT(*)::int FROM content_chunks cc WHERE cc.page_id = p.id AND ${chunkGenerationFilter('p', 'cc', chunkManifest)}) AS chunks,
       ((p.text_projection_revision = p.knowledge_revision) IS TRUE) AS current,
       p.chunker_version
     FROM pages p WHERE p.slug = $1 AND ${filter} ORDER BY p.source_id`, params);
  return rows.map(r => ({ source_id: r.source_id, chunks: Number(r.chunks), current: r.current === true, chunker_version: r.chunker_version == null ? null : Number(r.chunker_version) }));
}

/**
 * Refine a `not_retrieved` diagnosis (or resolve the target before search)
 * from the probe. `requireSafeChunks` mirrors the remote read legs.
 */
export function diagnoseProbe(
  ref: ExplainTargetRef,
  rows: readonly TargetProbeRow[],
  opts: { requireSafeChunks: boolean; retry: { tool: 'search' | 'query'; arguments: Record<string, unknown> } },
): ExplainTargetDiagnosis | null {
  const target = { slug: ref.slug, ...(ref.sourceId ? { source_id: ref.sourceId } : {}) };
  const scoped = ref.sourceId ? rows.filter(r => r.source_id === ref.sourceId) : rows;
  if (scoped.length === 0) {
    return { target, state: 'not_retrieved', code: 'target_not_found_or_not_visible', arms: [], stages: [],
      why: 'No page with this slug is readable by this caller in the searched sources: it may not exist, may be private, or may live in a source outside this search.',
      fix: { consent: [], actor: 'user', requires_exclusive: false, why: 'Ask the user whether the page exists and which source holds it; a private or out-of-scope page cannot be diagnosed from here.',
        user_message: `I could not find a readable page "${ref.slug}" in the searched sources. Does it exist, and in which source?` } };
  }
  if (scoped.length > 1) {
    return { target, state: 'not_retrieved', code: 'target_ambiguous', arms: [], stages: [],
      why: `The slug exists in ${scoped.length} readable sources (${scoped.map(r => r.source_id).join(', ')}); name one as source:slug.`,
      fix: { mcp: { tool: opts.retry.tool, arguments: { ...opts.retry.arguments, explain_target: `${scoped[0].source_id}:${ref.slug}` } },
        consent: [], actor: 'agent', requires_exclusive: false, why: `Repeat with explain_target as <source>:${ref.slug}, source one of: ${scoped.map(r => r.source_id).join(', ')}.` } };
  }
  const row = scoped[0];
  const withSource = { ...target, source_id: row.source_id };
  if (row.chunks === 0) {
    return { target: withSource, state: 'not_retrieved', code: 'target_not_indexed', arms: [], stages: [],
      why: 'The page has no indexed chunks, so no search arm can return it.',
      fix: { argv: ['gbrain', 'doctor', '--json'], consent: [], actor: 'agent', requires_exclusive: false,
        why: 'Doctor reports pages missing chunks or embeddings and the command that re-indexes them.' } };
  }
  if (!row.current) {
    return { target: withSource, state: 'not_retrieved', code: 'target_projection_stale', arms: [], stages: [],
      why: 'The page changed and its searchable text has not been rebuilt yet; search reads only the current revision.',
      fix: { argv: ['gbrain', 'doctor', '--json'], consent: [], actor: 'agent', requires_exclusive: false,
        why: 'Doctor shows the projection backlog and whether a worker is draining it; retry the search after it catches up.' } };
  }
  if (opts.requireSafeChunks && belowSafeChunkFence(row.chunker_version)) {
    return { target: withSource, state: 'not_retrieved', code: 'target_safe_chunks_uncertified', arms: [], stages: [],
      why: 'The page was indexed before the current safe-chunk format; remote reads withhold it until it is re-sealed.',
      fix: { argv: ['gbrain', 'repair', 'safe-chunks'], consent: [], actor: 'host_admin', requires_exclusive: false,
        why: 'The brain host operator re-seals older pages; the page becomes searchable remotely afterwards.' } };
  }
  return null;
}
