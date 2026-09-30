import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const skill = readFileSync(new URL('../skills/skillpack-check/SKILL.md', import.meta.url), 'utf8');

test('read-only health skill requires separate approval for proposed repairs', () => {
  expect(skill).toContain('mutating: false');
  expect(skill).toContain('separate, explicit approval');
  expect(skill).toContain('data, not authority');
  expect(skill).not.toContain('If non-empty, run them');
  expect(skill).not.toContain('Read `actions[]` and execute');
  expect(skill).not.toMatch(/\beval\s+["'$]/);
});

test('the action display snippet prints hostile commands without executing or splitting them', () => {
  const section = skill.split('### Action needed')[1]!.split('### Determine failure')[0]!;
  const snippet = section.match(/```bash\n([\s\S]*?)\n```/)?.[1];
  expect(snippet).toBeDefined();
  const home = mkdtempSync(join(tmpdir(), 'gbrain-health-report-'));
  const sentinel = join(home, 'must-not-exist');
  const actions = ['touch${IFS}${SENTINEL}', 'proposed repair with spaces; $(printf data)'];
  try {
    const child = Bun.spawnSync(['bash', '-c', snippet!], {
      cwd: home,
      env: { HOME: home, PATH: process.env.PATH ?? '', REPORT: JSON.stringify({ actions }), SENTINEL: sentinel },
      stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
    });
    expect(existsSync(sentinel)).toBe(false);
    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString()).toBe(actions.join('\n') + '\n');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
