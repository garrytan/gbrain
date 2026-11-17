/**
 * The typed refusal an engine throws for a capability it does not have (a Rust engine refuses raw SQL with
 * `engine_capability_missing`). Best-effort `catch` blocks must let it through: swallowing it turns "this engine
 * cannot do that" into a silent wrong answer.
 */
export function isEngineCapabilityRefusal(err: unknown): boolean {
  return (err as any)?.code === 'engine_capability_missing' || (err as any)?.envelope?.code === 'engine_capability_missing';
}

/** Call first in a best-effort `catch`: rethrows a capability refusal, returns for any other error. */
export function rethrowCapabilityRefusal(err: unknown): void {
  if (isEngineCapabilityRefusal(err)) throw err;
}
