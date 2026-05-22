import { describe, test, expect } from 'bun:test';
import { parseMarkdown, serializeMarkdown, splitBody } from '../src/core/markdown.ts';

describe('Markdown Parser', () => {
  test('parses frontmatter + compiled_truth + timeline (explicit sentinel)', () => {
    const md = `---
type: concept
title: Do Things That Don't Scale
tags: [startups, growth]
---

Paul Graham argues that startups should do unscalable things early on.

<!-- timeline -->

- 2013-07-01: Published on paulgraham.com
- 2024-11-15: Referenced in batch kickoff talk
`;
    const parsed = parseMarkdown(md);
    expect(parsed.type).toBe('concept');
    expect(parsed.title).toBe("Do Things That Don't Scale");
    expect(parsed.tags).toEqual(['startups', 'growth']);
    expect(parsed.compiled_truth).toContain('unscalable things');
    expect(parsed.timeline).toContain('Published on paulgraham.com');
    expect(parsed.timeline).toContain('batch kickoff talk');
  });

  test('handles no timeline separator', () => {
    const md = `---
type: concept
title: Superlinear Returns
---

Returns in many fields are superlinear.
Performance compounds over time.
`;
    const parsed = parseMarkdown(md);
    expect(parsed.compiled_truth).toContain('superlinear');
    expect(parsed.timeline).toBe('');
  });

  test('handles empty body', () => {
    const md = `---
type: concept
title: Empty Page
---
`;
    const parsed = parseMarkdown(md);
    expect(parsed.compiled_truth).toBe('');
    expect(parsed.timeline).toBe('');
  });

  test('removes type, title, tags from frontmatter object', () => {
    const md = `---
type: concept
title: Test
tags: [a, b]
custom_field: hello
---

Content
`;
    const parsed = parseMarkdown(md);
    expect(parsed.frontmatter).not.toHaveProperty('type');
    expect(parsed.frontmatter).not.toHaveProperty('title');
    expect(parsed.frontmatter).not.toHaveProperty('tags');
    expect(parsed.frontmatter).toHaveProperty('custom_field', 'hello');
  });

  test('infers type from file path', () => {
    const md = `---
title: Someone
---
Content
`;
    const parsed = parseMarkdown(md, 'people/someone.md');
    expect(parsed.type).toBe('person');
  });

  test('infers slug from file path', () => {
    const md = `---
type: concept
title: Test
---
Content
`;
    const parsed = parseMarkdown(md, 'concepts/do-things-that-dont-scale.md');
    expect(parsed.slug).toBe('concepts/do-things-that-dont-scale');
  });

  // v0.20: BrainBench / native inbox-chat-calendar Page types. These 5 directory
  // heuristics exercise PageType 'email | slack | calendar-event | note | meeting'
  // which were added for amara-life-v1 ingest but are useful for any gbrain user
  // ingesting an inbox dump, Slack export, iCal, meeting transcript, or daily notes.
  test.each([
    ['emails/em-0001.md', 'email'],
    ['email/em-0001.md', 'email'],
    ['slack/sl-0037.md', 'slack'],
    ['cal/evt-0042.md', 'calendar-event'],
    ['calendar/evt-0042.md', 'calendar-event'],
    ['notes/2026-04-standup.md', 'note'],
    ['note/2026-04-standup.md', 'note'],
    ['meetings/mtg-0003.md', 'meeting'],
    ['meeting/mtg-0003.md', 'meeting'],
  ] as const)('infers type %s -> %s', (path, expectedType) => {
    const md = `---\ntitle: Fixture\n---\nBody\n`;
    const parsed = parseMarkdown(md, path);
    expect(parsed.type).toBe(expectedType);
  });
});

describe('splitBody', () => {
  test('splits at <!-- timeline --> sentinel', () => {
    const body = 'Above the line\n\n<!-- timeline -->\n\nBelow the line';
    const { compiled_truth, timeline } = splitBody(body);
    expect(compiled_truth).toContain('Above the line');
    expect(timeline).toContain('Below the line');
  });

  test('splits at --- timeline --- sentinel', () => {
    const body = 'Above the line\n\n--- timeline ---\n\nBelow the line';
    const { compiled_truth, timeline } = splitBody(body);
    expect(compiled_truth).toContain('Above the line');
    expect(timeline).toContain('Below the line');
  });

  test('splits at --- when followed by ## Timeline heading', () => {
    const body = 'Article content\n\n---\n\n## Timeline\n\n- 2024: Event happened';
    const { compiled_truth, timeline } = splitBody(body);
    expect(compiled_truth).toContain('Article content');
    expect(timeline).toContain('## Timeline');
    expect(timeline).toContain('Event happened');
  });

  test('splits at --- when followed by ## History heading', () => {
    const body = 'Article content\n\n---\n\n## History\n\n- 2020: Founded';
    const { compiled_truth, timeline } = splitBody(body);
    expect(compiled_truth).toContain('Article content');
    expect(timeline).toContain('## History');
  });

  test('does NOT split at plain --- (horizontal rule in article body)', () => {
    const body = 'Above the line\n\n---\n\nBelow the line';
    const { compiled_truth, timeline } = splitBody(body);
    expect(compiled_truth).toBe(body);
    expect(timeline).toBe('');
  });

  test('does NOT split on multiple plain --- horizontal rules', () => {
    const body = 'Section 1\n\n---\n\nSection 2\n\n---\n\nSection 3';
    const { compiled_truth, timeline } = splitBody(body);
    expect(compiled_truth).toBe(body);
    expect(timeline).toBe('');
  });

  test('returns all as compiled_truth if no sentinel', () => {
    const body = 'Just some content\nWith multiple lines';
    const { compiled_truth, timeline } = splitBody(body);
    expect(compiled_truth).toBe(body);
    expect(timeline).toBe('');
  });

  test('plain --- at end of content stays in compiled_truth', () => {
    const body = 'Content here\n\n---\n';
    const { compiled_truth, timeline } = splitBody(body);
    expect(compiled_truth).toBe(body);
    expect(timeline).toBe('');
  });

  test('<!-- timeline --> with content before and after', () => {
    const body = '## Summary\n\nArticle summary here.\n\n---\n\nMore body content.\n\n<!-- timeline -->\n\n- 2024: Timeline entry';
    const { compiled_truth, timeline } = splitBody(body);
    expect(compiled_truth).toContain('## Summary');
    expect(compiled_truth).toContain('More body content.');
    expect(compiled_truth).not.toContain('Timeline entry');
    expect(timeline).toContain('Timeline entry');
  });
});

