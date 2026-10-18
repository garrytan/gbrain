/**
 * Wave B (spec 3.1): pass 1 of streaming ingest against parseMarkdown.
 *
 * Protects: for generated documents (frontmatter variants, sentinels, quoted
 * sentinels, `---` before a Timeline H2, bare timeline sections, closed,
 * unclosed and mispaired fences, CRLF and lone CR, BOM, NUL, astral text, no
 * frontmatter), the streamed scan's frontmatter, title, type, tags, slug and
 * validation findings equal `parseMarkdown(content)`, the truth and timeline
 * byte ranges read back to exactly its `compiled_truth` and `timeline`, the
 * fence-trust flags equal scanMarkdownCode's trust of each region, and the
 * byte/line counts match. Documents larger than the frontmatter head bound
 * take the bounded-head path and still agree, or are refused only when a
 * frontmatter reader's fence closes beyond the head. Any chunking of the
 * input (1 byte .. 64 KiB) gives the same result as one chunk.
 * Fails when: the line-by-line state machine drifts from splitBody (sentinel
 * fallback, pending `---`, bare-section lookahead), the trim endpoints are
 * off, the head prefix is read differently than the whole file, or a line
 * straddling a chunk boundary is split.
 * Why existing coverage misses it: test/large-pages/split-body-linear.test.ts
 * and test/markdown*.test.ts cover the whole-string parser only.
 * Seams: none; pure functions over bytes.
 */
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { parseMarkdown, type ParseOpts } from '../../src/core/markdown.ts';
import { scanMarkdownCode, stepFenceWalk, type FenceWalk } from '../../src/core/fence-scan.ts';
import { FRONTMATTER_HEAD_MAX_BYTES } from '../../src/core/page-body/limits.ts';
import {
  BodyScanner, firstInvalidUtf8, readBodyPieces, scanMarkdownBody, scanMarkdownString, type BodyScanResult,
} from '../../src/core/page-body/body-scan.ts';

const BODY_LINES = [
  '', ' ', '\t', '\u00a0', 'prose line', 'Re: alpha: beta', '😀 astral 𝄞', 'a\rb', 'nul\u0000here', '\uFEFFbom',
  '# Heading One', '#  Spaced #', '## Section', '### Deep', '## Timeline', '## History', '## timeline notes',
  '- 2024-05-01: dated', '* **2020** bold year', '  wrapped continuation', '- not dated',
  '---', '  ---', '--- ', '---\r', '<!-- timeline -->', '<!--timeline-->', '--- timeline ---', '---  Timeline  ---',
  '```', '```ts', '````', '~~~', '   ```', '    ```', '```inline`code', '~~~~ ', '  ```  ',
  'title: embedded', 'title: "quoted title"', 'key: value',
];
const OPENERS = ['---', '---\r', '---yaml', '--- ', '\n---', '\uFEFF---', '  ---', '----', '---json'];
const BLOCK_LINES = ['title: Alpha Example', 'title: Re: colon: title', 'type: person', 'tags: [b, a]', 'tags: x, y',
  'slug: notes/other', 'date: 2024-06-01', 'captured_at: 2026-01-01', 'bad: [unclosed', 'n: 123', '# comment', 'title: "a "b" c"', ''];
const CLOSERS = ['---', '---  ', '---\r', '...', ''];
const SEPARATORS = ['\n', '\r\n'];

const docArb = fc.record({
  frontmatter: fc.option(fc.record({
    opener: fc.constantFrom(...OPENERS),
    block: fc.array(fc.constantFrom(...BLOCK_LINES), { maxLength: 4 }),
    closer: fc.constantFrom(...CLOSERS),
  }), { nil: undefined }),
  body: fc.array(fc.constantFrom(...BODY_LINES), { maxLength: 18 }),
  sep: fc.constantFrom(...SEPARATORS),
  trailing: fc.boolean(),
});

