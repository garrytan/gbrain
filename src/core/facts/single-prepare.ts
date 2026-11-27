import type { BrainEngine, FactAttribution, FactRow } from '../engine.ts';
import type { WithdrawalRow } from '../engine-sql/facts-trust.ts';
import { verbError, type OperationError } from '../ops/contract.ts';
import { isAvailable, embedOne, getEmbeddingModel } from '../ai/gateway.ts';
import { cosineSimilarity } from './classify.ts';
import { FACT_WITHDRAWN_MESSAGE, FACT_WITHDRAWN_SUGGESTION, isFactWithdrawn } from './withdrawal.ts';
import { assertFactNotPurged } from './withdrawal.ts';
import { cosineVerdict } from './capture-dedup.ts';
import { interleaveFusion } from '../search/fusion-lists.ts';
import { readSupersessionThreshold } from './supersession-threshold.ts';
import { folderAccessForAll } from '../access/caller.ts';
import { memberIdentity } from '../access/members.ts';
import { ownerMemberId } from '../access/owner.ts';
import { MEMBER_PAGE_PREFIX } from '../access/principals.ts';
import { slugUnderBoundPrefixes } from '../ops/context.ts';
import { ownedPageWithdrawalSubject } from '../access/member-facts.ts';
import { isHoldingSlug } from '../facts-fence.ts';
import { sameClaimSlot } from './typed-claim.ts';

export type FactCandidate = FactRow & { source_markdown_slug: string | null; row_num: number | null };
export interface FactDecision { status: 'inserted' | 'duplicate' | 'superseded'; candidate: FactCandidate | null; }
export interface SingleFactIntent {
  fact: string; kind: FactRow['kind']; visibility: FactRow['visibility']; entity_slug: string | null;
  /** Speaker of the new claim; a fact another known speaker asserted is never its duplicate. */
  attributed_to?: FactAttribution | null;
  /**
   * GST-359 C2: the member page a member's fact goes to (access/member-facts.ts). Its duplicates and supersession
   * candidates are only facts on that page (the writer's own, so the readers filter is not applied to them); a write
   * with no page_slug never matches a fact on any member page.
   */
  page_slug?: string;
  /** A typed new fact's claim slot (remember): it never supersedes a typed fact in another slot (typed-claim.ts sameClaimSlot). Unset (untyped): not checked. */
  slot?: { claim_metric: string | null; claim_unit: string | null; claim_period: string | null; valid_from: Date | string };
}
/** Preparation time kept back after the embed (a quarter of what is left, at most this): the dedup reads still run. */
const EMBED_RESERVE_MS = 5_000;
/**
 * Provider work belongs to preparation, never to a page/source transaction. `disabled`: the brain opted out of embedding.
 * `deadlineAt` (#8135): the preparation budget's end. The embed gets its own timeout short of it, and that timeout takes
 * the no-vector fallback like any embed failure; without it a slow embedder let the budget's abort win, the attempt was
 * charged, and the write ended `preparation_stalled` with nothing saved. The caller's own abort still propagates.
 */
export async function prepareFactEmbedding(fact: string, signal?: AbortSignal, disabled = false, deadlineAt?: number): Promise<{ embedding: Float32Array | null; embedding_model: string | null; degraded: boolean }> {
  signal?.throwIfAborted();
  const remaining = deadlineAt === undefined ? Infinity : deadlineAt - Date.now();
  const embedMs = remaining - Math.min(EMBED_RESERVE_MS, Math.floor(remaining / 4));
  if (!disabled && isAvailable('embedding') && embedMs > 0) {
    try {
      const model = getEmbeddingModel();
      const abortSignal = Number.isFinite(embedMs) ? AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(embedMs)]) : signal;
      return { embedding: await embedOne(fact, { abortSignal, embeddingModel: model, inputType: 'document' }), embedding_model: model, degraded: false };
    } catch { signal?.throwIfAborted(); }
  }
  return { embedding: null, embedding_model: null, degraded: true };
}
/**
 * `excludePrivate`: the caller cannot read private pages. It gets the plain fact_withdrawn refusal with no `withdrawn`
 * detail, whether the withdrawn rows sit on pages it can read, on pages it cannot read, or on no page at all, so the
 * refusal never tells those cases apart and never carries anything read from a page the caller may not see.
 * `remote`: GST-2346, a remote save onto a member page meets only memberPageWithdrawal's withdrawals.
 */
