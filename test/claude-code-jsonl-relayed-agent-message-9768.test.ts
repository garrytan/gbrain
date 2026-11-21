import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseClaudeSessionFile, parseTranscript } from '../src/core/transcripts/claude-code-jsonl.ts';

const dir = mkdtempSync(join(tmpdir(), 'gb-relayed-9768-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function user(content: unknown): Record<string, unknown> {
  return { type: 'user', message: { role: 'user', content } };
}

describe('relayed agent messages are not owner turns (#9768)', () => {
  test('string and text-block relayed turns are skipped, human turn kept', () => {
    const entries = [
      user('Another Claude session sent a message:\nsynthetic brief'),
      user([{ type: 'text', text: 'Another Claude session sent a message:\nsynthetic block brief' }]),
      user('synthetic human prompt'),
    ];
    const path = join(dir, 's.jsonl');
    writeFileSync(path, entries.map((e, i) => JSON.stringify({
      sessionId: 's', timestamp: `2026-08-01T10:00:0${i}.000Z`, ...e,
    })).join('\n') + '\n');
    const hook = parseTranscript(path);
    expect(hook.turns.map((t) => t.text)).toEqual(['synthetic human prompt']);
    expect(hook.genuineUserTurnIndexes).toEqual([0]);
    const archive = parseClaudeSessionFile(path);
    expect(archive.turns.map((t) => t.text)).toEqual(['synthetic human prompt']);
  });
});
