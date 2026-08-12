// v0.39 T3 — gbrain schema suggest: LLM-powered runSuggest library.
//
// Layers refinement on top of T2's `runDetect` heuristic clustering.
// Single library function called by T3 CLI, T12 dream-cycle phase,
// T10 EIIRP skill, and T7 doctor consistency check (per D4(eng): one
// source of truth, not duplicated).
//
// Cost-bounded: one gateway request per invocation, with a bounded detector
// payload and output token cap. Hermetic-by-default: when the gateway is
// unconfigured, returns deterministic heuristic-only suggestions. Test seams
// let unit tests exercise both the direct suggestion and native gateway paths.

import type { BrainEngine } from '../engine.ts';
import { chat as gatewayChat, getChatModel, isAvailable } from '../ai/gateway.ts';
import { resolveModel } from '../model-config.ts';
import { runDetect, type DetectResult } from './detect.ts';

export interface SuggestOpts {
  sourceId?: string;
  /** Cap on sampled-page count for LLM context. Default 200. */
  maxSampleSize?: number;
  /** Test seam: replace the LLM call with a deterministic stub. */
  suggestFn?: (input: SuggestPromptInput) => Promise<RawSuggestion[]>;
  /** Explicit model override; otherwise resolves through models.schema_suggest. */
  model?: string;
  /** Test seam for the provider-neutral gateway call. */
  _chat?: typeof gatewayChat;
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

const SCHEMA_SUGGEST_PROMPT = `You refine schema-pack suggestions for a personal knowledge brain.

Given a bounded, aggregate-only detector report, propose only useful schema changes. Do not invent page prefixes, types, or evidence that are absent from the report.

Output ONLY one JSON object with this shape:
{"suggestions":[{"kind":"add_type|add_alias|rename|mark_experimental","summary":"concise operator-reviewable change","confidence":0.0,"evidence":["prefix or observed type"]}]}

Return at most 20 suggestions. Confidence must be between 0 and 1. An empty suggestions array is valid when the detected schema already fits.`;

const SUGGESTION_KINDS = new Set<RawSuggestion['kind']>([
  'add_type',
  'add_alias',
  'rename',
  'mark_experimental',
]);

/** Parse and validate the native gateway response. Exported for regression tests. */
export function parseSchemaSuggestions(raw: string): RawSuggestion[] {
  if (!raw || !raw.trim()) throw new Error('schema-suggest model returned empty output');
  let text = raw.trim();
  const fenced = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenced) text = (fenced[1] ?? '').trim();
  const objectStart = text.indexOf('{');
  const arrayStart = text.indexOf('[');
  const start = objectStart === -1
    ? arrayStart
    : arrayStart === -1
      ? objectStart
      : Math.min(objectStart, arrayStart);
  if (start === -1) throw new Error('schema-suggest model output was not JSON');

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start));
  } catch {
    throw new Error('schema-suggest model output was malformed JSON');
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { suggestions?: unknown }).suggestions)
      ? (parsed as { suggestions: unknown[] }).suggestions
      : null;
  if (!rows) throw new Error('schema-suggest model output omitted suggestions[]');

  const suggestions: RawSuggestion[] = [];
  for (const row of rows.slice(0, 20)) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    if (!SUGGESTION_KINDS.has(r.kind as RawSuggestion['kind'])) continue;
    if (typeof r.summary !== 'string' || !r.summary.trim()) continue;
    const confidence = typeof r.confidence === 'number'
      ? r.confidence
      : Number.parseFloat(String(r.confidence ?? ''));
    if (!Number.isFinite(confidence)) continue;
    suggestions.push({
      kind: r.kind as RawSuggestion['kind'],
      summary: r.summary.trim().slice(0, 500),
      confidence: Math.max(0, Math.min(1, confidence)),
      evidence: Array.isArray(r.evidence)
        ? r.evidence.filter((v): v is string => typeof v === 'string').slice(0, 10)
        : [],
    });
  }
  return suggestions;
}

export async function runSuggest(
  engine: BrainEngine,
  opts: SuggestOpts = {},
): Promise<SuggestResult> {
  const sourceId = opts.sourceId ?? 'default';
  const maxSampleSize = opts.maxSampleSize ?? 200;

  const detected = await runDetect(engine, { sourceId, maxTypes: 50 });
  const notes: string[] = [];

  const promptInput: SuggestPromptInput = {
    detected,
    sampleSize: Math.min(maxSampleSize, detected.total_pages),
  };

  let raw: RawSuggestion[];
  if (opts.suggestFn) {
    raw = await opts.suggestFn(promptInput);
  } else {
    // Use the same provider-neutral gateway and model resolver as the other
    // model-bearing dream phases. An unavailable or failed provider remains
    // an explicit heuristic fallback in notes; it is never mislabeled as LLM
    // refinement.
    try {
      const chat = opts._chat ?? gatewayChat;
      if (!opts._chat && !isAvailable('chat')) {
        notes.push('No LLM chat provider configured — returning heuristic-only suggestions.');
        raw = heuristicSuggestions(detected);
      } else {
        const model = await resolveModel(engine, {
          cliFlag: opts.model,
          configKey: 'models.schema_suggest',
          tier: 'reasoning',
          fallback: getChatModel(),
        });
        const detectorPayload = {
          source_id: sourceId,
          total_pages: detected.total_pages,
          typed_pages: detected.typed_pages,
          untyped_pages: detected.untyped_pages,
          prefixes: detected.prefixes.slice(0, 50),
          candidate_page_types: detected.candidate.page_types.slice(0, 50),
          sample_size: promptInput.sampleSize,
        };
        const response = await chat({
          model,
          system: SCHEMA_SUGGEST_PROMPT,
          messages: [{ role: 'user', content: JSON.stringify(detectorPayload) }],
          maxTokens: 1_200,
        });
        raw = parseSchemaSuggestions(response.text);
        notes.push(`LLM refinement completed with ${model}.`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notes.push(`LLM refinement failed (${message.slice(0, 160)}) — using heuristic fallback.`);
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
