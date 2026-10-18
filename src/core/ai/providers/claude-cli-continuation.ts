/**
 * #6791: Claude Code continues a response that hit its output cap on its own.
 * The query loop withholds the cap error, appends a meta nudge ("Output token
 * limit hit. Resume directly ...") and sends a second request; the model picks
 * up mid-thought. Print mode's `result` is then the text of the LAST assistant
 * message only, and its `stop_reason` is the continuation's (`end_turn`), so the
 * envelope alone reads as a complete answer that is really its tail.
 *
 * Every assistant message the loop yields reaches the SDK output, and with
 * `--output-format json --verbose` stdout is that whole event array (verified in
 * the Claude Code 2.1.296 bundle). The adapter therefore rebuilds the answer
 * from the call's own events, never from a session transcript on disk:
 * consecutive assistant events sharing a `message.id` are one API response
 * (one segment), and the answer is the segments' text in order.
 *
 * A rebuild is accepted only when it is provably this answer: the last
 * segment's final text block is the envelope's `result`, no event retracted a
 * segment, every earlier segment that carries text ended at the cap (or reports
 * no stop reason), and a nudge visible between segments asks to resume rather
 * than rewrite. Otherwise the call is `continuation_unproven`: the adapter
 * returns no text and no tool calls and finishes `length`, the outcome every
 * caller already escalates or retries on (#6523).
 */

/** CLAUDE_CODE_MAX_OUTPUT_TOKENS' default when the CLI's model table names none (Claude Code 2.1.x). */
export const CLAUDE_CLI_DEFAULT_OUTPUT_CAP = 32_000;

/**
 * Why a continued answer could not be proven, read from stdout only (no transcript is read):
 * `events_missing`: stdout was the bare result envelope, so the CLI ignored `--verbose`;
 * `no_assistant_events`: the event array carried no assistant message to rebuild from;
 * `segments_unmatched`: the assistant segments do not provably make up this answer.
 */
export type ContinuationUnprovenReason = 'events_missing' | 'no_assistant_events' | 'segments_unmatched';

/** The remedy each reason's stderr notice names. */
export const CONTINUATION_UNPROVEN_REMEDY: Record<ContinuationUnprovenReason, string> = {
  events_missing: 'upgrade the claude CLI: this one printed only the result envelope under --output-format json --verbose, without the session event array',
  no_assistant_events: 'upgrade the claude CLI: its --verbose event array carried no assistant messages to rebuild the answer from',
  segments_unmatched: "raise that caller's output cap (the setting its truncation warning names) so the answer fits without a continuation",
};

export type ClaudeCliAnswer =
  | { kind: 'answer'; text: string }
  | { kind: 'unproven'; reason: ContinuationUnprovenReason };

/** The parts of a print-mode run the resolution reads. */
export interface ClaudeCliRunView {
  result: string;
  stop_reason: string | null;
  num_turns?: number;
  usage?: { output_tokens?: number };
  /** The session's event array when stdout carried one; null for a bare envelope. */
  events: readonly unknown[] | null;
}

interface Segment {
  id: string;
  text: string;
  lastBlockText: string;
  stopReason: unknown;
  /** Text of the user events between the previous segment and this one. */
  nudges: string[];
}

const RESUME_NUDGE_RE = /\bResume directly\b/;

