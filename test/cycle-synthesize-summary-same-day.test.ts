/** #9598: a later same-day synthesize run keeps the earlier runs' summary links to live pages, and counts them apart. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __testing } from '../src/core/cycle/synthesize.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const writeSummaryPage = __testing.writeSummaryPage as (
  engine: PGLiteEngine, brainDir: string, slug: string, date: string, written: string[],
  outcomes: Array<{ jobId: number; status: string }>,
) => Promise<unknown>;

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => {
  await engine.disconnect();
});

describe('same-day dream summary (#9598)', () => {
  test('a second run lists its own page and the first run\'s live pages, counting each run apart', async () => {
    await resetPgliteState(engine);
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-summary-same-day-'));
    const summary = 'dream-cycle-summaries/2026-08-20';
    try {
      for (const s of ['wiki/a', 'wiki/b', 'wiki/c']) {
        await engine.putPage(s, { type: 'note', title: s, compiled_truth: 'body' });
      }
      const outcomes = [{ jobId: 1, status: 'completed' }];
      await writeSummaryPage(engine, brainDir, summary, '2026-08-20', ['wiki/a', 'wiki/b'], outcomes);
      await engine.deletePage('wiki/b');
      await writeSummaryPage(engine, brainDir, summary, '2026-08-20', ['wiki/c'], outcomes);
      const body = (await engine.getPage(summary))?.compiled_truth ?? '';
      expect(body).toContain('- [[wiki/a]]');
      expect(body).toContain('- [[wiki/c]]');
      expect(body).not.toContain('[[wiki/b]]');
      expect(body).toContain('**Pages written:** 1.');
      expect(body).toContain('**Pages from earlier runs today:** 1.');
      expect(body).toContain('## Pages');
    } finally {
      rmSync(brainDir, { recursive: true, force: true });
    }
  }, 120_000);
});
