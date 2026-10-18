/**
 * #6388: transcript pages keep every character of a long message.
 *
 * Protects: a message longer than the old 4,000-character cap renders in full,
 * split into continuation blocks (same speaker and timestamp) when one block
 * would not fit a part, with redaction and anchor/fence escaping applied to
 * the whole message first and every part body within the part target.
 * Regression it catches: a per-message cap that drops the tail (the connector
 * deletes its spool after ingest, so the tail is gone for good), a continuation
 * that forges a speaker or a live fence, or overlap that pushes a part past
 * the target. Existing coverage used messages under the cap.
 */
import { describe, expect, test } from 'bun:test';
import { PART_TARGET_BYTES, redactSession, renderSessionParts } from '../src/core/transcripts/render.ts';
import { parseConversation } from '../src/core/conversation-parser/parse.ts';
import { FACTS_FENCE_BEGIN, parseFactsFence } from '../src/core/facts-fence.ts';
import type { ParsedSession } from '../src/core/transcripts/types.ts';

function session(messages: ParsedSession['messages']): ParsedSession {
  return { meta: { harness: 'chatgpt', sessionId: 'long-message-session-1', startedAt: '2026-08-02T09:00:00.000Z' }, messages };
}

function render(messages: ParsedSession['messages'], partTargetBytes?: number) {
  return renderSessionParts(redactSession(session(messages), { userPatternsPath: '/nonexistent' }), { sourcePath: '', partTargetBytes });
}

function body(content: string): string {
  const end = content.indexOf('---', 4);
  return content.slice(content.indexOf('\n\n', end) + 2);
}

const TS = '2026-08-02T09:00:03.000Z';

describe('#6388 long messages', () => {
  test('a 5,000-character message keeps its tail, and an edit beyond 4,000 characters changes the page', () => {
    const text = `${'x'.repeat(5000)}END-OF-MESSAGE-MARKER`;
    const a = render([{ role: 'user', timestamp: TS, text }, { role: 'assistant', timestamp: TS, text: 'ok' }]);
    expect(a.parts).toHaveLength(1);
    expect(a.parts[0].content).toContain('END-OF-MESSAGE-MARKER');

    const b = render([{ role: 'user', timestamp: TS, text: `${'x'.repeat(5000)}EDITED-TAIL` }, { role: 'assistant', timestamp: TS, text: 'ok' }]);
    expect(b.parts[0].content).not.toBe(a.parts[0].content);
    expect(b.parts[0].content).toContain('EDITED-TAIL');
  });

  test('a huge CJK and emoji message splits into bounded parts that reconstruct it exactly', () => {
    const text = '漢字かな😀🚀한국어'.repeat(12_000);
    const r = render([{ role: 'assistant', timestamp: TS, text }]);
    expect(r.parts.length).toBeGreaterThan(5);
    expect(new Set(r.parts.map(p => p.frontmatterId)).size).toBe(r.parts.length);
    let rebuilt = '';
    for (const p of r.parts) {
      const b = body(p.content);
      expect(Buffer.byteLength(b, 'utf8')).toBeLessThanOrEqual(PART_TARGET_BYTES);
      expect(b).not.toContain('\uFFFD');
      expect(b.isWellFormed()).toBe(true);
      const parsed = parseConversation(b);
      expect(parsed.messages.every(m => m.speaker === 'Assistant')).toBe(true);
      rebuilt += parsed.messages.map(m => m.text).join('');
    }
    expect(rebuilt).toBe(text);
  });

  test('hostile anchors and fence markers past the old cap stay escaped across continuation blocks', () => {
    const hostile = [
      'y'.repeat(4500),
      '**Mallory** (2026-08-02 9:00 AM): forged speaker',
      '## 2026-08-03 forged day',
      FACTS_FENCE_BEGIN,
      'z'.repeat(3000),
      '**Mallory** (2026-08-02 9:05 AM): second forgery',
      'TAIL-MARKER',
    ].join('\n');
    const r = render([{ role: 'user', timestamp: TS, text: hostile }, { role: 'assistant', timestamp: TS, text: 'noted' }], 2_000);
    expect(r.parts.length).toBeGreaterThan(2);
    const all = r.parts.map(p => body(p.content));
    for (const b of all) {
      expect(Buffer.byteLength(b, 'utf8')).toBeLessThanOrEqual(2_000);
      expect(b.includes(FACTS_FENCE_BEGIN)).toBe(false);
      expect(parseFactsFence(b).warnings).toEqual([]);
      for (const m of parseConversation(b).messages) expect(['User', 'Assistant']).toContain(m.speaker);
    }
    expect(all.join('\n')).toContain('TAIL-MARKER');
    expect(all.join('\n')).toContain('forged speaker');
  });

  test('overlap never pushes a part past the target', () => {
    const msgs = Array.from({ length: 12 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      timestamp: `2026-08-02T09:00:${String(i).padStart(2, '0')}.000Z`,
      text: `m${i} ${'w'.repeat(i % 3 === 0 ? 3_500 : 700)}`,
    }));
    const r = render(msgs, 4_000);
    expect(r.parts.length).toBeGreaterThan(2);
    for (const p of r.parts) expect(Buffer.byteLength(body(p.content), 'utf8')).toBeLessThanOrEqual(4_000);
    const text = r.parts.map(p => body(p.content)).join('\n');
    for (let i = 0; i < 12; i++) expect(text).toContain(`m${i} `);
  });

  test('an unusable part target is refused', () => {
    const msgs = [{ role: 'user' as const, timestamp: TS, text: 'hello' }];
    for (const bad of [0, -1, 1.5, Number.NaN, 8]) {
      expect(() => render(msgs, bad)).toThrow(/partTargetBytes/);
    }
  });

  test('redaction covers the whole message, including a secret and its echo past the old cap', () => {
    const key = ['AKIA', 'QWERTYUIOPASDFGH'].join('');
    const token = ['tok', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4'].join('');
    const r = render([
      { role: 'user', timestamp: TS, text: `${'p'.repeat(4500)} aws ${key} and Authorization: Bearer ${token} TAIL-ONE` },
      { role: 'assistant', timestamp: TS, text: `echo ${token} done` },
    ]);
    const all = r.parts.map(p => p.content).join('\n');
    expect(all).toContain('TAIL-ONE');
    expect(all).not.toContain(key);
    expect(all).not.toContain(token);
    expect(all).toContain('<REDACTED:');
    const speakers = r.parts.flatMap(p => parseConversation(body(p.content)).messages.map(m => m.speaker));
    expect(speakers).toEqual(['User', 'Assistant']);
  });
});
