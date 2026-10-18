/**
 * Large pages (Wave A, A6): the shipped skills that tell agents what to do
 * with a big conversation or a `file_too_large` hold must match the 24 MiB
 * page ceiling. They may never tell an agent to split a page that fits, the
 * plugin variant carries the same guidance as the canonical skill, and the
 * tamper-evidence lock records the edited bytes.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const ARCHIVE = 'skills/conversation-archive/SKILL.md';
const ARCHIVE_VARIANT = 'plugin-variants/gbrain-daily/skills/conversation-archive/SKILL.md';
const GUARD = 'skills/frontmatter-guard/SKILL.md';
const LOCK = 'skills/skills.lock.json';

function section(text: string, start: string): string {
  const from = text.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  const end = text.indexOf('\n\n**', from + start.length);
  return text.slice(from, end < 0 ? undefined : end);
}

describe('large-page guidance in shipped skills', () => {
  test('conversation-archive keeps one page per conversation up to the ceiling, in the skill and its plugin variant', () => {
    for (const path of [ARCHIVE, ARCHIVE_VARIANT]) {
      const guidance = section(read(path), "**Don't split a conversation for size.**");
      expect(guidance).toContain('24 MiB page ceiling');
      expect(guidance).toContain('Only a conversation over 24 MiB');
      expect(guidance).toContain('docs/guides/memory-boundaries.md#large-pages');
    }
    expect(section(read(ARCHIVE_VARIANT), "**Don't split a conversation for size.**"))
      .toBe(section(read(ARCHIVE), "**Don't split a conversation for size.**"));
  });

  test('frontmatter-guard names the page limit and never tells an agent to split a page that fits', () => {
    const row = read(GUARD).split('\n').find(line => line.startsWith('| `file_too_large` |'));
    expect(row).toBeDefined();
    expect(row).toContain('24 MiB for Markdown, 5 MB for code');
    expect(row).toContain('never split one that fits');
    expect(row).not.toMatch(/^\| `file_too_large` \| Split the file/);
  });

  test('skills.lock.json records the current bytes of the edited skills', () => {
    const lock = JSON.parse(read(LOCK)) as Record<string, string>;
    for (const path of [ARCHIVE, GUARD]) {
      expect(lock[path.slice('skills/'.length)]).toBe(createHash('sha256').update(readFileSync(join(ROOT, path))).digest('hex'));
    }
  });
});
