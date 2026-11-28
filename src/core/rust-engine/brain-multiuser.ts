/**
 * The multi-user answer of the brain an engine reaches (I-0, multiuser-switch.ts), for callers that hold an engine: the
 * Rust engine's `brainMultiuser` (its store's answer as owner, the owner's answer as client), read from the engine itself
 * through any transaction clone, view or wrapper (engine-key.ts). False for any other engine and for none.
 */
import { engineKey } from '../engine-key.ts';

export function brainMultiuserOf(engine: object | null | undefined): boolean {
  if (!engine) return false;
  return (engineKey(engine) as { brainMultiuser?: unknown }).brainMultiuser === true;
}
