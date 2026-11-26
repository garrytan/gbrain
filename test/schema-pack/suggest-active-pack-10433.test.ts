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

test('coverage reads every type in a folder and every folder: a sixth undeclared type and a gap behind 50 covered folders are suggested', async () => {
  const wide = new PGLiteEngine();
  await wide.connect({});
  await wide.initSchema();
  try {
    for (const [i, type] of ['analysis', 'company', 'concept', 'deal', 'guide', 'zebra-kind'].entries()) {
      await wide.putPage(`mixed-notes/page-${i}`, { type: type as never, title: `mixed ${i}`, compiled_truth: 'Synthetic body.', timeline: '' });
    }
    for (let f = 0; f < 50; f++) {
      for (let i = 0; i < 6; i++) await wide.putPage(`covered-${f}/page-${i}`, { type: 'person' as never, title: `covered ${f} ${i}`, compiled_truth: 'Synthetic body.', timeline: '' });
    }
    for (let i = 0; i < 5; i++) await wide.putPage(`gizmos/page-${i}`, { type: 'gizmo' as never, title: `gizmo ${i}`, compiled_truth: 'Synthetic body.', timeline: '' });
    const result = await runSuggest(wide, { sourceId: 'default' });
    const summaries = result.suggestions.map(s => s.summary);
    expect(summaries.some(s => s.includes('`mixed-notes/`'))).toBe(true);
    expect(summaries.some(s => s.includes('`gizmos/`'))).toBe(true);
    expect(summaries.some(s => s.includes('`covered-'))).toBe(false);
    expect(result.notes.join('\n')).toContain('50 prefix(es) skipped');
  } finally {
    await wide.disconnect();
  }
}, 120_000);

test('a folder of untyped notes, which ingestion types as concept, is still suggested', async () => {
  for (let i = 0; i < 5; i++) {
    await engine.putPage(`scratch-notes/page-${i}`, { type: 'concept' as never, title: `scratch ${i}`, compiled_truth: 'Synthetic body.', timeline: '' });
  }
  const result = await runSuggest(engine, { sourceId: 'default' });
  expect(result.suggestions.map(s => s.summary).some(s => s.includes('`scratch-notes/`'))).toBe(true);
});
