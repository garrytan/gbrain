import { describe, test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// #4988/#5009: the skill's bash pre-pass once divided byte counts by 4 (then
// 3.5), undercounting Claude-loaded markdown by 13-35%. The shipped snippet is
// executed here on fixture files of known size: each estimate must be
// ceil(bytes / 2.8). The report must state that basis and defer to the host
// client's exact context breakdown when one exists.
const skill = readFileSync(join(import.meta.dir, '..', 'skills/context-audit/SKILL.md'), 'utf8');

describe('#4988 context-audit skill token estimate', () => {
  test('the stack-enumeration snippet estimates ceil(bytes / 2.8) tokens per always-loaded file', () => {
    const section = skill.split('### 1. Enumerate the stack')[1]!.split('### 2.')[0]!;
    const snippet = section.match(/```bash\n([\s\S]*?)\n```/)?.[1];
    expect(snippet).toBeDefined();
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-context-audit-'));
    const sizes: Record<string, number> = { 'CLAUDE.md': 1, 'AGENTS.md': 28, 'SOUL.md': 29, 'MEMORY.md': 10_000 };
    try {
      for (const [name, bytes] of Object.entries(sizes)) writeFileSync(join(dir, name), 'x'.repeat(bytes));
      const child = Bun.spawnSync(['bash', '-c', snippet!], { cwd: dir, env: { PATH: process.env.PATH ?? '' }, stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
      const expected = Object.entries(sizes).map(([name, bytes]) => `${name}: ${bytes} bytes (~${Math.ceil(bytes / 2.8)} tokens)`);
      expect(child.stdout.toString().trim().split('\n').sort()).toEqual(expected.sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('report header carries the estimate basis and defers to the host figure', () => {
    expect(skill).toContain('Estimate basis: bytes/2.8');
    expect(skill).toContain('Claude Code `/context`');
    expect(skill).toContain('host-reported exact total (e.g. `/context`)');
  });
});