describe('serializeMarkdown', () => {
  test('round-trips through parse and serialize (explicit sentinel)', () => {
    const original = `---
type: concept
title: Do Things That Don't Scale
tags:
  - startups
  - growth
custom: value
---

Paul Graham argues that startups should do unscalable things early on.

<!-- timeline -->

- 2013-07-01: Published on paulgraham.com
`;
    const parsed = parseMarkdown(original);
    const serialized = serializeMarkdown(
      parsed.frontmatter,
      parsed.compiled_truth,
      parsed.timeline,
      { type: parsed.type, title: parsed.title, tags: parsed.tags },
    );

    // Re-parse the serialized version
    const reparsed = parseMarkdown(serialized);
    expect(reparsed.type).toBe(parsed.type);
    expect(reparsed.title).toBe(parsed.title);
    expect(reparsed.compiled_truth).toBe(parsed.compiled_truth);
    expect(reparsed.timeline).toBe(parsed.timeline);
    expect(reparsed.frontmatter.custom).toBe('value');
  });
});

describe('parseMarkdown edge cases', () => {
  test('does NOT split on plain --- separators (horizontal rules stay in compiled_truth)', () => {
    const md = `---
type: concept
title: Test
---

First section.

---

Second section.

---

Third section.`;
    const parsed = parseMarkdown(md);
    expect(parsed.compiled_truth).toContain('First section.');
    expect(parsed.compiled_truth).toContain('Second section.');
    expect(parsed.compiled_truth).toContain('Third section.');
    expect(parsed.timeline).toBe('');
  });

  test('splits on <!-- timeline --> sentinel with horizontal rules in body', () => {
    const md = `---
type: concept
title: Test
---

First section.

---

Second section.

<!-- timeline -->

- 2024: Timeline entry`;
    const parsed = parseMarkdown(md);
    expect(parsed.compiled_truth).toContain('First section.');
    expect(parsed.compiled_truth).toContain('Second section.');
    expect(parsed.compiled_truth).not.toContain('Timeline entry');
    expect(parsed.timeline).toContain('Timeline entry');
  });

  test('handles frontmatter without type or title', () => {
    const md = `---
custom_field: hello
---

Some content.`;
    const parsed = parseMarkdown(md);
    expect(parsed.type).toBeTruthy();
    expect(parsed.compiled_truth.trim()).toBe('Some content.');
    expect(parsed.frontmatter.custom_field).toBe('hello');
  });

  test('handles content with no frontmatter at all', () => {
    const md = `Just plain text with no YAML.`;
    const parsed = parseMarkdown(md);
    expect(parsed.compiled_truth).toContain('Just plain text');
  });

  test('handles empty string', () => {
    const parsed = parseMarkdown('');
    expect(parsed.compiled_truth).toBe('');
    expect(parsed.timeline).toBe('');
  });

  test('infers type from various directory paths', () => {
    expect(parseMarkdown('', 'people/someone.md').type).toBe('person');
    expect(parseMarkdown('', 'concepts/thing.md').type).toBe('concept');
    expect(parseMarkdown('', 'companies/acme.md').type).toBe('company');
  });

  test('infers type from wiki subdirectory paths', () => {
    expect(parseMarkdown('', 'tech/wiki/concepts/longevity-science.md').type).toBe('concept');
    expect(parseMarkdown('', 'tech/wiki/guides/team-os-claude-code.md').type).toBe('guide');
    expect(parseMarkdown('', 'tech/wiki/analysis/agi-timeline-debate.md').type).toBe('analysis');
    expect(parseMarkdown('', 'tech/wiki/hardware/h100-vs-gb200-training-benchmarks.md').type).toBe('hardware');
    expect(parseMarkdown('', 'tech/wiki/architecture/kb-infrastructure.md').type).toBe('architecture');
    expect(parseMarkdown('', 'finance/wiki/analysis/polymarket-bot-automation-thesis.md').type).toBe('analysis');
    expect(parseMarkdown('', 'personal/wiki/concepts/career-regrets-2026-framework.md').type).toBe('concept');
  });

  test('infers writing type from /writing/ paths', () => {
    expect(parseMarkdown('', 'writing/post.md').type).toBe('writing');
    expect(parseMarkdown('', 'projects/blog/writing/essay.md').type).toBe('writing');
  });
});
