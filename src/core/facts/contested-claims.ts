/**
 * recall's contested label for facts in a pending decide proposal (GBRA-216
 * PR B): the keyless claim lane (facts/claim-conflicts.ts) and the paid
 * conflict sweep file supersede proposals into decide_proposals; a delivered
 * fact named by one, with both facts still active, carries the same
 * contested shape trust proposals give (eligibility/labels.ts Contested), with
 * proposal_ref dp<id> and the other fact's id.
 *
 * Set only when the caller can read the other fact under the same read policy
 * as the delivered one (world-only for remote callers, private provenance
 * hidden when the caller cannot read private pages, the trust floor), so a
 * label never reveals a fact the caller cannot see. A row a trust proposal
 * already marks keeps that label. One batched read per call; a failed read
 * leaves the rows unlabeled and reports contested_unavailable, never failing
 * the recall.
 */
import type { BrainEngine } from '../engine.ts';
import type { Contested } from '../eligibility/labels.ts';
import type { ReadEligibility } from '../eligibility/policy.ts';
import { projectionEligibleSql } from '../eligibility/sql.ts';
import { privateProvenanceFilterFragment } from '../search/private-visibility.ts';

export interface ContestedReadPolicy { remote: boolean; excludePrivate: boolean; eligibility?: ReadEligibility }
/** Filled when the lookup failed: recall reports it as facts_degraded. */
export interface ContestedLookup { degraded?: { reason: 'contested_unavailable' } }

const active = (a: string) => a + '.expired_at IS NULL AND (' + a + '.valid_until IS NULL OR ' + a + '.valid_until > now())';
const readable = (a: string, policy: ContestedReadPolicy) => [
  active(a),
  ...(policy.remote ? [a + ".visibility = 'world'"] : []),
  ...(policy.excludePrivate ? [privateProvenanceFilterFragment(a)] : []),
  projectionEligibleSql('facts', a, policy.eligibility),
].join(' AND ');

/** Adds contested to each row in a pending decide proposal whose other fact the caller can read. */
export async function withDecideContested<T extends { id: number; contested?: Contested }>(engine: Pick<BrainEngine, 'executeRaw'>, rows: T[],
  policy: ContestedReadPolicy, state: ContestedLookup): Promise<T[]> {
  const ids = rows.filter(r => !r.contested).map(r => Number(r.id)).filter(Number.isSafeInteger);
  if (ids.length === 0) return rows;
  let found: Array<{ id: number | string; delivered: number | string; new_fact_id: number | string; old_fact_id: number | string }>;
  try {
    found = await engine.executeRaw(
      'SELECT p.id, x.id AS delivered, p.new_fact_id, p.old_fact_id FROM unnest($1::bigint[]) AS x(id)\n'
      + "  JOIN decide_proposals p ON p.status = 'pending' AND (p.new_fact_id = x.id OR p.old_fact_id = x.id)\n"
      + '  JOIN facts n ON n.id = p.new_fact_id AND n.source_id = p.source_id\n'
      + '  JOIN facts o ON o.id = p.old_fact_id AND o.source_id = p.source_id\n'
      + ' WHERE ' + readable('n', policy) + ' AND ' + readable('o', policy) + '\n'
      + ' ORDER BY p.id', [ids]);
  } catch {
    state.degraded = { reason: 'contested_unavailable' };
    return rows;
  }
  const byFact = new Map<number, Contested>();
  for (const f of found) {
    const delivered = Number(f.delivered);
    if (byFact.has(delivered)) continue;
    const challenger = delivered === Number(f.new_fact_id);
    byFact.set(delivered, { proposal_ref: 'dp' + Number(f.id), role: challenger ? 'challenger' : 'challenged', fact_id: String(Number(challenger ? f.old_fact_id : f.new_fact_id)) });
  }
  return rows.map(r => (r.contested || !byFact.has(Number(r.id)) ? r : { ...r, contested: byFact.get(Number(r.id))! }));
}
