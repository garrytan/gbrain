/**
 * Tests for src/core/skillpack/harvest-lint.ts — the privacy linter
 * that defends against accidentally publishing real names from a
 * private host fork into gbrain core.
 *
 * Pins:
 *   - default Wintermute pattern matches
 *   - email + Slack patterns match
 *   - user-supplied patterns merge with defaults
 *   - malformed regex → PrivacyLintConfigError at LOAD time
 *   - no hits → no throw
 *   - hit detail format: `file:line: matched /<regex>/`
 */

import { describe, expect, it, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  DEFAULT_PRIVATE_PATTERNS,
  PrivacyLintConfigError,
  PrivacyLintError,
  loadPatterns,
  runPrivacyLint,
} from '../src/core/skillpack/harvest-lint.ts';

const created: string[] = [];
afterEach(() => {
  while (created.length) {
    const p = created.pop()!;
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {}
  }
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sp-lint-'));
  created.push(dir);
  return dir;
}

describe('loadPatterns', () => {
  it('returns defaults when no patterns file is provided', () => {
    const patterns = loadPatterns();
    expect(patterns.length).toBe(DEFAULT_PRIVATE_PATTERNS.length);
    expect(patterns.map(p => p.source)).toEqual(DEFAULT_PRIVATE_PATTERNS);
  });

  it('returns defaults + user patterns when both exist', () => {
    const dir = scratch();
    const path = join(dir, 'patterns.txt');
    writeFileSync(path, '# comment\nFooBar\n\n  \nBaz123\n');

    const patterns = loadPatterns(path);
    const sources = patterns.map(p => p.source);
    expect(sources).toContain('FooBar');
    expect(sources).toContain('Baz123');
    for (const def of DEFAULT_PRIVATE_PATTERNS) expect(sources).toContain(def);
  });

  it('throws PrivacyLintConfigError on malformed regex', () => {
    const dir = scratch();
    const path = join(dir, 'patterns.txt');
    writeFileSync(path, 'unterminated[group\n');

    expect(() => loadPatterns(path)).toThrow(PrivacyLintConfigError);
  });
});

describe('runPrivacyLint — default patterns', () => {
  it('catches Wintermute references', () => {
    const dir = scratch();
    const file = join(dir, 'skill.md');
    writeFileSync(file, '# Demo\n\nThis was lifted from Wintermute.\n');

    expect(() => runPrivacyLint([file])).toThrow(PrivacyLintError);
    try {
      runPrivacyLint([file]);
    } catch (err) {
      expect((err as PrivacyLintError).hits.some(h => h.includes('Wintermute'))).toBe(true);
    }
  });

  it('catches email addresses', () => {
    const dir = scratch();
    const file = join(dir, 'skill.md');
    writeFileSync(file, 'Contact: jane.doe@example.com for details.\n');

    expect(() => runPrivacyLint([file])).toThrow(PrivacyLintError);
  });

  it('catches Slack channel patterns', () => {
    const dir = scratch();
    const file = join(dir, 'skill.md');
    writeFileSync(file, 'Notify #eng-alerts when this triggers.\n');

    expect(() => runPrivacyLint([file])).toThrow(PrivacyLintError);
  });

  it('does NOT match safe content — no throw', () => {
    const dir = scratch();
    const file = join(dir, 'skill.md');
    writeFileSync(
      file,
      '# generic skill\n\nThis is generic placeholder content for the agent to interpret.\n',
    );

    expect(() => runPrivacyLint([file])).not.toThrow();
  });
});

describe('runPrivacyLint — hit reporting', () => {
  it('hit format is `file:line: matched /<regex>/`', () => {
    const dir = scratch();
    const file = join(dir, 'skill.md');
    writeFileSync(file, 'line 1\nWintermute on line 2\nline 3\n');

    try {
      runPrivacyLint([file]);
      throw new Error('expected throw');
    } catch (err) {
      const hits = (err as PrivacyLintError).hits;
      expect(hits.length).toBeGreaterThan(0);
      const wintermuteHit = hits.find(h => h.includes('Wintermute'));
      expect(wintermuteHit).toBeDefined();
      expect(wintermuteHit).toContain(`${file}:2:`);
    }
  });

  it('scans multiple files in one pass', () => {
    const dir = scratch();
    const f1 = join(dir, 's1.md');
    const f2 = join(dir, 's2.md');
    writeFileSync(f1, 'clean\n');
    writeFileSync(f2, 'has Wintermute in it\n');

    try {
      runPrivacyLint([f1, f2]);
      throw new Error('expected throw');
    } catch (err) {
      const hits = (err as PrivacyLintError).hits;
      expect(hits.length).toBe(1);
      expect(hits[0]).toContain(f2);
    }
  });
});

describe('runPrivacyLint — user patterns file', () => {
  it('catches user-defined patterns alongside defaults', () => {
    const dir = scratch();
    const patternsPath = join(dir, 'patterns.txt');
    writeFileSync(patternsPath, '\\bMyPrivateProject\\b\n');

    const file = join(dir, 'skill.md');
    writeFileSync(file, 'Refers to MyPrivateProject.\n');

    expect(() => runPrivacyLint([file], patternsPath)).toThrow(PrivacyLintError);
  });

  it('user patterns file with comments + blanks parses cleanly', () => {
    const dir = scratch();
    const patternsPath = join(dir, 'patterns.txt');
    writeFileSync(patternsPath, '# header comment\n\nUnique\n\n# another\nAlsoUnique\n');

    expect(() => loadPatterns(patternsPath)).not.toThrow();
    const patterns = loadPatterns(patternsPath);
    expect(patterns.some(p => p.source === 'Unique')).toBe(true);
    expect(patterns.some(p => p.source === 'AlsoUnique')).toBe(true);
  });
});
