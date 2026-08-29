import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseMarkdown, serializeMarkdown, splitBody, resolveSourceLocalFilePath } from '../src/core/markdown.ts';

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

  // rule 3's heading match used \b, which matches any heading that
  // merely STARTS with "Timeline"/"History" ("## History & Reach",
  // "## Timeline of Events"). That silently moved the rest of an ordinary
  // article into the timeline half. Rule 3 is a back-compat shim for pages
  // gbrain itself wrote, so it takes the exact heading only.
  test('does NOT split at --- when the heading only STARTS with History', () => {
    const body = 'Article content\n\n---\n\n## History & Reach\n\n- item';
    const { compiled_truth, timeline } = splitBody(body);
    expect(compiled_truth).toBe(body);
    expect(timeline).toBe('');
  });

  test('does NOT split at --- when the heading only STARTS with Timeline', () => {
    const body = 'Article content\n\n---\n\n## Timeline of Events\n\ntext';
    const { compiled_truth, timeline } = splitBody(body);
    expect(compiled_truth).toBe(body);
    expect(timeline).toBe('');
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

  test('keeps the whole body when a section heading merely starts with History', () => {
    // Real shape from an imported chat transcript: HR-separated sections,
    // one of them '## History & Reach'. Pre-fix the page was cut at the HR
    // and everything below it landed in the timeline column.
    const md = `---
type: source
title: Example show
---

Here's a breakdown of how it works.

---

## Format & Premise

- 30 singles date in pods.

---

## History & Reach

- The show premiered in 2020.

---

## Reception

- Critics noted the format.`;
    const parsed = parseMarkdown(md);
    expect(parsed.timeline).toBe('');
    expect(parsed.compiled_truth).toContain('## Format & Premise');
    expect(parsed.compiled_truth).toContain('## History & Reach');
    expect(parsed.compiled_truth).toContain('premiered in 2020');
    expect(parsed.compiled_truth).toContain('## Reception');
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

// issue #1939 — js-yaml parses `title: 2024-06-01` as a Date and `title: 1458`
// as a number. The old `(frontmatter.title as string)` cast was a compile-time
// lie; at runtime downstream `.toLowerCase()` threw and wedged sync. Coercion
// must be non-throwing AND deterministic (UTC ISO for dates, no timezone drift).
describe('issue #1939 — non-string frontmatter coercion', () => {
  test('date title coerces to its UTC ISO date string', () => {
    const parsed = parseMarkdown('---\ntitle: 2024-06-01\n---\nbody\n', 'apple-notes/x.md');
    expect(parsed.title).toBe('2024-06-01');
    expect(typeof parsed.title).toBe('string');
  });

  test('number title coerces to its string form', () => {
    const parsed = parseMarkdown('---\ntitle: 1458\n---\nbody\n', 'apple-notes/x.md');
    expect(parsed.title).toBe('1458');
  });

  test('date title is timezone-independent (UTC) — repro file shape', () => {
    // sources/apple-notes/YC/Talks YC/2023-04-25 1458.md style page.
    const parsed = parseMarkdown('---\ntitle: 2023-04-25\n---\nnotes\n', 'apple-notes/2023-04-25 1458.md');
    expect(parsed.title).toBe('2023-04-25'); // never "Mon Apr 24 2023 ...GMT-0700"
  });

  test('date/number slug + type coerce without throwing', () => {
    const parsed = parseMarkdown('---\nslug: 2024-06-01\ntype: 2024\n---\nbody\n', 'x.md');
    expect(typeof parsed.slug).toBe('string');
    expect(parsed.slug).toBe('2024-06-01');
    expect(typeof parsed.type).toBe('string');
  });

  test('missing/empty title falls back to inferred title (no throw)', () => {
    const parsed = parseMarkdown('---\ntype: note\n---\nbody\n', 'people/alice-example.md');
    expect(typeof parsed.title).toBe('string');
    expect(parsed.title.length).toBeGreaterThan(0);
  });

  test('string title still passes through unchanged', () => {
    const parsed = parseMarkdown('---\ntitle: A Normal Title\n---\nbody\n', 'x.md');
    expect(parsed.title).toBe('A Normal Title');
  });
});

// issue #2446 — when frontmatter has no `title:`, prefer the body's first H1
// over the slug/filename-humanized fallback. Slug-based imports (contacts,
// calendar) carry a correct `# Heading` but no frontmatter title; humanizing
// the slug leaks date/id tokens and loses casing (`Defalco` vs `DeFalco`).
describe('issue #2446 — body H1 fallback for missing frontmatter title', () => {
  test('no frontmatter title uses the body H1, not the slug-humanized junk', () => {
    const md = '---\ntype: person\n---\n\n# John DeFalco\n\nNotes about John.\n';
    const parsed = parseMarkdown(md, 'people/contact-20170928-5-john-defalco.md');
    expect(parsed.title).toBe('John DeFalco');
    // The slug-derived junk title must NOT win.
    expect(parsed.title).not.toBe('Contact 20170928 5 John Defalco');
  });

  test('no frontmatter title and no H1 falls back to the inferred slug title', () => {
    const md = '---\ntype: note\n---\n\njust body prose, no heading\n';
    const parsed = parseMarkdown(md, 'people/alice-example.md');
    expect(parsed.title).toBe('Alice Example');
  });

  test('frontmatter title wins over a body H1 (no regression)', () => {
    const md = '---\ntitle: Frontmatter Wins\n---\n\n# Body Heading\n\nbody\n';
    const parsed = parseMarkdown(md, 'people/some-slug.md');
    expect(parsed.title).toBe('Frontmatter Wins');
  });

  test('h2 is not treated as the title; first real H1 is used', () => {
    const md = '---\ntype: note\n---\n\n## Subsection First\n\n# The Real Title\n\nbody\n';
    const parsed = parseMarkdown(md, 'notes/x.md');
    expect(parsed.title).toBe('The Real Title');
  });

  test('a # inside a fenced code block is not mistaken for the title', () => {
    const md = '---\ntype: note\n---\n\n```sh\n# this is a shell comment, not a heading\n```\n\n# Actual Heading\n';
    const parsed = parseMarkdown(md, 'notes/x.md');
    expect(parsed.title).toBe('Actual Heading');
  });

  test('trailing closing hashes are stripped from the H1', () => {
    const md = '---\ntype: note\n---\n\n# Closed ATX Heading #\n\nbody\n';
    const parsed = parseMarkdown(md, 'notes/x.md');
    expect(parsed.title).toBe('Closed ATX Heading');
  });
});

// github.com/garrytan/gbrain/issues/3708 — an unquoted `: ` inside a
// frontmatter scalar (near-universal in "Re: ..." email/message subjects)
// used to break gray-matter's parse of the whole leading frontmatter block:
// it silently fell back to empty frontmatter + type 'concept' + a
// slug-derived title, with the well-formed original document folded into
// the body underneath a synthesized wrapper — indistinguishable at a
// glance from accidental double-frontmatter corruption. Fixed by quoting
// ambiguous scalars before gray-matter ever sees them.
describe('Markdown Parser — ambiguous-colon frontmatter scalars (#3708)', () => {
  test('an unquoted "Re: ..." title parses correctly instead of falling back to concept/slug-title', () => {
    const md = `---
type: imessage
title: Text with Jane Oh re: October 24 booking
participants: ["Jane Oh"]
---

**Jane Oh** (12:35 PM): body text`;
    const parsed = parseMarkdown(md, 'messages/jane-oh.md');
    // The discriminating assertions: on the unfixed code these are
    // 'concept' / false / 'Jane Oh' (slug-derived) instead.
    expect(parsed.type).toBe('imessage');
    expect(parsed.typeExplicit).toBe(true);
    expect(parsed.title).toBe('Text with Jane Oh re: October 24 booking');
    // The body must NOT contain the frontmatter fence — proof the fence was
    // actually recognized and stripped, not just coincidentally present.
    expect(parsed.compiled_truth).not.toContain('---');
    expect(parsed.compiled_truth).toContain('body text');
  });

  test('a trailing colon in a title is also quoted (the other ambiguous YAML case)', () => {
    const md = '---\ntype: email\ntitle: Subject line ending in a colon:\n---\n\nbody';
    const parsed = parseMarkdown(md, 'emails/x.md');
    expect(parsed.type).toBe('email');
    expect(parsed.title).toBe('Subject line ending in a colon:');
  });

  test('an already-quoted colon-bearing value is left alone (idempotent, no double-quoting)', () => {
    const md = '---\ntype: email\ntitle: "Re: already quoted"\n---\n\nbody';
    const parsed = parseMarkdown(md, 'emails/x.md');
    expect(parsed.type).toBe('email');
    expect(parsed.title).toBe('Re: already quoted');
  });

  test('a colon not followed by a space (e.g. a URL) is left untouched', () => {
    const md = '---\ntype: bookmark\ntitle: See http://example.com/page for details\n---\n\nbody';
    const parsed = parseMarkdown(md, 'bookmarks/x.md');
    expect(parsed.type).toBe('bookmark');
    expect(parsed.title).toBe('See http://example.com/page for details');
  });

  test('multi-line list values under a key are untouched (only top-level key: value lines are ever quoted)', () => {
    const md = `---
type: email
title: Re: multi-recipient thread
participants:
  - "Alice: Ops Lead"
  - Bob
---

body`;
    const parsed = parseMarkdown(md, 'emails/x.md');
    expect(parsed.type).toBe('email');
    expect(parsed.title).toBe('Re: multi-recipient thread');
    expect(parsed.frontmatter.participants).toEqual(['Alice: Ops Lead', 'Bob']);
  });

  test('content with no frontmatter fence at all is returned unchanged', () => {
    const md = 'Just a body, no frontmatter: not even a fence.';
    const parsed = parseMarkdown(md, 'notes/x.md');
    expect(parsed.compiled_truth).toContain('Just a body, no frontmatter: not even a fence.');
  });
});

// ---------------------------------------------------------------------------
// #2225 — silent timeline destruction on naive get/put reassembly.
// A bare `## Timeline` / `## History` heading (no sentinel, no preceding ---)
// is what a naive MCP client produces when it concatenates get_page's
// compiled_truth + timeline fields and put_pages the result. Pre-fix,
// splitBody buried the whole timeline inside compiled_truth (timeline → 0B).
// The fallback splits at the first bare heading — heading KEPT in the
// timeline half — outside code fences, only when a non-empty prefix exists.
// ---------------------------------------------------------------------------

describe('splitBody bare-heading fallback (#2225)', () => {
  test('splits at a bare ## Timeline heading (no --- and no sentinel), heading kept in timeline', () => {
    const body = 'Article content\n\n## Timeline\n\n- 2024-01-01: Event happened';
    const { compiled_truth, timeline } = splitBody(body);
    expect(compiled_truth).toContain('Article content');
    expect(compiled_truth).not.toContain('Event happened');
    expect(timeline).toContain('## Timeline');
    expect(timeline).toContain('Event happened');
  });

  test('splits at a bare ## History heading (case-insensitive)', () => {
    const body = 'Company overview\n\n## history\n\n- 2020: Founded';
    const { compiled_truth, timeline } = splitBody(body);
    expect(compiled_truth).toContain('Company overview');
    expect(timeline).toContain('## history');
    expect(timeline).toContain('Founded');
  });

  test('explicit sentinel still wins over an earlier bare heading', () => {
    const body = 'Intro\n\n<!-- timeline -->\n\n## Timeline\n\n- 2024: entry';
    const { compiled_truth, timeline } = splitBody(body);
    expect(compiled_truth).toBe('Intro\n');
    expect(timeline).toContain('## Timeline');
    expect(timeline).toContain('- 2024: entry');
  });

  test('a ## Timeline inside a fenced code block does NOT split', () => {
    const body = 'Docs about markdown:\n\n```md\n## Timeline\n- example\n```\n\nMore prose.';
    const { compiled_truth, timeline } = splitBody(body);
    expect(compiled_truth).toBe(body);
    expect(timeline).toBe('');
  });

  test('heading-first body (empty prefix) does not split', () => {
    const body = '## Timeline\n\n- 2024: only content on the page';
    const { compiled_truth, timeline } = splitBody(body);
    expect(compiled_truth).toBe(body);
    expect(timeline).toBe('');
  });

  test('### Timeline (h3) is not a split point', () => {
    const body = 'Prose\n\n### Timeline\n\n- 2024: nested subsection';
    const { compiled_truth, timeline } = splitBody(body);
    expect(compiled_truth).toBe(body);
    expect(timeline).toBe('');
  });

  test('## Timelines (word-boundary) is not a split point', () => {
    const body = 'Prose\n\n## Timelines of various projects\n\ncontent';
    const { compiled_truth, timeline } = splitBody(body);
    // \b after (timeline|history) — "Timelines" must not match
    expect(timeline).toBe('');
  });

  test('ordinary wiki page: prose ## History + later unrelated H2 stays fully intact', () => {
    // The gate: '## History' whose section is prose (not dated bullets) is a
    // normal wiki section, NOT a gbrain timeline. Pre-gate, EVERYTHING after
    // the heading — including '## Architecture' — was eaten into timeline.
    const body = 'Widget Co overview.\n\n## History\n\nFounded in a garage. Grew steadily.\n\n## Architecture\n\nThree services and a queue.';
    const { compiled_truth, timeline } = splitBody(body);
    expect(compiled_truth).toBe(body);
    expect(timeline).toBe('');
  });

  test('split stops at the next H2: later unrelated sections stay in compiled_truth', () => {
    const body = 'Overview prose.\n\n## Timeline\n\n- 2024-01-01: Event one\n- 2024-06-01: Event two\n\n## References\n\n- [spec](https://example.com)';
    const { compiled_truth, timeline } = splitBody(body);
    expect(timeline).toContain('## Timeline');
    expect(timeline).toContain('Event one');
    expect(timeline).toContain('Event two');
    expect(timeline).not.toContain('## References');
    expect(compiled_truth).toContain('Overview prose.');
    expect(compiled_truth).toContain('## References');
    expect(compiled_truth).toContain('example.com');
    expect(compiled_truth).not.toContain('Event one');
  });

  test('prose ## History is skipped but a later timeline-shaped ## Timeline still splits', () => {
    const body = 'Intro.\n\n## History\n\nProse paragraph, no dates.\n\n## Timeline\n\n- 2023-03-03: Dated entry';
    const { compiled_truth, timeline } = splitBody(body);
    expect(timeline).toContain('## Timeline');
    expect(timeline).toContain('Dated entry');
    expect(compiled_truth).toContain('## History');
    expect(compiled_truth).toContain('Prose paragraph, no dates.');
  });

  test('wrapped dated bullets (indented continuations) still count as timeline-shaped', () => {
    const body = 'Prose.\n\n## Timeline\n\n- 2024-05-01: A long entry that\n  wraps onto a second line';
    const { compiled_truth, timeline } = splitBody(body);
    expect(timeline).toContain('wraps onto a second line');
    expect(compiled_truth).toBe('Prose.\n');
  });

  test('undated bullets under ## History do not split (not timeline-shaped)', () => {
    const body = 'Prose.\n\n## History\n\n- first thing that happened\n- second thing';
    const { compiled_truth, timeline } = splitBody(body);
    expect(compiled_truth).toBe(body);
    expect(timeline).toBe('');
  });

  test('naive get→edit→put reassembly round-trips the timeline', () => {
    // 1. Canonical page as gbrain writes it.
    const original = `---
type: company
title: Acme Example
---

Acme builds widgets.

<!-- timeline -->

- 2024-05-01: Series A closed
`;
    const first = parseMarkdown(original, 'companies/acme-example.md');
    expect(first.timeline).toContain('Series A closed');

    // 2. A naive MCP client reassembles fields with a plain heading (the
    //    #2225 report shape) and put_pages it back.
    const naive = `---
type: company
title: Acme Example
---

${first.compiled_truth}

## Timeline

${first.timeline}
`;
    const second = parseMarkdown(naive, 'companies/acme-example.md');
    expect(second.timeline).toContain('Series A closed');
    expect(second.compiled_truth).not.toContain('Series A closed');
    expect(second.compiled_truth).toContain('Acme builds widgets.');

    // 3. And the canonical serializer keeps it stable from there.
    const reserialized = serializeMarkdown({}, second.compiled_truth, second.timeline, {
      type: 'company', title: 'Acme Example', tags: [],
    });
    const third = parseMarkdown(reserialized, 'companies/acme-example.md');
    expect(third.timeline).toContain('Series A closed');
    expect(third.compiled_truth).not.toContain('Series A closed');
  });
});

describe('resolveSourceLocalFilePath — POSIX backslash-in-filename (undeclared_db_only_pages false positive)', () => {
  let repoRoot: string;

  afterEach(() => {
    if (repoRoot) rmSync(repoRoot, { recursive: true, force: true });
  });

  test('a real file whose name contains a literal backslash resolves to its actual on-disk path', () => {
    if (process.platform === 'win32') return; // `\` is the real separator there — no such filename is possible
    // Reproduces production data: an Apple Notes export can legitimately
    // contain a `\` character in a note title, which lands verbatim in the
    // exported filename on a POSIX filesystem (where `\` is a normal
    // filename character, not a path separator).
    repoRoot = mkdtempSync(join(tmpdir(), 'gbrain-backslash-'));
    mkdirSync(join(repoRoot, '.git'));
    mkdirSync(join(repoRoot, 'Archive', 'POL'), { recursive: true });
    const filename = '2019-10-03 \\event title-.md';
    const filePath = join(repoRoot, 'Archive', 'POL', filename);
    writeFileSync(filePath, '# note');

    const sourcePath = `Archive/POL/${filename}`;
    const resolved = resolveSourceLocalFilePath(repoRoot, sourcePath);

    expect(resolved).toBe(filePath);
  });

  test('negative control: a genuinely missing file still resolves to null-equivalent (no such path)', () => {
    if (process.platform === 'win32') return; // relies on `\` staying a filename character (POSIX-only)
    repoRoot = mkdtempSync(join(tmpdir(), 'gbrain-backslash-missing-'));
    mkdirSync(join(repoRoot, '.git'));
    mkdirSync(join(repoRoot, 'Archive', 'POL'), { recursive: true });
    // No file written — the resolved path must point at a location that
    // does not exist, so callers' existsSync() check correctly reports it
    // as unbacked (this stays a real gap, not a resolution bug).
    const sourcePath = 'Archive/POL/2019-10-03 \\never-written-.md';
    const resolved = resolveSourceLocalFilePath(repoRoot, sourcePath);

    expect(resolved).toBe(join(repoRoot, 'Archive', 'POL', '2019-10-03 \\never-written-.md'));
  });

  test('path traversal via a real `/`-separated `..` segment is still rejected', () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'gbrain-backslash-traversal-'));
    mkdirSync(join(repoRoot, '.git'));
    expect(resolveSourceLocalFilePath(repoRoot, '../../etc/passwd.md')).toBeNull();
  });

  test('a Windows drive-letter absolute path is still rejected', () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'gbrain-backslash-drive-'));
    mkdirSync(join(repoRoot, '.git'));
    expect(resolveSourceLocalFilePath(repoRoot, 'C:\\Windows\\evil.md')).toBeNull();
  });

  test('on Windows, `\\` stays a real separator and `..\\` traversal is still rejected', () => {
    if (process.platform !== 'win32') return; // the platform-aware split only changes POSIX behavior
    repoRoot = mkdtempSync(join(tmpdir(), 'gbrain-backslash-win-'));
    mkdirSync(join(repoRoot, '.git'));
    expect(resolveSourceLocalFilePath(repoRoot, '..\\..\\evil.md')).toBeNull();
  });
});
