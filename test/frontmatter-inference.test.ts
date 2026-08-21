/**
 * Tests for frontmatter-inference.ts — the zero-friction ingest pipeline.
 *
 * Validates that files without frontmatter get correct type, title, date,
 * source, and tags inferred from their filesystem path and content.
 */

import { describe, test, expect } from 'bun:test';
import matter from 'gray-matter';
import {
  compileExcludePatterns,
  DEFAULT_EXCLUDE_PATTERNS,
} from '../src/core/cycle/transcript-discovery.ts';
import {
  inferFrontmatter,
  extractDateFromFilename,
  extractTitleFromFilename,
  extractTitleFromHeading,
  serializeFrontmatter,
  applyInference,
  DIRECTORY_RULES,
} from '../src/core/frontmatter-inference.ts';

// ── Date extraction ──────────────────────────────────────────────────

describe('extractDateFromFilename', () => {
  test('extracts YYYY-MM-DD from date-prefixed filename', () => {
    expect(extractDateFromFilename('2010-04-13 Apr 13 founders mtg.md')).toBe('2010-04-13');
  });

  test('extracts date with dash separator', () => {
    expect(extractDateFromFilename('2024-01-30-therapy-session.md')).toBe('2024-01-30');
  });

  test('extracts date with underscore separator', () => {
    expect(extractDateFromFilename('2023-06-15_meeting-notes.md')).toBe('2023-06-15');
  });

  test('returns null for no-date filename', () => {
    expect(extractDateFromFilename('README.md')).toBe(null);
  });

  test('returns null for filename with numbers but no date', () => {
    expect(extractDateFromFilename('chapter-1-intro.md')).toBe(null);
  });
});

// ── Title extraction ─────────────────────────────────────────────────

describe('extractTitleFromFilename', () => {
  test('strips date prefix and cleans up', () => {
    expect(extractTitleFromFilename('2010-04-13 Apr 13 founders mtg.md')).toBe('Apr 13 founders mtg');
  });

  test('strips YYYY-MM-DD- prefix', () => {
    expect(extractTitleFromFilename('2024-01-30-therapy-session.md')).toBe('Therapy Session');
  });

  test('handles filename without date', () => {
    expect(extractTitleFromFilename('cognitive-distortions.md')).toBe('Cognitive Distortions');
  });

  test('preserves mixed case', () => {
    expect(extractTitleFromFilename('YC presidency.md')).toBe('YC presidency');
  });

  test('returns Untitled for empty result', () => {
    expect(extractTitleFromFilename('.md')).toBe('Untitled');
  });
});

describe('extractTitleFromHeading', () => {
  test('extracts first # heading', () => {
    expect(extractTitleFromHeading('# Dhravya Shah\n\n> Founder of Supermemory')).toBe('Dhravya Shah');
  });

  test('ignores ## headings', () => {
    expect(extractTitleFromHeading('Some text\n## Not this\n# This one')).toBe('This one');
  });

  test('returns null when no heading found', () => {
    expect(extractTitleFromHeading('Just some text\nwithout headings')).toBe(null);
  });

  test('looks within first 20 lines only', () => {
    const lines = Array(25).fill('text').join('\n') + '\n# Too Late';
    expect(extractTitleFromHeading(lines)).toBe(null);
  });
});

// ── Core inference ───────────────────────────────────────────────────

