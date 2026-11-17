/**
 * F4b (spec 5.3 test 8, O-CEO-17, Addendum A item 1): `foresights import` of
 * 2,000 pages into PGLite refreshes planner statistics during the import, at
 * every `import.analyze_every_pages` (500) pages where the row-delta threshold
 * says the hot tables are stale, instead of planning the whole import against
 * the empty tables it started with. Slow: a real 2,000-file import.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runImport } from '../src/commands/import.ts';
import { __testing } from '../src/core/planner-stats.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  __testing.hooks.onAnalyzed = undefined;
  await engine.disconnect();
});

describe('8. ANALYZE during import', () => {
  test('a 2,000-page import analyzes pages at 500, 1,000, 1,500 and 2,000 pages and chunks when over the threshold', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'planner-import-'));
    for (let i = 0; i < 2000; i++) {
      writeFileSync(join(dir, `note-${String(i).padStart(4, '0')}.md`),
        `---\ntitle: Note ${i}\ntype: note\n---\nNote ${i} links to [[note-${String((i + 1) % 2000).padStart(4, '0')}]] about topic ${i % 37}.\n`);
    }
    await engine.setConfig('import.analyze_every_pages', '500');
    const analyzed: Array<{ table: string; pages: number }> = [];
    __testing.hooks.onAnalyzed = async (eng, event) => {
      if (event.reason !== 'import') return;
      const [{ n }] = await eng.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages');
      analyzed.push({ table: event.table, pages: n });
    };

    await runImport(engine, [dir, '--no-embed']);

    expect(analyzed.filter(a => a.table === 'pages').map(a => a.pages)).toEqual([500, 1000, 1500, 2000]);
    // One chunk per page: 500 new chunks are not over the max(500, 10%) threshold, 1,000 are.
    expect(analyzed.filter(a => a.table === 'content_chunks').map(a => a.pages)).toEqual([1000, 2000]);
    const [{ n }] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pg_stats WHERE schemaname = 'public' AND tablename = 'pages'");
    expect(n).toBeGreaterThan(0);
  }, 600_000);
});
