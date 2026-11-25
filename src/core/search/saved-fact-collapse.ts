/**
 * The columns a saved-fact read selects so capture-dedup can collapse its rows, in a module with no runtime imports.
 * engine-sql/facts-trust.ts (reached from postgres-engine.ts) imports them from here: entity-facts.ts statically
 * reaches the schema-pack YAML assets, which Node cannot load, and OpenClaw loads the engine under Node.
 */
import type { FactAttribution } from '../engine.ts';

export const SAVED_FACT_COLLAPSE_COLUMNS = 'f.source_id, f.visibility, f.created_at, f.attributed_to, gbrain_fact_fingerprint(f.fact) AS fact_fingerprint';
export type CollapseColumns = { source_id: string; visibility: string; created_at: Date | string; attributed_to: FactAttribution | null; fact_fingerprint: string };
