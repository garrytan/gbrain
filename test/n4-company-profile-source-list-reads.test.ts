/**
 * The company-brain profile reads and the source list that N4 moved behind typed members keep what the
 * `executeRaw` statements they replaced had.
 *
 * 1. Protects: `getCompanyBrainProfile` reads the source row and the ingestion receipt through the engine's own
 *    `executeRaw` (so a cancelled request and a wrapped `executeRaw` see them, as before N4), and a managed import's
 *    batch answers each of those two reads once, however many pages it admits (`batchSharedReads`).
 * 2. Fails when: a member reads on a path that bypasses `engine.executeRaw` (the cancellation fixtures in
 *    test/persistence-sync-company.serial.test.ts stop seeing the read and the run completes instead of cancelling), or
 *    `batchSharedReads` stops memoising the two typed twins (100 admitted pages issue 200 statements instead of 2).
 * 3. Existing coverage: test/n4-sql-move-parity.test.ts pins the statement text and rows; the batch counts and the
 *    path through `executeRaw` were not pinned.
 * 4. The source-list deadline is pinned by test/doctor-typed-reads-deadline.test.ts and
 *    test/doctor-typed-reads-stall.test.ts (`listSourceRecords` is a bounded typed read).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { getCompanyBrainProfile } from '../src/core/company-brain/profile.ts';
import { batchSharedReads } from '../src/core/persistence/page-mutations.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('company-brain profile reads', () => {
  test('the source row and the receipt are read through the engine\'s executeRaw', async () => {
    const execute = engine.executeRaw;
    const seen: string[] = [];
    engine.executeRaw = async function (this: BrainEngine, sql: string, params?: unknown[]) {
      seen.push(flat(sql));
      return execute.call(this, sql, params);
    } as BrainEngine['executeRaw'];
    try {
      await getCompanyBrainProfile(engine, 'default');
    } finally { engine.executeRaw = execute; }
    expect(seen).toContain('SELECT config,incarnation FROM sources WHERE id=$1');
    expect(seen.some(sql => sql.startsWith('SELECT r.id FROM source_ingestion_receipts r JOIN sources s'))).toBe(true);
  });

  test('a batch answers each of the two reads once for 100 pages', async () => {
    const calls = { incarnation: 0, receipt: 0 };
    const fake = {
      readSourceIncarnation: async () => { calls.incarnation++; return { config: {}, incarnation: 'i' }; },
      hasCompanyBrainReceipt: async () => { calls.receipt++; return true; },
      executeRaw: async () => [],
    } as unknown as BrainEngine;
    const shared = batchSharedReads(fake);
    for (let i = 0; i < 100; i++) {
      await shared.readSourceIncarnation('s');
      await shared.hasCompanyBrainReceipt('s');
    }
    expect(calls).toEqual({ incarnation: 1, receipt: 1 });
    // A different source is a different read.
    await shared.readSourceIncarnation('t');
    expect(calls.incarnation).toBe(2);
  });
});
