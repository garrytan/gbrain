/** Source-bound relink audit locks. Keep the evidence page body on the canonical read path. */
import type { BrainEngine } from '../engine.ts';

type Query = Pick<BrainEngine, 'executeRaw'>;

export async function lockReviewFact(tx: Query, source: string, id: number) {
  const [fact] = await tx.executeRaw<{ fact: string; source_session: string | null }>(
    `SELECT fact,source_session FROM facts WHERE source_id=$1 AND id=$2
      AND entity_slug IS NULL AND expired_at IS NULL FOR UPDATE`, [source, id]);
  return fact;
}

export async function lockReviewMemo(tx: Query, source: string, id: number) {
  const [memo] = await tx.executeRaw<{ memo: Record<string, unknown> }>(
    'SELECT to_jsonb(a) AS memo FROM fact_relink_attempts a WHERE source_id=$1 AND fact_id=$2 FOR UPDATE', [source, id]);
  return memo;
}

export async function lockReviewEvidence(tx: Query, source: string, slug: string, revision: string): Promise<boolean> {
  const [page] = await tx.executeRaw<{ id: number }>(
    `SELECT id FROM pages WHERE source_id=$1 AND slug=$2 AND knowledge_revision::text=$3 AND deleted_at IS NULL FOR SHARE`,
    [source, slug, revision]);
  return page !== undefined;
}

export async function publishReviewMemo(tx: Query, source: string, id: number, outcome: 'no_subject' | 'no_page', ref: string): Promise<void> {
  await tx.executeRaw(`UPDATE fact_relink_attempts SET outcome=$3,reason=$3,tier='operator',model=NULL,
    target_slug=NULL,run_id=$4,attempted_at=now() WHERE source_id=$1 AND fact_id=$2`, [source, id, outcome, ref]);
}
