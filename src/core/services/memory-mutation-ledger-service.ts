import { randomUUID } from 'crypto';
import type { BrainEngine } from '../engine.ts';
import type { MemoryMutationEvent, MemoryMutationEventInput } from '../types.ts';
import { normalizeMemoryMutationEventInput } from '../utils.ts';

export type MemoryMutationEventServiceInput =
  Omit<MemoryMutationEventInput, 'id'> & { id?: string };

export async function recordMemoryMutationEvent(
  engine: BrainEngine,
  input: MemoryMutationEventServiceInput,
): Promise<MemoryMutationEvent> {
  const normalized = normalizeMemoryMutationEventInput({
    ...input,
    id: input.id ?? randomUUID(),
  });
  return engine.createMemoryMutationEvent(normalized);
}
