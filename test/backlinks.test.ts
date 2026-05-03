import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractEntityRefs,
  extractPageTitle,
  hasBacklink,
  buildBacklinkEntry,
  findBacklinkGaps,
} from '../src/commands/backlinks.ts';

describe('extractEntityRefs', () => {
  test('extracts people links', () => {
    const content = 'Met [Jane Doe](../people/jane-doe.md) at the event.';
    const refs = extractEntityRefs(content, 'meetings/2026-04-01.md');
    expect(refs).toHaveLength(1);
    expect(refs[0].name).toBe('Jane Doe');
    expect(refs[0].slug).toBe('jane-doe');
    expect(refs[0].dir).toBe('people');
  });

  test('extracts company links', () => {
    const content = 'Discussed [Acme Corp](../../companies/acme-corp.md) deal.';
    const refs = extractEntityRefs(content, 'meetings/2026/q1.md');
    expect(refs).toHaveLength(1);
    expect(refs[0].name).toBe('Acme Corp');
    expect(refs[0].slug).toBe('acme-corp');
    expect(refs[0].dir).toBe('companies');
  });

  test('extracts multiple refs', () => {
    const content = '[Alice](../people/alice.md) and [Bob](../people/bob.md) from [Acme](../companies/acme.md).';
    const refs = extractEntityRefs(content, 'meetings/test.md');
    expect(refs).toHaveLength(3);
  });

  test('returns empty for no entity links', () => {
    const content = 'Just a plain page with [external](https://example.com) link.';
    expect(extractEntityRefs(content, 'test.md')).toHaveLength(0);
  });

  test('ignores non-entity brain links', () => {
    const content = '[Guide](../docs/setup.md) for reference.';
    expect(extractEntityRefs(content, 'test.md')).toHaveLength(0);
  });
});

describe('extractPageTitle', () => {
  test('extracts from frontmatter', () => {
    expect(extractPageTitle('---\ntitle: "Jane Doe"\ntype: person\n---\n# Jane')).toBe('Jane Doe');
  });

  test('extracts from H1 when no frontmatter title', () => {
    expect(extractPageTitle('---\ntype: person\n---\n# Jane Doe')).toBe('Jane Doe');
  });

  test('extracts H1 without frontmatter', () => {
    expect(extractPageTitle('# Meeting Notes\n\nContent.')).toBe('Meeting Notes');
  });

  test('returns Untitled for no title', () => {
    expect(extractPageTitle('Just content, no heading.')).toBe('Untitled');
  });
});

describe('hasBacklink', () => {
  test('returns true when source filename is present', () => {
    const content = '## Timeline\n\n- Referenced in [Meeting](../../meetings/q1-review.md)';
    expect(hasBacklink(content, 'q1-review.md')).toBe(true);
  });

  test('returns false when source filename is absent', () => {
    const content = '## Timeline\n\n- Some other entry';
    expect(hasBacklink(content, 'q1-review.md')).toBe(false);
  });
});

describe('buildBacklinkEntry', () => {
  test('builds properly formatted entry', () => {
    const entry = buildBacklinkEntry('Q1 Review', '../../meetings/q1-review.md', '2026-04-11');
    expect(entry).toBe('- **2026-04-11** | Referenced in [Q1 Review](../../meetings/q1-review.md)');
  });
});

describe('findBacklinkGaps', () => {
  // Helper: build a hermetic brain dir for the test, return its path.
  function buildBrain(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-test-'));
    for (const [rel, content] of Object.entries(files)) {
      const full = join(dir, rel);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content);
    }
    return dir;
  }

  test('dedups multiple references from the same source to the same target', () => {
    // Source page mentions [Jane Doe] three times; without the dedup guard
    // the function returns 3 gaps and fixBacklinkGaps writes 3 duplicate
    // timeline entries on jane-doe.md. Regression guard for the dedup fix.
    const brain = buildBrain({
      'people/jane-doe.md':
        '---\ntitle: Jane Doe\n---\n# Jane Doe\n\n## Timeline\n',
      'meetings/q1-review.md':
        '# Q1 Review\n\nDiscussed plans with [Jane Doe](../people/jane-doe.md). ' +
        'Then [Jane Doe](../people/jane-doe.md) shared the deck. Finally [Jane Doe](../people/jane-doe.md) signed off.',
    });
    try {
      const gaps = findBacklinkGaps(brain);
      const janeGaps = gaps.filter((g) => g.targetPage === 'people/jane-doe.md');
      expect(janeGaps).toHaveLength(1);
      expect(janeGaps[0].sourcePage).toBe('meetings/q1-review.md');
    } finally {
      rmSync(brain, { recursive: true, force: true });
    }
  });

  test('keeps separate gaps for the same source referencing different targets', () => {
    // Dedup must not collapse legitimately-distinct (source, target) pairs.
    const brain = buildBrain({
      'people/alice.md': '---\ntitle: Alice\n---\n# Alice\n',
      'people/bob.md': '---\ntitle: Bob\n---\n# Bob\n',
      'meetings/sync.md':
        '# Sync\n\n[Alice](../people/alice.md) and [Bob](../people/bob.md) attended.',
    });
    try {
      const gaps = findBacklinkGaps(brain);
      const syncGaps = gaps.filter((g) => g.sourcePage === 'meetings/sync.md');
      expect(syncGaps).toHaveLength(2);
      const targets = syncGaps.map((g) => g.targetPage).sort();
      expect(targets).toEqual(['people/alice.md', 'people/bob.md']);
    } finally {
      rmSync(brain, { recursive: true, force: true });
    }
  });
});