describe('inferFrontmatter', () => {
  test('skips files that already have frontmatter', () => {
    const result = inferFrontmatter('people/alice.md', '---\ntitle: Alice\n---\n# Alice');
    expect(result.skipped).toBe(true);
  });

  test('Apple Notes: infers type, date, title, source', () => {
    const result = inferFrontmatter(
      'Apple Notes/2010-04-13 Apr 13 founders mtg.md',
      '<span style="color:#000ff;">Top priority</span>',
    );
    expect(result.type).toBe('apple-note');
    expect(result.date).toBe('2010-04-13');
    expect(result.title).toBe('Apr 13 founders mtg');
    expect(result.source).toBe('apple-notes');
  });

  test('Apple Notes/YC: adds yc tag', () => {
    const result = inferFrontmatter(
      'Apple Notes/YC/2022-08-04 Project 1783Y.md',
      'Some content',
    );
    expect(result.type).toBe('apple-note');
    expect(result.tags).toContain('yc');
    expect(result.date).toBe('2022-08-04');
  });

  test('Apple Notes/Politics: adds politics tag', () => {
    const result = inferFrontmatter(
      'Apple Notes/Politics/2023-11-15 DA race notes.md',
      'Some content',
    );
    expect(result.tags).toContain('politics');
  });

  test('people/ directory: type person, title from heading', () => {
    const result = inferFrontmatter(
      'people/dhravya-shah.md',
      '# Dhravya Shah\n\n> Founder of Supermemory',
    );
    expect(result.type).toBe('person');
    expect(result.title).toBe('Dhravya Shah');
  });

  test('people/ directory: falls back to filename when no heading', () => {
    const result = inferFrontmatter(
      'people/john-doe.md',
      'Some text without a heading',
    );
    expect(result.type).toBe('person');
    expect(result.title).toBe('John Doe');
  });

  test('personal/therapy: infers therapy-session type with date', () => {
    const result = inferFrontmatter(
      'personal/therapy/jan/2024-01-30.md',
      'Session notes...',
    );
    expect(result.type).toBe('therapy-session');
    expect(result.date).toBe('2024-01-30');
    expect(result.source).toBe('therapy');
  });

  test('personal/reflections: infers reflection type, title from heading', () => {
    const result = inferFrontmatter(
      'personal/reflections/cognitive-distortions.md',
      '# Cognitive Distortions\n\nA list of common...',
    );
    expect(result.type).toBe('reflection');
    expect(result.title).toBe('Cognitive Distortions');
  });

  test('writing/essays: infers essay type', () => {
    const result = inferFrontmatter(
      'writing/essays/2024-03-15-on-being-remembered.md',
      '# On Being Remembered Forever\n\nSome thoughts...',
    );
    expect(result.type).toBe('essay');
    expect(result.title).toBe('On Being Remembered Forever');
    expect(result.date).toBe('2024-03-15');
  });

  test('daily/calendar: infers calendar-index type', () => {
    const result = inferFrontmatter(
      'daily/calendar/2026-01-15-yc-office-hours.md',
      '# Calendar Index\nSome calendar data',
    );
    expect(result.type).toBe('calendar-index');
    expect(result.source).toBe('calendar');
  });

  test('docs/runbooks: infers guide instead of catch-all note', () => {
    const result = inferFrontmatter(
      'docs/runbooks/cron-management-runbook.md',
      '# Cron Management Runbook\n\nUse this when changing schedules.',
    );
    expect(result.type).toBe('guide');
    expect(result.tags).toContain('runbook');
    expect(result.title).toBe('Cron Management Runbook');
  });

  test('docs/projects: infers project type', () => {
    const result = inferFrontmatter(
      'docs/projects/eva-brain.md',
      '# Eva Brain\n\nProject notes.',
    );
    expect(result.type).toBe('project');
    expect(result.tags).toContain('project');
  });

  test('companies/ directory: type company', () => {
    const result = inferFrontmatter(
      'companies/stripe.md',
      '# Stripe\n\n> Online payments infrastructure',
    );
    expect(result.type).toBe('company');
    expect(result.title).toBe('Stripe');
  });

  test('unknown directory: catch-all remains note when explicitly used by callers', () => {
    const result = inferFrontmatter(
      'random/some-file.md',
      '# My Random Notes\n\nStuff here',
    );
    expect(result.type).toBe('note');
    expect(result.title).toBe('My Random Notes');
  });

  test('handles empty content', () => {
    const result = inferFrontmatter('notes/empty.md', '');
    expect(result.type).toBe('note');
    expect(result.title).toBe('Empty');
  });
});

// ── Serialization ────────────────────────────────────────────────────