export async function assertFactNotWithdrawn(engine: BrainEngine, sourceId: string, input: SingleFactIntent, opts: { excludePrivate?: boolean; remote?: boolean } = {}): Promise<void> {
  await assertFactNotPurged(engine, sourceId, input);
  if (opts.remote && input.page_slug?.startsWith(MEMBER_PAGE_PREFIX)) {
    const met = await memberPageWithdrawal(engine, sourceId, input, input.page_slug);
    if (met) throw withdrawnRefusal(met);
    return;
  }
  if (await isFactWithdrawn(engine, sourceId, input.visibility, input.fact, input.entity_slug, ownedPageWithdrawalSubject(input.page_slug))) throw await factWithdrawnRefusal(engine, sourceId, input, opts);
}


function withdrawnRefusal(row: WithdrawalRow | undefined): OperationError {
  const error = verbError('invalid_params', FACT_WITHDRAWN_MESSAGE, FACT_WITHDRAWN_SUGGESTION);
  if (row) error.withdrawn = { at: new Date(row.withdrawn_at).toISOString(), subject: row.subject === '*' ? 'all_entities' : row.subject, visibility: row.visibility };
  return error;
}

/**
 * GST-2346: the withdrawal a remote save onto member page `page` meets, or null. What the member gets back never depends
 * on a claim it could not read, so the save meets the page's own withdrawals and a withdrawal of another subject only
 * when a row it withdrew is one the page's member reads: a row on that page, or a row on pages it reads (a shared one,
 * or for the enabled brain owner any one, under GST-2490's owner read rule). Otherwise the save is the member's own
 * row, which the insert guards leave active (facts/withdrawal-schema.ts). Judged by the page's member, live: a member
 * disabled or removed reads nothing.
 */
async function memberPageWithdrawal(engine: BrainEngine, sourceId: string, input: SingleFactIntent, page: string): Promise<WithdrawalRow | null> {
  const memberId = page.slice(MEMBER_PAGE_PREFIX.length);
  const identity = (await memberIdentity(engine, memberId).catch(() => null))?.identity ?? [];
  const satisfied = identity.length ? (await folderAccessForAll(engine, [identity])).satisfiedRuleIds : [];
  const owner = identity.length > 0 && await ownerMemberId(engine) === memberId;
  const row = await engine.readMemberPageWithdrawal({ sourceId, visibility: input.visibility, fact: input.fact, entitySlug: input.entity_slug, page, owner, identity, satisfied });
  return row ?? null;
}

/**
 * The refusal for a claim `isFactWithdrawn` matched. A caller that reads private pages (`excludePrivate` off) gets the
 * `withdrawn` detail from the withdrawal ledger alone (never a purge): the most specific subject first, then the newest
 * withdrawal. It covers the exact normalized claim only. Any other caller gets the plain refusal with no detail.
 */
export async function factWithdrawnRefusal(engine: BrainEngine, sourceId: string, input: SingleFactIntent, opts: { excludePrivate?: boolean } = {}): Promise<OperationError> {
  // A caller that cannot read private pages gets the same plain refusal for every withdrawal (see assertFactNotWithdrawn).
  if (opts.excludePrivate === true) return withdrawnRefusal(undefined);
  const met = await engine.readClaimWithdrawal({
    sourceId, visibility: input.visibility, fact: input.fact, entitySlug: input.entity_slug,
    ownPage: ownedPageWithdrawalSubject(input.page_slug), excludePrivate: false,
  });
  return withdrawnRefusal(met.row ?? undefined);
}
export const CANDIDATE_FUSION_KEY = 'facts.candidate_fusion';
export type CandidateFusion = 'rrf_free' | 'interleave';
/** Candidates the supersession decision scores; the cap bounds the blast radius. */
export const SUPERSESSION_CANDIDATE_K = 5;

/** `facts.candidate_fusion`: `rrf_free` (default) is the single cosine arm; unknown values read as the default. */
export async function readCandidateFusion(engine: BrainEngine): Promise<CandidateFusion> {
  try {
    const raw = (await engine.getConfig(CANDIDATE_FUSION_KEY))?.trim();
    return raw === 'interleave' ? 'interleave' : 'rrf_free';
  } catch {
    return 'rrf_free';
  }
}

/**
 * The supersession candidate set for one claim: the cosine arm's top k, or
 * under `interleave` the cosine and keyword arms merged round-robin by fact id
 * and cut to the same k, so the decision still scores at most k rows.
 */
