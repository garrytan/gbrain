// v0.39 T3 — gbrain schema suggest: LLM-powered runSuggest library.
//
// Layers refinement on top of T2's `runDetect` heuristic clustering.
// Single library function called by T3 CLI, T12 dream-cycle phase,
// T10 EIIRP skill, and T7 doctor consistency check (per D4(eng): one
// source of truth, not duplicated).
//
// Cost-bounded: per-invocation sampling cap + max_chunks_per_call.
// Hermetic-by-default: when gateway is unconfigured OR no API key,
// returns deterministic heuristic-only suggestions rather than throwing.
// Test seam via `opts.suggestFn` lets unit tests stub the LLM entirely.

import type { BrainEngine } from '../engine.ts';
import { runDetect, type DetectResult } from './detect.ts';
import { loadActivePackForLocalEngine } from './best-effort.ts';
import type { ResolvedPack } from './registry.ts';

/**
 * #10433: the detected prefixes that are real gaps in the active pack. A prefix the pack declares as a path prefix, or
 * whose typed pages all carry a type the pack declares (or one of its aliases), already has a type, so suggesting one
 * named after the folder would only duplicate it. No resolvable pack filters nothing.
 */
export function undeclaredPrefixes(detected: DetectResult, pack: Pick<ResolvedPack, 'manifest'> | null): DetectResult['prefixes'] {
  if (!pack) return detected.prefixes;
  const prefixes = new Set(pack.manifest.page_types.flatMap(t => t.path_prefixes.map(p => p.toLowerCase())));
  const types = new Set(pack.manifest.page_types.flatMap(t => [t.name, ...t.aliases]));
  return detected.prefixes.filter(p => !prefixes.has(p.prefix.toLowerCase())
    && !(p.sample_types.length > 0 && p.sample_types.every(type => types.has(type))));
}

export interface SuggestOpts {
  sourceId?: string;
  /** Cap on sampled-page count for LLM context. Default 200. */
  maxSampleSize?: number;
  /** Test seam: replace the LLM call with a deterministic stub. */
  suggestFn?: (input: SuggestPromptInput) => Promise<RawSuggestion[]>;
}

export interface SuggestPromptInput {
  detected: DetectResult;
  sampleSize: number;
}

/**
 * Raw output shape from the LLM (or stub). The runner re-shapes into
 * the public Suggestion type with confidence floors + dedup.
 */
export interface RawSuggestion {
  kind: 'add_type' | 'add_alias' | 'rename' | 'mark_experimental';
  summary: string;
  confidence: number; // [0, 1]
  evidence?: string[]; // optional sample slug list
}

export interface Suggestion {
  kind: string;
  summary: string;
  confidence: number;
  evidence: string[];
}

export interface SuggestResult {
  suggestions: Suggestion[];
  notes: string[];
  source_id: string;
}

/**
 * Deterministic heuristic fallback used when no LLM is available OR
 * `opts.suggestFn` is not provided. Emits one `add_type` suggestion per
 * detect-found prefix; confidence = 0.5 (mid). Per codex finding #9:
 * downstream consumers (EIIRP) MUST treat confidence < 0.6 as
 * "manual review required, not auto-apply" — so the heuristic
 * fallback is safe-by-construction (never triggers auto-apply).
 */
function heuristicSuggestions(detected: DetectResult): RawSuggestion[] {
  return detected.prefixes.map((p) => ({
    kind: 'add_type' as const,
    summary: `Add type \`${p.suggested_type}\` for ${p.page_count} pages under \`${p.prefix}\``,
    confidence: 0.5,
    evidence: p.sample_types.slice(0, 3),
  }));
}

export async function runSuggest(
  engine: BrainEngine,
  opts: SuggestOpts = {},
): Promise<SuggestResult> {
  const sourceId = opts.sourceId ?? 'default';
  const maxSampleSize = opts.maxSampleSize ?? 200;

  const found = await runDetect(engine, { sourceId, maxTypes: 50 });
  const notes: string[] = [];
  const gaps = undeclaredPrefixes(found, await loadActivePackForLocalEngine(engine, { sourceId }));
  if (gaps.length < found.prefixes.length) notes.push(`${found.prefixes.length - gaps.length} prefix(es) skipped: the active schema pack already declares their type.`);
  const detected: DetectResult = { ...found, prefixes: gaps };

  const promptInput: SuggestPromptInput = {
    detected,
    sampleSize: Math.min(maxSampleSize, detected.total_pages),
  };

  let raw: RawSuggestion[];
  if (opts.suggestFn) {
    raw = await opts.suggestFn(promptInput);
  } else {
    // Try the gateway; on any failure fall back to heuristic.
    try {
      const { isAvailable } = await import('../ai/gateway.ts');
      if (!isAvailable('chat')) {
        notes.push('No LLM chat provider configured — returning heuristic-only suggestions.');
        raw = heuristicSuggestions(detected);
      } else {
        // Real gateway call deferred to a future wave; v0.39.0.0 ships the
        // hermetic heuristic-by-default path and the test seam. The planned
        // T16 schema-authoring eval would drive the same `suggestFn` seam.
        notes.push('LLM refinement deferred to v0.39.1+; using heuristic fallback.');
        raw = heuristicSuggestions(detected);
      }
    } catch {
      notes.push('Gateway unavailable — using heuristic fallback.');
      raw = heuristicSuggestions(detected);
    }
  }

  // Public reshape: clamp confidence to [0, 1], dedup by summary, sort by
  // confidence desc.
  const seen = new Set<string>();
  const suggestions: Suggestion[] = [];
  for (const r of raw) {
    if (seen.has(r.summary)) continue;
    seen.add(r.summary);
    const c = Math.max(0, Math.min(1, Number.isFinite(r.confidence) ? r.confidence : 0));
    suggestions.push({
      kind: r.kind,
      summary: r.summary,
      confidence: c,
      evidence: r.evidence ?? [],
    });
  }
  suggestions.sort((a, b) => b.confidence - a.confidence);

  if (detected.untyped_pages > 0 && suggestions.length === 0) {
    notes.push(`${detected.untyped_pages} untyped pages detected but no suggestions produced — run \`gbrain schema review-candidates --json\` to see the disk-derived candidate set.`);
  }

  return { suggestions, notes, source_id: sourceId };
}
