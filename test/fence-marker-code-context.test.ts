import { describe, expect, test } from 'bun:test';
import { codeEndAt, indexOfOutsideCode, scanMarkdownCode, unclosedCodeFenceStart } from '../src/core/fence-scan.ts';
import {
  TAKES_FENCE_BEGIN, TAKES_FENCE_END, parseTakesFence, stripTakesFence, upsertTakeRow,
} from '../src/core/takes-fence.ts';
import {
  FACTS_FENCE_BEGIN, FACTS_FENCE_END, parseFactsFence, renderFactsTable, replaceOrInsertFactsFence, stripFactsFence,
} from '../src/core/facts-fence.ts';
import { sanitizeRemoteBody } from '../src/core/remote-body.ts';
import { preserveProtectedTakes } from '../src/core/persistence/protected-takes.ts';
import { prepareCanonicalProjections } from '../src/core/persistence/canonical-projections.ts';
import { withdrawalFenceBlocks } from '../src/core/facts/withdrawal-overlay.ts';
import { splitBody } from '../src/core/markdown.ts';
import type { ParsedPage } from '../src/core/import-file.ts';

const take = (claim: string) => ({ claim, kind: 'take' as const, holder: 'alice-example', weight: 0.5, active: true });
const realTakes = (claim: string) => upsertTakeRow('', take(claim)).body;

/** A doc page that documents the takes fence syntax inside a code block. */
const takesExample = [
  '```markdown',
  TAKES_FENCE_BEGIN,
  '| # | claim | kind | who | weight | since | source |',
  '|---|---|---|---|---|---|---|',
  '| 1 | EXAMPLE-CLAIM | take | alice-example | 0.5 | 2026-01 | docs |',
  TAKES_FENCE_END,
  '```',
].join('\n');

const factsExample = ['```markdown', FACTS_FENCE_BEGIN, '| 1 | EXAMPLE-FACT |', FACTS_FENCE_END, '```'].join('\n');

const worldAndPrivateFacts = renderFactsTable([
  { rowNum: 1, claim: 'WORLD-FACT', kind: 'fact', confidence: 1, visibility: 'world', notability: 'high', active: true },
  { rowNum: 2, claim: 'PRIVATE-FACT', kind: 'fact', confidence: 1, visibility: 'private', notability: 'high', active: true },
]);

/** Every code span, rebuilt by asking codeEndAt at each offset in order. */
function codeSlices(body: string): string[] {
  const map = scanMarkdownCode(body);
  const out: string[] = [];
  for (let i = 0; i < body.length;) {
    const end = codeEndAt(map, i);
    if (end === -1) { i++; continue; }
    out.push(body.slice(i, end));
    i = end;
  }
  return out;
}

const page = (compiled_truth: string): ParsedPage =>
  ({ type: 'concept', title: 't', compiled_truth, timeline: '', frontmatter: {}, tags: [] }) as ParsedPage;

