import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runImport } from '../src/commands/import.ts';
import { currentTextProjectionFilter } from '../src/core/search/safe-chunks.ts';

describe('bulk import collects planner statistics after empty initialization', () => {
  let engine: PGLiteEngine;
  let directory: string;

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'gbrain-planner-import-'));
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    for (let i = 0; i < 12; i++) {
      writeFileSync(join(directory, `example-${i}.md`), `---\ntitle: Synthetic example ${i}\ntype: note\n---\nSynthetic source observation ${i}.\n`);
    }
  }, 60_000);

  afterAll(async () => {
    await engine?.disconnect();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  test('the real import completion refreshes expression samples', async () => {
    const imported = await runImport(engine, [directory, '--no-embed', '--json']);
    expect(imported.imported).toBe(12);
    const rows = await engine.executeRaw<{ 'QUERY PLAN': Array<{ Plan: { 'Plan Rows': number } }> }>(
      `EXPLAIN (FORMAT JSON) SELECT * FROM pages p WHERE ${currentTextProjectionFilter('p')}`,
    );
    expect(rows[0]['QUERY PLAN'][0].Plan['Plan Rows']).toBe(12);
  }, 60_000);
});
