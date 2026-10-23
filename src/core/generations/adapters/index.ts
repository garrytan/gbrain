/**
 * GBRA-161: the generation adapters by ledger kind. The repair command and doctor resolve a kind here; tests register a
 * synthetic adapter (test/helpers/synthetic-generation.ts).
 */
import type { GenerationAdapter } from '../contract.ts';
import { atomGenerationAdapter } from './atoms.ts';

const adapters = new Map<string, GenerationAdapter<unknown>>([[atomGenerationAdapter.kind, atomGenerationAdapter as GenerationAdapter<unknown>]]);

export function generationAdapter(kind: string): GenerationAdapter<unknown> | undefined { return adapters.get(kind); }
export function generationKinds(): string[] { return [...adapters.keys()]; }
/** Registers an adapter for a kind (tests and later PRs). */
export function registerGenerationAdapter(adapter: GenerationAdapter<unknown>): void { adapters.set(adapter.kind, adapter); }
