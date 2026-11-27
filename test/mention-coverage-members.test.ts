/**
 * The mention-coverage typed members called directly on a real brain that has status rows.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: readMentionIndexStatus returns the status rows of the listed sources only;
 *    countLivePagesInSource counts a source's live pages; countMentionDueSince counts a source's
 *    live, unscanned pages written at or after a bound (`-infinity` for none); recountMentionIndexStatus saves a recount
 *    (pending, policy fingerprint, counted_at) only while the stored fingerprint is still the one
 *    the caller read, flips `complete` to `pending` when the recount is above 0, and leaves every
 *    other state, and a row whose fingerprint moved, unchanged.
 *  - Regression: the recount is the write on the coverage read path (mentions/coverage.ts). A lost
 *    compare-and-set overwrites a newer pass's fingerprint, and a lost state flip reports
 *    `complete` with pages pending.
 *  - Why existing coverage misses it: test/engine-parity/mention-coverage.test.ts runs every
 *    engine with no mention pass, so it never has a status row; test/mentions-coverage-version.test.ts
 *    reaches the recount only through readMentionCoverage on PGLite.
 *  - Seam: none. Real engines (PGLite, and Postgres when DATABASE_URL is set); status rows are
 *    seeded through executeRaw because only the mention pass writes them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MENTION_EXTRACTOR_VERSION } from '../src/core/mentions/pass.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const COUNTED_AT = '2001-01-01T00:00:00.000Z';

for (const kind of testBackends()) {
  describe(`mention-coverage typed members (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    async function seedStatus(sourceId: string, state: string, fingerprint: string | null): Promise<void> {
      await engine.executeRaw(
        `INSERT INTO mention_index_status (source_id, state, pending, counted_at, policy_fingerprint)
         VALUES ($1, $2, 3, $3::timestamptz, $4)
         ON CONFLICT (source_id) DO UPDATE SET state = EXCLUDED.state, pending = 3, counted_at = EXCLUDED.counted_at,
           policy_fingerprint = EXCLUDED.policy_fingerprint`,
        [sourceId, state, COUNTED_AT, fingerprint]);
    }
    async function status(sourceId: string) {
      const [row] = await engine.readMentionIndexStatus([sourceId]);
      return row ? { state: row.state, pending: Number(row.pending), fingerprint: row.policy_fingerprint,
        counted: row.counted_at == null ? null : new Date(row.counted_at as string).toISOString() } : null;
    }

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('other', 'other') ON CONFLICT (id) DO NOTHING`);
      for (const slug of ['notes/a', 'notes/b', 'notes/gone']) await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'Body.', timeline: '' });
      await engine.softDeletePage('notes/gone', { sourceId: 'default' });
      await engine.putPage('notes/c', { type: 'note', title: 'c', compiled_truth: 'Body.', timeline: '' }, { sourceId: 'other' });
    });
    afterAll(async () => { await close(); });

    test('the status read returns the rows of the listed sources only', async () => {
      expect(await engine.readMentionIndexStatus(['default', 'other'])).toEqual([]);
      await seedStatus('default', 'complete', 'h;v-old');
      const rows = await engine.readMentionIndexStatus(['default', 'other', 'ghost']);
      expect(rows.map(r => [r.source_id, r.state, Number(r.pending), r.policy_fingerprint, r.last_pass_at])).toEqual([['default', 'complete', 3, 'h;v-old', null]]);
      expect(new Date(rows[0]!.counted_at as string).toISOString()).toBe(COUNTED_AT);
      expect(await engine.readMentionIndexStatus(['other'])).toEqual([]);
    });

    test('the live-page and written-since counts', async () => {
      expect(await engine.countLivePagesInSource('default')).toBe(2);
      expect(await engine.countLivePagesInSource('other')).toBe(1);
      expect(await engine.countLivePagesInSource('ghost')).toBe(0);
      expect(await engine.countMentionDueSince('default', COUNTED_AT, MENTION_EXTRACTOR_VERSION)).toBe(2);
      expect(await engine.countMentionDueSince('default', '2999-01-01T00:00:00.000Z', MENTION_EXTRACTOR_VERSION)).toBe(0);
    });

    test('the written-since count with no bound (-infinity, a status row with no counted_at) counts every unscanned live page', async () => {
      expect(await engine.countMentionDueSince('default', '-infinity', MENTION_EXTRACTOR_VERSION)).toBe(2);
      expect(await engine.countMentionDueSince('other', '-infinity', MENTION_EXTRACTOR_VERSION)).toBe(1);
    });

    test('the recount saves only while the fingerprint is the one read, and flips complete to pending', async () => {
      await seedStatus('default', 'complete', 'h;v-old');
      // The fingerprint moved under the caller: nothing changes.
      await engine.recountMentionIndexStatus('default', { pending: 5, fingerprint: 'h;v-new', expectedFingerprint: 'h;v-other' });
      expect(await status('default')).toEqual({ state: 'complete', pending: 3, fingerprint: 'h;v-old', counted: COUNTED_AT });
      // Same fingerprint: saved, counted now, complete becomes pending.
      await engine.recountMentionIndexStatus('default', { pending: 5, fingerprint: 'h;v-new', expectedFingerprint: 'h;v-old' });
      const saved = await status('default');
      expect({ ...saved, counted: undefined }).toEqual({ state: 'pending', pending: 5, fingerprint: 'h;v-new', counted: undefined });
      expect(saved!.counted! > COUNTED_AT).toBe(true);
      // A recount of 0 keeps the state; a null stored fingerprint matches a null expectation.
      await seedStatus('default', 'complete', null);
      await engine.recountMentionIndexStatus('default', { pending: 0, fingerprint: 'h;v-new', expectedFingerprint: null });
      expect({ ...(await status('default')), counted: undefined }).toEqual({ state: 'complete', pending: 0, fingerprint: 'h;v-new', counted: undefined });
      // Other states never flip.
      await seedStatus('default', 'failed', 'h;v-old');
      await engine.recountMentionIndexStatus('default', { pending: 4, fingerprint: 'h;v-new', expectedFingerprint: 'h;v-old' });
      expect((await status('default'))!.state).toBe('failed');
      // A source with no row stays without one.
      await engine.recountMentionIndexStatus('other', { pending: 4, fingerprint: 'h;v-new', expectedFingerprint: null });
      expect(await engine.readMentionIndexStatus(['other'])).toEqual([]);
    });
  });
}