type Doc = typeof docArb extends fc.Arbitrary<infer T> ? T : never;

function render(doc: Doc, filler = ''): string {
  const lines: string[] = [];
  if (doc.frontmatter) lines.push(doc.frontmatter.opener, ...doc.frontmatter.block, doc.frontmatter.closer);
  return lines.join(doc.sep) + (lines.length ? doc.sep : '') + filler + doc.body.join(doc.sep) + (doc.trailing ? doc.sep : '');
}

/** scanMarkdownCode's trust of `text`: no unclosed fence, no mispairing (same walk, CR is a line end). */
function oracleTrust(text: string): 'trusted' | 'void' {
  const walk: FenceWalk = { opener: null, mispaired: false };
  for (const line of text.split(/\r\n|\r|\n/)) stepFenceWalk(walk, line);
  const trust = walk.opener || walk.mispaired ? 'void' : 'trusted';
  const code = scanMarkdownCode(text);
  if (trust === 'trusted') expect(code.unclosedAt).toBe(-1);
  else if (code.unclosedAt === -1) expect(code.fenced).toEqual([]);
  return trust;
}

function capture<T>(fn: () => T): T | { thrown: string } {
  try { return fn(); } catch (e) { return { thrown: String(e) }; }
}

function expectAgrees(content: string, filePath: string, opts: ParseOpts, lineBufferBytes?: number): void {
  const expected = capture(() => parseMarkdown(content, filePath, opts));
  const got = capture(() => scanMarkdownString(content, filePath, opts, lineBufferBytes));
  if ('thrown' in expected) {
    expect(got).toEqual(expected);
    return;
  }
  if ('thrown' in got || got.kind !== 'ok') throw new Error(`scan refused ${JSON.stringify(content.slice(0, 200))}: ${JSON.stringify(got)}`);
  const { compiled_truth, timeline, ...fields } = expected;
  expect(got.text.compiled_truth).toBe(compiled_truth);
  expect(got.text.timeline).toBe(timeline);
  expect(got.parsed).toEqual(fields);
  expect(Object.keys(got.parsed)).toEqual(Object.keys(fields));
  expect(got.truthBytes).toBe(Buffer.byteLength(compiled_truth));
  expect(got.timelineBytes).toBe(Buffer.byteLength(timeline));
  const stream = compiled_truth + timeline;
  expect(got.bodyLines).toBe(stream ? stream.split('\n').length : 0);
  expect(got.totalBytes).toBe(Buffer.byteLength(content));
  expect(got.bodyFlags.fence_trust).toBe(oracleTrust(compiled_truth));
  expect(got.bodyFlags.timeline_fence_trust).toBe(oracleTrust(timeline));
  expect(got.bodyFlags.has_nul).toBe(stream.includes('\u0000'));
  if (timeline === '') expect(got.timeline).toEqual([]);
}

const PATHS = ['notes/alpha-example.md', 'people/acme-example.md', 'wiki/analysis/x.md'];

