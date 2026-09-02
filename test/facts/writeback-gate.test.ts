/**
 * Ambient-writeback gate (WP4/G): every rule and reason is pinned here with
 * RULE-DISTINCT inputs (OV2-3) — "Thanks" pins too_short (rule 2 fires
 * before the ack lexicon, deliberately: the hermetic zero-LLM guarantee),
 * a ≥20-char pure ack pins ack_or_greeting, a CJK 6-char fact passes via
 * the lowered floor (F6). The reason vocabulary is frozen (additive only) —
 * heartbeat entries and skip sidecars carry these codes.
 */
import { describe, test, expect } from 'bun:test';
import {
  gateWritebackTurn,
  normalizeTurnText,
  turnHash24,
  MIN_TURN_CHARS,
  MIN_TURN_CHARS_CJK,
  MAX_TURN_CHARS,
} from '../../src/core/facts/writeback-gate.ts';

describe('gateWritebackTurn — skip rules, first hit wins', () => {
  test('empty / non-string → empty', () => {
    expect(gateWritebackTurn('')).toEqual({ ok: false, reason: 'empty' });
    expect(gateWritebackTurn('   \n ')).toEqual({ ok: false, reason: 'empty' });
    expect(gateWritebackTurn(undefined)).toEqual({ ok: false, reason: 'empty' });
  });

  test('"Thanks" → too_short (rule 2 precedes the lexicon — the hermetic guarantee)', () => {
    expect(gateWritebackTurn('Thanks')).toEqual({ ok: false, reason: 'too_short' });
    expect(gateWritebackTurn('ok')).toEqual({ ok: false, reason: 'too_short' });
    expect(gateWritebackTurn('yes please')).toEqual({ ok: false, reason: 'too_short' });
  });

  test('≥20-char pure acknowledgement → ack_or_greeting (rule-distinct pin)', () => {
    expect(gateWritebackTurn('okay sounds good thanks so much!')).toEqual({ ok: false, reason: 'ack_or_greeting' });
    expect(gateWritebackTurn('Good morning, thanks a lot')).toEqual({ ok: false, reason: 'ack_or_greeting' });
  });

  test('CJK floor (F6): a 6-char CJK fact passes; a 6-char CJK ack-length blob under 10 chars does not', () => {
    // "I am allergic to peanuts" — 6 chars, information-dense.
    const r = gateWritebackTurn('我对花生过敏');
    expect(r.ok).toBe(false); // 6 < 10 — still under the CJK floor
    const r2 = gateWritebackTurn('我对花生严重过敏，随身带肾上腺素笔');
    expect(r2.ok).toBe(true);
    expect(MIN_TURN_CHARS_CJK).toBeLessThan(MIN_TURN_CHARS);
  });

  test('slash command → slash_command', () => {
    expect(gateWritebackTurn('/compact and then continue with the review')).toEqual({ ok: false, reason: 'slash_command' });
  });

  test('questions carrying no new facts → question_only; a fact+question mix passes', () => {
    expect(gateWritebackTurn('What time is the standup tomorrow? Can you check the calendar?')).toEqual({ ok: false, reason: 'question_only' });
    const mixed = gateWritebackTurn('I moved the standup to 9am. Can you update the calendar?');
    expect(mixed.ok).toBe(true);
  });

  test('quoted / tool output → quoted_or_tool_output; quoted material with substantive user residue passes', () => {
    const quoted = ['> Alice wrote: the deploy failed', '> and the logs show a timeout'].join('\n');
    expect(gateWritebackTurn(quoted)).toEqual({ ok: false, reason: 'quoted_or_tool_output' });
    const fenced = '```\nERROR: connection refused at db.example:5432\nstack trace line line line\n```';
    expect(gateWritebackTurn(fenced)).toEqual({ ok: false, reason: 'quoted_or_tool_output' });
    const indented = Array.from({ length: 4 }, (_, i) => `        tool output row ${i}`).join('\n');
    expect(gateWritebackTurn(indented)).toEqual({ ok: false, reason: 'quoted_or_tool_output' });
    const withResidue = 'I decided we are switching the staging db to Postgres 17.\n> Alice wrote: the deploy failed';
    expect(gateWritebackTurn(withResidue).ok).toBe(true);
  });

  test('bulk paste over the cap → bulk_paste (imported text needs an explicit ask)', () => {
    const big = 'a decision was made. '.repeat(500); // > 8000 chars
    expect(big.length).toBeGreaterThan(MAX_TURN_CHARS);
    expect(gateWritebackTurn(big)).toEqual({ ok: false, reason: 'bulk_paste' });
  });
});

describe('gateWritebackTurn — ok path: normalization + idempotency hash', () => {
  test('substantive statement passes with NFC/collapsed normalization and a stable 24-hex hash', () => {
    const a = gateWritebackTurn('I prefer  dark mode\n in every editor.');
    const b = gateWritebackTurn('I prefer dark mode in every editor.');
    if (!a.ok || !b.ok) throw new Error('expected ok');
    expect(a.normalized).toBe('I prefer dark mode in every editor.');
    expect(a.hash24).toBe(b.hash24); // whitespace shape does not change the key
    expect(a.hash24).toMatch(/^[0-9a-f]{24}$/);
  });

  test('different turns → different hashes; helpers agree with the gate', () => {
    const a = gateWritebackTurn('I prefer dark mode in every editor.');
    const c = gateWritebackTurn('I have a mild cough today, nothing serious.');
    if (!a.ok || !c.ok) throw new Error('expected ok');
    expect(a.hash24).not.toBe(c.hash24);
    expect(turnHash24(normalizeTurnText('I prefer dark mode in every editor.'))).toBe(a.hash24);
  });
});
