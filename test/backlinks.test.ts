import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  extractEntityRefs,
  extractPageTitle,
  hasBacklink,
  buildBacklinkEntry,
  fixBacklinkGaps,
} from '../src/commands/backlinks.ts';
import { parseMarkdown } from '../src/core/markdown.ts';

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

  test('extracts project, system, and concept markdown links', () => {
    const content = [
      '[MBrain](../projects/mbrain.md)',
      '[MBrain System](../systems/mbrain.md)',
      '[Brain Agent Loop](../concepts/brain-agent-loop.md)',
    ].join('\n');
    const refs = extractEntityRefs(content, 'notes/test.md');
    expect(refs.map(ref => `${ref.dir}/${ref.slug}`)).toEqual([
      'projects/mbrain',
      'systems/mbrain',
      'concepts/brain-agent-loop',
    ]);
  });

  test('extracts markdown links with titles and angle-bracket destinations', () => {
    const content = [
      '[MBrain](../projects/mbrain.md "Project page")',
      '[Brain Agent Loop](<../concepts/brain-agent-loop.md>)',
    ].join('\n');
    const refs = extractEntityRefs(content, 'notes/test.md');
    expect(refs.map(ref => `${ref.dir}/${ref.slug}`)).toEqual([
      'projects/mbrain',
      'concepts/brain-agent-loop',
    ]);
  });

  test('ignores image destinations', () => {
    const content = '![Diagram](../projects/mbrain.md)';
    expect(extractEntityRefs(content, 'notes/test.md')).toHaveLength(0);
  });

  test('extracts nested durable entity slugs', () => {
    const content = [
      '[Local setup](../projects/mbrain/docs/local-offline-setup.md)',
      '[[projects/mbrain/docs/manual/06-sync-pipeline|Sync Pipeline]]',
      '[Precision Lookup](../concepts/retrieval/precision-lookup.md)',
    ].join('\n');
    const refs = extractEntityRefs(content, 'notes/test.md');
    expect(refs.map(ref => `${ref.dir}/${ref.slug}`)).toEqual(expect.arrayContaining([
      'projects/mbrain/docs/local-offline-setup',
      'projects/mbrain/docs/manual/06-sync-pipeline',
      'concepts/retrieval/precision-lookup',
    ]));
    expect(refs).toHaveLength(3);
  });

  test('extracts project-local relative markdown links using the source page path', () => {
    const content = [
      '[Local setup](local-offline-setup.md)',
      '[Sync pipeline](./manual/06-sync-pipeline.md)',
      '[Project root](../../mbrain.md)',
    ].join('\n');
    const refs = extractEntityRefs(content, 'projects/mbrain/docs/index.md');
    expect(refs.map(ref => `${ref.dir}/${ref.slug}`)).toEqual([
      'projects/mbrain/docs/local-offline-setup',
      'projects/mbrain/docs/manual/06-sync-pipeline',
      'projects/mbrain',
    ]);
  });

  test('resolves explicitly relative entity-looking paths against the source page', () => {
    const content = [
      '[Local people doc](./people/alice.md)',
      '[Bare local people doc](people/bob.md)',
      '[Local system doc](../systems/cache.md)',
    ].join('\n');
    const refs = extractEntityRefs(content, 'projects/acme/docs/index.md');
    expect(refs.map(ref => `${ref.dir}/${ref.slug}`)).toEqual([
      'projects/acme/docs/people/alice',
      'projects/acme/docs/people/bob',
      'projects/acme/systems/cache',
    ]);
  });

  test('extracts wikilinks with aliases and anchors', () => {
    const content = [
      'See [[projects/mbrain|MBrain]]',
      'and [[systems/mbrain#sync]]',
      'plus [[concepts/brain-agent-loop]].',
    ].join('\n');
    const refs = extractEntityRefs(content, 'notes/test.md');
    expect(refs.map(ref => `${ref.dir}/${ref.slug}`)).toEqual([
      'projects/mbrain',
      'systems/mbrain',
      'concepts/brain-agent-loop',
    ]);
  });

  test('trims wikilink targets and aliases', () => {
    const refs = extractEntityRefs('See [[ projects/mbrain | MBrain ]]', 'notes/test.md');
    expect(refs).toEqual([{ dir: 'projects', slug: 'mbrain', name: 'MBrain' }]);
  });

  test('ignores generic docs links that are not durable entity roots', () => {
    const content = '[Guide](../docs/setup.md) and [[docs/reference/90]].';
    expect(extractEntityRefs(content, 'notes/test.md')).toHaveLength(0);
  });

  test('ignores docs links that contain entity-root directory names', () => {
    const content = [
      '[Project docs](../docs/projects/mbrain.md)',
      '[[docs/projects/mbrain]]',
      '[System docs](../docs/systems/mbrain.md)',
      '[[docs/concepts/brain-agent-loop]]',
    ].join('\n');
    expect(extractEntityRefs(content, 'notes/test.md')).toHaveLength(0);
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
  test('returns true when source path is linked from the target page', () => {
    const content = '## Timeline\n\n- Referenced in [Meeting](../meetings/q1-review.md)';
    expect(hasBacklink(content, 'meetings/q1-review.md', 'people/jane-doe.md')).toBe(true);
  });

  test('returns false when only another page with the same basename is linked', () => {
    const content = '## Timeline\n\n- Referenced in [Meeting](../../meetings/q1-review.md)';
    expect(hasBacklink(content, 'notes/q1-review.md', 'people/jane-doe.md')).toBe(false);
  });

  test('returns false when the source basename appears outside a backlink link', () => {
    const content = '## Timeline\n\n- Discussed q1-review.md in prose only.';
    expect(hasBacklink(content, 'meetings/q1-review.md', 'people/jane-doe.md')).toBe(false);
  });

  test('returns false for local relative links whose root-like path differs from the resolved target', () => {
    const content = '## Timeline\n\n- Referenced in [Local](meetings/q1-review.md)';
    expect(hasBacklink(content, 'meetings/q1-review.md', 'people/jane-doe.md')).toBe(false);
  });
});

