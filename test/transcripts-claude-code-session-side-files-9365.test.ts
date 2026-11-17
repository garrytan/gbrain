/**
 * #9365: Claude Code 2.1 writes per-session state files inside the
 * `<session-uuid>/` directory. They are never transcripts, so ingest skips
 * them instead of failing each one with `unknown format`.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expandPaths } from '../src/commands/transcripts.ts';
import { isClaudeCodeRemoteControlStateFile } from '../src/core/transcripts/claude-code.ts';

const SESSION = '123e4567-e89b-42d3-a456-426614174000';

describe('Claude Code per-session side files', () => {
  test('ingest discovery skips them and keeps every other .json file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-cc-side-'));
    try {
      const s = join(root, SESSION);
      mkdirSync(join(s, 'subagents'), { recursive: true });
      mkdirSync(join(s, 'workflows'), { recursive: true });
      mkdirSync(join(root, 'notes', 'workflows'), { recursive: true });
      const side = [
        join(s, 'ccr-tip.json'),
        join(s, 'custom-title.json'),
        join(s, 'subagents', 'agent-abc.meta.json'),
        join(s, 'workflows', 'wf_123.json'),
      ];
      const keep = [
        join(root, 'export.json'),
        join(root, 'custom-title.json'),
        join(root, 'notes', 'workflows', 'wf_123.json'),
      ];
      for (const p of [...side, ...keep]) writeFileSync(p, '{}\n');
      const got = new Set(await expandPaths([root]));
      for (const p of side) expect(got.has(p)).toBe(false);
      for (const p of keep) expect(got.has(p)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a side-file name outside a session directory is not a state file', () => {
    expect(isClaudeCodeRemoteControlStateFile(`/p/${SESSION}/custom-title.json`)).toBe(true);
    expect(isClaudeCodeRemoteControlStateFile(`C:\\p\\${SESSION}\\workflows\\wf_1.json`)).toBe(true);
    expect(isClaudeCodeRemoteControlStateFile('/p/not-a-session/custom-title.json')).toBe(false);
    expect(isClaudeCodeRemoteControlStateFile(`/p/${SESSION}/subagents/agent-abc.jsonl`)).toBe(false);
    expect(isClaudeCodeRemoteControlStateFile(`/p/${SESSION}.jsonl`)).toBe(false);
  });
});
