// v0.42.x — Life Chronicle (#2390) agent-context loader (Phase B.12).
//
// Zero-LLM composition over the chronicle reads: hand an agent the recent
// timeline + the validity-resolved ontology for the entities in play, so it
// orients before acting (the exact thing missing when chronology gets fumbled).
// Pure composition of engine.getSince + engine.getOntology — no new SQL.
import type { BrainEngine } from '../engine.ts';
import type { ChronicleTimelineRow, OntologyValue } from '../types.ts';

export interface ChronicleContextOpts {
  /** Lookback window in days for the recent timeline (default 7). */
  days?: number;
  /** Entity slugs to resolve current ontology for (e.g. the people in the session). */
  entities?: string[];
  /** Cap on timeline rows (default 50). */
  limit?: number;
  /** Untrusted caller → diary-sourced ontology is redacted. */
  remote?: boolean;
  sourceId?: string;
  sourceIds?: string[];
}

export interface ChronicleContext {
  since: string;                                  // YYYY-MM-DD lower bound
  recent_timeline: ChronicleTimelineRow[];
  ontologies: Record<string, OntologyValue[]>;    // entity slug → current resolved values
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - Math.max(0, days) * 86_400_000).toISOString().slice(0, 10);
}

export async function loadChronicleContext(
  engine: BrainEngine,
  opts: ChronicleContextOpts = {},
): Promise<ChronicleContext> {
  const days = typeof opts.days === 'number' && opts.days > 0 ? opts.days : 7;
  const since = daysAgoIso(days);
  const scope = { sourceId: opts.sourceId, sourceIds: opts.sourceIds };

  const recent_timeline = await engine.getSince(since, { ...scope, limit: opts.limit ?? 50 });

  const ontologies: Record<string, OntologyValue[]> = {};
  for (const slug of opts.entities ?? []) {
    let vals = await engine.getOntology(slug, scope);
    if (opts.remote) vals = vals.filter((v) => !(v.source ?? '').startsWith('life/diary/'));
    if (vals.length) ontologies[slug] = vals;
  }
  return { since, recent_timeline, ontologies };
}