describe('body scan vs parseMarkdown (whole file within the head bound)', () => {
  test('generated documents', () => {
    fc.assert(fc.property(docArb, fc.constantFrom(...PATHS), fc.boolean(), (doc, path, validate) => {
      expectAgrees(render(doc), path, { validate });
    }), { numRuns: 3000 });
  }, 60_000);

  test('named shapes', () => {
    const shapes = [
      '', '\n', '   \n\t\n', 'plain', '# Only Title\n',
      'intro\n\n---\n\n## Timeline\n- 2024-01-01: a\n',
      'intro\n```\n<!-- timeline -->\n```\n<!-- timeline -->\nafter\n',
      'intro\n```\n<!-- timeline -->\n````\nrest\n',
      'intro\n```\n<!-- timeline -->\n',
      'intro\n## Timeline\n- 2024-01-01: x\n  more\n\n## Next\nkept\n',
      'intro\n## History\nprose disqualifies\n## Timeline\n- 2020: ok\n',
      '## Timeline\n- 2024: heading first\n',
      '---\ntitle: T\n---\n\n---\ntitle: inner\n---\nbody\n',
      '\n---\ntitle: Lifted\n---\nbody\n',
      '---\n---\nRe: a: b\n---\n',
      '---\ntitle: x\n---  \nNote: one: two\n---\nend\n',
      '---\r\ntitle: CRLF\r\n---\r\nbody\r\n<!-- timeline -->\r\n- 2024: t\r\n',
      '---\ntitle: x\r---\nbody\n',
      'a\r```\rb\n',
      '    ```\nindented four is not a fence for the trust walk\n',
    ];
    for (const content of shapes) for (const validate of [false, true]) expectAgrees(content, 'notes/x.md', { validate });
  });

  test('a language selector throws exactly as parseMarkdown does', () => {
    const content = '---toml\ntitle = "x"\n---\nbody\n';
    expect(() => scanMarkdownString(content)).toThrow('Unsupported frontmatter language');
    expectAgrees(content, 'notes/x.md', { validate: true });
  });
});

describe('body scan on files larger than the head bound', () => {
  const fillerLines = fc.array(fc.constantFrom(...BODY_LINES.filter(l => !l.startsWith('---') && !l.startsWith('<!--'))), { minLength: 1, maxLength: 12 });

  function big(doc: Doc, filler: string[]): string {
    const block = filler.join(doc.sep) + doc.sep;
    const reps = Math.ceil((FRONTMATTER_HEAD_MAX_BYTES + 4096) / Buffer.byteLength(block));
    return render(doc, block.repeat(reps));
  }

  test('generated documents agree or are refused only for a fence beyond the head', () => {
    let refused = 0;
    fc.assert(fc.property(docArb, fillerLines, fc.boolean(), (doc, filler, validate) => {
      const content = big(doc, filler);
      const got = capture(() => scanMarkdownString(content, 'notes/x.md', { validate }));
      if (!('thrown' in got) && got.kind === 'frontmatter_head_unbounded') {
        refused++;
        const head = new TextDecoder().decode(Buffer.from(content, 'utf8').subarray(0, FRONTMATTER_HEAD_MAX_BYTES), { stream: true });
        expect(!/\S/.test(head) || /^\s*-/.test(head)).toBe(true);
        return;
      }
      expectAgrees(content, 'notes/x.md', { validate });
    }), { numRuns: 80 });
    expect(refused).toBeLessThan(80);
  }, 120_000);

  const pad = (line: string) => `${line}\n`.repeat(Math.ceil((FRONTMATTER_HEAD_MAX_BYTES + 1000) / (line.length + 1)));

  test('frontmatter that never closes inside the head is refused (data fence)', () => {
    const content = `---\ntitle: x\n${pad('key: value')}---\nbody\n`;
    const got = scanMarkdownString(content);
    expect(got.kind).toBe('frontmatter_head_unbounded');
    if (got.kind === 'frontmatter_head_unbounded') expect(got.reader).toBe('data_fence');
  });

  test('a pre-quote fence closing beyond the head: refused when it rewrites a line, exact when it rewrites none', () => {
    const rewrites = `---\ntitle: x\n---  \n${pad('prose')}Note: one: two\n---\nend\n`;
    const got = scanMarkdownString(rewrites);
    expect(got.kind === 'frontmatter_head_unbounded' && got.reader).toBe('quote_fence');
    const blockRewrite = `---\ntitle: Re: a: b\n---  \n${pad('prose')}---\nend\n`;
    expect(scanMarkdownString(blockRewrite).kind).toBe('frontmatter_head_unbounded');
    expectAgrees(`---\ntitle: x\n---  \n${pad('prose')}---\nend\n`, 'notes/x.md', { validate: true });
    expectAgrees(`---\ntitle: x\n---  \n${pad('Note: one: two')}end\n`, 'notes/x.md', { validate: true });
    // The pass rebuilds the line before its closing `---` without the CR, so a CRLF body line changes too.
    const crlf = `---\r\n---\r\n${pad('## notes\r')}---`;
    expect(scanMarkdownString(crlf).kind).toBe('frontmatter_head_unbounded');
  });

  test('the validator fence must close in the head only under validate', () => {
    const content = `---\ntitle: x\r---\n${pad('body')}`;
    const got = scanMarkdownString(content, 'notes/x.md', { validate: true });
    expect(got.kind === 'frontmatter_head_unbounded' && got.reader).toBe('validator_fence');
    expectAgrees(content, 'notes/x.md', {});
  });

  test('a first line starting with "-" that does not end in the head is refused; other long lines are not', () => {
    const dashes = `- ${'x'.repeat(FRONTMATTER_HEAD_MAX_BYTES + 10)}\nrest\n`;
    expect(scanMarkdownString(dashes).kind).toBe('frontmatter_head_unbounded');
    expectAgrees(`${'y'.repeat(FRONTMATTER_HEAD_MAX_BYTES + 10)}\n<!-- timeline -->\nt\n`, 'notes/x.md', { validate: true });
    expectAgrees(`\uFEFF${'😀'.repeat(FRONTMATTER_HEAD_MAX_BYTES / 4 + 3)}`, 'notes/x.md', { validate: true });
  });

  test('a NUL after the head is reported on the line parseMarkdown reports', () => {
    expectAgrees(`---\ntitle: x\n---\n${pad('body')}late\u0000nul\n`, 'notes/x.md', { validate: true });
    expectAgrees(`plain\n${pad('body')}late\u0000nul\n`, 'notes/x.md', { validate: true });
  });

  test('a body rewritten by the pre-quote pass inside the head comes back as a text piece', () => {
    const content = `---\ntitle: x\n---  \nNote: one: two\n---\n${pad('prose')}<!-- timeline -->\n- 2024: t\n`;
    expectAgrees(content, 'notes/x.md', { validate: true });
    const got = scanMarkdownString(content);
    expect(got.kind === 'ok' && got.truth.some(piece => 'text' in piece)).toBe(true);
  });
});

