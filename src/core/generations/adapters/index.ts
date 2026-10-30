/**
 * GBRA-161: the generation adapters by ledger kind. The repair command and doctor resolve a kind here; tests register a
 * synthetic adapter (test/helpers/synthetic-generation.ts).
 */
import type { GenerationAdapter } from '../contract.ts';
import { atomGenerationAdapter } from './atoms.ts';
import { consolidationAdapter, factFenceAdapter } from './fact-rows.ts';
import { takeFenceAdapter } from './take-rows.ts';
import { extractedFactsAdapter } from './extracted-facts.ts';
import { chronicleEventAdapter } from './chronicle-events.ts';
import { synthesisAdapter } from './synthesis.ts';
import { dreamSummaryAdapter, driftReportAdapter, thinkSynthesisAdapter } from './single-page.ts';

const adapters = new Map<string, GenerationAdapter<unknown>>([atomGenerationAdapter, factFenceAdapter, takeFenceAdapter, consolidationAdapter, extractedFactsAdapter,
  chronicleEventAdapter, synthesisAdapter, dreamSummaryAdapter, thinkSynthesisAdapter, driftReportAdapter].map(adapter => [adapter.kind, adapter as GenerationAdapter<unknown>]));

/** The adapter of `kind`; a hyphenated spelling (`chronicle-event`) names the same kind. */
export function generationAdapter(kind: string): GenerationAdapter<unknown> | undefined { return adapters.get(kind) ?? adapters.get(kind.replaceAll('-', '_')); }
export function generationKinds(): string[] { return [...adapters.keys()]; }
/** Registers an adapter for a kind (tests and later PRs). */
export function registerGenerationAdapter(adapter: GenerationAdapter<unknown>): void { adapters.set(adapter.kind, adapter); }