function record(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

function blocksOf(message: Record<string, unknown>): Array<Record<string, unknown>> {
  const content = message.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content.map(record).filter((b): b is Record<string, unknown> => b !== null) : [];
}

function textOf(blocks: Array<Record<string, unknown>>): string {
  return blocks.map(b => (b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('');
}

/** The call's assistant segments in order, or null when the events contradict a single linear answer. */
function readSegments(events: readonly unknown[]): Segment[] | null {
  const segments: Segment[] = [];
  const seen = new Set<string>();
  let nudges: string[] = [];
  for (const raw of events) {
    const event = record(raw);
    if (!event) continue;
    if (event.type === 'tombstone') return null;
    const message = record(event.message);
    if (event.type === 'user') {
      if (message && segments.length > 0) nudges.push(textOf(blocksOf(message)));
      continue;
    }
    if (event.type !== 'assistant' || !message || message.model === '<synthetic>') continue;
    if (event.parent_tool_use_id != null || typeof message.id !== 'string') return null;
    const blocks = blocksOf(message);
    const last = segments.at(-1);
    if (last && last.id === message.id) {
      last.text += textOf(blocks);
      if (blocks.length > 0) last.lastBlockText = textOf(blocks.slice(-1));
      last.stopReason = message.stop_reason ?? last.stopReason;
      continue;
    }
    if (seen.has(message.id)) return null;
    seen.add(message.id);
    segments.push({ id: message.id, text: textOf(blocks), lastBlockText: textOf(blocks.slice(-1)), stopReason: message.stop_reason, nudges });
    nudges = [];
  }
  return segments;
}

function rebuild(segments: Segment[], result: string): string | null {
  const final = segments.at(-1)!;
  if (final.lastBlockText.trim() !== result.trim()) return null;
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i]!.text === '') continue;
    const stop = segments[i]!.stopReason;
    if (stop != null && stop !== 'max_tokens') return null;
    if (segments[i + 1]!.nudges.some(n => !RESUME_NUDGE_RE.test(n))) return null;
  }
  return segments.map(s => s.text).join('');
}

/**
 * Decide what text a print-mode run answered. A run with no continuation keeps
 * its envelope `result`; a continued run is rebuilt or refused. Continuation
 * shows as more than one segment; without events, as output above the cap
 * (`requestedCap`, forwarded as CLAUDE_CODE_MAX_OUTPUT_TOKENS, else the CLI
 * default) or more than one turn. One segment with output above a REQUESTED
 * cap contradicts the events (one API call cannot exceed it); the CLI default
 * is not that firm, since the CLI's model table can raise it.
 */
export function resolveClaudeCliAnswer(run: ClaudeCliRunView, requestedCap: number | undefined): ClaudeCliAnswer {
  const answer = { kind: 'answer', text: run.result } as const;
  if (run.stop_reason === 'max_tokens') return answer;
  const forwardedCap = typeof requestedCap === 'number' && Number.isInteger(requestedCap) && requestedCap > 0 ? requestedCap : undefined;
  const output = run.usage?.output_tokens;
  const overCap = typeof output === 'number' && output > (forwardedCap ?? CLAUDE_CLI_DEFAULT_OUTPUT_CAP);
  if (run.events === null) {
    return overCap || (run.num_turns ?? 1) > 1 ? unproven('events_missing') : answer;
  }
  const segments = readSegments(run.events);
  if (segments === null) return unproven('segments_unmatched');
  if (segments.length === 0) return overCap || (run.num_turns ?? 1) > 1 ? unproven('no_assistant_events') : answer;
  if (segments.length <= 1) return overCap && forwardedCap !== undefined ? unproven('segments_unmatched') : answer;
  const text = rebuild(segments, run.result);
  return text === null ? unproven('segments_unmatched') : { kind: 'answer', text };
}

const noticed = new Set<ContinuationUnprovenReason>();

function unproven(reason: ContinuationUnprovenReason): ClaudeCliAnswer {
  if (!noticed.has(reason)) {
    noticed.add(reason);
    process.stderr.write(`[claude-cli] continuation_unproven (${reason}): Claude Code continued an answer past its output cap and gbrain could not prove the full text, so the call finished as length with no text and no tool calls; the caller retries or escalates as for any capped answer. Remedy: ${CONTINUATION_UNPROVEN_REMEDY[reason]}. Details: gbrain errors continuation_unproven.\n`);
  }
  return { kind: 'unproven', reason };
}

/** Provider metadata of a refused continuation, under the provider's key. */
export function continuationUnprovenMetadata(reason: ContinuationUnprovenReason): { 'claude-cli': { code: 'continuation_unproven'; reason: ContinuationUnprovenReason } } {
  return { 'claude-cli': { code: 'continuation_unproven', reason } };
}
