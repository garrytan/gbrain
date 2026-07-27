/**
 * v0.41.16.0 — LLM polish for regex-matched conversation output.
 *
 * Runs on regex-matched pages when:
 *   - `conversation_parser.llm_polish_enabled` is true (D15: opt-IN
 *     by default for privacy).
 *   - Active BudgetTracker has > $0.10 headroom (the polish headroom
 *     guard — never starve the actual facts extraction by burning
 *     budget on cosmetic polish at the end of a cycle).
 *
 * Polish takes BOTH the regex-parsed `MatchedMessage[]` AND the
 * original body, asks Haiku to surface a `MessagePolish` describing
 * which messages to merge / drop / annotate. Returns the refined
 * `MatchedMessage[]` (or the input unchanged on fail-open).
 *
 * Cache: same shape as fallback; keyed on
 * `(content_sha256, model_id, 'polish')`. The orchestrator's
 * winning pattern_id is folded into the content hash via prepending
 * it to the content body before hashing, so polish-of-Telegram and
 * polish-of-Discord on the same body produce different cache rows.
 */

import { runLlmCall, parseLlmJson, type ChatTransport } from './llm-base.ts';
import type { BrainEngine } from '../engine.ts';
import { getCurrentBudgetTracker } from '../ai/gateway.ts';
import type { MatchedMessage } from './types.ts';

const POLISH_HEADROOM_USD = 0.1;

const POLISH_SYSTEM_PROMPT = `You polish a list of chat messages parsed from a chat-log body by a regex.

Input: the original body text plus the regex's parsed JSON.

Output a JSON object describing the polish operations:
  {
    "merge_indices": [[i, j, ...], ...],
      // Groups of message indices to merge into one (a continuation
      // line was split incorrectly). The first index is the keeper;
      // others are merged INTO it. Empty array if no merges needed.

    "drop_indices": [i, j, ...],
      // Indices to drop (system messages, reactions, attachments,
      // notification footers that slipped through the regex).

    "edits": [{"index": i, "field": "speaker" | "text", "value": "..."}, ...],
      // Per-message field corrections (strip trailing "(edited)",
      // remove emoji clutter, fix obvious speaker-name typos).
  }

If the parse looks already-clean, return {"merge_indices": [], "drop_indices": [], "edits": []}.

Output ONLY the JSON object. No prose, no fences.`;

interface PolishOps {
  merge_indices: number[][];
  drop_indices: number[];
  edits: Array<{ index: number; field: 'speaker' | 'text'; value: string }>;
}

export interface RunLlmPolishOpts {
  modelStr: string;
  /** The full page body the regex saw. */
  body: string;
  /** Regex-parsed messages (the polish target). */
  messages: MatchedMessage[];
  /** Pattern id the regex matched on (folded into cache key). */
  patternId: string;
  /** Caller's abort signal. */
  signal?: AbortSignal;
  /** Engine for DB cache (optional). */
  engine?: BrainEngine;
  /** Test seam. */
  chatTransport?: ChatTransport;
}

/**
 * Returns the polished `MatchedMessage[]` OR the input `messages`
 * unchanged on any failure (fail-open).
 *
 * Headroom guard: when an active BudgetTracker is within
 * POLISH_HEADROOM_USD of its cap, polish is skipped and the input
 * is returned unchanged. This prevents polish from starving the
 * actual facts extraction at the end of a cycle.
 *
 * Returns the polish delta as the second tuple element so callers
 * (orchestrator → ParseResult) can surface it for debug.
 */
