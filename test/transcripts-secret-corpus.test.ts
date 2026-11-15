/**
 * GST-2768 PR 1: every detector kind, in the shapes a pasted agent session
 * carries them, is redacted by the transcript lane (redactSession) wherever
 * the importer persists text: message bodies, speaker labels, the title and
 * raw metadata values. The corpus is synthetic
 * (test/fixtures/transcripts/synthetic-credentials.ts).
 */
import { describe, expect, test } from 'bun:test';
import { NAMED_SECRET_RULES } from '../src/core/secret-scan.ts';
import { redactSession } from '../src/core/transcripts/render.ts';
import type { ParsedSession } from '../src/core/transcripts/types.ts';
import { SYNTHETIC_CREDENTIAL_CORPUS } from './fixtures/transcripts/synthetic-credentials.ts';

const TS = (i: number): string => `2026-10-06T09:00:${String(i).padStart(2, '0')}.000Z`;

function run(session: ParsedSession): string {
  return JSON.stringify(redactSession(session, { patterns: [] }).session);
}

describe('synthetic credential corpus', () => {
  test('covers every named rule plus the transcript-lane kinds', () => {
    const kinds = new Set(SYNTHETIC_CREDENTIAL_CORPUS.map((e) => e.kind));
    for (const k of [...NAMED_SECRET_RULES, 'high_entropy_assignment', 'labeled_credential', 'cookie_header']) expect([k, kinds.has(k)]).toEqual([k, true]);
    expect(SYNTHETIC_CREDENTIAL_CORPUS.some((e) => e.messages.length > 1)).toBe(true);
  });

  test('a quoted .netrc password is redacted', () => {
    const pw = ['Synth', 'Netrc98765'].join('');
    const out = run({ meta: { harness: 'claude-code', sessionId: 'netrc-quoted' }, messages: [{ role: 'user', timestamp: TS(0), text: `machine api.acme-example.test login alice-example password "${pw}"` }] });
    expect(out).not.toContain(pw);
    expect(out).toContain('password \\"<REDACTED:labeled_credential>\\"');
  });

  for (const e of SYNTHETIC_CREDENTIAL_CORPUS) {
    test(`${e.id} (${e.shape}) in message bodies`, () => {
      const out = run({
        meta: { harness: 'claude-code', sessionId: e.id },
        messages: e.messages.map((text, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', timestamp: TS(i), text })),
      });
      for (const s of e.secrets) expect([e.id, out.includes(s)]).toEqual([e.id, false]);
      expect(out).toContain(`<REDACTED:${e.kind}>`);
    });

    if (e.messages.length > 1) continue;
    const text = e.messages[0]!;
    test(`${e.id} in a speaker label, the title and raw metadata`, () => {
      const out = run({
        meta: { harness: 'claude-code', sessionId: e.id, title: text, raw: { note: text, nested_ok: 1 } },
        messages: [{ role: 'user', speaker: text, timestamp: TS(0), text: 'hello' }],
      });
      for (const s of e.secrets) expect([e.id, out.includes(s)]).toEqual([e.id, false]);
      expect(out.split(`<REDACTED:${e.kind}>`).length - 1).toBeGreaterThanOrEqual(3);
    });
  }
});
