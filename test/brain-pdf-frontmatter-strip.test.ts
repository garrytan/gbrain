/**
 * #5772: brain-pdf stripped frontmatter with a GNU-only sed range that BSD sed
 * (macOS) rejects (empty PDF) and that GNU sed also got wrong: a body `---`
 * rule restarted the range and deleted everything after it, and a page
 * without frontmatter kept only its first line. These run the strip step as
 * written in skills/brain-pdf/SKILL.md (and its generated plugin copy).
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

const REPO = resolve(import.meta.dir, '..');

/** The skill's strip step: the line that writes "$CLEAN", plus its guard. */
function stripStep(skillPath: string): string {
  const lines = readFileSync(join(REPO, skillPath), 'utf-8').split('\n');
  const i = lines.findIndex(l => l.includes('"$RAW" > "$CLEAN"'));
  if (i < 0) throw new Error(`no strip step in ${skillPath}`);
  return lines.slice(i, i + 2).filter(l => l.includes('"$CLEAN"')).join('\n');
}

function strip(skillPath: string, page: string): { out: string; status: number | null; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-5772-'));
  try {
    writeFileSync(join(dir, 'raw.md'), page);
    const r = spawnSync('bash', ['-c', `${stripStep(skillPath)}\ncat "$CLEAN"`], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', RAW: join(dir, 'raw.md'), CLEAN: join(dir, 'clean.md'), SLUG: 'notes/x' },
      encoding: 'utf-8',
    });
    return { out: r.stdout, status: r.status, stderr: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const skill of ['skills/brain-pdf/SKILL.md', 'plugin/skills/brain-pdf/SKILL.md']) {
  describe(`#5772 brain-pdf frontmatter strip (${skill})`, () => {
    test('removes only the leading frontmatter block; a body --- rule and what follows survive', () => {
      const r = strip(skill, '---\ntitle: X\ntype: note\n---\n# X\n\npara1\n\n---\n\npara2 after hr\n');
      expect(r.status).toBe(0);
      expect(r.out).toBe('# X\n\npara1\n\n---\n\npara2 after hr\n');
    });

    test('a page without frontmatter keeps every line', () => {
      const page = '# Plain page\n\nline two\n\nline three\n';
      expect(strip(skill, page).out).toBe(page);
    });

    test('a page that is only frontmatter stops instead of rendering an empty PDF', () => {
      const r = strip(skill, '---\ntitle: X\n---\n');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('nothing to render for notes/x');
    });
  });
}
