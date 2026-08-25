/**
 * #4506 — the dream cycle-summary dual-write into <brainDir> dirtied clean
 * source repos (an untracked dream-cycle-summaries/<date>.md after every
 * nightly run) with no opt-out. Pinned here:
 *   - default stays the dual-write (back-compat): DB row + file;
 *   - `dream.synthesize.summary_file_write=false` keeps the DB row and
 *     skips the file;
 *   - a gbrain.yml storage tier declaring the summary path `db_only`
 *     suppresses the file write too (the DB/file-plane split covers it).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { __testing } from '../src/core/cycle/synthesize.ts';

const { writeSummaryPage } = __testing;

let engine: PGLiteEngine;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 300_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-4506-'));
});

const SLUG = 'dream-cycle-summaries/2026-08-22';

async function runWrite(): Promise<void> {
  await writeSummaryPage(
    engine, brainDir, SLUG, '2026-08-22',
    ['wiki/some/page'], [{ jobId: 1, status: 'completed' }], 'default',
  );
}

async function dbRowExists(): Promise<boolean> {
  const page = await engine.getPage(SLUG, { sourceId: 'default' });
  return page !== null;
}

describe('#4506 — summary file-write opt-out', () => {
  test('default: dual-write (DB row + file) — back-compat', async () => {
    await runWrite();
    expect(await dbRowExists()).toBe(true);
    expect(existsSync(join(brainDir, `${SLUG}.md`))).toBe(true);
  });

  test('dream.synthesize.summary_file_write=false: DB row only, repo stays clean', async () => {
    await engine.setConfig('dream.synthesize.summary_file_write', 'false');
    await runWrite();
    expect(await dbRowExists()).toBe(true);
    expect(existsSync(join(brainDir, `${SLUG}.md`))).toBe(false);
    expect(existsSync(join(brainDir, 'dream-cycle-summaries'))).toBe(false);
  });

  test("'off' and '0' spellings suppress too", async () => {
    for (const v of ['off', '0']) {
      const dir = mkdtempSync(join(tmpdir(), 'gbrain-4506-v-'));
      try {
        await engine.setConfig('dream.synthesize.summary_file_write', v);
        await writeSummaryPage(engine, dir, SLUG, '2026-08-22', [], [], 'default');
        expect(existsSync(join(dir, `${SLUG}.md`))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('gbrain.yml db_only tier covering the summary path suppresses the file write', async () => {
    writeFileSync(
      join(brainDir, 'gbrain.yml'),
      'storage:\n  db_only:\n    - dream-cycle-summaries\n',
      'utf8',
    );
    await runWrite();
    expect(await dbRowExists()).toBe(true);
    expect(existsSync(join(brainDir, `${SLUG}.md`))).toBe(false);
  });

  test('gbrain.yml with an unrelated db_only tier keeps the dual-write', async () => {
    writeFileSync(
      join(brainDir, 'gbrain.yml'),
      'storage:\n  db_only:\n    - atoms\n',
      'utf8',
    );
    await runWrite();
    expect(existsSync(join(brainDir, `${SLUG}.md`))).toBe(true);
  });
});
