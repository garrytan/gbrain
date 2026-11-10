/**
 * The untrusted-content convention describes controls that ship: the remote-read quoting in transcript-quote.ts and
 * the TURN_CONTEXT_ENVELOPE line. No skill tells an agent to write a frontmatter flag or fence name that no code reads.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { TURN_CONTEXT_ENVELOPE } from '../src/core/context/turn-context-envelope.ts';

const ROOT = join(import.meta.dir, '..');
const UNIMPLEMENTED = ['untrusted_directives', 'untrusted-quoted'];

function markdown(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? markdown(p) : p.endsWith('.md') ? [p] : [];
  });
}

describe('untrusted-content convention', () => {
  test('no skill names a flag or fence that no code implements', () => {
    const hits = ['skills', 'plugin', 'plugin-variants'].flatMap(d => markdown(join(ROOT, d)))
      .flatMap(p => UNIMPLEMENTED.filter(name => readFileSync(p, 'utf8').includes(name)).map(name => `${p.slice(ROOT.length + 1)}: ${name}`));
    expect(hits).toEqual([]);
  });

  test('every copy names the shipped controls', () => {
    const copies = ['skills', 'plugin', 'plugin-variants'].flatMap(d => markdown(join(ROOT, d))).filter(p => p.endsWith('conventions/untrusted-content.md'));
    expect(copies.length).toBeGreaterThanOrEqual(2);
    for (const p of copies) {
      const text = readFileSync(p, 'utf8').replace(/\s+/g, ' ');
      expect(text).toContain('quotesStored');
      expect(text).toContain('TURN_CONTEXT_ENVELOPE');
      expect(text).toContain(TURN_CONTEXT_ENVELOPE);
      expect(text).toContain('owner tier');
    }
  });
});