describe('markdown code map', () => {
  test('closed fences and same-line inline spans are code', () => {
    expect(codeSlices('a `x` b\n```\ncode\n```\ntail')).toEqual(['`x`', '```\ncode\n```\n']);
  });

  test('an unclosed fence anywhere means fence pairing cannot be trusted', () => {
    // The stray ~~~ proves some fence line is mispaired, so no block is code.
    expect(codeSlices('a `x` b\n```\ncode\n```\n~~~\nopen to EOF')).toEqual(['`x`']);
  });

  test('a longer outer fence nests an example; a same-length inner opener is a mispairing', () => {
    const nested = '````markdown\n```ts\nx\n```\n````\n';
    expect(codeSlices(`${nested}tail`)).toEqual([nested]);
    // ``` then ```ts: the inner opener cannot close the block, so the first
    // ``` must be a stray that paired with the wrong line.
    expect(codeSlices('```\nstray\n```ts\nx\n```\ntail')).toEqual([]);
  });

  test('double-backtick spans, escaped backticks and CRLF line endings', () => {
    const body = 'p ``a ` b`` q \\`not code` r\r\n```\r\nz\r\n```';
    expect(codeSlices(body)).toEqual(['``a ` b``', '```\r\nz\r\n```']);
  });

  test('bare CR line endings are line breaks too', () => {
    const body = 'a `x`\r```\rz\r```\rtail';
    expect(codeSlices(body)).toEqual(['`x`', '```\rz\r```\r']);
  });

  test('stays linear on long pages with no backticks or line breaks to find', () => {
    // A per-line search that runs to EOF on every line lacking a backtick is
    // quadratic: ~200 ms per MB of plain prose. Linear is ~1 ms.
    const prose = 'Plain prose with no code at all, just words.\n'.repeat(45_000);
    const start = performance.now();
    expect(scanMarkdownCode(prose).fenced).toEqual([]);
    expect(performance.now() - start).toBeLessThan(150);
  });

  test('stays linear with thousands of quoted markers on one long line', () => {
    // Inline spans are computed per marker line on demand; a line's spans must
    // be computed once, not once per marker on it.
    const line = `\`${TAKES_FENCE_BEGIN}\` `.repeat(20_000);
    const start = performance.now();
    expect(indexOfOutsideCode(line, TAKES_FENCE_BEGIN)).toBe(-1);
    expect(performance.now() - start).toBeLessThan(150);
  });

  test('stays linear across many marker lines on a page with no backticks', () => {
    // A facts/takes-heavy page without inline code: judging each marker line
    // must not search the rest of the body for a backtick.
    const body = `${FACTS_FENCE_BEGIN}\n${'x'.repeat(80)}\n`.repeat(20_000);
    const start = performance.now();
    const code = scanMarkdownCode(body);
    let n = 0;
    for (let at = indexOfOutsideCode(body, FACTS_FENCE_BEGIN); at !== -1; at = indexOfOutsideCode(body, FACTS_FENCE_BEGIN, at + 1, code)) n++;
    expect(n).toBe(20_000);
    expect(performance.now() - start).toBeLessThan(150);
  });

  test('stays linear when a lone CR sits far before many marker lines', () => {
    // Finding a marker's line must never search toward the start of the body.
    const body = 'head\r' + `plain line of prose here\n\`${TAKES_FENCE_BEGIN}\`\n`.repeat(20_000);
    const start = performance.now();
    expect(indexOfOutsideCode(body, TAKES_FENCE_BEGIN)).toBe(-1);
    expect(performance.now() - start).toBeLessThan(150);
  });

  test('indexOfOutsideCode skips quoted occurrences and finds the live one', () => {
    const body = `\`${TAKES_FENCE_BEGIN}\`\n${TAKES_FENCE_BEGIN}`;
    expect(indexOfOutsideCode(body, TAKES_FENCE_BEGIN)).toBe(body.lastIndexOf(TAKES_FENCE_BEGIN));
    expect(indexOfOutsideCode('`only quoted`', 'quoted')).toBe(-1);
  });

  test('unclosedCodeFenceStart ignores closed fences', () => {
    expect(unclosedCodeFenceStart('a\n```\nb\n```\nc')).toBe(-1);
    expect(unclosedCodeFenceStart('a\n```\nb\n```\n~~~\nc')).toBe('a\n```\nb\n```\n'.length);
  });
});

describe('takes fence markers quoted in code are documentation', () => {
  test('parse ignores a fenced example and still reads the real fence after it', () => {
    expect(parseTakesFence(`doc\n\n${takesExample}\n`)).toEqual({ takes: [], warnings: [] });
    const body = `doc\n\n${takesExample}\n\n${realTakes('REAL-CLAIM')}`;
    expect(parseTakesFence(body).takes.map(t => t.claim)).toEqual(['REAL-CLAIM']);
  });

  test('an inline-code mention of the marker is neither unbalanced nor a near miss', () => {
    const body = `The marker is \`${TAKES_FENCE_BEGIN}\` on its own line.\n\nTAIL`;
    expect(parseTakesFence(body).warnings).toEqual([]);
    expect(parseTakesFence(`mention \`<!-- gbrain:takes:begin -->\``).warnings).toEqual([]);
  });

  test('upsert leaves the example untouched and adds a real fence', () => {
    const body = `doc\n\n${takesExample}\n`;
    const out = upsertTakeRow(body, take('REAL-CLAIM')).body;
    expect(out.startsWith(body)).toBe(true);
    expect(parseTakesFence(out).takes.map(t => t.claim)).toEqual(['REAL-CLAIM']);
  });

  test('strip hides the example too: the privacy boundary never trusts code blocks', () => {
    const body = `doc\n\n${takesExample}\n\n${realTakes('REAL-CLAIM')}`;
    const out = stripTakesFence(body);
    expect(out).not.toContain('EXAMPLE-CLAIM');
    expect(out).not.toContain('REAL-CLAIM');
  });
});

