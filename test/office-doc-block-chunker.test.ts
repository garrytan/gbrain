import { test, expect } from 'bun:test';
import { chunkDocBlocks } from '../src/core/chunkers/doc-block.ts';
import {
  type DocBlock,
  type DocBlockType,
  type SourceLocator,
  emptyLocator,
} from '../src/core/office/types.ts';

function loc(page: number | null = null): SourceLocator {
  return { ...emptyLocator(), page };
}

function blk(
  type: DocBlockType,
  markdown: string,
  extra: Partial<DocBlock> & { order: number },
): DocBlock {
  return {
    id: extra.id ?? `b${extra.order}`,
    type,
    level: extra.level ?? (type === 'heading' ? 1 : null),
    markdown,
    text: extra.text ?? markdown,
    order: extra.order,
    locator: extra.locator ?? emptyLocator(),
    table: extra.table ?? null,
    asset_ref: extra.asset_ref ?? null,
  };
}

test('merges consecutive prose into one chunk under target', () => {
  const chunks = chunkDocBlocks(
    [
      blk('paragraph', 'Hello world.', { order: 0 }),
      blk('paragraph', 'Second paragraph.', { order: 1 }),
    ],
    { targetWords: 100 },
  );
  expect(chunks.length).toBe(1);
  expect(chunks[0].chunk_source).toBe('doc_block');
  expect(chunks[0].chunk_text).toContain('Hello world.');
  expect(chunks[0].chunk_text).toContain('Second paragraph.');
});

test('heading flushes prior prose and is prepended as context', () => {
  const chunks = chunkDocBlocks(
    [
      blk('paragraph', 'Intro.', { order: 0 }),
      blk('heading', '## Section A', { order: 1, level: 2 }),
      blk('paragraph', 'Body of A.', { order: 2 }),
    ],
    { targetWords: 100 },
  );
  expect(chunks.length).toBe(2);
  expect(chunks[0].chunk_text).toBe('Intro.');
  expect(chunks[1].chunk_text.startsWith('## Section A')).toBe(true);
  expect(chunks[1].chunk_text).toContain('Body of A.');
});

test('table is a hard boundary and is NOT emitted as a chunk', () => {
  const chunks = chunkDocBlocks(
    [
      blk('paragraph', 'Before table.', { order: 0 }),
      blk('table', 'TABLE_MARKDOWN_SENTINEL', {
        order: 1,
        table: { header_rows: 1, n_rows: 2, n_cols: 2, columns: ['a', 'b'], rows: [['1', '2']] },
      }),
      blk('paragraph', 'After table.', { order: 2 }),
    ],
    { targetWords: 100 },
  );
  expect(chunks.length).toBe(2);
  const joined = chunks.map((c) => c.chunk_text).join('\n');
  expect(joined).not.toContain('TABLE_MARKDOWN_SENTINEL');
  expect(joined).toContain('Before table.');
  expect(joined).toContain('After table.');
});

test('figure is a hard boundary and is NOT emitted', () => {
  const chunks = chunkDocBlocks(
    [
      blk('paragraph', 'P.', { order: 0 }),
      blk('figure', 'FIGURE_SENTINEL', { order: 1, asset_ref: 'a1' }),
    ],
    { targetWords: 100 },
  );
  expect(chunks.length).toBe(1);
  expect(chunks[0].chunk_text).not.toContain('FIGURE_SENTINEL');
});

test('code becomes its own self-contained chunk', () => {
  const chunks = chunkDocBlocks(
    [
      blk('paragraph', 'Prose.', { order: 0 }),
      blk('code', '```js\nconsole.log(1)\n```', { order: 1 }),
    ],
    { targetWords: 100 },
  );
  expect(chunks.length).toBe(2);
  expect(chunks[1].chunk_text).toContain('console.log(1)');
});

test('merged chunk locator takes the min (start) page', () => {
  const chunks = chunkDocBlocks(
    [
      blk('paragraph', 'P1.', { order: 0, locator: loc(2) }),
      blk('paragraph', 'P2.', { order: 1, locator: loc(3) }),
    ],
    { targetWords: 100 },
  );
  expect(chunks.length).toBe(1);
  expect(chunks[0].source_locator.page).toBe(2);
});

test('oversized single prose block is split into multiple chunks', () => {
  const big = Array.from({ length: 50 }, (_, i) => `word${i}`).join(' ');
  const chunks = chunkDocBlocks([blk('paragraph', big, { order: 0 })], { targetWords: 10 });
  expect(chunks.length).toBeGreaterThan(1);
  for (const c of chunks) expect(c.chunk_source).toBe('doc_block');
});

test('blocks out of order are processed by order field', () => {
  const chunks = chunkDocBlocks(
    [
      blk('paragraph', 'Second.', { order: 1 }),
      blk('heading', '# Title', { order: 0 }),
    ],
    { targetWords: 100 },
  );
  // heading(0) flushes nothing, then prose(1) carries the heading context
  expect(chunks.length).toBe(1);
  expect(chunks[0].chunk_text.startsWith('# Title')).toBe(true);
  expect(chunks[0].chunk_text).toContain('Second.');
});
