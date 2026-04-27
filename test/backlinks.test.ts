import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import {
  extractEntityRefs,
  extractPageTitle,
  hasBacklink,
  buildBacklinkEntry,
  findBacklinkGaps,
  fixBacklinkGaps,
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

describe('backlink gap scan + fix', () => {
  function makeBrainDir(): string {
    return mkdtempSync(join(tmpdir(), 'gbrain-backlinks-'));
  }

  function writeBrainFile(root: string, relPath: string, content: string): void {
    const full = join(root, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }

  test('findBacklinkGaps reports missing backlink for people/company refs', () => {
    const dir = makeBrainDir();
    try {
      writeBrainFile(
        dir,
        'meetings/q1-review.md',
        '# Q1 Review\n\nMet [Jane Doe](../people/jane-doe.md).\n',
      );
      writeBrainFile(
        dir,
        'people/jane-doe.md',
        '# Jane Doe\n\n## Timeline\n\n- **2026-01-01** | Existing note\n',
      );

      const gaps = findBacklinkGaps(dir);
      expect(gaps).toHaveLength(1);
      expect(gaps[0]).toMatchObject({
        sourcePage: 'meetings/q1-review.md',
        targetPage: 'people/jane-doe.md',
        entityName: 'Jane Doe',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('findBacklinkGaps skips pages that already reference the source filename', () => {
    const dir = makeBrainDir();
    try {
      writeBrainFile(
        dir,
        'meetings/q1-review.md',
        '# Q1 Review\n\nMet [Jane Doe](../people/jane-doe.md).\n',
      );
      writeBrainFile(
        dir,
        'people/jane-doe.md',
        '# Jane Doe\n\n## Timeline\n\n- **2026-01-01** | Referenced in [Q1 Review](../../meetings/q1-review.md)\n',
      );

      const gaps = findBacklinkGaps(dir);
      expect(gaps).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fixBacklinkGaps dry-run reports count but does not write file', () => {
    const dir = makeBrainDir();
    try {
      writeBrainFile(
        dir,
        'meetings/q1-review.md',
        '# Q1 Review\n\nMet [Jane Doe](../people/jane-doe.md).\n',
      );
      writeBrainFile(dir, 'people/jane-doe.md', '# Jane Doe\n\nNo timeline yet.\n');

      const gaps = findBacklinkGaps(dir);
      const before = readFileSync(join(dir, 'people/jane-doe.md'), 'utf-8');
      const fixed = fixBacklinkGaps(dir, gaps, true);
      const after = readFileSync(join(dir, 'people/jane-doe.md'), 'utf-8');

      expect(fixed).toBe(1);
      expect(after).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fixBacklinkGaps inserts Timeline section when missing', () => {
    const dir = makeBrainDir();
    try {
      writeBrainFile(
        dir,
        'meetings/q1-review.md',
        '# Q1 Review\n\nMet [Jane Doe](../people/jane-doe.md).\n',
      );
      writeBrainFile(dir, 'people/jane-doe.md', '# Jane Doe\n\nNo timeline yet.\n');

      const gaps = findBacklinkGaps(dir);
      const fixed = fixBacklinkGaps(dir, gaps, false);
      const content = readFileSync(join(dir, 'people/jane-doe.md'), 'utf-8');

      expect(fixed).toBe(1);
      expect(content).toContain('## Timeline');
      expect(content).toContain('Referenced in [Q1 Review]');
      expect(content).toContain('../meetings/q1-review.md');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
