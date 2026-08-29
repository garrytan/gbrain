/**
 * v0.20.0 Cathedral II Layer 8 D2 — markdown fence extraction tests.
 *
 * Validates that importing markdown with fenced code blocks produces
 * extra chunks with chunk_source='fenced_code', correct language
 * metadata, and respect for the fence-bomb DOS cap.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { scanFencedBlocks } from '../src/core/fence-scan.ts';

describe('Layer 8 D2 — markdown fence extraction', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  }, 30_000);

  test('TypeScript fence becomes a fenced_code chunk with language=typescript', async () => {
    const md = `# Guide

Some intro prose about the chunker.

\`\`\`ts
export function hello(name: string): string {
  return \`Hello, \${name}\`;
}
\`\`\`

More prose.`;

    await importFromContent(engine, 'guides/fence-ts', md, { noEmbed: true });
    const chunks = await engine.getChunks('guides/fence-ts');
    const fenceChunks = chunks.filter(c => c.chunk_source === 'fenced_code');
    expect(fenceChunks.length).toBeGreaterThan(0);
    expect(fenceChunks[0]!.language).toBe('typescript');
  });

  test('Python fence → language=python, chunk_text contains the def', async () => {
    const md = `Docs.

\`\`\`python
def greet(name):
    return f"hi, {name}"
\`\`\`
`;
    await importFromContent(engine, 'guides/fence-py', md, { noEmbed: true });
    const chunks = await engine.getChunks('guides/fence-py');
    const fenceChunks = chunks.filter(c => c.chunk_source === 'fenced_code');
    expect(fenceChunks.length).toBeGreaterThan(0);
    expect(fenceChunks[0]!.language).toBe('python');
    expect(fenceChunks[0]!.chunk_text).toMatch(/def greet/);
  });

  test('Ruby fence → language=ruby', async () => {
    const md = `\`\`\`ruby
class Foo
  def bar; 42; end
end
\`\`\``;
    await importFromContent(engine, 'guides/fence-rb', md, { noEmbed: true });
    const chunks = await engine.getChunks('guides/fence-rb');
    const fenceChunks = chunks.filter(c => c.chunk_source === 'fenced_code');
    expect(fenceChunks.length).toBeGreaterThan(0);
    expect(fenceChunks[0]!.language).toBe('ruby');
  });

  test('unknown fence tag produces zero fenced_code chunks (graceful fallback)', async () => {
    const md = `Intro.

\`\`\`mermaid
graph TD
  A --> B
\`\`\`

\`\`\`unknown-lang-xyz
do stuff
\`\`\``;
    await importFromContent(engine, 'guides/fence-unknown', md, { noEmbed: true });
    const chunks = await engine.getChunks('guides/fence-unknown');
    const fenceChunks = chunks.filter(c => c.chunk_source === 'fenced_code');
    // No extraction — no chunks with fenced_code source. Prose still chunks normally.
    expect(fenceChunks.length).toBe(0);
  });

  test('missing fence language tag → no fenced_code chunks', async () => {
    const md = `Intro.

\`\`\`
some ambiguous code
\`\`\``;
    await importFromContent(engine, 'guides/fence-no-tag', md, { noEmbed: true });
    const chunks = await engine.getChunks('guides/fence-no-tag');
    const fenceChunks = chunks.filter(c => c.chunk_source === 'fenced_code');
    expect(fenceChunks.length).toBe(0);
  });

  test('multiple fences on one page all extract (under cap)', async () => {
    const md = `
\`\`\`ts
const a = 1;
\`\`\`

prose

\`\`\`python
x = 2
\`\`\`

\`\`\`bash
echo hi
\`\`\`
`;
    await importFromContent(engine, 'guides/fence-multi', md, { noEmbed: true });
    const chunks = await engine.getChunks('guides/fence-multi');
    const fenceChunks = chunks.filter(c => c.chunk_source === 'fenced_code');
    // Three fences, each produces at least one chunk. Languages vary.
    expect(fenceChunks.length).toBeGreaterThanOrEqual(3);
    const langs = new Set(fenceChunks.map(c => c.language));
    expect(langs.has('typescript')).toBe(true);
    expect(langs.has('python')).toBe(true);
    expect(langs.has('bash')).toBe(true);
  });

  test('empty fence body is skipped (no chunks)', async () => {
    const md = "Intro.\n\n```ts\n```\n";
    await importFromContent(engine, 'guides/fence-empty', md, { noEmbed: true });
    const chunks = await engine.getChunks('guides/fence-empty');
    const fenceChunks = chunks.filter(c => c.chunk_source === 'fenced_code');
    expect(fenceChunks.length).toBe(0);
  });

  // #2437 — extractFencedChunks skips marked.lexer entirely when the body has
  // no fence marker (the lexer transiently allocates ~60x the page size, which
  // OOMs the import worker under memory pressure). These two guard that the
  // fast-path neither breaks tilde fences nor lexes fence-less pages.
  test('tilde-fenced (~~~) code is still extracted after the no-fence fast-path (#2437)', async () => {
    const md = 'Docs.\n\n~~~ts\nexport const x = 1;\n~~~\n';
    await importFromContent(engine, 'guides/fence-tilde', md, { noEmbed: true });
    const chunks = await engine.getChunks('guides/fence-tilde');
    const fenceChunks = chunks.filter(c => c.chunk_source === 'fenced_code');
    expect(fenceChunks.length).toBeGreaterThan(0);
    expect(fenceChunks[0]!.language).toBe('typescript');
  });

  test('CR-only (\\r) line endings still extract a fenced chunk (#2437)', async () => {
    // marked normalizes \r → \n before lexing, so the fast-path's fence probe
    // must too; otherwise a classic-Mac line-ended page loses its fenced code.
    const md = 'intro\r```ts\rexport const x = 1;\r```\r';
    await importFromContent(engine, 'guides/fence-cr', md, { noEmbed: true });
    const chunks = await engine.getChunks('guides/fence-cr');
    const fenceChunks = chunks.filter(c => c.chunk_source === 'fenced_code');
    expect(fenceChunks.length).toBeGreaterThan(0);
    expect(fenceChunks[0]!.language).toBe('typescript');
  });

  // #2862 — a SINGLE fence marker used to route the whole body through
  // marked.lexer, which is quadratic on autolink-dense text under bun
  // (~50s for a 418KB body; OOM class on bigger ones). The linear line
  // scanner makes fence extraction O(lines) regardless of inline content.
  test('400KB autolink-dense body with one fence imports and still extracts it (#2862)', async () => {
    // ~420KB total — matches the issue's 418KB body and stays UNDER the
    // content-sanity bytes_block (500KB), which would otherwise embed-skip
    // the page and bypass fence extraction entirely.
    const line = '<https://example.com/very/long/path/segment?ticket=12345&session=abcdef>\n';
    const half = line.repeat(Math.ceil(210_000 / line.length));
    const md = '# Autolink flood\n\n' + half + '\n```ts\nexport const marker = 2862;\n```\n' + half;
    // The scanner itself must be linear-fast regardless of inline autolink
    // density: pre-fix, marked.lexer spent ~50s on this exact shape. 2s is
    // ~1000x headroom for a pure O(lines) pass even on a heavily loaded box
    // (an end-to-end import timing assertion proved too load-sensitive:
    // chunking + PGLite inserts dominate and vary wildly under parallel CI).
    const t0 = Date.now();
    const { fences } = scanFencedBlocks(md);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(fences.length).toBe(1);
    // End-to-end: the fence still lands as a fenced_code chunk.
    await importFromContent(engine, 'guides/fence-autolink-flood', md, { noEmbed: true });
    const chunks = await engine.getChunks('guides/fence-autolink-flood');
    const fenceChunks = chunks.filter(c => c.chunk_source === 'fenced_code');
    expect(fenceChunks.length).toBeGreaterThan(0);
    expect(fenceChunks[0]!.language).toBe('typescript');
    expect(fenceChunks[0]!.chunk_text).toContain('marker = 2862');
  }, 120_000);

  test('import-file no longer routes fence extraction through marked (#2862)', async () => {
    // Structural pin: the quadratic-lexer class of bug can only come back if
    // someone re-imports marked into the import hot path.
    const { readFileSync } = await import('fs');
    const src = readFileSync(new URL('../src/core/import-file.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/from ['"]marked['"]/);
  });

  // #2862 — linear-scanner parity edges the marked walk used to handle.
  // Body fidelity is asserted on the scanner itself (the code chunker
  // downstream legitimately reshapes chunk text around parseable symbols).
  test('scanner: longer close fence closes a shorter opener; other-char stays literal (#2862)', () => {
    const md = 'intro\n\n```ts\nconst a = 1;\n~~~\nconst b = 2;\n`````\n\nprose\n';
    const { fences, capped } = scanFencedBlocks(md);
    expect(capped).toBe(false);
    expect(fences.length).toBe(1);
    expect(fences[0]!.lang).toBe('ts');
    // The ~~~ line is fence BODY (wrong char can't close a backtick fence);
    // the ````` line (5 >= 3 backticks) closes it.
    expect(fences[0]!.text).toBe('const a = 1;\n~~~\nconst b = 2;');
  });

  test('scanner: backtick opener with backtick in info string is inline code, not a fence (#2862)', () => {
    const md = '```inline `code` weirdness\nnot a fence body\n';
    const { fences } = scanFencedBlocks(md);
    expect(fences.length).toBe(0);
  });

  test('scanner: opener indentation is stripped from body lines (#2862)', () => {
    const md = '  ```ts\n  const x = 1;\n    deeper();\n  ```\n';
    const { fences } = scanFencedBlocks(md);
    expect(fences.length).toBe(1);
    expect(fences[0]!.text).toBe('const x = 1;\n  deeper();');
  });

  test('scanner: cap stops collection and reports capped (#2862)', () => {
    const md = Array.from({ length: 5 }, (_, i) => '```ts\nconst v' + i + ' = 1;\n```').join('\n\n');
    const { fences, capped } = scanFencedBlocks(md, 3);
    expect(capped).toBe(true);
    expect(fences.length).toBe(3);
  });

  test('unclosed fence runs to EOF (#2862)', async () => {
    const md = 'intro\n\n```python\ndef trailing():\n    return 1\n';
    await importFromContent(engine, 'guides/fence-unclosed', md, { noEmbed: true });
    const chunks = await engine.getChunks('guides/fence-unclosed');
    const fenceChunks = chunks.filter(c => c.chunk_source === 'fenced_code');
    expect(fenceChunks.length).toBeGreaterThan(0);
    expect(fenceChunks[0]!.language).toBe('python');
    expect(fenceChunks[0]!.chunk_text).toContain('def trailing');
  });

  test('lang is the first info-string word (```ts title=x) (#2862)', async () => {
    const md = '```ts title=example.ts\nexport const infoWord = true;\n```\n';
    await importFromContent(engine, 'guides/fence-info-word', md, { noEmbed: true });
    const chunks = await engine.getChunks('guides/fence-info-word');
    const fenceChunks = chunks.filter(c => c.chunk_source === 'fenced_code');
    expect(fenceChunks.length).toBeGreaterThan(0);
    expect(fenceChunks[0]!.language).toBe('typescript');
  });

  test('large fence-less table page imports with zero fenced chunks (no lexer pass) (#2437)', async () => {
    const cols = 16;
    const header = '| ' + Array.from({ length: cols }, (_, i) => 'col' + i).join(' | ') + ' |';
    const sep = '| ' + Array.from({ length: cols }, () => '---').join(' | ') + ' |';
    const body = Array.from({ length: 2000 }, (_, r) =>
      '| ' + Array.from({ length: cols }, (_, c) => 'v' + r + '_' + c).join(' | ') + ' |').join('\n');
    const md = '# Overview\n\n' + header + '\n' + sep + '\n' + body + '\n';
    // sanity: the page is genuinely fence-less, so the fast-path applies
    expect(/(^|[\r\n])[ \t]{0,3}(```|~~~)/.test(md)).toBe(false);
    await importFromContent(engine, 'guides/fence-less-table', md, { noEmbed: true });
    const chunks = await engine.getChunks('guides/fence-less-table');
    const fenceChunks = chunks.filter(c => c.chunk_source === 'fenced_code');
    expect(fenceChunks.length).toBe(0);
  });
});
