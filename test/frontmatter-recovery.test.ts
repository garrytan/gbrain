/**
 * #5988 Lane A: the frontmatter reader recovers what it can read exactly
 * (quoting a value), holds what it would have to guess, and never reads a
 * protected key as a broader value.
 *
 * Protects: import of the issue's files, the hold classification every
 * ingestion path shares, and the upgrade invariant (a file that imports today
 * parses to the same values). Regressions it catches: the validator rejecting
 * files the parser reads (R2), a guessed value or a swallowed `visibility`
 * being imported, a rule rewriting a valid line, raw values leaking into
 * persisted messages.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyImportHold, parseMarkdown, recoverFrontmatter, HOLD_CODES, PROTECTED_FRONTMATTER_KEYS,
  IDENTITY_FRONTMATTER_KEYS, RECOVERY_VERSION, type ParsedMarkdown,
} from '../src/core/markdown.ts';
import { isPrivatePage } from '../src/core/search/private-visibility.ts';

const doc = (block: string, body = 'Body text.\n') => `---\n${block}\n---\n\n${body}`;
const parse = (content: string, path = 'notes/example.md') => parseMarkdown(content, path, { validate: true });
const hold = (parsed: ParsedMarkdown) => classifyImportHold(parsed);
const allFrontmatter = (parsed: ParsedMarkdown) => ({ ...parsed.frontmatter, title: parsed.title, type: parsed.type });

describe('recoverable shapes import with their exact text', () => {
  test("the issue's exact author line (unquoted ': ') imports and is not held", () => {
    const parsed = parse(doc('title: Payments roundup\nauthor: PYMNTS (citing Reuters / Bloomberg) (original: https://x.com/a/status/1)'));
    expect(parsed.frontmatter.author).toBe('PYMNTS (citing Reuters / Bloomberg) (original: https://x.com/a/status/1)');
    expect(hold(parsed)).toBeNull();
    const yaml = parsed.errors!.find(e => e.code === 'YAML_PARSE')!;
    expect(yaml.recoverable).toBe(true);
    expect(yaml.recovery).toEqual([{ kind: 'quote', key: 'author', line: 3, recovery_version: RECOVERY_VERSION }]);
    expect(parsed.warnings!.map(w => [w.code, w.key, w.line])).toEqual([['FRONTMATTER_RECOVERED', 'author', 3]]);
  });

  test('"quoted" trailing text keeps the whole value text', () => {
    const parsed = parse(doc('title: "Quoted" trailing words\ntype: note'));
    expect(parsed.title).toBe('"Quoted" trailing words');
    expect(parsed.recovery?.status).toBe('recovered');
    expect(hold(parsed)).toBeNull();
  });

  test('nested quotes keep the inner text, as the NESTED_QUOTES fix does', () => {
    const parsed = parse(doc('title: "Name "Nick" Last"'));
    expect(parsed.title).toBe('Name "Nick" Last');
    expect(parsed.errors!.map(e => e.code)).toContain('NESTED_QUOTES');
    expect(hold(parsed)).toBeNull();
  });

  test('a single-quoted scalar followed by text and an unclosed leading quote are quoted', () => {
    expect(parse(doc("title: 'it' s here")).title).toBe("'it' s here");
    expect(parse(doc('title: "Hello\ntype: note')).title).toBe('"Hello');
  });

  test('CRLF files recover and keep CRLF on every line, including the rewritten one', () => {
    const block = 'title: Re: hello\r\nstatus: draft # todo\r\n';
    const recovered = recoverFrontmatter(block);
    expect(recovered.status).toBe('recovered');
    expect(recovered.block).toBe('title: "Re: hello"\r\nstatus: draft # todo\r\n');
    const parsed = parse('---\r\ntitle: Re: hello\r\ntype: note\r\n---\r\nbody\r\n');
    expect(parsed.title).toBe('Re: hello');
    expect(hold(parsed)).toBeNull();
  });

  test('a BOM-prefixed file recovers', () => {
    const parsed = parse('\uFEFF---\ntitle: Re: hello\n---\nbody\n');
    expect(parsed.title).toBe('Re: hello');
    expect(hold(parsed)).toBeNull();
  });

  test('valid lines stay byte-identical; only the suspect line is rewritten', () => {
    const block = 'status: draft # todo\ntitle: "Hello" world\ntags: [a, b]\ndate: 2024-06-01\n';
    const recovered = recoverFrontmatter(block);
    expect(recovered.status).toBe('recovered');
    expect(recovered.block.split('\n')).toEqual(['status: draft # todo', 'title: "\\"Hello\\" world"', 'tags: [a, b]', 'date: 2024-06-01', '']);
    expect(recovered.steps.map(s => [s.kind, s.key, s.line])).toEqual([['quote', 'title', 2]]);
  });

  test('a recovered visibility-bearing file keeps its private visibility end to end', () => {
    const parsed = parse(doc('title: "Hello" world\nvisibility: private'));
    expect(hold(parsed)).toBeNull();
    expect(isPrivatePage({ type: parsed.type, frontmatter: parsed.frontmatter })).toBe(true);
  });
});

describe('interpretive shapes are held, never imported', () => {
  test('a value continuing on unquoted lines (fold) is needs_interpretation, with the proposal kept', () => {
    const parsed = parse(doc('title: First line of a post\nsecond line of the post\ntype: note'));
    expect(parsed.frontmatter).toEqual({});
    expect(hold(parsed)).toMatchObject({ code: 'invalid_frontmatter', reason: 'needs_interpretation', key: 'title', line: 2 });
    expect(parsed.recovery!.block).toContain('title: "First line of a post\\nsecond line of the post"');
  });

  test('a duplicated non-identity key is needs_interpretation naming both lines', () => {
    const parsed = parse(doc('title: a\ntype: note\ntitle: b'));
    expect(hold(parsed)).toMatchObject({ code: 'invalid_frontmatter', reason: 'needs_interpretation', key: 'title', line: 4 });
    expect(parsed.recovery!.steps[0]).toMatchObject({ kind: 'dup', key: 'title', line: 4, otherLine: 2 });
  });

  test('an unclosed [ is needs_interpretation', () => {
    expect(hold(parse(doc('tags: [a, b\ntype: note')))).toMatchObject({ reason: 'needs_interpretation', key: 'tags' });
  });

  test('shapes with no rule are unrecoverable yaml_parse holds', () => {
    expect(hold(parse(doc('tags:\n  - a\n - b')))).toMatchObject({ code: 'invalid_frontmatter', reason: 'yaml_parse', key: 'tags' });
    expect(recoverFrontmatter('title: ok\n  bad: indent\n').status).toBe('unrecoverable');
  });

  test('duplicated identity keys are held as ambiguous_identity_key', () => {
    for (const key of IDENTITY_FRONTMATTER_KEYS) {
      const h = hold(parse(doc(`${key}: one\ntitle: a\n${key}: two`)));
      expect(h).toMatchObject({ code: 'invalid_frontmatter', reason: 'ambiguous_identity_key', key, line: 4 });
      expect(h!.message.startsWith('Invalid YAML frontmatter: ambiguous identity key')).toBe(true);
    }
  });
});

describe('protected keys are never guessed', () => {
  test('a visibility swallowed by an unclosed quote is held although YAML parses it', () => {
    const parsed = parse(doc('title: "Hello\nvisibility: private\nsummary: x"'));
    expect(parsed.errors!.some(e => e.code === 'YAML_PARSE')).toBe(false);
    expect(isPrivatePage({ type: parsed.type, frontmatter: parsed.frontmatter })).toBe(false);
    expect(hold(parsed)).toMatchObject({ code: 'invalid_frontmatter', reason: 'ambiguous_protected_key', key: 'visibility', line: 3 });
  });

  test('a protected value the pre-quote pass rewrote is held', () => {
    const parsed = parse(doc('title: a\nvisibility: private # note: x'));
    expect(hold(parsed)).toMatchObject({ reason: 'ambiguous_protected_key', key: 'visibility', line: 3 });
  });

  test('an unclosed fence carrying visibility is held instead of importing with no frontmatter', () => {
    const parsed = parse('---\ntitle: a\nvisibility: private\n\n# Heading\nbody\n');
    expect(parsed.errors!.map(e => e.code)).toContain('MISSING_CLOSE');
    expect(hold(parsed)).toMatchObject({ reason: 'ambiguous_protected_key', key: 'visibility', line: 3 });
  });

  test('duplicated visibility, a quoted visibility with trailing text and a fold into derived_from are held', () => {
    expect(hold(parse(doc('visibility: private\ntitle: a\nvisibility: world')))).toMatchObject({ reason: 'ambiguous_protected_key', key: 'visibility' });
    expect(hold(parse(doc('visibility: "private" trailing')))).toMatchObject({ reason: 'ambiguous_protected_key', key: 'visibility' });
    expect(hold(parse(doc('derived_from: notes/a\nnotes/b\ntitle: x')))).toMatchObject({ reason: 'ambiguous_protected_key', key: 'derived_from' });
  });

  test('every frontmatter key the access-control and provenance readers use is protected', () => {
    const readers = ['src/core/search/private-visibility.ts', 'src/core/repair/visibility.ts', 'src/core/persistence/connector-sync.ts'];
    const keys = new Set<string>();
    for (const file of readers) {
      const text = readFileSync(join(import.meta.dir, '..', file), 'utf8');
      for (const m of text.matchAll(/frontmatter(?:->>?'|\??\.)([a-z_]+)/g)) keys.add(m[1]!);
    }
    expect(keys.size).toBeGreaterThan(3);
    for (const key of keys) expect(PROTECTED_FRONTMATTER_KEYS).toContain(key);
  });
});

describe('contract surfaces', () => {
  test('producer checks stay strict: recoverable YAML_PARSE stays in errors; warnings are separate', () => {
    const parsed = parse(doc('title: Re: hello'));
    expect(parsed.errors!.map(e => e.code)).toEqual(['YAML_PARSE']);
    expect(parsed.warnings!.map(w => w.code)).toEqual(['FRONTMATTER_RECOVERED']);
    expect(parse(doc('title: fine')).warnings).toEqual([]);
  });

  test('#-comment values are detected without changing the parse; a spaced comment is left alone', () => {
    const parsed = parse(doc('title: #1 thing\ndescription: # TODO'));
    expect(parsed.frontmatter.description).toBeNull();
    expect(parsed.title).toBe('Example');
    expect(parsed.warnings!.map(w => [w.code, w.key, w.line])).toEqual([['FRONTMATTER_COMMENT_VALUE', 'title', 2]]);
    expect(hold(parsed)).toBeNull();
  });

  test('hold messages and YAML_PARSE messages are location-only', () => {
    const secret = 'alice-example private note';
    for (const block of [`title: ${secret}\nmore of ${secret}`, `tags:\n  - ${secret}\n - b`, `title: "${secret}" x\ntitle: y`]) {
      const parsed = parse(doc(block));
      const h = hold(parsed)!;
      expect(h.message.startsWith('Invalid YAML frontmatter:')).toBe(true);
      expect(h.message).not.toContain('alice-example');
      for (const e of parsed.errors!) expect(e.message).not.toContain('alice-example');
    }
  });

  test('HOLD_CODES is the canonical hold set', () => {
    expect([...HOLD_CODES]).toEqual(['invalid_frontmatter', 'frontmatter_slug_conflict', 'file_too_large', 'rename_held', 'parser_regression', 'tag_too_long']);
  });

  test('slug conflicts hold unless the recorded-origin exemption applies', () => {
    const parsed = parse(doc('slug: other/page'), 'notes/page.md');
    expect(classifyImportHold(parsed, { expectedSlug: 'notes/page' })).toMatchObject({ code: 'frontmatter_slug_conflict', key: 'slug' });
    expect(classifyImportHold(parsed, { expectedSlug: 'notes/page', slugExempt: slug => slug === 'other/page' })).toBeNull();
  });
});

describe('upgrade invariant: files that import today parse to identical values', () => {
  const corpus: Array<[string, Record<string, unknown>]> = [
    ['title: foo # note: x\ntype: note', { title: 'foo # note: x', type: 'note' }],
    ['title: #1 thing\ntype: note', { title: 'Example', type: 'note' }],
    ['status: draft # todo\ntitle: Plain', { status: 'draft', title: 'Plain', type: 'note' }],
    ['title: Re: October booking\ntype: email', { title: 'Re: October booking', type: 'email' }],
    ['title: "Quoted: fine"\ntags: [a, "b c"]', { title: 'Quoted: fine', type: 'note' }],
    ["title: 'single \"inner\" quotes'", { title: 'single "inner" quotes', type: 'note' }],
    ['title: Ends with colon:\nvisibility: world', { title: 'Ends with colon:', visibility: 'world', type: 'note' }],
    ['title: >\n  folded block\n  text\ntype: concept', { title: 'folded block text', type: 'concept' }],
    ['description: |\n  line one\n  line two\ntitle: Block', { description: 'line one\nline two\n', title: 'Block', type: 'note' }],
    ['title: Multi\n  line plain\ntype: note', { title: 'Multi line plain', type: 'note' }],
    ['title: "Hello\n  continued"', { title: 'Hello continued', type: 'note' }],
    ['tags:\n- a\n- b\ntitle: Seq', { title: 'Seq', type: 'note' }],
    ['title: 2024-06-01', { title: '2024-06-01', type: 'note' }],
    ['date: 2024-02-30\ntitle: Bad date', { date: '2024-02-30', title: 'Bad date', type: 'note' }],
  ];
  for (const [block, expected] of corpus) {
    test(JSON.stringify(block), () => {
      const content = doc(block);
      const parsed = parse(content, 'notes/example.md');
      expect(parsed.recovery?.steps ?? []).toEqual([]);
      expect(parsed.recovery).toBeUndefined();
      expect(allFrontmatter(parsed)).toMatchObject(expected);
      expect(hold(parsed)).toBeNull();
      const plain = parseMarkdown(content, 'notes/example.md');
      expect(allFrontmatter(plain)).toEqual(allFrontmatter(parsed));
    });
  }
});
