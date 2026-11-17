import type { BrainEngine } from '../../src/core/engine.ts';

/**
 * GST-2900: the newest supersede_fact proposal holding a world restatement of `claim` in `sourceId` (one whose
 * before_state carries the widening), as `tp<id>`. The reply to a held write no longer names it to a caller who cannot
 * read the private copy, so a test that decides the hold reads its ref here.
 */
export async function heldProposalRef(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, claim: string): Promise<string> {
  const [row] = await engine.executeRaw<{ id: number | string }>(
    `SELECT tp.id FROM trust_proposals tp JOIN facts f ON tp.related_table = 'facts' AND f.id = tp.related_id
      WHERE tp.action = 'supersede_fact' AND tp.source_id = $1 AND f.fact = $2 AND tp.before_state->'visibility' IS NOT NULL
      ORDER BY tp.id DESC LIMIT 1`, [sourceId, claim]);
  if (!row) throw new Error(`no held restatement of "${claim}" in ${sourceId}`);
  return 'tp' + Number(row.id);
}