describe('remote privacy boundary', () => {
  test('an inline-code marker mention no longer truncates the rest of the page', () => {
    const body = `intro\n\nThe marker is \`${TAKES_FENCE_BEGIN}\` on its own line.\n\nIMPORTANT TAIL`;
    expect(sanitizeRemoteBody(body)).toBe(body);
  });

  test('a real fence after a documented example is still stripped', () => {
    const body = `doc\n\n${takesExample}\n\n${realTakes('SECRET-CLAIM')}\n\nafter`;
    const out = sanitizeRemoteBody(body);
    expect(out).not.toContain('EXAMPLE-CLAIM');
    expect(out).not.toContain('SECRET-CLAIM');
    expect(out).toContain('after');
  });

  test('fails closed: a fence after an unclosed code block is still stripped', () => {
    const body = `doc\n\n\`\`\`text\nnever closed\n\n${realTakes('SECRET-CLAIM')}\n`;
    expect(sanitizeRemoteBody(body)).not.toContain('SECRET-CLAIM');
    expect(stripTakesFence(body)).not.toContain('SECRET-CLAIM');
  });

  test('every take the parser sees is hidden from remote readers', () => {
    const bodies = [
      realTakes('P1'),
      `${takesExample}\n\n${realTakes('P2')}`,
      `\`${TAKES_FENCE_BEGIN}\`\n\n${realTakes('P3')}`,
      `\`\`\`\nunclosed\n${realTakes('P4')}`,
    ];
    for (const body of bodies) {
      const claims = parseTakesFence(body).takes.map(t => t.claim);
      expect(claims.length).toBe(1);
      for (const claim of claims) expect(sanitizeRemoteBody(body)).not.toContain(claim);
    }
  });

  test('private facts stay hidden when a facts example precedes the fence', () => {
    const body = `doc\n\n${factsExample}\n\n${worldAndPrivateFacts}\n`;
    const out = sanitizeRemoteBody(body);
    expect(out).not.toContain('EXAMPLE-FACT');
    expect(out).toContain('WORLD-FACT');
    expect(out).not.toContain('PRIVATE-FACT');
  });
});

describe('remote page replacement', () => {
  test('a page that quotes the marker in inline code can be replaced', () => {
    const stored = `The marker is \`${TAKES_FENCE_BEGIN}\`.\n`;
    expect(preserveProtectedTakes(`${stored}edit\n`, stored)).toBe(`${stored}edit\n`);
  });

  test('two live fences in one section are still rejected', () => {
    const twice = `${realTakes('A')}\n\n${realTakes('B')}\n`;
    expect(() => prepareCanonicalProjections(page(twice), 'docs/fences', 'default')).toThrow('at most one');
    const strayEnd = `${realTakes('A')}\n${TAKES_FENCE_END}\n`;
    expect(() => prepareCanonicalProjections(page(strayEnd), 'docs/fences', 'default')).toThrow('at most one');
    const bothFacts = `${worldAndPrivateFacts}\n\n${worldAndPrivateFacts}\n`;
    expect(() => prepareCanonicalProjections(page(bothFacts), 'docs/fences', 'default')).toThrow('at most one');
  });

  test('a documented example plus a real fence passes the canonical projection checks', () => {
    const body = `doc\n\n${takesExample}\n\n${realTakes('REAL-CLAIM')}\n\n${factsExample}\n`;
    expect(() => prepareCanonicalProjections(page(body), 'docs/fences', 'default')).not.toThrow();
  });
});

