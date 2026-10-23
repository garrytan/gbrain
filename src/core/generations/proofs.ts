/**
 * GBRA-161 D4: the only ways an empty result may retire a live generation. A model returning nothing, or a parse that
 * produced no items, is never evidence that the input is empty; each proof below is rechecked under the key lock against
 * the input as stored and the live generation's pin, and a proof that does not hold publishes nothing (held `no_proof`).
 */
import type { InputState } from './contract.ts';

export type EmptySourceProof =
  /** The input is gone (deleted page, removed transcript) and a live generation was derived from it. */
  | { kind: 'originGone' }
  /** The input no longer qualifies for this kind; only an adapter that rechecks the rule accepts it (`proofHolds`: chronicle events). */
  | { kind: 'originIneligible'; reason: string }
  /** A canonical fence was read whole and holds no rows (fence kinds, PR 2). */
  | { kind: 'fenceParsedEmpty'; pin: string }
  /** The input changed since the live generation, and the change at `pin` committed the removal of every item. */
  | { kind: 'committedRemoval'; pin: string };

export const originGone = (): EmptySourceProof => ({ kind: 'originGone' });
export const fenceParsedEmpty = (pin: string): EmptySourceProof => ({ kind: 'fenceParsedEmpty', pin });
export const committedRemoval = (pin: string): EmptySourceProof => ({ kind: 'committedRemoval', pin });

/** Whether `proof` holds for the input as stored now (`input`) and the live generation's pin (`livePin`, null: no live generation). */
export function proofHolds(proof: EmptySourceProof, input: InputState | null, livePin: string | null | undefined, fenceKind = false): boolean {
  switch (proof.kind) {
    case 'originGone': return input === null && typeof livePin === 'string';
    case 'committedRemoval': return input !== null && input.pin === proof.pin && typeof livePin === 'string' && livePin !== proof.pin;
    case 'fenceParsedEmpty': return fenceKind && input !== null && input.pin === proof.pin;
    case 'originIneligible': return false;
  }
}