describe('chunking', () => {
  function scanChunks(bytes: Uint8Array, sizes: number[]): BodyScanResult {
    const scanner = new BodyScanner('notes/x.md', { validate: true });
    let at = 0;
    for (let k = 0; at < bytes.length; k++) {
      const size = sizes[k % sizes.length]!;
      scanner.push(bytes.subarray(at, at + size));
      at += size;
    }
    return scanner.finish();
  }

  test('any chunking (1 byte .. 64 KiB) gives the single-chunk result', () => {
    fc.assert(fc.property(docArb, fc.array(fc.integer({ min: 1, max: 64 * 1024 }), { minLength: 1, maxLength: 5 }), fc.boolean(), (doc, sizes, large) => {
      const content = large ? render(doc, 'filler line\n'.repeat(Math.ceil(FRONTMATTER_HEAD_MAX_BYTES / 12) + 50)) : render(doc);
      const bytes = Buffer.from(content, 'utf8');
      const whole = capture(() => scanChunks(bytes, [bytes.length || 1]));
      const small = sizes.map(s => (large ? s : Math.max(1, s % 17)));
      expect(capture(() => scanChunks(bytes, small))).toEqual(whole);
    }), { numRuns: 200 });
  }, 120_000);

  test('the async form equals the push form, and pieces read back from the file', async () => {
    const content = `---\ntitle: Alpha Example\n---\nintro 😀\n${'line\n'.repeat(70_000)}<!-- timeline -->\n- 2024: t\n`;
    const bytes = Buffer.from(content, 'utf8');
    async function* chunks() { for (let at = 0; at < bytes.length; at += 4093) yield bytes.subarray(at, at + 4093); }
    const streamed = await scanMarkdownBody(chunks(), 'notes/x.md');
    const whole = scanMarkdownString(content, 'notes/x.md');
    if (streamed.kind !== 'ok' || whole.kind !== 'ok') throw new Error('refused');
    const { text, ...rest } = whole;
    expect(streamed).toEqual(rest);
    expect(readBodyPieces(streamed.truth, bytes)).toBe(text.compiled_truth);
  });
});

