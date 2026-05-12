import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { operations } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { readContext } from '../src/core/services/read-context-service.ts';

function getPageOperation() {
  const op = operations.find(operation => operation.name === 'get_page');
  if (!op) throw new Error('get_page operation is missing');
  return op;
}

test('get_page can return a bounded content window with continuation selectors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-get-page-window-'));
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    await engine.initSchema();

    await importFromContent(engine, 'concepts/large-page', [
      '---',
      'type: concept',
      'title: Large Page',
      '---',
      'A'.repeat(120),
      '',
      '---',
      '',
      'B'.repeat(120),
    ].join('\n'));

    const result = await getPageOperation().handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      slug: 'concepts/large-page',
      content_char_limit: 50,
    }) as any;

    expect(result.compiled_truth).toHaveLength(50);
    expect(result.timeline).toHaveLength(50);
    expect(result.content_window.truncated).toBe(true);
    expect(result.content_window.compiled_truth.has_more).toBe(true);
    expect(result.content_window.compiled_truth.continuation_selector.kind).toBe('compiled_truth');
    expect(result.content_window.compiled_truth.continuation_selector.char_start).toBe(50);
    expect(result.content_window.timeline.has_more).toBe(true);
    expect(result.content_window.timeline.continuation_selector.kind).toBe('timeline_range');
    expect(result.content_window.timeline.continuation_selector.char_start).toBe(50);

    const continuationRead = await readContext(engine, {
      selectors: [result.content_window.timeline.continuation_selector],
      token_budget: 100,
    });
    expect(continuationRead.canonical_reads[0]?.text).toBe('B'.repeat(70));
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('get_page keeps full content by default for CLI compatibility', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-get-page-full-'));
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    await engine.initSchema();

    await importFromContent(engine, 'concepts/full-page', [
      '---',
      'type: concept',
      'title: Full Page',
      '---',
      'full compiled truth',
      '',
      '---',
      '',
      'full timeline',
    ].join('\n'));

    const result = await getPageOperation().handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      slug: 'concepts/full-page',
    }) as any;

    expect(result.compiled_truth).toBe('full compiled truth');
    expect(result.timeline).toBe('full timeline');
    expect(result.content_window).toBeUndefined();
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
