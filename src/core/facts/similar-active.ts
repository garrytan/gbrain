/**
 * After a forget: other active facts about the same entity that are close in
 * meaning to the withdrawn claim. Zero model calls: the withdrawn fact's stored
 * embedding is compared in SQL. Returns fact ids and similarity scores only (no
 * stored text), plus what the overnight semantic review will do, so the agent
 * can ask the user whether any of them restate what was withdrawn.
 */
import type { BrainEngine } from '../engine.ts';
import { loadConfigSnapshot } from '../config-snapshot.ts';
import { readDecideConfig, providerKind } from '../ai/decide/config.ts';
import { hasTypesafeKey } from '../ai/decide/index.ts';
import { CONFLICT_MIN_COSINE } from '../ai/decide/conflict.ts';
import { REVIEW_WITHDRAW_KEY, reviewWithdrawOn } from './withdrawal.ts';

export const SIMILAR_ACTIVE_LIMIT = 5;

export type SemanticReviewState = 'scheduled' | 'off' | 'unavailable' | 'opted_out';

export interface SimilarActive {
  state: 'checked' | 'not_checked_no_embedding' | 'not_checked_pending';
  candidates: Array<{ fact_id: string; similarity: number }>;
  semantic_review: SemanticReviewState;
  next: string;
}

async function reviewState(engine: BrainEngine, optedOut: boolean): Promise<SemanticReviewState> {
  if (optedOut) return 'opted_out';
  const snapshot = await loadConfigSnapshot(engine);
  if (!reviewWithdrawOn(snapshot?.[REVIEW_WITHDRAW_KEY])) return 'off';
  const cfg = readDecideConfig(snapshot, { typesafeKey: hasTypesafeKey() });
  if (cfg.slots.conflict.mode === 'off') return 'off';
  const kind = providerKind(cfg.slots.conflict.provider);
  if (kind === 'none' || (kind === 'typesafe' && !hasTypesafeKey())) return 'unavailable';
  return 'scheduled';
}

const REVIEW_LINE: Record<SemanticReviewState, string> = {
  scheduled: 'An overnight semantic review will also propose rewordings of the withdrawn claim for the owner to accept.',
  off: 'Overnight semantic review is off, so nothing else will catch rewordings: ask the user before forgetting more.',
  unavailable: 'Overnight semantic review is on but has no decision provider, so it will not run: ask the user before forgetting more.',
  opted_out: 'This withdrawal opted out of overnight semantic review.',
};

export async function similarActiveAfterForget(engine: BrainEngine, opts: {
  sourceId: string; factId: number; remote: boolean; committed: boolean; semanticReview?: boolean;
}): Promise<SimilarActive> {
  const semantic_review = await reviewState(engine, opts.semanticReview === false);
  const finish = (state: SimilarActive['state'], candidates: SimilarActive['candidates'], lead: string): SimilarActive =>
    ({ state, candidates, semantic_review, next: `${lead} ${REVIEW_LINE[semantic_review]}` });
  if (!opts.committed) return finish('not_checked_pending', [], 'Similar facts were not checked because the withdrawal has not committed yet.');
  const [anchor] = await engine.executeRaw<{ has_embedding: boolean; entity_slug: string | null }>(
    `SELECT embedding IS NOT NULL AS has_embedding, entity_slug FROM facts WHERE id=$1 AND source_id=$2`, [opts.factId, opts.sourceId]);
  if (!anchor?.has_embedding) {
    return finish('not_checked_no_embedding', [], 'The withdrawn fact has no embedding, so close rewordings could not be checked; recall the entity and ask the user if any remaining fact restates it.');
  }
  const rows = await engine.executeRaw<{ id: number | string; similarity: number | string }>(
    `SELECT c.id, (1 - (c.embedding <=> n.embedding))::float8 AS similarity
       FROM facts n JOIN facts c
         ON c.source_id = n.source_id AND c.entity_slug IS NOT DISTINCT FROM n.entity_slug AND c.visibility = n.visibility AND c.id <> n.id
      WHERE n.id = $1 AND n.source_id = $2
        AND c.expired_at IS NULL AND (c.valid_until IS NULL OR c.valid_until > now())
        AND c.embedding IS NOT NULL AND c.embedding_model = n.embedding_model
        AND ($3::boolean = false OR c.visibility = 'world')
        AND (1 - (c.embedding <=> n.embedding)) >= $4
      ORDER BY c.embedding <=> n.embedding, c.id
      LIMIT $5`,
    [opts.factId, opts.sourceId, opts.remote, CONFLICT_MIN_COSINE, SIMILAR_ACTIVE_LIMIT]);
  const candidates = rows.map(r => ({ fact_id: String(r.id), similarity: Math.round(Number(r.similarity) * 1000) / 1000 }));
  if (!candidates.length) return finish('checked', [], 'No close matches found among the remaining active facts (this does not prove every rewording is gone).');
  const entity = anchor.entity_slug ? ` (recall entity: ${anchor.entity_slug})` : '';
  return finish('checked', candidates,
    `Close matches are not necessarily the same claim. Show these facts to the user${entity} and forget one only if the user confirms it restates what they withdrew.`);
}
