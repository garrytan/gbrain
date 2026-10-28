/**
 * Harness ask 6 (GBRA-200): one stamp on every degraded or partial read
 * result, so an agent never relays a degraded answer as "the brain has no
 * notes on this". The stamp is derived, never produced by a handler: it reads
 * what a call already reports (its `_meta.retrieval.degraded` stages, the
 * degraded fields of its result body and the `kind: degraded` notices it
 * emitted, before any notice dedupe) and names each cause with a stable code.
 * Pure: callers pass the call's result, its response meta and its notices.
 *
 * MCP results carry it as `_meta.degraded` plus one text block
 * (`degradedStampLine`); CLI `--json` objects carry a `degraded` key and
 * every other CLI output prints the line on stderr. A clean result carries
 * nothing. docs/protocol/AGENT_OPERATOR_v1.md, "Degraded stamp".
 */
import type { Notice } from './agent-output.ts';
import type { RetrievalCoverage } from './search/retrieval-coverage.ts';
import { affectsRecall } from './types.ts';

export interface DegradedStamp {
  /** Stable reason codes, sorted and unique (the vocabulary is in the doc above). */
  reasons: string[];
}

/** Notices of kind `degraded` that say this call's own result is partial; the notice code is the reason. */
const RESULT_NOTICE_REASONS: ReadonlySet<string> = new Set([
  'held_files', 'sources_not_readable', 'references_unavailable', 'mention_index',
  'relational_chain', 'graph_walk_truncated', 'pinned_answer_stale', 'facts_unembedded', 'delta_incomplete',
]);

/** One condition, one code: recall's keyword-only markers name the stage search and query already use. */
const KEYWORD_ONLY_MARKERS: ReadonlySet<string> = new Set(['keyword_only_no_embedding_provider', 'keyword_only_embedding_disabled']);
const stageCode = (stage: string): string => (KEYWORD_ONLY_MARKERS.has(stage) ? 'embed_unavailable' : stage);

/** think and synthesize warnings that mean the gathered evidence is partial. */
const QUESTION_EMBED_WARNINGS: ReadonlySet<string> = new Set(['QUESTION_EMBED_FAILED', 'QUESTION_EMBED_SKIPPED_EMBEDDING_DISABLED']);
/** think's gather reports a degraded retrieval stage as `GATHER_DEGRADED:<stage>`. */
export const GATHER_DEGRADED_PREFIX = 'GATHER_DEGRADED:';

/** The marker that opens the one-line text form; `[gbrain degraded: <code>, <code>]`. */
export const DEGRADED_STAMP_PREFIX = '[gbrain degraded: ';

type Stage = { stage?: unknown; reason?: unknown };

/**
 * The stamp for one successful call, or null when nothing about it was
 * degraded. `meta` is the call's response meta (`{ retrieval }` on the CLI);
 * `notices` are every notice the call produced, before dedupe.
 */
export function degradedStampFor(
  op: string, result: unknown, meta: Record<string, unknown> | null | undefined, notices: readonly Notice[] = [],
): DegradedStamp | null {
  const reasons = new Set<string>();
  const retrieval = (meta?.retrieval ?? null) as { degraded?: Stage[]; coverage?: RetrievalCoverage } | null;
  const pendingCould = retrieval?.coverage?.could_affect?.pending_projection;
  for (const d of Array.isArray(retrieval?.degraded) ? retrieval!.degraded : []) {
    if (typeof d?.stage !== 'string' || !affectsRecall(d as { stage: string })) continue;
    if (d.stage === 'projection_pending' && pendingCould === 0) continue;
    reasons.add(stageCode(d.stage));
  }
  const r = (result && typeof result === 'object' && !Array.isArray(result) ? result : {}) as Record<string, unknown>;
  if (typeof r.search_degraded === 'string') reasons.add('embed_unavailable');
  const facts = r.facts_degraded as { reason?: unknown; unembedded?: unknown } | undefined;
  if (typeof facts?.reason === 'string') reasons.add(stageCode(facts.reason));
  if (typeof facts?.unembedded === 'number' && facts.unembedded > 0) reasons.add('facts_unembedded');
  if (typeof r.degraded_reason === 'string') {
    if (op === 'delta') reasons.add('delta_incomplete');
    else for (const part of r.degraded_reason.split(',')) if (part.trim()) reasons.add(part.trim());
  }
  if (op === 'get_page' && r.file_held !== undefined && r.file_held !== null) reasons.add('file_held');
  if (op === 'think' || op === 'synthesize') {
    for (const w of Array.isArray(r.warnings) ? r.warnings : []) {
      if (typeof w !== 'string') continue;
      if (QUESTION_EMBED_WARNINGS.has(w)) reasons.add('embed_unavailable');
      else if (w.startsWith(GATHER_DEGRADED_PREFIX)) reasons.add(stageCode(w.slice(GATHER_DEGRADED_PREFIX.length)));
      else if (/^GATHER_[A-Z_]+_FAILED$/.test(w)) reasons.add(w.toLowerCase());
    }
  }
  if (op === 'search_exact' && Array.isArray(r.incomplete_reasons)) {
    for (const why of r.incomplete_reasons) if (why === 'deadline' || why === 'unreadable_pages') reasons.add(why === 'deadline' ? 'scan_deadline' : why);
  }
  if (op === 'open_loops') {
    if (r.stale === true) reasons.add('source_stale');
    if (r.completeness === 'partial') reasons.add('held_items');
  }
  if (op === 'rank_entities') {
    const state = (r.coverage as { state?: unknown } | undefined)?.state;
    if (state === 'behind' || state === 'unread') reasons.add(`link_coverage_${state}`);
  }
  for (const n of notices) if (n.kind === 'degraded' && RESULT_NOTICE_REASONS.has(n.code)) reasons.add(n.code);
  return reasons.size ? { reasons: [...reasons].sort() } : null;
}

/** The one-line text form an agent can relay; never longer than one line. */
export function degradedStampLine(stamp: DegradedStamp): string {
  return `${DEGRADED_STAMP_PREFIX}${stamp.reasons.join(', ')}] This result is partial or degraded: never report "no notes" or "not found" from it.`;
}