describe('facts fence', () => {
  test('parse, strip and withdrawal enumeration ignore a fenced example', () => {
    const body = `doc\n\n${factsExample}\n\n${worldAndPrivateFacts}\n`;
    expect(parseFactsFence(body).facts.map(f => f.claim)).toEqual(['WORLD-FACT', 'PRIVATE-FACT']);
    expect(stripFactsFence(body)).not.toContain('EXAMPLE-FACT');
    expect(withdrawalFenceBlocks(body).map(b => b.parsed.facts.length)).toEqual([2]);
  });
});

describe('fence placement above an unclosed code block', () => {
  test('a new takes fence is not written inside an unclosed code block', () => {
    const body = 'doc\n\n```text\nnever closed\n';
    const out = upsertTakeRow(body, take('REAL-CLAIM')).body;
    const fenceAt = out.indexOf(TAKES_FENCE_BEGIN);
    expect(fenceAt).toBeGreaterThan(-1);
    expect(fenceAt).toBeLessThan(out.indexOf('```text'));
    expect(out.endsWith('```text\nnever closed\n')).toBe(true);
    expect(parseTakesFence(out).takes.map(t => t.claim)).toEqual(['REAL-CLAIM']);
  });

  test('a new facts fence is not written inside an unclosed code block', () => {
    const body = 'doc\n\n```text\nnever closed\n';
    const out = replaceOrInsertFactsFence(body, worldAndPrivateFacts);
    expect(out.indexOf(FACTS_FENCE_BEGIN)).toBeLessThan(out.indexOf('```text'));
    expect(out.endsWith('```text\nnever closed\n')).toBe(true);
  });

  test('without an unclosed code block the placement is unchanged', () => {
    expect(upsertTakeRow('doc\n', take('X')).body.startsWith('doc\n\n## Takes\n\n')).toBe(true);
    expect(replaceOrInsertFactsFence('doc\n', worldAndPrivateFacts)).toBe(`doc\n\n## Facts\n\n${worldAndPrivateFacts}\n`);
  });
});

/**
 * A stray ``` pairs with a later block's opener, so a real fence between them
 * reads as the inside of a closed code block. The shapes below are the ways
 * that happens; none may expose a protected row.
 */
const stray = 'doc\n\n```\nnever closed\n\n';
const mispaired = {
  // The later block's closer is left unpaired: an unclosed fence remains.
  shifted: (fence: string) => `${stray}${fence}\n\n\`\`\`\ncode\n\`\`\`\n`,
  // An info string cannot close a block, so everything pairs up and no
  // unclosed fence is left to reveal the mispairing.
  infoString: (fence: string) => `${stray}${fence}\n\n\`\`\`ts\ncode\n\`\`\`\n`,
  // Deliberately wrapped in a balanced code block.
  wrapped: (fence: string) => `doc\n\n\`\`\`\n${fence}\n\`\`\`\n`,
};

