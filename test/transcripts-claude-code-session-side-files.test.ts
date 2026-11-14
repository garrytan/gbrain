import { describe, test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expandPaths } from '../src/commands/transcripts.ts';

const UUID = '123e4567-e89b-42d3-a456-426614174000';

describe('expandPaths Claude Code per-session side files', () => {
  test('excludes in-session state files but keeps other .json files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gb-ccside-'));
    try {
      const s = join(root, UUID);
      mkdirSync(join(s, 'subagents'), { recursive: true });
      mkdirSync(join(s, 'workflows'), { recursive: true });
      const side = [
        join(s, 'ccr-tip.json'),
        join(s, 'custom-title.json'),
        join(s, 'subagents', 'agent-abc.meta.json'),
        join(s, 'workflows', 'wf_123.json'),
      ];
      const keep = [join(root, 'export.json')];
      for (const p of [...side, ...keep]) writeFileSync(p, '{}\n');
      const got = await expandPaths([root]);
      const real = (p: string) => got.some((g) => g.endsWith(p.slice(root.length)));
      for (const p of side) expect(real(p)).toBe(false);
      expect(real(keep[0]!)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
