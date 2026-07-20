import { describe, test, expect } from 'bun:test';
import {
  normalizeBlockConversation,
  looksLikeBlockConversation,
} from '../src/core/conversation-parser/normalize-block.ts';
import { parseConversation } from '../src/core/conversation-parser/parse.ts';

// A realistic Slack-collector page body (the format gbrain's own collector emits).
const SLACK_DM = `# DM (group) with Hugh, Karyshma, Theo — 2026-06-15

- **Theo** (Mon 11:18)
  Hey everyone — quick note on the *real fiscal value* we surface after accounting.

  It's a huge win at renewal and dents churn.
- **Juan** (Mon 11:20)
  Agreed. Let's make sure we capture it for all ongoing customers.`;

describe('looksLikeBlockConversation', () => {
  test('detects the block header signature', () => {
    expect(looksLikeBlockConversation(SLACK_DM)).toBe(true);
    expect(looksLikeBlockConversation('- **Theo** (16:36)\n  body')).toBe(true);
    expect(looksLikeBlockConversation('- **Theo** (11:18 AM)\n  body')).toBe(true);
  });

  test('is false for canonical single-line content (no false trigger)', () => {
    expect(looksLikeBlockConversation('**Theo** (11:18): hi there')).toBe(false);
    expect(looksLikeBlockConversation('**Theo** (2026-06-15 11:18): hi')).toBe(false);
    expect(looksLikeBlockConversation('just some prose with no chat at all')).toBe(false);
  });
});

describe('normalizeBlockConversation', () => {
  test('collapses header + indented multi-paragraph body to one canonical line', () => {
    const out = normalizeBlockConversation(SLACK_DM).split('\n');
    expect(out).toEqual([
      "**Theo** (11:18): Hey everyone — quick note on the *real fiscal value* we surface after accounting. It's a huge win at renewal and dents churn.",
      "**Juan** (11:20): Agreed. Let's make sure we capture it for all ongoing customers.",
    ]);
  });

  test('drops the page-title line and leading blanks', () => {
    const out = normalizeBlockConversation(SLACK_DM);
    expect(out.startsWith('# DM')).toBe(false);
    expect(out.startsWith('**Theo**')).toBe(true);
  });

  test('converts 12h am/pm to 24h', () => {
    expect(normalizeBlockConversation('- **A** (1:05 PM)\n  hi')).toBe('**A** (13:05): hi');
    expect(normalizeBlockConversation('- **A** (12:00 AM)\n  midnight')).toBe('**A** (00:00): midnight');
    expect(normalizeBlockConversation('- **A** (12:30 PM)\n  noon-ish')).toBe('**A** (12:30): noon-ish');
  });

  test('keeps day-of-week out of the emitted time', () => {
    expect(normalizeBlockConversation('- **A** (Tue 09:07)\n  morning')).toBe('**A** (09:07): morning');
  });

  test('is a strict no-op on canonical single-line content', () => {
    const canonical = '**Theo** (11:18): hi\n**Juan** (11:20): yo';
    expect(normalizeBlockConversation(canonical)).toBe(canonical);
  });

  test('a message with no body emits an empty-body line', () => {
    expect(normalizeBlockConversation('- **A** (10:00)')).toBe('**A** (10:00): ');
  });
});

describe('parseConversation integration — block format now yields messages', () => {
  test('Slack-collector body parses to 2 messages via the normalize pre-pass', () => {
    const res = parseConversation(SLACK_DM, { fallbackDate: '2026-06-15' });
    expect(res.messages.length).toBe(2);
    expect(res.messages[0].speaker).toBe('Theo');
    expect(res.messages[1].speaker).toBe('Juan');
    expect(res.phase).not.toBe('no_match');
  });

  test('canonical content still parses unchanged (no regression)', () => {
    const res = parseConversation('**Theo** (11:18): hi there', { fallbackDate: '2026-06-15' });
    expect(res.messages.length).toBe(1);
    expect(res.messages[0].speaker).toBe('Theo');
  });
});