export async function listSupersessionCandidates(engine: BrainEngine, sourceId: string, entitySlug: string, fact: string, embedding: Float32Array, embeddingModel?: string | null, fusion?: CandidateFusion, attributedTo?: FactAttribution | null, scope: { excludeMemberPages?: boolean; onlyPage?: string } = {}): Promise<FactRow[]> {
  const k = SUPERSESSION_CANDIDATE_K;
  const cosine = await engine.findCandidateDuplicates(sourceId, entitySlug, fact, { embedding, embeddingModel, k, attributedTo, ...scope });
  if ((fusion ?? await readCandidateFusion(engine)) !== 'interleave') return cosine;
  const keyword = await engine.findCandidateDuplicates(sourceId, entitySlug, fact, { embedding, embeddingModel, k, arm: 'keyword', attributedTo, ...scope });
  return interleaveFusion([cosine, keyword], row => row.id, k);
}

/**
 * SQL-only, so publication can verify the semantic decision under its guard.
 * `lane` is the writer's `facts.source`: capture lanes never drop by cosine (#5888).
 */
export async function decideSingleFact(engine: BrainEngine, sourceId: string, input: SingleFactIntent, embedding: Float32Array | null, embeddingModel?: string | null, lane?: string | null, opts: { excludePrivate?: boolean } = {}): Promise<FactDecision> {
  const remoteFloor = opts.excludePrivate === true && !input.page_slug;
  const exact = await engine.findActiveSingleFact({ sourceId, entitySlug: input.entity_slug, visibility: input.visibility, fact: input.fact,
    attributedTo: input.attributed_to ?? null, pageSlug: input.page_slug ?? null, remoteFloor });
  if (exact) return { status: 'duplicate', candidate: { ...exact, id: Number(exact.id) } };
  if (embedding && input.entity_slug) {
    const candidates = await listSupersessionCandidates(engine, sourceId, input.entity_slug, input.fact, embedding, embeddingModel, undefined, input.attributed_to ?? null,
      input.page_slug ? { onlyPage: input.page_slug } : { excludeMemberPages: true });
    const metadata = await engine.listSingleFactMetadata({ sourceId, ids: candidates.map(c => c.id), remoteFloor });
    let candidate: FactCandidate | null = null;
    let score = -1;
    for (const found of candidates) {
      const fence = metadata.find(m => Number(m.id) === found.id);
      if (!fence) continue;
      const c: FactCandidate = { ...found, ...fence, id: found.id };
      // A private candidate must never affect a world's response or expire as a
      // side effect. Cross-page supersession requires a separate multi-page op.
      if (!c.embedding || c.visibility !== input.visibility || c.expired_at ||
        c.valid_until && new Date(c.valid_until).getTime() <= Date.now() ||
        (input.page_slug ? c.source_markdown_slug !== input.page_slug : c.source_markdown_slug && c.source_markdown_slug !== input.entity_slug) ||
        input.slot && c.claim_metric && !sameClaimSlot(input.slot, c)) continue;
      const next = cosineSimilarity(embedding, c.embedding);
      if (next > score) { score = next; candidate = c; }
    }
    if (candidate && cosineVerdict(lane, score, input.fact, candidate.fact, (await readSupersessionThreshold(engine, embeddingModel, embedding.length)).threshold) === 'duplicate') return {
      status: candidate.kind === input.kind ? 'superseded' : 'duplicate', candidate,
    };
  }
  return { status: 'inserted', candidate: null };
}

/** #6764: a conversation-derived fact changes when its page is re-extracted (forget + remember would only withdraw it). */
function replacesDerivedSuggestion(sourceId: string, slug: string): string {
  const base = `gbrain extract-conversation-facts --source-id ${sourceId} --slugs ${slug} --force`;
  return `Re-extract the conversation page to change its facts: preview with ${base} --dry-run, then run ${base} --max-cost-usd <n> (paid).`;
}

/**
 * #7248: a replacement whose visibility the caller did not set keeps a
 * private target private, so replacing a private fact needs no flag. Only a
 * local caller qualifies (a remote caller never sees a private fact), and a
 * world target never widens a default.
 */
export async function replacementVisibility(engine: BrainEngine, sourceId: string, targetId: number,
  defaulted: 'world' | 'private', opts: { remote: boolean }): Promise<'world' | 'private'> {
  if (defaulted === 'private' || opts.remote || !Number.isSafeInteger(targetId)) return defaulted;
  const target = await engine.readFactVisibility(targetId, sourceId);
  return target?.visibility === 'private' ? 'private' : defaulted;
}

/**
 * `remember.replaces`: the caller names the fact the new one replaces. Checked,
 * zero-model: the target must be an active fact in this source with the same
 * visibility and entity, and on the same entity page; equal text is a no-op
 * duplicate. `lock` takes the target row lock inside the publishing transaction.
 */
