/**
 * Rotation for repair kinds whose candidates come back in the same order every
 * run (fences, slug-conflicts): a bare apply saves the key of each candidate it
 * attempts, and the next bare apply starts after it, so a candidate that keeps
 * failing (or a run that keeps stopping on a budget) cannot hold the rest back.
 * Stored in op_checkpoints under the kind's own op, keyed by brain.
 */
import type { BrainEngine } from '../engine.ts';

export async function rotationAfter(engine: BrainEngine, op: string, brainId: string): Promise<string | null> {
  const record = await engine.readOpCheckpointRecord(op, brainId);
  const last = Array.isArray(record?.completed_keys) ? (record.completed_keys[0] as { last?: unknown } | undefined)?.last : undefined;
  return last == null ? null : String(last);
}

export async function saveRotation(engine: BrainEngine, op: string, brainId: string, last: string): Promise<void> {
  await engine.writeOpCheckpointRecord(op, brainId, [{ last }]);
}

/** The candidates after `rotation` first, then the rest, each part in its original order. */
export function rotate<T>(items: readonly T[], key: (item: T) => string, rotation: string | null): T[] {
  return rotation ? [...items.filter(item => key(item) > rotation), ...items.filter(item => key(item) <= rotation)] : [...items];
}

/**
 * A candidate's rotation key: source, then the kind's key, ordered by source first. U+0001 separates them because jsonb
 * refuses U+0000, which made every saved rotation fail before GBRA-130.
 */
export function rotationKeyOf(sourceId: string, key: string): string {
  return `${sourceId}\u0001${key}`;
}

/** The brain id a handler's apply stores its rotation under. */
export async function rotationBrain(engine: BrainEngine): Promise<string> {
  return (await engine.readPersistenceBrainId().catch(() => null)) ?? 'host';
}
