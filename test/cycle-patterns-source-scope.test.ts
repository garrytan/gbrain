/**
 * Regression for #1586's unfixed half: the patterns phase.
 *
 * #1586 threaded the cycle's resolved source through `synthesize.ts` so dream
 * output lands in the named source's `(source_id, slug)` rows. `patterns.ts`
 * was left on the pre-#1586 shape: `collectChildPutPageSlugs` stamped a literal
 * `'default'` and `reverseWriteRefs` compared against a literal `'default'`.
 *
 * The result on a per-source cycle was a page filed against the wrong source:
 * the ROW is created under `default` (the child had no `source_id` to scope
 * its put_page calls), while the reverse-write drops the FILE into the named
 * source's checkout — `source_id === 'default'` selected the
 * `brainDir/<slug>.md` branch, and on a per-source cycle `brainDir` IS the
 * named source's checkout. Row and file then disagree about which source owns
 * the page, which is what `doctor` reports as `multi_source_drift`.
 *
 * These tests pin both halves of the fix, plus the unscoped legacy behavior.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __testing } from '../src/core/cycle/patterns.ts';

const { collectChildPutPageSlugs, reverseWriteRefs } = __testing;

const SOURCE_ID = 'coast';
const SLUG = 'wiki/personal/patterns/a-pattern';

let engine: PGLiteEngine;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-patterns-scope-'));

  const db = (engine as any).db;
  await db.exec(`
    INSERT INTO sources (id, name, local_path)
    VALUES ('${SOURCE_ID}', 'coast', '/tmp/coast-brain')
    ON CONFLICT (id) DO NOTHING;
  `);
  await db.exec(`
    INSERT INTO minion_jobs (id, queue, name, data, status)
    VALUES (2001, 'default', 'subagent', '{}'::jsonb, 'completed')
    ON CONFLICT (id) DO NOTHING;
  `);
  await db.query(
    `INSERT INTO subagent_tool_executions (job_id, message_idx, tool_use_id, tool_name, status, input)
     VALUES (2001, 0, 'tool_p1', 'brain_put_page', 'complete', $1::jsonb)`,
    [JSON.stringify({ slug: SLUG, body: 'a pattern' })],
  );

  // The page the child wrote lives in the cycle's source, not in 'default'.
  await engine.putPage(SLUG, {
    type: 'note',
    title: 'A pattern',
    compiled_truth: 'a pattern',
  } as any, { sourceId: SOURCE_ID });
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(brainDir, { recursive: true, force: true });
});

describe('#1586: the patterns phase scopes its writes to the cycle source', () => {
  test('collected refs carry the cycle source, not a hardcoded default', async () => {
    const refs = await collectChildPutPageSlugs(engine as any, [2001], SOURCE_ID);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.slug).toBe(SLUG);
    // Pre-fix this was the literal 'default' no matter which source the cycle
    // resolved, which is what filed the page against the wrong source.
    expect(refs[0]!.source_id).toBe(SOURCE_ID);
  });

  test('unscoped callers keep the legacy default source', async () => {
    const refs = await collectChildPutPageSlugs(engine as any, [2001]);
    expect(refs[0]!.source_id).toBe('default');
  });

  test('reverse-write resolves the row the child actually wrote', async () => {
    const refs = await collectChildPutPageSlugs(engine as any, [2001], SOURCE_ID);
    const count = await reverseWriteRefs(engine as any, brainDir, refs, SOURCE_ID);
    // The lookup is keyed on the ref's source_id, so a ref carrying the cycle
    // source resolves the row the child wrote there.
    expect(count).toBe(1);
  });

  test('the cycle source is native — its pages stay at brainDir/<slug>.md', async () => {
    const refs = await collectChildPutPageSlugs(engine as any, [2001], SOURCE_ID);
    await reverseWriteRefs(engine as any, brainDir, refs, SOURCE_ID);
    expect(existsSync(join(brainDir, `${SLUG}.md`))).toBe(true);
    expect(existsSync(join(brainDir, '.sources', SOURCE_ID, `${SLUG}.md`))).toBe(false);
  });

  test('a foreign source still lands under .sources/<id>/', async () => {
    const foreignDir = mkdtempSync(join(tmpdir(), 'gbrain-patterns-foreign-'));
    try {
      const refs = await collectChildPutPageSlugs(engine as any, [2001], SOURCE_ID);
      // brainDir belongs to 'default' here, so 'coast' is foreign to it.
      await reverseWriteRefs(engine as any, foreignDir, refs, 'default');
      expect(existsSync(join(foreignDir, '.sources', SOURCE_ID, `${SLUG}.md`))).toBe(true);
      expect(existsSync(join(foreignDir, `${SLUG}.md`))).toBe(false);
    } finally {
      rmSync(foreignDir, { recursive: true, force: true });
    }
  });
});
