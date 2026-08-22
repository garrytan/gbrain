/**
 * issue #3969 — unconditional no-op ingest_log writes made get_ingest_log
 * unusable on a cron (93% of rows were "Imported 0 pages, N skipped, 0
 * chunks"). runImport (and performSync's mirror) now gate the write through
 * shouldLogIngest: skip when imported===0 && errors===0 && chunksCreated===0,
 * unless --log-noop opts back in.
 *
 * Hermetic PGLite; temp dir + sandboxed GBRAIN_HOME (checkpoint/ledger files
 * never touch the real ~/.gbrain).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runImport, shouldLogIngest } from '../src/commands/import.ts';
import { withEnv } from './helpers/with-env.ts';

describe('shouldLogIngest predicate (#3969)', () => {
  test('all-zero counters without --log-noop → skip', () => {
    expect(shouldLogIngest({ imported: 0, errors: 0, chunksCreated: 0 }, false)).toBe(false);
  });

  test('imported > 0 → log', () => {
    expect(shouldLogIngest({ imported: 1, errors: 0, chunksCreated: 0 }, false)).toBe(true);
  });

  test('errors > 0 → log (failures are events)', () => {
    expect(shouldLogIngest({ imported: 0, errors: 2, chunksCreated: 0 }, false)).toBe(true);
  });

  test('chunksCreated > 0 → log', () => {
    expect(shouldLogIngest({ imported: 0, errors: 0, chunksCreated: 3 }, false)).toBe(true);
  });

  test('all-zero counters with --log-noop → log (liveness opt-in)', () => {
    expect(shouldLogIngest({ imported: 0, errors: 0, chunksCreated: 0 }, true)).toBe(true);
  });
});

describe('runImport ingest_log gating (#3969)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
  }, 60_000);

  async function ingestLogCount(): Promise<number> {
    const rows = await engine.executeRaw<{ n: string | number }>(
      `SELECT COUNT(*)::text AS n FROM ingest_log`,
    );
    return Number(rows[0]?.n ?? 0);
  }

  test('real import logs; unchanged re-import (noop poll) does not; --log-noop opts back in', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-ingest-noop-'));
    writeFileSync(join(dir, 'note.md'), '---\ntype: note\n---\n# Note\n\nbody\n');
    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-home-'));

    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      // Run 1: a page is imported → row written.
      const r1 = await runImport(engine, [dir, '--no-embed', '--json']);
      expect(r1.imported).toBe(1);
      expect(await ingestLogCount()).toBe(1);

      // Run 2: nothing changed → the poll writes NO row (pre-fix: one row
      // per poll, "Imported 0 pages, 1 skipped, 0 chunks").
      const r2 = await runImport(engine, [dir, '--no-embed', '--json']);
      expect(r2.imported).toBe(0);
      expect(r2.errors).toBe(0);
      expect(r2.chunksCreated).toBe(0);
      expect(await ingestLogCount()).toBe(1);

      // Run 3: --log-noop opts back into the per-poll row.
      const r3 = await runImport(engine, [dir, '--no-embed', '--json', '--log-noop']);
      expect(r3.imported).toBe(0);
      expect(await ingestLogCount()).toBe(2);
    });
  }, 60_000);
});
