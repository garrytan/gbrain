import type { BrainEngine } from '../engine.ts';
import { storedClaim } from '../facts/typed-claim.ts';
import { nonUserSpeaker } from '../facts/attribution.ts';
import { assertFactNotWithdrawn, readReplacementTarget } from '../facts/single-prepare.ts';
import { opError } from '../ops/contract.ts';
import type { WriteGateHold } from '../write-gate-store.ts';

/** A release appends a separate reviewed assertion. Its saved attribution must still describe the original. */
export async function assertHeldRestatementCurrent(engine: BrainEngine, hold: Pick<WriteGateHold, 'id' | 'source_id' | 'payload'>, lock = false): Promise<void> {
  const p = hold.payload;
  const speaker = nonUserSpeaker(p.replacement_speaker);
  if (!speaker) return;
  const end = p.valid_until ?? null;
  const original = typeof p.replaces === 'number' && Number.isSafeInteger(p.replaces) && (end === null || typeof end === 'string')
    ? await readReplacementTarget(engine, hold.source_id, p.replaces, { requiredValidUntil: end, lock })
    : undefined;
  if (!original || original.withdrawn || original.attributed_to !== speaker || original.kind !== p.kind || original.visibility !== p.visibility ||
      original.entity_slug !== (p.entity_slug ?? null) || JSON.stringify(storedClaim(original)) !== JSON.stringify(storedClaim(p)) ||
      typeof p.valid_from !== 'string' || p.fact !== `${p.valid_from.slice(0, 10)}: ${original.fact}`) {
    throw opError('preview_changed', `The original fact for h${hold.id} changed. The dated restatement stays held.`,
      'Read the original fact and its source again before making a new correction.');
  }
  await assertFactNotWithdrawn(engine, hold.source_id, original);
}
