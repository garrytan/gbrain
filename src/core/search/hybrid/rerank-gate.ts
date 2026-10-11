/**
 * hybridSearch pipeline stage (W3): the confidence gate in front of the
 * cross-encoder. Runs on the deduped candidates, before `rerankAndPin` calls
 * the reranker, only when `search.reranker.gate` is not `off`.
 *
 * It reads the identity tiers without applying them: the alias table read
 * (`lookupAliasHop`) and the structural exact lookup (`structuralExactLookup`)
 * return what the post-rerank tiers would apply, the grade reads them plus a
 * detached view of the candidates (`gradePreRerank`, pure), and
 * `sizeReturnPool` applies the same lookups at today's post-rerank position,
 * so each lookup runs once and the reranker's input is unchanged. `off`
 * returns nothing and the pipeline is untouched.
 */
import type { SearchResult } from '../../types.ts';
import type { HybridRequest } from './request.ts';
import type { RerankerOpts } from '../rerank.ts';
import { type AliasHopLookup, aliasHopCanonicals, isExcludedIdentity, lookupAliasHop } from '../alias-hop.ts';
import { type ExactLookupOpts, structuralExactLookup } from '../exact-lookup.ts';
import {
  type PreRerankNotStrongReason,
  type PreRerankStrongReason,
  type RerankGateMode,
  RERANK_GATE_SKIP_REASONS,
  applyRerankGateTrust,
  gradePreRerank,
} from '../crag.ts';
import type { TrustTier } from '../../trust/tier.ts';
import { stampPageTrust } from '../../eligibility/stamp.ts';

/** `meta.rerank_gate`: what the gate decided for this request (present only when the gate is not `off`). */
export interface RerankGateMeta {
  mode: Exclude<RerankGateMode, 'off'>;
  /** False when the reranker would not have run anyway (reranker off, egress denied, no candidates). */
  eligible: boolean;
  ineligible_reason?: 'reranker_off' | 'egress_denied' | 'no_candidates';
  grade?: 'strong' | 'not_strong';
  reason?: PreRerankStrongReason | PreRerankNotStrongReason;
  top_cosine?: number;
  gap?: number;
  /** Deduped candidates the grade read. */
  candidates: number;
  /** A strong grade for a skip reason, with nothing blocking a skip. */
  would_skip: boolean;
  /** Why a strong grade would not skip: a shadow-only reason (A57) or the System One rerank slot. */
  skip_blocked?: 'shadow_only_reason' | 'decide_rerank_slot';
  /** `on` only: the gate skipped the cross-encoder (a deliberate skip, never in `degraded[]`). */
  skipped?: true;
  /** A reranker provider call was made for this request. */
  provider_called: boolean;
}

/** Identity lookups read before reranking and applied after it (`sizeReturnPool`). */
export interface IdentityLookups {
  alias: AliasHopLookup | null;
  exactHits: SearchResult[];
}

/** True when the opt-in single-token alias hop has a candidate it would move (full-query alias absent). */
function tokenHopWouldFire(lookup: AliasHopLookup, opts: HybridRequest['aliasHopOpts']): boolean {
  if ((lookup.aliasMap.get(lookup.qNorm)?.length ?? 0) > 0) return false;
  return lookup.tokens.some((t) => (lookup.aliasMap.get(t) ?? []).filter((ref) => !isExcludedIdentity(ref.slug, opts)).length === 1);
}

async function pageTrust(req: HybridRequest, top: { slug: string; source_id: string; page_id?: number }, candidates: readonly SearchResult[]): Promise<TrustTier | undefined> {
  const row = candidates.find((r) => r.slug === top.slug && (r.source_id ?? 'default') === top.source_id);
  const probe: { slug: string; source_id?: string; page_id?: number; chunk_text?: string; trust_tier?: string } = row ? { ...row } : { ...top, chunk_text: '' };
  try {
    const [stamped] = await stampPageTrust(req.engine, [probe]);
    return stamped?.trust_tier as TrustTier | undefined;
  } catch {
    return undefined;
  }
}

/**
 * Grade the deduped candidates before reranking. Returns `{}` under `off`.
 * Never mutates `deduped` or its rows.
 */
export async function prepareRerankGate(
  req: HybridRequest,
  { deduped, rerankerOpts, egressDenied, exactLookupOpts, multimodal }: {
    deduped: readonly SearchResult[]; rerankerOpts: Pick<RerankerOpts, 'enabled' | 'topNIn'>; egressDenied: boolean;
    exactLookupOpts: ExactLookupOpts; multimodal: boolean;
  },
): Promise<{ meta?: RerankGateMeta; lookups?: IdentityLookups }> {
  const mode = req.resolvedMode.reranker_gate;
  if (mode === 'off') return {};
  const base = { mode, candidates: deduped.length, would_skip: false, provider_called: false } as const;
  if (!rerankerOpts.enabled || rerankerOpts.topNIn <= 0) return { meta: { ...base, eligible: false, ineligible_reason: 'reranker_off' } };
  if (egressDenied) return { meta: { ...base, eligible: false, ineligible_reason: 'egress_denied' } };
  if (deduped.length === 0) return { meta: { ...base, eligible: false, ineligible_reason: 'no_candidates' } };

  const { engine, query, aliasHopOpts, resolvedMode } = req;
  const [alias, exactHits] = await Promise.all([
    lookupAliasHop(engine, query, aliasHopOpts),
    structuralExactLookup(engine, query, exactLookupOpts).catch(() => [] as SearchResult[]),
  ]);
  let grade = gradePreRerank({
    candidates: deduped,
    query,
    exactLookupHits: exactHits,
    aliasCanonicals: alias ? aliasHopCanonicals(alias, aliasHopOpts) : [],
    aliasTokenHop: alias ? tokenHopWouldFire(alias, aliasHopOpts) : false,
    multimodal,
    cosineFloor: resolvedMode.evidence_cosine_floor,
    minGap: resolvedMode.reranker_gate_min_gap,
  });
  if (grade.strong && grade.top) {
    grade = applyRerankGateTrust(grade, await pageTrust(req, grade.top, deduped), req.opts?.minTrust);
  }
  const s1 = req.decide?.policies.rerank;
  const skipReason = grade.strong && RERANK_GATE_SKIP_REASONS.has(grade.reason as PreRerankStrongReason);
  const blocked = !grade.strong ? undefined
    : !skipReason ? 'shadow_only_reason' as const
      : s1 && s1.effective !== 'off' ? 'decide_rerank_slot' as const
        : undefined;
  const meta: RerankGateMeta = {
    ...base,
    eligible: true,
    grade: grade.strong ? 'strong' : 'not_strong',
    reason: grade.reason,
    ...(grade.top_cosine !== undefined ? { top_cosine: grade.top_cosine } : {}),
    ...(grade.gap !== undefined ? { gap: grade.gap } : {}),
    would_skip: grade.strong && blocked === undefined,
    ...(blocked ? { skip_blocked: blocked } : {}),
  };
  return { meta, lookups: { alias, exactHits } };
}