describe('serializeFrontmatter', () => {
  test('generates valid YAML frontmatter', () => {
    const fm = serializeFrontmatter({
      title: 'Apr 13 founders mtg',
      type: 'apple-note',
      date: '2010-04-13',
      source: 'apple-notes',
      tags: ['yc'],
    });
    expect(fm).toContain('---');
    expect(fm).toContain('title: Apr 13 founders mtg');
    expect(fm).toContain('type: apple-note');
    expect(fm).toContain('date: "2010-04-13"');
    expect(fm).toContain('source: apple-notes');
    // v0.37.9.0 — canonical single-quoted YAML flow. Aligns with
    // brain-writer's step 3a auto-fix output. Was double-quoted pre-v0.37.9.0.
    expect(fm).toContain(`tags: ['yc']`);
  });

  test('tags with apostrophe fall back to double quotes', () => {
    const fm = serializeFrontmatter({
      title: 'fashion note',
      type: 'note',
      tags: ["Men's Fashion", 'yc'],
    });
    // Apostrophe item keeps double quotes (JSON.stringify); clean item uses single.
    expect(fm).toContain(`tags: ["Men's Fashion", 'yc']`);
  });

  test('quotes title with special chars', () => {
    const fm = serializeFrontmatter({
      title: 'What\'s the deal: a "primer"',
      type: 'note',
    });
    expect(fm).toContain('title: "What\'s the deal: a \\"primer\\""');
  });

  // Regression: the title quoting rule was a denylist of "special" chars and
  // every gap corrupted a page at import. A round trip through gray-matter is
  // the assertion that matters — `toContain` on the emitted string cannot tell
  // a throw from a silent coercion.
  describe('title quoting round-trips through the YAML parser', () => {
    const cases: Array<[string, string]> = [
      ['leading backtick (blocked docs/guides/skillopt.md)', '`gbrain skillopt` — Self-evolving skills'],
      ['leading @ (YAML c-reserved)', '@mentions and you'],
      ['leading % (directive indicator)', '% completion tracking'],
      ['leading dash (parsed as a sequence — title went undefined)', '- dash leading title'],
      ['bare true (coerced to boolean)', 'true'],
      ['bare year (coerced to number)', '2026'],
      ['plain safe title', 'Search Modes'],
      ['colon and quotes', 'What\'s the deal: a "primer"'],
    ];
    for (const [label, title] of cases) {
      test(label, () => {
        const parsed = matter(serializeFrontmatter({ title, type: 'guide' }));
        expect(parsed.data.title).toBe(title);
        expect(typeof parsed.data.title).toBe('string');
      });
    }
  });

  test('leaves a provably-safe title unquoted', () => {
    expect(serializeFrontmatter({ title: 'Alice Smith', type: 'note' })).toContain(
      'title: Alice Smith',
    );
  });

  test('returns empty string for skipped files', () => {
    expect(serializeFrontmatter({ title: '', type: '', skipped: true })).toBe('');
  });

  test('omits optional fields when absent', () => {
    const fm = serializeFrontmatter({ title: 'Test', type: 'note' });
    expect(fm).not.toContain('date');
    expect(fm).not.toContain('source');
    expect(fm).not.toContain('tags');
  });
});

// ── Integration ──────────────────────────────────────────────────────

describe('applyInference', () => {
  test('prepends frontmatter to content without it', () => {
    const { content, inferred } = applyInference(
      'people/alice-smith.md',
      '# Alice Smith\n\n> Founder of FooBar',
    );
    expect(content).toMatch(/^---\n/);
    expect(content).toContain('type: person');
    expect(content).toContain('title: Alice Smith');
    expect(content).toContain('# Alice Smith');
    expect(inferred.skipped).toBeUndefined();
  });

  test('returns original content for files with frontmatter', () => {
    const original = '---\ntitle: Bob\n---\n# Bob';
    const { content, inferred } = applyInference('people/bob.md', original);
    expect(content).toBe(original);
    expect(inferred.skipped).toBe(true);
  });
});