describe('invalid UTF-8', () => {
  test('names the offset of the first invalid byte, in the head and after it', () => {
    for (const at of [0, 5, FRONTMATTER_HEAD_MAX_BYTES - 1, FRONTMATTER_HEAD_MAX_BYTES + 7]) {
      const bytes = Buffer.from('a'.repeat(FRONTMATTER_HEAD_MAX_BYTES + 100) + '\n');
      bytes[at] = 0xff;
      const scanner = new BodyScanner();
      scanner.push(bytes);
      expect(scanner.finish()).toEqual({ kind: 'invalid_utf8', offset: at });
    }
    const truncated = Buffer.concat([Buffer.from('ok\n'), Buffer.from([0xf0, 0x9f, 0x98])]);
    const scanner = new BodyScanner();
    scanner.push(truncated);
    expect(scanner.finish()).toEqual({ kind: 'invalid_utf8', offset: 3 });
  });

  test('firstInvalidUtf8 agrees with a fatal TextDecoder', () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 12 }), (bytes) => {
      let valid = true;
      try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { valid = false; }
      expect(firstInvalidUtf8(bytes) === -1).toBe(valid);
    }), { numRuns: 5000 });
  });
});

describe('lines longer than the line buffer', () => {
  const ws = fc.array(fc.constantFrom(' ', ' ', '\t', '\u00a0', '\u2028', '\u3000', '\r'), { maxLength: 12 }).map(a => a.join(''));
  const spaces = fc.array(fc.constantFrom(' ', '\t'), { maxLength: 9 }).map(a => a.join(''));
  const run = (char: string) => fc.integer({ min: 1, max: 10 }).map(n => char.repeat(n));
  const word = fc.constantFrom('timeline', 'Timeline', 'HISTORY', 'history', 'notes', 'x', '😀', 'Re: a: b', 'a:', '2024', 'nul\u0000', '');
  const longTail = fc.constantFrom('', '', 'y'.repeat(300), ' '.repeat(300), `${'z '.repeat(150)}`, '😀'.repeat(140), '`x`');
  const template = fc.oneof(
    fc.tuple(ws, run('`'), ws, word, ws).map(p => p.join('')),
    fc.tuple(spaces, run('~'), spaces, longTail).map(p => p.join('')),
    fc.tuple(ws, fc.constant('---'), ws, word, ws, fc.constantFrom('---', '--', '')).map(p => p.join('')),
    fc.tuple(ws, fc.constantFrom('<!--', '<!-- '), ws, word, ws, fc.constant('-->')).map(p => p.join('')),
    fc.tuple(ws, fc.constantFrom('##', '#', '###'), ws, word, ws, longTail, ws).map(p => p.join('')),
    fc.tuple(ws, fc.constantFrom('-', '*', '+'), ws, run('*'), fc.constantFrom('2024', '20245', '2024-05-01: x', 'abcd'), longTail).map(p => p.join('')),
    fc.tuple(fc.constantFrom('title:', 'key:', 'Note:', '_k1:', '1k:'), spaces, fc.constantFrom('', '"q"', 'a: b', 'end:', 'plain', '|x'), longTail, ws).map(p => p.join('')),
    fc.tuple(fc.constantFrom('# ', '#\t', '#\r ', '#'), longTail, word, ws, fc.constantFrom('', ' ##', '\rmore'), ws).map(p => p.join('')),
    fc.tuple(ws, longTail, ws).map(p => p.join('')),
  );
  const longLine = fc.array(template, { minLength: 1, maxLength: 3 }).map(parts => parts.join('\r'));
  const longDoc = fc.record({
    frontmatter: fc.option(fc.record({
      opener: fc.constantFrom(...OPENERS),
      block: fc.array(fc.constantFrom(...BLOCK_LINES), { maxLength: 3 }),
      closer: fc.constantFrom(...CLOSERS),
    }), { nil: undefined }),
    body: fc.array(fc.oneof(fc.constantFrom(...BODY_LINES), longLine), { maxLength: 14 }),
    sep: fc.constantFrom(...SEPARATORS),
    trailing: fc.boolean(),
  });

  const join = (parts: string[]) => parts.join('');
  const embeddedDoc = fc.record({
    lead: fc.constantFrom('---\ntype: note\n---\n', '---\ntype: note\n---\n\n  \n'),
    opener: fc.tuple(fc.constant('---'), ws).map(join),
    lines: fc.array(fc.oneof(
      fc.tuple(fc.constantFrom('title:', 'title: ', 'title:\t', ' title: '), spaces, fc.constantFrom('Alpha', '"Q"', "'s'", 'a\rb', 'x\u2028y', 'v\r', ''), longTail, ws).map(join),
      fc.constantFrom('type: x', '', '---', '--- \t'),
    ), { maxLength: 3 }),
    closer: fc.tuple(fc.constant('---'), ws).map(join),
    tail: fc.constantFrom('body', '# H1 wins', ''),
    sep: fc.constantFrom(...SEPARATORS),
  }).map(d => d.lead + [d.opener, ...d.lines, d.closer, d.tail].join(d.sep));
  const bareDoc = fc.record({
    heading: fc.tuple(ws, fc.constantFrom('##'), ws, fc.constantFrom('Timeline', 'history', 'Timeline notes'), ws).map(join),
    lines: fc.array(fc.oneof(
      fc.tuple(ws, fc.constantFrom('-', '*', '+', '**', '*-', 'x'), ws, run('*'), fc.constantFrom('2024', '20245', '2024: x', 'abcd'), longTail).map(join),
      fc.tuple(ws, fc.constantFrom('cont', '`x`', '')).map(join),
    ), { maxLength: 5 }),
    next: fc.constantFrom('', '## Next\nkept', '##  \u00a0Next'),
    sep: fc.constantFrom(...SEPARATORS),
  }).map(d => ['intro', d.heading, ...d.lines, d.next].join(d.sep));
  const fenceLine = fc.tuple(fc.constantFrom('', ' ', '   ', '    ', '\t', '\u00a0'), fc.integer({ min: 2, max: 9 }), fc.constantFrom('`', '~'),
    fc.constantFrom('', ' ', ' \u00a0', '\u2028', ' \u2028x', 'ts', '`', ' \t', '\u3000', 'info ~'), ws)
    .map(([lead, n, c, tail, end]) => lead + c.repeat(n) + tail + end);
  const fenceDoc = fc.record({
    lines: fc.array(fc.oneof(fenceLine, fenceLine, fc.constantFrom('code', '', '<!-- timeline -->', '## Timeline', '- 2024: x', '---'),
      fc.array(fenceLine, { minLength: 2, maxLength: 3 }).map(l => l.join('\r'))), { maxLength: 10 }),
    sep: fc.constantFrom(...SEPARATORS),
    lead: fc.constantFrom('intro', ' \u00a0\n', ''),
  }).map(d => [d.lead, ...d.lines].join(d.sep));

  test('embedded fences, bare sections and fence lines agree on both paths', () => {
    fc.assert(fc.property(fc.oneof(embeddedDoc, bareDoc, fenceDoc), fc.constantFrom(1, 2, 5, 11, 40, undefined), fc.boolean(), (content, buffer, validate) => {
      expectAgrees(content, 'notes/x.md', { validate }, buffer);
    }), { numRuns: 4000 });
  }, 120_000);

  test('generated documents agree when every line takes the long-line path', () => {
    fc.assert(fc.property(docArb, fc.integer({ min: 1, max: 24 }), fc.boolean(), (doc, buffer, validate) => {
      expectAgrees(render(doc), 'notes/x.md', { validate }, buffer);
    }), { numRuns: 2000 });
  }, 120_000);

  test('long runs, CR sub-lines and astral text split at the buffer edge agree', () => {
    fc.assert(fc.property(longDoc, fc.integer({ min: 1, max: 40 }), fc.boolean(), fc.constantFrom(...PATHS), (doc, buffer, validate, path) => {
      expectAgrees(render(doc), path, { validate }, buffer);
    }), { numRuns: 3000 });
  }, 120_000);

  test('bounded-head documents agree through the long-line path, including the pre-quote watch', () => {
    const pad = (line: string) => `${line}\n`.repeat(Math.ceil((FRONTMATTER_HEAD_MAX_BYTES + 1000) / (line.length + 1)));
    const shapes = [
      `---\ntitle: x\n---  \n${pad('prose')}---\nend\n`,
      `---\ntitle: x\n---  \n${pad('prose')}Note: ${'z'.repeat(300)} end\n---\nend\n`,
      `---\ntitle: x\n---  \n${pad('Note: one two')}end\n`,
      `---\ntitle: x\n---\n${pad('body')}late\u0000nul ${'w'.repeat(500)}\n`,
      `---\ntitle: x\n---  \n${pad('prose')}Note: a: b\rmore ${'m'.repeat(300)}\nplain\n---\nend\n`,
      `---\ntitle: x\n---  \n${pad('prose')}Note: a: b\u2028more\nplain\n---\nend\n`,
      `---\ntitle: x\n---  \n${pad('prose')}Note: "a: b"\nplain\n---\nend\n`,
    ];
    for (const content of shapes) for (const buffer of [1, 7, 64]) expectAgrees(content, 'notes/x.md', { validate: true }, buffer);
    for (const value of [`one: ${'z'.repeat(300)}`, `${'z'.repeat(300)}:`, `${'k'.repeat(300)}: a: b`]) {
      for (const buffer of [1, 7, 64]) {
        const got = scanMarkdownString(`---\ntitle: x\n---  \n${pad('prose')}Note: ${value}\n---\nend\n`, 'notes/x.md', {}, buffer);
        expect(got.kind === 'frontmatter_head_unbounded' && got.reader).toBe('quote_fence');
      }
    }
  });

  test('embedded fence lines whose whitespace run hides a non-[ \t] unit in its middle', () => {
    const shapes = [
      '---\ntype: note\n---\n---  \u00a0  \ntitle: Alpha\n---\nbody\n',
      '---\ntype: note\n---\n---\ntitle: Alpha\n---  \u00a0  \nbody\n',
      '---\ntype: note\n---\n---  \r  \ntitle: Alpha\n---\nbody\n',
      '---\ntype: note\n---\n---\ntitle: Alpha\n--- \t\u3000\t\t \nbody\n',
      '---\ntype: note\n---\n--- \t \t \t\r\ntitle: Alpha\r\n---\t \t \t \r\nbody\r\n',
    ];
    for (const content of shapes) for (const buffer of [1, 3, 8, undefined]) expectAgrees(content, 'notes/x.md', { validate: true }, buffer);
  });

  test('lines longer than the real 64 KiB buffer', () => {
    const big = 70_000;
    const shapes = [
      `# ${'t'.repeat(big)} ##\nbody\n`,
      `intro\n# Long ${'t '.repeat(big)}\t\nbody\n`,
      `# Title\r${'more\r'.repeat(big / 5)}\n# Second\n`,
      `---\ntype: note\n---\n---\ntitle: ${'v'.repeat(big)}\n---\nbody\n`,
      `intro\n---${' '.repeat(big)}timeline${'\t'.repeat(big)}---\n- 2024: t\n`,
      `intro\n${' '.repeat(big)}<!-- timeline -->${' '.repeat(big)}\nt\n`,
      `intro\n---\n${'\u3000'.repeat(big)}## Timeline${' '.repeat(big)}\n- 2024: t\n`,
      `intro\n${'`'.repeat(big)}\ncode\n${'`'.repeat(big + 1)}\n<!-- timeline -->\nt\n`,
      `intro\n${'`'.repeat(big)}\ncode\n${'`'.repeat(big - 1)}\n<!-- timeline -->\nt\n`,
      `intro\n${'~'.repeat(big)} info ${'i'.repeat(big)}\ncode\n${'~'.repeat(big)}${' \t'.repeat(big)}\nafter\n`,
      `intro\n\`\`\`ts${' x'.repeat(big)}\u2028\n<!-- timeline -->\n\`\`\`\nt\n`,
      `${'a\r```\rcode\r```\r'.repeat(big / 10)}\n<!-- timeline -->\nt\r\`\`\`\r`,
      `intro\n## Timeline\n- ${'*'.repeat(big)}2024 dated\n  ${'w'.repeat(big)}\n## Next\nkept\n`,
      `intro\n## Timeline\n- ${'*'.repeat(big)}20245 not dated\n## Next\nkept\n`,
      `plain\n${' \u00a0\u2028'.repeat(big)}\n${'😀'.repeat(big)}\n`,
      `plain\n${'x'.repeat(big)}\u0000${'y'.repeat(big)}\n`,
      `${'\r\n'.repeat(10)}${'q'.repeat(big)}\r\n<!-- timeline -->\r\n- 2024: t\r\n`,
    ];
    for (const content of shapes) for (const validate of [false, true]) expectAgrees(content, 'notes/alpha-example.md', { validate });
  });

  test('invalid UTF-8 inside a long line names its offset', () => {
    for (const at of [3, 65_535, 65_536, 65_537, 150_001]) {
      const bytes = Buffer.from(`plain\n${'a'.repeat(200_000)}\nend\n`);
      bytes[at + 6] = 0xff;
      for (const buffer of [undefined, 5]) {
        const scanner = new BodyScanner('notes/x.md', {}, buffer);
        for (let k = 0; k < bytes.length; k += 4093) scanner.push(bytes.subarray(k, k + 4093));
        expect(scanner.finish()).toEqual({ kind: 'invalid_utf8', offset: at + 6 });
      }
    }
    const cut = Buffer.concat([Buffer.from(`ok\n${'a'.repeat(100)}`), Buffer.from([0xf0, 0x9f, 0x98])]);
    const scanner = new BodyScanner(undefined, undefined, 8);
    scanner.push(cut);
    expect(scanner.finish()).toEqual({ kind: 'invalid_utf8', offset: cut.length - 3 });
  });

  test('any chunking gives the single-chunk result on the long-line path', () => {
    fc.assert(fc.property(longDoc, fc.integer({ min: 1, max: 40 }), fc.array(fc.integer({ min: 1, max: 97 }), { minLength: 1, maxLength: 4 }), (doc, buffer, sizes) => {
      const bytes = Buffer.from(render(doc), 'utf8');
      const scan = (chunks: number[]) => capture(() => {
        const scanner = new BodyScanner('notes/x.md', { validate: true }, buffer);
        for (let at = 0, k = 0; at < bytes.length; k++) {
          const size = chunks[k % chunks.length]!;
          scanner.push(bytes.subarray(at, at + size));
          at += size;
        }
        return scanner.finish();
      });
      expect(scan(sizes)).toEqual(scan([bytes.length || 1]));
    }), { numRuns: 500 });
  }, 120_000);
});
