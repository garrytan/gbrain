import { describe, test, expect } from 'bun:test';
import {
  extractEntityRefs,
  extractPageTitle,
  hasBacklink,
  buildBacklinkEntry,
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