describe('mispaired code fences at the privacy boundary', () => {
  for (const [name, shape] of Object.entries(mispaired)) {
    test(`${name}: takes stay hidden from every boundary consumer`, () => {
      const body = shape(realTakes('SECRET-CLAIM'));
      expect(sanitizeRemoteBody(body)).not.toContain('SECRET-CLAIM');
      expect(stripTakesFence(body)).not.toContain('SECRET-CLAIM');
    });

    test(`${name}: private facts stay hidden from every boundary consumer`, () => {
      const body = shape(worldAndPrivateFacts);
      expect(sanitizeRemoteBody(body)).not.toContain('PRIVATE-FACT');
      expect(stripFactsFence(body)).not.toContain('PRIVATE-FACT');
      expect(stripFactsFence(body, { keepVisibility: ['world'] })).not.toContain('PRIVATE-FACT');
    });
  }

  test('readers see a mispaired real fence again', () => {
    for (const shape of [mispaired.shifted, mispaired.infoString]) {
      expect(parseTakesFence(shape(realTakes('REAL-CLAIM'))).takes.map(t => t.claim)).toEqual(['REAL-CLAIM']);
    }
  });

  test('readers treat a deliberately wrapped fence as code', () => {
    expect(parseTakesFence(mispaired.wrapped(realTakes('REAL-CLAIM'))).takes).toEqual([]);
  });

  test('a fence readers see stays hidden up to the end marker readers pair with it', () => {
    // An end marker quoted in a code block inside the fence does not end it
    // for readers, so it must not end the hidden region either.
    const quotedEnd = ['```', TAKES_FENCE_END, '```'].join('\n');
    const body = [
      TAKES_FENCE_BEGIN,
      '| # | claim | kind | who | weight | since | source |',
      '|---|---|---|---|---|---|---|',
      '| 1 | FIRST-SECRET | take | alice-example | 0.5 | 2026-01 | x |',
      quotedEnd,
      '| 2 | SECOND-SECRET | take | alice-example | 0.5 | 2026-01 | x |',
      TAKES_FENCE_END,
      'after',
    ].join('\n');
    const claims = parseTakesFence(body).takes.map(t => t.claim);
    expect(claims).toContain('SECOND-SECRET');
    for (const out of [sanitizeRemoteBody(body), stripTakesFence(body)]) {
      for (const claim of claims) expect(out).not.toContain(claim);
      expect(out).toContain('after');
    }
  });

  test('a remote replacement keeps a mispaired real fence', () => {
    const stored = mispaired.shifted(realTakes('REAL-CLAIM'));
    const incoming = `${sanitizeRemoteBody(stored).trimEnd()}\nedit\n`;
    expect(preserveProtectedTakes(incoming, stored)).toContain('REAL-CLAIM');
  });

  test('a remote replacement of a page whose only fence is a code example is refused', () => {
    // Re-appending the hidden example at EOF would make it a live fence.
    const stored = `doc\n\n${takesExample}\n`;
    const incoming = `${sanitizeRemoteBody(stored).trimEnd()}\nedit\n`;
    expect(() => preserveProtectedTakes(incoming, stored)).toThrow('inside a code block');
  });
});

describe('timeline sentinel quoted in code', () => {
  const SENTINEL = '<!-- timeline -->';
  const entry = '- **2026-01-01** | manual — entry';

  test('a sentinel inside a code block example does not split the page', () => {
    const body = `Intro\n\n\`\`\`markdown\n${SENTINEL}\n\`\`\`\n\nMore prose.\n\n${SENTINEL}\n\n${entry}`;
    expect(splitBody(body)).toEqual({
      compiled_truth: `Intro\n\n\`\`\`markdown\n${SENTINEL}\n\`\`\`\n\nMore prose.\n`,
      timeline: `\n${entry}`,
    });
  });

  test('a legacy --- plus ## Timeline pair inside a code block does not split the page', () => {
    const body = 'Intro\n\n```\n---\n## Timeline\n```\n\nAfter.';
    expect(splitBody(body)).toEqual({ compiled_truth: body, timeline: '' });
  });

  test('the serializer\'s sentinel still splits when a stray fence mispairs the blocks', () => {
    for (const opener of ['```', '```ts']) {
      const body = `Intro\n\n\`\`\`\nstray\n\n${SENTINEL}\n\n${entry}\n\n${opener}\ncode\n\`\`\``;
      expect(splitBody(body).timeline).toContain(entry);
    }
  });

  test('a new facts fence lands above the real sentinel, not above a quoted one', () => {
    const body = `doc\n\n\`\`\`markdown\n${SENTINEL}\n\`\`\`\n\nprose\n\n${SENTINEL}\n\n${entry}\n`;
    const out = replaceOrInsertFactsFence(body, worldAndPrivateFacts);
    expect(out.indexOf(FACTS_FENCE_BEGIN)).toBeGreaterThan(out.indexOf('prose'));
    expect(out.indexOf(FACTS_FENCE_BEGIN)).toBeLessThan(out.lastIndexOf(SENTINEL));
  });
});
