/**
 * #9768: Claude Code delivers a message from another Claude session as a user-role line that opens with its own
 * lead-in ("Another Claude session sent a message:", or "... while you were working:") and a <cross-session-message>
 * envelope. An agent wrote it, so neither the hook window nor the archive parse may take it as the owner's words. The
 * check is per turn: the same session's typed prompts stay. Synthetic transcripts only.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseClaudeSessionFile, parseTranscript } from '../src/core/transcripts/claude-code-jsonl.ts';

let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

function transcript(entries: Record<string, unknown>[]): string {
  dir = mkdtempSync(join(tmpdir(), 'gb-jsonl-relayed-'));
  const path = join(dir, 'synthetic.jsonl');
  writeFileSync(path, entries.map((entry, index) => JSON.stringify({
    sessionId: 'synthetic-relayed-session', timestamp: `2026-08-01T10:00:${String(index).padStart(2, '0')}.000Z`, ...entry,
  })).join('\n') + '\n');
  return path;
}

const user = (content: unknown) => ({ type: 'user', message: { role: 'user', content } });
const envelope = (body: string) => `<cross-session-message from="uds:/tmp/example.sock" from-name="worker-example" from-mode="prompting">\n${body}\n</cross-session-message>`;

describe('messages relayed from another Claude session are not owner turns (#9768)', () => {
  test('both lead-ins, as a string or a text block, are excluded; typed prompts stay, a quoted lead-in included', () => {
    const path = transcript([
      user(`Another Claude session sent a message:\n${envelope('synthetic relayed brief')}`),
      user([{ type: 'text', text: `Another Claude session sent a message while you were working:\n${envelope('synthetic relayed block')}` }]),
      user('synthetic human prompt'),
      user('Why does my log say "Another Claude session sent a message:"?'),
      { type: 'assistant', message: { role: 'assistant', content: 'synthetic assistant reply' } },
    ]);
    const kept = ['synthetic human prompt', 'Why does my log say "Another Claude session sent a message:"?', 'synthetic assistant reply'];
    const hook = parseTranscript(path);
    expect(hook.turns.map(t => t.text)).toEqual(kept);
    expect(hook.genuineUserTurnIndexes).toEqual([0, 1]);
    const archive = parseClaudeSessionFile(path);
    expect(archive.turns.map(t => t.text)).toEqual(kept);
    expect(archive.excludedUserLines).toBe(2);
  });

  test('a typed prompt that opens with the lead-in but carries no relay envelope stays an owner turn', () => {
    const typed = 'Another Claude session sent a message: please help me debug this notification.';
    const path = transcript([user(typed)]);
    expect(parseTranscript(path).turns.map(t => t.text)).toEqual([typed]);
    const archive = parseClaudeSessionFile(path);
    expect(archive.turns.map(t => t.text)).toEqual([typed]);
    expect(archive.excludedUserLines).toBe(0);
  });
});