describe('buildBacklinkEntry', () => {
  test('builds properly formatted entry', () => {
    const entry = buildBacklinkEntry('Q1 Review', '../../meetings/q1-review.md', '2026-04-11');
    expect(entry).toBe('- **2026-04-11** | Referenced in [Q1 Review](../../meetings/q1-review.md)');
  });
});

describe('fixBacklinkGaps', () => {
  test('writes generated backlinks to timeline rather than compiled truth when target has no separator', () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'mbrain-backlinks-'));
    try {
      mkdirSync(join(brainDir, 'people'), { recursive: true });
      writeFileSync(join(brainDir, 'people/jane.md'), [
        '---',
        'type: person',
        'title: Jane',
        '---',
        '',
        'Jane is a person.',
        '',
      ].join('\n'));

      const fixed = fixBacklinkGaps(brainDir, [{
        sourcePage: 'meetings/q1.md',
        targetPage: 'people/jane.md',
        entityName: 'Jane',
        sourceTitle: 'Q1 Review',
      }]);

      expect(fixed).toBe(1);
      const parsed = parseMarkdown(readFileSync(join(brainDir, 'people/jane.md'), 'utf-8'));
      expect(parsed.compiled_truth).toBe('Jane is a person.');
      expect(parsed.timeline).toContain('Referenced in [Q1 Review](../meetings/q1.md)');
    } finally {
      rmSync(brainDir, { recursive: true, force: true });
    }
  });

  test('does not treat similarly named compiled headings as legacy Timeline sections', () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'mbrain-backlinks-'));
    try {
      mkdirSync(join(brainDir, 'people'), { recursive: true });
      writeFileSync(join(brainDir, 'people/jane.md'), [
        '---',
        'type: person',
        'title: Jane',
        '---',
        '',
        'Jane is a person.',
        '',
        '## Timeline Architecture',
        '',
        'The product uses timelines as a retrieval concept.',
        '',
      ].join('\n'));

      const fixed = fixBacklinkGaps(brainDir, [{
        sourcePage: 'meetings/q1.md',
        targetPage: 'people/jane.md',
        entityName: 'Jane',
        sourceTitle: 'Q1 Review',
      }]);

      expect(fixed).toBe(1);
      const parsed = parseMarkdown(readFileSync(join(brainDir, 'people/jane.md'), 'utf-8'));
      expect(parsed.compiled_truth).toContain('## Timeline Architecture');
      expect(parsed.compiled_truth).toContain('The product uses timelines as a retrieval concept.');
      expect(parsed.timeline).toContain('Referenced in [Q1 Review](../meetings/q1.md)');
      expect(parsed.timeline).not.toContain('Architecture');
    } finally {
      rmSync(brainDir, { recursive: true, force: true });
    }
  });
});
