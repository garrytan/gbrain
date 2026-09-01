/**
 * Ambient-writeback Stop-hook gate — the deterministic, zero-LLM salience
 * pre-filter (WP4/G). Runs in the ENGINE-FREE hook child under a hard
 * deadline, so: node builtins only, no engine, no config, no I/O.
 *
 * Two-filter design (OV-A8): this gate is the CHEAP filter that keeps
 * operational chatter from ever being banked ("Thanks" must produce zero
 * work with zero LLM — a hermetic-test guarantee); the extraction pipeline's
 * semantic skip rules remain the second, semantic filter. Rules fire in
 * order, FIRST HIT WINS, and every rule + reason is pinned by
 * test/facts/writeback-gate.test.ts — treat the rule list as a frozen
 * vocabulary (additive only; heartbeat reasons ride these codes).
 *
 * The hash is the turn's idempotency key (requirement 9): the wb corpus
 * file is named `<session>.wb-<hash24>.txt`, so a re-fired Stop hook for the
 * same turn re-derives the same name and short-circuits on the existing
 * file — deterministic, embedding-free dedup that works on keyless brains.
 */

import { createHash } from 'node:crypto';

/** Every gate skip is a BY-DESIGN filter outcome, not a failure — heartbeat
 * writers classify these `outcome: 'ok'` so alerting on 'degraded' never
 * fires on a "Thanks" (adversarial review, this wave). ONE canonical list;
 * the type derives from it. */
export const WRITEBACK_SKIP_REASONS = [
  'empty',
  'too_short',
  'ack_or_greeting',
  'slash_command',
  'question_only',
  'quoted_or_tool_output',
  'bulk_paste',
] as const;
export type WritebackSkipReason = (typeof WRITEBACK_SKIP_REASONS)[number];

export type WritebackGateResult =
  | { ok: true; normalized: string; hash24: string }
  | { ok: false; reason: WritebackSkipReason };

/** Min chars for a substantive turn; CJK-dense turns say more with less
 * ("我对花生过敏" is an allergy in six characters — F6), so the floor drops. */
export const MIN_TURN_CHARS = 20;
export const MIN_TURN_CHARS_CJK = 10;
/** Pasted/imported text is excluded unless the user explicitly asks — the
 * explicit-ask path is the agent calling remember/extract_facts itself. */
export const MAX_TURN_CHARS = 8000;

const CJK_RE = /[　-鿿豈-﫿가-힯぀-ヿ]/;

/** Pure acknowledgement / greeting lexicon — matched against the WHOLE
 * lowercased, punctuation-stripped text when it is ≤ 6 words. Repeated
 * alternation: any sequence of ack phrases (plus the filler tail tokens)
 * with nothing else present is an ack ("okay sounds good thanks so much"). */
const ACK_PHRASE =
  '(thanks|thank you|thx|ty|ok(ay)?|k+|sure|yes|yep|yeah|no|nope|got it|sounds good|great|perfect|nice|cool|awesome|good (morning|afternoon|evening|night)|hi|hello|hey|bye|goodbye|see you|lgtm|will do|done|please (do|continue)|go ahead|continue|proceed|stop|cancel|never ?mind|nvm|please|so much|a lot)';
const ACK_RE = new RegExp(`^${ACK_PHRASE}((\\s|,)+${ACK_PHRASE})*$`);

function stripQuotedAndToolOutput(text: string): string {
  // Fenced code blocks.
  let out = text.replace(/```[\s\S]*?(```|$)/g, ' ');
  const lines = out.split('\n');
  const kept: string[] = [];
  let indentRun: string[] = [];
  const flushRun = () => {
    // Runs of ≥3 consecutive deeply-indented lines read as pasted tool
    // output; shorter runs are ordinary formatting and are kept.
    if (indentRun.length > 0 && indentRun.length < 3) kept.push(...indentRun);
    indentRun = [];
  };
  for (const line of lines) {
    if (line.trimStart().startsWith('>')) continue; // quoted material
    if (/^\s{4,}\S/.test(line)) { indentRun.push(line); continue; }
    flushRun();
    kept.push(line);
  }
  flushRun();
  return kept.join('\n');
}

/** NFC + trim + collapse whitespace runs — the canonical form the hash and
 * downstream extraction both see. */
export function normalizeTurnText(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

export function turnHash24(normalized: string): string {
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 24);
}

export function gateWritebackTurn(text: unknown): WritebackGateResult {
  if (typeof text !== 'string') return { ok: false, reason: 'empty' };
  const trimmed = text.trim();

  // 1. empty
  if (trimmed.length === 0) return { ok: false, reason: 'empty' };

  // 2. too_short (CJK-aware floor — F6)
  const minChars = CJK_RE.test(trimmed) ? MIN_TURN_CHARS_CJK : MIN_TURN_CHARS;
  if (trimmed.length < minChars) return { ok: false, reason: 'too_short' };

  // 3. bulk_paste — hoisted ABOVE the regex/split rules (performance review,
  // this wave): a multi-megabyte paste can never pass the gate, so it must
  // not pay several full-text O(n) passes inside the 2s Stop budget before a
  // single length compare rejects it.
  if (trimmed.length > MAX_TURN_CHARS) return { ok: false, reason: 'bulk_paste' };

  // 4. ack_or_greeting: ≤6 words AND the whole text is lexicon-matched.
  const bare = trimmed.toLowerCase().replace(/[.!?,;:~……]+$/gu, '').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').trim();
  if (bare.split(/\s+/).length <= 6 && ACK_RE.test(bare)) {
    return { ok: false, reason: 'ack_or_greeting' };
  }

  // 5. slash_command (harness command, operational)
  if (trimmed.startsWith('/')) return { ok: false, reason: 'slash_command' };

  // 6. question_only: every non-empty sentence ends with a question mark.
  //    Precision-biased — a fact embedded in a question is an accepted miss.
  const sentences = trimmed
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (sentences.length > 0 && sentences.every((s) => /[?？]$/.test(s))) {
    return { ok: false, reason: 'question_only' };
  }

  // 7. quoted_or_tool_output: strip fences / '>' quotes / indent runs; if the
  //    residue is not substantive on its own, the turn was quoted material.
  const residue = stripQuotedAndToolOutput(trimmed).trim();
  if (residue.length < (CJK_RE.test(residue) ? MIN_TURN_CHARS_CJK : MIN_TURN_CHARS)) {
    return { ok: false, reason: 'quoted_or_tool_output' };
  }

  const normalized = normalizeTurnText(trimmed);
  return { ok: true, normalized, hash24: turnHash24(normalized) };
}