// ── Rules coverage ───────────────────────────────────────────────────

describe('DIRECTORY_RULES', () => {
  test('has a catch-all rule with empty prefix', () => {
    const catchAll = DIRECTORY_RULES.find(r => r.pathPrefix === '');
    expect(catchAll).toBeDefined();
    expect(catchAll!.type).toBe('note');
  });

  // Mirror production normalization: inferFrontmatter lowercases BOTH sides
  // before `startsWith` (frontmatter-inference.ts:297), so a rule authored as
  // 'Apple Notes/YC/' matches at runtime and must be examined here too.
  const APPLE_PREFIX = 'apple notes/';
  const applePrefixOf = (r: { pathPrefix: string }) => r.pathPrefix.toLowerCase();
  const isAppleRule = (r: { pathPrefix: string }) => applePrefixOf(r).startsWith(APPLE_PREFIX);
  const isGenericApple = (r: { pathPrefix: string }) => applePrefixOf(r) === APPLE_PREFIX;

  /**
   * True when a subfolder rule reproduces exactly what the generic
   * 'apple notes/' rule already derives, and so can never change an outcome.
   */
  const isRedundantApple = (
    r: { pathPrefix: string; tags?: string[]; type?: string; source?: string; datePattern?: string; titleStrategy?: string },
    generic: { type?: string; source?: string; datePattern?: string; titleStrategy?: string },
  ): boolean => {
    if (!isAppleRule(r) || isGenericApple(r)) return false;
    const seg = applePrefixOf(r).slice(APPLE_PREFIX.length).replace(/\/+$/, '').split('/')[0];
    const derived = seg.replace(/\s+/g, '-');
    // inferFrontmatter defaults both optional strategy fields to 'filename'
    // (frontmatter-inference.ts:310, :317), so an omitted field and an
    // explicit 'filename' are the same rule. Comparing them literally would
    // let a redundant rule escape by simply leaving them out.
    const dp = (v?: string) => v ?? 'filename';
    const ts = (v?: string) => v ?? 'filename';
    const sameFields =
      r.type === generic.type &&
      r.source === generic.source &&
      dp(r.datePattern) === dp(generic.datePattern) &&
      ts(r.titleStrategy) === ts(generic.titleStrategy);
    return sameFields && [...(r.tags ?? [])].sort().join(',') === derived;
  };

  // Transcripts matching gbrain's sensitivity vocabulary are dropped before any
  // LLM call. A shipped DIRECTORY_RULE that maps a specific person's folder
  // onto one of those categories encodes a private fact about a real individual
  // into every install, which the Privacy rule in CLAUDE.md forbids for
  // checked-in code. Personal mappings belong in the operator's own notes.
  //
  // Matched with the production compiler, not a local `includes`: bare words
  // compile to \b<word>\b, so `therapy-notes` and `medical records` are caught
  // the same way discoverTranscripts catches them. An exact-equality check
  // would let those spellings recreate the association with CI green.
  test('no shipped rule binds a path to a sensitive category', () => {
    const res = compileExcludePatterns([...DEFAULT_EXCLUDE_PATTERNS]);
    expect(res.length).toBe(DEFAULT_EXCLUDE_PATTERNS.length); // no silent drop
    const offenders = DIRECTORY_RULES.filter(r =>
      (r.tags ?? []).some(t => res.some(re => re.test(t))),
    );
    // Report indices, not prefixes: an offending prefix is by definition the
    // kind of string this test exists to keep out of public artifacts, and a
    // failing assertion is printed into CI logs.
    expect(offenders.map(r => DIRECTORY_RULES.indexOf(r))).toEqual([]);
  });

  test('Apple Notes rules are more specific than the catch-all', () => {
    const appleRules = DIRECTORY_RULES.filter(isAppleRule);
    expect(appleRules.length).toBeGreaterThan(1); // subfolder rules + catch-all
    // EVERY subfolder rule must come before the generic one, not just a named
    // example: findIndex on an absent prefix returns -1, which satisfies
    // `toBeLessThan(genericIdx)` vacuously, so an assertion naming one rule
    // keeps passing after that rule is deleted.
    const genericIdx = DIRECTORY_RULES.findIndex(isGenericApple);
    expect(genericIdx).toBeGreaterThanOrEqual(0);
    const subIdx = appleRules
      .filter(r => !isGenericApple(r))
      .map(r => DIRECTORY_RULES.indexOf(r));
    expect(subIdx.length).toBeGreaterThan(0);
    for (const i of subIdx) expect(i).toBeLessThan(genericIdx);
  });

  test('no Apple Notes subfolder rule duplicates what the generic rule derives', () => {
    // The generic 'apple notes/' rule assigns type/source/date/title and tags
    // the first path segment, lowercased and hyphenated. A subfolder rule that
    // reproduces exactly that is dead weight: it can never change an output,
    // but it reads as a deliberate override.
    const generic = DIRECTORY_RULES.find(isGenericApple);
    expect(generic).toBeDefined();
    expect(DIRECTORY_RULES.filter(r => isRedundantApple(r, generic!)).map(r => r.pathPrefix)).toEqual([]);
  });

  test('a path under a removed prefix now reports the generic rule', () => {
    // Accepted, and pinned rather than incidental: `matchedRule` is a
    // diagnostic label, surfaced as results[].rule by `gbrain frontmatter`
    // (frontmatter.ts:486). Deleting a rule necessarily changes which rule is
    // named. Everything the label does NOT cover — title/type/date/source/tags,
    // i.e. every field serializeFrontmatter persists — is unchanged.
    const out = inferFrontmatter('Apple Notes/YC/2024-03-05 A Note.md', 'body');
    expect(out.matchedRule).toBe('apple notes/');
    expect(out).toMatchObject({
      title: 'A Note',
      type: 'apple-note',
      date: '2024-03-05',
      source: 'apple-notes',
      tags: ['yc'],
    });
    // The catch-all branch in frontmatter.ts keys on the literal '(default)',
    // so its skip decision is untouched by this rename.
    expect(out.matchedRule).not.toBe('(default)');
  });

  test('the redundancy predicate catches the shapes a naive one misses', () => {
    // A guard that never fires is indistinguishable from a guard that cannot
    // fire. Feed it the two spellings production would still match: a
    // mixed-case prefix (inferFrontmatter lowercases both sides before
    // startsWith) and a nested prefix (the generic rule tags parts[1] only,
    // so a deeper rule repeating the first segment is equally redundant).
    const generic = DIRECTORY_RULES.find(isGenericApple)!;
    const like = (pathPrefix: string, tags: string[]) => ({
      pathPrefix,
      tags,
      type: generic.type,
      source: generic.source,
      datePattern: generic.datePattern,
      titleStrategy: generic.titleStrategy,
    });
    expect(isRedundantApple(like('Apple Notes/YC/', ['yc']), generic)).toBe(true);
    expect(isRedundantApple(like('apple notes/yc/archive/', ['yc']), generic)).toBe(true);
    expect(isRedundantApple(like('apple notes/pitch notes/', ['pitch-notes']), generic)).toBe(true);
    // Omitting the optional strategy fields is the same rule as spelling out
    // their defaults, so leaving them out must not buy an escape.
    const { datePattern: _dp, titleStrategy: _ts, ...withoutDefaults } = like('apple notes/yc/', ['yc']);
    expect(isRedundantApple(withoutDefaults, generic)).toBe(true);
    // Real overrides must NOT be flagged: a different tag set, or a field the
    // generic rule sets differently.
    expect(isRedundantApple(like('apple notes/youtube shows/', ['youtube', 'shows']), generic)).toBe(false);
    expect(isRedundantApple({ ...like('apple notes/yc/', ['yc']), type: 'note' }, generic)).toBe(false);
    expect(isRedundantApple(like('wiki/yc/', ['yc']), generic)).toBe(false); // not an Apple Notes rule
  });
});
