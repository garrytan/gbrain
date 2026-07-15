// v0.39 T12 — dream-cycle schema-suggest phase.
//
// Thin wrapper around `runSuggest()` library (D4 from plan-eng-review:
// single library, multiple thin callers). Runs AFTER `sync` (not after
// `extract` per the original plan — schema-suggest only needs sync to
// have completed so source_path is fresh; it doesn't depend on extract,
// extract_facts, resolve_symbol_edges, or patterns).
//
// Writes nothing to the user's brain. Writes candidates to
// `~/.gbrain/audit/schema-candidates-YYYY-Www.jsonl` (T15 audit).
// Reviewed via `gbrain schema review-candidates`.

import type { BrainEngine } from '../engine.ts';
import { runSuggest } from '../schema-pack/suggest.ts';
import { logSchemaEvent } from '../schema-events.ts';

export interface SchemaSuggestPhaseOpts {
  sourceId?: string;
  dryRun?: boolean;
}

export interface SchemaSuggestPhaseResult {
  suggestions_emitted: number;
  source_id: string;
  skipped: boolean;
  reason?: string;
}

export async function runSchemaSuggestPhase(
  engine: BrainEngine,
  opts: SchemaSuggestPhaseOpts = {},
): Promise<SchemaSuggestPhaseResult> {
  const sourceId = opts.sourceId ?? 'default';

  // Dry-run still calls runSuggest but logs only — no audit append.
  if (opts.dryRun) {
    const result = await runSuggest(engine, { sourceId });
    return {
      suggestions_emitted: result.suggestions.length,
      source_id: sourceId,
      skipped: false,
      reason: 'dry-run',
    };
  }

  try {
    const result = await runSuggest(engine, { sourceId });
    logSchemaEvent({
      verb: 'cycle:schema-suggest',
      outcome: 'success',
      flags: [`source=${sourceId}`, `count=${result.suggestions.length}`],
    });
    return {
      suggestions_emitted: result.suggestions.length,
      source_id: sourceId,
      skipped: false,
    };
  } catch (e) {
    logSchemaEvent({
      verb: 'cycle:schema-suggest',
      outcome: 'error',
      flags: [`source=${sourceId}`, `err=${(e as Error).message.slice(0, 80)}`],
    });
    return {
      suggestions_emitted: 0,
      source_id: sourceId,
      skipped: true,
      reason: (e as Error).message,
    };
  }
}
