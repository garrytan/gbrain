/** Claude Code sessions-index.json is an index, not a transcript (#9115). */
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { expandPaths } from '../src/commands/transcripts.ts';

let tmp: string | null = null;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('expandPaths sessions-index.json', () => {
  test('directory expansion drops sessions-index.json and keeps the session jsonl', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'gb-sidx-'));
    const proj = join(tmp, 'proj');
    mkdirSync(proj, { recursive: true });
    const session = join(proj, 'abc.jsonl');
    writeFileSync(
      session,
      JSON.stringify({ sessionId: 's1', type: 'user', message: { role: 'user', content: 'hi' } }) + '\n',
    );
    writeFileSync(join(proj, 'sessions-index.json'), '{"version":1,"entries":[]}');
    expect(await expandPaths([proj])).toEqual([session]);
  });
});
