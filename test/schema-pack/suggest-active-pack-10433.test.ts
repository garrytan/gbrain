/**
 * #10433: `gbrain schema suggest` (and the dream schema-suggest phase) proposes add_type only for real gaps.
 *
 * Before the fix every slug prefix with enough pages got an add_type suggestion named after the folder, even when
 * the active pack already declares that folder as a path prefix or the folder's pages already carry types the pack
 * declares, so a brain whose pack covers its folders got only pluralized duplicates. Now a prefix the pack declares,
 * or whose typed pages all carry a declared type (or alias), is skipped with a note. PGLite (repo-less), the bundled
 * default pack (gbrain-base).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runSuggest } from '../../src/core/schema-pack/suggest.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const seed = async (prefix: string, type: string) => {
    for (let i = 0; i < 5; i++) {
      await engine.putPage(`${prefix}page-${i}`, { type: type as never, title: `${prefix} ${i}`, compiled_truth: 'Synthetic body.', timeline: '' });
    }
  };
  await seed('people/', 'person');
  await seed('kitchen-notes/', 'meeting');
  await seed('widgets/', 'note');
  await seed('gadgets/', 'gadget');
  await engine.executeRaw("UPDATE pages SET type = '' WHERE slug LIKE 'widgets/%'");
}, 60_000);
afterAll(async () => { await engine.disconnect(); });

test('declared prefixes and folders of declared types are skipped; untyped and undeclared folders are suggested', async () => {
  const result = await runSuggest(engine, { sourceId: 'default' });
  const summaries = result.suggestions.map(s => s.summary);
  expect(summaries.some(s => s.includes('`people/`'))).toBe(false);
  expect(summaries.some(s => s.includes('`kitchen-notes/`'))).toBe(false);
  expect(summaries.some(s => s.includes('`widgets/`'))).toBe(true);
  expect(summaries.some(s => s.includes('`gadgets/`'))).toBe(true);
  expect(result.notes.join('\n')).toContain('2 prefix(es) skipped');
});