export async function decideReplacement(engine: BrainEngine, sourceId: string, input: SingleFactIntent, targetId: number,
  opts: { pageSlug: string; remote: boolean; lock?: boolean; excludePrivate?: boolean; slugPrefixes?: string[] | null }): Promise<FactDecision> {
  // GST-359: a member's write may replace a fact on its own member page (the page this write goes to), private or not.
  const ownPage = input.page_slug && input.page_slug === opts.pageSlug ? input.page_slug : null;
  const notFound = () => verbError('not_found', `No fact with id "${targetId}" to replace.`,
    'Pass the fact_id of an active fact from recall (facts[].fact_id) about the same entity, or omit replaces to save a new fact.');
  const target = await engine.readReplacementTarget({ targetId, sourceId, excludePrivate: opts.excludePrivate, ownPage, lock: opts.lock });
  if (!target || (opts.remote && target.visibility !== 'world' && !(ownPage && target.source_markdown_slug === ownPage))) throw notFound();
  // #5913 [R2]: a slug-bound writer learns nothing about a fact outside its prefixes; the answer is the missing-id one.
  if (opts.slugPrefixes && [target.entity_slug, target.source_markdown_slug].some(slug => slug && !slugUnderBoundPrefixes(opts.slugPrefixes!, slug))) throw notFound();
  if (target.visibility !== input.visibility) {
    throw verbError('invalid_params', `replaces_visibility_mismatch: fact #${targetId} is ${target.visibility}, and the new fact would be ${input.visibility}.`,
      `Pass visibility: "${target.visibility}" to replace it, or forget fact #${targetId} and remember the new claim separately.`);
  }
  const candidate: FactCandidate = { ...target, id: Number(target.id) };
  if (target.withdrawn) {
    throw verbError('invalid_params', `target_withdrawn: fact #${targetId} was forgotten, so it cannot be replaced.`,
      'Remember the new claim without replaces; the forgotten claim stays withdrawn.');
  }
  if (target.expired_at || (target.valid_until && new Date(target.valid_until).getTime() <= Date.now())) {
    if (target.superseded_by != null) {
      throw verbError('invalid_params', `target_superseded: fact #${targetId} was already replaced by fact #${target.superseded_by}.`,
        `Recall the entity to check the current fact, then pass replaces: "${target.superseded_by}" if the new claim replaces that one.`);
    }
    throw verbError('invalid_params', `target_expired: fact #${targetId} is no longer active.`,
      'Remember the new claim without replaces.');
  }
  // R1: replacing a fact saved without an entity by the same claim with an entity links it (supersession, no withdrawal).
  if (target.entity_slug != null && target.entity_slug !== (input.entity_slug ?? null)) {
    throw verbError('invalid_params', `replaces_entity_mismatch: fact #${targetId} is about ${target.entity_slug ?? 'no entity'}, not ${input.entity_slug ?? 'no entity'}.`,
      'Pass the same entity as the fact being replaced, or forget the old fact and remember the new one separately.');
  }
  // GBRA-190 G4: a fact saved without an entity is a row of memory/unattributed; linking it strikes that row in the same write.
  // GST-2492: so does replacing a fact a strict source held there for the same entity (checked above).
  const linking = input.entity_slug != null && isHoldingSlug(candidate.source_markdown_slug);
  if (candidate.source_markdown_slug && candidate.source_markdown_slug !== opts.pageSlug && !linking) {
    const derived = String(candidate.source ?? '').startsWith('cli:extract-conversation-facts');
    throw verbError('invalid_params', `replaces_cross_page: fact #${targetId} lives on page ${candidate.source_markdown_slug}${derived ? ', extracted from that conversation page' : ''}.`,
      derived ? replacesDerivedSuggestion(sourceId, candidate.source_markdown_slug) : 'Forget the old fact, then remember the new one.');
  }
  const exact = await decideSingleFact(engine, sourceId, input, null, undefined, undefined, { excludePrivate: opts.excludePrivate });
  if (exact.status === 'duplicate') {
    if (exact.candidate!.id === candidate.id) return { status: 'duplicate', candidate };
    throw verbError('invalid_params', `replaces_duplicate: an active fact (#${exact.candidate!.id}) already states this claim.`,
      `Forget fact #${targetId} if it is no longer true; the existing fact #${exact.candidate!.id} already says the new claim.`);
  }
  return { status: 'superseded', candidate };
}
