/**
 * GBRA-75 wave 10: the doctor frontmatter scan's head-only parse
 * (`frontmatterScanHead`, `ScanOpts.frontmatterOnly`) must yield exactly the
 * findings of the whole-file parse.
 *
 * Protects: for every validation code, every warning and recovery status, and
 * the shapes the frontmatter readers disagree on (BOM, leading blank lines,
 * language selectors, CRLF, an indented or padded close, a `---x` line, an
 * empty block, a close at end of file, NUL bytes, `---` lines in the body),
 * the head parse gives the same errors, warnings, recovery, slug and import
 * hold as the full parse, and a shape it cannot prove falls back to the full
 * content unchanged. A seeded generator mixes the same fragments into 10,000
 * more documents. `scanBrainSources` with and without `frontmatterOnly`
 * returns the same report on a checkout holding every case.
 * Fails when: the head drops a finding the body carries (NUL bytes), a reader
 * closes the block somewhere else than the head ends, or a fallback case is
 * truncated.
 * Pure CPU plus a temp directory ($0); synthetic content only.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { frontmatterScanHead, scanBrainSources } from '../src/core/brain-writer.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { classifyImportHold, parseMarkdown, type ParseValidationCode } from '../src/core/markdown.ts';
import { slugifyPath } from '../src/core/sync.ts';

const ALL_CODES: ParseValidationCode[] = ['MISSING_OPEN', 'MISSING_CLOSE', 'YAML_PARSE', 'SLUG_MISMATCH', 'NULL_BYTES', 'NESTED_QUOTES', 'NON_STRING_FIELD', 'EMPTY_FRONTMATTER'];
const BODY = '# Heading\n\nBody text with [[a-link]].\n\n---\n\nAfter a thematic break.\n\n## Timeline\n\n- **2024-01-01** | Event\n';

/** [relative path, content, the head is shorter than the content]. */
const CASES: Array<[string, string, boolean]> = [
  ['clean.md', `---\ntitle: Clean\ntype: note\n---\n${BODY}`, true],
  ['crlf.md', `---\r\ntitle: Crlf\r\n---\r\n${BODY.replaceAll('\n', '\r\n')}`, true],
  ['missing-open.md', `No frontmatter.\n${BODY}`, false],
  ['empty-file.md', '   \n', false],
  ['missing-close.md', '---\ntitle: Missing Close\n# Heading\nBody.\n', false],
  ['missing-close-body-break.md', `---\ntitle: Closed By The Body Break\n${BODY}`, true],
  ['missing-close-eof.md', '---\ntitle: Missing Close', false],
  ['empty-frontmatter.md', `---\n---\n${BODY}`, false],
  ['empty-frontmatter-blank.md', `---\n\n---\n${BODY}`, true],
  ['nested-quotes.md', `---\ntitle: "Name "Nick" Last"\n---\n${BODY}`, true],
  ['yaml-unrecoverable.md', `---\ntitle: [unclosed\n---\n${BODY}`, true],
  ['needs-interpretation.md', `---\ntitle: [unclosed\ntags: a: b\n---\n${BODY}`, true],
  ['recoverable-colon.md', `---\ntitle: Ratio: 3:1 split\n---\n${BODY}`, true],
  ['recoverable-yaml.md', `---\ntitle: ok\nsummary: one: two\n  three\n---\n${BODY}`, true],
  ['duplicate-key.md', `---\ntitle: One\ntitle: Two\n---\n${BODY}`, true],
  ['protected-dup.md', `---\nslug: a\nslug: b\n---\n${BODY}`, true],
  ['slug-mismatch.md', `---\ntitle: S\nslug: somewhere-else\n---\n${BODY}`, true],
  ['slug-equivalent.md', `---\ntitle: S\nslug: Slug-Equivalent\n---\n${BODY}`, true],
  ['non-string.md', `---\ntitle: 123\ntype: 2024\nslug: 7\n---\n${BODY}`, true],
  ['null-body.md', `---\ntitle: Null\n---\nBody \u0000 here.\n`, false],
  ['null-frontmatter.md', '---\ntitle: Null\u0000 Front\n---\nBody.\n', false],
  ['comment-value.md', `---\ntitle: #hashtag title\n---\n${BODY}`, true],
  ['comment-value-other.md', `---\ntitle: T\nsummary: #not-rescued\n---\n${BODY}`, true],
  ['bom.md', `\uFEFF---\ntitle: Bom\n---\n${BODY}`, false],
  ['leading-blank.md', `\n\n---\ntitle: Leading\n---\n${BODY}`, false],
  ['language-yaml.md', `---yaml\ntitle: Language\n---\n${BODY}`, false],
  ['language-json.md', `---json\n{"title": "Json"}\n---\n${BODY}`, false],
  ['language-other.md', `---toml\ntitle = "x"\n---\n${BODY}`, false],
  ['opener-padded.md', `--- \ntitle: Padded\n---\n${BODY}`, false],
  ['indented-close.md', `---\ntitle: Indented\n  ---\nmore: x\n---\n${BODY}`, false],
  ['padded-close.md', `---\ntitle: Padded\n--- \n${BODY}`, false],
  ['tab-close.md', `---\ntitle: Tab\n---\t\n${BODY}`, false],
  ['dash-line.md', `---\ntitle: Dash\n---x\n---\n${BODY}`, false],
  ['four-dash.md', `---\ntitle: Four\n----\n---\n${BODY}`, false],
  ['block-scalar-dash.md', `---\ntitle: T\ndesc: |\n  ---\n  text\n---\n${BODY}`, false],
  ['close-at-eof.md', '---\ntitle: Eof\n---', false],
  ['close-then-eof.md', '---\ntitle: Eof\n---\n', false],
  ['crlf-close-eof.md', '---\r\ntitle: Eof\r\n---\r\n', false],
  ['mixed-eol.md', `---\r\ntitle: Mixed\n---\n${BODY}`, true],
  ['body-frontmatter.md', `---\ntitle: Twice\n---\n---\ntitle: Embedded\n---\n${BODY}`, true],
  ['body-only-dashes.md', `---\ntitle: T\n---\n---\n---\n---\n`, true],
  ['aliases.md', `---\ntitle: T\na: &a [x]\nb: [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a]\n---\n${BODY}`, true],
  ['array-root.md', `---\n- a\n- b\n---\n${BODY}`, true],
  ['scalar-root.md', `---\njust a string\n---\n${BODY}`, true],
  ['date-title.md', `---\ntitle: 2024-02-30\ntype: 2024-01-01\n---\n${BODY}`, true],
  ['unicode-space-close.md', `---\ntitle: T\n\u00a0---\n---\n${BODY}`, false],
  ['image.md', '---\ntitle: T\n---\n\u0000\u0001binary', false],
];

