import type { BrainEngine, FactRow } from '../engine.ts';
import { storedClaim, type ClaimParamKey } from '../facts/typed-claim.ts';
import { nonUserSpeaker } from '../facts/attribution.ts';
import { assertFactNotWithdrawn } from '../facts/single-prepare.ts';
import { opError } from '../ops/contract.ts';
import type { WriteGateHold } from '../write-gate-store.ts';

/** A release appends a separate reviewed assertion. Its saved attribution must still describe the original. */
export async function assertHeldRestatementCurrent(engine: BrainEngine, hold: Pick<WriteGateHold, 'id' | 'source_id' | 'payload'>, lock = false): Promise<void> {
  const p = hold.payload;
  const speaker = nonUserSpeaker(p.replacement_speaker);
  if (!speaker) return;
  const [original] = await engine.executeRaw<Pick<FactRow, 'fact' | 'kind' | 'visibility' | 'entity_slug' | ClaimParamKey>>(
    `SELECT fact,kind,visibility,entity_slug,claim_metric,claim_value,claim_unit,claim_period FROM facts WHERE source_id=$1 AND id=$2 AND attributed_to=$3 AND kind=$4
       AND visibility=$5 AND entity_slug IS NOT DISTINCT FROM $6 AND expired_at IS NULL AND superseded_by IS NULL
       AND valid_until IS NOT DISTINCT FROM $7::timestamptz AND (valid_until IS NULL OR valid_until>now())${lock ? ' FOR UPDATE' : ''}`,
    [hold.source_id, p.replaces, speaker, p.kind, p.visibility, p.entity_slug ?? null, p.valid_until ?? null]);
  if (!original || JSON.stringify(storedClaim(original)) !== JSON.stringify(storedClaim(p)) || typeof p.valid_from !== 'string' || p.fact !== `${p.valid_from.slice(0, 10)}: ${original.fact}`) {
    throw opError('preview_changed', `The original fact for h${hold.id} changed. The dated restatement stays held.`,
      'Read the original fact and its source again before making a new correction.');
  }
  await assertFactNotWithdrawn(engine, hold.source_id, original);
}
