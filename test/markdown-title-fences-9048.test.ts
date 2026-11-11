/**
 * Protects imported titles and rename identity from headings quoted in nested
 * Markdown examples. Whole-string and bounded streaming readers must agree on
 * marker character, run length and closing-line grammar, without changing the
 * legacy timeline splitter. Previously every fence-looking line toggled titles.
 * Seams: none; pure parsers plus a real keyless PGLite import/read-back.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { explicitMarkdownTitle, parseMarkdown } from '../src/core/markdown.ts';
import { BodyScanner, scanMarkdownString } from '../src/core/page-body/body-scan.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importStreamedMarkdownFile } from '../src/core/page-body/streamed-import.ts';
import { readPageBodyPolicy } from '../src/core/page-body/limits.ts';

const nested = ['````markdown', '```sh', '# Example command', '```', '````', '', '# Actual guide', '', 'The guide text.'].join('\n');
const fixtures: Array<[string, string, string]> = [
  ['short inner backticks', nested, 'Actual guide'],
  ['mixed markers', ['~~~~markdown', '```sh', '# Quoted', '```', '~~~~', '# Real title'].join('\n'), 'Real title'],
  ['short closer', ['`````md', '````', '# Quoted', '`````', '# Real title'].join('\n'), 'Real title'],
  ['closer with info', ['```sh', '```not-a-close', '# Quoted', '```', '# Real title'].join('\n'), 'Real title'],
  ['unclosed outer', ['````md', '```', '# Quoted', '```'].join('\n'), 'Fallback'],
  ['longer closer', ['   ```sh', '# Quoted', '  `````  \t', '# Real title ###'].join('\n'), 'Real title'],
  ['invalid inline opener', ['```inline`code', '# Real title'].join('\n'), 'Real title'],
  ['four-space indentation', ['    ```sh', '# Real title'].join('\n'), 'Real title'],
  ['frontmatter precedence', '---\ntitle: Explicit title\n---\n' + nested, 'Explicit title'],
  ['filename fallback', '````md\n```sh\n# Quoted\n```\n````', 'Fallback'],
  ['long marker runs', ['`'.repeat(8193) + 'md', '`'.repeat(4097), '# Quoted', '`'.repeat(8193), '# Real title'].join('\n'), 'Real title'],
  ['long info tail', ['````' + 'm'.repeat(8193), '```sh', '# Quoted', '```', '````', '# Real title'].join('\n'), 'Real title'],
];

describe('Markdown title fence grammar (#9048)', () => {
  for (const [name, input, title] of fixtures) {
    for (const ending of ['\n', '\r\n']) {
      test(`${name} (${JSON.stringify(ending)})`, () => {
        const content = input.replaceAll('\n', ending);
        const parsed = parseMarkdown(content, 'notes/fallback.md');
        expect(parsed.title).toBe(title);
        expect(explicitMarkdownTitle(content)).toBe(title === 'Fallback' ? '' : title);
        for (const buffer of [16, 65536]) {
          const scan = scanMarkdownString(content, 'notes/fallback.md', undefined, buffer);
          expect(scan.kind).toBe('ok');
          if (scan.kind === 'ok') expect(scan.parsed.title).toBe(title);
        }
        const scanner = new BodyScanner('notes/fallback.md', undefined, 16);
        const bytes = new TextEncoder().encode(content);
        for (let at = 0; at < bytes.length; at += 7) scanner.push(bytes.subarray(at, at + 7));
        const streamed = scanner.finish();
        expect(streamed.kind).toBe('ok');
        if (streamed.kind === 'ok') expect(streamed.parsed.title).toBe(title);
      });
    }
  }
});

let engine: PGLiteEngine;
let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gbrain-title-fences-'));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => {
  await engine?.disconnect();
  rmSync(dir, { recursive: true, force: true });
});

test('real import stores the outside H1 and preserves body through unchanged replay', async () => {
  const content = '---\ntype: note\n---\n\n' + nested;
  const first = await importFromContent(engine, 'notes/nested-fence', content, { noEmbed: true, sourceId: 'default' });
  expect(first.status).toBe('imported');
  const stored = await engine.getPage('notes/nested-fence', { sourceId: 'default' });
  expect(stored?.title).toBe('Actual guide');
  expect(stored?.compiled_truth).toBe(nested);
  const replay = await importFromContent(engine, 'notes/nested-fence', content, { noEmbed: true, sourceId: 'default' });
  expect(replay.status).toBe('skipped');
  expect((await engine.getPage('notes/nested-fence', { sourceId: 'default' }))?.title).toBe('Actual guide');
}, 120_000);

test('real streamed file import publishes the outside H1', async () => {
  const path = join(dir, 'streamed-title.md');
  writeFileSync(path, '---\ntype: note\n---\n\n' + nested);
  const result = await importStreamedMarkdownFile(engine, path, 'streamed-title.md',
    { noEmbed: true, sourceId: 'default', inferFrontmatter: false }, statSync(path), await readPageBodyPolicy(engine));
  expect(result).toMatchObject({ status: 'imported' });
  expect((await engine.readPageSnapshot('streamed-title', { sourceId: 'default' }))?.page.title).toBe('Actual guide');
}, 120_000);
