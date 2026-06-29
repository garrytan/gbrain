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

  // #2437: a large fence-less body must produce zero fenced_code chunks. The
  // fence-opener guard short-circuits marked.lexer (the transient-OOM source)
  // for these — proven here by the [] result on a body with no ``` / ~~~ at all.
  test('large fence-less prose page produces zero fenced_code chunks', async () => {
    // ~50KB of prose, no code fence anywhere (the ~99% case, and the shape
    // that drove marked.lexer to a ~60x transient spike and OOM).
    const para =
      'This is ordinary wiki prose with no fenced code block of any kind. ' +
      'It mentions code informally but never opens a fence. ';
    const md = `# Large fence-less page\n\n${para.repeat(800)}\n`;
    expect(md.length).toBeGreaterThan(40_000);
    expect(md).not.toMatch(/```|~~~/); // sanity: truly fence-less

    await importFromContent(engine, 'guides/fence-less-large', md, { noEmbed: true });
    const chunks = await engine.getChunks('guides/fence-less-large');
    const fenceChunks = chunks.filter(c => c.chunk_source === 'fenced_code');
    expect(fenceChunks.length).toBe(0);
  });

  // #2437: the guard must not break the happy path — a body WITH a recognized
  // fence still extracts its chunk(s) past the early-return.
  test('fenced page still extracts after the fence-less guard (happy path intact)', async () => {
    const md = `# Has a fence\n\nIntro prose.\n\n\`\`\`ts\nexport const answer = 42;\n\`\`\`\n\nOutro prose.`;
    await importFromContent(engine, 'guides/fence-guard-happy', md, { noEmbed: true });
    const chunks = await engine.getChunks('guides/fence-guard-happy');
    const fenceChunks = chunks.filter(c => c.chunk_source === 'fenced_code');
    expect(fenceChunks.length).toBeGreaterThan(0);
    expect(fenceChunks[0]!.language).toBe('typescript');
  });
});