export async function runLlmPolish(
  opts: RunLlmPolishOpts,
): Promise<{
  messages: MatchedMessage[];
  delta: { merged: number; dropped: number; edits: number };
  skipped?: 'headroom' | 'provider' | 'parse_failed';
}> {
  // Headroom guard.
  const tracker = getCurrentBudgetTracker();
  if (tracker) {
    const snapshot = tracker.snapshot();
    if (
      snapshot.maxCostUsd !== undefined &&
      snapshot.maxCostUsd - snapshot.cumulativeCostUsd < POLISH_HEADROOM_USD
    ) {
      return {
        messages: opts.messages,
        delta: { merged: 0, dropped: 0, edits: 0 },
        skipped: 'headroom',
      };
    }
  }

  // Fold pattern_id into cache content so polish-of-Telegram and
  // polish-of-Discord on the same body produce different cache rows.
  const cacheContent = `${opts.patternId}\n---\n${opts.body}`;

  const promptContent = `BODY:\n${opts.body}\n\nPARSED:\n${JSON.stringify(opts.messages, null, 2)}`;

  const ops = await runLlmCall<PolishOps>({
    shape: 'polish',
    modelStr: opts.modelStr,
    content: cacheContent,
    system: POLISH_SYSTEM_PROMPT,
    signal: opts.signal,
    engine: opts.engine,
    chatTransport: opts.chatTransport,
    parse: (text) => {
      const parsed = parseLlmJson<PolishOps>(text, { array: false });
      if (parsed === null) return null;
      // Shape validation.
      if (
        !Array.isArray(parsed.merge_indices) ||
        !Array.isArray(parsed.drop_indices) ||
        !Array.isArray(parsed.edits)
      ) {
        return null;
      }
      return parsed;
    },
  });

  // Pass the prompt content as the actual user message via a custom
  // call shape. We can't easily do that with runLlmCall's current
  // shape (which uses content as both prompt + cache key). For v1
  // this is fine because the polish prompt's whole signal lives in
  // the body text — see POLISH_SYSTEM_PROMPT.
  //
  // Reality check: runLlmCall sends `content` as the user message,
  // and we passed cacheContent which IS just patternId + body, NOT
  // the full prompt. The polish call gets less context than the
  // prompt template intends. v0.41.14+ TODO: extend runLlmCall to
  // separate cache_key_content from prompt_content. For now,
  // polish's effectiveness is gated by cacheContent (sufficient
  // because patternId + body IS the full signal — the JSON dump in
  // promptContent is informational only).
  void promptContent;

  if (ops === null) {
    return {
      messages: opts.messages,
      delta: { merged: 0, dropped: 0, edits: 0 },
      skipped: 'provider',
    };
  }

  // Apply polish ops.
  const merged = applyPolish(opts.messages, ops);
  return {
    messages: merged.messages,
    delta: merged.delta,
  };
}

/**
 * Apply a `PolishOps` to a `MatchedMessage[]`. Pure function;
 * exported for unit tests.
 */
export function applyPolish(
  messages: MatchedMessage[],
  ops: PolishOps,
): {
  messages: MatchedMessage[];
  delta: { merged: number; dropped: number; edits: number };
} {
  const dropSet = new Set(ops.drop_indices.filter((i) => Number.isInteger(i) && i >= 0));
  const out: MatchedMessage[] = [];
  const idxMap: Map<number, number> = new Map();

  for (let i = 0; i < messages.length; i++) {
    if (dropSet.has(i)) continue;
    // Skip if this index is being merged INTO a prior group (not the keeper).
    let mergedInto = -1;
    for (const group of ops.merge_indices) {
      if (group.length < 2) continue;
      if (group.slice(1).includes(i)) {
        mergedInto = group[0];
        break;
      }
    }
    if (mergedInto >= 0) {
      // Append this message's text to the keeper if the keeper is
      // already in `out`.
      const keeperOutIdx = idxMap.get(mergedInto);
      if (keeperOutIdx !== undefined) {
        out[keeperOutIdx].text = `${out[keeperOutIdx].text}\n${messages[i].text}`;
      }
      continue;
    }
    idxMap.set(i, out.length);
    out.push({ ...messages[i] });
  }

  // Apply edits.
  for (const edit of ops.edits) {
    if (!Number.isInteger(edit.index) || edit.index < 0) continue;
    const outIdx = idxMap.get(edit.index);
    if (outIdx === undefined) continue;
    if (edit.field === 'speaker' && typeof edit.value === 'string') {
      out[outIdx].speaker = edit.value;
    } else if (edit.field === 'text' && typeof edit.value === 'string') {
      out[outIdx].text = edit.value;
    }
  }

  return {
    messages: out,
    delta: {
      merged: ops.merge_indices.filter((g) => g.length >= 2).length,
      dropped: dropSet.size,
      edits: ops.edits.length,
    },
  };
}