function verdict(content: string, rel: string) {
  const expectedSlug = slugifyPath(rel);
  const parsed = parseMarkdown(content, rel, { validate: true, expectedSlug });
  return { errors: parsed.errors, warnings: parsed.warnings, recovery: parsed.recovery ?? null, slug: parsed.slug,
    hold: classifyImportHold(parsed, { expectedSlug }) };
}

function expectSameVerdict(rel: string, content: string): boolean {
  const head = frontmatterScanHead(content);
  expect(content.startsWith(head)).toBe(true);
  if (head !== content) expect(verdict(head, rel)).toEqual(verdict(content, rel));
  return head !== content;
}

describe('frontmatterScanHead', () => {
  test('every case: same verdict on the head path, the full content on the fallback path', () => {
    const codes = new Set<string>();
    for (const [rel, content, fast] of CASES) {
      expect({ rel, fast: expectSameVerdict(rel, content) }).toEqual({ rel, fast });
      for (const e of verdict(content, rel).errors ?? []) codes.add(e.code);
    }
    expect([...codes].sort()).toEqual([...ALL_CODES].sort());
  });

  test('every validation code is reached on the head path except those it cannot prove', () => {
    const headCodes = new Set<string>();
    for (const [rel, content, fast] of CASES) if (fast) for (const e of verdict(content, rel).errors ?? []) headCodes.add(e.code);
    // MISSING_OPEN, MISSING_CLOSE and NULL_BYTES need the whole file; EMPTY_FRONTMATTER on `---\n---` too (an empty
    // block lets the colon quoting look past the close), but a blank-line block is still proven.
    expect([...headCodes].sort()).toEqual(['EMPTY_FRONTMATTER', 'NESTED_QUOTES', 'NON_STRING_FIELD', 'SLUG_MISMATCH', 'YAML_PARSE']);
  });

  test('10,000 generated documents: same verdict whenever the head path is taken', () => {
    const FM = ['title: Plain', 'title: Ratio: 3:1', 'title: "a "b" c"', 'title: [open', 'tags: a: b', 'title: 12', 'slug: x/y', 'slug: Other',
      'type: note', 'summary: #comment', 'desc: |', '  ---', '  text', '---x', '----', '  ---', '--- ', 'k: &a [1]', 'j: *a', '', '# c', 'title: Dup', 'title: Dup',
      'list:', '  - one', 'bad: : :', '\u0000', 'when: 2024-02-30', 'a: {open', 'title: \'single "q" ok\''];
    const BODY_LINES = ['Body', '---', '----', '# H', '- **2024-01-01** | E', '```', '[[x]]', '', '\u0000', '---\r', 'title: in body'];
    let seed = 42;
    const rand = (n: number) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 16) % n; };
    let fast = 0;
    for (let i = 0; i < 10_000; i++) {
      const eol = rand(5) === 0 ? '\r\n' : '\n';
      const fm = Array.from({ length: 1 + rand(5) }, () => FM[rand(FM.length)]!);
      const body = Array.from({ length: 1 + rand(8) }, () => BODY_LINES[rand(BODY_LINES.length)]!);
      const opener = rand(4) ? '---' : ['--- ', '---yaml', '\uFEFF---', '\n---'][rand(4)]!;
      const close = rand(4) ? '---' : ['  ---', '--- ', '---\t', ''][rand(4)]!;
      const content = [opener, ...fm, close, ...body].join(eol) + (rand(4) ? eol : '');
      if (expectSameVerdict(`gen/doc-${i}.md`, content)) fast++;
    }
    expect(fast).toBeGreaterThan(1500);
  });
});

describe('scanBrainSources frontmatterOnly', () => {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-fm-scan-head-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test('the report equals the full-parse report on a checkout holding every case', async () => {
    for (const [rel, content] of CASES) {
      mkdirSync(dirname(join(root, 'cases', rel)), { recursive: true });
      writeFileSync(join(root, 'cases', rel), content);
    }
    const engine = { executeRaw: async () => [{ id: 'fixture', local_path: root }] } as unknown as BrainEngine;
    const strip = ({ scanned_at: _at, ...report }: Awaited<ReturnType<typeof scanBrainSources>>) => report;
    for (const strictMissingOpen of [false, true]) {
      const full = strip(await scanBrainSources(engine, { strictMissingOpen }));
      expect(full.total).toBeGreaterThan(20);
      expect(strip(await scanBrainSources(engine, { strictMissingOpen, frontmatterOnly: true }))).toEqual(full);
    }
  });
});
