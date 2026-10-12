/**
 * subagent-stop-reason — the one mapping from what a provider turn produced
 * to the `SubagentStopReason` the subagent handler reports (#6448).
 *
 * The handler used to classify a turn by its `stop_reason` and whether it
 * carried tool calls, never by whether it produced an answer: a turn with no
 * text (a refusal with an empty body, a thinking-only turn, a blank string)
 * reported `end_turn`, and `finalizeWriteAccounting` then treated the empty
 * result as a clean finish. These helpers make "finished with nothing" its
 * own answer (`error`, which `SubagentStopReason` already defines as "empty
 * response") on the direct Messages path, the gateway path and both replay
 * paths, and keep the output-cap (`max_tokens`) and `refusal` words.
 */
import type { SubagentStopReason } from './types.ts';
import type { ToolLoopStopReason } from '../ai/gateway.ts';

/** True when the final text carries no answer (empty, or whitespace only). */
export function isEmptyFinalText(text: string | null | undefined): boolean {
  return text == null || text.trim() === '';
}

/**
 * Direct Messages path: the terminal turn's provider `stop_reason` plus the
 * text it produced. `max_tokens` wins over empty (a truncated reply may have
 * lost its text); `refusal` is reported as such (Claude 5 / Haiku 5.5 stop
 * with `stop_reason: "refusal"`); an empty body on a clean stop is `error`.
 */
export function directStopReason(
  providerStopReason: string | null | undefined,
  finalText: string,
): SubagentStopReason {
  if (providerStopReason === 'max_tokens') return 'max_tokens';
  if (providerStopReason === 'refusal') return 'refusal';
  if (isEmptyFinalText(finalText)) return 'error';
  return 'end_turn';
}

/**
 * Gateway path: `toolLoop`'s stop reason. `length` is the output cap
 * (#2778 / #4088 honesty vocabulary); `empty_response`, `aborted` and
 * `unrecoverable` are all `error` (the loop produced no answer); `refusal`
 * and `content_filter` are `refusal`.
 */
export function gatewayStopReason(stop: ToolLoopStopReason): SubagentStopReason {
  switch (stop) {
    case 'end': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'max_turns': return 'max_turns';
    case 'refusal':
    case 'content_filter':
      return 'refusal';
    case 'empty_response':
    case 'aborted':
    case 'unrecoverable':
      return 'error';
  }
}

/**
 * Replay of a persisted terminal assistant turn (both paths). The live stop
 * reason is not persisted; `tokens_out >= cap` recovers an output-cap stop
 * (F1: a truncated zero-write run must not launder into `end_turn`, #4217),
 * and a persisted turn whose text is empty replays as `error` without a new
 * provider request (re-sending it would be an assistant prefill, which
 * Sonnet 4.6+ and Haiku 5.5 reject with HTTP 400).
 */
export function replayTerminalStopReason(
  tokensOut: number | null | undefined,
  maxOutputTokens: number,
  finalText: string,
): SubagentStopReason {
  if (tokensOut != null && tokensOut >= maxOutputTokens) return 'max_tokens';
  return isEmptyFinalText(finalText) ? 'error' : 'end_turn';
}
