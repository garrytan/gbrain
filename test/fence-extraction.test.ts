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
});
