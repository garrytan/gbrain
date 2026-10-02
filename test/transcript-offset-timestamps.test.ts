/**
 * Offset-stamped source timestamps must round-trip exactly (gbrain-evals
 * N12-2). An adapter that copied '2026-08-10T22:30:00.000-07:00' verbatim
 * met a renderer that paired the local DATE (sliced from the string) with
 * the UTC HOUR, so the anchor read "2026-08-10 5:30 AM" and re-parsed one
 * day early. Adapters now normalize offset timestamps to UTC, and the
 * renderer takes date and hour from the same UTC instant.
 *
 * Synthetic data only.
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeExportAdapter } from '../src/core/transcripts/claude-export.ts';
import { claudeCodeAdapter } from '../src/core/transcripts/claude-code.ts';
import { mapCodexLine } from '../src/core/transcripts/codex.ts';
import { mapOpenclawLine } from '../src/core/transcripts/openclaw.ts';
import { redactSession, renderSessionParts } from '../src/core/transcripts/render.ts';
import { parseConversation } from '../src/core/conversation-parser/parse.ts';
import type { ParsedSession } from '../src/core/transcripts/types.ts';

const OFFSET = '2026-08-10T22:30:00.000-07:00';
const INSTANT = '2026-08-11T05:30:00.000Z';

const dir = mkdtempSync(join(tmpdir(), 'n12-2-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function first(gen: AsyncGenerator<ParsedSession, unknown>): Promise<ParsedSession> {
  const r = await gen.next();
  if (r.done) throw new Error('no session');
  return r.value;
}

function roundTrip(session: ParsedSession) {
  const part = renderSessionParts(redactSession(session, { patterns: [] }), { sourcePath: 'x' }).parts[0];
  const parsed = parseConversation(part.body, { noFallback: true, noPolish: true, page: { frontmatter: part.frontmatter } } as any);
  return { part, parsed };
}

describe('render round-trips offset timestamps exactly', () => {
  test('anchor carries the UTC date with the UTC hour; frontmatter date and slug use the UTC day', () => {
    const session: ParsedSession = {
      meta: { harness: 'claude-export', sessionId: 'c1', title: 'evening chat', startedAt: OFFSET },
      messages: [{ role: 'user', timestamp: OFFSET, text: 'hello' }],
    };
    const { part, parsed } = roundTrip(session);
    expect(part.body.split('\n')[0]).toBe('**User** (2026-08-11 5:30 AM): hello');
    expect(part.frontmatter.date).toBe('2026-08-11');
    expect(part.slug).toContain('/2026-08-11-');
    expect(Date.parse(parsed.messages[0].timestamp)).toBe(Date.parse(INSTANT));
  });
});

describe('adapters normalize offset timestamps to UTC', () => {
  test('claude-export (the N12-2 repro)', async () => {
    const p = join(dir, 'conversations.json');
    writeFileSync(p, JSON.stringify([{ uuid: 'c1', name: 'evening chat', created_at: OFFSET,
      chat_messages: [{ uuid: 'm1', sender: 'human', created_at: OFFSET, text: 'hello' }] }]));
    const s = await first(claudeExportAdapter.parse(p));
    expect(s.messages[0].timestamp).toBe(INSTANT);
    expect(s.meta.startedAt).toBe(INSTANT);
    expect(Date.parse(roundTrip(s).parsed.messages[0].timestamp)).toBe(Date.parse(INSTANT));
  });

  test('claude-code', async () => {
    const p = join(dir, 'session.jsonl');
    writeFileSync(p, JSON.stringify({ type: 'user', sessionId: 's1', uuid: 'u1', timestamp: OFFSET, message: { role: 'user', content: 'hello' } }) + '\n');
    const s = await first(claudeCodeAdapter.parse(p));
    expect(s.messages[0].timestamp).toBe(INSTANT);
    expect(s.meta.startedAt).toBe(INSTANT);
  });

  test('codex', () => {
    const session = mapCodexLine({ type: 'session_meta', timestamp: OFFSET, payload: { id: 's1', timestamp: OFFSET } });
    expect(session.kind === 'session' && session.startedAt).toBe(INSTANT);
    const user = mapCodexLine({ type: 'event_msg', timestamp: OFFSET, payload: { type: 'user_message', message: 'hello' } });
    expect(user.kind === 'user' && user.message.timestamp).toBe(INSTANT);
  });

  test('openclaw', () => {
    const session = mapOpenclawLine({ type: 'session', id: 's1', timestamp: OFFSET });
    expect(session.kind === 'session' && session.startedAt).toBe(INSTANT);
    const msg = mapOpenclawLine({ type: 'message', timestamp: OFFSET, message: { role: 'user', content: 'hello', timestamp: OFFSET } });
    expect(msg.kind === 'message' && msg.message.timestamp).toBe(INSTANT);
  });

  test('UTC timestamps pass through byte-identical (no churn for existing imports)', () => {
    const z = '2026-08-01T10:00:00Z';
    const user = mapCodexLine({ type: 'event_msg', timestamp: z, payload: { type: 'user_message', message: 'hello' } });
    expect(user.kind === 'user' && user.message.timestamp).toBe(z);
  });
});
